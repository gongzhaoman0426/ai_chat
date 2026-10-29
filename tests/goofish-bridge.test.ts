import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { normalizeGoofishMessage } from '../packages/platforms/src/goofish';
import { normalizeGoofishQuery } from '../packages/platforms/src/goofish/queries';
const script = await readFile('resources/goofish-bridge.js', 'utf8');
const active: any[] = [];
afterEach(() => {
  for (const f of active) f.bridge.dispose();
  active.length = 0;
});
const testOrderId = '4951116036319758915';
function orderHead(orderId: string | undefined = testOrderId) {
  return {
    commonData: {
      itemId: '300',
      ...(orderId ? { orderId } : {}),
      seller: 'true',
      supportPCTrade: 'true',
      utArgs: { orderStatusName: '宝贝已发出，买家还没确认收货', orderStatus: '3' },
    },
    left: { data: { picUrl: 'https://img.alicdn.com/item.png' } },
    middle: { data: { title: '测试商品', price: '0.01' } },
    right: { data: {} },
  };
}
function componentOrder(orderId = testOrderId, amount: unknown = '0.01') {
  return {
    itemId: '300',
    orderId,
    peerUserId: '200',
    seller: 'true',
    components: [
      { render: 'orderStatusVO', data: { orderStatusInfo: { title: '等待买家确认收货' } } },
      {
        render: 'orderInfoVO',
        data: {
          itemInfo: { title: '测试商品' },
          priceInfo: { amount: { title: '成交价', value: amount } },
          orderInfoList: [{ title: '订单编号', value: orderId, copyable: 'true' }],
        },
      },
    ],
  };
}
async function fixture(login: Record<string, any> = {}) {
  // Sanitized structures from the public xy-site 0.0.174 SDK, not real customer/order records.
  const identity = { userId: '101', mainUserId: '100', nick: '测试卖家', ...login };
  const conversation = {
    sessionId: '9001',
    sessionType: 1,
    ownerInfo: { userId: '100' },
    userInfo: { userId: '200' },
    itemInfo: { itemId: '300', sellerInfo: { userId: '100' } },
  };
  const store = { convMap: new Map([[conversation.sessionId, conversation]]) };
  const messageListeners = new Set<any>(),
    eventListeners = new Set<any>();
  const register = vi.fn((fn: any) => {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  });
  const events = { register };
  const sendMessage = vi.fn(async (_message: any): Promise<any> => undefined);
  const getMessageById = vi.fn(async (_id: string): Promise<any> => ({ data: undefined }));
  const updateMessageToRead = vi.fn(async () => undefined);
  const messages = { sendMessage, getMessageById, updateMessageToRead };
  const listPrevMsgs = vi.fn(
    async (..._args: any[]): Promise<any> => ({
      userMessageModels: [],
      hasMore: false,
      nextCursor: '123',
    }),
  );
  const lowMessages = { listPrevMsgs };
  const getConversation = vi.fn(async () => ({}));
  const client = {
    getEventService: () => events,
    getMsgService: () => lowMessages,
    getConvService: () => ({ getConversation }),
    getAuthService: () => ({}),
  };
  const sdk = {
    getUserId: () => identity.userId,
    getStore: () => store,
    getMessageServiceSync: () => messages,
    getConnectionStatus: () => 4,
    registerMessageChangeLisnter: vi.fn(async (listener: any) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    }),
  };
  const api = vi.fn(async (request: any): Promise<any> => {
    const data =
      request.api === 'mtop.taobao.idlemessage.pc.loginuser.get'
        ? identity
        : request.api === 'mtop.taobao.idlemessage.pc.user.query'
          ? { userInfo: { fishNick: '测试买家', logo: 'https://img.alicdn.com/buyer.png' } }
          : request.api === 'mtop.idle.trade.pc.message.headinfo'
            ? orderHead()
            : request.api === 'mtop.idle.trade.message.chat.tradeinfo'
              ? {
                  module: {
                    items: [{ commonData: { itemId: '300', orderId: '4951116036319758915' } }],
                  },
                }
              : request.api === 'mtop.idle.web.trade.order.detail'
                ? {
                    commonData: {
                      orderId: '4951116036319758915',
                      buyerId: '200',
                      sellerId: '100',
                      itemId: '300',
                    },
                    statusText: '待发货',
                    button: { api: 'mtop.taobao.idle.logistic.consign.dummy' },
                  }
                : request.api === 'mtop.taobao.idlemessage.pc.tool.item.search'
                  ? {
                      items: [{ itemId: '300', title: '商品', reservePrice: '12.00' }],
                      nextPage: false,
                    }
                  : {};
    return { ret: ['SUCCESS::调用成功'], data };
  });
  const modules: any = {
    sdkFactory: function () {
      return 'registerMessageChangeLisnter getMessageServiceSync';
    },
    clientFactory: function () {
      return 'PaaSMessageChange getEventService getAuthService';
    },
  };
  const require: any = (id: string) =>
    id === 'sdkFactory' ? { renamed: sdk } : id === 'clientFactory' ? { newExport: client } : {};
  require.m = modules;
  require.c = {};
  const chunk = { push: vi.fn((entry: any) => entry[2](require)) };
  const fetch = vi.fn(
    async (..._args: any[]): Promise<any> => ({
      ok: true,
      json: async () => ({
        success: true,
        object: { url: 'https://img.alicdn.com/test.png', pix: '20x30' },
      }),
    }),
  );
  const sandbox: any = {
    Date,
    URL,
    Map,
    Set,
    File,
    FormData,
    Uint8Array,
    TextDecoder,
    atob,
    fetch,
    navigator: { onLine: true },
    lib: { mtop: { request: api } },
    webpackChunk_changed_name: chunk,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 12000 ? 35 : ms),
    clearTimeout,
  };
  sandbox.window = sandbox;
  runInNewContext(script, sandbox);
  const bridge = sandbox.__judeskBridge;
  await bridge.identity();
  await Promise.resolve();
  const command = {
    id: 'outbound-1',
    accountId: 'local-account',
    buyerId: '200',
    conversationKey: '9001',
    kind: 'text',
    text: '您好',
    token: 'test',
  };
  const message = (overrides: any = {}) => ({
    messageId: '8001',
    sessionId: '9001',
    senderInfo: { userId: '200' },
    content: { contentType: 1, text: { text: '在吗' } },
    timeStamp: Date.now(),
    sendState: 0,
    messageStatus: 1,
    ...overrides,
  });
  const emit = async (m: any) => {
    for (const l of messageListeners) l.onAdd(m);
    await bridge.work;
  };
  const event = async (name: string, m: any) => {
    for (const l of eventListeners) l(name, m);
    await bridge.work;
  };
  const receipt = (overrides: any = {}) => ({
    cid: '9001',
    recordStatus: 1,
    extension: { extJson: JSON.stringify({ judeskOutboundId: command.id }) },
    messageModel: {
      cid: '9001',
      messageId: '999999999999999999',
      createAt: Date.now(),
      sender: { uid: '101@goofish' },
      content: {
        contentType: 101,
        custom: { data: JSON.stringify({ contentType: 1, text: { text: '您好' } }) },
      },
    },
    ...overrides,
  });
  const f = {
    bridge,
    identity,
    conversation,
    store,
    client,
    sdk,
    sandbox,
    api,
    command,
    message,
    emit,
    event,
    receipt,
    sendMessage,
    lowMessages,
    listPrevMsgs,
    getMessageById,
    updateMessageToRead,
    fetch,
    chunk,
  };
  active.push(f);
  return f;
}
describe('闲鱼 SDK 发现与账号隔离', () => {
  it('真实登录接口仅返回 userId 时也能注册个人卖家，后台查询不再次启动登录流程', async () => {
    const f = await fixture({
      mainUserId: undefined,
      nick: undefined,
      needDecryptKeys: [],
      needDecryptKeysV2: [],
    });
    expect(await f.bridge.identity()).toMatchObject({ externalId: '101', mallId: '101' });
    expect(f.api).toHaveBeenCalledWith(
      expect.objectContaining({
        api: 'mtop.taobao.idlemessage.pc.loginuser.get',
        needLogin: false,
        sessionOption: 'AutoLoginOnly',
        timeout: 10000,
      }),
    );
  });
  it('不依赖 .h 或数字模块 ID；重复注入只注册一次，可取消异步订阅', async () => {
    const f = await fixture();
    runInNewContext(script, f.sandbox);
    f.bridge.poll();
    expect(f.bridge.poll().attached).toBe(true);
    expect(f.sdk.registerMessageChangeLisnter).toHaveBeenCalledTimes(1);
    expect(f.chunk.push).toHaveBeenCalledTimes(1);
    expect(await f.bridge.identity()).toMatchObject({ externalId: '101', mallId: '100' });
    f.api.mockImplementationOnce(async () => ({
      ret: ['SUCCESS::调用成功'],
      data: { user: { uid: '101@goofish', nick: '嵌套卖家' }, mainUserId: 100 },
    }));
    expect(await f.bridge.identity()).toMatchObject({
      externalId: '101',
      mallId: '100',
      name: '嵌套卖家',
    });
    f.bridge.dispose();
    await f.emit(f.message());
    expect(f.bridge.poll().events).toEqual([]);
  });
  it('登录成功与 IM 在线分别检查', async () => {
    const f = await fixture();
    f.sdk.getConnectionStatus = () => 2;
    expect(f.bridge.poll()).toMatchObject({
      attached: false,
      capabilities: { receive: false, sendText: false },
    });
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'rejected' });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it('平台未登录与网络错误对象显示具体原因，不退化成 object Object', async () => {
    const f = await fixture();
    f.api.mockRejectedValueOnce({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'] });
    await expect(f.bridge.identity()).rejects.toThrow('闲鱼尚未登录');
    f.api.mockRejectedValueOnce({ ret: ['FAIL_SYS_TRAFFIC_LIMIT::请求过于频繁'] });
    await expect(f.bridge.identity()).rejects.toThrow('FAIL_SYS_TRAFFIC_LIMIT');
  });
  it('买方购买会话不会自动接待，不能发送到其他买家或切换后的身份', async () => {
    const f = await fixture();
    f.conversation.itemInfo.sellerInfo.userId = '200';
    await f.emit(f.message());
    expect(f.bridge.poll().events).toEqual([]);
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'rejected' });
    f.conversation.itemInfo.sellerInfo.userId = '100';
    expect(await f.bridge.send({ ...f.command, buyerId: '201' })).toMatchObject({
      status: 'rejected',
    });
    f.identity.userId = '999';
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'rejected' });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
describe('闲鱼消息归一化与发送确认', () => {
  it('稳定 ID 去重，保留 ACK 前的事件；历史、人工作答、图片不误分类', async () => {
    const f = await fixture();
    const msg = f.message();
    await f.emit(msg);
    await f.emit(msg);
    await f.emit(f.message({ messageId: '8002', senderInfo: { userId: '101' } }));
    await f.emit(f.message({ messageId: '8003', timeStamp: Date.now() - 60000 }));
    await f.emit(
      f.message({
        messageId: '8004',
        content: { contentType: 2, image: { pics: [{ url: 'https://img.alicdn.com/image.png' }] } },
      }),
    );
    const polled = f.bridge.poll();
    expect(polled.events).toHaveLength(4);
    const normalized = polled.events.map((e: any) =>
      normalizeGoofishMessage('local-account', e.message),
    );
    expect(normalized.map((m: any) => m.origin)).toEqual(['buyer', 'human', 'buyer', 'buyer']);
    expect(normalized[2].historical).toBe(true);
    expect(normalized[3].remoteImageUrl).toContain('alicdn.com');
    expect(f.bridge.poll().events).toHaveLength(4);
    f.bridge.ack(polled.events[3].sequence);
    expect(f.bridge.poll().events).toEqual([]);
  });
  it('本地发送中、降级仅自己可见、精度损失 ID 都不会成为客户消息', async () => {
    const f = await fixture();
    await f.emit(f.message({ sendState: 1 }));
    await f.emit(f.message({ messageStatus: 4 }));
    await f.emit(f.message({ messageId: Number('999999999999999999') }));
    expect(f.bridge.poll().events).toEqual([]);
  });
  it('sendMessage 返回空值和本地回显不能当作成功，也不会自动重试', async () => {
    const f = await fixture();
    f.sendMessage.mockImplementation(async (data) => {
      await f.emit(
        f.message({ senderInfo: { userId: '101' }, sendState: 1, extJson: data.extJson }),
      );
    });
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'unknown' });
    expect(f.bridge.poll().events).toEqual([]);
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'unknown' });
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('仅服务器回执与本次发送 ID、会话匹配才确认；晚到回执仍能修正未知状态', async () => {
    const f = await fixture();
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'unknown' });
    await f.event(
      'paas.message.changed',
      f.receipt({ messageModel: { ...f.receipt().messageModel, cid: '9002' }, cid: '9002' }),
    );
    expect(f.bridge.sends.get(f.command.id).status).toBe('unknown');
    await f.event('paas.message.changed', f.receipt());
    expect(f.bridge.sends.get(f.command.id)).toEqual({
      status: 'confirmed',
      externalId: '999999999999999999',
    });
    expect(f.bridge.poll().events).toHaveLength(1);
    expect(f.bridge.poll().events[0].outboundId).toBe(f.command.id);
  });
  it('服务端失败回执会使发送失败', async () => {
    const f = await fixture();
    f.sendMessage.mockImplementation(async () => {
      await f.event('paas.message.changed', f.receipt({ recordStatus: -1 }));
    });
    expect(await f.bridge.send(f.command)).toMatchObject({ status: 'rejected' });
  });
  it('图片上传后发送仍需真实回执；上传期间切换身份不发送', async () => {
    const f = await fixture();
    f.sendMessage.mockImplementation(async () => {
      await f.event('paas.message.changed', f.receipt());
    });
    const command = { ...f.command, kind: 'image', imageData: 'aW1hZ2U=', imageMime: 'image/png' };
    expect(await f.bridge.send(command)).toMatchObject({ status: 'confirmed' });
    expect(f.sendMessage.mock.calls[0][0].content).toMatchObject({
      contentType: 2,
      image: { pics: [{ width: 20, height: 30 }] },
    });
    const g = await fixture();
    g.fetch.mockImplementation(async () => {
      g.identity.userId = '999';
      return {
        ok: true,
        json: async () => ({
          success: true,
          object: { url: 'https://img.alicdn.com/test.png', pix: '1x1' },
        }),
      };
    });
    expect(await g.bridge.send(command)).toMatchObject({ status: 'rejected' });
    expect(g.sendMessage).not.toHaveBeenCalled();
  });
  it('明确打开会话才能标记对应消息已读', async () => {
    const f = await fixture();
    f.getMessageById.mockResolvedValue({ data: f.message() });
    expect(
      await f.bridge.markRead({ conversationKey: '9001', buyerId: '200', messageIds: ['8001'] }),
    ).toEqual({ updated: 1 });
    expect(f.updateMessageToRead).toHaveBeenCalledTimes(1);
    f.getMessageById.mockResolvedValue({ data: f.message({ sessionId: '9002' }) });
    await expect(
      f.bridge.markRead({ conversationKey: '9001', buyerId: '200', messageIds: ['8001'] }),
    ).rejects.toThrow('不属于');
  });
});
describe('闲鱼会话工具与交付', () => {
  it.each(['http://img.alicdn.com', '//img.alicdn.com', 'https://img.alicdn.com'])(
    '原生商品图片 %s 统一为 HTTPS，咨询、店铺列表、详情、关联商品均可显示',
    async (origin) => {
      const f = await fixture();
      const image = origin + '/item.jpg_200x200.jpg?quality=90';
      const expected = 'https://img.alicdn.com/item.jpg_200x200.jpg?quality=90';
      f.api.mockImplementation(async (request) => ({
        ret: ['SUCCESS::调用成功'],
        data: request.api.includes('loginuser')
          ? f.identity
          : request.api.includes('headinfo')
            ? {
                left: { data: { picUrl: image } },
                middle: { data: { subTitle: '咨询商品', price: '12.00' } },
              }
            : request.api.includes('item.search')
              ? { items: [{ itemId: '300', absoluteMajorPicture: image }], nextPage: false }
              : request.api === 'mtop.taobao.idle.pc.detail'
                ? {
                    itemDO: { itemId: '300', title: '商品详情', imageInfos: [{ url: image }] },
                    sellerDO: { sellerId: '100' },
                  }
                : { module: { items: [] } },
      }));
      for (const operation of [
        'conversation-item',
        'goods',
        'goods-detail',
        'buyer-footprint',
      ] as const) {
        const input =
          operation === 'goods-detail'
            ? { goodsId: '300' }
            : operation === 'conversation-item'
              ? {}
              : { page: 1, pageSize: 10 };
        const raw = await f.bridge.query(operation, {
          ...input,
          conversationKey: '9001',
          buyerId: '200',
        });
        const data = normalizeGoofishQuery(operation, raw, input, '200').data as any;
        expect((data.product ?? data.products[0]).imageUrl).toBe(expected);
      }
      expect(f.sendMessage).not.toHaveBeenCalled();
    },
  );
  it('无效主图不会遮住可用备用图，非平台地址或凭据 URL 不进入图片结果', async () => {
    const f = await fixture();
    const invalid = [
      'http://img.alicdn.com.evil.test/a.jpg',
      'https://evil.test/a.jpg',
      'https://user:pass@img.alicdn.com/a.jpg',
      'ftp://img.alicdn.com/a.jpg',
      'data:image/png;base64,abc',
      'javascript:alert(1)',
    ];
    const normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) =>
      request.api.includes('item.search')
        ? {
            ret: ['SUCCESS::调用成功'],
            data: {
              items: [
                {
                  itemId: '300',
                  mainPic: invalid[0],
                  absoluteMajorPicture: '//img.alicdn.com/valid.jpg',
                },
                ...invalid.map((mainPic, i) => ({ itemId: String(400 + i), mainPic })),
              ],
              nextPage: false,
            },
          }
        : normal(request),
    );
    const raw = await f.bridge.query('goods', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    const products = normalizeGoofishQuery('goods', raw, {}, '200').data.products as any[];
    expect(products[0].imageUrl).toBe('https://img.alicdn.com/valid.jpg');
    expect(products.slice(1).every((p) => !('imageUrl' in p))).toBe(true);
  });
  it('资料与商品查询自动使用会话范围，未知结构不能当成空列表', async () => {
    const f = await fixture(),
      scope = { conversationKey: '9001', buyerId: '200' };
    const raw = await f.bridge.query('buyer-profile', scope);
    expect(normalizeGoofishQuery('buyer-profile', raw, {}, '200').data).toEqual({
      buyerId: '200',
      name: '测试买家',
      avatarUrl: 'https://img.alicdn.com/buyer.png',
      introduction: '',
    });
    const items = await f.bridge.query('goods', { ...scope, page: 1, pageSize: 10 });
    expect(normalizeGoofishQuery('goods', items, {}, '200').data).toMatchObject({
      products: [{ goodsId: '300' }],
    });
    await expect(f.bridge.query('buyer-profile', { ...scope, buyerId: '201' })).rejects.toThrow(
      '不匹配',
    );
    f.api.mockImplementation(async (r) =>
      r.api.includes('loginuser')
        ? { ret: ['SUCCESS::调用成功'], data: f.identity }
        : { ret: ['SUCCESS::调用成功'], data: {} },
    );
    await expect(f.bridge.query('goods', { ...scope, page: 1, pageSize: 10 })).rejects.toThrow(
      '结构',
    );
  });
  it('足迹没有交易卡片时回退到当前会话咨询商品，不假装有完整浏览记录', async () => {
    const f = await fixture();
    f.api.mockImplementation(async (request) => ({
      ret: ['SUCCESS::调用成功'],
      data: request.api.includes('loginuser')
        ? f.identity
        : request.api.includes('tradeinfo')
          ? { module: { items: [] } }
          : request.api.includes('headinfo')
            ? {
                left: { data: { picUrl: 'https://img.alicdn.com/item.png' } },
                middle: { data: { title: '咨询商品', price: '9.00' } },
              }
            : {},
    }));
    const raw = await f.bridge.query('buyer-footprint', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    expect(
      normalizeGoofishQuery('buyer-footprint', raw, { page: 1, pageSize: 10 }, '200').data,
    ).toMatchObject({
      products: [{ goodsId: '300', title: '咨询商品', priceText: '9.00' }],
    });
    expect(raw.partial).toBe(true);
    expect(raw.failedSections[0].reason).toContain('没有完整浏览足迹');
  });
  it('历史按指定会话查询，保留游标；不切换网页当前会话、不触发自动回复', async () => {
    const f = await fixture();
    f.listPrevMsgs.mockResolvedValue({
      userMessageModels: [
        {
          message: {
            cid: '9001',
            messageId: '8001',
            sender: { uid: '200@goofish' },
            createAt: Date.now() - 60000,
            content: {
              contentType: 101,
              custom: { data: JSON.stringify({ contentType: 1, text: { text: '历史问题' } }) },
            },
          },
          msgStatus: 1,
        },
      ],
      hasMore: true,
      nextCursor: '1750000000000',
    });
    const result = await f.bridge.query('history', {
      conversationKey: '9001',
      buyerId: '200',
      cursor: '1750000000010',
      pageSize: 20,
    });
    expect(
      normalizeGoofishQuery('history', result, { cursor: '1750000000010', pageSize: 20 }, '200')
        .data,
    ).toMatchObject({
      messages: [{ text: '历史问题' }],
      hasMore: true,
      nextCursor: '1750000000000',
    });
    expect(f.listPrevMsgs).toHaveBeenCalledWith('9001', '1750000000010', 20);
    expect(f.bridge.poll().events).toEqual([]);
  });
  it('订单限定当前会话，不能直接查询其他买家的订单', async () => {
    const f = await fixture(),
      scope = { conversationKey: '9001', buyerId: '200', page: 1, pageSize: 10 };
    const raw = await f.bridge.query('buyer-orders', scope);
    expect(normalizeGoofishQuery('buyer-orders', raw, {}, '200')).toMatchObject({
      partial: true,
      data: { orders: [{ orderSn: '4951116036319758915', canShipWithoutLogistics: true }] },
    });
    await expect(
      f.bridge.query('order-detail', { ...scope, orderSn: '4951116036319758916' }),
    ).rejects.toThrow('不属于');
  });
  it('交易列表为空时使用当前会话头部的明确订单，解析真实组件式详情', async () => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api === 'mtop.idle.trade.message.chat.tradeinfo')
        raw.data = {
          kunEmbedUrl:
            'https://h5.m.goofish.com/wow/moyu/moyu-project/idle-at/pages/message-head-seller?kun=true&wh_ttid=native',
          module: { items: [] },
        };
      if (request.api === 'mtop.idle.web.trade.order.detail') raw.data = componentOrder();
      return raw;
    });
    const raw = await f.bridge.query('buyer-orders', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    expect(normalizeGoofishQuery('buyer-orders', raw, {}, '200').data.orders).toEqual([
      expect.objectContaining({
        orderSn: testOrderId,
        goodsId: '300',
        productTitle: '测试商品',
        statusText: '等待买家确认收货',
        amountText: '0.01元',
        canShipWithoutLogistics: false,
        details: expect.arrayContaining([{ label: '订单编号', value: testOrderId }]),
      }),
    ]);
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('tradeinfo'))).toHaveLength(1);
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('headinfo'))).toHaveLength(1);
    expect(f.api).toHaveBeenCalledWith(
      expect.objectContaining({
        api: 'mtop.idle.trade.message.chat.tradeinfo',
        data: { sessionId: '9001', sessionType: 1, peerUserId: '200' },
      }),
    );
    expect(f.api).toHaveBeenCalledWith(
      expect.objectContaining({
        api: 'mtop.idle.trade.pc.message.headinfo',
        data: { sessionId: '9001', sessionType: 1, itemId: '300' },
      }),
    );
  });
  it('会话交易与头部订单合并去重，同页详情复用已经验证的关联关系', async () => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!,
      otherOrderId = '4951116036319758916';
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api === 'mtop.idle.trade.message.chat.tradeinfo')
        raw.data = { module: { items: [{ commonData: { orderId: otherOrderId } }] } };
      if (request.api === 'mtop.idle.web.trade.order.detail')
        raw.data = componentOrder(request.data.tid);
      return raw;
    });
    const raw = await f.bridge.query('buyer-orders', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    expect(raw.data.orders.map((o: any) => o.orderSn).sort()).toEqual([testOrderId, otherOrderId]);
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('tradeinfo'))).toHaveLength(1);
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('headinfo'))).toHaveLength(1);
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('order.detail'))).toHaveLength(2);
    const g = await fixture();
    const duplicate = await g.bridge.query('buyer-orders', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    expect(duplicate.data.orders).toHaveLength(1);
    expect(g.api.mock.calls.filter(([r]) => r.api.includes('order.detail'))).toHaveLength(1);
  });
  it.each([
    ['tradeinfo', 'conversationTrade'],
    ['headinfo', 'conversationHead'],
  ])('一个订单来源 %s 失败时，仅在另一来源有明确证据时降级', async (failedApi, section) => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      if (request.api.includes(failedApi))
        throw { ret: ['FAIL_SYS_TRAFFIC_LIMIT::订单来源暂不可用'] };
      return normal(request);
    });
    const raw = await f.bridge.query('buyer-orders', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    expect(raw.data.orders).toHaveLength(1);
    expect(raw.partial).toBe(true);
    expect(raw.failedSections).toContainEqual({
      section,
      reason: expect.stringContaining('FAIL_SYS_TRAFFIC_LIMIT'),
    });
    const detail = await f.bridge.query('order-detail', {
      conversationKey: '9001',
      buyerId: '200',
      orderSn: testOrderId,
    });
    expect(detail.partial).toBe(true);
    expect(detail.failedSections).toContainEqual({
      section,
      reason: expect.stringContaining('FAIL_SYS_TRAFFIC_LIMIT'),
    });
  });
  it.each(['tradeinfo', 'headinfo'])(
    '没有订单证据且 %s 失败时保留错误，不伪装成暂无订单',
    async (failedApi) => {
      const f = await fixture(),
        normal = f.api.getMockImplementation()!;
      f.api.mockImplementation(async (request) => {
        if (request.api.includes(failedApi))
          throw { ret: ['FAIL_SYS_TRAFFIC_LIMIT::订单来源暂不可用'] };
        const raw = await normal(request);
        if (request.api.includes('tradeinfo')) raw.data = { module: { items: [] } };
        if (request.api.includes('headinfo')) raw.data = orderHead('');
        return raw;
      });
      await expect(
        f.bridge.query('buyer-orders', {
          conversationKey: '9001',
          buyerId: '200',
          page: 1,
          pageSize: 10,
        }),
      ).rejects.toThrow('FAIL_SYS_TRAFFIC_LIMIT');
      expect(f.api.mock.calls.some(([r]) => r.api.includes('order.detail'))).toBe(false);
    },
  );
  it('两个已识别来源都没有订单时才显示空列表', async () => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api.includes('tradeinfo')) raw.data = { module: { items: [] } };
      if (request.api.includes('headinfo'))
        raw.data = {
          ...orderHead(''),
          commonData: { itemId: '300', supportPCTrade: 'true' },
        };
      return raw;
    });
    const raw = await f.bridge.query('buyer-orders', {
      conversationKey: '9001',
      buyerId: '200',
      page: 1,
      pageSize: 10,
    });
    expect(raw.data.orders).toEqual([]);
    expect(raw.failedSections).toEqual([expect.objectContaining({ section: 'allBuyerOrders' })]);
  });
  it.each([
    { itemId: '301' },
    { buyerId: '201' },
    { peerUserId: '201' },
    { sellerId: '999' },
    { seller: 'false' },
  ])('头部的其他买家、商品或卖家订单不能进入当前会话：%j', async (mismatch) => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api.includes('tradeinfo')) raw.data = { module: { items: [] } };
      if (request.api.includes('headinfo')) Object.assign(raw.data.commonData, mismatch);
      return raw;
    });
    await expect(
      f.bridge.query('buyer-orders', {
        conversationKey: '9001',
        buyerId: '200',
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toThrow(/不属于|不匹配|不是/);
    expect(f.api.mock.calls.some(([r]) => r.api.includes('order.detail'))).toBe(false);
  });
  it('头部关联不绕过详情中的买家校验，也不能查询头部未关联的订单', async () => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api.includes('tradeinfo')) raw.data = { module: { items: [] } };
      if (request.api.includes('order.detail'))
        raw.data = { ...componentOrder(), peerUserId: '201' };
      return raw;
    });
    const scope = { conversationKey: '9001', buyerId: '200' };
    await expect(
      f.bridge.query('order-detail', { ...scope, orderSn: testOrderId }),
    ).rejects.toThrow('买家不匹配');
    await expect(
      f.bridge.query('order-detail', { ...scope, orderSn: '4951116036319758916' }),
    ).rejects.toThrow('不属于');
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('order.detail'))).toHaveLength(1);
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.api.mock.calls.some(([r]) => r.api.includes('consign.dummy'))).toBe(false);
  });
  it.each([
    'detail-seller-flag',
    'detail-nested-buyer',
    'detail-nested-seller',
    'detail-unkeyed-common-buyer',
    'detail-matching-order-peer',
    'head-buyer-conflict',
  ])('订单显式归属冲突不能被其他来源或顶层订单号掩盖，也不能准备发货：%s', async (scenario) => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api.includes('headinfo') && scenario === 'head-buyer-conflict')
        raw.data.commonData.buyerId = '201';
      if (request.api.includes('order.detail')) {
        raw.data = {
          ...componentOrder(),
          button: { api: 'mtop.taobao.idle.logistic.consign.dummy' },
        };
        if (scenario === 'detail-seller-flag') raw.data.seller = 'false';
        if (scenario === 'detail-nested-buyer')
          raw.data.commonData = { orderId: testOrderId, buyerId: '201' };
        if (scenario === 'detail-nested-seller')
          raw.data.commonData = { orderId: testOrderId, sellerId: '999' };
        if (scenario === 'detail-unkeyed-common-buyer') raw.data.commonData = { buyerId: '201' };
        if (scenario === 'detail-matching-order-peer')
          raw.data.orderInfo = { orderId: testOrderId, peerUserId: '201' };
      }
      return raw;
    });
    const command = {
      ...f.command,
      deliveryMode: 'no_logistics',
      orderSn: testOrderId,
      note: '测试交付说明',
    };
    await expect(f.bridge.prepareShipment(command)).rejects.toMatchObject({
      code: 'GOOFISH_ORDER_SCOPE_MISMATCH',
    });
    await expect(
      f.bridge.query('buyer-orders', {
        conversationKey: '9001',
        buyerId: '200',
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: 'GOOFISH_ORDER_SCOPE_MISMATCH' });
    expect(f.bridge.drafts.size).toBe(0);
    expect(f.api.mock.calls.some(([r]) => r.api.includes('consign.dummy'))).toBe(false);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it('详情中的普通界面字段不误作订单卖家身份', async () => {
    const f = await fixture(),
      normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api.includes('order.detail'))
        raw.data = {
          ...componentOrder(),
          button: { api: 'mtop.taobao.idle.logistic.consign.dummy', seller: false },
        };
      return raw;
    });
    await expect(
      f.bridge.prepareShipment({
        ...f.command,
        deliveryMode: 'no_logistics',
        orderSn: testOrderId,
        note: '测试交付说明',
      }),
    ).resolves.toMatchObject({ buyerId: '200', sellerId: '100' });
    expect(f.api.mock.calls.some(([r]) => r.api.includes('consign.dummy'))).toBe(false);
  });
  it.each([0.01, '￥0.01', '1e2', '0.001', '0.01<script>'])(
    '组件式成交价不接受非金额字符串 %j',
    async (amount) => {
      const f = await fixture(),
        normal = f.api.getMockImplementation()!;
      f.api.mockImplementation(async (request) => {
        const raw = await normal(request);
        if (request.api.includes('order.detail')) raw.data = componentOrder(testOrderId, amount);
        return raw;
      });
      const raw = await f.bridge.query('order-detail', {
        conversationKey: '9001',
        buyerId: '200',
        orderSn: testOrderId,
      });
      expect(raw.data.order.amountText).toBe('');
    },
  );
  it('普通快递订单不调用 dummy 发货；未经准备不提交', async () => {
    const f = await fixture();
    const normal = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (request) => {
      const raw = await normal(request);
      if (request.api === 'mtop.idle.web.trade.order.detail') delete raw.data.button;
      return raw;
    });
    const c = {
      ...f.command,
      deliveryMode: 'no_logistics',
      orderSn: '4951116036319758915',
      note: '数字内容已交付',
    };
    await expect(f.bridge.prepareShipment(c)).rejects.toThrow('未明确提供');
    await expect(f.bridge.commitShipment(c)).rejects.toThrow('已过期');
    expect(f.api.mock.calls.some(([r]) => r.api.includes('consign.dummy'))).toBe(false);
  });
  it('发货须准备、单次提交并读回；接口成功但读回不符保持 unknown', async () => {
    const f = await fixture(),
      c = {
        ...f.command,
        deliveryMode: 'no_logistics',
        orderSn: '4951116036319758915',
        note: '数字内容已交付',
      };
    expect(await f.bridge.prepareShipment(c)).toMatchObject({ sellerId: '100', buyerId: '200' });
    expect(await f.bridge.commitShipment(c)).toMatchObject({ status: 'unknown' });
    await expect(f.bridge.commitShipment(c)).rejects.toThrow('已经提交');
    expect(f.api.mock.calls.filter(([r]) => r.api.includes('consign.dummy'))).toHaveLength(1);
  });
});

it('发货准备后身份变化不会提交，完整交付读回才能确认，prepare 重放不能重置已提交状态', async () => {
  const f = await fixture();
  const c = {
    ...f.command,
    deliveryMode: 'no_logistics',
    orderSn: '4951116036319758915',
    note: '交付已完成',
  };
  await f.bridge.prepareShipment(c);
  f.identity.userId = '999';
  await expect(f.bridge.commitShipment(c)).rejects.toThrow('账号或连接');
  expect(f.api.mock.calls.some(([r]) => r.api.includes('consign.dummy'))).toBe(false);
  f.identity.userId = '101';
  let shipped = false;
  const normal = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (request) => {
    const raw = await normal(request);
    if (request.api === 'mtop.taobao.idle.logistic.consign.dummy') shipped = true;
    if (shipped && request.api === 'mtop.idle.web.trade.order.detail') delete raw.data.button;
    if (request.api === 'mtop.taobao.idle.unconsign.detail') raw.data = { tradeText: c.note };
    return raw;
  });
  expect(await f.bridge.commitShipment(c)).toMatchObject({ status: 'confirmed' });
  await expect(f.bridge.prepareShipment(c)).rejects.toThrow('已经提交');
  expect(f.api.mock.calls.filter(([r]) => r.api.includes('consign.dummy'))).toHaveLength(1);
});
