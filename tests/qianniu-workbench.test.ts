import { afterEach, expect, it, vi } from 'vitest';
import { setup } from './helpers';
import { WorkbenchService } from '../packages/core/src/workbench';
import { CommerceService } from '../packages/core/src/commerce-service';
import { AssetService } from '../packages/ai/src/assets';
import { commerceToolkit } from '../packages/ai/src/commerce-toolkit';
import { currentToolkit } from '../packages/agent-config/src/toolkit-resolution';
import { availableOperations } from '../packages/contracts/src/platform-operations';
import { capabilitiesSchema } from '../packages/contracts/src';
import { uid } from '../packages/core/src/util';

let fixture: Awaited<ReturnType<typeof setup>>;
let assets: AssetService | undefined;
afterEach(async () => {
  assets?.close();
  assets = undefined;
  await fixture?.cleanup();
});
const capabilities = capabilitiesSchema.parse({
  receive: true,
  sendText: true,
  sendImage: true,
  verified: true,
  goods: true,
  orders: true,
  history: true,
  buyerProfile: true,
  staffGroups: true,
  staffTransfer: true,
  sendProductCard: true,
  quickActions: true,
});

async function prepare() {
  const f = (fixture = await setup());
  const account = await f.engine.registerAccount({
    platform: 'qianniu',
    mallId: '600',
    mallName: '千牛测试店',
    externalId: '店铺:主客服',
    name: '主客服',
    partition: 'persist:qianniu-main',
    capabilities,
  });
  const message = await f.engine.ingest(
    f.inbound('查订单和商品', {
      accountId: account.id,
      buyerId: 'buyer-001',
      buyerName: '千牛买家',
      conversationKey: 'cntaobao:buyer-001',
      platformContext: { sellerId: '600', userId: 'buyer-001' },
    }),
  );
  f.host.query = vi.fn(async (_id, operation, input) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: operation === 'history',
    failedSections:
      operation === 'history' ? [{ section: 'platform_history', reason: '仅本机已同步消息' }] : [],
    subjectId:
      operation === 'goods'
        ? undefined
        : operation === 'goods-detail'
          ? String(input.goodsId)
          : String(input.buyerId),
    data:
      operation === 'goods'
        ? { products: [{ goodsId: '300', title: '纯棉衬衫', priceText: '¥89.00' }], hasMore: false }
        : operation === 'buyer-orders'
          ? {
              orders: [
                {
                  orderSn: '123456789',
                  productTitle: '纯棉衬衫',
                  statusText: '已付款',
                  amountText: '¥89.00',
                },
              ],
              hasMore: false,
            }
          : operation === 'order-detail'
            ? { order: { orderSn: input.orderSn, productTitle: '纯棉衬衫' } }
            : operation === 'order-logistics'
              ? { orderSn: input.orderSn, records: [{ label: '物流', value: '等待揽收' }] }
              : operation === 'history'
                ? {
                    messages: [{ messageId: message.id, text: message.text }],
                    source: 'local',
                    hasMore: false,
                    nextCursor: null,
                  }
                : { name: '千牛买家' },
  }));
  f.host.staff = vi.fn(async () => [
    { id: '2220231913125', name: '售后客服小林', statusText: '在线' },
  ]);
  f.host.executeTransfer = vi.fn(async (command, authorize) => {
    await authorize({
      targetStaffId: command.targetStaffId,
      targetName: '售后客服小林',
      buyerId: command.buyerId,
      conversationKey: command.conversationKey!,
    });
    return {
      status: 'confirmed' as const,
      reasonCode: 'platform_receipt',
      message: '千牛已确认转接',
    };
  });
  const workbench = new WorkbenchService(f.engine);
  const context = await workbench.context(message.conversationId);
  return { ...f, account, message, workbench, context };
}

it('千牛侧栏提供商品、订单和个人客服转接，查询固定当前账号和买家且产出受限引用', async () => {
  const f = await prepare();
  expect(f.context.operations).toEqual(
    expect.arrayContaining([
      'goods',
      'goods-detail',
      'buyer-footprint',
      'buyer-orders',
      'order-detail',
      'order-logistics',
      'buyer-profile',
      'history',
      'staff-list',
      'transfer-conversation',
      'transfer-group',
      'invite-order',
    ]),
  );
  for (const unsupported of [
    'goods-skus',
    'ship-order',
    'order-remark',
    'video-materials',
    'invite-review',
  ])
    expect(f.context.operations).not.toContain(unsupported);
  const goods: any = await f.workbench.query(f.context.sessionId, 'goods', {
    keyword: '衬衫',
    page: 2,
  });
  expect(goods.data.products[0].productRef).toMatch(/^product:/);
  expect(f.host.query).toHaveBeenCalledWith(
    f.account.id,
    'goods',
    expect.objectContaining({
      buyerId: 'buyer-001',
      keyword: '衬衫',
      page: 2,
      pageSize: 10,
      conversationKey: 'cntaobao:buyer-001',
      platformContext: { sellerId: '600', userId: 'buyer-001' },
    }),
  );
  const orders: any = await f.workbench.query(f.context.sessionId, 'buyer-orders', {});
  const orderRef = orders.data.orders[0].orderRef;
  expect(orderRef).toMatch(/^order:/);
  await f.workbench.query(f.context.sessionId, 'order-detail', { orderRef });
  await f.workbench.query(f.context.sessionId, 'order-logistics', { orderRef });
  expect(f.host.query).toHaveBeenLastCalledWith(
    f.account.id,
    'order-logistics',
    expect.objectContaining({ orderSn: '123456789', buyerId: 'buyer-001' }),
  );
  await expect(
    f.workbench.query(f.context.sessionId, 'buyer-orders', { keyword: '衬衫' }),
  ).rejects.toThrow('不支持关键词');
  await expect(
    f.workbench.query(f.context.sessionId, 'goods', { accountId: 'foreign', buyerId: 'foreign' }),
  ).rejects.toThrow();
  const other = await f.engine.ingest(
    f.inbound('其他买家', {
      accountId: f.account.id,
      buyerId: 'buyer-002',
      conversationKey: 'cntaobao:buyer-002',
    }),
  );
  const foreign = await f.workbench.context(other.conversationId);
  const calls = vi.mocked(f.host.query).mock.calls.length;
  await expect(
    f.workbench.query(foreign.sessionId, 'order-detail', { orderRef }),
  ).rejects.toThrow();
  expect(f.host.query).toHaveBeenCalledTimes(calls);
  const secondAccount = await f.engine.registerAccount({
    platform: 'qianniu',
    mallId: '601',
    mallName: '另一千牛店',
    externalId: '另一店:主客服',
    name: '另店主客服',
    partition: 'persist:qianniu-other',
    capabilities,
  });
  const secondMessage = await f.engine.ingest(
    f.inbound('同一买家在另店咨询', {
      accountId: secondAccount.id,
      buyerId: 'buyer-001',
      conversationKey: 'cntaobao:buyer-001',
      platformContext: { sellerId: '601', userId: 'buyer-001' },
    }),
  );
  const secondContext = await f.workbench.context(secondMessage.conversationId);
  await f.workbench.query(secondContext.sessionId, 'goods', {});
  expect(f.host.query).toHaveBeenLastCalledWith(
    secondAccount.id,
    'goods',
    expect.objectContaining({
      buyerId: 'buyer-001',
      platformContext: { sellerId: '601', userId: 'buyer-001' },
    }),
  );
  await expect(
    f.workbench.query(secondContext.sessionId, 'order-detail', { orderRef }),
  ).rejects.toThrow();
  await f.db.account.update({
    where: { id: f.account.id },
    data: { capabilities: { ...capabilities, goods: false } },
  });
  await expect(f.workbench.query(f.context.sessionId, 'goods', {})).rejects.toThrow('不再支持');
  expect(await f.db.aiRun.count()).toBe(0);
});

it.each(['confirmed', 'unknown'] as const)(
  '千牛个人转接使用本会话客服引用，%s 回执保留人工和审计且不会重放',
  async (status) => {
    const f = await prepare();
    f.host.executeTransfer = vi.fn(async (command, authorize) => {
      await authorize({
        targetStaffId: command.targetStaffId,
        targetName: '售后客服小林',
        buyerId: command.buyerId,
        conversationKey: command.conversationKey!,
      });
      return {
        status,
        reasonCode: 'fixture',
        message: status === 'confirmed' ? '平台已确认' : '平台未明确确认，请核对',
      };
    });
    const staff: any = await f.workbench.query(f.context.sessionId, 'staff-list', {});
    const request = {
      sessionId: f.context.sessionId,
      requestId: uid(),
      operation: 'transfer-conversation' as const,
      input: { staffRef: staff.data.staff[0].staffRef, note: '请协助售后' },
    };
    const result: any = await f.workbench.action(request);
    expect(result.status, JSON.stringify(result)).toBe(status);
    await f.workbench.action(request);
    expect(f.host.executeTransfer).toHaveBeenCalledTimes(1);
    expect(f.host.executeTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: f.account.id,
        buyerId: 'buyer-001',
        conversationKey: 'cntaobao:buyer-001',
        targetStaffId: '2220231913125',
        note: '请协助售后',
      }),
      expect.any(Function),
    );
    expect(
      await f.db.conversation.findUnique({ where: { id: f.message.conversationId } }),
    ).toMatchObject({ openedByHuman: true, awaitingHuman: true });
    expect(await f.db.platformAction.findUnique({ where: { id: result.actionId } })).toMatchObject({
      status,
      accountId: f.account.id,
      sourceEvidenceId: staff.evidenceRef,
    });
    await expect(f.engine.setReception(f.message.conversationId, 'ai')).rejects.toThrow();
  },
);

it('千牛转接拒绝跨会话客服引用与授权前变更的接待范围', async () => {
  const f = await prepare();
  const staff: any = await f.workbench.query(f.context.sessionId, 'staff-list', {});
  const other = await f.engine.ingest(
    f.inbound('其他买家', {
      accountId: f.account.id,
      buyerId: 'buyer-002',
      conversationKey: 'cntaobao:buyer-002',
    }),
  );
  const foreign = await f.workbench.context(other.conversationId);
  const request = {
    sessionId: foreign.sessionId,
    requestId: uid(),
    operation: 'transfer-conversation' as const,
    input: { staffRef: staff.data.staff[0].staffRef, note: '请协助售后' },
  };
  await expect(f.workbench.action(request)).rejects.toThrow('不属于当前店铺');
  expect(f.host.executeTransfer).not.toHaveBeenCalled();
  let dispatched = false;
  f.host.executeTransfer = vi.fn(async (command, authorize) => {
    await f.db.conversation.update({
      where: { id: f.message.conversationId },
      data: { routeVersion: { increment: 1 } },
    });
    await authorize({
      targetStaffId: command.targetStaffId,
      targetName: '售后客服小林',
      buyerId: command.buyerId,
      conversationKey: command.conversationKey!,
    });
    dispatched = true;
    return { status: 'confirmed' as const, reasonCode: 'fixture', message: '平台已确认' };
  });
  const result: any = await f.workbench.action({
    ...request,
    sessionId: f.context.sessionId,
    requestId: uid(),
  });
  expect(result.status).toBe('rejected');
  expect(dispatched).toBe(false);
});

it('共享 Toolkit 为千牛封装商品和订单证据，隐去未支持及人工工具，旧挂载升级且保留原清单', async () => {
  const f = await prepare();
  assets = new AssetService(f.db, f.dir);
  const old = await f.db.installedExtension.findUniqueOrThrow({
    where: { id: 'builtin/commerce@1.3.0' },
  });
  expect(old.artifactHash).toBe('9aac36f3e4c747d0bf136e2d24933a5d1a2a15346854024f26089b5953cb30ad');
  const current = await currentToolkit(f.db, old.id);
  expect(current.version).toBe(commerceToolkit.manifest.version);
  const run = await f.db.aiRun.create({
    data: {
      storeId: f.account.storeId,
      conversationId: f.message.conversationId,
      role: 'reply',
      path: 'agent',
      input: {},
      output: {},
      evidence: [],
      usage: {},
    },
  });
  const evidence = new Set<string>();
  const runtime = new CommerceService(
    f.db,
    f.host,
    {
      platform: 'qianniu',
      storeId: f.account.storeId,
      accountId: f.account.id,
      conversationId: f.message.conversationId,
      buyerId: 'buyer-001',
      runId: run.id,
      capabilities,
      guard: async () => {},
    },
    evidence,
  );
  const allowed = new Set([
    'goods',
    'orders',
    'history',
    'buyerProfile',
    'staffGroups',
    'sendProductCard',
    'quickActions',
  ]);
  const ctx: any = {
    role: 'reply',
    storeId: f.account.storeId,
    accountId: f.account.id,
    conversationId: f.message.conversationId,
    runId: run.id,
    signal: new AbortController().signal,
    settings: {},
    knowledge: { search: async () => [] },
    agents: { runSub: async () => ({}) },
    logger: { info() {} },
    platform: {
      id: 'qianniu',
      operations: availableOperations('qianniu', capabilities),
      query: (op: string, input: any) =>
        runtime.query(op, input, allowed, AbortSignal.timeout(10000)),
    },
  };
  const tools = await assets.tools(current.id, ctx, allowed, async () => {});
  const tool = (op: string) => tools[assets!.alias(`builtin/commerce/${op}`)] as any;
  for (const op of [
    'goods',
    'buyer-orders',
    'order-detail',
    'order-logistics',
    'history',
    'send-product-card',
  ])
    expect(tool(op)).toBeDefined();
  for (const op of [
    'ship-order',
    'goods-skus',
    'order-remark',
    'staff-groups',
    'staff-statistics',
    'transfer-conversation',
    'invite-review',
  ])
    expect(tool(op)).toBeUndefined();
  expect(tool('goods').inputSchema.safeParse({ keyword: '衬衫' }).success).toBe(true);
  expect(tool('buyer-orders').inputSchema.safeParse({ keyword: '衬衫' }).success).toBe(false);
  expect(tool('history').description).toContain('本机已同步');
  const orders = await tool('buyer-orders').execute({}, {});
  await tool('order-detail').execute({ orderRef: orders.data.orders[0].orderRef }, {});
  await tool('goods').execute({ keyword: '衬衫' }, {});
  expect(evidence.size).toBe(3);
  expect(
    await f.db.platformEvidence.count({
      where: { runId: run.id, accountId: f.account.id, buyerId: 'buyer-001', sessionId: null },
    }),
  ).toBe(3);
  await expect(
    tool('order-detail').execute({ orderRef: `order:${uid()}:0` }, {}),
  ).rejects.toThrow();
  await assets.initialize();
  expect(await f.db.installedExtension.findUnique({ where: { id: old.id } })).toEqual(old);
});
