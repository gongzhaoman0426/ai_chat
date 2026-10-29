import { defaultConfig } from '../packages/agent-config/src';
import { afterEach, expect, it, vi } from 'vitest';
import { setup, flush, legacyAgent } from './helpers';
import { ReplyPlatformTools } from '../packages/ai/src/platform-tools';
import { availableOperations, resolveReplyScope } from '../packages/ai/src/platform-scope';
import { AssetService } from '../packages/ai/src/assets';
import type { ReplyContext } from '../packages/core/src/types';
import { legacyCommerceToolkit } from '../packages/ai/src/compatibility/commerce-toolkit-v1';
import { COMMERCE_TOOLKIT_ID } from '../packages/contracts/src/toolkit-catalog';
import { hash } from '../packages/core/src/util';
let f: Awaited<ReturnType<typeof setup>> | undefined;
const caps = {
  receive: true,
  sendText: true,
  sendImage: true,
  history: true,
  goods: true,
  buyerProfile: true,
  orders: true,
  shipment: true,
  verified: true,
};
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
async function init() {
  f = await setup();
  const account = await f.engine.registerAccount({
    platform: 'goofish',
    mallId: '100',
    mallName: '闲鱼卖家',
    externalId: '101',
    name: '闲鱼客服',
    partition: 'persist:goofish-test',
    capabilities: caps,
  });
  await f.db.account.update({ where: { id: account.id }, data: { verifiedAt: new Date() } });
  const question = await f.engine.ingest(
    f.inbound('查看订单', {
      accountId: account.id,
      conversationKey: '9001',
      buyerId: '200',
      platformContext: { sellerId: '100', itemId: '300', sessionType: 1, userId: '200' },
    }),
  );
  const config = await f.engine.agents.prepareDraft(
    (await f.db.agentDefinition.findFirstOrThrow()).id,
  );
  const run = await f.db.aiRun.create({
    data: {
      storeId: account.storeId,
      conversationId: question.conversationId,
      role: 'reply',
      path: 'agent',
      status: 'running',
      input: {},
      output: {},
      evidence: [],
      usage: {},
    },
  });
  const ctx: ReplyContext = {
    accountId: account.id,
    storeId: account.storeId,
    conversationId: question.conversationId,
    buyerId: '200',
    runId: run.id,
    configEpoch: 1,
    question: '查看订单',
    messages: [],
    matches: [],
    config,
    revisionId: 'test',
    capabilities: caps,
    signal: new AbortController().signal,
    guard: async () => {},
  };
  const query = vi.fn(async (_account: string, operation: string, input: any) => ({
    operation,
    subjectId:
      operation === 'goods' ? undefined : operation === 'goods-detail' ? input.goodsId : '200',
    queriedAt: new Date().toISOString(),
    partial: operation === 'buyer-orders',
    failedSections: [],
    data:
      operation === 'buyer-orders'
        ? {
            orders: [
              {
                orderSn: '4951116036319758915',
                source: 'current_conversation',
                canShipWithoutLogistics: true,
              },
            ],
          }
        : operation === 'order-detail'
          ? { order: { orderSn: input.orderSn } }
          : { products: [] },
  }));
  f.host.query = query;
  const runtime = new ReplyPlatformTools(f.db, f.host, ctx, new Set());
  return { ...f, account, question, ctx, query, runtime };
}
it('平台和店铺按真实账号决定；新工具仅向适用的平台开放', async () => {
  const t = await init();
  expect(await resolveReplyScope(t.db, t.ctx)).toMatchObject({
    platform: 'goofish',
    conversationKey: '9001',
    platformContext: { sellerId: '100' },
  });
  expect(availableOperations('goofish', caps)).toContain('buyer-profile');
  expect(availableOperations('goofish', caps)).not.toContain('order-remark');
  expect(availableOperations('douyin', caps)).not.toContain('ship-order');
  expect(availableOperations('pinduoduo', caps)).not.toContain('buyer-profile');
  expect(availableOperations('goofish', { ...caps, operations: ['goods'] })).toEqual(['goods']);
  await t.runtime.query('buyer-profile', {}, new Set(['buyerProfile']), t.ctx.signal);
  expect(t.query).toHaveBeenCalledWith(
    t.account.id,
    'buyer-profile',
    expect.objectContaining({
      conversationKey: '9001',
      buyerId: '200',
      platformContext: { sellerId: '100', itemId: '300', sessionType: 1, userId: '200' },
    }),
  );
  await expect(
    t.runtime.query('buyer-profile', { buyerId: '999' }, new Set(['buyerProfile']), t.ctx.signal),
  ).rejects.toThrow();
  await expect(
    resolveReplyScope(t.db, { ...t.ctx, accountId: t.inbound().accountId }),
  ).rejects.toThrow('范围不匹配');
});
it('订单详情与物流只接受本轮、当前店铺买家产生的 orderRef', async () => {
  const t = await init();
  const result: any = await t.runtime.query('buyer-orders', {}, new Set(['orders']), t.ctx.signal);
  const orderRef = result.data.orders[0].orderRef;
  await t.runtime.query('order-detail', { orderRef }, new Set(['orders']), t.ctx.signal);
  expect(t.query).toHaveBeenLastCalledWith(
    t.account.id,
    'order-detail',
    expect.objectContaining({ orderSn: '4951116036319758915' }),
  );
  await expect(
    t.runtime.query(
      'order-detail',
      { orderRef, orderSn: '123' },
      new Set(['orders']),
      t.ctx.signal,
    ),
  ).rejects.toThrow();
  const other = new ReplyPlatformTools(t.db, t.host, { ...t.ctx, runId: 'another-run' }, new Set());
  await expect(
    other.query('order-detail', { orderRef }, new Set(['orders']), t.ctx.signal),
  ).rejects.toThrow('本轮');
});
it('无需物流发货记录在数据库，跨运行重启和修改文案也不重复提交未知订单', async () => {
  const t = await init();
  const result: any = await t.runtime.query('buyer-orders', {}, new Set(['orders']), t.ctx.signal);
  const orderRef = result.data.orders[0].orderRef;
  const execute = vi.fn(async (command, authorize) => {
    await authorize({
      orderSn: command.orderSn,
      buyerId: '200',
      sellerId: '100',
      deliveryMode: 'no_logistics',
      note: command.note,
    });
    throw new Error('network lost after dispatch');
  });
  t.host.executeShipment = execute;
  const input = { orderRef, deliveryMode: 'no_logistics', note: '数字内容已交付' };
  expect(
    await t.runtime.action('ship-order', input, new Set(['orders', 'shipment']), t.ctx.signal),
  ).toMatchObject({ status: 'unknown' });
  const resumed = new ReplyPlatformTools(t.db, t.host, t.ctx, new Set());
  expect(
    await resumed.action(
      'ship-order',
      { ...input, note: '更换说明也不能重发' },
      new Set(['orders', 'shipment']),
      t.ctx.signal,
    ),
  ).toMatchObject({ status: 'unknown' });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await t.db.platformAction.findFirst({ where: { operation: 'ship-order' } })).toMatchObject(
    { status: 'unknown', storeId: t.account.storeId },
  );
});
it('发货预览若换买家、商家、订单或说明，在提交前拒绝', async () => {
  const t = await init();
  const result: any = await t.runtime.query('buyer-orders', {}, new Set(['orders']), t.ctx.signal);
  const dispatch = vi.fn();
  t.host.executeShipment = async (command, authorize) => {
    await authorize({
      orderSn: command.orderSn,
      buyerId: '999',
      sellerId: '100',
      deliveryMode: 'no_logistics',
      note: command.note,
    });
    dispatch();
    return { status: 'confirmed', reasonCode: 'test', message: 'test' };
  };
  const input = {
    orderRef: result.data.orders[0].orderRef,
    deliveryMode: 'no_logistics',
    note: '已交付',
  };
  expect(
    await t.runtime.action('ship-order', input, new Set(['orders', 'shipment']), t.ctx.signal),
  ).toMatchObject({ status: 'rejected' });
  expect(dispatch).not.toHaveBeenCalled();
  await expect(
    t.runtime.action('ship-order', input, new Set(['orders']), t.ctx.signal),
  ).rejects.toThrow('未挂载');
});
it('新工具版本保持旧版本哈希，旧 Agent 可运行且新手只看到当前版本', async () => {
  const t = await init(),
    assets = new AssetService(t.db, t.dir);
  const old = await t.db.installedExtension.findUniqueOrThrow({
    where: { id: 'builtin/commerce@1.0.0' },
  });
  expect(old.artifactHash).toBe(hash(legacyCommerceToolkit.manifest));
  expect((await assets.module(old.id)).manifest.members.map((m) => m.id)).not.toContain(
    'ship-order',
  );
  expect((await assets.module(COMMERCE_TOOLKIT_ID)).manifest.members.map((m) => m.id)).toContain(
    'ship-order',
  );
  expect(
    (await assets.list()).assets.filter((a) => a.assetId === 'builtin/commerce').map((a) => a.id),
  ).toEqual([COMMERCE_TOOLKIT_ID]);
});
it('闲鱼人工文本回复保留 AI 接待并进入原有发送与学习流程', async () => {
  const t = await init();
  await t.engine.setPolicy({
    storeId: t.account.storeId,
    autoReplyEnabled: true,
    autoLearnEnabled: true,
  });
  const msg = await t.engine.ingest(
    t.inbound('在吗', {
      accountId: t.account.id,
      conversationKey: '9002',
      buyerId: '201',
      platformContext: { sellerId: '100', itemId: '300', sessionType: 1, userId: '201' },
    }),
  );
  await flush(t.engine, t.db);
  expect(t.ai.replyCalls).toBe(1);
  expect(t.sends).toHaveLength(1);
  expect(t.sends[0]).toMatchObject({
    accountId: t.account.id,
    conversationKey: '9002',
    buyerId: '201',
    platformContext: { sellerId: '100' },
  });
  expect(t.ai.learnCalls).toBe(1);
  const human = await t.engine.sendManual({
    conversationId: msg.conversationId,
    text: '我来继续处理',
    requestId: 'manual-idle',
  });
  await flush(t.engine, t.db);
  expect(await t.db.outboundMessage.findUnique({ where: { id: human.id } })).toMatchObject({
    status: 'confirmed',
  });
  expect(await t.db.conversation.findUnique({ where: { id: msg.conversationId } })).toMatchObject({
    openedByHuman: false,
  });
  const turns = await t.db.answeredTurn.findMany({ where: { storeId: t.account.storeId } });
  expect(turns.length).toBeGreaterThan(0);
});

it('保留自定义 Agent 的历史发布配置，保存草稿改为工具包身份引用', async () => {
  const t = await init();
  const config = {
    ...defaultConfig(t.model.id),
    name: '自定义旧版',
    prompt: '保留我的定制提示词',
    toolkitIds: ['builtin/commerce@1.0.0'],
  };
  const { definition, revision } = await legacyAgent(t, config);
  await t.engine.agents.retirePddToolkits();
  await t.engine.agents.upgradeBuiltinDefaults();
  expect(await t.db.agentRevision.count({ where: { agentId: definition.id } })).toBe(1);
  expect(
    (await t.db.agentDefinition.findUniqueOrThrow({ where: { id: definition.id } })).draftConfig,
  ).toEqual(config);
  const saved = await t.engine.agents.save({
    id: definition.id,
    expectedRevision: definition.draftRevision,
    config,
  });
  expect((saved.draftConfig as any).toolkitIds).toEqual(['builtin/commerce']);
  expect(await t.db.agentRevision.findUnique({ where: { id: revision.id } })).toMatchObject({
    configHash: revision.configHash,
  });
});
