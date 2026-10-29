import { afterEach, expect, it } from 'vitest';
import { setup } from './helpers';
import { Router } from '../packages/core/src/router';

let f: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await f?.cleanup();
});

it('接待筛选区分待处理与已接管；查看未读后仍能独立读取当前会话且不接管', async () => {
  f = await setup();
  const router = new Router(f.engine, f.ai as any);
  const rows = [];
  for (const [buyer, awaitingHuman, openedByHuman] of [
    ['waiting', true, false],
    ['human', true, true],
    ['automatic', false, false],
  ] as const) {
    const row = await f.db.conversation.create({
      data: {
        storeId: f.account.storeId,
        accountId: f.account.id,
        externalKey: buyer,
        buyerId: buyer,
        buyerName: buyer,
        awaitingHuman,
        openedByHuman,
        unread: 1,
      },
    });
    rows.push(row);
  }
  const ids = async (filter: string) =>
    ((await router.call('conversations.list', { filter })) as any[]).map((c) => c.id);
  expect(await ids('waiting')).toEqual([rows[0].id]);
  expect(await ids('human')).toEqual([rows[1].id]);
  expect(await ids('handoff')).toEqual(expect.arrayContaining([rows[0].id, rows[1].id]));
  await router.call('conversations.open', { conversationId: rows[0].id });
  expect(await ids('unread')).not.toContain(rows[0].id);
  expect(await router.call('conversations.get', { conversationId: rows[0].id })).toMatchObject({
    unread: 0,
    openedByHuman: false,
    awaitingHuman: true,
  });
  expect(f.sends).toHaveLength(0);
  expect(f.ai.replyCalls + f.ai.learnCalls).toBe(0);
});

it('分页保留读取时的游标，当前边界会话更新后不会跳过下一页，同时间戳无遗漏', async () => {
  f = await setup();
  const router = new Router(f.engine, f.ai as any);
  const timestamp = new Date('2026-09-01T00:00:00.000Z');
  await f.db.conversation.createMany({
    data: Array.from({ length: 215 }, (_, i) => ({
      storeId: f.account.storeId,
      accountId: f.account.id,
      externalKey: `page-${i}`,
      buyerId: `${i}`,
      buyerName: `客户 ${i}`,
      updatedAt: timestamp,
      awaitingHuman: true,
    })),
  });
  const first = (await router.call('conversations.list', { filter: 'waiting' })) as any[];
  expect(first).toHaveLength(200);
  const before = { id: first.at(-1).id, updatedAt: first.at(-1).updatedAt.toISOString() };
  await f.db.conversation.update({
    where: { id: before.id },
    data: { updatedAt: new Date(), openedByHuman: true },
  });
  const second = (await router.call('conversations.list', { filter: 'waiting', before })) as any[];
  expect(second).toHaveLength(15);
  expect(new Set([...first, ...second].map((c) => c.id)).size).toBe(215);
});

it('全部与指定店铺筛选均隐藏已移除店铺；游标不能绕过店铺与搜索过滤', async () => {
  f = await setup();
  const router = new Router(f.engine, f.ai as any);
  const msg = await f.engine.ingest(f.inbound());
  const before = { id: msg.conversationId, updatedAt: new Date(Date.now() + 60_000).toISOString() };
  expect(await router.call('conversations.list', { storeId: 'other-store', before })).toEqual([]);
  expect(await router.call('conversations.list', { search: '不会匹配的客户', before })).toEqual([]);
  await f.db.account.delete({ where: { id: f.account.id } });
  expect(await router.call('conversations.list', {})).toEqual([]);
  expect(await router.call('conversations.list', { storeId: f.account.storeId, before })).toEqual(
    [],
  );
  expect(await router.call('conversations.get', { conversationId: msg.conversationId })).toBeNull();
});
