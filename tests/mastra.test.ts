import { it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup, flush, waitFor } from './helpers';
import { Engine } from '../packages/core/src/engine';
import { defaultConfig } from '../packages/agent-config/src/index';
import { DEFAULT_REPLY_PROMPT } from '../packages/contracts/src/reply-guidance';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MastraAi } from '../packages/ai/src/index';
let fixture: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let server: Server | undefined;
let runtime: Engine | undefined;
afterEach(async () => {
  await runtime?.stop();
  await ai?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await fixture?.cleanup();
  fixture = undefined;
  ai = undefined;
  server = undefined;
  runtime = undefined;
});
it('真实 Mastra 单次提交回复、工具循环截止及生产发送链路，学习与向量按店铺隔离', async () => {
  fixture = await setup();
  let calls = 0;
  let embeddings = 0;
  let mode = 'learning';
  let replyToolUsed = false;
  let beforeReplyResponse: (() => Promise<void>) | undefined;
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (req.url?.endsWith('/embeddings')) {
      embeddings++;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ embedding: [1, 0, 0] }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
      );
      return;
    }
    calls++;
    let text = JSON.stringify(
      mode.startsWith('reply')
        ? {
            action: mode === 'reply-handoff-final' ? 'handoff' : 'reply',
            text: '隔离调试回答',
            evidenceIds: mode === 'reply-evidence' ? ['not-a-real-evidence-id'] : [],
            reasonCode: mode === 'reply-handoff-final' ? '需人工核实订单' : 'fixture',
          }
        : {
            matchVerdict: 'not_applicable',
            replyVerdict: 'reasonable',
            reuseVerdict: 'not_reusable',
            reason: '本地兼容服务的结构化测试',
            evidenceIds: [],
            suggestions: [],
          },
    );
    // The endpoint ignores native JSON response formats for conversational replies but
    // supports function calling. submitReply is the terminal output, not a formatting call.
    const isReply = mode.startsWith('reply');
    const instructions = JSON.stringify(body.messages.filter((m: any) => m.role === 'system'));
    if (
      !isReply &&
      (!instructions.includes('properties') || body.response_format?.type !== 'json_object')
    )
      text = '普通文字不是合法的学习结果';
    const searchTool =
      (['reply-tool', 'reply-prose-tool'].includes(mode) && !replyToolUsed) ||
      mode === 'reply-loop';
    const tool =
      isReply && (!mode.startsWith('reply-prose') || searchTool)
        ? body.tools.find(
            (t: any) =>
              t.function.name ===
              (searchTool
                ? 'searchQaPairs'
                : mode === 'reply-handoff'
                  ? 'handoffToHuman'
                  : 'submitReply'),
          )
        : null;
    if (searchTool) replyToolUsed = true;
    const argumentsText = searchTool
      ? JSON.stringify({ query: '测试知识' })
      : mode === 'reply-handoff'
        ? JSON.stringify({ reason: '需人工核实订单' })
        : mode === 'reply-invalid'
          ? JSON.stringify({ text: '缺少 action 与 reasonCode' })
          : text;
    const toolCalls = tool
      ? [
          {
            index: 0,
            id: searchTool ? 'fixture-search' : 'fixture-submit',
            type: 'function',
            function: { name: tool.function.name, arguments: argumentsText },
          },
        ]
      : undefined;
    if (mode.startsWith('reply-prose'))
      text = mode === 'reply-prose-empty' ? '' : '您好，请问有什么可以帮您？';
    if (tool && beforeReplyResponse) {
      const hook = beforeReplyResponse;
      beforeReplyResponse = undefined;
      await hook();
    }
    const finishReason = tool ? 'tool_calls' : mode === 'reply-prose-truncated' ? 'length' : 'stop';
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'chatcmpl-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  ...(tool
                    ? {
                        tool_calls: toolCalls,
                        ...(mode === 'reply-prose-tool' ? { content: '我先查询一下知识库。' } : {}),
                      }
                    : { content: text }),
                  reasoning_content: '仅用于夹具验证：内部推理不能发送给买家',
                },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'chatcmpl-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                ...(tool
                  ? {
                      tool_calls: toolCalls,
                      ...(mode === 'reply-prose-tool' ? { content: '我先查询一下知识库。' } : {}),
                    }
                  : { content: text }),
                reasoning_content: '仅用于夹具验证：内部推理不能发送给买家',
              },
              finish_reason: finishReason,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
    }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/v1`;
  await fixture.db.modelProfile.update({
    where: { id: fixture.model.id },
    data: { baseUrl: url, provider: 'openai', model: 'glm-5.3-flash', secretRef: null },
  });
  ai = new MastraAi(fixture.db, fixture.dir, fixture.host);
  await ai.initialize();
  const result = await ai.evaluate(
    { questions: [{ text: '问题' }], answers: [{ text: '实际回答' }] },
    fixture.model.id,
    new AbortController().signal,
  );
  expect(result.result.replyVerdict).toBe('reasonable');
  expect(calls).toBeGreaterThan(0);
  mode = 'reply';
  const definition = await fixture.engine.agents.save({
    config: defaultConfig(fixture.model.id),
  });
  const rev = await fixture.engine.agents.publish(definition.id, definition.draftRevision);
  const beforeDirect = calls;
  const debug = await ai.debug(rev.configSnapshot as any, '请使用配置的工具回答测试问题');
  expect(calls - beforeDirect).toBe(1);
  expect(debug.result.text).toBe('隔离调试回答');
  expect(await fixture.db.aiRun.count()).toBe(0);
  expect(await fixture.db.outboundMessage.count()).toBe(0);
  expect(
    JSON.parse((await readFile(join(fixture.dir, 'sandbox', 'runs.jsonl'), 'utf8')).trim()),
  ).toMatchObject({ status: 'completed', usage: { totalTokens: 30 } });
  const replyRequest = requests.at(-1);
  expect(replyRequest.tool_choice).toBe('auto');
  expect(replyRequest.response_format).toBeUndefined();
  expect(JSON.stringify(replyRequest.tools)).toContain('searchQaPairs');
  expect(JSON.stringify(replyRequest.tools)).toContain('handoffToHuman');
  expect(JSON.stringify(replyRequest.tools)).toContain('submitReply');
  expect(
    replyRequest.tools.find((t: any) => t.function.name === 'submitReply').function.parameters
      .properties,
  ).toHaveProperty('reasonCode');
  mode = 'reply-tool';
  const beforeTool = calls;
  const afterTool = await ai.debug(rev.configSnapshot as any, '先检索知识再返回结构化回答');
  expect(afterTool.result.text).toBe('隔离调试回答');
  expect(replyToolUsed).toBe(true);
  expect(calls - beforeTool).toBe(2);
  expect(requests.at(-1).messages.some((m: any) => m.role === 'tool')).toBe(true);
  // Snapshots published before Workflow was removed may still list mounts; they are ignored.
  mode = 'reply';
  const beforeLegacy = calls;
  const legacy = await ai.debug(
    { ...(rev.configSnapshot as any), workflowIds: ['builtin/reply-helpers@1.0.0'] },
    '旧快照中的流程挂载不再生效',
  );
  expect(legacy.result.text).toBe('隔离调试回答');
  expect(calls - beforeLegacy).toBe(1);
  expect(JSON.stringify(requests.at(-1).tools)).not.toContain('reply_helpers');
  mode = 'reply-invalid';
  const beforeInvalid = calls;
  await expect(
    ai.debug(rev.configSnapshot as any, '模型仍返回错误结构时必须拒绝发送'),
  ).rejects.toThrow(/结构无效|执行失败/);
  expect(calls - beforeInvalid).toBe(1);
  mode = 'reply-prose';
  const beforeProse = calls;
  const native = await ai.debug(rev.configSnapshot as any, '单次生成面向买家的正文');
  expect(native.result).toMatchObject({
    action: 'reply',
    text: '您好，请问有什么可以帮您？',
    reasonCode: 'agent_text',
  });
  expect(native.result.text).not.toContain('内部推理');
  expect(calls - beforeProse).toBe(1);
  mode = 'reply-prose-tool';
  replyToolUsed = false;
  const beforeNativeTools = calls;
  const nativeWithTools = await ai.debug(rev.configSnapshot as any, '先查知识再生成正文');
  expect(nativeWithTools.result.text).toBe('您好，请问有什么可以帮您？');
  expect(nativeWithTools.result.text).not.toContain('我先查询');
  expect(calls - beforeNativeTools).toBe(2);
  for (const invalidTextMode of ['reply-prose-truncated', 'reply-prose-empty']) {
    mode = invalidTextMode;
    const beforeInvalidText = calls;
    await expect(ai.debug(rev.configSnapshot as any, '不发送未完成或空正文')).rejects.toThrow(
      /未完成回复|没有返回/,
    );
    expect(calls - beforeInvalidText).toBe(1);
  }
  mode = 'reply-loop';
  const beforeLoop = calls;
  await expect(
    ai.debug({ ...(rev.configSnapshot as any), maxSteps: 2 }, '工具循环不得超出配置步数'),
  ).rejects.toThrow(/未完成回复/);
  expect(calls - beforeLoop).toBe(2);

  mode = 'reply-handoff';
  const beforeHandoff = calls;
  expect((await ai.debug(rev.configSnapshot as any, '需要人工核实订单')).result.action).toBe(
    'handoff',
  );
  expect(calls - beforeHandoff).toBe(1);

  expect(await fixture.db.outboundMessage.count()).toBe(0);
  expect(fixture.sends).toHaveLength(0);

  // Production path: persisted inbound -> real Mastra -> terminal candidate -> checked outbox.
  // The host is local and fake, so this never sends a real customer message.
  runtime = new Engine(fixture.db, fixture.dir, fixture.host, ai);
  await runtime.agents.bind({
    scopeKey: `store:${fixture.account.storeId}`,
    revisionId: rev.id,
    expectedRevision: null,
  });
  await runtime.setPolicy({ storeId: fixture.account.storeId, autoReplyEnabled: true });
  mode = 'reply-prose';
  const beforeProduction = calls;
  const greeting = await runtime.ingest(fixture.inbound('在吗'));
  await flush(runtime, fixture.db);
  expect(calls - beforeProduction).toBe(1);
  expect(fixture.sends).toHaveLength(1);
  expect(await fixture.db.outboundMessage.findFirst()).toMatchObject({
    status: 'confirmed',
    origin: 'ai',
    body: { text: '您好，请问有什么可以帮您？' },
  });
  expect(await fixture.db.aiRun.findFirst()).toMatchObject({
    status: 'succeeded',
    path: 'agent',
    output: { action: 'reply' },
  });
  expect(await fixture.db.answeredTurn.count()).toBe(1);
  expect(
    await fixture.db.conversation.findUnique({ where: { id: greeting.conversationId } }),
  ).toMatchObject({ awaitingHuman: false });
  const greetingRequest = requests.at(-1);
  const system = JSON.stringify(greetingRequest.messages.filter((m: any) => m.role === 'system'));
  expect(system).toContain('不需要知识证据、检索或业务工具');
  expect(system).not.toContain('没有依据时调用 handoffToHuman');
  expect(system).not.toContain('没有充分依据时转人工');
  expect(system.split('接待判断：')).toHaveLength(2); // policy is supplied exactly once
  expect(system).toContain('买家明确要求人工');
  expect(system).toContain('不是每轮先调用 searchQaPairs');
  expect(system).toContain('不把问答检索作为平台查询的前置步骤');
  expect(JSON.stringify(greetingRequest.messages)).toContain('在吗');
  const greetingContext = greetingRequest.messages
    .filter((m: any) => m.role === 'user')
    .map((m: any) => JSON.parse(m.content))
    .at(-1);
  expect(greetingContext.knowledgeSearch).toEqual({ query: '在吗', status: 'failed' });
  expect((rev.configSnapshot as any).prompt).toBe(DEFAULT_REPLY_PROMPT);
  expect(
    greetingRequest.tools.find((t: any) => t.function.name === 'handoffToHuman').function
      .description,
  ).toContain('单纯问候、信息待补充或未命中问答不应调用');
  expect(
    greetingRequest.tools.find((t: any) => t.function.name === 'searchQaPairs').function
      .description,
  ).toContain('先读本轮 knowledge');

  for (const failureMode of ['reply-invalid', 'reply-evidence']) {
    mode = failureMode;
    const beforeFailure = calls;
    const message = await runtime.ingest(
      fixture.inbound('测试无效结果必须转人工', {
        buyerId: failureMode,
        conversationKey: `buyer:${failureMode}`,
      }),
    );
    await flush(runtime, fixture.db);
    expect(calls - beforeFailure).toBe(1);
    expect(fixture.sends).toHaveLength(1);
    expect(
      await fixture.db.conversation.findUnique({ where: { id: message.conversationId } }),
    ).toMatchObject({ awaitingHuman: true });
    expect(
      await fixture.db.aiRun.findFirst({ where: { conversationId: message.conversationId } }),
    ).toMatchObject({ status: 'failed' });
    await flush(runtime, fixture.db);
    expect(calls - beforeFailure).toBe(1);
  }

  mode = 'reply';
  const beforeTakeover = calls;
  const takeover = await runtime.ingest(
    fixture.inbound('生成期间人工接待', { buyerId: 'takeover', conversationKey: 'buyer:takeover' }),
  );
  beforeReplyResponse = () => runtime!.setReception(takeover.conversationId, 'human');
  await flush(runtime, fixture.db);
  await waitFor(
    async () =>
      (await fixture!.db.aiRun.findFirst({ where: { conversationId: takeover.conversationId } }))
        ?.status === 'failed',
  );
  expect(calls - beforeTakeover).toBe(1);
  expect(fixture.sends).toHaveLength(1);
  expect(
    await fixture.db.conversation.findUnique({ where: { id: takeover.conversationId } }),
  ).toMatchObject({ openedByHuman: true, awaitingHuman: false });

  // A successful handoff is a terminal business action, not a stale auto reply.
  for (const handoffMode of ['reply-handoff', 'reply-handoff-final']) {
    mode = handoffMode;
    const beforeHandoffCalls = calls;
    const beforeHandoffSends = fixture.sends.length;
    const beforeHandoffTurns = await fixture.db.answeredTurn.count();
    const beforeHandoffEvents = await fixture.db.businessEvent.count();
    const handoffMessage = await runtime.ingest(
      fixture.inbound('转人工', {
        buyerId: handoffMode,
        conversationKey: `buyer:${handoffMode}`,
      }),
    );
    await flush(runtime, fixture.db);
    const run = await fixture.db.aiRun.findFirstOrThrow({
      where: { conversationId: handoffMessage.conversationId },
    });
    expect(run).toMatchObject({
      status: 'succeeded',
      error: null,
      output: { action: 'handoff', reasonCode: '需人工核实订单' },
      usage: {
        outputMode: handoffMode === 'reply-handoff-final' ? 'terminal_tool' : 'handoff_tool',
      },
    });
    expect(await fixture.db.job.findUnique({ where: { id: run.jobId! } })).toMatchObject({
      status: 'succeeded',
      leaseToken: null,
      leaseUntil: null,
    });
    expect(
      await fixture.db.conversation.findUnique({ where: { id: handoffMessage.conversationId } }),
    ).toMatchObject({
      awaitingHuman: true,
      openedByHuman: false,
      humanSentAfterHandoff: false,
      handoffReason: '需人工核实订单',
    });
    await waitFor(
      async () =>
        (await fixture!.db.outboundMessage.findFirst({ where: { aiRunId: run.id } }))?.status ===
        'confirmed',
    );
    const notice = await fixture.db.outboundMessage.findFirstOrThrow({
      where: { aiRunId: run.id },
    });
    expect(notice).toMatchObject({
      status: 'confirmed',
      origin: 'handoff_notice',
      body: { text: '已为您转人工，请稍候。' },
    });
    await runtime.dispatch(notice.id);
    await runtime.ingest(
      fixture.inbound('还在吗', {
        buyerId: handoffMode,
        conversationKey: `buyer:${handoffMode}`,
      }),
    );
    await flush(runtime, fixture.db);
    expect(calls - beforeHandoffCalls).toBe(1);
    expect(fixture.sends.length - beforeHandoffSends).toBe(1);
    expect(await fixture.db.answeredTurn.count()).toBe(beforeHandoffTurns);
    expect(await fixture.db.businessEvent.count()).toBe(beforeHandoffEvents);
  }

  mode = 'reply-handoff';
  const beforeHandoffRace = calls;
  const beforeHandoffRaceSends = fixture.sends.length;
  const handoffRace = await runtime.ingest(
    fixture.inbound('转人工期间人工先接管', {
      buyerId: 'handoff-race',
      conversationKey: 'buyer:handoff-race',
    }),
  );
  beforeReplyResponse = () => runtime!.setReception(handoffRace.conversationId, 'human');
  await flush(runtime, fixture.db);
  await waitFor(
    async () =>
      (await fixture!.db.aiRun.findFirst({ where: { conversationId: handoffRace.conversationId } }))
        ?.status === 'failed',
  );
  expect(calls - beforeHandoffRace).toBe(1);
  expect(fixture.sends).toHaveLength(beforeHandoffRaceSends);
  expect(
    await fixture.db.conversation.findUnique({ where: { id: handoffRace.conversationId } }),
  ).toMatchObject({ openedByHuman: true, awaitingHuman: false });
  expect(
    await fixture.db.outboundMessage.count({
      where: { conversationId: handoffRace.conversationId },
    }),
  ).toBe(0);

  const embedding = await fixture.db.modelProfile.create({
    data: {
      name: 'embedding fixture',
      kind: 'embedding',
      model: 'embed',
      baseUrl: url,
      dimensions: 3,
    },
  });
  await fixture.db.appSetting.create({ data: { key: 'embeddingProfileId', value: embedding.id } });
  const r = await fixture.engine.knowledge.save({
    storeId: fixture.account.storeId,
    qa: {
      intent: '测试意图',
      answerKind: 'text',
      answer: '知识答案',
      scope: { productIds: [], conditions: '' },
    },
  });
  await ai.index(r.id);
  expect(await ai.search('other-store', '测试')).toEqual([]);
  expect((await ai.search(fixture.account.storeId, '测试'))[0]).toMatchObject({
    revisionId: r.id,
    qa: { answer: '知识答案' },
  });
  await fixture.engine.knowledge.setStatus(r.entryId, 'disabled', r.id);
  expect(await ai.search(fixture.account.storeId, '测试')).toEqual([]);
  expect(embeddings).toBeGreaterThan(0);
}, 30000);
