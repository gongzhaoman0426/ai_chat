import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { normalizeDouyinMessage } from '../packages/platforms/src/douyin';
const script = await readFile('resources/douyin-bridge.js', 'utf8');
async function fixture() {
  const listeners = new Set<(event: unknown) => void>();
  const unsubscribed = vi.fn();
  const stream = {
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
          unsubscribed();
        },
      };
    }),
  };
  const identity = {
    shop_id: 'shop-1',
    staff_id: 'staff-1',
    shop_name: '抖店测试店',
    staff_name: '测试客服',
  };
  const info = {
    conversation_id: 'opaque:conversation:pigeon',
    shop_id: 'shop-1',
    user_id: 'buyer-1',
    user_name: '测试买家',
    security_user_id: 'secure-user-1',
    securityBizConversationId: 'opaque:secure:conversation',
  };
  const im = {
    message$: stream,
    getConversation: vi.fn(async () => ({ data: info })),
    sendText: vi.fn(async (..._args: any[]) => undefined as any),
    _sendMsg: vi.fn(async (..._args: any[]) => undefined as any),
  };
  const get = vi.fn(
    async (path: string, _input?: unknown): Promise<any> =>
      path === '/backstage/currentuser'
        ? { code: 0, data: identity }
        : { code: 0, data: { list: [] } },
  );
  const post = vi.fn(async (_path: string, _input: unknown) => ({ code: 0, data: { orders: [] } }));
  const e = { im, get, post };
  const sandbox: any = {
    __workbench__: { workbenchOptions: { extra: e } },
    Date,
    URL,
    File,
    Uint8Array,
    atob,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 12000 ? 30 : ms),
    clearTimeout,
  };
  sandbox.window = sandbox;
  runInNewContext(script, sandbox);
  const bridge = sandbox.__judeskBridge;
  await bridge.identity();
  const emit = async (event: unknown) => {
    for (const listener of listeners) listener(event);
    await bridge.work;
  };
  const message = (overrides: Record<string, unknown> = {}) => ({
    serverId: '7650740519126992134',
    conversationId: info.conversation_id,
    sender: { id: 'buyer-1', role: 'user', name: '测试买家' },
    type: 'text',
    content: '商品多久发货',
    timestamp: Date.now(),
    ...overrides,
  });
  const command = {
    id: 'command-1',
    token: 'token',
    accountId: 'account-1',
    conversationKey: info.conversation_id,
    buyerId: info.user_id,
    platformContext: {
      userId: info.user_id,
      securityUserId: info.security_user_id,
      securityConversationId: info.securityBizConversationId,
    },
    kind: 'text',
    text: '您好，已收到您的问题',
  };
  return {
    bridge,
    sandbox,
    im,
    get,
    post,
    e,
    identity,
    info,
    stream,
    unsubscribed,
    emit,
    message,
    command,
  };
}
describe('飞鸽扩展业务入口', () => {
  it('评价邀请的自身流回声早于发送回执时，不误记为人工回复；其他客服消息仍保留', async () => {
    const f = await fixture();
    let resolve!: (value: unknown) => void;
    const gate = new Promise((r) => {
      resolve = r;
    });
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const sendCustomCard = vi.fn(() => {
      started();
      return gate;
    });
    Object.assign(f.im, { sendCustomCard });
    const sending = f.bridge.send({
      ...f.command,
      kind: 'review_card',
      richContent: { kind: 'review_card', orderSn: '123456789', title: '邀请评价' },
    });
    await ready;
    const own = f.message({
      serverId: 'review-echo',
      type: 'custom_card',
      ext: { card_type: 'comment', data_id: '123456789' },
      sender: { id: 'staff-1', role: 'staff' },
    });
    const emitted = f.emit({ messages: [own, { ...own, serverId: 'another-human-card' }] });
    resolve({ data: { message: own } });
    expect(await sending).toMatchObject({ status: 'confirmed', externalId: 'review-echo' });
    await emitted;
    const events = f.bridge.poll().events;
    expect(
      events.filter((e: any) => e.type === 'message').map((e: any) => e.message.messageId),
    ).toEqual(['another-human-card']);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'confirmed',
          outboundId: f.command.id,
          externalId: 'review-echo',
        }),
      ]),
    );
  });
  it.each([
    [{ data: { message: { serverId: 'review-1', flightStatus: 3 } } }, 'confirmed'],
    [{ code: 0, data: {} }, 'unknown'],
    [{ code: 403, message: '拒绝发送' }, 'rejected'],
  ])('评价邀请走发送通道，只有消息回执才确认：%j', async (raw, status) => {
    const f = await fixture();
    const sendCustomCard = vi.fn(async () => raw);
    Object.assign(f.im, { sendCustomCard });
    const command = {
      ...f.command,
      kind: 'review_card',
      richContent: { kind: 'review_card', orderSn: '123456789', title: '邀请评价' },
    };
    expect(await f.bridge.send(command)).toMatchObject({ status });
    expect(sendCustomCard).toHaveBeenCalledWith(f.info.conversation_id, {
      card_type: 'comment',
      data_id: '123456789',
    });
    await f.bridge.send(command);
    expect(sendCustomCard).toHaveBeenCalledTimes(1);
  });
  it('平台话术查询已移除，评价邀请不再绕开发送队列作为快捷操作', async () => {
    const f = await fixture();
    expect(f.bridge.poll().capabilities.operations).not.toContain('platform-replies');
    await expect(f.bridge.query('platform-replies', f.command)).rejects.toThrow();
    await expect(
      f.bridge.quickAction({ ...f.command, operation: 'invite-review', targetId: '123456789' }),
    ).rejects.toThrow();
  });
  it('搜索词原样传给商品与当前买家订单，不切换店铺或买家', async () => {
    const f = await fixture();
    await f.bridge.query('goods', { ...f.command, page: 2, pageSize: 10, keyword: '折叠椅' });
    expect(f.get).toHaveBeenLastCalledWith(
      '/backstage/workstation/get_product_list',
      expect.objectContaining({
        page_no: 1,
        search_words: '折叠椅',
        security_user_id: 'secure-user-1',
      }),
    );
    await f.bridge.query('buyer-orders', {
      ...f.command,
      page: 1,
      pageSize: 10,
      keyword: '123456',
    });
    expect(f.post).toHaveBeenLastCalledWith(
      '/backstage/cmpoent/order/query',
      expect.objectContaining({ search_words: '123456', security_user_id: 'secure-user-1' }),
    );
  });
  it('已读使用当前会话收到的原始消息对象，不能把其他会话消息标为已读', async () => {
    const f = await fixture();
    const markRead = vi.fn(async () => undefined);
    (f.im as any).markReadMessage = markRead;
    const message = f.message();
    await f.emit(message);
    await f.bridge.markRead({ ...f.command, messageIds: [message.serverId] });
    expect(markRead).toHaveBeenCalledWith(f.command.conversationKey, message);
    await expect(
      f.bridge.markRead({ ...f.command, messageIds: ['other-message'] }),
    ).rejects.toThrow('原始对象');
    expect(markRead).toHaveBeenCalledTimes(1);
  });
  it('商品卡片携带命令关联 ID，已存在的视频走 sendVideo，void 不算成功', async () => {
    const f = await fixture();
    (f.im as any).sendCard = vi.fn(async () => ({ serverId: 'card-receipt' }));
    (f.im as any).sendVideo = vi.fn(async () => undefined);
    expect(
      await f.bridge.send({
        ...f.command,
        kind: 'product_card',
        richContent: { kind: 'product_card', goodsId: '123456', title: '椅' },
      }),
    ).toMatchObject({ status: 'confirmed', externalId: 'card-receipt' });
    expect((f.im as any).sendCard.mock.calls[0][0]).toMatchObject({
      conversation_id: f.command.conversationKey,
      data_id: '123456',
    });
    expect(JSON.parse((f.im as any).sendCard.mock.calls[0][0].message_ext)).toMatchObject({
      'p:check_Send': f.command.id,
    });
    expect(
      await f.bridge.send({
        ...f.command,
        id: 'video-1',
        kind: 'video',
        richContent: {
          kind: 'video',
          videoId: 'v1',
          width: 640,
          height: 480,
          coverUrl: 'https://p.byteimg.com/c.jpg',
          duration: 10,
        },
      }),
    ).toMatchObject({ status: 'unknown' });
    expect((f.im as any).sendVideo).toHaveBeenCalledWith(f.command.conversationKey, {
      videoId: 'v1',
      width: 640,
      height: 480,
      coverURL: 'https://p.byteimg.com/c.jpg',
      duration: 10,
    });
  });
  it('读取订单备注必须返回同一订单的明确备注和星标，写入不改星标', async () => {
    const f = await fixture();
    f.post.mockResolvedValue({
      code: 0,
      data: { orders: [{ order_id: '123456', remark_info: { remark: '旧备注', star: 4 } }] },
    } as any);
    expect(await f.bridge.orderState({ ...f.command, orderSn: '123456' })).toEqual({
      remark: '旧备注',
      tag: 4,
      tagName: '4',
    });
    await f.bridge.writeOrderRemark({
      ...f.command,
      orderSn: '123456',
      remark: '旧备注\n加固',
      remarkTag: 4,
    });
    expect(f.post).toHaveBeenLastCalledWith(
      '/backstage/workshop/addRemark?_pms=1',
      expect.objectContaining({
        order_id: '123456',
        remark_info: { is_add_remark: true, is_add_star: false, remark: '旧备注\n加固', star: 4 },
      }),
    );
    f.post.mockResolvedValue({
      code: 0,
      data: { orders: [{ order_id: '123456', remark: '未带星标' }] },
    } as any);
    await expect(f.bridge.orderState({ ...f.command, orderSn: '123456' })).rejects.toThrow(
      '禁止覆盖',
    );
  });
  it('素材、客服组和邀请操作使用固定入口；转接源客服来自登录身份', async () => {
    const f = await fixture();
    await f.bridge.query('video-materials', { ...f.command, page: 1, pageSize: 10 });
    expect(f.get).toHaveBeenLastCalledWith('/backstage/search_pigeon_materials', {
      material_type: 'video',
      order_by: 'UpdateTimeDesc',
      page: 1,
      size: 10,
      parent_folder_id: '203',
    });
    await f.bridge.quickAction({ ...f.command, operation: 'transfer-group', targetId: 'group-1' });
    expect(f.post).toHaveBeenLastCalledWith('/backstage/conversationToShopGroup', {
      fromStaffId: 'staff-1',
      groupId: 'group-1',
      receiverUid: 'buyer-1',
      ignoreSnap: false,
    });
    await f.bridge.quickAction({ ...f.command, operation: 'invite-order', targetId: '123456' });
    expect(f.post).toHaveBeenLastCalledWith('/backstage/workstation/order_create_care', {
      product_id: '123456',
      user_id: 'buyer-1',
    });
  });
  it('视频素材切换目录与翻页保留平台返回的完整目录编号，不退回默认目录', async () => {
    const f = await fixture();
    await f.bridge.query('video-materials', {
      ...f.command,
      page: 2,
      pageSize: 20,
      folderId: '7650740519126992135',
    });
    expect(f.get).toHaveBeenLastCalledWith('/backstage/search_pigeon_materials', {
      material_type: 'video',
      order_by: 'UpdateTimeDesc',
      page: 2,
      size: 20,
      parent_folder_id: '7650740519126992135',
    });
  });
});
describe('抖店桥接：订阅、身份与消息', () => {
  it('重复注入不会重复订阅，SDK 替换会清理旧订阅，ACK 前保留事件', async () => {
    const f = await fixture();
    runInNewContext(script, f.sandbox);
    f.bridge.poll();
    expect(f.stream.subscribe).toHaveBeenCalledTimes(1);
    await f.emit(f.message());
    const first = f.bridge.poll();
    expect(first.events).toHaveLength(1);
    expect(f.bridge.poll().events).toHaveLength(1);
    expect(normalizeDouyinMessage('account-1', first.events[0].message)).toMatchObject({
      externalId: '7650740519126992134',
      buyerId: 'buyer-1',
      direction: 'in',
      conversationKey: f.info.conversation_id,
      platformContext: { securityUserId: 'secure-user-1' },
    });
    f.bridge.ack(first.events[0].sequence);
    expect(f.bridge.poll().events).toEqual([]);
    const stream = { subscribe: vi.fn(() => ({ unsubscribe() {} })) };
    f.im.message$ = stream as any;
    f.bridge.poll();
    expect(f.unsubscribed).toHaveBeenCalledTimes(1);
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
    f.bridge.dispose();
  });
  it('平台人工作答是 outgoing；历史回放被标记，不虚构未知角色和不安全数字 ID', async () => {
    const f = await fixture();
    await f.emit(f.message({ sender: 'staff-1', content: '平台人工回复' }));
    await f.emit(f.message({ serverId: 'history-1', timestamp: Date.now() - 60000 }));
    await f.emit(f.message({ serverId: Number('7650740519126992134') }));
    await f.emit(f.message({ sender: 'unknown-role', serverId: 'unknown-1' }));
    const polled = f.bridge.poll();
    expect(polled.events.map((e: any) => e.message.direction)).toEqual(['out', 'in']);
    expect(polled.events[1].message.historical).toBe(true);
    expect(polled.diagnostics.unsupportedEvents).toBe(2);
    expect(JSON.stringify(polled.diagnostics)).not.toContain('商品多久发货');
  });
  it('同一页面身份切换后拒绝发送，不把新店登录态复用给旧账号', async () => {
    const f = await fixture();
    f.identity.shop_id = 'shop-2';
    await expect(f.bridge.send(f.command)).resolves.toMatchObject({ status: 'rejected' });
    expect(f.im.sendText).not.toHaveBeenCalled();
  });
});
describe('抖店发送确认', () => {
  it('只根据平台消息 ID 确认，命令幂等并产生可 ACK 的确认事件', async () => {
    const f = await fixture();
    f.im.sendText.mockResolvedValue({
      message: { serverId: 'server-ack-1', conversationId: f.info.conversation_id },
    });
    await expect(f.bridge.send(f.command)).resolves.toEqual({
      status: 'confirmed',
      externalId: 'server-ack-1',
    });
    await expect(f.bridge.send(f.command)).resolves.toMatchObject({ status: 'confirmed' });
    expect(f.im.sendText).toHaveBeenCalledTimes(1);
    expect(f.im.sendText).toHaveBeenCalledWith(f.info.conversation_id, f.command.text, {
      'p:check_Send': f.command.id,
    });
    expect(f.bridge.poll().events).toContainEqual(
      expect.objectContaining({
        type: 'confirmed',
        outboundId: f.command.id,
        externalId: 'server-ack-1',
      }),
    );
  });
  it.each([undefined, { id: 'local-id-only' }, { success: true }])(
    'SDK 仅返回 %j 不等于已发送；迟到的精确回执仍可完成确认',
    async (value) => {
      const f = await fixture();
      f.im.sendText.mockResolvedValue(value);
      await expect(f.bridge.send(f.command)).resolves.toMatchObject({ status: 'unknown' });
      await f.emit(
        f.message({
          sender: 'staff-1',
          ext: { 'p:check_Send': f.command.id },
          serverId: 'late-server-id',
        }),
      );
      expect(f.bridge.sends.get(f.command.id)).toEqual({
        status: 'confirmed',
        externalId: 'late-server-id',
      });
      expect(f.im.sendText).toHaveBeenCalledTimes(1);
    },
  );
  it('相同文本或其他会话的事件不能确认本次发送；明确拒绝不是成功', async () => {
    const f = await fixture();
    await f.bridge.send(f.command);
    await f.emit(f.message({ sender: 'staff-1', content: f.command.text, serverId: 'human-id' }));
    await f.emit(
      f.message({
        sender: 'staff-1',
        conversationId: 'other-conversation',
        ext: { 'p:check_Send': f.command.id },
      }),
    );
    expect(f.bridge.sends.get(f.command.id).status).toBe('unknown');
    f.im.sendText.mockResolvedValue({ code: 403 });
    await expect(f.bridge.send({ ...f.command, id: 'rejected-command' })).resolves.toMatchObject({
      status: 'rejected',
    });
  });
  it('图片通过上传模块并使用实际尺寸和独立关联 ID', async () => {
    const f = await fixture();
    const upload = vi.fn(async () => ({ uri: 'tos-uploaded-image-uri' }));
    const require: any = Object.assign(() => ({ iP: upload }), {
      m: { image: function doImageXUpload() {} },
    });
    f.sandbox.masterWebpackJsonp = { push: (chunk: any[]) => chunk[2](require) };
    f.sandbox.Image = class {
      naturalWidth = 640;
      naturalHeight = 480;
      onload?: () => void;
      set src(_url: string) {
        this.onload?.();
      }
    };
    f.bridge.scanAt = 0;
    expect(f.bridge.poll().capabilities.sendImage).toBe(true);
    f.im._sendMsg.mockResolvedValue({ serverId: 'image-ack' });
    await expect(
      f.bridge.send({ ...f.command, kind: 'image', imageMime: 'image/png', imageData: 'YWJj' }),
    ).resolves.toMatchObject({ status: 'confirmed' });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(f.im._sendMsg).toHaveBeenCalledWith(
      f.info.conversation_id,
      expect.objectContaining({
        type: 'file_image',
        ext: expect.objectContaining({
          imageUrl: 'tos-uploaded-image-uri',
          imageWidth: '640',
          imageHeight: '480',
          uuid: f.command.id,
        }),
      }),
    );
  });
});
describe('抖店业务查询范围', () => {
  it('订单使用当前买家安全 ID，历史使用原始安全会话 ID；查询不允许写订单，备注使用独立校验通道', async () => {
    const f = await fixture();
    const input = { ...f.command, page: 1, pageSize: 10, cursor: '' };
    await f.bridge.query('goods-detail', { ...input, goodsId: '3737994268627829216' });
    expect(f.get).toHaveBeenCalledWith(
      '/backstage/productdetail',
      expect.objectContaining({
        product_id: '3737994268627829216',
        security_user_id: 'secure-user-1',
      }),
    );
    await f.bridge.query('buyer-orders', input);
    expect(f.post).toHaveBeenCalledWith(
      '/backstage/cmpoent/order/query',
      expect.objectContaining({ security_user_id: 'secure-user-1', page_no: 0 }),
    );
    await f.bridge.query('history', input);
    expect(f.get).toHaveBeenCalledWith(
      '/chat/api/backstage/conversation/get_history_msg',
      expect.objectContaining({ securityBizConversationId: 'opaque:secure:conversation' }),
    );
    await expect(f.bridge.query('order-remark', input)).rejects.toThrow('不支持');
    await expect(f.bridge.query('/arbitrary-url', input)).rejects.toThrow('未提供');
    expect(f.bridge.poll().capabilities.operations).not.toContain('goods-skus');
    expect(f.bridge.poll().capabilities.orderRemark).toBe(true);
  });
  it('旧存储中的买家 ID 不能绕过实时会话身份不匹配', async () => {
    const f = await fixture();
    f.info.user_id = 'other-buyer';
    await expect(
      f.bridge.query('buyer-orders', { ...f.command, page: 1, pageSize: 10 }),
    ).rejects.toThrow('买家 ID 已变化');
    expect(f.post).not.toHaveBeenCalled();
  });
});

it('匹配当前公开飞鸽 SDK：CustomerServiceInfo/ShopId、ext 数字角色、createTime 与 securityConversationId', async () => {
  const f = await fixture();
  f.get.mockImplementation(async () => ({
    st: 0,
    data: {
      ShopId: 'shop-1',
      ShopName: '真实字段店铺',
      CustomerServiceInfo: { id: 'staff-1', screen_name: '真实字段客服' },
    },
  }));
  expect(await f.bridge.identity()).toMatchObject({
    mallId: 'shop-1',
    externalId: 'staff-1',
    mallName: '真实字段店铺',
    name: '真实字段客服',
  });
  const cid = 'AQ-secure-buyer:shop-1::2:1:pigeon';
  f.im.getConversation.mockResolvedValue({
    id: cid,
    securityConversationId: cid,
    originExt: {},
  } as any);
  await f.emit({
    serverId: '7650740519126992134',
    conversationId: cid,
    sender: 'AQ-secure-buyer',
    securitySender: 'AQ-secure-buyer',
    createTime: Date.now(),
    messageType: 1000,
    type: 1000,
    flightStatus: 4,
    content: '来自真实字段的消息',
    originExt: { sender_role: '1', type: 'text', shop_id: 'shop-1' },
  });
  const incoming = f.bridge.poll().events[0].message;
  expect(incoming).toMatchObject({
    direction: 'in',
    kind: 'text',
    buyerId: 'AQ-secure-buyer',
    platformContext: { securityUserId: 'AQ-secure-buyer', securityConversationId: cid },
  });
  await f.bridge.query('history', {
    ...f.command,
    buyerId: incoming.buyerId,
    conversationKey: cid,
    platformContext: incoming.platformContext,
    cursor: '',
    pageSize: 10,
  });
  expect(f.get).toHaveBeenLastCalledWith(
    '/chat/api/backstage/conversation/get_history_msg',
    expect.objectContaining({ securityUserId: 'AQ-secure-buyer', securityBizConversationId: cid }),
  );
});
it.each([-1, -2, -3, 0, 1, 2])(
  'flightStatus=%s 即使带 serverId，也不能确认已向买家发送',
  async (flightStatus) => {
    const f = await fixture();
    f.im.sendText.mockResolvedValue({ serverId: 'not-visible-to-buyer', flightStatus });
    const result = await f.bridge.send(f.command);
    expect(result.status).toBe(flightStatus === -2 || flightStatus === -3 ? 'rejected' : 'unknown');
  },
);
it('订阅 SDK 人工发送状态变化；发送中的草稿不入库，服务器确认后才同步', async () => {
  const f = await fixture();
  let callback: (event: any) => void = () => {};
  const unsubscribe = vi.fn();
  (f.im as any).onMessageChange = (fn: typeof callback) => {
    callback = fn;
    return { unsubscribe };
  };
  f.bridge.stream = null;
  f.bridge.poll();
  callback({
    serverId: 'manual-native-id',
    conversationId: f.info.conversation_id,
    sender: 'staff-1',
    createTime: Date.now(),
    flightStatus: 2,
    type: 1000,
    content: '原平台人工回复',
    originExt: { sender_role: '2', type: 'text' },
  });
  await f.bridge.work;
  expect(f.bridge.poll().events).toHaveLength(0);
  callback({
    serverId: 'manual-native-id',
    conversationId: f.info.conversation_id,
    sender: 'staff-1',
    createTime: Date.now(),
    flightStatus: 3,
    type: 1000,
    content: '原平台人工回复',
    originExt: { sender_role: '2', type: 'text' },
  });
  await f.bridge.work;
  expect(f.bridge.poll().events[0].message).toMatchObject({
    direction: 'out',
    kind: 'text',
    text: '原平台人工回复',
  });
  f.bridge.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it('转接使用原生会话地址和目标客服，不借用发送消息接口', async () => {
  const f = await fixture();
  const transfer = vi.fn(async () => ({ code: 0 }));
  Object.assign(f.im, { sendTransferService: transfer });
  expect(f.bridge.poll().capabilities.staffTransfer).toBe(true);
  await f.bridge.staff();
  expect(f.get).toHaveBeenCalledWith('/pcbackstage/getCanAssignStaffList');
  await f.bridge.transfer({ ...f.command, targetStaffId: 'target-staff', note: '转接说明' });
  expect(transfer).toHaveBeenCalledWith(f.info.conversation_id, 'target-staff');
  expect(f.im.sendText).not.toHaveBeenCalled();
  await expect(
    f.bridge.transfer({ ...f.command, buyerId: 'another-buyer', targetStaffId: 'target-staff' }),
  ).rejects.toThrow();
  expect(transfer).toHaveBeenCalledTimes(1);
});
