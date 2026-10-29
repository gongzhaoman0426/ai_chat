import { afterEach, expect, it } from 'vitest';
import { setup, flush } from './helpers';
import { HUMAN_LEARNING_SETTLE_MS } from '../packages/core/src/human-learning';
import { hash } from '../packages/core/src/util';
import { BUILTIN_LEARNING_VERSION } from '../packages/core/src/types';
let fixture: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
async function init() {
  fixture = await setup();
  await fixture.engine.setPolicy({ storeId: fixture.account.storeId, autoLearnEnabled: true });
  return fixture;
}

it('超过旧每日学习上限继续评估，建议仍须审批，旧指纹任务恢复不重复学习', async () => {
  const f = await init();
  await f.db.aiRun.createMany({
    data: Array.from({ length: 301 }, () => ({
      storeId: f.account.storeId,
      role: 'learning',
      path: 'agent',
      status: 'succeeded',
      input: {},
      output: {},
      evidence: [],
      usage: { inputTokens: 10 },
    })),
  });
  const q = await f.engine.ingest(f.inbound('发货时间'));
  await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '48 小时内发出',
    requestId: 'unlimited-learning',
  });
  f.ai.result.suggestions = [
    {
      action: 'create_qa',
      reason: '可复用',
      qa: {
        intent: '发货时间',
        answerKind: 'text',
        answer: '48 小时内发出',
        scope: { productIds: [], conditions: '' },
      },
    },
  ];
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  const evaluation = await f.db.learningEvaluation.findFirstOrThrow();
  const candidate = await f.db.knowledgeCandidate.findFirstOrThrow();
  expect(candidate.status).toBe('pending_review');
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  const run = await f.db.aiRun.findUniqueOrThrow({ where: { id: evaluation.aiRunId! } });
  expect(run.usage).toMatchObject({ inputTokens: 10 });
  expect(await f.db.job.findUniqueOrThrow({ where: { id: run.jobId! } })).toMatchObject({
    status: 'succeeded',
  });

  // Simulate the upgrade/crash boundary: evaluation committed under the old
  // fingerprint, but its durable task still needs to record completion.
  await f.db.learningEvaluation.update({
    where: { id: evaluation.id },
    data: {
      evaluatorVersion: hash({ builtin: BUILTIN_LEARNING_VERSION, model: f.model, limits: 1 }),
    },
  });
  await f.db.job.update({ where: { id: run.jobId! }, data: { status: 'retry_wait' } });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  expect(await f.db.learningEvaluation.count()).toBe(1);
  expect(await f.db.knowledgeCandidate.findMany()).toEqual([candidate]);

  // Another answered turn on the same day still runs, while completed turns stay deduplicated.
  const next = await f.engine.ingest(
    f.inbound('另一件商品什么时候发货', { conversationKey: 'buyer:next-learning' }),
  );
  await f.engine.sendManual({
    conversationId: next.conversationId,
    text: '现货 48 小时内发出',
    requestId: 'next-learning',
  });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(2);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
});

it('连续人工文字和图片归入一个学习来源，防抖后只调用一次评估', async () => {
  const f = await init();
  const q = await f.engine.ingest(
    f.inbound('杯子尺寸多少？', { raw: { privatePlatformField: 'not-model-input' } }),
  );
  const first = await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '请看尺寸图',
    requestId: 'text',
  });
  const image = await f.engine.knowledge.attach(
    f.account.storeId,
    Buffer.from('image'),
    '尺寸.png',
  );
  const second = await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '',
    attachmentId: image.id,
    requestId: 'image',
  });
  const turn = await f.db.answeredTurn.findFirstOrThrow({ include: { answers: true } });
  expect(await f.db.answeredTurn.count()).toBe(1);
  expect(turn.sourceRevision).toBe(2);
  expect(turn.answers.map((a) => a.outboundId).sort()).toEqual([first.id, second.id].sort());
  await f.engine.tick();
  const job = await f.db.job.findFirstOrThrow({ where: { kind: 'learn' } });
  expect(job.runAfter.getTime()).toBeGreaterThanOrEqual(
    turn.answeredAt.getTime() + HUMAN_LEARNING_SETTLE_MS,
  );
  expect(f.ai.learnCalls).toBe(0);
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.ai.learnInputs[0]).toMatchObject({
    associationMode: 'conversation_context',
    questions: [{ id: q.id }],
    answers: [
      { message: { text: '请看尺寸图', origin: 'human' } },
      { message: { kind: 'image', attachmentId: image.id, origin: 'human' } },
    ],
  });
  expect(f.ai.learnInputs[0].context[0]).not.toHaveProperty('raw');
  expect(f.ai.learnInputs[0].questions[0]).not.toHaveProperty('raw');
});

it('新买家消息开始新的人工学习回合，不把下一轮答案追加到上一轮', async () => {
  const f = await init();
  const firstQuestion = await f.engine.ingest(f.inbound('什么时候发货'));
  await f.engine.sendManual({
    conversationId: firstQuestion.conversationId,
    text: '明天',
    requestId: 'first',
  });
  const nextQuestion = await f.engine.ingest(f.inbound('什么快递'));
  await f.engine.sendManual({
    conversationId: nextQuestion.conversationId,
    text: '顺丰',
    requestId: 'second',
  });
  const turns = await f.db.answeredTurn.findMany({ include: { questionGroup: true } });
  expect(turns).toHaveLength(2);
  expect(turns.map((t) => t.questionGroup.messageIds)).toEqual(
    expect.arrayContaining([[firstQuestion.id], [nextQuestion.id]]),
  );
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(2);
});

it('发送 unknown 不学习，迟到确认只使用发送时已经看到的问题', async () => {
  const f = await init();
  f.setResponse({ status: 'unknown', reason: '等待回执' });
  const q = await f.engine.ingest(f.inbound('什么时候发货'));
  const outbound = await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '明天发出',
    requestId: 'late',
  });
  expect(await f.db.answeredTurn.count()).toBe(0);
  const later = await f.engine.ingest(
    f.inbound('新问题，不能算这条回答的来源', {
      timestamp: new Date(outbound.createdAt.getTime() - 1).toISOString(),
    }),
  );
  await f.db.message.update({
    where: { id: later.id },
    data: { receivedAt: new Date(outbound.createdAt.getTime() + 1000) },
  });
  await f.engine.completeSend(outbound.id, { status: 'confirmed', externalId: 'late-receipt' });
  const turn = await f.db.answeredTurn.findFirstOrThrow({ include: { questionGroup: true } });
  expect(turn.questionGroup.messageIds).toEqual([q.id]);
  expect(turn.contextMessageIds).not.toContain(later.id);
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
});

it('平台回显先到、重复回显、重复确认都只采集一次人工答案', async () => {
  const f = await init();
  f.setResponse({ status: 'unknown', reason: '等待确认' });
  const q = await f.engine.ingest(f.inbound());
  const out = await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '明天',
    requestId: 'echo',
  });
  const echo = f.inbound('明天', { externalId: 'echo-id', direction: 'out', origin: 'human' });
  await f.engine.ingest(echo);
  expect(await f.db.answeredTurn.count()).toBe(0);
  await f.engine.completeSend(out.id, { status: 'confirmed', externalId: 'echo-id' });
  await f.engine.ingest(echo);
  await f.engine.completeSend(out.id, { status: 'confirmed', externalId: 'echo-id' });
  expect(await f.db.turnAnswer.count()).toBe(1);
  expect(await f.db.businessEvent.count()).toBe(1);
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
});

it('开启学习不补跑关闭期间的回复，后续回复单独采集，旧回复仅作上下文', async () => {
  const f = await init();
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: false });
  const q = await f.engine.ingest(f.inbound());
  await f.engine.sendManual({ conversationId: q.conversationId, text: '旧回复', requestId: 'off' });
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(0);
  await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '开启后的补充回复',
    requestId: 'on',
  });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  expect(f.ai.learnInputs[0].answers.map((a: any) => a.message.text)).toEqual(['开启后的补充回复']);
});

it('无买家上下文或只有未来问题时不伪造问答、不请求模型、不要求人工配对', async () => {
  const f = await init();
  const future = await f.engine.ingest(
    f.inbound('尚未发生的问题', { timestamp: new Date(Date.now() + 60000).toISOString() }),
  );
  await f.engine.sendManual({
    conversationId: future.conversationId,
    text: '主动招呼',
    requestId: 'no-context',
  });
  const message = await f.db.message.findFirstOrThrow({ where: { direction: 'out' } });
  expect(message.associationStatus).toBe('no_question_context');
  expect(await f.db.answeredTurn.count()).toBe(0);
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(0);
});

it('引用的聊天上下文被撤回会使人工学习来源与未审批建议失效', async () => {
  const f = await init();
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: false });
  await f.engine.ingest(f.inbound('旧问题'));
  const oldReplyInput = f.inbound('旧 AI 回答', { direction: 'out', origin: 'ai' });
  const oldReply = await f.engine.ingest(oldReplyInput);
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  const q = await f.engine.ingest(f.inbound('发货时间'));
  await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '48 小时内发出',
    requestId: 'context',
  });
  f.ai.result = {
    ...f.ai.result,
    suggestions: [
      {
        action: 'create_qa',
        reason: '可复用',
        qa: {
          intent: '发货时间',
          answerKind: 'text',
          answer: '48 小时内发出',
          scope: { productIds: [], conditions: '' },
        },
      },
    ],
  };
  await flush(f.engine, f.db);
  const turn = await f.db.answeredTurn.findFirstOrThrow({
    where: { associationMode: 'conversation_context' },
  });
  expect(turn.contextMessageIds).toContain(oldReply.id);
  expect((await f.db.knowledgeCandidate.findFirstOrThrow()).status).toBe('pending_review');
  await f.engine.ingest({ ...oldReplyInput, withdrawn: true });
  expect(await f.db.answeredTurn.findUnique({ where: { id: turn.id } })).toMatchObject({
    status: 'invalidated',
    sourceRevision: 2,
  });
  expect((await f.db.knowledgeCandidate.findFirstOrThrow()).status).toBe('stale');
  expect(await f.db.knowledgeEntry.count()).toBe(0);
});

it('重启只恢复已经采集的学习事件，不扫描旧 needs_association 消息', async () => {
  const f = await init();
  const q = await f.engine.ingest(f.inbound());
  await f.engine.sendManual({
    conversationId: q.conversationId,
    text: '新回复',
    requestId: 'restart',
  });
  await f.db.message.create({
    data: {
      conversationId: q.conversationId,
      storeId: f.account.storeId,
      externalId: 'legacy',
      direction: 'out',
      origin: 'human',
      text: '旧版本待关联消息',
      timestamp: new Date(0),
      associationStatus: 'needs_association',
      raw: {},
    },
  });
  await f.engine.initialize();
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  expect(await f.db.turnAnswer.count()).toBe(1);
  expect(
    (await f.db.message.findFirstOrThrow({ where: { externalId: 'legacy' } })).associationStatus,
  ).toBe('needs_association');
});
