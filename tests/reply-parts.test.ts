import { afterEach, describe, expect, it } from 'vitest';
import { setup, flush } from './helpers';
import { splitReplyText } from '../packages/core/src/util';

describe('splitReplyText', () => {
  it('按空行拆分，去掉空白段，单段保持原样', () => {
    expect(splitReplyText('在的，请问有什么可以帮您？')).toEqual(['在的，请问有什么可以帮您？']);
    expect(splitReplyText('  在的～\n\n  有现货的。 \n \n\n')).toEqual(['在的～', '有现货的。']);
    expect(splitReplyText('第一行\n第二行')).toEqual(['第一行\n第二行']);
    expect(splitReplyText('A\r\n\r\nB')).toEqual(['A', 'B']);
    expect(splitReplyText('   ')).toEqual([]);
  });
  it('超过 3 段时并入最后一条，避免刷屏', () => {
    expect(splitReplyText('A\n\nB\n\nC\n\nD')).toEqual(['A', 'B', 'C\nD']);
  });
});

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});

it('AI 回复按空行拆成多条依次发送，共用同一回答序列', async () => {
  f = await setup();
  f.ai.replyResult = {
    action: 'reply',
    text: '在的～\n\n我可以帮您查商品、订单和物流。\n\n您想先办哪件事呢？',
    evidenceIds: [],
    reasonCode: 'test',
  };
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.ingest(f.inbound('你能做啥'));
  await flush(f.engine, f.db);
  expect(f.sends.map((s) => s.text)).toEqual([
    '在的～',
    '我可以帮您查商品、订单和物流。',
    '您想先办哪件事呢？',
  ]);
  const outbounds = await f.db.outboundMessage.findMany({ orderBy: { createdAt: 'asc' } });
  expect(outbounds.map((o) => o.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  expect(new Set(outbounds.map((o) => (o.body as any).sequenceHash)).size).toBe(1);
  expect(new Set(outbounds.map((o) => o.aiRunId)).size).toBe(1);
});

it('前一条未确认时停止后续分段，不重发', async () => {
  f = await setup();
  f.ai.replyResult = {
    action: 'reply',
    text: '有现货的。\n\n付款后 48 小时内发货。',
    evidenceIds: [],
    reasonCode: 'test',
  };
  f.setResponse({ status: 'rejected', reason: '会话已关闭' });
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.ingest(f.inbound('有货吗'));
  await flush(f.engine, f.db);
  expect(f.sends.map((s) => s.text)).toEqual(['有现货的。']);
  const outbounds = await f.db.outboundMessage.findMany({ orderBy: { createdAt: 'asc' } });
  expect(outbounds.map((o) => o.status)).toEqual(['rejected', 'cancelled']);
  expect(outbounds[1].error).toContain('分段回复前一条消息未确认');
});

it('问答直答保留原文，不拆分', async () => {
  f = await setup();
  const qa = {
    intent: '发货时间',
    answerKind: 'text' as const,
    answer: '现货 48 小时内发货。\n\n预售按页面时间发货。',
    scope: { productIds: [], conditions: '' },
  };
  const r = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  f.ai.matches = [{ entryId: r.entryId, revisionId: r.id, intent: qa.intent, qa, score: 0.96 }];
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.ingest(f.inbound('什么时候发货'));
  await flush(f.engine, f.db);
  expect(f.sends.map((s) => s.text)).toEqual([qa.answer]);
});

const learningRuns = async () =>
  (await f!.db.aiRun.findMany({ where: { role: 'learning' } })).map((r) => ({
    status: r.status,
    answers: (r.input as any).answerMessageIds?.length,
  }));

it('分段回复只算一个回答，全部发完后学习一次', async () => {
  f = await setup();
  f.ai.replyResult = {
    action: 'reply',
    text: '在的～\n\n我可以帮您查商品、订单和物流。\n\n您想先办哪件事呢？',
    evidenceIds: [],
    reasonCode: 'test',
  };
  await f.engine.setPolicy({
    storeId: f.account.storeId,
    autoReplyEnabled: true,
    autoLearnEnabled: true,
  });
  await f.engine.ingest(f.inbound('你能做啥'));
  await flush(f.engine, f.db);
  await flush(f.engine, f.db);
  expect(f.sends).toHaveLength(3);
  expect(f.ai.learnCalls).toBe(1);
  expect(await learningRuns()).toEqual([{ status: 'succeeded', answers: 3 }]);
  const turn = await f.db.answeredTurn.findFirstOrThrow();
  expect(turn.sourceRevision).toBe(1);
  expect(await f.db.turnAnswer.count({ where: { turnId: turn.id } })).toBe(3);
  expect(await f.db.job.count({ where: { kind: 'learn', status: { not: 'succeeded' } } })).toBe(0);
});

it('后续分段停发时，只学习已发出的部分，且只学习一次', async () => {
  f = await setup();
  f.ai.replyResult = {
    action: 'reply',
    text: '有现货的。\n\n付款后 48 小时内发货。\n\n还有其他问题吗？',
    evidenceIds: [],
    reasonCode: 'test',
  };
  const send = f.host.send;
  let n = 0;
  f.host.send = async (c) => (++n === 2 ? { status: 'rejected', reason: '会话已关闭' } : send(c));
  await f.engine.setPolicy({
    storeId: f.account.storeId,
    autoReplyEnabled: true,
    autoLearnEnabled: true,
  });
  await f.engine.ingest(f.inbound('有货吗'));
  await flush(f.engine, f.db);
  await flush(f.engine, f.db);
  const statuses = (await f.db.outboundMessage.findMany({ orderBy: { createdAt: 'asc' } })).map(
    (o) => o.status,
  );
  expect(statuses).toEqual(['confirmed', 'rejected', 'cancelled']);
  expect(f.ai.learnCalls).toBe(1);
  expect(await learningRuns()).toEqual([{ status: 'succeeded', answers: 1 }]);
});

it('AI 分段回复后人工再补充，人工消息照常单独学习', async () => {
  f = await setup();
  f.ai.replyResult = {
    action: 'reply',
    text: '有现货的。\n\n付款后 48 小时内发货。',
    evidenceIds: [],
    reasonCode: 'test',
  };
  await f.engine.setPolicy({
    storeId: f.account.storeId,
    autoReplyEnabled: true,
    autoLearnEnabled: true,
  });
  const m = await f.engine.ingest(f.inbound('有货吗'));
  await flush(f.engine, f.db);
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  await f.engine.sendManual({
    conversationId: m.conversationId,
    text: '更正：今天下单当天发货。',
    requestId: 'correct-split',
  });
  await flush(f.engine, f.db);
  await flush(f.engine, f.db);
  // A human follow-up is learned as its own context turn; the split AI reply stays one answer.
  const turns = await f.db.answeredTurn.findMany({ orderBy: { answeredAt: 'asc' } });
  expect(turns.map((t) => [t.associationMode, t.sourceRevision])).toEqual([
    ['explicit', 1],
    ['conversation_context', 1],
  ]);
  expect(f.ai.learnCalls).toBe(2);
});
