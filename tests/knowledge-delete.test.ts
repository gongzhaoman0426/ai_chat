import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup, flush } from './helpers';
import { Router } from '../packages/core/src/router';
import type { MastraAi } from '../packages/ai/src';
import { apiInputs, type QaInput } from '../packages/contracts/src';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
const qa: QaInput = {
  intent: '发货时间',
  answer: '48 小时内发出',
  answerKind: 'text',
  scope: { productIds: [], conditions: '' },
};
async function init() {
  fixture = await setup();
  return { ...fixture, router: new Router(fixture.engine, {} as MastraAi) };
}

it('删除复核修订，旧确认不能删除新内容，删除不可逆且幂等', async () => {
  const f = await init();
  const first = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  const remove = (revision = first.id) =>
    f.router.call('knowledge.delete', { id: first.entryId, expectedRevisionId: revision });
  const latest = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    entryId: first.entryId,
    expectedRevisionId: first.id,
    qa: { ...qa, answer: '24 小时内发出' },
  });
  await expect(remove()).rejects.toThrow('版本已变化');
  expect(await remove(latest.id)).toEqual({ ok: true });
  expect(await remove(latest.id)).toEqual({ ok: true });
  for (const status of ['enabled', 'disabled'] as const)
    await expect(
      f.router.call('knowledge.status', {
        id: first.entryId,
        expectedRevisionId: latest.id,
        status,
      }),
    ).rejects.toThrow('已删除');
  await expect(
    f.engine.knowledge.save({
      storeId: f.account.storeId,
      entryId: first.entryId,
      expectedRevisionId: latest.id,
      qa,
    }),
  ).rejects.toThrow('已删除');
  await expect(
    f.engine.knowledge.save({
      storeId: null,
      expectedStoreId: f.account.storeId,
      entryId: first.entryId,
      expectedRevisionId: latest.id,
      qa,
    }),
  ).rejects.toThrow('已删除');
  expect(await f.db.auditEvent.count({ where: { type: 'knowledge.delete' } })).toBe(1);
  expect(await f.router.call('knowledge.history', { id: first.entryId })).toEqual([latest, first]);
});

it('删除文字与图片问答后所有列表与导出排除，历史图片可用，重新导入不被已删除条目阻挡', async () => {
  const f = await init();
  const image = await f.engine.knowledge.attach(null, Buffer.from('test-image'), 'history.png');
  const text = await f.engine.knowledge.save({ storeId: null, qa });
  const picture = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    qa: { ...qa, intent: '发货说明图', answerKind: 'image', attachmentId: image.id },
  });
  const keep = await f.engine.knowledge.save({
    storeId: null,
    qa: { ...qa, intent: '保留图片', answerKind: 'image', attachmentId: image.id },
  });
  const question = await f.engine.ingest(f.inbound('请发说明图'));
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: '',
    attachmentId: image.id,
    requestId: 'old-image',
  });
  const messages = await f.db.message.findMany();
  for (const r of [text, picture]) {
    await f.router.call('knowledge.delete', { id: r.entryId, expectedRevisionId: r.id });
  }
  for (const scope of ['available', 'owned', 'all'] as const) {
    const rows = await f.engine.knowledge.list(f.account.storeId, '', scope);
    expect(rows.every((r) => r.id !== text.entryId && r.id !== picture.entryId)).toBe(true);
    const file = join(f.dir, scope + '.zip');
    f.host.saveFile = async () => file;
    await f.router.call('knowledge.export', { storeId: f.account.storeId, scope });
    const manifest = JSON.parse(
      new AdmZip(await readFile(file)).getEntry('manifest.json')!.getData().toString(),
    );
    expect(manifest.every((r: any) => r.intent === '保留图片')).toBe(true);
  }
  expect(await f.db.message.findMany()).toEqual(messages);
  expect(await readFile(join(f.dir, image.relativePath), 'utf8')).toBe('test-image');
  expect(await f.db.knowledgeRevision.findUnique({ where: { id: keep.id } })).toMatchObject({
    attachmentId: image.id,
  });
  await expect(
    f.engine.knowledge.save({
      storeId: f.account.storeId,
      qa: { ...qa, scope: { ...qa.scope, overridesEntryId: text.entryId } },
    }),
  ).rejects.toThrow('未删除的通用问答');
  const imported = join(f.dir, 'reimport.json');
  await writeFile(imported, JSON.stringify([qa]));
  f.host.pickFile = async () => imported;
  const preview = await f.engine.knowledge.previewImport(null);
  expect(preview?.rows[0]).toMatchObject({ qa });
  expect(preview?.rows[0].conflict).toBeUndefined();
  expect(await f.engine.knowledge.applyImport(preview!.token, [0])).toEqual([
    { index: 0, ok: true },
  ]);
  expect(await f.db.knowledgeEntry.findUnique({ where: { id: text.entryId } })).toMatchObject({
    status: 'deleted',
  });
});

it.each([false, true])('删除使目标学习建议失效，已批准=%s 时也不能重新发布', async (approved) => {
  const f = await init();
  const revision = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  f.ai.result.suggestions = [
    {
      action: 'revise_qa',
      targetEntryId: revision.entryId,
      reason: '更新规则',
      qa: { ...qa, answer: '24 小时内发出' },
    },
  ];
  const question = await f.engine.ingest(f.inbound('发货多久'));
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: '24 小时内',
    requestId: 'learn-delete',
  });
  await flush(f.engine, f.db);
  const candidate = await f.db.knowledgeCandidate.findFirstOrThrow();
  const reviewInput = {
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    contentHash: candidate.contentHash,
    decision: 'approved' as const,
    requestId: 'approve-delete',
  };
  if (approved) await f.engine.knowledge.review(reviewInput);
  await f.router.call('knowledge.delete', {
    id: revision.entryId,
    expectedRevisionId: revision.id,
  });
  expect(await f.db.knowledgeCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject({
    status: 'stale',
  });
  if (approved) {
    const change = await f.db.knowledgeChange.findFirstOrThrow();
    expect(change.status).toBe('conflicted');
    await f.engine.knowledge.apply(change.id);
    expect(await f.db.job.findFirst({ where: { kind: 'publish' } })).toMatchObject({
      status: 'cancelled',
    });
    expect(await f.db.knowledgeReview.count()).toBe(1);
  } else await expect(f.engine.knowledge.review(reviewInput)).rejects.toThrow('候选已变化');
  expect(await f.db.knowledgeEntry.findUnique({ where: { id: revision.entryId } })).toMatchObject({
    status: 'deleted',
  });
  expect(await f.db.knowledgeRevision.count({ where: { entryId: revision.entryId } })).toBe(1);
});

it('停用问答可直接删除，不改变有效接待配置；旧归档接口不再接受', async () => {
  const f = await init();
  const revision = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  await f.engine.knowledge.setStatus(revision.entryId, 'disabled', revision.id);
  const before = await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } });
  await f.router.call('knowledge.delete', {
    id: revision.entryId,
    expectedRevisionId: revision.id,
  });
  expect(await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } })).toEqual(before);
  expect(await f.engine.knowledge.list(f.account.storeId)).toEqual([]);
  expect(
    apiInputs['knowledge.status'].safeParse({
      id: revision.entryId,
      expectedRevisionId: revision.id,
      status: 'archived',
    }).success,
  ).toBe(false);
  for (const method of ['knowledge.list', 'knowledge.export'] as const)
    expect(apiInputs[method].safeParse({ scope: 'archived' }).success).toBe(false);
});

it.each(['global', 'store'])('生成途中删除 %s 问答使旧回答失效，只更新相关店铺', async (scope) => {
  const f = await init();
  const other = await f.db.store.create({
    data: { platform: 'pinduoduo', externalId: 'other', name: '另一店' },
  });
  const storeId = scope === 'global' ? null : f.account.storeId;
  const revision = await f.engine.knowledge.save({ storeId, qa });
  const before = await f.db.store.findUniqueOrThrow({ where: { id: other.id } });
  f.ai.matches = [
    {
      storeId,
      entryId: revision.entryId,
      revisionId: revision.id,
      intent: qa.intent,
      qa,
      score: 0.8,
    },
  ];
  await f.engine.setPolicy({
    storeId: f.account.storeId,
    autoReplyEnabled: true,
    directMatchThreshold: 0.9,
  });
  f.ai.beforeReply = async () => {
    await f.router.call('knowledge.delete', {
      id: revision.entryId,
      expectedRevisionId: revision.id,
    });
  };
  await f.engine.ingest(f.inbound());
  await flush(f.engine, f.db);
  expect(f.ai.replyCalls).toBe(1);
  expect(f.sends).toHaveLength(0);
  expect(await f.db.job.findFirst({ where: { kind: 'reply' } })).toMatchObject({
    status: 'cancelled',
  });
  expect((await f.db.store.findUniqueOrThrow({ where: { id: other.id } })).replyConfigEpoch).toBe(
    before.replyConfigEpoch + (scope === 'global' ? 1 : 0),
  );
});

it('学习结果返回前删除目标，不产生可恢复它的新建议', async () => {
  const f = await init();
  const revision = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  f.ai.result.suggestions = [
    { action: 'revise_qa', targetEntryId: revision.entryId, reason: '更新时效', qa },
  ];
  f.ai.beforeLearn = async () => {
    await f.router.call('knowledge.delete', {
      id: revision.entryId,
      expectedRevisionId: revision.id,
    });
  };
  const question = await f.engine.ingest(f.inbound());
  await f.engine.sendManual({
    conversationId: question.conversationId,
    text: '48 小时内发出',
    requestId: 'in-flight-delete',
  });
  await flush(f.engine, f.db);
  expect(await f.db.knowledgeCandidate.count()).toBe(0);
  expect(await f.db.aiRun.findFirst({ where: { role: 'learning' } })).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('已删除'),
  });
});

it('旧资料库归档条目升级后保持停用和可见，可直接删除；有效条目与历史不受影响', async () => {
  const f = await init();
  const old = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  const keep = await f.engine.knowledge.save({ storeId: null, qa: { ...qa, intent: '通用时效' } });
  await f.db.knowledgeEntry.update({ where: { id: old.entryId }, data: { status: 'archived' } });
  const revisions = await f.db.knowledgeRevision.findMany({ orderBy: { id: 'asc' } });
  await f.db.$executeRawUnsafe(
    await readFile(
      'packages/database/prisma/migrations/202609100004_retire_knowledge_archive/migration.sql',
      'utf8',
    ),
  );
  expect(await f.engine.knowledge.list(f.account.storeId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: old.entryId, status: 'disabled' }),
      expect.objectContaining({ id: keep.entryId, status: 'enabled' }),
    ]),
  );
  expect(await f.db.knowledgeRevision.findMany({ orderBy: { id: 'asc' } })).toEqual(revisions);
  await f.router.call('knowledge.delete', { id: old.entryId, expectedRevisionId: old.id });
  expect((await f.engine.knowledge.list(f.account.storeId)).map((r) => r.id)).toEqual([
    keep.entryId,
  ]);
});
