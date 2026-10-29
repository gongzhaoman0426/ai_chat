import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { kuaishouPageScript, kuaishouOrders, kuaishouGoods } from './fixtures-kuaishou';
import { normalizeKuaishouMessage } from '../packages/platforms/src/kuaishou';
import { normalizeKuaishouQuery } from '../packages/platforms/src/kuaishou/queries';
import { normalizeStaff, transferResult } from '../packages/platforms/src/staff';
const script = await readFile('resources/kuaishou-bridge.js', 'utf8');
const scope = {
  buyerId: '200',
  conversationKey: '0_200',
  platformContext: { sessionType: 0, userId: '200', sellerId: '100' },
};
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
async function fixture(start = true, sdkInIframe = false) {
  const window: any = {};
  const sdkWindow: any = sdkInIframe ? {} : window;
  runInNewContext(kuaishouPageScript, { window: sdkWindow, Date, Promise });
  const f = sdkWindow.__fixture;
  f.orders = kuaishouOrders;
  f.goods = kuaishouGoods;
  if (sdkInIframe) {
    window.document = {
      getElementById: () => ({ contentWindow: sdkWindow }),
      querySelectorAll: () => [],
    };
  }
  window.fetch = sdkWindow.fetch;
  const inject = () =>
    runInNewContext(script, {
      window,
      document: window.document,
      fetch: window.fetch,
      AbortSignal,
      URL,
      Date,
      BigInt,
      setTimeout,
      clearTimeout,
      Promise,
    });
  inject();
  const b = window.__judeskBridge;
  if (start) {
    await b.identity();
    b.poll();
    await tick();
  }
  return { b, f, window, inject };
}
it('SDK 缺席时身份仍可识别，正确分离店铺和客服，登录失败/切换/精度丢失都不误注册', async () => {
  const { b, f, window } = await fixture(false);
  delete window.webpackChunkkwaishop_seller_cs_main;
  expect(await b.identity()).toEqual({
    mallId: '100',
    externalId: '101',
    mallName: '快手验收店',
    name: '快手客服',
  });
  expect(b.poll().attached).toBe(false);
  f.signedIn = false;
  await expect(b.identity()).rejects.toThrow('尚未登录');
  f.signedIn = true;
  f.response.data.shopId = '999';
  await expect(b.identity()).rejects.toThrow('身份已改变');
  f.response.data.shopId = Number('90071992547409931');
  await expect(b.identity()).rejects.toThrow('店铺和客服身份');
});
it('初始化等待真正 IM 就绪，断线停止能力，SDK 替换后只留一个监听', async () => {
  const { b, f, inject } = await fixture();
  expect(b.poll()).toMatchObject({
    attached: true,
    capabilities: { sendText: true, orders: true, goods: true, sendProductCard: true },
  });
  inject();
  f.im.isConnected = false;
  expect(b.poll()).toMatchObject({
    attached: false,
    capabilities: { receive: false, sendText: false },
  });
  f.im.isConnected = true;
  f.module.singleton = { ...f.sdk };
  b.poll();
  await tick();
  f.emit(f.message());
  await tick();
  expect(b.poll().events.filter((e: any) => e.type === 'message')).toHaveLength(1);
  b.dispose();
  f.emit(f.message('9002'));
  await tick();
  expect(b.queue).toHaveLength(1);
});
it('快手主页面通过同源隐藏 chat-sdk iframe 提供 SDK 时也能接入', async () => {
  const { b, f } = await fixture(true, true);
  expect(b.poll()).toMatchObject({
    attached: true,
    capabilities: { receive: true, sendText: true, orders: true },
  });
  f.emit(f.message('9050'));
  await tick();
  expect(b.poll().events[0].message).toMatchObject({ messageId: '9050', direction: 'in' });
});
it('线上 msgId 为 0 时使用 seqId 作为消息唯一标识', async () => {
  const { b, f } = await fixture();
  f.emit(
    f.message('0', '线上消息', { seqId: '1789163155389023', clientSeqId: '17891896361105700' }),
  );
  await tick();
  expect(b.poll().events[0].message).toMatchObject({
    messageId: '1789163155389023',
    direction: 'in',
    text: '线上消息',
  });
});
it('只将实时买家推送触发回复，历史/重复/无服务器确认/其他店铺及不明发送方被隔离', async () => {
  const { b, f } = await fixture();
  f.emit(f.message());
  f.emit(f.message());
  f.emit(f.message('9002', '历史'), 'insert', 'sync');
  f.emit(f.message('9003', '未知', { fromUserId: '555' }));
  f.emit(f.message('9004', '待发送', { state: 1 }));
  await tick();
  const events = b.poll().events;
  expect(events).toHaveLength(2);
  expect(events[0].message).toMatchObject({
    historical: false,
    direction: 'in',
    messageId: '9001',
  });
  expect(events[1].message.historical).toBe(true);
  expect(normalizeKuaishouMessage('account', events[0].message)).toMatchObject({
    platformContext: scope.platformContext,
    origin: 'buyer',
  });
  expect(normalizeKuaishouMessage('account', { ...events[0].message, buyerId: '999' })).toBeNull();
  f.sdk.store.state.loginUserInfo.belongShopId = '999';
  f.emit(f.message('9005'));
  await tick();
  expect(b.queue).toHaveLength(2);
  b.ack(events[1].sequence);
  expect(b.queue).toHaveLength(0);
});
it('平台系统事件不伪装成人工回复，也不产生可回复文本', async () => {
  const { b, f } = await fixture();
  f.emit(f.message('9011', '', { contentType: 2, fromUserId: '100', toUserId: '200' }));
  await tick();
  const event = b.poll().events.find((e: any) => e.type === 'message');
  expect(event.message).toMatchObject({ kind: 'system', text: '[快手平台消息]', direction: 'out' });
  expect(normalizeKuaishouMessage('account', event.message)).toMatchObject({
    kind: 'system',
    origin: 'unknown',
  });
});
it('文本发送关联平台 msgId，重复命令不重复提交，回显不误计为人工回复', async () => {
  const { b, f } = await fixture();
  const command = { id: 'outbound-1', ...scope, kind: 'text', text: '您好' };
  const result = await b.send(command);
  await tick();
  expect(result).toMatchObject({ status: 'confirmed', externalId: '1002' });
  expect(await b.send(command)).toEqual(result);
  expect(f.sends).toHaveLength(1);
  expect(b.queue).toEqual([
    expect.objectContaining({ type: 'confirmed', outboundId: command.id, externalId: '1002' }),
  ]);
  const bad = await b.send({ ...command, id: 'outbound-bad', buyerId: '300' });
  expect(bad.status).toBe('rejected');
  expect(f.sends).toHaveLength(1);
});
it('线上发送确认 msgId 为 0 时用 seqId；克隆事件也能按 clientSeqId 关联', async () => {
  const { b, f } = await fixture();
  f.sendMode = 'void';
  const command = { id: 'seq-receipt', ...scope, kind: 'text', text: '在的' };
  const task = b.send(command);
  await tick();
  const sent = f.sends[0];
  expect(sent.clientSeqId).toBeTruthy();
  // 真机常见：messagesUpdate 推送克隆对象，msgId=0，真实 ID 在 seqId。
  const clone = {
    ...sent,
    rawMsg: {
      ...sent,
      state: 4,
      msgId: '0',
      seqId: '1789163155389023',
      clientSeqId: sent.clientSeqId,
      fromUserId: '101', // 与 pending 里 loginImId=100 不同，模拟身份字段漂移
    },
    state: 4,
    msgId: '0',
    seqId: '1789163155389023',
    clientSeqId: sent.clientSeqId,
    fromUserId: '101',
    sessionId: '0_200',
  };
  f.emit(clone, 'update', 'update');
  await tick();
  expect(await task).toMatchObject({ status: 'confirmed', externalId: '1789163155389023' });
  expect(b.sends.get(command.id)).toMatchObject({
    status: 'confirmed',
    externalId: '1789163155389023',
  });
});
it('空返回或网络错误不伪报成功，超时不重发，晚到的精确回执仍可确认', async () => {
  vi.useFakeTimers();
  const { b, f } = await fixture();
  f.sendMode = 'void';
  const command = { id: 'late', ...scope, kind: 'text', text: '您好' };
  const task = b.send(command);
  await tick();
  await vi.advanceTimersByTimeAsync(12001);
  expect((await task).status).toBe('unknown');
  expect((await b.send(command)).status).toBe('unknown');
  f.emit(
    f.message('9100', '其他人工消息', { fromUserId: '100', clientSeqId: '99999' }),
    'update',
    'update',
  );
  expect(b.sends.get('late').status).toBe('unknown');
  Object.assign(f.sends[0], { msgId: '9101', state: 4 });
  f.emit(f.sends[0], 'update', 'update');
  await tick();
  expect(b.sends.get('late')).toMatchObject({ status: 'confirmed', externalId: '9101' });
  expect(f.sends).toHaveLength(1);
});
it('图片消息解析 ks 资源，历史真正按游标分页且不产生新消息，已读使用精确会话', async () => {
  const { b, f } = await fixture();
  f.emit(f.message('9010', '', { contentType: 1, url: 'ks://image' }));
  await tick();
  expect(b.queue[0].message).toMatchObject({
    kind: 'image',
    imageUrl: 'https://static.yximgs.com/fixture.png',
  });
  const result = await b.query('history', { ...scope, pageSize: 10, cursor: '' });
  expect(result.messages[0]).toMatchObject({ historical: true, text: '历史咨询' });
  expect(f.historyArgs.slice(1)).toEqual([
    '9223372036854775807',
    true,
    10,
    false,
    false,
    'preload',
  ]);
  expect(b.queue).toHaveLength(1);
  await b.markRead(scope);
  expect(f.read).toEqual(['0_200']);
});
it('商品列表与浏览足迹走可序列化查询，并支持预发后发送商品卡片', async () => {
  const { b, f } = await fixture();
  expect(b.poll().capabilities).toMatchObject({
    goods: true,
    sendProductCard: true,
    operations: expect.arrayContaining(['goods', 'buyer-footprint', 'send-product-card']),
  });
  const raw = await b.query('goods', { ...scope, page: 1, pageSize: 10, keyword: '水杯' });
  expect(f.queries).toContainEqual(
    expect.objectContaining({
      path: '/gateway/business/cs/list/item/info',
      args: {
        buyerId: '200',
        limit: 10,
        offset: 0,
        viewTab: 1,
        searchKeyword: '水杯',
      },
    }),
  );
  await b.query('buyer-footprint', { ...scope, page: 1, pageSize: 10 });
  expect(f.queries).toContainEqual(
    expect.objectContaining({
      path: '/gateway/business/cs/list/item/info',
      args: expect.objectContaining({ viewTab: 2, buyerId: '200' }),
    }),
  );
  const result: any = normalizeKuaishouQuery('goods', raw, { page: 1, pageSize: 10 }, '200');
  expect(result.subjectId).toBeUndefined();
  expect(result.data.products[0]).toMatchObject({
    goodsId: '26953364011874',
    title: '快手测试水杯',
    priceText: '¥25.00',
    imageUrl: 'https://static.yximgs.com/fixture.png',
  });
  const footprintRaw = await b.query('buyer-footprint', { ...scope, page: 1, pageSize: 10 });
  expect(
    normalizeKuaishouQuery('buyer-footprint', footprintRaw, { page: 1, pageSize: 10 }, '200')
      .subjectId,
  ).toBe('200');
  const command = {
    id: 'goods-card-1',
    ...scope,
    kind: 'product_card',
    richContent: { kind: 'product_card', goodsId: '26953364011874' },
  };
  const sent = await b.send(command);
  expect(sent).toMatchObject({ status: 'confirmed' });
  expect(f.commodityCreates[0]).toMatchObject({
    dry: true,
    args: {
      targetId: '200',
      targetType: 0,
      content: expect.objectContaining({ itemId: '26953364011874' }),
    },
  });
  expect(f.queries).toContainEqual(
    expect.objectContaining({
      path: '/rest/app/tts/cs/card/preSendCommodity',
      args: { targetId: '200', commodityId: '26953364011874' },
    }),
  );
  expect(f.sends[0]).toMatchObject({ contentType: 2000, targetId: '200' });
});
it('订单/人员/客服组使用真实 SDK 方法与参数，业务失败不显示空列表，转接无回执不报成功', async () => {
  const { b, f } = await fixture();
  const raw = await b.query('buyer-orders', { ...scope, page: 2, pageSize: 10, keyword: '水杯' });
  expect(f.queries[0]).toMatchObject({
    path: '/gateway/business/cs/order/list',
    args: { buyerId: '200', offset: 10, limit: 10, itemTitle: '水杯', searchCondition: null },
  });
  const result: any = normalizeKuaishouQuery('buyer-orders', raw, {}, '200');
  expect(result.data.orders[0]).toMatchObject({
    orderSn: '90071992547409931',
    amountText: '¥25.00',
    goods: { title: '快手测试水杯' },
  });
  expect(() =>
    normalizeKuaishouQuery('buyer-orders', { result: 1, data: { total: 0 } }, {}, '200'),
  ).toThrow('缺少');
  expect(() =>
    normalizeKuaishouQuery('buyer-orders', { result: 401, error_msg: '登录过期' }, {}, '200'),
  ).toThrow('登录过期');
  expect(normalizeStaff('kuaishou', await b.staff(), '101')).toEqual([
    { id: '102', name: '售后客服', statusText: '在线' },
  ]);
  const transfer = await b.transfer({ ...scope, targetStaffId: '102', note: '售后问题' });
  expect(transferResult('kuaishou', transfer).status).toBe('confirmed');
  expect(f.transfers[0]).toMatchObject({
    sellerId: '100',
    buyerIds: ['200'],
    allocationUserId: '102',
    message: '售后问题',
  });
  f.transferResponse = { result: 1, data: [] };
  expect(
    (await b.quickAction({ ...scope, operation: 'transfer-group', targetId: '301', note: '' }))
      .status,
  ).toBe('unknown');
  await expect(b.transfer({ ...scope, targetStaffId: '900' })).rejects.toThrow('列表');
});
