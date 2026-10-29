import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from './helpers';
import { WorkbenchService } from '../packages/core/src/workbench';
import { Router } from '../packages/core/src/router';
import { CommerceService } from '../packages/core/src/commerce-service';
import { executeOrderRemark } from '../packages/platforms/src/pdd/order-remark';
import { normalizeStaff, transferResult } from '../packages/platforms/src/staff';
import { uid } from '../packages/core/src/util';
let f: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await f?.cleanup();
});
const caps = {
  receive: true,
  sendText: true,
  sendImage: true,
  history: true,
  goods: true,
  orders: true,
  orderRemark: true,
  shipment: true,
  buyerProfile: true,
  staffTransfer: true,
  verified: true,
};
async function init(platform: 'pinduoduo' | 'goofish' | 'douyin' = 'pinduoduo') {
  f = await setup();
  const account =
    platform === 'pinduoduo'
      ? f.account
      : await f.engine.registerAccount({
          platform,
          partition: `persist:${platform}`,
          mallId: '100',
          mallName: `${platform}店铺`,
          externalId: '101',
          name: '接待客服',
          capabilities: caps,
        });
  await f.db.account.update({ where: { id: account.id }, data: { capabilities: caps } });
  const message = await f.engine.ingest(
    f.inbound('订单咨询', {
      accountId: account.id,
      buyerId: '200',
      conversationKey: 'conversation-200',
    }),
  );
  f.host.query = vi.fn(async (_account, operation, input: any) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    subjectId:
      operation === 'goods' ? undefined : operation.startsWith('goods-') ? input.goodsId : '200',
    data:
      operation === 'buyer-orders'
        ? { orders: [{ orderSn: '123456789', canShipWithoutLogistics: true }] }
        : { products: [] },
  }));
  f.host.staff = vi.fn(async () => [{ id: 'other-cs', name: '售后客服' }]);
  const service = new WorkbenchService(f.engine);
  const context = await service.context(message.conversationId);
  const query: any = await service.query(context.sessionId, 'buyer-orders', {});
  return {
    ...f,
    account,
    service,
    context,
    orderRef: query.data.orders[0].orderRef,
    conversationId: message.conversationId,
  };
}
const confirmed = {
  status: 'confirmed' as const,
  reasonCode: 'test_receipt',
  message: '平台已确认',
};
it('人工查询无需 Agent 或开发者模式；绑定精确账号，刷新重新查询，既不接管也不创建模型记录', async () => {
  const t = await init();
  const router = new Router(t.engine, t.ai as any);
  await router.call('workbench.query', {
    sessionId: t.context.sessionId,
    operation: 'goods',
    input: {},
  });
  await router.call('workbench.query', {
    sessionId: t.context.sessionId,
    operation: 'goods',
    input: {},
  });
  expect(t.host.query).toHaveBeenCalledTimes(3);
  expect(t.host.query).toHaveBeenLastCalledWith(
    t.account.id,
    'goods',
    expect.objectContaining({ buyerId: '200' }),
  );
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } })).openedByHuman,
  ).toBe(false);
  expect(await t.db.aiRun.count()).toBe(0);
  expect(t.ai.replyCalls + t.ai.learnCalls).toBe(0);
  expect(
    await t.db.platformEvidence.count({ where: { sessionId: t.context.sessionId, runId: null } }),
  ).toBe(3);
  await expect(
    router.call('workbench.query', {
      sessionId: t.context.sessionId,
      operation: 'goods',
      input: { buyerId: '999' },
    }),
  ).rejects.toThrow();
  await expect(
    router.call('workbench.query', {
      sessionId: t.context.sessionId,
      operation: 'refund',
      input: {},
    }),
  ).rejects.toThrow();
});
it('延迟响应、路由变化、失效会话和删除账号不能返回其他店铺的资料', async () => {
  const t = await init();
  const original = t.host.query;
  t.host.query = async (...args) => {
    await t.db.conversation.update({
      where: { id: t.conversationId },
      data: { routeVersion: { increment: 1 } },
    });
    return original(...args);
  };
  await expect(t.service.query(t.context.sessionId, 'goods', {})).rejects.toThrow('账号已变化');
  const ctx = await t.service.context(t.conversationId);
  expect(ctx.sessionId).not.toBe(t.context.sessionId);
  await t.db.workbenchSession.update({
    where: { id: ctx.sessionId },
    data: { expiresAt: new Date(0) },
  });
  await expect(t.service.query(ctx.sessionId, 'goods', {})).rejects.toThrow('已过期');
  await t.db.account.delete({ where: { id: t.account.id } });
  await expect(t.service.context(t.conversationId)).rejects.toThrow('已移除');
});
it('订单引用不能跨人工会话或 AI 运行；无效请求不接管会话', async () => {
  const t = await init();
  await t.db.workbenchSession.update({
    where: { id: t.context.sessionId },
    data: { expiresAt: new Date() },
  });
  const next = await t.service.context(t.conversationId);
  await expect(
    t.service.action({
      sessionId: next.sessionId,
      requestId: uid(),
      operation: 'order-remark',
      input: { orderRef: t.orderRef, note: '核实' },
    }),
  ).rejects.toThrow('不属于');
  const ctx = {
    runId: uid(),
    platform: 'pinduoduo' as const,
    storeId: t.account.storeId,
    accountId: t.account.id,
    conversationId: t.conversationId,
    buyerId: '200',
    capabilities: caps,
    guard: async () => {},
  };
  await expect(
    new CommerceService(t.db, t.host, ctx, new Set()).resolveOrder(t.orderRef),
  ).rejects.toThrow('不属于');
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } })).openedByHuman,
  ).toBe(false);
});
it('人工备注保留接待模式和平台标签，重复请求仅执行一次', async () => {
  const t = await init();
  const before = await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } });
  let state = { remark: '原始备注', tag: 2, tagName: '重点' };
  const write = vi.fn(async (next) => {
    state = next;
    return { success: true };
  });
  t.host.executeAction = vi.fn(async (command, authorize) =>
    executeOrderRemark(command, {
      ownsOrder: async () => true,
      read: async () => ({ ...state }),
      authorize,
      write,
    }),
  );
  const input = {
    sessionId: t.context.sessionId,
    requestId: uid(),
    operation: 'order-remark' as const,
    input: { orderRef: t.orderRef, note: '客户要求晚点发货' },
  };
  const [a, b]: any[] = await Promise.all([t.service.action(input), t.service.action(input)]);
  expect(a.status).toBe('confirmed');
  expect(b.actionId).toBe(a.actionId);
  await t.service.action(input);
  expect(write).toHaveBeenCalledTimes(1);
  expect(state).toEqual({ remark: '原始备注\n客户要求晚点发货', tag: 2, tagName: '重点' });
  await expect(
    t.service.action({ ...input, input: { ...input.input, note: '其他说明' } }),
  ).rejects.toThrow('其他内容');
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
  expect(await t.db.auditEvent.count({ where: { type: 'conversation.reception' } })).toBe(0);
  expect(await t.db.aiRun.count()).toBe(0);
});
it('并发改用相同请求号、提交前能力撤销都不会产生第二次平台写入', async () => {
  const t = await init();
  t.host.executeAction = vi.fn(async (_command, authorize) => {
    await t.db.account.update({
      where: { id: t.account.id },
      data: { capabilities: { ...caps, orderRemark: false } },
    });
    await authorize({
      before: { remark: '', tag: 0, tagName: '' },
      after: { remark: '备注', tag: 0, tagName: '' },
    });
    return confirmed;
  });
  const input = {
    sessionId: t.context.sessionId,
    requestId: uid(),
    operation: 'order-remark' as const,
    input: { orderRef: t.orderRef, note: '备注' },
  };
  const first = t.service.action(input);
  await expect(
    t.service.action({ ...input, input: { ...input.input, note: '偷偷改掉' } }),
  ).rejects.toThrow('其他内容');
  expect(await first).toMatchObject({ status: 'rejected' });
  expect((await t.db.platformAction.findFirstOrThrow()).status).toBe('rejected');
});
it('闲鱼发货必须确认真实交付；未知回执可人工核对但跨新会话也不会重发', async () => {
  const t = await init('goofish');
  const before = await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } });
  t.host.executeShipment = vi.fn(async (command, authorize) => {
    await authorize({
      orderSn: command.orderSn,
      buyerId: '200',
      sellerId: '100',
      note: command.note,
      deliveryMode: 'no_logistics',
    });
    throw new Error('回执连接中断');
  });
  const input = {
    sessionId: t.context.sessionId,
    requestId: uid(),
    operation: 'ship-order' as const,
    input: {
      orderRef: t.orderRef,
      deliveryMode: 'no_logistics' as const,
      note: '已交付',
      delivered: true as const,
    },
  };
  const router = new Router(t.engine, t.ai as any);
  await expect(
    router.call('workbench.action', { ...input, input: { ...input.input, delivered: false } }),
  ).rejects.toThrow();
  const result: any = await router.call('workbench.action', input);
  expect(result.status).toBe('unknown');
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
  expect(await t.service.action(input)).toMatchObject({
    actionId: result.actionId,
    status: 'unknown',
  });
  await expect(t.engine.setReception(t.conversationId, 'ai')).rejects.toThrow('业务操作');
  await t.service.review(result.actionId, '原平台已发货，当前账号可以继续接待');
  expect(
    (await t.db.platformAction.findUniqueOrThrow({ where: { id: result.actionId } })).status,
  ).toBe('unknown');
  await t.engine.setReception(t.conversationId, 'ai');
  await t.db.workbenchSession.update({
    where: { id: t.context.sessionId },
    data: { expiresAt: new Date() },
  });
  const fresh = await t.service.context(t.conversationId);
  const query: any = await t.service.query(fresh.sessionId, 'buyer-orders', {});
  await t.service.action({
    ...input,
    sessionId: fresh.sessionId,
    requestId: uid(),
    input: { ...input.input, orderRef: query.data.orders[0].orderRef, note: '新说明' },
  });
  expect(t.host.executeShipment).toHaveBeenCalledTimes(1);
});
it('转接只使用本会话客服引用；原生成功后保持人工，复核后才能恢复 AI', async () => {
  const t = await init('douyin');
  t.host.executeTransfer = vi.fn(async (command, authorize) => {
    expect(
      await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } }),
    ).toMatchObject({
      openedByHuman: true,
    });
    await authorize({
      targetStaffId: command.targetStaffId,
      targetName: '售后客服',
      buyerId: '200',
      conversationKey: 'conversation-200',
    });
    return confirmed;
  });
  const list: any = await t.service.query(t.context.sessionId, 'staff-list', {});
  const request = {
    sessionId: t.context.sessionId,
    requestId: uid(),
    operation: 'transfer-conversation' as const,
    input: { staffRef: list.data.staff[0].staffRef, note: '售后处理' },
  };
  const result: any = await t.service.action(request);
  expect(result.status).toBe('confirmed');
  await t.service.action(request);
  expect(t.host.executeTransfer).toHaveBeenCalledTimes(1);
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } }),
  ).toMatchObject({
    openedByHuman: true,
    awaitingHuman: true,
  });
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: t.conversationId } })).handoffReason,
  ).toContain('售后客服');
  await expect(t.engine.setReception(t.conversationId, 'ai')).rejects.toThrow('平台转接');
  await expect(t.service.action({ ...request, requestId: uid() })).rejects.toThrow('尚待核对');
  await t.service.review(result.actionId, '已在原平台重新分配给本账号');
  await t.engine.setReception(t.conversationId, 'ai');
});
it('重启将未提交操作取消、已提交操作标成待核对，不会自动重放；导出保留人工核对且防公式注入', async () => {
  const t = await init();
  const source = await t.db.platformEvidence.findFirstOrThrow();
  const create = (status: string) =>
    t.db.platformAction.create({
      data: {
        sessionId: t.context.sessionId,
        storeId: t.account.storeId,
        accountId: t.account.id,
        buyerId: '200',
        conversationId: t.conversationId,
        operation: 'order-remark',
        targetId: '123456789',
        sourceEvidenceId: source.id,
        dedupKey: uid(),
        status,
        input: { note: '=HYPERLINK("test")' },
        preview: {},
        result: {},
      },
    });
  const prepared = await create('prepared'),
    dispatched = await create('dispatched');
  await t.engine.initialize();
  expect((await t.db.platformAction.findUniqueOrThrow({ where: { id: prepared.id } })).status).toBe(
    'rejected',
  );
  expect(
    (await t.db.platformAction.findUniqueOrThrow({ where: { id: dispatched.id } })).status,
  ).toBe('unknown');
  const file = join(t.dir, 'operations.csv');
  t.host.saveFile = async () => file;
  await new Router(t.engine, t.ai as any).call('workbench.export', {
    conversationId: t.conversationId,
  });
  const csv = await readFile(file, 'utf8');
  expect(csv).toContain('人工核对时间');
  expect(csv).toContain("'=HYPERLINK");
  expect(await t.db.aiRun.count()).toBe(0);
});
it('聚合概况从数据库统计，不受 200 条会话列表上限影响；移除店铺不再出现', async () => {
  const t = await init();
  await t.db.conversation.createMany({
    data: Array.from({ length: 205 }, (_, i) => ({
      storeId: t.account.storeId,
      accountId: t.account.id,
      buyerId: `buyer-${i}`,
      buyerName: `买家${i}`,
      externalKey: `c-${i}`,
      awaitingHuman: true,
    })),
  });
  expect((await t.service.overview())[0].waiting).toBe(205);
  await t.db.account.delete({ where: { id: t.account.id } });
  expect(await t.service.overview()).toEqual([]);
});
it('平台客服列表及转接回执严格解析，空回执不是成功', () => {
  expect(
    normalizeStaff('pinduoduo', {
      success: true,
      errorCode: 1000000,
      result: { csList: [{ csid: '123', csName: '小王' }] },
    }),
  ).toEqual([{ id: '123', name: '小王' }]);
  expect(
    normalizeStaff('douyin', { code: 0, data: { serviceList: [{ id: '456', name: '小李' }] } }),
  ).toEqual([{ id: '456', name: '小李' }]);
  expect(() => normalizeStaff('pinduoduo', { success: true, result: {} })).toThrow('结构');
  expect(() =>
    normalizeStaff('douyin', {
      code: 0,
      data: { list: [{ id: Number.MAX_SAFE_INTEGER + 1, name: '客服' }] },
    }),
  ).toThrow('ID');
  expect(transferResult('pinduoduo', undefined).status).toBe('unknown');
  expect(transferResult('pinduoduo', { success: true, errorCode: 1000000 }).status).toBe(
    'confirmed',
  );
  expect(transferResult('pinduoduo', { success: true, errorCode: 403 }).status).toBe('rejected');
  expect(transferResult('douyin', { code: 0 }).status).toBe('confirmed');
  expect(transferResult('douyin', { code: 403 }).status).toBe('rejected');
});

it('拼多多原生 csList 索引对象正确显示昵称、排除当前客服，空对象是无候选', () => {
  const raw = (csList: Record<string, unknown>) => ({
    success: true,
    errorCode: 1000000,
    result: { csList, transReason: [] },
  });
  const self = { id: 111, nickname: '当前接待', username: 'internal-self' };
  const other = { id: 222, nickname: '售后客服', username: 'internal-other', unreplyNum: 2 };
  expect(normalizeStaff('pinduoduo', raw({ 123: self, 456: other }), '111')).toEqual([
    { id: '456', name: '售后客服' },
  ]);
  expect(normalizeStaff('pinduoduo', raw({ 123: self }), '111')).toEqual([]);
  expect(normalizeStaff('pinduoduo', raw({}), '111')).toEqual([]);
  expect(normalizeStaff('pinduoduo', raw({ 123: self, 111: other }), '111')).toEqual([
    { id: '111', name: '售后客服' },
  ]);
  expect(
    normalizeStaff(
      'pinduoduo',
      raw({ 456: { ...other, nickname: '', username: '客服账号' } }),
      '111',
    ),
  ).toEqual([{ id: '456', name: '客服账号' }]);
});

it.each([
  { 123: { id: 111, csid: '456', nickname: '索引不匹配' } },
  { 123: null },
  { 123: { nickname: '缺少身份' } },
  { '9007199254740993': { id: Number.MAX_SAFE_INTEGER + 1, nickname: '精度丢失' } },
])('拼多多索引列表身份无效时拒绝返回可转接目标：%j', (csList) => {
  expect(() => normalizeStaff('pinduoduo', { success: true, result: { csList } })).toThrow(
    '客服 ID',
  );
});

it('抖店原生 data 数组只列出其他可转接客服，空列表和只有本人都没有目标', () => {
  const self = { staffId: '7000000000000000001', staffName: '当前接待', status: 1 };
  const other = { staffId: '7000000000000000002', staffName: '售后客服', status: 1 };
  const response = (data: unknown[]) => ({
    code: 0,
    st: 0,
    check_spam_resp: { decision: 'PASS' },
    data,
  });
  expect(normalizeStaff('douyin', response([]), self.staffId)).toEqual([]);
  expect(normalizeStaff('douyin', response([self]), self.staffId)).toEqual([]);
  expect(normalizeStaff('douyin', response([self, other, other]), self.staffId)).toEqual([
    { id: other.staffId, name: other.staffName },
  ]);
});

it('抖店优先使用 staffIdStr，避免长数字 ID 丢精度或把本人列为转接目标', () => {
  const self = '7000000000000000001',
    other = '7000000000000000002';
  // These two IDs round to the same JavaScript number in the legacy field.
  expect(Number(self)).toBe(Number(other));
  expect(
    normalizeStaff(
      'douyin',
      {
        code: 0,
        data: [
          { staffId: Number(self), staffIdStr: self, staffName: '当前接待' },
          { staffId: Number(other), staffIdStr: other, staffName: '售后客服' },
        ],
      },
      self,
    ),
  ).toEqual([{ id: other, name: '售后客服' }]);
});

it.each([
  { code: 403, data: [] },
  { code: 0, data: { st: 403, data: [] } },
  { code: 0, check_spam_resp: { decision: 'VERIFY' }, data: [] },
  { code: 0, data: {} },
])('抖店拒绝、验证要求和未知结构不能显示为没有可转接客服：%j', (raw) => {
  expect(() => normalizeStaff('douyin', raw, 'current-staff')).toThrow();
});
