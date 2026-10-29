import { afterEach, expect, it, vi } from 'vitest';
import { setup } from './helpers';
import { WorkbenchService } from '../packages/core/src/workbench';
import { normalizeKuaishouQuery } from '../packages/platforms/src/kuaishou/queries';
import { kuaishouOrders } from './fixtures-kuaishou';
import { commerceToolkit } from '../packages/ai/src/commerce-toolkit';
import { AssetService } from '../packages/ai/src/assets';
import { availableOperations } from '../packages/contracts/src/platform-operations';
let f: Awaited<ReturnType<typeof setup>>;
let assets: AssetService;
afterEach(async () => {
  assets?.close();
  await f?.cleanup();
});
const caps = {
  receive: true,
  sendText: true,
  sendImage: true,
  history: true,
  goods: true,
  orders: true,
  buyerProfile: true,
  staffTransfer: true,
  staffGroups: true,
  sendProductCard: true,
  verified: true,
};
it('快手右侧工作台绑定账号和买家，生成订单引用，拒绝跨会话引用和缺失能力', async () => {
  f = await setup();
  const a = await f.engine.registerAccount({
    platform: 'kuaishou',
    mallId: '100',
    mallName: '快手店',
    externalId: '101',
    name: '快手客服',
    partition: 'persist:kuaishou-test',
    capabilities: caps,
  });
  const m = await f.engine.ingest(
    f.inbound('订单', {
      accountId: a.id,
      buyerId: '200',
      conversationKey: '0_200',
      platformContext: { sessionType: 0, sellerId: '100', userId: '200' },
    }),
  );
  f.host.query = vi.fn(async (_accountId, op, input) =>
    normalizeKuaishouQuery(
      op as any,
      kuaishouOrders,
      Object.fromEntries(
        Object.entries(input).filter(([k]) => ['page', 'pageSize', 'keyword'].includes(k)),
      ),
      '200',
    ),
  );
  f.host.staff = vi.fn(async () => [{ id: '102', name: '售后客服' }]);
  f.host.executeTransfer = vi.fn(async () => ({
    status: 'confirmed' as const,
    reasonCode: 'fixture',
    message: '已确认',
  }));
  const service = new WorkbenchService(f.engine),
    context = await service.context(m.conversationId);
  expect(context.operations).toEqual(
    expect.arrayContaining([
      'buyer-orders',
      'buyer-profile',
      'buyer-footprint',
      'goods',
      'history',
      'send-product-card',
      'staff-list',
      'transfer-conversation',
      'transfer-group',
    ]),
  );
  for (const op of ['ship-order', 'order-remark', 'close-conversation', 'send-video'])
    expect(context.operations).not.toContain(op);
  const result: any = await service.query(context.sessionId, 'buyer-orders', { keyword: '水杯' });
  expect(result.data.orders[0]).toMatchObject({
    orderRef: expect.stringMatching(/^order:/),
    productTitle: '快手测试水杯',
  });
  expect(f.host.query).toHaveBeenCalledWith(
    a.id,
    'buyer-orders',
    expect.objectContaining({
      buyerId: '200',
      conversationKey: '0_200',
      keyword: '水杯',
      platformContext: { sellerId: '100', sessionType: 0, userId: '200' },
    }),
  );
  const other = await f.engine.ingest(
    f.inbound('其他', {
      accountId: a.id,
      buyerId: '201',
      conversationKey: '0_201',
      platformContext: { sellerId: '100', sessionType: 0, userId: '201' },
    }),
  );
  const next = await service.context(other.conversationId);
  await expect(
    service.query(next.sessionId, 'order-remark-state', {
      orderRef: result.data.orders[0].orderRef,
    }),
  ).rejects.toThrow();
  await expect(
    service.query(context.sessionId, 'buyer-orders', { buyerId: '201' }),
  ).rejects.toThrow();
  expect(await f.db.aiRun.count()).toBe(0);
});
it('同一个最新 Toolkit 给快手只暴露已支持查询，转接保留在人工侧，旧挂载自动解析', async () => {
  f = await setup();
  assets = new AssetService(f.db, f.dir);
  await assets.initialize();
  const query = vi.fn(async (operation: string) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: { buyerId: '200' },
    evidenceRef: 'fixture',
  }));
  const ctx: any = {
    role: 'reply',
    storeId: 'store',
    accountId: 'account',
    conversationId: 'conversation',
    runId: 'run',
    signal: new AbortController().signal,
    settings: {},
    knowledge: { search: async () => [] },
    platform: { id: 'kuaishou', operations: availableOperations('kuaishou', caps), query },
    agents: { runSub: async () => ({}) },
    logger: { info() {} },
  };
  const tools = await assets.tools(
    `builtin/commerce@${commerceToolkit.manifest.version}`,
    ctx,
    new Set(['goods', 'history', 'orders', 'buyerProfile', 'staffGroups', 'sendProductCard']),
    async () => {},
  );
  expect(Object.keys(tools).sort()).toEqual(
    ['buyer-profile', 'buyer-orders', 'buyer-footprint', 'goods', 'history', 'send-product-card']
      .map((op) => assets.alias(`builtin/commerce/${op}`))
      .sort(),
  );
  await (tools[assets.alias('builtin/commerce/buyer-profile')] as any).execute({}, {});
  expect(query).toHaveBeenCalledWith('buyer-profile', {});
  const { currentToolkit } = await import('../packages/agent-config/src/toolkit-resolution');
  expect((await currentToolkit(f.db, 'builtin/commerce@1.2.1')).version).toBe(
    commerceToolkit.manifest.version,
  );
});
