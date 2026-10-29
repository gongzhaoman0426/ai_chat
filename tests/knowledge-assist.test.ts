import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setup } from './helpers';
import { apiInputs } from '../packages/contracts/src/index';
import {
  catalogEntries,
  loadAssistAttachments,
  loadAssistEntries,
  loadKnowledgeAssistContext,
  resolveAssistModel,
  resolveAssistTargetStore,
  resolveKnowledgeAssist,
} from '../packages/core/src/knowledge-assist';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});

const qa = (intent: string, answer: string) => ({
  intent,
  answerKind: 'text' as const,
  answer,
  scope: { productIds: [], conditions: '' },
});

it('自然语言提案会绑定已有问答版本，并丢掉不存在的条目', async () => {
  f = await setup();
  const saved = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    qa: qa('多久发货', '现货 24 小时内发出'),
  });
  const catalog = catalogEntries(await f.engine.knowledge.list(f.account.storeId, '', 'owned'));
  const out = resolveKnowledgeAssist(
    {
      reply: '把发货时效改成 48 小时。',
      proposals: [
        {
          action: 'update',
          entryId: saved.entryId,
          qa: qa('多久发货', '现货 48 小时内发出'),
        },
        { action: 'delete', entryId: '00000000-0000-4000-8000-000000000099' },
      ],
    },
    catalog,
    f.account.storeId,
    new Set(),
  );
  expect(out.reply).toContain('48');
  expect(out.proposals).toHaveLength(1);
  expect(out.proposals[0]).toMatchObject({
    action: 'update',
    entryId: saved.entryId,
    expectedRevisionId: saved.id,
    storeId: f.account.storeId,
  });
  expect(out.proposals[0].qa?.answer).toBe('现货 48 小时内发出');
});

it('本店问答可以改成通用，并清掉商品限定', async () => {
  f = await setup();
  const saved = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    qa: {
      ...qa('你好/在吗/哈喽', '亲，您好'),
      scope: { productIds: ['1001'], conditions: '' },
    },
  });
  const catalog = catalogEntries(await f.engine.knowledge.list(f.account.storeId, '', 'owned'));
  const out = resolveKnowledgeAssist(
    {
      reply: '把问候改成通用。',
      proposals: [
        {
          action: 'update',
          entryId: saved.entryId,
          storeId: null,
          qa: {
            ...qa('你好/在吗/哈喽', '亲，您好，请问有什么可以帮您'),
            scope: { productIds: ['1001'], conditions: '' },
          },
        },
      ],
    },
    catalog,
    null,
    new Set(['1001']),
  );
  expect(out.proposals[0]).toMatchObject({
    action: 'update',
    entryId: saved.entryId,
    expectedRevisionId: saved.id,
    expectedStoreId: f.account.storeId,
    storeId: null,
  });
  expect(out.proposals[0].qa?.scope.productIds).toEqual([]);
  expect(out.proposals[0].detail).toContain('本店 → 通用');
});

it('不能把问答改到当前范围以外的店铺', () => {
  expect(resolveAssistTargetStore('store-b', 'store-a', 'store-a')).toBe('store-a');
  expect(resolveAssistTargetStore(null, 'store-a', 'store-a')).toBeNull();
  expect(resolveAssistTargetStore('store-a', null, 'store-a')).toBe('store-a');
});

it('通用视图也能按 id 找到本店问答', async () => {
  f = await setup();
  const saved = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    qa: qa('你好/在吗/哈喽', '亲，您好'),
  });
  const extra = await loadAssistEntries(f.engine, null, [saved.entryId]);
  expect(extra[0]).toMatchObject({ id: saved.entryId, storeId: f.account.storeId });
});

it('新建提案只保留店铺商品列表里的商品，未上传的图片问答改成文字', () => {
  const out = resolveKnowledgeAssist(
    {
      reply: '新增一条粽子问答。',
      proposals: [
        {
          action: 'create',
          qa: {
            intent: '粽子多重',
            answerKind: 'image',
            answer: '净含量 1kg',
            attachmentId: '00000000-0000-4000-8000-000000000001',
            scope: { productIds: ['1001', '9999'], conditions: '' },
          },
        },
      ],
    },
    [],
    'store-1',
    new Set(['1001']),
  );
  expect(out.proposals[0].qa).toMatchObject({
    answerKind: 'text',
    answer: '净含量 1kg',
    scope: { productIds: ['1001'] },
  });
});

it('本轮上传的图片可以做成图片问答，编造的附件会丢掉', () => {
  const allowed = '00000000-0000-4000-8000-000000000001';
  const out = resolveKnowledgeAssist(
    {
      reply: '用上传的图做尺码问答。',
      proposals: [
        {
          action: 'create',
          qa: {
            intent: '尺码怎么选',
            answerKind: 'image',
            answer: '',
            attachmentId: allowed,
            scope: { productIds: [], conditions: '' },
          },
        },
        {
          action: 'create',
          qa: {
            intent: '假图',
            answerKind: 'image',
            answer: '',
            attachmentId: '00000000-0000-4000-8000-000000000099',
            scope: { productIds: [], conditions: '' },
          },
        },
      ],
    },
    [],
    'store-1',
    new Set(),
    new Set([allowed]),
  );
  expect(out.proposals).toHaveLength(1);
  expect(out.proposals[0].qa).toMatchObject({
    answerKind: 'image',
    attachmentId: allowed,
  });
});

it('修改已有图片问答时可以沿用原图', async () => {
  f = await setup();
  const image = await f.engine.knowledge.attach(
    f.account.storeId,
    Buffer.from('size-chart'),
    'size.png',
  );
  const saved = await f.engine.knowledge.save({
    storeId: f.account.storeId,
    qa: { ...qa('尺码表', ''), answerKind: 'image', attachmentId: image.id },
  });
  const catalog = catalogEntries(await f.engine.knowledge.list(f.account.storeId, '', 'owned'));
  const out = resolveKnowledgeAssist(
    {
      reply: '只改问法。',
      proposals: [
        {
          action: 'update',
          entryId: saved.entryId,
          qa: {
            intent: '怎么选尺码',
            answerKind: 'image',
            answer: '',
            attachmentId: image.id,
            scope: { productIds: [], conditions: '' },
          },
        },
      ],
    },
    catalog,
    f.account.storeId,
    new Set(),
  );
  expect(out.proposals[0].qa).toMatchObject({
    answerKind: 'image',
    attachmentId: image.id,
    intent: '怎么选尺码',
  });
});

it('助手只能使用当前范围可见的图片', async () => {
  f = await setup();
  const shop = await f.engine.knowledge.attach(
    f.account.storeId,
    Buffer.from('shop-image'),
    'shop.png',
  );
  const shared = await f.engine.knowledge.attach(null, Buffer.from('shared-image'), 'shared.png');
  await expect(
    loadAssistAttachments(f.engine, f.account.storeId, [shop.id, shared.id]),
  ).resolves.toEqual([
    { id: shop.id, name: 'shop.png' },
    { id: shared.id, name: 'shared.png' },
  ]);
  await expect(loadAssistAttachments(f.engine, null, [shop.id])).rejects.toThrow('通用');
});

it('可以一次选多张图片入库', async () => {
  f = await setup();
  const file = join(f.dir, 'batch.png');
  await writeFile(file, Buffer.from('batch-image'));
  f.host.pickFiles = async () => [file];
  const rows = await f.engine.knowledge.pickImages(f.account.storeId);
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe('batch.png');
  expect(rows[0].storeId).toBe(f.account.storeId);
});

it('助手请求必须有文字或图片', () => {
  expect(() => apiInputs['knowledge.assist'].parse({ text: '', attachmentIds: [] })).toThrow();
  expect(apiInputs['knowledge.assist'].parse({ attachmentIds: ['img-1'] }).attachmentIds).toEqual([
    'img-1',
  ]);
});

it('未配置对话模型时不能开问答助手', async () => {
  f = await setup();
  await f.db.appSetting.deleteMany({ where: { key: 'defaultModelId' } });
  await expect(resolveAssistModel(f.engine, null)).rejects.toThrow('对话模型');
});

it('助手上下文带上本店和通用问答', async () => {
  f = await setup();
  await f.engine.knowledge.save({ storeId: null, qa: qa('通用包装', '纸箱发货') });
  await f.engine.knowledge.save({ storeId: f.account.storeId, qa: qa('本店包装', '泡沫箱发货') });
  const ctx = await loadKnowledgeAssistContext(f.engine, f.account.storeId, 'available');
  expect(ctx.catalog.map((row) => row.intent).sort()).toEqual(['本店包装', '通用包装']);
  expect(ctx.model.kind).toBe('chat');
});
