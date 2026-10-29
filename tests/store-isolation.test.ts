import { afterEach, expect, it, vi } from 'vitest';
import { setup, flush } from './helpers';
import { MastraAi } from '../packages/ai/src';
import { Router } from '../packages/core/src/router';
import { uid } from '../packages/core/src/util';
let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
async function stores() {
  f = await setup();
  const dy = await f.engine.registerAccount({
    platform: 'douyin',
    mallId: 'mall-a',
    mallName: '同 ID 抖店',
    externalId: 'cs-a',
    name: '抖店客服',
    partition: 'persist:dy-isolation',
    capabilities: {
      receive: true,
      sendText: true,
      sendImage: true,
      history: true,
      goods: true,
      orders: true,
      verified: false,
    },
  });
  await f.db.account.update({ where: { id: dy.id }, data: { verifiedAt: new Date() } });
  return { f, pdd: f.account, dy };
}
it('平台店铺 ID、客服 ID、买家 ID、消息 ID 均相同仍隔离；同一店铺多客服共享该店知识', async () => {
  const { f, pdd, dy } = await stores();
  expect(dy.storeId).not.toBe(pdd.storeId);
  const anotherPdd = await f.engine.registerAccount({
    platform: 'pinduoduo',
    mallId: 'mall-a',
    mallName: '同一家拼多多',
    externalId: 'cs-b',
    name: '另一客服',
    partition: 'persist:pdd-b',
    capabilities: {
      receive: true,
      sendText: true,
      sendImage: false,
      history: true,
      goods: true,
      orders: false,
      verified: false,
    },
  });
  expect(anotherPdd.storeId).toBe(pdd.storeId);
  const common = f.inbound('相同问题', {
    externalId: 'same-message',
    conversationKey: 'same-conversation',
  });
  const a = await f.engine.ingest(common);
  const b = await f.engine.ingest({ ...common, accountId: dy.id });
  expect(a.id).not.toBe(b.id);
  expect(a.conversationId).not.toBe(b.conversationId);
  const qa = (answer: string) => ({
    intent: '发货时间',
    answerKind: 'text' as const,
    answer,
    scope: { productIds: [], conditions: '' },
  });
  await f.engine.knowledge.save({ storeId: pdd.storeId, qa: qa('拼多多店：24 小时') });
  await f.engine.knowledge.save({ storeId: dy.storeId, qa: qa('抖店：72 小时') });
  const libraryA = await f.engine.knowledge.list(pdd.storeId),
    libraryB = await f.engine.knowledge.list(dy.storeId);
  expect(libraryA.map((k) => k.revisions[0].answer)).toEqual(['拼多多店：24 小时']);
  expect(libraryB.map((k) => k.revisions[0].answer)).toEqual(['抖店：72 小时']);
  await expect(
    f.engine.knowledge.save({
      storeId: dy.storeId,
      entryId: libraryA[0].id,
      expectedRevisionId: libraryA[0].activeRevisionId!,
      qa: qa('企图改写其他店铺'),
    }),
  ).rejects.toThrow('不属于当前店铺');
  const attachment = await f.engine.knowledge.attach(pdd.storeId, Buffer.from('image'), '本店图片');
  await expect(
    f.engine.knowledge.save({
      storeId: dy.storeId,
      qa: { ...qa(''), answerKind: 'image', attachmentId: attachment.id },
    }),
  ).rejects.toThrow('图片不属于当前店铺');
});
it('工作台会话列表不传店铺则聚合已连接店铺，传 storeId 仍只看该店', async () => {
  const { f, pdd, dy } = await stores();
  const router = new Router(f.engine, {} as MastraAi);
  const common = f.inbound('相同问题', {
    externalId: 'same-message',
    conversationKey: 'same-conversation',
  });
  await f.engine.ingest(common);
  await f.engine.ingest({ ...common, accountId: dy.id });
  const all = (await router.call('conversations.list', {})) as any[];
  expect(new Set(all.map((c) => c.storeId))).toEqual(new Set([pdd.storeId, dy.storeId]));
  expect(all.every((c) => c.store?.name)).toBe(true);
  const onlyPdd = (await router.call('conversations.list', { storeId: pdd.storeId })) as any[];
  expect(onlyPdd).toHaveLength(1);
  expect(onlyPdd[0].storeId).toBe(pdd.storeId);
});
it('向量检索带 storeId 过滤，返回的命中还会再次核验店铺，防止相同问题串库', async () => {
  const { f, pdd, dy } = await stores();
  for (const [storeId, answer] of [
    [pdd.storeId, 'PDD_ONLY'],
    [dy.storeId, 'DOUYIN_ONLY'],
  ])
    await f.engine.knowledge.save({
      storeId,
      qa: {
        intent: '同样的买家问题',
        answerKind: 'text',
        answer,
        scope: { productIds: [], conditions: '' },
      },
    });
  const revisions = await f.db.knowledgeRevision.findMany();
  const query = vi.fn(async () => revisions.map((r) => ({ id: r.id, score: 0.99 })));
  // Exercise real search's filter + post-filter, with a deliberately over-broad vector result.
  const ai = Object.assign(Object.create(MastraAi.prototype), {
    db: f.db,
    embeddingProfile: async () => ({ profile: {}, indexName: 'test' }),
    embed: async () => [1, 0],
    vector: { listIndexes: async () => ['test'], query },
  }) as MastraAi;
  expect((await ai.search(pdd.storeId, '同样的买家问题')).map((m) => m.qa.answer)).toEqual([
    'PDD_ONLY',
  ]);
  expect((await ai.search(dy.storeId, '同样的买家问题')).map((m) => m.qa.answer)).toEqual([
    'DOUYIN_ONLY',
  ]);
  expect(query.mock.calls.map(([input]: any) => input.filter)).toEqual([
    { storeId: { $in: [pdd.storeId, '__shared_knowledge__'] } },
    { storeId: { $in: [dy.storeId, '__shared_knowledge__'] } },
  ]);
});
it('共用 Agent 仍按店铺独立学习、审批与发布；关闭另一店学习不生成其建议', async () => {
  const { f, pdd, dy } = await stores();
  expect((await f.engine.agents.resolve(pdd.storeId))!.revision.id).toBe(
    (await f.engine.agents.resolve(dy.storeId))!.revision.id,
  );
  await f.engine.setPolicy({ storeId: pdd.storeId, autoLearnEnabled: true });
  await f.engine.setPolicy({ storeId: dy.storeId, autoLearnEnabled: false });
  const questionA = await f.engine.ingest(f.inbound('拼多多问题_A'));
  const questionB = await f.engine.ingest(
    f.inbound('抖店问题_B', {
      accountId: dy.id,
      conversationKey: 'opaque-douyin',
      platformContext: { userId: 'buyer-a' },
    }),
  );
  f.ai.beforeLearn = async () => {
    const input = f.ai.learnInputs.at(-1);
    f.ai.result = {
      ...f.ai.result,
      reuseVerdict: 'reusable',
      suggestions: [
        {
          action: 'create_qa',
          reason: '本店实际人工回复',
          qa: {
            intent: input.questions.at(-1).text,
            answerKind: 'text',
            answer: input.answers.at(-1).message.text,
            scope: { productIds: [], conditions: '' },
          },
        },
      ],
    };
  };
  await f.engine.sendManual({
    conversationId: questionA.conversationId,
    text: '仅限拼多多店的答案_A',
    requestId: 'reply-a',
  });
  await f.engine.sendManual({
    conversationId: questionB.conversationId,
    text: '关闭学习期间的答案_B',
    requestId: 'reply-b-off',
  });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  expect(f.ai.learnInputs[0].storeId).toBe(pdd.storeId);
  expect(JSON.stringify(f.ai.learnInputs[0])).not.toContain('答案_B');
  expect(await f.db.knowledgeCandidate.count({ where: { storeId: dy.storeId } })).toBe(0);
  await f.engine.setPolicy({ storeId: dy.storeId, autoLearnEnabled: true });
  const next = await f.engine.ingest(
    f.inbound('抖店新问题_B', { accountId: dy.id, conversationKey: 'opaque-douyin' }),
  );
  await f.engine.sendManual({
    conversationId: next.conversationId,
    text: '仅限抖店的正式答案_B',
    requestId: 'reply-b-on',
  });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(2);
  expect(f.ai.learnInputs[1].storeId).toBe(dy.storeId);
  expect(JSON.stringify(f.ai.learnInputs[1])).not.toContain('答案_A');
  expect(await f.db.knowledgeEntry.count()).toBe(0); // neither suggestion is published without review
  const candidates = await f.db.knowledgeCandidate.findMany({ orderBy: { createdAt: 'asc' } });
  expect(candidates.map((c) => c.storeId)).toEqual([pdd.storeId, dy.storeId]);
  const router = new Router(f.engine, {} as MastraAi);
  expect(
    ((await router.call('learning.list', { storeId: pdd.storeId })) as any[]).map((c) => c.id),
  ).toEqual([candidates[0].id]);
  const c = candidates[0];
  await f.engine.knowledge.review({
    candidateId: c.id,
    candidateVersion: c.candidateVersion,
    contentHash: c.contentHash,
    requestId: uid(),
    decision: 'approved',
  });
  await flush(f.engine, f.db);
  expect((await f.engine.knowledge.list(pdd.storeId)).map((k) => k.revisions[0].answer)).toEqual([
    '仅限拼多多店的答案_A',
  ]);
  expect(await f.engine.knowledge.list(dy.storeId)).toEqual([]);
  expect(
    await f.db.knowledgeCandidate.findUnique({ where: { id: candidates[1].id } }),
  ).toMatchObject({ status: 'pending_review' });
});
it('抖店历史回放只入库，不创建回复任务和新学习回合', async () => {
  const { f, dy } = await stores();
  await f.engine.setPolicy({ storeId: dy.storeId, autoReplyEnabled: true, autoLearnEnabled: true });
  await f.engine.ingest(f.inbound('历史问题', { accountId: dy.id, historical: true }));
  await f.engine.ingest(
    f.inbound('历史人工回复', {
      accountId: dy.id,
      direction: 'out',
      origin: 'human',
      historical: true,
    }),
  );
  expect(await f.db.message.count({ where: { storeId: dy.storeId } })).toBe(2);
  expect(await f.db.messageGroup.count()).toBe(0);
  expect(await f.db.answeredTurn.count()).toBe(0);
  await flush(f.engine, f.db);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.ai.learnCalls).toBe(0);
});
