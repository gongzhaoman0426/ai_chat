import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup, flush, waitFor } from './helpers';
import { Router } from '../packages/core/src/router';
import { MastraAi } from '../packages/ai/src';
import { buildLearningEvidence } from '../packages/core/src/learning-evidence';
import { uid } from '../packages/core/src/util';
import type { QaInput } from '../packages/contracts/src';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
afterEach(async () => {
  await ai?.close();
  await f?.cleanup();
  f = undefined;
  ai = undefined;
});
const qa = (answer: string): QaInput => ({
  intent: `问题_${answer}`,
  answer,
  answerKind: 'text',
  scope: { productIds: [], conditions: '' },
});
async function fixture() {
  f = await setup();
  const other = await f.engine.registerAccount({
    platform: 'douyin',
    mallId: 'mall-a',
    mallName: '另一店',
    externalId: 'other',
    name: '客服',
    partition: 'persist:shared-other',
    capabilities: f.account.capabilities as any,
  });
  await f.db.account.update({ where: { id: other.id }, data: { verifiedAt: new Date() } });
  const router = new Router(f.engine, {} as MastraAi);
  return { ...f, other, router };
}
it('不绑定店铺保存通用问答；两个平台只返回通用+本店，编辑不能隐式改变归属', async () => {
  const t = await fixture();
  const common = (await t.router.call('knowledge.save', { qa: qa('SHARED') })) as any;
  await t.router.call('knowledge.save', { storeId: t.account.storeId, qa: qa('PDD_ONLY') });
  await t.router.call('knowledge.save', { storeId: t.other.storeId, qa: qa('DY_ONLY') });
  const answers = async (storeId: string | null, scope?: string) =>
    ((await t.router.call('knowledge.list', { storeId, ...(scope ? { scope } : {}) })) as any[])
      .map((e) => e.revisions[0].answer)
      .sort();
  expect(await answers(t.account.storeId)).toEqual(['PDD_ONLY', 'SHARED']);
  expect(await answers(t.other.storeId)).toEqual(['DY_ONLY', 'SHARED']);
  expect(await answers(null)).toEqual(['SHARED']);
  expect(await answers(t.account.storeId, 'owned')).toEqual(['PDD_ONLY']);
  expect(await answers(null, 'all')).toEqual(['DY_ONLY', 'PDD_ONLY', 'SHARED']);
  expect(await t.db.knowledgeEntry.findUnique({ where: { id: common.entryId } })).toMatchObject({
    storeId: null,
  });
  await expect(
    t.router.call('knowledge.save', {
      storeId: t.other.storeId,
      entryId: common.entryId,
      expectedRevisionId: common.id,
      qa: qa('REASSIGNED'),
    }),
  ).rejects.toThrow('不属于');
  await expect(
    t.router.call('knowledge.save', {
      qa: { ...qa('GLOBAL_PRODUCT'), scope: { productIds: ['same-platform-id'], conditions: '' } },
    }),
  ).rejects.toThrow('通用问答不能绑定');
});
it('通用图片可保存并发给不同店铺买家，专属图片不能转成通用或发送到其他店', async () => {
  const t = await fixture();
  const image = await t.engine.knowledge.attach(null, Buffer.from('shared-image'), 'shared.png');
  const own = await t.engine.knowledge.attach(
    t.account.storeId,
    Buffer.from('private-image'),
    'private.png',
  );
  await t.router.call('knowledge.save', {
    qa: { ...qa('SHARED_IMAGE'), answerKind: 'image', attachmentId: image.id },
  });
  await expect(
    t.router.call('knowledge.save', {
      qa: { ...qa('PRIVATE_AS_GLOBAL'), answerKind: 'image', attachmentId: own.id },
    }),
  ).rejects.toThrow('图片不属于');
  for (const account of [t.account, t.other]) {
    const msg = await t.engine.ingest(
      t.inbound('要图片', {
        accountId: account.id,
        conversationKey: `conv-${account.id}`,
        platformContext: account.id === t.other.id ? { userId: 'buyer-a' } : undefined,
      }),
    );
    const outbound = (await t.router.call('messages.send', {
      conversationId: msg.conversationId,
      text: '',
      attachmentId: image.id,
      requestId: uid(),
    })) as any;
    await waitFor(
      async () =>
        (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } })).status ===
        'confirmed',
    );
    if (account.id === t.other.id)
      await expect(
        t.router.call('messages.send', {
          conversationId: msg.conversationId,
          text: '',
          attachmentId: own.id,
          requestId: uid(),
        }),
      ).rejects.toThrow('图片范围');
  }
  expect(t.sends).toHaveLength(2);
  expect(t.sends.every((s) => s.imageData === Buffer.from('shared-image').toString('base64'))).toBe(
    true,
  );
  expect(t.sends.map((s) => s.accountId).sort()).toEqual([t.account.id, t.other.id].sort());
});
it('真实本地向量索引能检索通用与本店，启用/过期/所属店铺仍在数据库再次校验', async () => {
  const t = await fixture();
  const records = [];
  for (const [storeId, answer] of [
    [null, 'SHARED'],
    [t.account.storeId, 'PDD_ONLY'],
    [t.other.storeId, 'DY_ONLY'],
  ] as const)
    records.push(await t.engine.knowledge.save({ storeId, qa: qa(answer) }));
  ai = new MastraAi(t.db, t.dir, t.host);
  await ai.initialize();
  const embed = vi.spyOn(ai as any, 'embed').mockResolvedValue([1, 0]);
  vi.spyOn(ai as any, 'embeddingProfile').mockResolvedValue({
    profile: { dimensions: 2 },
    profileHash: 'shared-fixture',
    indexName: 'shared_fixture',
  });
  for (const r of records) await ai.index(r.id);
  expect((await ai.search(t.account.storeId, '问题')).map((m) => m.qa.answer)).toEqual([
    'PDD_ONLY',
    'SHARED',
  ]);
  expect((await ai.search(t.other.storeId, '问题')).map((m) => m.qa.answer)).toEqual([
    'DY_ONLY',
    'SHARED',
  ]);
  expect(embed).toHaveBeenCalledTimes(5);
  await t.engine.knowledge.setStatus(records[0].entryId, 'disabled', records[0].id);
  expect((await ai.search(t.other.storeId, '问题')).map((m) => m.qa.answer)).toEqual(['DY_ONLY']);
  await t.router.call('knowledge.delete', {
    id: records[0].entryId,
    expectedRevisionId: records[0].id,
  });
  const callsBefore = embed.mock.calls.length;
  await ai.index(records[0].id);
  expect(embed).toHaveBeenCalledTimes(callsBefore);
  expect((await ai.search(t.account.storeId, '问题')).map((m) => m.qa.answer)).toEqual([
    'PDD_ONLY',
  ]);
  expect((await ai.search(t.other.storeId, '问题')).map((m) => m.qa.answer)).toEqual(['DY_ONLY']);
  await t.db.knowledgeRevision.update({
    where: { id: records[2].id },
    data: { validUntil: new Date(0) },
  });
  expect(await ai.search(t.other.storeId, '问题')).toEqual([]);
});
it('自动学习只产生来源店铺候选，审批后只入本店库，通用问答保持原状', async () => {
  const t = await fixture();
  const common = await t.engine.knowledge.save({ storeId: null, qa: qa('SHARED') });
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  t.ai.beforeLearn = async () => {
    const input = t.ai.learnInputs.at(-1);
    t.ai.result = {
      ...t.ai.result,
      reuseVerdict: 'reusable',
      evidenceIds: [input.evidenceCatalog[0].ref],
      suggestions: [{ action: 'create_qa', reason: '本店人工回复', qa: qa('NEW_LOCAL') }],
    };
  };
  const question = await t.engine.ingest(t.inbound('本店问题'));
  await t.engine.sendManual({
    conversationId: question.conversationId,
    text: 'NEW_LOCAL',
    requestId: uid(),
  });
  await flush(t.engine, t.db);
  const candidate = await t.db.knowledgeCandidate.findFirstOrThrow({
    where: { storeId: t.account.storeId },
  });
  expect(
    (await t.engine.knowledge.list(t.account.storeId)).map((e) => e.revisions[0].answer),
  ).not.toContain('NEW_LOCAL');
  await t.engine.knowledge.review({
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    contentHash: candidate.contentHash,
    requestId: uid(),
    decision: 'approved',
  });
  await flush(t.engine, t.db);
  expect(
    (await t.engine.knowledge.list(t.account.storeId)).map((e) => e.revisions[0].answer),
  ).toContain('NEW_LOCAL');
  expect(
    (await t.engine.knowledge.list(t.other.storeId)).map((e) => e.revisions[0].answer),
  ).toEqual(['SHARED']);
  expect(await t.db.knowledgeEntry.findUnique({ where: { id: common.entryId } })).toMatchObject({
    storeId: null,
    activeRevisionId: common.id,
  });
  expect(t.ai.learnCalls).toBe(1);
});
it('学习可以核验被引用的通用问答，但将其标记为只读且不混入其他店铺知识', async () => {
  const t = await fixture();
  const common = await t.engine.knowledge.save({ storeId: null, qa: qa('SHARED') });
  const privateQa = await t.engine.knowledge.save({ storeId: t.other.storeId, qa: qa('DY_ONLY') });
  const message = await t.engine.ingest(t.inbound());
  const question = await t.db.message.findUniqueOrThrow({ where: { id: message.id } });
  const sources = await buildLearningEvidence(t.db, {
    storeId: t.account.storeId,
    conversationId: question.conversationId,
    questions: [question],
    context: [],
    answers: [{ ...question, timestamp: new Date() }],
    knowledge: [],
    runs: [
      {
        id: 'run',
        path: 'agent',
        evidence: [],
        output: { evidenceIds: [common.id, privateQa.id] },
      },
    ],
  });
  expect(JSON.stringify(sources.input)).toContain('shared_readonly');
  expect(JSON.stringify(sources.input)).not.toContain('DY_ONLY');
});
it('升级数据库保留旧问答、图片与修订引用，不把旧条目改成通用', async () => {
  const t = await fixture();
  const { createClient } = await import('@libsql/client');
  const { readFile, readdir } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const migration = '202609090002_resource_store_scope';
  const dir = resolve('packages/database/prisma/migrations');
  const db = createClient({ url: pathToFileURL(join(t.dir, 'legacy-scope.db')).href });
  try {
    for (const name of (await readdir(dir))
      .filter((s) => s.startsWith('20') && s < migration)
      .sort())
      await db.executeMultiple(await readFile(join(dir, name, 'migration.sql'), 'utf8'));
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
      INSERT INTO KnowledgeEntry (id,storeId,activeRevisionId,updatedAt) VALUES ('old-entry','old-store','old-revision',CURRENT_TIMESTAMP);
      INSERT INTO Attachment (id,storeId,relativePath,mimeType,size,hash,name) VALUES ('old-image','old-store','attachments/a.png','image/png',1,'hash','a.png');
      INSERT INTO KnowledgeRevision (id,entryId,version,intent,answerKind,answer,attachmentId,scope,sourceKind) VALUES ('old-revision','old-entry',1,'历史图片','image','','old-image','{}','manual');
    `);
    await db.executeMultiple(await readFile(join(dir, migration, 'migration.sql'), 'utf8'));
    expect(
      (await db.execute('SELECT storeId,activeRevisionId FROM KnowledgeEntry')).rows[0],
    ).toMatchObject({ storeId: 'old-store', activeRevisionId: 'old-revision' });
    expect((await db.execute('SELECT storeId FROM Attachment')).rows[0]).toMatchObject({
      storeId: 'old-store',
    });
    expect(
      (await db.execute('SELECT entryId,attachmentId FROM KnowledgeRevision')).rows[0],
    ).toMatchObject({ entryId: 'old-entry', attachmentId: 'old-image' });
    expect((await db.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    await db.execute(
      "INSERT INTO KnowledgeEntry (id,storeId,updatedAt) VALUES ('common',NULL,CURRENT_TIMESTAMP)",
    );
    expect(
      (await db.execute("SELECT storeId FROM KnowledgeEntry WHERE id='common'")).rows[0].storeId,
    ).toBeNull();
  } finally {
    db.close();
  }
});
it('人工可明确绑定/解绑已有问答，校验旧归属和版本，跨店在途配置失效且保留修订', async () => {
  const t = await fixture();
  const first = await t.engine.knowledge.save({ storeId: null, qa: qa('SHARED') });
  const before = await t.db.store.findUniqueOrThrow({ where: { id: t.other.storeId } });
  const moved = (await t.router.call('knowledge.save', {
    entryId: first.entryId,
    expectedRevisionId: first.id,
    expectedStoreId: null,
    storeId: t.account.storeId,
    qa: qa('ONLY_LOCAL_NOW'),
  })) as any;
  expect(await t.engine.knowledge.list(t.other.storeId)).toEqual([]);
  expect(
    (await t.db.store.findUniqueOrThrow({ where: { id: t.other.storeId } })).replyConfigEpoch,
  ).toBeGreaterThan(before.replyConfigEpoch);
  await expect(
    t.router.call('knowledge.save', {
      entryId: first.entryId,
      expectedRevisionId: first.id,
      expectedStoreId: null,
      storeId: t.other.storeId,
      qa: qa('STALE'),
    }),
  ).rejects.toThrow('明确原所属店铺');
  const shared = (await t.router.call('knowledge.save', {
    entryId: first.entryId,
    expectedRevisionId: moved.id,
    expectedStoreId: t.account.storeId,
    storeId: null,
    qa: qa('SHARED_AGAIN'),
  })) as any;
  expect((await t.engine.knowledge.list(t.other.storeId))[0].revisions[0].answer).toBe(
    'SHARED_AGAIN',
  );
  expect(await t.db.knowledgeRevision.count({ where: { entryId: first.entryId } })).toBe(3);
  expect(await t.db.knowledgeEntry.findUnique({ where: { id: first.entryId } })).toMatchObject({
    storeId: null,
    activeRevisionId: shared.id,
  });
});
it('删除的问答不出现在接待列表和全量导出', async () => {
  const t = await fixture();
  await t.router.call('knowledge.save', { storeId: t.account.storeId, qa: qa('KEEP') });
  const gone = (await t.router.call('knowledge.save', {
    storeId: t.other.storeId,
    qa: qa('GONE'),
  })) as any;
  await t.router.call('knowledge.delete', {
    id: gone.entryId,
    expectedRevisionId: gone.id,
  });
  const answers = async (scope: string) =>
    ((await t.router.call('knowledge.list', { storeId: null, scope })) as any[])
      .map((e) => e.revisions[0].answer)
      .sort();
  expect(await answers('all')).toEqual(['KEEP']);
  const out = join(t.dir, 'knowledge.zip');
  t.engine.host.saveFile = async () => out;
  expect(await t.router.call('knowledge.export', { scope: 'all' })).toEqual({ count: 1 });
  const zip = new AdmZip(await readFile(out));
  expect(JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))).toEqual([
    expect.objectContaining({ intent: '问题_KEEP', answer: 'KEEP' }),
  ]);
});
