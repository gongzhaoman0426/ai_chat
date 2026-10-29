import { afterEach, expect, it, vi } from 'vitest';
import { Router } from '../packages/core/src/router';
import { setup } from './helpers';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  vi.restoreAllMocks();
  f = undefined;
});

async function init() {
  f = await setup();
  const router = new Router(f.engine, {} as any);
  return { ...f, router };
}

it('问答绑定时从已连接店铺拉取商品，不要求手填 ID', async () => {
  const t = await init();
  await t.engine.ingest(t.inbound());
  t.host.query = vi.fn(async (_account, operation, input: any) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: {
      products: [
        { goodsId: '10010892206577', title: '嘉兴大肉粽', imageUrl: 'https://img.test/z.png' },
      ],
      hasMore: false,
    },
  }));
  const result = (await t.router.call('stores.goods', { storeId: t.account.storeId })) as any;
  expect(result).toMatchObject({
    online: true,
    products: [{ goodsId: '10010892206577', title: '嘉兴大肉粽' }],
    hasMore: false,
  });
  expect(t.host.query).toHaveBeenCalledWith(
    t.account.id,
    'goods',
    expect.objectContaining({ page: 1, pageSize: 20, buyerId: 'buyer-a' }),
  );
  expect((t.host.query as any).mock.calls[0][2].keyword).toBeUndefined();
});

it('拼多多没有会话也能拉店铺商品', async () => {
  const t = await init();
  t.host.query = vi.fn(async () => ({
    operation: 'goods',
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: { groups: [{ items: [{ goodsId: '88', title: '短袖' }] }] },
  }));
  const result = (await t.router.call('stores.goods', { storeId: t.account.storeId })) as any;
  expect(result.products).toEqual([{ goodsId: '88', title: '短袖' }]);
  expect(t.host.query).toHaveBeenCalledWith(
    t.account.id,
    'goods',
    expect.objectContaining({ buyerId: '' }),
  );
});

it('未连接账号时不查询平台，提示先连接', async () => {
  const t = await init();
  await t.db.account.update({ where: { id: t.account.id }, data: { status: 'offline' } });
  t.host.query = vi.fn();
  const result = (await t.router.call('stores.goods', { storeId: t.account.storeId })) as any;
  expect(result).toMatchObject({
    online: false,
    products: [],
    reason: expect.stringContaining('连接'),
  });
  expect(t.host.query).not.toHaveBeenCalled();
});

it('抖店没有会话时不查询，避免误用买家上下文', async () => {
  const t = await init();
  const dy = await t.engine.registerAccount({
    platform: 'douyin',
    partition: 'persist:douyin-goods',
    mallId: 'dy-mall',
    mallName: '抖店铺',
    externalId: 'dy-cs',
    name: '抖客服',
    capabilities: {
      receive: true,
      sendText: true,
      sendImage: true,
      history: true,
      goods: true,
      orders: false,
      verified: true,
    },
  });
  t.host.query = vi.fn();
  const result = (await t.router.call('stores.goods', { storeId: dy.storeId })) as any;
  expect(result.online).toBe(true);
  expect(result.products).toEqual([]);
  expect(result.reason).toMatch(/会话/);
  expect(t.host.query).not.toHaveBeenCalled();
});
