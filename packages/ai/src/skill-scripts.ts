import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { PublishedSkill } from '../../agent-config/src/skills';
import {
  skillInputSchema,
  skillScriptCallSchema,
  type SkillScriptCall,
  type SkillScriptResult,
} from '../../contracts/src/index';
import { assert, uid } from '../../core/src/util';

const MAX_OUTPUT = 64 * 1024;
const MAX_CONCURRENT = 2;
type Active = { scope: string; controller: AbortController; promise: Promise<SkillScriptResult> };
// Runs trusted user-authored files, never model-authored shell command strings.
// A separate process limits lifetime/output; it is not an OS security sandbox.
export class SkillScriptRunner {
  private active = new Map<string, Active>();
  private closed = false;
  constructor(
    private dataDir: string,
    private nodeExecutable = process.execPath,
  ) {}
  async initialize() {
    await mkdir(join(this.dataDir, 'skill-runs'), { recursive: true });
  }
  async run(
    scope: string,
    skill: PublishedSkill,
    input: SkillScriptCall,
    signal?: AbortSignal,
  ): Promise<SkillScriptResult> {
    assert(!this.closed, '脚本执行器已关闭');
    assert(this.active.size < MAX_CONCURRENT, '已有两个脚本正在运行，请稍后重试');
    const call = skillScriptCallSchema.parse(input);
    const config = skillInputSchema.parse({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      references: skill.references,
      scripts: skill.scripts,
    });
    assert(Object.hasOwn(config.scripts, call.path), '脚本不存在或未包含在当前 Skill 发布版本中');
    signal?.throwIfAborted();
    const executionId = uid();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = this.execute({ ...skill, ...config }, call, executionId, combined).finally(() =>
      this.active.delete(executionId),
    );
    this.active.set(executionId, { scope, controller, promise });
    return promise;
  }
  cancel(scope: string) {
    let count = 0;
    for (const run of this.active.values())
      if (run.scope === scope) {
        run.controller.abort();
        count++;
      }
    return { cancelled: count > 0 };
  }
  async close() {
    this.closed = true;
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((run) => run.promise));
  }
  private async interpreter(extension: string) {
    if (/^\.[cm]?[jt]s$/.test(extension))
      return {
        name: 'Node.js',
        file: this.nodeExecutable,
        args: [
          '--max-old-space-size=128',
          ...(extension.endsWith('ts') ? ['--experimental-transform-types'] : []),
        ],
      };
    const names = extension === '.py' ? ['python3', 'python'] : ['bash'];
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const name of names) {
        const file = resolve(dir, name + (process.platform === 'win32' ? '.exe' : ''));
        try {
          await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          return {
            name: extension === '.py' ? 'Python' : 'Bash',
            file,
            args: extension === '.py' ? ['-E', '-s'] : ['--noprofile', '--norc'],
          };
        } catch {
          /* Try the next installed interpreter. */
        }
      }
    }
    throw new Error(
      extension === '.py'
        ? '未找到 Python 解释器，请安装 Python 3 并加入 PATH，或改用内置 TS/JS。'
        : '未找到 Bash 解释器，请安装 Bash 并加入 PATH，或改用内置 TS/JS。',
    );
  }
  private async execute(
    skill: PublishedSkill,
    call: SkillScriptCall,
    executionId: string,
    signal: AbortSignal,
  ): Promise<SkillScriptResult> {
    const started = Date.now();
    let directory: string | undefined;
    let runtime = 'unknown';
    const base = {
      executionId,
      skillId: skill.id,
      skillName: skill.name,
      skillRevision: skill.revision,
      contentHash: skill.contentHash,
      path: call.path,
    };
    try {
      const interpreter = await this.interpreter(extname(call.path));
      runtime = interpreter.name;
      signal.throwIfAborted();
      const root = join(this.dataDir, 'skill-runs');
      await mkdir(root, { recursive: true });
      directory = await mkdtemp(join(root, 'call-'));
      const files = {
        'SKILL.md': `---\n${stringify({ name: skill.name, description: skill.description })}---\n${skill.instructions}`,
        'package.json': '{"type":"module"}',
        ...skill.references,
        ...skill.scripts,
      };
      for (const [path, text] of Object.entries(files)) {
        signal.throwIfAborted();
        const file = join(directory, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text, { mode: 0o600, flag: 'wx' });
      }
      signal.throwIfAborted();
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
      if (process.platform === 'win32') {
        env.SystemRoot = process.env.SystemRoot;
        env.WINDIR = process.env.WINDIR;
        env.TEMP = directory;
        env.TMP = directory;
      }
      if (interpreter.name === 'Node.js') env.ELECTRON_RUN_AS_NODE = '1';
      const child = spawn(
        interpreter.file,
        [...interpreter.args, join(directory, call.path), ...call.args],
        {
          cwd: directory,
          env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: 'pipe',
        },
      );
      const result = await this.collect(child, call, signal);
      return { ...base, runtime, ...result, durationMs: Date.now() - started };
    } catch (e) {
      return {
        ...base,
        runtime,
        status: signal.aborted ? 'cancelled' : 'failed',
        stdout: '',
        stderr: signal.aborted ? '脚本运行已取消' : e instanceof Error ? e.message : '脚本无法执行',
        exitCode: null,
        signal: null,
        truncated: false,
        durationMs: Date.now() - started,
      };
    } finally {
      if (directory)
        await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    }
  }
  private collect(
    child: ChildProcessWithoutNullStreams,
    call: SkillScriptCall,
    signal: AbortSignal,
  ): Promise<
    Omit<
      SkillScriptResult,
      | 'executionId'
      | 'skillId'
      | 'skillName'
      | 'skillRevision'
      | 'contentHash'
      | 'path'
      | 'runtime'
      | 'durationMs'
    >
  > {
    return new Promise((resolveResult) => {
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let bytes = 0,
        truncated = false,
        settled = false;
      let stopped: SkillScriptResult['status'] | undefined;
      let failure = '';
      const killTree = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          execFile(
            join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 2000 },
            () => {
              child.kill('SIGKILL');
            },
          );
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      const stop = (status: SkillScriptResult['status']) => {
        if (settled) return;
        stopped ??= status;
        killTree();
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timed_out'), call.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        const remaining = MAX_OUTPUT - bytes;
        if (remaining > 0) {
          const kept = chunk.subarray(0, remaining);
          chunks.push(kept);
          bytes += kept.length;
        }
        if (chunk.length > remaining) {
          truncated = true;
          stop('output_limit');
        }
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.stdin.on('error', () => {}); // An early exit can close stdin before all input is consumed.
      child.on('error', (e) => {
        failure = e.message;
      });
      child.on('exit', () => {
        if (process.platform !== 'win32') killTree();
      }); // No detached background descendants.
      child.on('close', (exitCode, exitSignal) => {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolveResult({
          status: stopped ?? (exitCode === 0 && !failure ? 'succeeded' : 'failed'),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8') + failure,
          exitCode,
          signal: exitSignal,
          truncated,
        });
      });
      if (signal.aborted) abort();
      else child.stdin.end(call.stdin);
    });
  }
}
