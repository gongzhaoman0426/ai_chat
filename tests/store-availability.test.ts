import { afterEach, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from '../packages/core/src/router';
import type { MastraAi } from '../packages/ai/src';
import type { Capabilities } from '../packages/contracts/src';
import { setup } from './helpers';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
const qa = {
  intent: '发货时间',
  answerKind: 'text' as const,
  answer: '通常两天内发货',
  scope: { productIds: [], conditions: '' },
};

it('删除最后一个账号后历史店铺不再可选，知识和会话保留；重新接入复用原店铺', async () => {
  f = await setup();
  const router = new Router(f.engine, {} as MastraAi);
  const saved = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  const message = await f.engine.ingest(f.inbound());
  await router.call('accounts.remove', { accountId: f.account.id });
  expect(await router.call('stores.list')).toEqual([]);
  expect(await f.db.store.findUnique({ where: { id: f.account.storeId } })).not.toBeNull();
  expect(await f.db.knowledgeRevision.findUnique({ where: { id: saved.id } })).not.toBeNull();
  expect(
    await f.db.conversation.findUnique({ where: { id: message.conversationId } }),
  ).not.toBeNull();
  expect(await router.call('knowledge.list', { storeId: f.account.storeId })).toHaveLength(1);
  const reconnected = await f.engine.registerAccount({
    platform: 'pinduoduo',
    mallId: 'mall-a',
    mallName: '测试店铺',
    externalId: 'cs-a',
    partition: 'persist:reconnected',
    name: '重新添加的客服',
    capabilities: f.account.capabilities as unknown as Capabilities,
  });
  expect(reconnected.storeId).toBe(f.account.storeId);
  expect(await router.call('stores.list')).toMatchObject([{ id: f.account.storeId }]);
  expect(await f.engine.knowledge.list(reconnected.storeId)).toMatchObject([
    { activeRevisionId: saved.id },
  ]);
});

it('断开连接不等于移除；还有其他账号时店铺仍可选且离线可维护知识', async () => {
  f = await setup();
  const router = new Router(f.engine, {} as MastraAi);
  const second = await f.engine.registerAccount({
    mallId: 'mall-a',
    mallName: '测试店铺',
    externalId: 'cs-b',
    partition: 'persist:second',
    name: '客服 B',
    capabilities: f.account.capabilities as unknown as Capabilities,
  });
  await router.call('accounts.remove', { accountId: f.account.id });
  await router.call('accounts.disconnect', { accountId: second.id });
  expect(await router.call('stores.list')).toMatchObject([
    { id: second.storeId, accounts: [{ id: second.id, status: 'offline' }] },
  ]);
  await expect(
    router.call('knowledge.save', { storeId: second.storeId, qa }),
  ).resolves.toMatchObject({ answer: qa.answer });
  await router.call('accounts.remove', { accountId: second.id });
  expect(await router.call('stores.list')).toEqual([]);
});

it('已打开的编辑/新建/导入在店铺移除后不能继续发布，原知识不受影响', async () => {
  f = await setup();
  const router = new Router(f.engine, {} as MastraAi);
  const saved = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  const path = join(f.dir, 'pending-import.json');
  await writeFile(path, JSON.stringify([{ ...qa, intent: '待导入问答' }]));
  const preview = await f.engine.knowledge.previewImport(f.account.storeId, path);
  await router.call('accounts.remove', { accountId: f.account.id });
  await expect(router.call('knowledge.save', { storeId: f.account.storeId, qa })).rejects.toThrow(
    '该店铺已移除',
  );
  await expect(
    router.call('knowledge.save', {
      storeId: f.account.storeId,
      entryId: saved.entryId,
      expectedRevisionId: saved.id,
      qa: { ...qa, answer: '不应写入的回答' },
    }),
  ).rejects.toThrow('该店铺已移除');
  expect(await f.engine.knowledge.applyImport(preview!.token, [0])).toEqual([
    { index: 0, error: '该店铺已移除，请重新添加账号后维护问答' },
  ]);
  expect(await f.db.knowledgeRevision.count()).toBe(1);
  expect(await f.engine.knowledge.list(f.account.storeId)).toMatchObject([
    { activeRevisionId: saved.id, revisions: [{ answer: qa.answer }] },
  ]);
});
