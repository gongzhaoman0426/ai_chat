import { validateBackup } from '../../../../packages/core/src/backup';
import {
  app,
  BrowserWindow,
  ipcMain,
  utilityProcess,
  safeStorage,
  dialog,
  nativeImage,
  Tray,
  Menu,
  protocol,
  net,
  powerMonitor,
  shell,
  nativeTheme,
} from 'electron';
import type { UtilityProcess } from 'electron';
import { mkdir, readFile, writeFile, stat, cp, rename, rm, readdir } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { PddHost } from './pdd-host';
import { GoofishHost } from './goofish-host';
import { DouyinHost } from './douyin-host';
import { KuaishouHost } from './kuaishou-host';
import { QianniuHost } from './qianniu-host';
import { QianniuTransport } from './qianniu-transport';
import { QianniuNativeClient } from './qianniu-native';
import { discoverQianniuExecutable } from './qianniu-discovery';
import { PlatformHosts } from './platform-hosts';
import { stopServiceProcess } from './service-shutdown';
import type { PlatformId } from '../../../../packages/contracts/src/platform';
import { apiInputs, type Method } from '../../../../packages/contracts/src/index';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.JUDESK_DATA_DIR || join(app.getPath('userData'), 'judesk-data');
if (process.env.JUDESK_DATA_DIR) app.setPath('userData', join(dataDir, 'electron-profile')); // Isolate test profiles and single-instance locks.
let window: BrowserWindow | undefined;
let attaching = false;
let service: UtilityProcess | undefined;
let platforms: PlatformHosts;
let qianniu: QianniuHost;
let qianniuNative: QianniuNativeClient;
let tray: Tray;
let quitting = false;
let ready = false;
let stoppingRuntime: Promise<void> | undefined;
let preparingDatabase: Promise<void> | undefined;
let failures = 0;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
const resource = (name: string) =>
  app.isPackaged ? join(process.resourcesPath, 'resources', name) : resolve('resources', name);
protocol.registerSchemesAsPrivileged([
  { scheme: 'judesk', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// Do not let a second process continue through window creation and database
// migration. Calling app.quit() alone is asynchronous; without this guard the
// second process could still run `migrate deploy` while the first process holds
// SQLite's lock, which surfaces as "database is locked" on Windows.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
function request(data: Record<string, unknown>): Promise<any> {
  const currentService = service;
  if (!currentService) return Promise.reject(new Error('本地服务未启动'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本地服务请求超时'));
    }, 190000);
    pending.set(id, { resolve, reject, timer });
    currentService.postMessage({ ...data, id });
  });
}
function workbench() {
  return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : undefined;
}
function notifyRenderer() {
  workbench()?.webContents.send('judesk:changed');
}

async function stopRuntime(timeoutMs: number | null, killOnTimeout: boolean) {
  if (stoppingRuntime) return stoppingRuntime;
  stoppingRuntime = (async () => {
    // Do not leave a backup/restore/migration process running after quitting.
    await preparingDatabase?.catch(() => undefined);
    await platforms?.close();
    const currentService = service;
    if (currentService) await stopServiceProcess(currentService, timeoutMs, killOnTimeout);
  })();
  try {
    await stoppingRuntime;
  } finally {
    stoppingRuntime = undefined;
  }
}

function showWindow() {
  const current = workbench();
  if (!current) {
    void attachWindow().then(() => {
      const created = workbench();
      created?.show();
      created?.focus();
    });
    return;
  }
  current.show();
  current.focus();
}
async function attachWindow() {
  if (workbench() || attaching) return;
  attaching = true;
  try {
    const windowIcon = nativeImage.createFromPath(resource('icon.png'));
    if (process.platform === 'darwin' && !windowIcon.isEmpty()) app.dock?.setIcon(windowIcon);
    window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 960,
      minHeight: 720,
      title: '句达',
      // Match the renderer's system-following theme to avoid a flash before first paint.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e131b' : '#f3f7fd',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      icon: windowIcon.isEmpty() ? undefined : windowIcon,
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (e, url) => {
      const current = workbench();
      if (!current || url !== current.webContents.getURL()) e.preventDefault();
    });
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        workbench()?.hide();
        service?.postMessage({ type: 'windowHidden' });
      }
    });
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(here, '../renderer/index.html'));
  } finally {
    attaching = false;
  }
}

async function migrate() {
  const schema = app.isPackaged
    ? join(process.resourcesPath, 'prisma', 'schema.prisma')
    : resolve('packages/database/prisma/schema.prisma');
  const migrationsDir = join(dirname(schema), 'migrations');
  // Waiting for the process (not just the backup promise) releases every native
  // SQLite handle before the migration engine requests an exclusive lock.
  await promisify(execFile)(
    process.execPath,
    [
      join(here, 'database-prepare.js'),
      JSON.stringify({ dataDir, appVersion: app.getVersion(), migrationsDir }),
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 2 * 1024 * 1024 },
  );
  if (quitting) return;
  await mkdir(join(dataDir, 'db'), { recursive: true });
  await writeFile(join(dataDir, 'db', 'judesk.db'), '', { flag: 'a' });
  const config = join(dataDir, 'migration.config.ts');
  await writeFile(
    config,
    `export default ${JSON.stringify({ schema, migrations: { path: join(dirname(schema), 'migrations') }, datasource: { url: `file:${join(dataDir, 'db', 'judesk.db').replace(/\\/g, '/')}` } })};\n`,
  );
  const cli = require.resolve('prisma/build/index.js');
  const engineDir = dirname(
    require.resolve('@prisma/engines/package.json', { paths: [dirname(cli)] }),
  ).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  const wanted =
    process.platform === 'win32'
      ? 'schema-engine-windows.exe'
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? 'schema-engine-darwin-arm64'
        : process.platform === 'darwin'
          ? 'schema-engine-darwin'
          : null;
  const engines = (await readdir(engineDir)).filter(
    (name) => name.startsWith('schema-engine-') && !name.endsWith('.sha256'),
  );
  const engineFile = (wanted && engines.includes(wanted) && wanted) || engines[0];
  if (!engineFile) throw new Error('缺少 Prisma 迁移引擎');
  await promisify(execFile)(process.execPath, [cli, 'migrate', 'deploy', '--config', config], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PRISMA_SCHEMA_ENGINE_BINARY: join(engineDir, engineFile),
    },
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
async function host(method: string, args: any[]) {
  switch (method) {
    case 'maintenance':
      platforms.setMaintenance(args[0]);
      return;
    case 'stageRestore': {
      await validateBackup(args[0]);
      await cp(args[0], join(dataDir, 'restore.pending.zip'));
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 500);
      return;
    }
    case 'send':
      return platforms.send(args[0]);
    case 'query':
      return platforms.query(args[0], args[1], args[2]);
    case 'staff':
      return platforms.staff(args[0]);
    case 'executeQuickAction':
      return platforms.executeQuickAction(args[0]);
    case 'executeTransfer':
      return platforms.executeTransfer(args[0]);
    case 'markRead':
      return platforms.markRead(args[0], args[1]);
    case 'executeShipment':
      return platforms.executeShipment(args[0]);
    case 'executeAction':
      return platforms.executeAction(args[0]);
    case 'connect': {
      let account;
      if (args[0]) {
        const stores = await request({ type: 'call', method: 'stores.list', input: {} });
        account = stores
          .flatMap((s: any) => s.accounts.map((a: any) => ({ ...a, platform: s.platform })))
          .find((a: any) => a.id === args[0]);
        if (!account) throw new Error('账号不存在，无法打开平台');
      }
      return platforms.connect(account, args[1]);
    }
    case 'disconnect':
      return platforms.disconnect(args[0]);
    case 'forgetPartition':
      return platforms.forgetPartition(args[0]);
    case 'verify':
      return platforms.verify(args[0]);
    case 'secretPut': {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('操作系统密钥存储不可用');
      const ref = args[1] || randomUUID();
      if (!/^[a-zA-Z0-9-]+$/.test(ref)) throw new Error('无效密钥引用');
      await mkdir(join(dataDir, 'secrets'), { recursive: true });
      await writeFile(join(dataDir, 'secrets', ref), safeStorage.encryptString(args[0]), {
        mode: 0o600,
      });
      return ref;
    }
    case 'secretGet': {
      if (!/^[a-zA-Z0-9-]+$/.test(args[0])) throw new Error('无效密钥引用');
      return safeStorage.decryptString(await readFile(join(dataDir, 'secrets', args[0])));
    }
    case 'pickFile':
    case 'pickFiles': {
      const extensions =
        args[0] === 'image'
          ? ['png', 'jpg', 'jpeg', 'webp', 'gif']
          : args[0] === 'skill'
            ? ['md', 'zip']
            : args[0] === 'agent'
              ? ['json']
              : args[0] === 'knowledge'
                ? ['json', 'zip']
                : ['zip'];
      const multiple = method === 'pickFiles';
      const options: Electron.OpenDialogOptions = {
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: '支持的文件', extensions }],
      };
      const parent = workbench();
      const selected = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (selected.canceled) return multiple ? [] : null;
      return multiple ? selected.filePaths.slice(0, 8) : selected.filePaths[0];
    }
    case 'saveFile': {
      const options = { defaultPath: args[0] };
      const parent = workbench();
      const selected = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return selected.canceled ? null : selected.filePath;
    }
    case 'validateImage': {
      const bytes = Buffer.from(args[0]);
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('图片无法解码');
      let mime = '';
      if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        mime = 'image/png';
      else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
      else if (bytes.subarray(0, 3).toString() === 'GIF') mime = 'image/gif';
      else if (
        bytes.subarray(0, 4).toString() === 'RIFF' &&
        bytes.subarray(8, 12).toString() === 'WEBP'
      )
        mime = 'image/webp';
      return { ...image.getSize(), mime };
    }
    default:
      throw new Error('未登记的桌面能力');
  }
}
function startService() {
  // A restart timer may already be queued when quitting or installing an update.
  if (quitting || service) return;
  ready = false;
  const currentService = utilityProcess.fork(join(here, 'service.js'), [], {
    serviceName: '句达本地服务',
    stdio: 'pipe',
  });
  service = currentService;
  currentService.stdout?.on('data', (data) => console.log(String(data)));
  currentService.stderr?.on('data', (data) => console.error(String(data)));
  currentService.on('message', async (data) => {
    if (service !== currentService) return;
    if (data.type === 'ready') {
      if (quitting) {
        currentService.postMessage({ type: 'shutdown' });
        return;
      }
      ready = true;
      failures = 0;
      void platforms.restore(data.accounts ?? []);
      notifyRenderer();
      return;
    }
    if (data.type === 'changed') {
      notifyRenderer();
      return;
    }
    if (data.type === 'result') {
      const p = pending.get(data.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(data.id);
        data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
      }
      return;
    }
    if (data.type === 'fatal') {
      console.error('本地服务启动失败', data.error);
      if (process.env.JUDESK_SMOKE_TEST) app.exit(1);
      else
        void dialog.showMessageBox({
          type: 'error',
          title: '本地服务启动失败',
          message: data.error,
        });
      return;
    }
    if (data.type === 'host') {
      try {
        currentService.postMessage({
          type: 'hostResult',
          id: data.id,
          ok: true,
          result: await host(data.method, data.args),
        });
      } catch (e) {
        currentService.postMessage({
          type: 'hostResult',
          id: data.id,
          ok: false,
          error: e instanceof Error ? e.message : '桌面操作失败',
        });
      }
    }
  });
  currentService.on('exit', () => {
    if (service !== currentService) return;
    service = undefined;
    ready = false;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('本地服务已断开'));
    }
    pending.clear();
    if (!quitting && ++failures <= 3) setTimeout(startService, 1000 * failures);
    else if (!quitting)
      dialog.showErrorBox('本地服务已暂停', '服务连续退出，请重启应用并导出诊断。');
  });
  currentService.postMessage({
    type: 'init',
    dir: dataDir,
    nodeExecutable: process.execPath,
    appVersion: app.getVersion(),
  });
}
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await mkdir(dataDir, { recursive: true });
  protocol.handle('judesk', async (request) => {
    const url = new URL(request.url);
    if (
      url.hostname !== 'attachment' ||
      !/^\/[a-zA-Z0-9-]+\.(png|jpg|jpeg|webp|gif)$/.test(url.pathname)
    )
      return new Response('Not found', { status: 404 });
    const file = join(dataDir, 'attachments', url.pathname.slice(1));
    try {
      return await net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  ipcMain.handle('judesk:call', async (event, data) => {
    const current = workbench();
    if (
      !current ||
      event.sender !== current.webContents ||
      event.senderFrame !== current.webContents.mainFrame
    )
      return { ok: false, error: '不允许的调用来源' };
    if (!ready) return { ok: false, error: '本地服务正在启动，请稍候' };
    try {
      const method = data.method as Method;
      if (!Object.hasOwn(apiInputs, method)) throw new Error('未知业务方法');
      const input = apiInputs[method].parse(data.input ?? {});
      let result: unknown;
      switch (method) {
        case 'qianniu.status':
          result = qianniuNative.status();
          break;
        case 'qianniu.download':
          result = await qianniuNative.download();
          break;
        case 'qianniu.launch':
          await qianniu.connect();
          result = qianniuNative.status();
          break;
        case 'qianniu.addAccount':
          await qianniu.start();
          result = await qianniuNative.start({ openLogin: true });
          break;
        case 'qianniu.retryHook':
          await qianniu.start();
          result = await qianniuNative.retryHook();
          break;
        default:
          result = await request({ type: 'call', method, input });
      }
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '请求失败' };
    }
  });
  await attachWindow();
  const windowIcon = nativeImage.createFromPath(resource('icon.png'));
  const trayIcon = nativeImage.createFromPath(
    resource(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon.isEmpty() ? windowIcon : trayIcon);
  tray.setToolTip('句达');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开工作台', click: () => showWindow() },
      { label: '退出句达', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showWindow());
  const platformRequest = (platform: PlatformId) => async (data: Record<string, unknown>) => {
    const result = await request(data);
    if (data.type === 'account') platforms.remember({ ...result, platform });
    return result;
  };
  const platformNotify = (data: any) => {
    if (data.type === 'connection_notice')
      workbench()?.webContents.send('judesk:notice', data.message);
    else service?.postMessage(data);
  };
  let qianniuDownloadUrl = '';
  try {
    const config = JSON.parse(await readFile(resource('qianniu.json'), 'utf8'));
    if (typeof config.downloadUrl === 'string') qianniuDownloadUrl = config.downloadUrl.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('千牛下载配置不可用，可启动已安装的适配客户端');
  }
  const qianniuTransport = new QianniuTransport({});
  qianniuNative = new QianniuNativeClient({
    configPath: join(dataDir, 'qianniu-client.json'),
    installDirectory: join(dataDir, 'qianniu-client'),
    hookDirectory: resource('qianniu-native'),
    downloadUrl: qianniuDownloadUrl,
    openExternal: (url) => shell.openExternal(url),
    discoverExecutable: () =>
      discoverQianniuExecutable({ candidatePaths: [join(dataDir, 'qianniu-client')] }),
    changed: notifyRenderer,
  });
  await qianniuNative.initialize();
  qianniuTransport.on('connection', () =>
    qianniuNative.updateConnections(qianniuTransport.states()),
  );
  qianniu = new QianniuHost({
    transport: qianniuTransport,
    request: platformRequest('qianniu'),
    notify: platformNotify,
    native: qianniuNative,
    imageDirectory: join(dataDir, 'qianniu-images'),
    onError: (error) => qianniuNative.setBridgeError(error),
  });
  platforms = new PlatformHosts({
    qianniu,
    kuaishou: new KuaishouHost(
      resource('kuaishou-bridge.js'),
      platformRequest('kuaishou'),
      platformNotify,
      !app.isPackaged,
    ),
    goofish: new GoofishHost(
      resource('goofish-bridge.js'),
      platformRequest('goofish'),
      platformNotify,
      !app.isPackaged,
    ),
    pinduoduo: new PddHost(
      resource('pdd-bridge.js'),
      platformRequest('pinduoduo'),
      platformNotify,
      !app.isPackaged,
    ),
    douyin: new DouyinHost(
      resource('douyin-bridge.js'),
      platformRequest('douyin'),
      platformNotify,
      !app.isPackaged,
    ),
  });
  try {
    if (quitting) return;
    preparingDatabase = migrate();
    await preparingDatabase;
    startService();
  } catch (e) {
    console.error('数据库准备失败', e);
    if (quitting) return;
    if (process.env.JUDESK_SMOKE_TEST) app.exit(1);
    else
      void dialog.showMessageBox({
        type: 'error',
        title: '数据库准备失败',
        message: e instanceof Error ? e.message : '迁移失败',
      });
  } finally {
    preparingDatabase = undefined;
  }
  powerMonitor.on('suspend', () => {
    void platforms.close();
  });
  powerMonitor.on('resume', () => {
    if (ready)
      void request({ type: 'connections' })
        .then((accounts) => platforms.restore(accounts))
        .catch(console.error);
  });
  app.on('activate', () => showWindow());
});
process.on('unhandledRejection', (error) => {
  console.error('JuDesk unhandled rejection:', error);
  if (process.env.JUDESK_SMOKE_TEST) app.exit(1);
});
process.on('uncaughtException', (error) => {
  if (error instanceof Error && /has been destroyed/i.test(error.message)) {
    console.error('JuDesk window already closed:', error);
    return;
  }
  console.error('JuDesk uncaught exception:', error);
  if (process.env.JUDESK_SMOKE_TEST) app.exit(1);
});
app.on('second-instance', () => showWindow());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopRuntime(8000, true)
    .catch((error) => console.error('关闭本地服务失败', error))
    .finally(() => app.quit());
});
app.on('window-all-closed', () => {});
