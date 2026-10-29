import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Engine } from '../packages/core/src/engine';
import { Router } from '../packages/core/src/router';
import { RunTrace, traceValue } from '../packages/core/src/run-trace';
import { MastraAi } from '../packages/ai/src';
import { defaultConfig } from '../packages/agent-config/src';
import { SkillService } from '../packages/agent-config/src/skills';
import { setup, flush, waitFor } from './helpers';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined, runtime: Engine | undefined, server: Server | undefined;
let release: (() => void) | undefined;
afterEach(async () => {
  release?.();
  await runtime?.stop();
  await ai?.close();
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  await f?.cleanup();
  f = undefined;
  ai = undefined;
  runtime = undefined;
  server = undefined;
  release = undefined;
});
type Answer =
  | string
  | Array<{ name: string; args: unknown; id: string }>
  | { text: string; finishReason: 'length' };
async function init(answers: Answer[], beforeResponse?: () => Promise<void>) {
  const t = (f = await setup());
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const answer = answers[requests.length] ?? 'unexpected model call';
    const truncated = typeof answer === 'object' && !Array.isArray(answer) ? answer : undefined;
    const usage = truncated
      ? {
          prompt_tokens: 6133,
          completion_tokens: 2048,
          total_tokens: 8181,
          completion_tokens_details: { reasoning_tokens: truncated.text ? 2000 : 2048 },
        }
      : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    requests.push(body);
    await beforeResponse?.();
    const tools = Array.isArray(answer)
      ? answer.map((t, index) => ({
          index,
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }))
      : undefined;
    const message = {
      role: 'assistant',
      content: typeof answer === 'string' ? answer : (truncated?.text ?? ''),
      reasoning_content: 'PRIVATE_MODEL_THOUGHT',
      ...(tools ? { tool_calls: tools } : {}),
    };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'trace-test',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [{ index: 0, delta: message, finish_reason: null }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'trace-test',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: truncated?.finishReason ?? (tools ? 'tool_calls' : 'stop'),
              },
            ],
            usage,
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'trace-test',
          object: 'chat.completion',
          model: 'fixture',
          choices: [
            {
              index: 0,
              message,
              finish_reason: truncated?.finishReason ?? (tools ? 'tool_calls' : 'stop'),
            },
          ],
          usage,
        }),
      );
    }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  await t.db.modelProfile.update({
    where: { id: t.model.id },
    data: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      provider: 'openai',
      model: 'fixture',
    },
  });
  ai = new MastraAi(t.db, t.dir, t.host);
  await ai.initialize();
  runtime = new Engine(t.db, t.dir, t.host, ai);
  const router = new Router(runtime, ai);
  const run = async (config = defaultConfig(t.model.id)) => {
    const a = await runtime!.agents.save({ config });
    const rev = await runtime!.agents.publish(a.id, a.draftRevision);
    await runtime!.agents.bind({
      scopeKey: `store:${t.account.storeId}`,
      revisionId: rev.id,
      expectedRevision: null,
    });
    await runtime!.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
    const question = await runtime!.ingest(t.inbound());
    await flush(runtime!, t.db);
    const result = await t.db.aiRun.findFirstOrThrow({
      where: { conversationId: question.conversationId },
    });
    const detail = (await router.call('runs.detail', {
      storeId: t.account.storeId,
      id: result.id,
    })) as any;
    return detail;
  };
  return { ...t, run, router, requests };
}
it.each(['', '我先核对订单，地址可以'])(
  '输出超限时保留用量和明确诊断，不发送空白或截断正文（%s）',
  async (text) => {
    const t = await init([{ text, finishReason: 'length' }]);
    const detail = await t.run();
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0].max_tokens).toBe(2048);
    expect(detail).toMatchObject({ status: 'failed', modelCalls: 1, toolCalls: 0, outbounds: [] });
    expect(detail.error).toContain('配置输出上限 2048 tokens');
    expect(detail.error).toContain('实际输出 2048 tokens');
    expect(detail.error).toContain(text ? '回复正文被截断' : '未生成回复正文');
    const model = detail.steps.find((step: any) => step.kind === 'model');
    expect(model).toMatchObject({
      status: 'failed',
      metadata: {
        maxOutputTokens: 2048,
        finishReason: 'length',
        usage: {
          inputTokens: 6133,
          outputTokens: 2048,
          totalTokens: 8181,
          reasoningTokens: text ? 2000 : 2048,
        },
      },
    });
    expect(model.error).toContain(`输出中用于思考 ${text ? 2000 : 2048} tokens`);
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_MODEL_THOUGHT');
    expect(await t.db.aiRun.findUnique({ where: { id: detail.id } })).toMatchObject({
      usage: { maxOutputTokens: 2048, finishReason: 'length', textLength: text.length },
    });
    await flush(runtime!, t.db);
    expect(t.requests).toHaveLength(1);
    expect(t.sends).toHaveLength(0);
  },
);
it('真实模型并行调用同名工具，输入结果按调用 ID 区分并实时持久化，不增加模型次数', async () => {
  const t = await init([
    [
      { name: 'searchQaPairs', args: { query: '配送' }, id: 'search-1' },
      { name: 'searchQaPairs', args: { query: '售后' }, id: 'search-2' },
    ],
    '已核实两个问题',
  ]);
  const detail = await t.run();
  expect(t.requests).toHaveLength(2);
  expect(detail).toMatchObject({
    status: 'succeeded',
    modelCalls: 2,
    toolCalls: 2,
    usage: { totalTokens: 30 },
    outbounds: [{ status: 'confirmed' }],
  });
  const tools = detail.steps.filter((s: any) => s.kind === 'tool');
  expect(tools).toHaveLength(2);
  expect(tools.map((s: any) => s.input.query).sort()).toEqual(['售后', '配送']);
  expect(tools.every((s: any) => s.status === 'succeeded' && Array.isArray(s.output))).toBe(true);
  expect(tools.map((s: any) => s.metadata.toolCallId).sort()).toEqual(['search-1', 'search-2']);
  expect(new Set(tools.map((s: any) => s.parentId)).size).toBe(1);
  expect(detail.steps.find((s: any) => s.id === tools[0].parentId).kind).toBe('model');
  expect(detail.steps.filter((s: any) => s.status === 'running')).toEqual([]);
  expect(JSON.stringify(detail.steps)).not.toContain('PRIVATE_MODEL_THOUGHT');
  expect(
    detail.steps.filter((s: any) => s.kind === 'model').every((s: any) => s.input.messages?.length),
  ).toBe(true);
});
it('Workflow 的模型工具调用与内部步骤有层级，保存实际输入输出', async () => {
  const answers: Answer[] = [];
  const n = await init(answers);
  const name = ai!.assets.alias('builtin/reply-helpers@1.0.0/normalize');
  answers.push(
    [{ name, args: { input: { text: '  工作流输出  ' } }, id: 'workflow-call' }],
    '工作流完成',
  );
  const detail = await n.run({
    ...defaultConfig(n.model.id),
    workflowIds: ['builtin/reply-helpers@1.0.0'],
  });
  expect(detail.status).toBe('succeeded');
  expect(n.requests).toHaveLength(2);
  const workflow = detail.steps.find((s: any) => s.kind === 'workflow');
  expect(workflow).toMatchObject({
    status: 'succeeded',
    input: { input: { text: '  工作流输出  ' } },
    output: { text: '工作流输出' },
  });
  expect(detail.steps.find((s: any) => s.kind === 'workflow_step')).toMatchObject({
    parentId: workflow.id,
    status: 'succeeded',
    input: { text: '  工作流输出  ' },
    output: { text: '工作流输出' },
  });
});
it('子 Agent 和 Skill 加载/脚本执行都被记录，脚本 stdout 与退出码可追踪', async () => {
  const t = await init([
    [{ name: 'delegate_helper', args: { input: '执行脚本' }, id: 'delegate-1' }],
    [{ name: 'skill', args: { name: 'calculate' }, id: 'skill-1' }],
    [
      {
        name: 'skill_read',
        args: { skillName: 'calculate', path: 'scripts/calc.mjs' },
        id: 'read-1',
      },
    ],
    [
      {
        name: 'runSkillScript',
        args: {
          skillName: 'calculate',
          path: 'scripts/calc.mjs',
          args: [],
          stdin: '',
          timeoutMs: 1000,
        },
        id: 'script-1',
      },
    ],
    '子助手结果 42',
    '最终结果 42',
  ]);
  const skill = await new SkillService(t.db).save({
    config: {
      name: 'calculate',
      description: '计算',
      instructions: '运行脚本',
      references: {},
      scripts: { 'scripts/calc.mjs': 'console.log(42)' },
    },
  });
  const child = await runtime!.agents.save({
    config: { ...defaultConfig(t.model.id), name: '计算子助手', skillIds: [skill.id] },
  });
  const rev = await runtime!.agents.publish(child.id, child.draftRevision);
  const detail = await t.run({
    ...defaultConfig(t.model.id),
    name: '主助手',
    subAgents: [{ alias: 'helper', revisionId: rev.id }],
  });
  expect(detail.status).toBe('succeeded');
  expect(t.requests).toHaveLength(6);
  const delegated = detail.steps.find((s: any) => s.toolName === 'delegate_helper');
  expect(detail.steps.find((s: any) => s.name === '计算子助手')).toMatchObject({
    parentId: delegated.id,
  });
  expect(detail.steps.filter((s: any) => s.kind === 'skill').map((s: any) => s.toolName)).toEqual([
    'skill',
    'skill_read',
    'runSkillScript',
  ]);
  expect(detail.steps.find((s: any) => s.toolName === 'runSkillScript')).toMatchObject({
    status: 'succeeded',
    output: { stdout: '42\n', exitCode: 0, status: 'succeeded' },
  });
  expect(detail.modelCalls).toBe(6);
  expect(detail.usage.totalTokens).toBe(90);
});
it('无效工具参数保留失败的输入与错误，不伪装成功或追加模型请求', async () => {
  const t = await init([
    [{ name: 'submitReply', args: { text: '缺少必填参数' }, id: 'invalid-1' }],
  ]);
  const detail = await t.run();
  expect(detail.status).toBe('failed');
  expect(t.requests).toHaveLength(1);
  const tool = detail.steps.find((s: any) => s.toolName === 'submitReply');
  expect(tool).toMatchObject({ status: 'failed', input: { text: '缺少必填参数' } });
  expect(tool.error).toBeTruthy();
  expect(detail.outbounds).toEqual([]);
  expect(detail.steps.some((s: any) => s.status === 'running')).toBe(false);
});
it('运行记录按店铺隔离、分页稳定；只读详情不触发刷新循环；历史记录不伪造步骤', async () => {
  const t = (f = await setup());
  const router = new Router(t.engine, {} as MastraAi);
  const data = {
    storeId: t.account.storeId,
    role: 'reply',
    path: 'agent',
    input: {},
    output: {},
    evidence: {},
    usage: {},
    status: 'succeeded',
    startedAt: new Date('2026-09-01'),
  };
  for (const id of ['a', 'b', 'c']) await t.db.aiRun.create({ data: { ...data, id } });
  await t.db.aiRun.create({ data: { ...data, id: 'foreign', storeId: 'another-store' } });
  const changed = vi.fn();
  t.engine.onChanged = changed;
  const first = (await router.call('runs.history', {
    storeId: t.account.storeId,
    limit: 2,
  })) as any;
  expect(first.runs.map((r: any) => r.id)).toEqual(['c', 'b']);
  const second = (await router.call('runs.history', {
    storeId: t.account.storeId,
    limit: 2,
    cursor: first.nextCursor,
  })) as any;
  expect(second.runs.map((r: any) => r.id)).toEqual(['a']);
  expect(second.nextCursor).toBeNull();
  expect(await router.call('runs.detail', { storeId: t.account.storeId, id: 'a' })).toMatchObject({
    traceVersion: 0,
    steps: [],
  });
  await expect(
    router.call('runs.detail', { storeId: t.account.storeId, id: 'foreign' }),
  ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  const all = (await router.call('runs.history', { limit: 10 })) as any;
  expect(all.runs.map((r: any) => r.id)).toEqual(['foreign', 'c', 'b', 'a']);
  expect(changed).not.toHaveBeenCalled();
});
it('中途重启把未结束步骤标为中断，保留已完成工具结果', async () => {
  const t = (f = await setup());
  const run = await t.db.aiRun.create({
    data: {
      storeId: t.account.storeId,
      role: 'reply',
      path: 'agent',
      input: {},
      output: {},
      evidence: {},
      usage: {},
      traceVersion: 1,
    },
  });
  const trace = new RunTrace(t.db, run.id);
  await trace.record({ kind: 'tool', name: '已完成工具', output: { result: 42 } });
  await trace.start({ kind: 'model', name: '未完成模型' });
  await t.engine.initialize();
  expect(await t.db.aiRunStep.findMany({ orderBy: { sequence: 'asc' } })).toMatchObject([
    { status: 'succeeded', output: { result: 42 } },
    { status: 'cancelled', error: expect.stringContaining('重启') },
  ]);
  expect(await t.db.aiRun.findUnique({ where: { id: run.id } })).toMatchObject({
    status: 'failed',
  });
});
it('采集过滤密钥与隐藏推理、限制大结果并正确处理 bigint / 循环对象', () => {
  const cycle: any = {
    apiKey: 'secret',
    access_token: 'token',
    content: [{ type: 'reasoning', text: 'PRIVATE_THOUGHT' }],
    response: 'known-secret-value',
    n: 99999999999999999999n,
    large: 'x'.repeat(70000),
  };
  cycle.self = cycle;
  const value = JSON.stringify(traceValue(cycle, ['known-secret-value']));
  expect(value).not.toContain('PRIVATE_THOUGHT');
  expect(value).not.toContain('known-secret-value');
  expect(value).not.toContain('"secret"');
  expect(value).toContain('99999999999999999999');
  expect(value.length).toBeLessThan(15000);
});

it('模型仍在等待时即可读取 running 步骤，返回后在同一记录保存结果', async () => {
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = await init(['实时返回的回复'], () => gate);
  const done = t.run();
  await waitFor(
    async () => !!(await t.db.aiRunStep.findFirst({ where: { kind: 'model', status: 'running' } })),
  );
  const running = await t.db.aiRun.findFirstOrThrow();
  const detail = (await t.router.call('runs.detail', {
    storeId: t.account.storeId,
    id: running.id,
  })) as any;
  const pending = detail.steps.find((s: any) => s.kind === 'model');
  expect(pending).toMatchObject({ status: 'running', output: null, finishedAt: null });
  release!();
  const finished = await done;
  expect(finished.steps.find((s: any) => s.id === pending.id)).toMatchObject({
    status: 'succeeded',
    output: { text: '实时返回的回复' },
  });
  expect(t.requests).toHaveLength(1);
});

it('脚本返回非零退出码时步骤标失败并保留 stderr，后续模型仍看到原始结果', async () => {
  const t = await init([
    [
      {
        name: 'runSkillScript',
        args: {
          skillName: 'failure',
          path: 'scripts/fail.mjs',
          args: [],
          stdin: '',
          timeoutMs: 1000,
        },
        id: 'script-failure',
      },
    ],
    '脚本失败，请人工核实',
  ]);
  const saved = await new SkillService(t.db).save({
    config: {
      name: 'failure',
      description: '测试失败',
      instructions: '运行脚本',
      references: {},
      scripts: { 'scripts/fail.mjs': 'console.error("执行出错"); process.exit(7)' },
    },
  });
  const detail = await t.run({ ...defaultConfig(t.model.id), skillIds: [saved.id] });
  expect(t.requests).toHaveLength(2);
  expect(detail.steps.find((s: any) => s.toolName === 'runSkillScript')).toMatchObject({
    status: 'failed',
    output: { exitCode: 7, stderr: '执行出错\n' },
  });
  expect(JSON.stringify(t.requests[1].messages)).toContain('执行出错');
});

it('内置学习模型同样采集实际 JSON 结果，仍只有一次模型请求', async () => {
  const evaluation = {
    matchVerdict: 'not_applicable',
    replyVerdict: 'reasonable',
    reuseVerdict: 'not_reusable',
    reason: '无新知识',
    evidenceIds: [],
    suggestions: [],
  };
  const t = await init([JSON.stringify(evaluation)]);
  const run = await t.db.aiRun.create({
    data: {
      storeId: t.account.storeId,
      role: 'learning',
      path: 'agent',
      input: {},
      output: {},
      evidence: {},
      usage: {},
      traceVersion: 1,
    },
  });
  const trace = new RunTrace(t.db, run.id);
  const result = await ai!.evaluate(
    { storeId: t.account.storeId, questions: [{ text: '在吗' }], answers: [{ text: '在的' }] },
    t.model.id,
    new AbortController().signal,
    undefined,
    trace,
  );
  expect(result.result).toEqual(evaluation);
  expect(t.requests).toHaveLength(1);
  expect(await t.db.aiRunStep.findMany({ where: { runId: run.id } })).toMatchObject([
    { kind: 'model', status: 'succeeded', output: { text: JSON.stringify(evaluation) } },
  ]);
});
