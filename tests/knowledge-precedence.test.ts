import { afterEach, expect, it } from 'vitest';
import { setup, flush } from './helpers';
import {
  resolveKnowledgeMatches,
  decideKnowledgeReply,
} from '../packages/core/src/knowledge-resolution';
import { qaSchema, type QaInput } from '../packages/contracts/src';
let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
const init = async () => (f = await setup());
const qa = (answer: string, intent = '多久发货'): QaInput => ({
  intent,
  answer,
  answerKind: 'text',
  scope: { productIds: [], conditions: '' },
});
async function save(storeId: string | null, input: QaInput) {
  const r = await f!.engine.knowledge.save({ storeId, qa: input });
  return {
    storeId,
    entryId: r.entryId,
    revisionId: r.id,
    intent: input.intent,
    qa: input,
    score: 0.99,
  };
}
it.each(['explicit', 'same_intent'])(
  '本店 %s 规则即使未进入向量候选也优先于通用问答，不额外调用模型',
  async (mode) => {
    const t = await init();
    const common = await save(null, qa('48 小时内发货'));
    const input = qa('72 小时内发货', mode === 'explicit' ? '本店发货时效' : '多久发货？');
    if (mode === 'explicit') input.scope.overridesEntryId = common.entryId;
    const local = await save(t.account.storeId, input);
    t.ai.matches = [common];
    await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
    await t.engine.ingest(t.inbound());
    await flush(t.engine, t.db);
    expect(t.sends.map((s) => s.text)).toEqual(['72 小时内发货']);
    expect(t.ai.replyCalls).toBe(0);
    const run = await t.db.aiRun.findFirstOrThrow();
    expect(run.output).toMatchObject({ evidenceIds: [local.revisionId] });
  },
);
it.each(['disabled', 'expired', 'other_shop'])(
  '%s 的专属规则不能覆盖当前店铺通用答案',
  async (state) => {
    const t = await init();
    const common = await save(null, qa('通用回答'));
    const other =
      state === 'other_shop'
        ? await t.engine.registerAccount({
            partition: 'persist:other',
            mallId: 'other',
            mallName: '另一店',
            externalId: 'other',
            name: '另一客服',
            capabilities: t.account.capabilities as any,
          })
        : t.account;
    const input = qa('不应采用');
    if (state === 'expired') input.validUntil = new Date(0).toISOString();
    const local = await save(other.storeId, input);
    if (state === 'disabled')
      await t.engine.knowledge.setStatus(local.entryId, 'disabled', local.revisionId);
    const matches = await resolveKnowledgeMatches(t.db, t.account.storeId, [common, local]);
    expect(matches.map((m) => m.entryId)).toEqual([common.entryId]);
    expect(decideKnowledgeReply(matches, 0.9).direct?.qa.answer).toBe('通用回答');
  },
);
it.each(['product', 'condition', 'duplicate'])(
  '有 %s 规则时不因相似度高而直接发通用答案，只交给现有 Agent',
  async (kind) => {
    const t = await init();
    const common = await save(null, qa('48 小时内发货'));
    const input = qa('72 小时内发货');
    if (kind === 'product') input.scope.productIds = ['p1'];
    if (kind === 'condition') input.scope.conditions = '仅限预售';
    await save(t.account.storeId, input);
    if (kind === 'duplicate') await save(t.account.storeId, qa('96 小时内发货'));
    t.ai.matches = [common];
    await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
    await t.engine.ingest(t.inbound());
    await flush(t.engine, t.db);
    expect(t.ai.replyCalls).toBe(1);
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0].text).toBe(t.ai.replyResult.text);
  },
);
it('学习未经审批、失效来源和过期旧修订不能作为覆盖规则', async () => {
  const t = await init();
  const common = await save(null, qa('通用答案'));
  const local = await save(t.account.storeId, qa('伪造学习答案'));
  await t.db.knowledgeRevision.update({
    where: { id: local.revisionId },
    data: { sourceKind: 'learning', approvalId: null },
  });
  expect(
    (await resolveKnowledgeMatches(t.db, t.account.storeId, [common, local])).map((m) => m.entryId),
  ).toEqual([common.entryId]);
});
it('覆盖目标只能是通用问答，关联保存在修订内；通用条目不能覆盖别的问答', async () => {
  const t = await init();
  const privateRule = await save(t.account.storeId, qa('店铺答案'));
  const bad = qa('非法覆盖');
  bad.scope.overridesEntryId = privateRule.entryId;
  await expect(save(t.account.storeId, bad)).rejects.toThrow('覆盖目标必须');
  const common = await save(null, qa('通用答案'));
  bad.scope.overridesEntryId = common.entryId;
  await expect(save(null, bad)).rejects.toThrow('只有店铺');
  const local = await save(t.account.storeId, bad);
  const revision = await t.db.knowledgeRevision.findUniqueOrThrow({
    where: { id: local.revisionId },
  });
  expect(revision.scope).toMatchObject({ overridesEntryId: common.entryId });
  expect(qaSchema.parse({ ...bad, scope: revision.scope }).scope.overridesEntryId).toBe(
    common.entryId,
  );
});
it('生成过程中新增本店覆盖使旧上下文失效，旧答案不能送出', async () => {
  const t = await init();
  const common = await save(null, qa('通用旧答案'));
  t.ai.matches = [{ ...common, score: 0.8 }];
  await t.engine.setPolicy({
    storeId: t.account.storeId,
    autoReplyEnabled: true,
    directMatchThreshold: 0.9,
  });
  t.ai.beforeReply = async () => {
    await save(t.account.storeId, qa('本店新答案'));
  };
  await t.engine.ingest(t.inbound());
  await flush(t.engine, t.db);
  expect(t.ai.replyCalls).toBe(1);
  expect(t.sends).toHaveLength(0);
});

it('向量只命中改写过的本店规则时，仍补齐同一通用目标下的商品覆盖', async () => {
  const t = await init();
  const common = await save(null, qa('48 小时发出'));
  const general = qa('72 小时发出', '本店一般时效');
  general.scope.overridesEntryId = common.entryId;
  const local = await save(t.account.storeId, general);
  const product = qa('7 天内发出', '预售商品安排');
  product.scope = { productIds: ['preorder'], conditions: '', overridesEntryId: common.entryId };
  const special = await save(t.account.storeId, product);
  const matches = await resolveKnowledgeMatches(t.db, t.account.storeId, [local]);
  expect(matches.map((m) => m.entryId).sort()).toEqual([local.entryId, special.entryId].sort());
  expect(decideKnowledgeReply(matches, 0.9).direct).toBeUndefined();
});

it('相同文字图片引用可直答，数学符号不同的意图不会被误当作同一规则', async () => {
  const t = await init();
  const image = await t.engine.knowledge.attach(null, Buffer.from('fixture'), 'fixture.png');
  const a = await save(null, { ...qa(''), answerKind: 'image', attachmentId: image.id });
  const b = await save(t.account.storeId, {
    ...qa(''),
    answerKind: 'image',
    attachmentId: image.id,
  });
  expect(
    decideKnowledgeReply(await resolveKnowledgeMatches(t.db, t.account.storeId, [a]), 0.9).direct
      ?.entryId,
  ).toBe(b.entryId);
  const plus = await save(null, qa('加法', 'A+B'));
  await save(t.account.storeId, qa('减法', 'A-B'));
  expect(
    (await resolveKnowledgeMatches(t.db, t.account.storeId, [plus])).map((m) => m.entryId),
  ).toEqual([plus.entryId]);
});

it('学习修订保留已有覆盖关系，审批前不生效，批准后只更新本店答案', async () => {
  const t = await init();
  const common = await save(null, qa('通用答案', '通用发货'));
  const localInput = qa('本店旧答案', '专属发货');
  localInput.scope.overridesEntryId = common.entryId;
  const local = await save(t.account.storeId, localInput);
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  t.ai.result = {
    matchVerdict: 'correct',
    replyVerdict: 'reasonable',
    reuseVerdict: 'reusable',
    reason: '人工更新了时效',
    evidenceIds: [],
    suggestions: [
      {
        action: 'revise_qa',
        targetEntryId: local.entryId,
        reason: '更新本店时效',
        qa: qa('本店新答案', '专属发货'),
      },
    ],
  };
  const msg = await t.engine.ingest(t.inbound());
  await t.engine.sendManual({
    conversationId: msg.conversationId,
    text: '本店新答案',
    requestId: 'learning-override',
  });
  await flush(t.engine, t.db);
  const candidate = await t.db.knowledgeCandidate.findFirstOrThrow();
  expect(candidate.content).toMatchObject({ scope: { overridesEntryId: common.entryId } });
  expect((await resolveKnowledgeMatches(t.db, t.account.storeId, [common]))[0].qa.answer).toBe(
    '本店旧答案',
  );
  await t.engine.knowledge.review({
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    contentHash: candidate.contentHash,
    requestId: 'approve-override',
    decision: 'approved',
  });
  await flush(t.engine, t.db);
  expect((await resolveKnowledgeMatches(t.db, t.account.storeId, [common]))[0].qa.answer).toBe(
    '本店新答案',
  );
  expect(
    (await t.db.knowledgeEntry.findUniqueOrThrow({ where: { id: common.entryId } }))
      .activeRevisionId,
  ).toBe(common.revisionId);
  expect(t.ai.learnCalls).toBe(1);
});
