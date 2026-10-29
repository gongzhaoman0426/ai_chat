import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import type {
  QianniuSetupState,
  QianniuSetupPhase,
} from '../../../../packages/contracts/src/platform';
import type { QianniuIdentity } from './qianniu-transport';
import { discoverQianniuExecutable, validatePatchedQianniuExecutable } from './qianniu-discovery';

export const QIANNIU_SCRIPT_URL = 'http://127.0.0.1:3000/qianniu-inject';
const MAX_CLIENT_ZIP_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 50_000;
const MAX_FIND_DEPTH = 8;
const MAX_FIND_DIRS = 2_000;

export type QianniuProcess = { pid: number; executablePath: string; startedAt: string };
type Connection = { loginId: string; websocket: boolean; tcp: boolean };
type NativeOptions = {
  platform?: NodeJS.Platform;
  configPath: string;
  hookDirectory: string;
  /** Directory used for silent zip install (defaults next to configPath). */
  installDirectory?: string;
  downloadUrl?: string;
  discoverExecutable?: () => Promise<string | undefined>;
  validateExecutable?: (file: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  changed?: () => void;
  listProcesses?: () => Promise<QianniuProcess[]>;
  launchProcess?: (file: string) => Promise<void>;
  injectProcess?: (helper: string, pid: number, executablePath: string) => Promise<void>;
  pollMs?: number;
  hookTimeoutMs?: number;
  maxAttempts?: number;
};

const exec = promisify(execFile);
const sameExecutable = (a: string, b: string) =>
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

/** Locate all AliWorkbench.exe under an extracted client tree (bounded walk). */
export async function findAliWorkbenchExecutables(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const next = queue.shift()!;
    if (next.depth > MAX_FIND_DEPTH) continue;
    const direct = join(next.dir, 'AliWorkbench.exe');
    try {
      if ((await stat(direct)).isFile()) found.push(direct);
    } catch {}
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (++seen > MAX_FIND_DIRS) return rankAliWorkbenchCandidates(found);
      queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
    }
  }
  return rankAliWorkbenchCandidates(found);
}

/** Prefer installs that ship Resources/newWebui/webui.zip beside the EXE or under a version folder. */
async function rankAliWorkbenchCandidates(files: string[]): Promise<string[]> {
  const scored = await Promise.all(
    files.map(async (file) => {
      let score = 0;
      const dir = dirname(file);
      try {
        if ((await stat(join(dir, 'Resources', 'newWebui', 'webui.zip'))).isFile()) score += 100;
      } catch {}
      if (score < 100) {
        try {
          const versions = (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+){1,3}[a-z]?$/i.test(entry.name))
            .slice(0, 20);
          for (const version of versions) {
            try {
              if (
                (await stat(join(dir, version.name, 'Resources', 'newWebui', 'webui.zip'))).isFile()
              ) {
                score += 100;
                break;
              }
            } catch {}
          }
        } catch {}
      }
      if (/[/\\]\d+(?:\.\d+){1,3}[a-z]?(?:[/\\]|$)/i.test(file)) score += 40;
      score += file.split(/[/\\]/).length;
      return { file, score };
    }),
  );
  return scored.sort((a, b) => b.score - a.score).map((row) => row.file);
}

export async function findAliWorkbenchExecutable(root: string): Promise<string | undefined> {
  return (await findAliWorkbenchExecutables(root))[0];
}

function extractClientZip(archivePath: string, destination: string) {
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error('压缩包为空，请检查 CDN 文件。');
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('压缩包文件过多，已拒绝解压。');
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..'))
      throw new Error('压缩包包含不安全路径，已拒绝解压。');
  }
  zip.extractAllTo(destination, true);
}

async function downloadToFile(
  response: Response,
  destination: string,
  maxBytes: number,
): Promise<void> {
  if (!response.body) throw new Error('下载响应无内容。');
  const { Transform } = await import('node:stream');
  let received = 0;
  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > maxBytes) {
        cb(new Error('安装包过大，已取消下载。'));
        return;
      }
      cb(null, chunk);
    },
  });
  await pipeline(nodeStream, counter, createWriteStream(destination));
  if (received === 0) throw new Error('下载内容为空，请检查 CDN 文件。');
}

export async function listQianniuProcesses(): Promise<QianniuProcess[]> {
  const { stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name = \'AliWorkbench.exe\'" | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(value) ? value : [value]).flatMap((row) =>
    Number.isSafeInteger(row.ProcessId) &&
    row.ProcessId > 0 &&
    typeof row.ExecutablePath === 'string'
      ? [
          {
            pid: row.ProcessId,
            executablePath: row.ExecutablePath,
            startedAt: String(row.CreationDate ?? ''),
          },
        ]
      : [],
  );
}

export async function launchQianniu(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, [], { cwd: dirname(file), detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function injectQianniu(
  helper: string,
  pid: number,
  executablePath: string,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw new Error('千牛进程已失效，请重新启动千牛。');
  try {
    // This asInvoker GUI helper never requests elevation and has no visible window.
    await exec(helper, [String(pid), executablePath], {
      cwd: dirname(helper),
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    const reason: Record<number, string> = {
      3: '千牛进程与专用客户端不一致，请重新启动千牛。',
      4: '请使用当前 Windows 用户正常启动千牛，不要以管理员身份运行。',
      5: '无法连接千牛进程，请正常启动千牛，不要以管理员身份运行。',
      6: '请安装支持的 Windows 64 位千牛客户端。',
      7: '千牛连接组件缺失，请重新安装句达。',
      11: '千牛连接组件加载未完成，请重试连接。',
      12: '千牛连接组件加载超时，请重新启动千牛。',
    };
    throw new Error(
      typeof code === 'number' && reason[code]
        ? reason[code]
        : '无法在后台连接千牛，请重新启动客户端后重试。',
      { cause: error },
    );
  }
}

/** Discovers and connects the prepatched Windows client without altering installed files. */
export class QianniuNativeClient {
  private readonly platform: NodeJS.Platform;
  private executablePath: string | null = null;
  private connections: Connection[] = [];
  private phase: QianniuSetupPhase = 'not_configured';
  private message = '安装句达专用千牛后，点击启动并登录。';
  private bridgeError = '';
  private paused = false;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private lifecycle = 0;
  private attempted = new Map<
    string,
    { count: number; at: number; error?: string; retryable?: boolean }
  >();
  private loginSeen = new Set<string>();
  private injecting?: Promise<void>;
  private discovering?: Promise<void>;
  private downloading = false;

  constructor(private readonly options: NativeOptions) {
    this.platform = options.platform ?? process.platform;
  }

  async initialize() {
    if (this.platform !== 'win32') return;
    try {
      const saved = JSON.parse(await readFile(this.options.configPath, 'utf8'));
      if (typeof saved.executablePath === 'string') {
        await this.validateExecutable(saved.executablePath);
        this.executablePath = saved.executablePath;
        this.setPhase('ready', '千牛客户端已就绪，可以启动并登录。');
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.setPhase('not_configured', '千牛客户端已更新或移动，启动时将自动查找。');
    }
  }

  private assertWindows() {
    if (this.platform !== 'win32') throw new Error('千牛接入仅支持 Windows。');
    if (this.paused) throw new Error('正在维护本地数据，请稍后再连接千牛。');
  }
  private setPhase(phase: QianniuSetupPhase, message: string) {
    if (this.phase === phase && this.message === message) return;
    this.phase = phase;
    this.message = message;
    this.options.changed?.();
  }
  private async validateExecutable(file: string) {
    if (
      !file ||
      !(await (this.options.validateExecutable ?? validatePatchedQianniuExecutable)(file))
    )
      throw new Error('未找到句达专用千牛，请先完成安装，再点击启动。');
  }
  status(): QianniuSetupState {
    const supported = this.platform === 'win32';
    return {
      supported,
      downloadUrl: this.options.downloadUrl || '',
      executablePath: this.executablePath,
      phase: !supported ? 'unavailable' : this.bridgeError ? 'error' : this.phase,
      message: !supported ? '千牛接入仅支持 Windows。' : this.bridgeError || this.message,
      scriptUrl: QIANNIU_SCRIPT_URL,
      tcpPort: 9996,
      accounts: supported ? this.connections.map((row) => ({ ...row })) : [],
      downloading: this.downloading,
    };
  }
  setBridgeError(error?: unknown) {
    this.bridgeError = error
      ? `千牛本地连接服务启动失败：${error instanceof Error ? error.message : String(error)}`
      : '';
    this.options.changed?.();
  }
  updateConnections(connections: Connection[]) {
    this.connections = connections.map((row) => ({ ...row }));
    for (const loginId of this.loginSeen)
      if (!connections.some((row) => row.loginId === loginId && row.websocket))
        this.loginSeen.delete(loginId);
    if (connections.some((row) => row.websocket && row.tcp)) {
      this.setPhase('connected', '千牛账号已连接，可在店铺设置中开启接待。');
    } else if (this.phase === 'connected') {
      this.setPhase(
        connections.some((row) => row.websocket) ? 'waiting_hook' : 'waiting_login',
        connections.some((row) => row.websocket)
          ? '正在自动恢复千牛连接…'
          : '等待千牛登录并进入聊天工作台。',
      );
    }
    this.options.changed?.();
  }
  private async persistExecutable(file: string) {
    await this.validateExecutable(file);
    await mkdir(dirname(this.options.configPath), { recursive: true });
    const temp = `${this.options.configPath}.tmp`;
    await writeFile(temp, JSON.stringify({ executablePath: file }), { mode: 0o600 });
    await rename(temp, this.options.configPath);
    this.executablePath = file;
    this.attempted.clear();
    this.generation++;
  }

  async download() {
    this.assertWindows();
    const raw = this.options.downloadUrl || '';
    if (!raw) throw new Error('千牛下载地址尚未配置，安装包就绪后即可下载。');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('千牛下载地址必须是有效的 HTTPS 地址。');

    // Non-zip URLs still open in the browser (installer / release page).
    if (!/\.zip(?:$|\?)/i.test(url.pathname + url.search)) {
      await this.options.openExternal(url.href);
      return this.status();
    }

    if (this.downloading) return this.status();
    this.downloading = true;
    this.setPhase(
      this.executablePath ? 'ready' : 'not_configured',
      '正在下载并解压千牛客户端，请稍候…',
    );
    this.options.changed?.();

    const installDir =
      this.options.installDirectory ?? join(dirname(this.options.configPath), 'qianniu-client');
    const staging = `${installDir}.staging-${Date.now()}`;
    const zipPath = `${installDir}.download-${Date.now()}.zip`;

    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(url.href, { redirect: 'follow' });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）。`);
      const length = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(length) && length > MAX_CLIENT_ZIP_BYTES)
        throw new Error('安装包过大，已取消下载。');

      this.setPhase(this.executablePath ? 'ready' : 'not_configured', '正在写入安装包…');
      this.options.changed?.();
      await mkdir(dirname(zipPath), { recursive: true });
      await downloadToFile(response, zipPath, MAX_CLIENT_ZIP_BYTES);

      this.setPhase(this.executablePath ? 'ready' : 'not_configured', '正在解压千牛客户端…');
      this.options.changed?.();
      await mkdir(staging, { recursive: true });
      extractClientZip(zipPath, staging);

      const candidates = await findAliWorkbenchExecutables(staging);
      if (!candidates.length) throw new Error('压缩包中未找到 AliWorkbench.exe，请确认包结构。');
      let found: string | undefined;
      for (const candidate of candidates) {
        try {
          await this.validateExecutable(candidate);
          found = candidate;
          break;
        } catch {
          // Keep trying other AliWorkbench.exe copies (launcher vs versioned install).
        }
      }
      if (!found) {
        throw new Error(
          '解压后的客户端未通过适配校验：recent.html 须包含 http://127.0.0.1:3000/qianniu-inject，请重新打补丁后上传 CDN。',
        );
      }

      await rm(installDir, { recursive: true, force: true });
      await rename(staging, installDir);
      const executable = join(installDir, relative(staging, found));
      await this.persistExecutable(executable);
      this.downloading = false;
      this.setPhase('ready', '千牛客户端已下载并就绪，可以启动并登录。');
      return this.status();
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.downloading = false;
      this.setPhase('error', `千牛下载失败：${message}`);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      await rm(zipPath, { force: true }).catch(() => undefined);
      this.downloading = false;
      this.options.changed?.();
    }
  }
  private async discoverClient() {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      const file = await (this.options.discoverExecutable ?? discoverQianniuExecutable)();
      if (!file) throw new Error('未找到句达专用千牛，请先完成安装，再点击启动。');
      await this.persistExecutable(file);
    })();
    try {
      await this.discovering;
    } finally {
      this.discovering = undefined;
    }
  }
  async start({ openLogin = false }: { openLogin?: boolean } = {}) {
    this.assertWindows();
    if (this.busy || (!openLogin && this.injecting)) return this.status();
    this.busy = true;
    const lifecycle = this.lifecycle;
    try {
      if (this.executablePath) {
        try {
          await this.validateExecutable(this.executablePath);
        } catch {
          this.executablePath = null;
        }
      }
      if (!this.executablePath) await this.discoverClient();
      if (lifecycle !== this.lifecycle || this.paused) return this.status();
      this.setPhase('starting', openLogin ? '正在打开千牛登录窗口…' : '正在启动千牛…');
      const processes = await (this.options.listProcesses ?? listQianniuProcesses)();
      if (lifecycle !== this.lifecycle || this.paused) return this.status();
      // An explicit additional login must reach the native launcher even when
      // another account is online. Ordinary reconnects still reuse that client.
      if (
        openLogin ||
        !processes.some((p) => sameExecutable(p.executablePath, this.executablePath!))
      )
        await (this.options.launchProcess ?? launchQianniu)(this.executablePath!);
      if (lifecycle !== this.lifecycle || this.paused) return this.status();
      this.setPhase(
        this.connections.some((row) => row.websocket && row.tcp) ? 'connected' : 'waiting_login',
        openLogin
          ? '请在千牛登录窗口登录其他店铺，并进入聊天工作台。'
          : this.connections.some((row) => row.websocket && row.tcp)
            ? '千牛账号已连接，可在店铺设置中开启接待。'
            : '请在千牛窗口登录并进入聊天工作台，句达会自动建立连接。',
      );
      // The single user-facing Start action also retries a previously failed connection.
      if (!openLogin && !this.injecting) this.attempted.clear();
      this.watch();
      if (this.loginSeen.size) await this.scan();
      return this.status();
    } catch (e) {
      if (lifecycle === this.lifecycle)
        this.setPhase('error', `千牛启动失败：${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async onLogin(identity: QianniuIdentity) {
    if (this.platform !== 'win32' || this.paused || !identity.loginId.trim()) return;
    const lifecycle = this.lifecycle;
    this.loginSeen.add(identity.loginId);
    if (!this.executablePath) {
      try {
        await this.discoverClient();
      } catch (error) {
        this.setPhase(
          'not_configured',
          error instanceof Error ? error.message : '未找到句达专用千牛，请完成安装。',
        );
        return;
      }
    }
    if (lifecycle !== this.lifecycle || this.paused) return;
    this.watch();
    await this.scan();
  }
  private watch() {
    if (this.timer || this.platform !== 'win32' || this.paused) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, this.options.pollMs ?? 3000);
    this.timer.unref?.();
  }
  private async scan() {
    if (this.injecting) return this.injecting;
    if (this.paused || !this.executablePath || !this.loginSeen.size) return;
    // Transport retains disconnected identities. They must not trigger a reconnect
    // after the currently logged-in accounts are already fully connected.
    if (
      [...this.loginSeen].every((id) =>
        this.connections.some((c) => c.loginId === id && c.websocket && c.tcp),
      )
    )
      return;
    const generation = this.generation;
    this.injecting = (async () => {
      try {
        const processes = await (this.options.listProcesses ?? listQianniuProcesses)();
        const candidates = processes.filter((p) =>
          sameExecutable(p.executablePath, this.executablePath!),
        );
        if (!candidates.length) {
          if (this.phase !== 'connected')
            this.setPhase('error', '未找到句达专用千牛的运行进程，请重新启动。');
          return;
        }
        const helper = join(this.options.hookDirectory, 'JuDeskQianniuHook.exe');
        for (const file of [helper, join(this.options.hookDirectory, 'QnQtMsg64.dll')])
          if (!(await stat(file)).isFile()) throw new Error(`缺少千牛连接组件 ${basename(file)}`);
        let awaitingConfirmation = false;
        let awaitingRetry = false;
        const maxAttempts = this.options.maxAttempts ?? 3;
        const failures: string[] = [];
        for (const process of candidates) {
          if (this.paused || generation !== this.generation || !this.loginSeen.size) return;
          const key = `${process.pid}:${process.startedAt}`;
          const attempt = this.attempted.get(key);
          if (attempt && Date.now() - attempt.at < (this.options.hookTimeoutMs ?? 15_000)) {
            if (attempt.error) {
              failures.push(attempt.error);
              if (attempt.retryable && attempt.count < maxAttempts) awaitingRetry = true;
            } else awaitingConfirmation = true;
            continue;
          }
          if (attempt && attempt.count >= maxAttempts) {
            failures.push(attempt.error || '千牛连接未能恢复，请退出并重新启动千牛客户端。');
            continue;
          }
          this.attempted.set(key, { count: (attempt?.count ?? 0) + 1, at: Date.now() });
          if (this.phase !== 'connected')
            this.setPhase('injecting', '已检测到登录，正在后台连接千牛…');
          try {
            await (this.options.injectProcess ?? injectQianniu)(
              helper,
              process.pid,
              this.executablePath!,
            );
          } catch (error) {
            if (this.paused || generation !== this.generation) return;
            // A launcher can fail while another process owns the chat workbench.
            // Bound this PID's failures without blocking the remaining candidates.
            const message = error instanceof Error ? error.message : String(error);
            const retryable =
              error instanceof Error &&
              (error.cause as { code?: unknown } | undefined)?.code === 11;
            const count = (attempt?.count ?? 0) + 1;
            this.attempted.set(key, {
              count: retryable ? count : maxAttempts,
              at: Date.now(),
              error: message,
              retryable,
            });
            failures.push(message);
            if (retryable && count < maxAttempts) awaitingRetry = true;
            continue;
          }
          if (this.paused || generation !== this.generation) return;
          this.attempted.get(key)!.at = Date.now();
          awaitingConfirmation = true;
        }
        if (this.phase === 'connected') return;
        if (awaitingConfirmation)
          this.setPhase('waiting_hook', '正在等待千牛确认，句达会自动完成连接。');
        else if (awaitingRetry)
          this.setPhase('waiting_hook', '千牛连接组件加载未完成，句达会自动重试连接。');
        else if (failures.length)
          this.setPhase('error', `千牛后台连接未完成：${[...new Set(failures)].join('；')}`);
      } catch (e) {
        if (!this.paused && generation === this.generation && this.phase !== 'connected')
          this.setPhase(
            'error',
            e instanceof Error ? e.message : '后台连接千牛失败，请重新启动客户端。',
          );
      }
    })();
    try {
      await this.injecting;
    } finally {
      this.injecting = undefined;
    }
  }
  async retryHook() {
    this.assertWindows();
    if (!this.loginSeen.size) throw new Error('请先在千牛客户端登录并进入聊天工作台。');
    if (this.injecting) return this.status();
    this.attempted.clear();
    await this.scan();
    return this.status();
  }
  setMaintenance(paused: boolean) {
    this.paused = paused;
    this.generation++;
    this.lifecycle++;
    if (paused && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!paused && this.loginSeen.size) this.watch();
  }
  close() {
    this.generation++;
    this.lifecycle++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.loginSeen.clear();
    this.connections = [];
    this.attempted.clear();
    this.setPhase(
      this.executablePath ? 'ready' : 'not_configured',
      this.executablePath
        ? '千牛客户端已就绪，可以启动并登录。'
        : '安装句达专用千牛后，点击启动并登录。',
    );
  }
}
