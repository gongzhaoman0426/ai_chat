import { afterEach, expect, it, vi } from 'vitest';
import { setup, waitFor } from './helpers';
import { WorkbenchService } from '../packages/core/src/workbench';
import { CommerceService } from '../packages/core/src/commerce-service';
import { normalizeExtraQuery } from '../packages/platforms/src/commerce-extra';
import { normalizePddMessage } from '../packages/platforms/src/pdd';
import { normalizeDouyinMessage } from '../packages/platforms/src/douyin';
import { normalizeDouyinQuery } from '../packages/platforms/src/douyin/queries';
import { douyinVideoMaterials } from './fixtures-douyin-query';
import { executeOrderRemark } from '../packages/platforms/src/pdd/order-remark';
import { availableOperations } from '../packages/contracts/src/platform-operations';
import { commerceToolkit } from '../packages/ai/src/commerce-toolkit';
import { uid } from '../packages/core/src/util';
let f: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await f?.cleanup();
});
const caps = {
  receive: true,
  sendText: true,
  sendImage: true,
  goods: true,
  orders: true,
  history: true,
  verified: true,
  markRead: true,
  sendVideo: true,
  sendProductCard: true,
  videoMaterials: true,
  orderRemark: true,
  staffGroups: true,
  quickActions: true,
};
async function init() {
  f = await setup();
  await f.db.store.update({ where: { id: f.account.storeId }, data: { platform: 'douyin' } });
  await f.db.account.update({ where: { id: f.account.id }, data: { capabilities: caps } });
  const message = await f.engine.ingest(f.inbound('这款有视频吗'));
  const service = new WorkbenchService(f.engine);
  const ctx = await service.context(message.conversationId);
  f.host.query = vi.fn(async (_account, operation, input) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    subjectId:
      operation === 'buyer-orders' || operation === 'order-remark-state' ? 'buyer-a' : undefined,
    data:
      operation === 'goods'
        ? { products: [{ goodsId: '123456', title: '安装演示椅' }] }
        : operation === 'video-materials'
          ? {
              materials: [
                {
                  kind: 'video',
                  materialId: 'video-1',
                  title: '安装教程',
                  videoId: 'vid-1',
                  coverUrl: 'https://a.byteimg.com/cover.jpg',
                  width: 1280,
                  height: 720,
                  duration: 12,
                  sendable: true,
                },
              ],
            }
          : operation === 'staff-groups'
            ? { groups: [{ id: 'group-1', name: '售后组' }] }
            : operation === 'buyer-orders'
              ? { orders: [{ orderSn: '123456789' }] }
              : { remark: '加固包装', tag: 4, tagName: '4' },
  }));
  return { service, ctx, message };
}
it('邀请评价仅在抖店可用，客服组保持人工，移除平台话术入口', () => {
  expect(availableOperations('pinduoduo', caps)).toContain('send-video');
  expect(availableOperations('pinduoduo', caps)).not.toContain('send-product-card');
  expect(availableOperations('pinduoduo', caps)).not.toContain('invite-review');
  expect(availableOperations('douyin', caps)).toContain('invite-review');
  expect(availableOperations('douyin', caps)).not.toContain('platform-replies');
  expect(availableOperations('douyin', caps)).toContain('send-product-card');
  expect(availableOperations('douyin', { ...caps, sendVideo: false })).not.toContain('send-video');
  expect(commerceToolkit.manifest.members.map((m) => m.id)).toEqual(
    expect.arrayContaining([
      'send-video',
      'send-product-card',
      'video-materials',
      'order-remark-state',
      'invite-review',
    ]),
  );
  expect(commerceToolkit.manifest.members.map((m) => m.id)).not.toEqual(
    expect.arrayContaining(['platform-replies']),
  );
  expect(commerceToolkit.manifest.members.map((m) => m.id)).not.toContain('staff-groups');
});
it('商品卡片通过持久化队列异步发送，不切换接待，重复请求只发送一次并保留富消息', async () => {
  const { service, ctx } = await init();
  const before = await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } });
  const query: any = await service.query(ctx.sessionId, 'goods', { keyword: '椅' });
  expect(f.host.query).toHaveBeenCalledWith(
    f.account.id,
    'goods',
    expect.objectContaining({ keyword: '椅', buyerId: 'buyer-a' }),
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const send = f.host.send;
  f.host.send = async (c) => {
    await gate;
    return send(c);
  };
  const input = {
    sessionId: ctx.sessionId,
    requestId: uid(),
    operation: 'send-product-card' as const,
    input: { productRef: query.data.products[0].productRef },
  };
  const result: any = await service.action(input);
  expect(result.status).toBe('queued');
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
  const same: any = await service.action(input);
  expect(same.outboundId).toBe(result.outboundId);
  release();
  await waitFor(
    async () =>
      (await f.db.outboundMessage.findUnique({ where: { id: result.outboundId } }))?.status ===
      'confirmed',
  );
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]).toMatchObject({
    kind: 'product_card',
    accountId: f.account.id,
    buyerId: 'buyer-a',
    richContent: { goodsId: '123456' },
  });
  expect(
    await f.db.message.findFirst({ where: { externalId: `sent-${result.outboundId}` } }),
  ).toMatchObject({ kind: 'product_card', raw: { richContent: { goodsId: '123456' } } });
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
});
it('视频引用过期、其他买家引用及任意素材地址均不能发送', async () => {
  const { service, ctx } = await init();
  const q: any = await service.query(ctx.sessionId, 'video-materials', {});
  const other = await f.engine.ingest(
    f.inbound('其他客户', { buyerId: 'buyer-b', conversationKey: 'buyer:buyer-b' }),
  );
  const otherCtx = await service.context(other.conversationId);
  await expect(
    service.action({
      sessionId: otherCtx.sessionId,
      requestId: uid(),
      operation: 'send-video',
      input: { materialRef: q.data.materials[0].materialRef },
    }),
  ).rejects.toThrow('不属于');
  await f.db.platformEvidence.update({
    where: { id: q.evidenceRef },
    data: { observedAt: new Date(Date.now() - 6 * 60000) },
  });
  await expect(
    service.action({
      sessionId: ctx.sessionId,
      requestId: uid(),
      operation: 'send-video',
      input: { materialRef: q.data.materials[0].materialRef },
    }),
  ).rejects.toThrow('过期');
  expect(f.sends).toHaveLength(0);
});
it('按视频元数据归一化，缺少播放链接可以发送已有飞鸽视频，未知列表不假报空', () => {
  const result = normalizeExtraQuery(
    'video-materials',
    {
      materials: [
        {
          id: '1',
          name: '教程',
          video_info: {
            videoId: 'v1',
            width: 1280,
            height: 720,
            coverURL: 'https://p.byteimg.com/c.jpg',
            duration: 3,
          },
        },
      ],
    },
    { page: 1, pageSize: 10 },
    'buyer',
    'douyin',
  );
  expect((result!.data.materials as any[])[0]).toMatchObject({ sendable: true, videoId: 'v1' });
  expect(() =>
    normalizeExtraQuery(
      'video-materials',
      { unexpected: [] },
      { page: 1, pageSize: 10 },
      'buyer',
      'pinduoduo',
    ),
  ).toThrow('格式');
  const incomplete = normalizeExtraQuery(
    'video-materials',
    { files: [{ id: '1', name: '坏链接', url: 'https://untrusted.example/file.mp4' }] },
    { page: 1, pageSize: 10 },
    'buyer',
    'pinduoduo',
  );
  expect((incomplete!.data.materials as any[])[0]).toMatchObject({ sendable: false });
});
it('真实飞鸽素材结构通过工作台引用进入视频发送队列，保持店铺买家范围与完整元数据', async () => {
  const { service, ctx } = await init();
  const before = await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } });
  f.host.query = vi.fn(async (_account, operation, input) => {
    const { buyerId, conversationKey, platformContext, ...params } = input;
    return normalizeDouyinQuery(operation, douyinVideoMaterials, params, String(buyerId));
  });
  const query: any = await service.query(ctx.sessionId, 'video-materials', {});
  const material = (query.data.materials as any[])[0];
  const result: any = await service.action({
    sessionId: ctx.sessionId,
    requestId: uid(),
    operation: 'send-video',
    input: { materialRef: material.materialRef },
  });
  expect(result.status).toBe('queued');
  await waitFor(async () => f.sends.length === 1);
  expect(f.sends[0]).toMatchObject({
    kind: 'video',
    accountId: f.account.id,
    buyerId: 'buyer-a',
    richContent: {
      videoId: 'fixture-video-id',
      materialId: '7650740519126992135',
      width: 1440,
      height: 1080,
      duration: 7.848,
      coverUrl: 'https://p3-shop-material-center-sign.byteimg.com/fixture.jpeg?signature=fixture',
    },
  });
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
});
it('两平台视频接收保留可预览资料，文字中的视频链接不变成视频消息', () => {
  const raw = {
    msg_id: 'm',
    from: { uid: 'u', role: 'user' },
    to: { uid: 's', role: 'mall' },
    ts: Date.now(),
    type: 9,
    content: JSON.stringify({ video_url: 'https://video.pddpic.com/a.mp4' }),
  };
  expect(normalizePddMessage('a', raw)).toMatchObject({
    kind: 'video',
    richContent: { url: 'https://video.pddpic.com/a.mp4' },
  });
  expect(normalizePddMessage('a', { ...raw, type: 0 })?.kind).toBe('text');
  expect(
    normalizeDouyinMessage('a', {
      messageId: 'm',
      conversationId: 'c',
      buyerId: 'u',
      buyerName: '客户',
      direction: 'in',
      kind: 'video',
      text: '[视频]',
      timestamp: new Date().toISOString(),
      platformContext: {},
      richContent: { videoId: 'v', url: 'https://video.douyincdn.com/a.mp4' },
    }),
  ).toMatchObject({ kind: 'video', richContent: { videoId: 'v' } });
});
it.each(['pinduoduo', 'douyin'])(
  '%s 查看会话和查看期间的新消息同步平台已读，不接管 AI',
  async (platform) => {
    const { ctx } = await init();
    await f.db.store.update({ where: { id: f.account.storeId }, data: { platform } });
    f.host.markRead = vi.fn(async () => ({ ok: true }));
    await f.engine.setOpened(ctx.conversationId);
    await waitFor(async () => (f.host.markRead as any).mock.calls.length > 0);
    expect(f.host.markRead).toHaveBeenCalledWith(
      f.account.id,
      expect.objectContaining({ buyerId: 'buyer-a', messageIds: expect.any(Array) }),
    );
    expect(
      (await f.db.conversation.findUnique({ where: { id: ctx.conversationId } }))?.openedByHuman,
    ).toBe(false);
    const count = (f.host.markRead as any).mock.calls.length;
    await f.engine.ingest(f.inbound('还有吗'));
    await waitFor(async () => (f.host.markRead as any).mock.calls.length > count);
  },
);
it('查看备注只接受当前买家订单引用，实际请求使用已核验订单号', async () => {
  const { service, ctx } = await init();
  const q: any = await service.query(ctx.sessionId, 'buyer-orders', {});
  const r: any = await service.query(ctx.sessionId, 'order-remark-state', {
    orderRef: q.data.orders[0].orderRef,
  });
  expect(r.data.remark).toBe('加固包装');
  expect(f.host.query).toHaveBeenLastCalledWith(
    f.account.id,
    'order-remark-state',
    expect.objectContaining({ orderSn: '123456789', buyerId: 'buyer-a' }),
  );
});
it('抖店备注保留星标，写后读回，读不到完整星标时不写入', async () => {
  let state = { remark: '旧备注', tag: 4, tagName: '4' },
    writes = 0;
  const command = {
    id: uid(),
    accountId: 'a',
    buyerId: 'u',
    orderSn: '123456',
    page: 1,
    pageSize: 10,
    note: '加固包装',
  };
  const io = {
    ownsOrder: async () => true,
    read: async () => ({ ...state }),
    authorize: async () => {},
    write: async (next: typeof state) => {
      writes++;
      state = next;
      return { code: 0 };
    },
  };
  expect(
    await executeOrderRemark(command, io, {
      name: '抖店',
      rejected: () => false,
      failureReason: () => '',
    }),
  ).toMatchObject({ status: 'confirmed' });
  expect(state).toEqual({ remark: '旧备注\n加固包装', tag: 4, tagName: '4' });
  expect(
    await executeOrderRemark(
      { ...command, id: uid() },
      {
        ...io,
        read: async () => {
          throw new Error('星标缺失');
        },
      },
    ),
  ).toMatchObject({ status: 'rejected' });
  expect(writes).toBe(1);
});
it('分组转接使用当前会话并持久化未知结果，不能自动重试，人工核对后可继续', async () => {
  const { service, ctx } = await init();
  const q: any = await service.query(ctx.sessionId, 'staff-groups', {});
  f.host.executeQuickAction = vi.fn(async (command, authorize) => {
    expect(
      await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
    ).toMatchObject({
      openedByHuman: true,
    });
    await authorize({
      operation: command.operation,
      buyerId: command.buyerId,
      conversationKey: command.conversationKey,
      targetId: command.targetId,
    });
    return { status: 'unknown' as const, reasonCode: 'receipt_missing', message: '请核对原平台' };
  });
  const input = {
    sessionId: ctx.sessionId,
    requestId: uid(),
    operation: 'transfer-group' as const,
    input: { groupRef: q.data.groups[0].groupRef, note: '' },
  };
  const result: any = await service.action(input);
  expect(result.status).toBe('unknown');
  expect(await service.action(input)).toMatchObject({
    actionId: result.actionId,
    status: 'unknown',
  });
  await expect(service.action({ ...input, requestId: uid() })).rejects.toThrow('核对');
  expect(f.host.executeQuickAction).toHaveBeenCalledTimes(1);
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ).toMatchObject({
    openedByHuman: true,
    awaitingHuman: true,
  });
  await service.review(result.actionId, '已在平台确认接待人');
});
it('邀请评价使用订单引用进入发送队列，同一订单确认后也不重复邀请', async () => {
  const { service, ctx } = await init();
  const before = await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } });
  const q: any = await service.query(ctx.sessionId, 'buyer-orders', {});
  const input = {
    sessionId: ctx.sessionId,
    requestId: uid(),
    operation: 'invite-review' as const,
    input: { orderRef: q.data.orders[0].orderRef },
  };
  const result: any = await service.action(input);
  expect(result.status).toBe('queued');
  await waitFor(
    async () =>
      (await f.db.outboundMessage.findUnique({ where: { id: result.outboundId } }))?.status ===
      'confirmed',
  );
  const again: any = await service.action({ ...input, requestId: uid() });
  expect(again).toMatchObject({ status: 'confirmed', outboundId: result.outboundId });
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]).toMatchObject({
    kind: 'review_card',
    buyerId: 'buyer-a',
    richContent: { orderSn: '123456789' },
  });
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
});

it('邀请下单只执行当前商品操作，不接管会话，重复请求不重发', async () => {
  const { service, ctx } = await init();
  const before = await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } });
  const query: any = await service.query(ctx.sessionId, 'goods', {});
  f.host.executeQuickAction = vi.fn(async (command, authorize) => {
    await authorize({
      operation: command.operation,
      buyerId: command.buyerId,
      conversationKey: command.conversationKey,
      targetId: command.targetId,
    });
    return { status: 'confirmed' as const, reasonCode: 'fixture_receipt', message: '平台已确认' };
  });
  const input = {
    sessionId: ctx.sessionId,
    requestId: uid(),
    operation: 'invite-order' as const,
    input: { productRef: query.data.products[0].productRef },
  };
  const first: any = await service.action(input);
  expect(first.status).toBe('confirmed');
  expect(await service.action(input)).toMatchObject({
    status: 'confirmed',
    actionId: first.actionId,
  });
  expect(f.host.executeQuickAction).toHaveBeenCalledTimes(1);
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ).toMatchObject({
    openedByHuman: false,
    awaitingHuman: false,
    revision: before.revision,
  });
  expect(await f.db.auditEvent.count({ where: { type: 'conversation.reception' } })).toBe(0);
});
it('邀请评价拒绝其他买家、过期的订单引用和未挂载的平台能力', async () => {
  const { service, ctx } = await init();
  const q: any = await service.query(ctx.sessionId, 'buyer-orders', {});
  const other = await f.engine.ingest(
    f.inbound('另一买家', { buyerId: 'buyer-b', conversationKey: 'buyer:buyer-b' }),
  );
  const otherCtx = await service.context(other.conversationId);
  const input = {
    sessionId: otherCtx.sessionId,
    requestId: uid(),
    operation: 'invite-review' as const,
    input: { orderRef: q.data.orders[0].orderRef },
  };
  await expect(service.action(input)).rejects.toThrow('不属于');
  await f.db.platformEvidence.update({
    where: { id: q.evidenceRef },
    data: { observedAt: new Date(Date.now() - 6 * 60000) },
  });
  await expect(
    service.action({ ...input, sessionId: ctx.sessionId, requestId: uid() }),
  ).rejects.toThrow('过期');
  await f.db.account.update({
    where: { id: ctx.accountId },
    data: { capabilities: { ...caps, quickActions: false } },
  });
  await expect(
    service.action({ ...input, sessionId: ctx.sessionId, requestId: uid() }),
  ).rejects.toThrow();
  expect(f.sends).toHaveLength(0);
});
