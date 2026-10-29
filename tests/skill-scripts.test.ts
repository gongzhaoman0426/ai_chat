import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import {
  skillInputSchema,
  skillScriptCallSchema,
  agentConfigSchema,
  apiInputs,
} from '../packages/contracts/src/index';
import {
  SkillService,
  exportSkill,
  importSkill,
  publishedSkills,
  type PublishedSkill,
} from '../packages/agent-config/src/skills';
import { SkillScriptRunner } from '../packages/ai/src/skill-scripts';
import { SnapshotSkillSource } from '../packages/ai/src/skill-runtime';
import { MastraAi } from '../packages/ai/src/index';
import { Router } from '../packages/core/src/router';
import { hash, uid } from '../packages/core/src/util';
import { setup, waitFor } from './helpers';

let dir: string | undefined;
let runner: SkillScriptRunner | undefined;
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await runner?.close();
  await ai?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await f?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
  runner = undefined;
  ai = undefined;
  f = undefined;
  server = undefined;
  dir = undefined;
});
const skill = (
  scripts: Record<string, string>,
  references: Record<string, string> = {},
): PublishedSkill => {
  const config = skillInputSchema.parse({
    name: 'calculate',
    description: '核实数值时使用',
    instructions: '读取 scripts/calculate.ts，用 runSkillScript 运行，按 stdout 回答。',
    scripts,
    references,
  });
  return { ...config, id: uid(), revision: 1, contentHash: hash(config) };
};
const draftInput = ({ id, revision, contentHash, ...config }: PublishedSkill) =>
  skillInputSchema.parse(config);
const call = (path: string, values: Record<string, unknown> = {}) =>
  skillScriptCallSchema.parse({ path, ...values });
async function setupRunner() {
  dir = await mkdtemp(join(tmpdir(), 'judesk-script-'));
  runner = new SkillScriptRunner(dir);
  await runner.initialize();
  return runner;
}
async function noTemporaryFiles() {
  expect(await readdir(join(dir!, 'skill-runs'))).toEqual([]);
}

it('TS 脚本使用参数、stdin、相对模块和资料，结果包含冻结版本，不继承宿主密钥', async () => {
  await setupRunner();
  vi.stubEnv('JUDESK_SCRIPT_TEST_SECRET', 'must-not-inherit');
  vi.stubEnv('NODE_OPTIONS', '--definitely-not-a-real-node-option');
  const config = skill(
    {
      'scripts/calculate.ts': `import { readFile } from 'node:fs/promises';
import { add } from './helper.ts';
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
console.log(JSON.stringify({ value: add(Number(process.argv[2])), arg: process.argv[3], stdin, reference: await readFile('references/value.txt', 'utf8'), secret: process.env.JUDESK_SCRIPT_TEST_SECRET ?? null, options: process.env.NODE_OPTIONS ?? null }));`,
      'scripts/helper.ts': 'export const add = (value: number) => value + 1;',
    },
    { 'references/value.txt': '资料原文' },
  );
  const result = await runner!.run(
    'test',
    config,
    call('scripts/calculate.ts', {
      args: ['41', '$(echo INJECTION); && hello'],
      stdin: '{"buyer":"小林"}',
    }),
  );
  expect(result).toMatchObject({
    status: 'succeeded',
    exitCode: 0,
    skillId: config.id,
    skillRevision: 1,
    contentHash: config.contentHash,
    runtime: 'Node.js',
    truncated: false,
  });
  expect(JSON.parse(result.stdout)).toEqual({
    value: 42,
    arg: '$(echo INJECTION); && hello',
    stdin: '{"buyer":"小林"}',
    reference: '资料原文',
    secret: null,
    options: null,
  });
  await noTemporaryFiles();
});

it.each(['js', 'mjs', 'cjs', 'mts', 'cts'])(
  '%s 脚本使用内置 Node，无需安装项目依赖',
  async (ext) => {
    await setupRunner();
    const source = ext.endsWith('ts')
      ? 'const n: number = 42; console.log(n);'
      : 'console.log(42);';
    const result = await runner!.run(
      'test',
      skill({ [`scripts/sample.${ext}`]: source }),
      call(`scripts/sample.${ext}`),
    );
    expect(result).toMatchObject({ status: 'succeeded', stdout: '42\n', exitCode: 0 });
    await noTemporaryFiles();
  },
);

it('Bash 的 argv 不被再次作为命令解释；缺失 Python 时给出明确错误', async () => {
  await setupRunner();
  if (process.platform !== 'win32') {
    const literal = '$(touch SHOULD_NOT_EXIST); && 你好';
    const result = await runner!.run(
      'shell',
      skill({ 'scripts/echo.sh': 'set -euo pipefail\nprintf "%s" "$1"' }),
      call('scripts/echo.sh', { args: [literal] }),
    );
    expect(result).toMatchObject({ status: 'succeeded', stdout: literal, runtime: 'Bash' });
  }
  vi.stubEnv('PATH', '');
  const result = await runner!.run(
    'missing',
    skill({ 'scripts/check.py': 'print(42)' }),
    call('scripts/check.py'),
  );
  expect(result).toMatchObject({ status: 'failed', exitCode: null });
  expect(result.stderr).toContain('未找到 Python 解释器');
  await noTemporaryFiles();
});

it('拒绝不存在的脚本、任意命令、越界路径和非法参数，非零退出保留 stderr', async () => {
  await setupRunner();
  const config = skill({
    'scripts/fail.mjs': 'console.error("business failed"); process.exit(7);',
  });
  await expect(runner!.run('bad', config, call('scripts/missing.ts'))).rejects.toThrow(
    '脚本不存在',
  );
  for (const path of [
    '../escape.ts',
    'scripts/../escape.ts',
    '/scripts/check.ts',
    'scripts/a\\b.ts',
    'scripts/check.exe',
    'scripts//a.ts',
    'scripts/a:ads.ts',
    'scripts/__proto__/a.ts',
  ]) {
    expect(skillScriptCallSchema.safeParse({ path }).success).toBe(false);
  }
  for (const invalid of [
    { command: 'echo hi' },
    { args: ['\0'] },
    { timeoutMs: 30001 },
    { args: [42] },
  ]) {
    expect(skillScriptCallSchema.safeParse({ path: 'scripts/fail.mjs', ...invalid }).success).toBe(
      false,
    );
  }
  const result = await runner!.run('fail', config, call('scripts/fail.mjs'));
  expect(result).toMatchObject({ status: 'failed', exitCode: 7, stderr: 'business failed\n' });
  await noTemporaryFiles();
});

it('超时和正常退出都清理进程组中的后台子进程', async () => {
  if (process.platform === 'win32') return;
  await setupRunner();
  for (const timeout of [true, false]) {
    const config = skill({
      'scripts/parent.mjs': `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(child.pid);
${timeout ? 'setInterval(() => {}, 1000);' : 'child.unref();'}`,
    });
    const result = await runner!.run(
      'children',
      config,
      call('scripts/parent.mjs', { timeoutMs: 700 }),
    );
    expect(result.status).toBe(timeout ? 'timed_out' : 'succeeded');
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await waitFor(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await noTemporaryFiles();
  }
});

it('停止试运行、Agent 取消和关闭执行器都会结束正在运行的脚本', async () => {
  await setupRunner();
  const ready = join(dir!, 'ready');
  const config = skill({
    'scripts/wait.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ready'); setInterval(() => {}, 1000);`,
  });
  for (const mode of ['scope', 'signal', 'close']) {
    const abort = new AbortController();
    const pending = runner!.run(
      'active',
      config,
      call('scripts/wait.mjs', { args: [ready] }),
      abort.signal,
    );
    await waitFor(async () => {
      try {
        return (await readFile(ready, 'utf8')) === 'ready';
      } catch {
        return false;
      }
    });
    expect(runner!.cancel('unrelated')).toEqual({ cancelled: false });
    if (mode === 'scope') expect(runner!.cancel('active')).toEqual({ cancelled: true });
    if (mode === 'signal') abort.abort();
    if (mode === 'close') await runner!.close();
    expect((await pending).status).toBe('cancelled');
    await rm(ready);
    await noTemporaryFiles();
  }
  await expect(runner!.run('after-close', config, call('scripts/wait.mjs'))).rejects.toThrow(
    '已关闭',
  );
});

it('输出洪泛被截断并终止，并发名额在脚本结束后释放', async () => {
  await setupRunner();
  const config = skill({
    'scripts/flood.mjs': 'process.stdout.write("x".repeat(200000)); setInterval(() => {}, 1000);',
    'scripts/wait.mjs': 'setInterval(() => {}, 1000);',
  });
  const result = await runner!.run('flood', config, call('scripts/flood.mjs'));
  expect(result).toMatchObject({ status: 'output_limit', truncated: true });
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(65536);
  const first = runner!.run('one', config, call('scripts/wait.mjs'));
  const second = runner!.run('two', config, call('scripts/wait.mjs'));
  await expect(runner!.run('three', config, call('scripts/wait.mjs'))).rejects.toThrow('两个脚本');
  runner!.cancel('one');
  runner!.cancel('two');
  expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([
    'cancelled',
    'cancelled',
  ]);
  expect((await runner!.run('next', config, call('scripts/flood.mjs'))).status).toBe(
    'output_limit',
  );
  await noTemporaryFiles();
});

it('脚本 ZIP 往返、读源码和旧发布快照兼容；脚本变更参与哈希校验', async () => {
  await setupRunner();
  const original = draftInput(
    skill(
      { 'scripts/calculate.ts': 'console.log(42);', 'scripts/nested/helper.py': 'print(1)' },
      { 'references/value.txt': '42' },
    ),
  );
  const file = join(dir!, 'skill.zip');
  await writeFile(file, exportSkill(original));
  expect(await importSkill(file)).toEqual(original);
  const zip = new AdmZip(exportSkill(original));
  zip.addFile('scripts/unexpected.exe', Buffer.from('binary'));
  await writeFile(file, zip.toBuffer());
  await expect(importSkill(file)).rejects.toThrow();
  expect(
    skillInputSchema.safeParse({
      ...original,
      scripts: { 'scripts/a.ts': '', 'scripts/a.ts/nested.ts': '' },
    }).success,
  ).toBe(false);
  expect(
    skillInputSchema.safeParse({
      ...original,
      scripts: Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`scripts/${i}.ts`, ''])),
    }).success,
  ).toBe(false);
  const { scripts: _, ...oldConfig } = original;
  const legacy = { ...oldConfig, id: uid(), revision: 1, contentHash: hash(oldConfig) };
  const oldJson = JSON.stringify(legacy);
  expect(publishedSkills({ skillIds: [legacy.id], skills: [legacy] })[0]).toEqual(legacy);
  expect(JSON.stringify(legacy)).toBe(oldJson);
  const snapshot = skill({ 'scripts/calculate.ts': 'console.log(42);' });
  const source = new SnapshotSkillSource([snapshot]);
  expect(await source.readFile('/skills/calculate/scripts/calculate.ts')).toBe('console.log(42);');
  expect(await source.exists('/skills/calculate/scripts/../../SKILL.md')).toBe(false);
  await expect(source.readFile('/etc/passwd')).rejects.toThrow('not found');
  snapshot.scripts!['scripts/calculate.ts'] = 'console.log(99);';
  expect(() => publishedSkills({ skillIds: [snapshot.id], skills: [snapshot] })).toThrow(
    '快照校验失败',
  );
});

it('试运行 API 受开发者模式控制，运行未保存草稿且不创建 Skill 或改动绑定', async () => {
  f = await setup();
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  const router = new Router(f.engine, ai);
  const config = draftInput(
    skill({ 'scripts/calculate.ts': 'console.log(Number(process.argv[2]) + 1);' }),
  );
  const input = { runId: uid(), config, call: call('scripts/calculate.ts', { args: ['41'] }) };
  const binding = await f.db.agentBinding.findMany();
  await expect(router.call('skills.test', input)).rejects.toThrow();
  await f.db.appSetting.upsert({
    where: { key: 'developerModeEnabled' },
    update: { value: true },
    create: { key: 'developerModeEnabled', value: true },
  });
  expect(await router.call('skills.test', input)).toMatchObject({
    status: 'succeeded',
    stdout: '42\n',
    skillRevision: 0,
  });
  expect(await router.call('skills.cancelTest', { runId: input.runId })).toEqual({
    cancelled: false,
  });
  expect(apiInputs['skills.cancelTest'].safeParse({ runId: 'reply-production' }).success).toBe(
    false,
  );
  expect(await f.db.skillDefinition.count()).toBe(0);
  expect(await f.db.agentBinding.findMany()).toEqual(binding);
  expect(f.sends).toHaveLength(0);
});

async function modelFixture(steps: Array<{ name: string; arguments: unknown } | string>) {
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const step = steps[requests.length - 1] ?? '意外的额外调用';
    const tool = typeof step !== 'string';
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: `script-${requests.length}`,
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            finish_reason: tool ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: tool ? null : step,
              ...(tool
                ? {
                    tool_calls: [
                      {
                        id: `tool-${requests.length}`,
                        type: 'function',
                        function: { name: step.name, arguments: JSON.stringify(step.arguments) },
                      },
                    ],
                  }
                : {}),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server');
  await f!.db.modelProfile.update({
    where: { id: f!.model.id },
    data: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
  });
  return requests;
}

it('真实 Mastra 加载脚本并调用 runSkillScript，只执行已挂载发布副本，输出写入运行日志', async () => {
  f = await setup();
  const requests = await modelFixture([
    { name: 'skill', arguments: { name: 'calculate' } },
    { name: 'skill_read', arguments: { skillName: 'calculate', path: 'scripts/calculate.ts' } },
    {
      name: 'runSkillScript',
      arguments: {
        skillName: 'calculate',
        path: 'scripts/calculate.ts',
        args: ['41'],
        stdin: '',
        timeoutMs: 1000,
      },
    },
    '计算结果为 42',
  ]);
  const service = new SkillService(f.db);
  const source = draftInput(
    skill({
      'scripts/calculate.ts':
        'const value: number = Number(process.argv[2]) + 1; console.log(value);',
    }),
  );
  const saved = await service.save({ config: source });
  await service.save({
    config: {
      ...source,
      name: 'private',
      scripts: { 'scripts/calculate.ts': 'console.log("PRIVATE_CODE");' },
    },
  });
  const agent = await f.engine.agents.save({
    config: agentConfigSchema.parse({
      name: '脚本助手',
      prompt: '按技能计算。',
      modelProfileId: f.model.id,
      skillIds: [saved.id],
    }),
  });
  const published = await f.engine.agents.publish(agent.id, agent.draftRevision);
  const changed = await service.save({
    id: saved.id,
    expectedRevision: saved.revision,
    config: { ...source, scripts: { 'scripts/calculate.ts': 'console.log("CHANGED_CODE");' } },
  });
  await service.remove(saved.id, changed.revision);
  await f.engine.agents.validateTree(published.id);
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  const result = await ai.debug(published.configSnapshot as any, '计算 41 加一');
  expect(result.result.text).toBe('计算结果为 42');
  expect(requests).toHaveLength(4);
  const names = requests[0].tools.map((t: any) => t.function.name);
  expect(names).toEqual(
    expect.arrayContaining(['skill', 'skill_read', 'skill_search', 'runSkillScript']),
  );
  expect(names.some((n: string) => /sandbox|filesystem|execute_command/.test(n))).toBe(false);
  expect(JSON.stringify(requests[0])).not.toContain('const value');
  expect(JSON.stringify(requests[1])).toContain('scripts/calculate.ts');
  expect(JSON.stringify(requests[2])).toContain('const value');
  expect(JSON.stringify(requests)).not.toContain('PRIVATE_CODE');
  expect(JSON.stringify(requests)).not.toContain('CHANGED_CODE');
  expect(result.usage).toMatchObject({
    scriptExecutions: [
      {
        status: 'succeeded',
        stdout: '42\n',
        skillId: saved.id,
        skillRevision: saved.revision,
        contentHash: (published.configSnapshot as any).skills[0].contentHash,
      },
    ],
  });
  const logged = JSON.parse((await readFile(join(f.dir, 'sandbox', 'runs.jsonl'), 'utf8')).trim());
  expect(logged.usage.scriptExecutions[0].stdout).toBe('42\n');
  expect(f.sends).toHaveLength(0);
}, 30000);

it('委派子 Agent 只执行自己的冻结脚本，父 Agent 看不到子脚本源码', async () => {
  f = await setup();
  const requests = await modelFixture([
    { name: 'delegate_helper', arguments: { input: '计算数值' } },
    {
      name: 'runSkillScript',
      arguments: {
        skillName: 'calculate',
        path: 'scripts/child.mjs',
        args: [],
        stdin: '',
        timeoutMs: 1000,
      },
    },
    '子脚本结果为 42',
    '已核实，结果为 42',
  ]);
  const service = new SkillService(f.db);
  const saved = await service.save({
    config: draftInput(skill({ 'scripts/child.mjs': 'console.log("CHILD_ONLY_42");' })),
  });
  const child = await f.engine.agents.save({
    config: agentConfigSchema.parse({
      name: '计算子助手',
      prompt: '运行脚本。',
      modelProfileId: f.model.id,
      skillIds: [saved.id],
    }),
  });
  const childRev = await f.engine.agents.publish(child.id, child.draftRevision);
  await service.remove(saved.id, saved.revision);
  const parent = await f.engine.agents.save({
    config: agentConfigSchema.parse({
      name: '父助手',
      prompt: '委派 helper。',
      modelProfileId: f.model.id,
      subAgents: [{ alias: 'helper', revisionId: childRev.id }],
    }),
  });
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  const result = await ai.debug(await f.engine.agents.prepareDraft(parent.id), '计算');
  expect(result.result.text).toBe('已核实，结果为 42');
  expect(requests).toHaveLength(4);
  expect(requests[0].tools.map((t: any) => t.function.name)).not.toContain('runSkillScript');
  expect(requests[1].tools.map((t: any) => t.function.name)).toContain('runSkillScript');
  expect(JSON.stringify(requests[2])).toContain('CHILD_ONLY_42');
  expect(JSON.stringify(requests[3])).not.toContain('CHILD_ONLY_42');
  expect(result.usage).toMatchObject({
    scriptExecutions: [{ skillId: saved.id, stdout: 'CHILD_ONLY_42\n' }],
  });
}, 30000);

it.each([
  { skillName: 'private', path: 'scripts/check.mjs' },
  { skillName: 'calculate', path: 'scripts/missing.mjs' },
])(
  '模型选择未授权脚本时停止本轮，不额外请求修复：%j',
  async (target) => {
    f = await setup();
    const requests = await modelFixture([
      { name: 'runSkillScript', arguments: { ...target, args: [], stdin: '', timeoutMs: 1000 } },
    ]);
    const service = new SkillService(f.db);
    const mounted = await service.save({
      config: draftInput(skill({ 'scripts/check.mjs': 'console.log(42);' })),
    });
    await service.save({
      config: {
        ...draftInput(skill({ 'scripts/check.mjs': 'console.log("PRIVATE");' })),
        name: 'private',
      },
    });
    const agent = await f.engine.agents.save({
      config: agentConfigSchema.parse({
        name: '脚本助手',
        prompt: '按技能执行',
        modelProfileId: f.model.id,
        skillIds: [mounted.id],
      }),
    });
    ai = new MastraAi(f.db, f.dir, f.host);
    await ai.initialize();
    await expect(
      ai.debug(await f.engine.agents.prepareDraft(agent.id), '运行脚本'),
    ).rejects.toThrow('模型或工具执行失败');
    expect(requests).toHaveLength(1);
    expect(await readdir(join(f.dir, 'skill-runs'))).toEqual([]);
    expect(f.sends).toHaveLength(0);
  },
  30000,
);
