import { afterEach, expect, it } from 'vitest';
import {
  buildLearningEvidence,
  resolveLearningEvidence,
} from '../packages/core/src/learning-evidence';
import { setup, flush } from './helpers';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
const init = async () => (fixture = await setup());
const qa = {
  intent: '现货多久发货',
  answerKind: 'text' as const,
  answer: '现货 48 小时内发货。',
  scope: { productIds: [], conditions: '' },
};

it('历史回复中的知识旧版和真实消息加入统一证据；条目、临时工具、跨店铺/会话和撤回 ID 不作为证据', async () => {
  const f = await init();
  const old = await f.engine.ingest(
    f.inbound('历史问题', { timestamp: new Date(Date.now() - 10000).toISOString() }),
  );
  const question = await f.engine.ingest(f.inbound());
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: qa.answer,
    requestId: 'source-answer',
  });
  const answer = await f.db.message.findFirstOrThrow({ where: { direction: 'out' } });
  const revision = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  const current = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    entryId: revision.entryId,
    expectedRevisionId: revision.id,
    qa: { ...qa, answer: '现货 24 小时内发货。' },
  });
  const otherConversation = await f.engine.ingest(
    f.inbound('其他会话', {
      conversationKey: 'other-buyer',
      timestamp: old.timestamp.toISOString(),
    }),
  );
  const withdrawn = await f.engine.ingest(
    f.inbound('已撤回', { timestamp: old.timestamp.toISOString(), withdrawn: true }),
  );
  const future = await f.engine.ingest(
    f.inbound('回答之后的消息', {
      timestamp: new Date(answer.timestamp.getTime() + 10000).toISOString(),
    }),
  );
  const otherStore = await f.db.store.create({
    data: {
      externalId: 'foreign-store',
      name: '另一店铺',
      accounts: {
        create: {
          externalId: 'foreign-staff',
          name: '另一店铺客服',
          sessionPartition: 'persist:foreign-store',
          capabilities: {},
        },
      },
    },
  });
  const foreign = await f.engine.knowledge.save({ storeId: otherStore.id, qa });
  const all = [
    old.id,
    revision.id,
    'temporary-tool-id',
    revision.entryId,
    foreign.id,
    otherConversation.id,
    withdrawn.id,
    future.id,
  ];
  const sources = await buildLearningEvidence(f.db, {
    storeId: f.account.storeId,
    conversationId: question.conversationId,
    questions: [question],
    context: [],
    answers: [answer],
    knowledge: await f.engine.knowledge.list(f.account.storeId),
    runs: [
      {
        id: 'reply-run-id',
        path: 'agent',
        output: { evidenceIds: all },
        evidence: [{ revisionId: revision.id, entryId: revision.entryId }],
      },
    ],
  });
  expect(sources.input.context).toEqual([
    expect.objectContaining({
      id: old.id,
      text: '历史问题',
      evidenceRef: expect.stringMatching(/^E\d+$/),
    }),
  ]);
  const entry = sources.input.knowledge.find((e) => e.entryId === revision.entryId)!;
  expect(entry.revisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: revision.id, isActive: false, answer: qa.answer }),
      expect.objectContaining({ id: current.id, isActive: true, answer: '现货 24 小时内发货。' }),
    ]),
  );
  const allowed = sources.diagnostics.catalog.map((e) => e.id);
  expect(allowed).toEqual(
    expect.arrayContaining([question.id, answer.id, old.id, revision.id, current.id]),
  );
  expect(sources.diagnostics.omittedReplyRefs).toEqual(
    expect.arrayContaining([
      'temporary-tool-id',
      revision.entryId,
      foreign.id,
      otherConversation.id,
      withdrawn.id,
      future.id,
    ]),
  );
  expect(sources.input.replyEvidence[0].unavailableEvidenceCount).toBe(6);
  expect(sources.input.replyEvidence[0].evidenceRefs).toHaveLength(2);
  for (const invalid of [
    'temporary-tool-id',
    'reply-run-id',
    foreign.id,
    otherConversation.id,
    withdrawn.id,
    future.id,
  ])
    expect(JSON.stringify(sources.input)).not.toContain(invalid);
  const result = resolveLearningEvidence(
    { ...f.ai.result, evidenceIds: [revision.entryId, 'E999', 'temporary-tool-id', foreign.id] },
    sources.diagnostics.catalog,
  );
  expect(result.invalidIds).toHaveLength(4);
});

it('不在首批知识内的已停用引用可供历史匹配评估，但标记不可作为当前答案', async () => {
  const f = await init();
  const question = await f.engine.ingest(f.inbound());
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: qa.answer,
    requestId: 'archived-answer',
  });
  const answer = await f.db.message.findFirstOrThrow({ where: { direction: 'out' } });
  const revision = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  await f.db.knowledgeEntry.update({
    where: { id: revision.entryId },
    data: { status: 'disabled' },
  });
  const sources = await buildLearningEvidence(f.db, {
    storeId: f.account.storeId,
    conversationId: question.conversationId,
    questions: [question],
    context: [],
    answers: [answer],
    knowledge: [],
    runs: [
      { id: 'run', path: 'direct_match', output: {}, evidence: [{ revisionId: revision.id }] },
    ],
  });
  expect(sources.input.knowledge).toEqual([
    expect.objectContaining({
      entryId: revision.entryId,
      status: 'disabled',
      revisions: [expect.objectContaining({ id: revision.id, isActive: false })],
    }),
  ]);
  expect(sources.diagnostics.omittedReplyRefs).toEqual([]);
});

it('学习实际 AI 回复时忽略无法核实的工具编号，但保留真实知识依据且只评估一次', async () => {
  const f = await init();
  const revision = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  const question = await f.engine.ingest(f.inbound());
  // An actual confirmed source with a linked AI run; mirror the reported transient ID.
  const sourceRun = await f.db.aiRun.create({
    data: {
      storeId: f.account.storeId,
      conversationId: question.conversationId,
      role: 'reply',
      path: 'agent',
      status: 'succeeded',
      input: {},
      output: { evidenceIds: [revision.id, 'unsaved-platform-tool-id'] },
      evidence: [{ revisionId: revision.id, entryId: revision.entryId }],
      usage: {},
    },
  });
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: qa.answer,
    requestId: 'linked-answer',
  });
  const outbound = await f.db.outboundMessage.findFirstOrThrow();
  await f.db.outboundMessage.update({
    where: { id: outbound.id },
    data: { aiRunId: sourceRun.id, origin: 'ai' },
  });
  const answer = await f.db.message.findFirstOrThrow({ where: { direction: 'out' } });
  await f.db.message.update({ where: { id: answer.id }, data: { origin: 'ai' } });
  f.ai.evaluate = async (raw) => {
    f.ai.learnCalls++;
    const input = raw as { evidenceCatalog: Array<{ id: string; ref: string }> };
    f.ai.learnInputs.push(raw);
    return {
      result: {
        ...f.ai.result,
        evidenceIds: [input.evidenceCatalog.find((e) => e.id === revision.id)!.ref],
      },
      usage: { inputTokens: 1 },
    };
  };
  await flush(f.engine, f.db);
  const run = await f.db.aiRun.findFirstOrThrow({ where: { role: 'learning' } });
  expect(run).toMatchObject({
    status: 'succeeded',
    output: { evidenceIds: [revision.id] },
    evidence: { omittedReplyRefs: ['unsaved-platform-tool-id'], invalidEvidenceIds: [] },
  });
  expect(JSON.stringify(f.ai.learnInputs[0])).not.toContain('unsaved-platform-tool-id');
  expect(JSON.stringify(f.ai.learnInputs[0])).not.toContain(sourceRun.id);
  expect(f.ai.learnCalls).toBe(1);
  expect(await f.db.knowledgeCandidate.count()).toBe(0);
  expect(f.sends).toHaveLength(1);
});

it('持久化平台资料进入 E 引用清单；拒绝跨买家、其他运行、未来或未实际引用的平台资料', async () => {
  const f = await init();
  const question = await f.engine.ingest(f.inbound('这款是什么材质'));
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: '商品属性是纯棉。',
    requestId: 'platform-source',
  });
  const answer = await f.db.message.findFirstOrThrow({ where: { direction: 'out' } });
  const run = await f.db.aiRun.create({
    data: {
      storeId: f.account.storeId,
      conversationId: question.conversationId,
      role: 'reply',
      path: 'agent',
      status: 'succeeded',
      input: {},
      output: {},
      evidence: [],
      usage: {},
    },
  });
  const fact = {
    runId: run.id,
    storeId: f.account.storeId,
    conversationId: question.conversationId,
    accountId: f.account.id,
    buyerId: 'buyer-a',
    operation: 'goods-detail',
    subjectId: '12345',
    input: { goodsId: '12345' },
    result: {
      operation: 'goods-detail',
      subjectId: '12345',
      queriedAt: question.timestamp.toISOString(),
      partial: false,
      failedSections: [],
      data: { properties: [{ name: '材质', values: ['纯棉'] }] },
    },
    observedAt: question.timestamp,
  };
  const real = await f.db.platformEvidence.create({ data: { ...fact, queryKey: 'real' } });
  const otherBuyer = await f.db.platformEvidence.create({
    data: { ...fact, buyerId: 'different', queryKey: 'other-buyer' },
  });
  const future = await f.db.platformEvidence.create({
    data: { ...fact, queryKey: 'future', observedAt: new Date(answer.timestamp.getTime() + 60000) },
  });
  const uncited = await f.db.platformEvidence.create({ data: { ...fact, queryKey: 'uncited' } });
  const otherRun = await f.db.aiRun.create({
    data: {
      storeId: f.account.storeId,
      conversationId: question.conversationId,
      role: 'reply',
      path: 'agent',
      status: 'succeeded',
      input: {},
      output: {},
      evidence: [],
      usage: {},
    },
  });
  const unrelated = await f.db.platformEvidence.create({
    data: { ...fact, runId: otherRun.id, queryKey: 'other-run' },
  });
  const cited = [real.id, otherBuyer.id, future.id, unrelated.id];
  const evidence = await buildLearningEvidence(f.db, {
    storeId: f.account.storeId,
    conversationId: question.conversationId,
    questions: [question],
    answers: [answer],
    context: [],
    knowledge: [],
    runs: [{ ...run, output: { evidenceIds: cited } }],
  });
  expect(evidence.input.platformFacts).toHaveLength(1);
  expect(evidence.input.platformFacts[0]).toMatchObject({
    operation: 'goods-detail',
    data: { properties: [{ name: '材质', values: ['纯棉'] }] },
  });
  const ref = evidence.input.platformFacts[0].evidenceRef;
  expect(evidence.diagnostics.catalog).toContainEqual({ ref, id: real.id, kind: 'platform_fact' });
  expect(evidence.diagnostics.catalog.some((e) => e.id === uncited.id)).toBe(false);
  expect(evidence.diagnostics.omittedReplyRefs).toEqual(
    expect.arrayContaining([otherBuyer.id, future.id, unrelated.id]),
  );
  expect(evidence.input.replyEvidence[0]).toMatchObject({
    evidenceRefs: [ref],
    unavailableEvidenceCount: 3,
  });
});
