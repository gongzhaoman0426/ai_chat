import { afterEach, expect, it } from 'vitest';
import { apiInputs, type LearningResult, type QaInput } from '../packages/contracts/src';
import { json } from '../packages/database/src';
import { hash, uid } from '../packages/core/src/util';
import { flush, setup } from './helpers';

type Fixture = Awaited<ReturnType<typeof setup>>;
type Suggestion = LearningResult['suggestions'][number];
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const qa: QaInput = {
  intent: '现货多久发货',
  answerKind: 'text',
  answer: '现货付款后 48 小时内发出。',
  scope: { productIds: [], conditions: '' },
};

async function init() {
  fixture = await setup();
  const f = fixture;
  const other = await f.db.store.create({
    data: {
      externalId: 'review-other-store',
      name: '发布目标店铺',
      accounts: {
        create: {
          externalId: 'review-other-staff',
          name: '目标店铺客服',
          sessionPartition: 'persist:review-other',
          capabilities: {},
        },
      },
    },
  });
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  return { ...f, other };
}

async function makeCandidate(f: Fixture, suggestion: Partial<Suggestion> = {}) {
  f.ai.result = {
    ...f.ai.result,
    reuseVerdict: 'reusable',
    suggestions: [{ action: 'create_qa', reason: '人工回复可复用', qa, ...suggestion }],
  };
  const question = await f.engine.ingest(f.inbound(qa.intent));
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: suggestion.qa?.answer || qa.answer,
    requestId: uid(),
  });
  await flush(f.engine, f.db);
  expect(f.ai.learnCalls).toBe(1);
  return f.db.knowledgeCandidate.findFirstOrThrow();
}

function approval(candidate: { id: string; candidateVersion: number; contentHash: string }) {
  return {
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    contentHash: candidate.contentHash,
    requestId: uid(),
    decision: 'approved' as const,
  };
}

async function changeFor(f: Fixture, candidateId: string) {
  return f.db.knowledgeChange.findFirstOrThrow({ where: { candidateId } });
}

it('审批接口保留省略范围与显式 null 的区别，并拒绝空或非法目标', () => {
  const input = approval({ id: 'candidate', candidateVersion: 1, contentHash: 'hash' });
  const schema = apiInputs['learning.review'];
  expect(schema.parse(input)).not.toHaveProperty('targetStoreId');
  expect(schema.parse({ ...input, targetStoreId: undefined }).targetStoreId).toBeUndefined();
  expect(schema.parse({ ...input, targetStoreId: null }).targetStoreId).toBeNull();
  expect(schema.parse({ ...input, targetStoreId: 'store-b' }).targetStoreId).toBe('store-b');
  for (const targetStoreId of ['', 123, {}])
    expect(schema.safeParse({ ...input, targetStoreId }).success).toBe(false);
});

it.each(['omitted', 'source', 'other', 'general'] as const)(
  '创建建议审批范围为 %s 时只发布到批准范围，来源不变且重复审批和发布幂等',
  async (scope) => {
    const f = await init();
    const candidate = await makeCandidate(f);
    const targetStoreId =
      scope === 'general' ? null : scope === 'other' ? f.other.id : f.account.storeId;
    const input = {
      ...approval(candidate),
      ...(scope === 'omitted' ? {} : { targetStoreId }),
    };
    await f.engine.knowledge.review(input);
    const review = await f.db.knowledgeReview.findUniqueOrThrow({
      where: { requestId: input.requestId },
    });
    expect(await f.engine.knowledge.review(input)).toEqual(review);
    expect(review.publicationScope).toEqual({ storeId: targetStoreId });
    expect(review.contentHash).not.toBe(candidate.contentHash);
    const version = candidate.candidateVersion + (targetStoreId === candidate.storeId ? 0 : 1);
    expect(review.candidateVersion).toBe(version);
    expect(await f.db.knowledgeCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject(
      {
        storeId: f.account.storeId,
        evaluationId: candidate.evaluationId,
        sourceRevision: candidate.sourceRevision,
        candidateVersion: version,
        contentHash: review.contentHash,
        status: 'approved',
      },
    );
    expect(await f.db.knowledgeEntry.count()).toBe(0);
    expect(await f.db.job.findFirst({ where: { kind: 'publish' } })).toMatchObject({
      storeId: targetStoreId,
    });

    const change = await changeFor(f, candidate.id);
    await f.engine.knowledge.apply(change.id);
    await f.engine.knowledge.apply(change.id);
    expect(await f.engine.knowledge.review(input)).toEqual(review);
    expect(await f.db.knowledgeReview.count()).toBe(1);
    expect(await f.db.knowledgeChange.count()).toBe(1);
    expect(await f.db.knowledgeEntry.count()).toBe(1);
    expect(await f.db.knowledgeRevision.count()).toBe(1);
    const revision = await f.db.knowledgeRevision.findFirstOrThrow({ include: { entry: true } });
    expect(revision).toMatchObject({
      answer: qa.answer,
      sourceKind: 'learning',
      approvalId: review.id,
      evaluationId: candidate.evaluationId,
      entry: { storeId: targetStoreId },
    });
    const evaluation = await f.db.learningEvaluation.findUniqueOrThrow({
      where: { id: candidate.evaluationId },
    });
    expect(evaluation.storeId).toBe(f.account.storeId);
    expect(
      await f.db.knowledgeSource.findFirst({ where: { revisionId: revision.id } }),
    ).toMatchObject({
      turnId: evaluation.turnId,
      sourceRevision: candidate.sourceRevision,
    });
    expect(await changeFor(f, candidate.id)).toMatchObject({
      status: 'applied',
      resultRevisionId: revision.id,
    });
    expect(f.sends).toHaveLength(1);
  },
);

it('同时编辑内容和范围只增加一个候选版本，并发布实际批准的内容', async () => {
  const f = await init();
  const candidate = await makeCandidate(f);
  const editedQa = { ...qa, answer: '人工确认后修改为 24 小时内发出。' };
  await f.engine.knowledge.review({
    ...approval(candidate),
    targetStoreId: null,
    editedQa,
  });
  const review = await f.db.knowledgeReview.findFirstOrThrow();
  expect(review.candidateVersion).toBe(candidate.candidateVersion + 1);
  expect(await f.db.knowledgeCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject({
    content: editedQa,
    contentHash: review.contentHash,
    candidateVersion: review.candidateVersion,
    storeId: candidate.storeId,
  });
  await f.engine.knowledge.apply((await changeFor(f, candidate.id)).id);
  expect(await f.db.knowledgeRevision.findFirst()).toMatchObject({ answer: editedQa.answer });
});

it.each(['omitted', 'other'] as const)(
  '重复请求不能把原 %s 范围审批改成通用范围',
  async (scope) => {
    const f = await init();
    const candidate = await makeCandidate(f);
    const input = {
      ...approval(candidate),
      ...(scope === 'other' ? { targetStoreId: f.other.id } : {}),
    };
    await f.engine.knowledge.review(input);
    await expect(
      f.engine.knowledge.review({ ...input, targetStoreId: null }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('发布范围') });
    expect(await f.db.knowledgeReview.count()).toBe(1);
    expect(await f.db.knowledgeChange.count()).toBe(1);
  },
);

it.each(['other', 'general'] as const)(
  '修订建议发布到 %s 时创建新条目，原店铺问答及来源保持不变',
  async (scope) => {
    const f = await init();
    const original = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
    const updatedQa = { ...qa, answer: '最新人工确认：24 小时内发出。' };
    const candidate = await makeCandidate(f, {
      action: 'revise_qa',
      targetEntryId: original.entryId,
      qa: updatedQa,
    });
    const targetStoreId = scope === 'general' ? null : f.other.id;
    await f.engine.knowledge.review({ ...approval(candidate), targetStoreId });
    const change = await changeFor(f, candidate.id);
    await f.engine.knowledge.apply(change.id);
    await f.engine.knowledge.apply(change.id);
    expect(await f.db.knowledgeEntry.findUnique({ where: { id: original.entryId } })).toMatchObject(
      {
        storeId: f.account.storeId,
        activeRevisionId: original.id,
        status: 'enabled',
      },
    );
    expect(await f.db.knowledgeRevision.findUnique({ where: { id: original.id } })).toEqual(
      original,
    );
    expect(await f.db.knowledgeRevision.count({ where: { entryId: original.entryId } })).toBe(1);
    const copy = await f.db.knowledgeRevision.findFirstOrThrow({
      where: { sourceKind: 'learning' },
      include: { entry: true },
    });
    expect(copy.entryId).not.toBe(original.entryId);
    expect(copy).toMatchObject({
      version: 1,
      answer: updatedQa.answer,
      entry: { storeId: targetStoreId },
    });
    expect(await f.db.knowledgeCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject(
      {
        storeId: f.account.storeId,
        targetEntryId: original.entryId,
        expectedActiveRevisionId: original.id,
      },
    );
    expect(await f.db.knowledgeEntry.count()).toBe(2);
  },
);

it.each(['other', 'general'] as const)('停用建议不能更改为 %s 范围', async (scope) => {
  const f = await init();
  const original = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  const candidate = await makeCandidate(f, {
    action: 'disable_qa',
    targetEntryId: original.entryId,
  });
  await expect(
    f.engine.knowledge.review({
      ...approval(candidate),
      targetStoreId: scope === 'general' ? null : f.other.id,
    }),
  ).rejects.toThrow('停用建议不能更改适用店铺');
  expect(await f.db.knowledgeReview.count()).toBe(0);
  expect(await f.db.knowledgeChange.count()).toBe(0);
  expect(await f.db.knowledgeEntry.findUnique({ where: { id: original.entryId } })).toMatchObject({
    status: 'enabled',
    activeRevisionId: original.id,
  });
});

it.each(['missing', 'removed'] as const)(
  '审批拒绝 %s 的目标店铺，事务不留下批准记录',
  async (kind) => {
    const f = await init();
    const candidate = await makeCandidate(f);
    if (kind === 'removed') await f.db.account.deleteMany({ where: { storeId: f.other.id } });
    await expect(
      f.engine.knowledge.review({
        ...approval(candidate),
        targetStoreId: kind === 'missing' ? 'nonexistent-store' : f.other.id,
      }),
    ).rejects.toThrow(kind === 'missing' ? '店铺不存在' : '店铺已移除');
    expect(await f.db.knowledgeReview.count()).toBe(0);
    expect(await f.db.knowledgeChange.count()).toBe(0);
    expect(await f.db.knowledgeCandidate.findUnique({ where: { id: candidate.id } })).toEqual(
      candidate,
    );
  },
);

it.each(['other', 'general'] as const)(
  '来源店铺专属图片不能随审批发布到 %s 范围',
  async (scope) => {
    const f = await init();
    const image = await f.engine.knowledge.attach(
      f.account.storeId,
      Buffer.from('private'),
      'private.png',
    );
    const candidate = await makeCandidate(f, {
      qa: { ...qa, answerKind: 'image', attachmentId: image.id },
    });
    await expect(
      f.engine.knowledge.review({
        ...approval(candidate),
        targetStoreId: scope === 'general' ? null : f.other.id,
      }),
    ).rejects.toThrow('图片不属于');
    expect(await f.db.knowledgeReview.count()).toBe(0);
    expect(await f.db.knowledgeEntry.count()).toBe(0);
  },
);

it('审批换用目标店铺图片时按发布范围校验', async () => {
  const f = await init();
  const candidate = await makeCandidate(f);
  const image = await f.engine.knowledge.attach(f.other.id, Buffer.from('target'), 'target.png');
  await f.engine.knowledge.review({
    ...approval(candidate),
    targetStoreId: f.other.id,
    editedQa: { ...qa, answerKind: 'image', attachmentId: image.id },
  });
  await f.engine.knowledge.apply((await changeFor(f, candidate.id)).id);
  expect(await f.db.knowledgeRevision.findFirst({ include: { entry: true } })).toMatchObject({
    attachmentId: image.id,
    entry: { storeId: f.other.id },
  });
});

it.each(['products', 'override'] as const)('通用审批拒绝残留的店铺 %s 约束', async (kind) => {
  const f = await init();
  const global = await f.engine.knowledge.save({
    storeId: null,
    qa: { ...qa, intent: '通用规则' },
  });
  const candidate = await makeCandidate(f, {
    qa: {
      ...qa,
      scope:
        kind === 'products'
          ? { productIds: ['platform-product-id'], conditions: '' }
          : { productIds: [], conditions: '', overridesEntryId: global.entryId },
    },
  });
  await expect(
    f.engine.knowledge.review({ ...approval(candidate), targetStoreId: null }),
  ).rejects.toThrow(kind === 'products' ? '通用问答不能绑定店铺商品' : '只有店铺专属问答可以覆盖');
  expect(await f.db.knowledgeReview.count()).toBe(0);
  expect(await f.db.knowledgeChange.count()).toBe(0);
  // Removing the source shop constraint is an explicit edit approved by the user.
  await f.engine.knowledge.review({ ...approval(candidate), targetStoreId: null, editedQa: qa });
  await f.engine.knowledge.apply((await changeFor(f, candidate.id)).id);
  expect(
    await f.db.knowledgeRevision.findFirst({ where: { sourceKind: 'learning' } }),
  ).toMatchObject({
    scope: { productIds: [], conditions: '' },
  });
});

it.each(['account', 'image'] as const)(
  '批准后目标 %s 权限失效，实际发布时再次校验',
  async (kind) => {
    const f = await init();
    const sharedImage = await f.engine.knowledge.attach(null, Buffer.from('shared'), 'shared.png');
    const candidate = await makeCandidate(f, {
      qa: { ...qa, answerKind: 'image', attachmentId: sharedImage.id },
    });
    await f.engine.knowledge.review({ ...approval(candidate), targetStoreId: f.other.id });
    if (kind === 'account') await f.db.account.deleteMany({ where: { storeId: f.other.id } });
    else
      await f.db.attachment.update({
        where: { id: sharedImage.id },
        data: { storeId: f.account.storeId },
      });
    const change = await changeFor(f, candidate.id);
    await expect(f.engine.knowledge.apply(change.id)).rejects.toThrow(
      kind === 'account' ? '店铺已移除' : '图片不属于',
    );
    expect(await f.db.knowledgeEntry.count()).toBe(0);
    expect(await f.db.knowledgeRevision.count()).toBe(0);
    expect((await changeFor(f, candidate.id)).status).not.toBe('applied');
  },
);

it.each(['scope', 'content', 'action', 'target'] as const)(
  '批准后篡改 %s 会使审批冲突并使候选失效',
  async (kind) => {
    const f = await init();
    const original = await f.engine.knowledge.save({
      storeId: f.account.storeId,
      qa: { ...qa, intent: '原规则' },
    });
    const candidate = await makeCandidate(f, {
      action: 'revise_qa',
      targetEntryId: original.entryId,
    });
    await f.engine.knowledge.review({ ...approval(candidate), targetStoreId: f.other.id });
    const review = await f.db.knowledgeReview.findFirstOrThrow();
    if (kind === 'scope')
      await f.db.knowledgeReview.update({
        where: { id: review.id },
        data: { publicationScope: { storeId: null } },
      });
    else
      await f.db.knowledgeCandidate.update({
        where: { id: candidate.id },
        data:
          kind === 'content'
            ? { content: json({ ...qa, answer: '未经审批的新答案' }) }
            : kind === 'action'
              ? { action: 'create_qa' }
              : { targetEntryId: null },
      });
    const change = await changeFor(f, candidate.id);
    await f.engine.knowledge.apply(change.id);
    await f.engine.knowledge.apply(change.id);
    expect(await changeFor(f, candidate.id)).toMatchObject({
      status: 'conflicted',
      resultRevisionId: null,
    });
    expect(await f.db.knowledgeCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject(
      { status: 'stale' },
    );
    expect(await f.db.knowledgeRevision.count()).toBe(1);
    expect(await f.db.knowledgeEntry.findUnique({ where: { id: original.entryId } })).toMatchObject(
      { activeRevisionId: original.id },
    );
  },
);

it.each(['source', 'target'] as const)(
  '跨店复制修订仍检查原 %s 版本，变化后不发布',
  async (kind) => {
    const f = await init();
    const original = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
    const candidate = await makeCandidate(f, {
      action: 'revise_qa',
      targetEntryId: original.entryId,
      qa: { ...qa, answer: '建议更新后的回复' },
    });
    await f.engine.knowledge.review({ ...approval(candidate), targetStoreId: f.other.id });
    if (kind === 'source')
      await f.db.answeredTurn.updateMany({ data: { sourceRevision: { increment: 1 } } });
    else
      await f.engine.knowledge.save({
        storeId: f.account.storeId,
        entryId: original.entryId,
        expectedRevisionId: original.id,
        qa: { ...qa, answer: '审批后已被另一次人工编辑' },
      });
    await f.engine.knowledge.apply((await changeFor(f, candidate.id)).id);
    expect(await changeFor(f, candidate.id)).toMatchObject({
      status: 'conflicted',
      resultRevisionId: null,
    });
    expect(await f.db.knowledgeEntry.count({ where: { storeId: f.other.id } })).toBe(0);
  },
);

it('迁移前 publicationScope 为数据库 null 的审批仍按原内容 hash 发布到来源店铺', async () => {
  const f = await init();
  const candidate = await makeCandidate(f);
  expect(candidate.contentHash).toBe(hash(candidate.content));
  // A pre-migration approval omitted this column and used the plain QA hash.
  const review = await f.db.knowledgeReview.create({
    data: {
      ...approval(candidate),
      sourceRevision: candidate.sourceRevision,
      expectedActiveRevisionId: candidate.expectedActiveRevisionId,
    },
  });
  expect(review.publicationScope).toBeNull();
  await f.db.knowledgeCandidate.update({
    where: { id: candidate.id },
    data: { status: 'approved' },
  });
  const change = await f.db.knowledgeChange.create({
    data: {
      candidateId: candidate.id,
      approvalId: review.id,
      applyKey: hash([review.id, review.candidateVersion, review.contentHash]),
    },
  });
  await f.engine.knowledge.apply(change.id);
  await f.engine.knowledge.apply(change.id);
  expect(await f.db.knowledgeRevision.count()).toBe(1);
  expect(await f.db.knowledgeRevision.findFirst({ include: { entry: true } })).toMatchObject({
    answer: qa.answer,
    approvalId: review.id,
    entry: { storeId: f.account.storeId },
  });
  expect(await changeFor(f, candidate.id)).toMatchObject({ status: 'applied' });
});
