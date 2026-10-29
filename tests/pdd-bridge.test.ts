import { it, expect, vi, afterEach } from 'vitest';
afterEach(() => vi.useRealTimers());
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transferResult } from '../packages/platforms/src/staff';
it('兼容 botsdk 使用的 webpackJsonp，监听队列入库确认后才删除，发送按 request_id 确认', async () => {
  const listeners: Record<string, Function> = {};
  const sdk: any = {
    socket: {
      on: (name: string, fn: Function) => {
        listeners[name] = fn;
      },
    },
    sendCmdMsg: async (body: any) => ({ request_id: body.request_id, msg_id: 'confirmed-123' }),
  };
  const im = {
    sendMsg: async (p: any) =>
      sdk.sendCmdMsg({
        cmd: 'send_message',
        request_id: 'request-1',
        message: {
          content: p.content,
          type: 0,
          to: { uid: p.uid, role: 'user' },
          from: { uid: 'mall-1', role: 'mall_cs' },
          ts: Date.now(),
        },
      }),
    getLatestConversation: () => {},
    sendMsgWeb: () => {},
  };
  const require: any = () => ({ im });
  require.m = {
    1: function () {
      return 'sendMsgWeb getLatestConversation';
    },
  };
  require.c = {};
  const chunk: any[] = [];
  chunk.push = ((item: any) => {
    const id = item[0][0];
    item[1][id]({}, {}, require);
    return 1;
  }) as any;
  const window: any = { webpackJsonp: chunk };
  const state = { IMSDK: sdk, userInfo: { mall_id: 'mall-1' } };
  runInNewContext(await readFile('resources/pdd-bridge.js', 'utf8'), {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state } } }) },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        id: 'cs-1',
        username: '客服',
        mall: { mall_id: 'mall-1', mall_name: '店铺' },
      }),
    }),
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Map,
    Object,
    Array,
    String,
  });
  const bridge = window.__judeskBridge;
  expect(bridge.poll().capabilities.sendText).toBe(true);
  listeners.message({
    payload: {
      message: {
        msg_id: 'incoming-1',
        type: 0,
        content: 'hello',
        from: { uid: 'buyer-1', role: 'user' },
        to: { uid: 'mall-1', role: 'mall_cs' },
        ts: Date.now(),
      },
    },
  });
  const pending = bridge.poll();
  expect(pending.events).toHaveLength(1);
  expect(bridge.poll().events).toHaveLength(1);
  bridge.ack(pending.events[0].sequence);
  expect(bridge.poll().events).toHaveLength(0);
  const result = await bridge.send({
    id: 'outbound-1',
    buyerId: 'buyer-1',
    kind: 'text',
    text: '您好',
  });
  expect(result).toMatchObject({ status: 'confirmed', externalId: 'confirmed-123' });
  expect(bridge.poll().events[0].outboundId).toBe('outbound-1');
  expect(
    await bridge.send({ id: 'outbound-1', buyerId: 'buyer-1', kind: 'text', text: '您好' }),
  ).toEqual(result);
});

it('商家壳有用户信息但尚无 IMSDK 时不把登录当作消息已连接，聊天挂载后可恢复', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  let state: any = { userInfo: { mall_id: 'mall', cs_id: 'cs' } };
  const listeners: Function[] = [];
  const window: any = { _imsdk: { sendMsg() {}, getLatestConversation() {} } };
  runInNewContext(source, {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state } } }) },
    console,
    setTimeout,
    clearTimeout,
  });
  const bridge = window.__judeskBridge;
  expect(bridge.poll()).toMatchObject({
    attached: false,
    capabilities: { receive: false },
    diagnostics: { listenerAttached: false },
  });
  const socket = { on: (_name: string, fn: Function) => listeners.push(fn), off: () => {} };
  state = { ...state, IMSDK: { socket, sendCmdMsg: async () => ({}) } };
  expect(bridge.poll()).toMatchObject({
    attached: true,
    capabilities: { receive: true, sendText: true },
    diagnostics: { sendReceiptHook: true },
  });
  bridge.poll();
  bridge.poll();
  expect(listeners).toHaveLength(1);
});

it('外层 Vue 壳与聊天子应用分离时找到聊天 store，socket 重建只注册当前监听', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  const first: any = { on: () => {}, off: () => {} };
  const shell = { userInfo: { mall_id: 'mall', cs_id: 'cs' } };
  const state: any = { ...shell, IMSDK: { socket: first, sendCmdMsg: async () => ({}) } };
  let oldCount = 0;
  first.on = () => oldCount++;
  const window: any = { _imsdk: { sendMsg() {}, getLatestConversation() {} } };
  runInNewContext(source, {
    window,
    document: {
      getElementById: () => ({ __vue__: { $store: { state: shell } } }),
      querySelectorAll: () => [{ __vue__: { $store: { state } } }],
    },
    console,
    setTimeout,
    clearTimeout,
  });
  expect(window.__judeskBridge.poll().capabilities.receive).toBe(true);
  let newCount = 0;
  state.IMSDK = {
    socket: { on: () => newCount++, connected: false },
    sendCmdMsg: async () => ({}),
  };
  expect(window.__judeskBridge.poll().capabilities.receive).toBe(false);
  state.IMSDK.socket.connected = true;
  expect(window.__judeskBridge.poll().capabilities.receive).toBe(true);
  expect(oldCount).toBe(1);
  expect(newCount).toBe(1);
});

it('首页与聊天页都使用账号接口 ID，不把聊天 cs_id 当成另一个登录账号', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  let state: any = { userInfo: { id: 'canonical-cs', mall_id: 'mall' } };
  let calls = 0;
  const window: any = {};
  runInNewContext(source, {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state } } }) },
    fetch: async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          result: {
            id: 'canonical-cs',
            username: '客服',
            mall: { mall_id: 'mall', mall_name: '店铺' },
          },
        }),
      };
    },
    console,
    setTimeout,
    clearTimeout,
  });
  expect((await window.__judeskBridge.identity()).externalId).toBe('canonical-cs');
  state = { userInfo: { cs_id: 'chat-routing-id', uid: 'different-user-id', mall_id: 'mall' } };
  expect((await window.__judeskBridge.identity()).externalId).toBe('canonical-cs');
  expect(calls).toBe(2);
});

it('PDD 工厂源码不包含 getLatestConversation 字样时仍按 botsdk 签名找到导出 SDK', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  const im = { sendMsg() {}, getLatestConversation() {} };
  const upload = { uploadImage() {}, updateUserRemark() {} };
  const require: any = (id: string) => (id === 'im' ? { default: im } : { default: upload });
  require.m = {
    im: () =>
      'unmarkConversation closeConversation setCsStatus sendMsgWeb sendMsg moveConversation markRead markConversation',
    upload: () => 'uploadImage updateUserRemark',
  };
  // This is an array-like webpack runtime; it need not pass Array.isArray.
  const window: any = {
    webpackJsonp: {
      push(item: any) {
        const id = item[0][0];
        item[1][id]({}, {}, require);
      },
    },
  };
  const state = { IMSDK: { socket: { on() {} }, sendCmdMsg: async () => ({}) } };
  runInNewContext(source, {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state } } }) },
    console,
    setTimeout,
    clearTimeout,
  });
  expect(window.__judeskBridge.poll()).toMatchObject({
    attached: true,
    capabilities: { sendText: true, sendImage: true },
    diagnostics: { webpackRuntimes: 1, matchedFactories: 2, sendCandidates: 1 },
  });
});

it('无关缓存模块的 getter 抛异常不会丢掉已发现的发送 SDK', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  const im = { sendMsg() {}, getLatestConversation() {} };
  const poison = Object.defineProperty({}, 'default', {
    enumerable: true,
    get() {
      throw new Error('optional module unavailable');
    },
  });
  const require: any = () => ({ default: im });
  require.m = { im: () => 'sendMsgWeb getLatestConversation' };
  require.c = {
    poison: { exports: poison },
    unreadable: Object.defineProperty({}, 'exports', {
      get() {
        throw new Error('unavailable');
      },
    }),
  };
  let captures = 0;
  const chunk: any = [];
  chunk.push = (item: any) => {
    captures++;
    const id = item[0][0];
    item[1][id]({}, {}, require);
  };
  const window: any = { webpackJsonp: chunk };
  const state = { IMSDK: { socket: { on() {} }, sendCmdMsg: async () => ({}) } };
  const clock = { now: () => 10000 };
  runInNewContext(source, {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state } } }) },
    Date: clock,
    console,
    setTimeout,
    clearTimeout,
  });
  expect(window.__judeskBridge.poll()).toMatchObject({
    attached: true,
    capabilities: { sendText: true },
    diagnostics: { cachedModules: 2, sendCandidates: 1 },
  });
  clock.now = () => 20000;
  expect(window.__judeskBridge.poll().capabilities.sendText).toBe(true);
  expect(captures).toBe(1);
});

it('开发时更新桥接保留未确认事件，旧监听卸载且不重复包装发送', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  const listeners = new Set<Function>();
  let sends = 0;
  const sdk: any = {
    socket: {
      on: (_name: string, fn: Function) => listeners.add(fn),
      off: (_name: string, fn: Function) => listeners.delete(fn),
    },
    sendCmdMsg: async (body: any) => {
      sends++;
      return { request_id: body.request_id, msg_id: 'sent-one' };
    },
  };
  const window: any = {
    _imsdk: {
      getLatestConversation() {},
      sendMsg: (p: any) =>
        sdk.sendCmdMsg({
          cmd: 'send_message',
          request_id: 'req',
          message: { content: p.content, to: { uid: p.uid, role: 'user' } },
        }),
    },
  };
  const context = {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state: { IMSDK: sdk } } } }) },
    console,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(source, context);
  for (const listener of listeners)
    listener({
      payload: {
        message: {
          msg_id: 'incoming',
          from: { role: 'user', uid: 'buyer' },
          to: { role: 'mall_cs', uid: 'cs' },
          content: 'hi',
          ts: Date.now(),
        },
      },
    });
  window.__judeskBridge.version = 0;
  runInNewContext(source, context);
  expect(listeners.size).toBe(1);
  expect(window.__judeskBridge.poll().events).toHaveLength(1);
  expect(
    (
      await window.__judeskBridge.send({
        id: 'outbound',
        buyerId: 'buyer',
        text: 'hello',
        kind: 'text',
      })
    ).status,
  ).toBe('confirmed');
  expect(sends).toBe(1);
  expect(window.__judeskBridge.poll().events).toHaveLength(2);
});

it('sendMsg 提前返回并延迟提交时，保留命令直到收到精确回执；重复命令不重发', async () => {
  const source = await readFile('resources/pdd-bridge.js', 'utf8');
  let sends = 0;
  const sdk: any = {
    socket: { on() {} },
    sendCmdMsg: async (body: any) => {
      sends++;
      return { request_id: String(body.request_id), msg_id: 'delayed-confirmed' };
    },
  };
  const window: any = {
    _imsdk: {
      getLatestConversation() {},
      sendMsg: (p: any) => {
        setTimeout(
          () =>
            void sdk.sendCmdMsg({
              cmd: 'send_message',
              request_id: 987654321,
              message: {
                content: p.content,
                to: { uid: p.uid, role: 'user' },
                from: { role: 'mall_cs' },
              },
            }),
          50,
        );
        // Actual platform SDK returns undefined; do not return a Promise from this fixture.
      },
    },
  };
  runInNewContext(source, {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state: { IMSDK: sdk } } } }) },
    setTimeout,
    clearTimeout,
  });
  const command = { id: 'deferred-outbound', buyerId: 'buyer', text: '您好', kind: 'text' };
  const sending = window.__judeskBridge.send(command);
  expect(window.__judeskBridge.active?.id).toBe(command.id);
  expect(await sending).toEqual({ status: 'confirmed', externalId: 'delayed-confirmed' });
  expect(window.__judeskBridge.active).toBeNull();
  expect(window.__judeskBridge.poll().events).toMatchObject([
    { outboundId: command.id, message: { msg_id: 'delayed-confirmed' } },
  ]);
  await window.__judeskBridge.send(command);
  expect(sends).toBe(1);
});

it('错误请求回执不能确认发送；超时保留 unknown 并释放账号，不会自动重发', async () => {
  vi.useFakeTimers();
  try {
    const source = await readFile('resources/pdd-bridge.js', 'utf8');
    let sends = 0;
    const sdk: any = {
      socket: { on() {} },
      sendCmdMsg: async () => {
        sends++;
        return { request_id: 'other', msg_id: 'wrong' };
      },
    };
    const window: any = {
      _imsdk: {
        getLatestConversation() {},
        sendMsg(p: any) {
          setTimeout(
            () =>
              void sdk.sendCmdMsg({
                cmd: 'send_message',
                request_id: 'ours',
                message: { content: p.content, to: { uid: p.uid } },
              }),
            50,
          );
        },
      },
    };
    runInNewContext(source, {
      window,
      document: { getElementById: () => ({ __vue__: { $store: { state: { IMSDK: sdk } } } }) },
      setTimeout,
      clearTimeout,
    });
    const command = { id: 'unknown-outbound', buyerId: 'buyer', text: '您好', kind: 'text' };
    const sending = window.__judeskBridge.send(command);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await sending).status).toBe('unknown');
    expect(window.__judeskBridge.active).toBeNull();
    expect(window.__judeskBridge.poll().events).toHaveLength(0);
    await window.__judeskBridge.send(command);
    expect(sends).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

async function receiptFixture(
  options: {
    response?: (body: any) => Promise<any>;
    invoke?: (params: any, sdk: any) => unknown;
  } = {},
) {
  const sdk: any = {
    socket: { on() {} },
    sendCmdMsg: vi.fn(
      options.response ??
        (async (body: any) => ({
          result: 'ok',
          request_id: body.request_id,
          msg_id: 'received-message',
        })),
    ),
  };
  const originalSend = sdk.sendCmdMsg;
  let params: any;
  const im = {
    getLatestConversation() {},
    sendMsg: vi.fn((p: any) => {
      params = p;
      return options.invoke
        ? options.invoke(p, sdk)
        : sdk.sendCmdMsg({
            cmd: 'send_message',
            request_id: 'owned-request',
            message: { content: p.content, to: { uid: p.uid } },
          });
    }),
  };
  const window: any = { _imsdk: im };
  runInNewContext(await readFile('resources/pdd-bridge.js', 'utf8'), {
    window,
    document: { getElementById: () => ({ __vue__: { $store: { state: { IMSDK: sdk } } } }) },
    setTimeout,
    clearTimeout,
  });
  return {
    bridge: window.__judeskBridge,
    im,
    originalSend,
    params: () => params,
    command: { id: 'outbound-owned', buyerId: 'buyer', text: '您好', kind: 'text' },
  };
}

it.each([
  { result: 'fail', error_msg: '当前会话不允许发送' },
  { result: 'error', error: '发送失败' },
  { success: false, error_msg: '发送被拦截' },
  { error_code: 100059, error_msg: '会话已转移' },
])('平台明确拒绝即使带 msg_id 也不能确认或形成回答：%j', async (failure) => {
  const f = await receiptFixture({
    response: async (body) => ({
      ...failure,
      request_id: body.request_id,
      msg_id: 'not-delivered',
    }),
  });
  const result = await f.bridge.send(f.command);
  expect(result).toMatchObject({
    status: 'rejected',
    reason: expect.stringContaining('拼多多拒绝发送'),
  });
  expect(result.reason).toContain('error_msg' in failure ? failure.error_msg : failure.error);
  expect(f.bridge.poll().events).toMatchObject([
    { type: 'send_rejected', outboundId: f.command.id, reason: result.reason },
  ]);
  expect(f.bridge.poll().events.some((e: any) => e.type === 'message')).toBe(false);
  expect(await f.bridge.send(f.command)).toEqual(result);
  expect(f.originalSend).toHaveBeenCalledTimes(1);
});

it('平台 Promise 拒绝保留明确错误码，重复回调不重复入队', async () => {
  const f = await receiptFixture({
    response: async () => {
      throw { result: 'fail', error_code: 10006, error_msg: '客服不在线' };
    },
  });
  const result = await f.bridge.send(f.command);
  expect(result).toEqual({ status: 'rejected', reason: '拼多多拒绝发送（10006）：客服不在线' });
  f.params().cb({ request_id: 'owned-request', result: 'fail', error_msg: '客服不在线' });
  expect(f.bridge.poll().events).toHaveLength(1);
  expect(f.bridge.active).toBeNull();
});

it('传输异常不能断言未送达，保留原因且不重发', async () => {
  const f = await receiptFixture({
    response: async () => {
      throw new Error('socket disconnected');
    },
  });
  const result = await f.bridge.send(f.command);
  expect(result).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('socket disconnected'),
  });
  expect(f.bridge.poll().events).toHaveLength(0);
  await f.bridge.send(f.command);
  expect(f.originalSend).toHaveBeenCalledTimes(1);
});

it('返回其他 request_id 的拒绝不能把当前发送标为 rejected', async () => {
  vi.useFakeTimers();
  const f = await receiptFixture({
    response: async () => ({
      request_id: 'someone-else',
      result: 'fail',
      error_msg: '其他请求的错误',
    }),
  });
  const sending = f.bridge.send(f.command);
  await vi.advanceTimersByTimeAsync(3001);
  expect(await sending).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('owned-request'),
  });
  f.params().cb({ request_id: 'someone-else', result: 'ok', msg_id: 'not-ours' });
  expect(f.bridge.sends.get(f.command.id).status).toBe('unknown');
  expect(f.bridge.poll().events).toHaveLength(0);
});

it('每次 SDK 调用自己的 callback 能确认发送，不依赖同一个 IMSDK 钩子', async () => {
  const f = await receiptFixture({
    invoke: (p) => {
      p.cb({ request_id: 'callback-request', result: 'ok', msg_id: 'callback-message' });
    },
  });
  expect(await f.bridge.send(f.command)).toEqual({
    status: 'confirmed',
    externalId: 'callback-message',
  });
  expect(f.bridge.poll().events).toMatchObject([
    { type: 'message', outboundId: f.command.id, message: { msg_id: 'callback-message' } },
  ]);
  expect(f.originalSend).not.toHaveBeenCalled();
});

it.each(['confirmed', 'rejected'])(
  'SDK 未观察到请求时超时，迟到 callback 更新原记录为 %s，不重发',
  async (status) => {
    vi.useFakeTimers();
    const f = await receiptFixture({ invoke: () => {} });
    const sending = f.bridge.send(f.command);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await sending).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('未观察到该命令提交请求'),
    });
    expect(f.bridge.active).toBeNull();
    expect(f.bridge.poll().events).toHaveLength(0);
    const response =
      status === 'confirmed'
        ? { request_id: 'late-request', result: 'ok', msg_id: 'late-message' }
        : { request_id: 'late-request', result: 'fail', error_msg: '平台限制发送' };
    f.params().cb(response);
    f.params().cb(response);
    expect(f.bridge.sends.get(f.command.id).status).toBe(status);
    expect(f.bridge.poll().events).toHaveLength(1);
    expect(f.bridge.poll().events[0]).toMatchObject({
      type: status === 'confirmed' ? 'message' : 'send_rejected',
      outboundId: f.command.id,
    });
    await f.bridge.send(f.command);
    expect(f.im.sendMsg).toHaveBeenCalledTimes(1);
    f.bridge.ack(f.bridge.poll().events[0].sequence);
    expect(f.bridge.poll().events).toHaveLength(0);
  },
);

it('钩子和 callback 都返回成功只产生一次精确确认', async () => {
  const f = await receiptFixture({
    invoke: async (p, sdk) => {
      const result = await sdk.sendCmdMsg({
        cmd: 'send_message',
        request_id: 'owned-request',
        message: { content: p.content, to: { uid: p.uid } },
      });
      p.cb(result);
    },
  });
  expect((await f.bridge.send(f.command)).status).toBe('confirmed');
  await Promise.resolve();
  expect(f.bridge.poll().events).toHaveLength(1);
});

it('收到对应回执但缺少 msg_id 不算成功，展示不完整回执原因', async () => {
  vi.useFakeTimers();
  const f = await receiptFixture({
    response: async (body) => ({ result: 'ok', request_id: body.request_id }),
  });
  const sending = f.bridge.send(f.command);
  await vi.advanceTimersByTimeAsync(3001);
  expect(await sending).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('未包含可确认的消息 ID'),
  });
  expect(f.bridge.poll().events).toHaveLength(0);
});
async function transferFixture(methods: Record<string, unknown> = {}) {
  const im = { ...methods, sendMsg: vi.fn(), sendMsgWeb: vi.fn(), getLatestConversation: vi.fn() };
  const require: any = () => ({ im });
  require.m = {
    1: function () {
      return 'sendMsgWeb getLatestConversation';
    },
  };
  require.c = {};
  const chunk: any[] = [];
  chunk.push = ((item: any) => {
    const id = item[0][0];
    item[1][id]({}, {}, require);
    return 1;
  }) as any;
  const window: any = { webpackJsonp: chunk };
  const fetch = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify({ success: true, result: { csList: [] } }),
    json: async () => ({
      id: 'cs-1',
      username: '客服',
      mall: { mall_id: 'mall-1', mall_name: '店铺' },
    }),
  }));
  runInNewContext(await readFile('resources/pdd-bridge.js', 'utf8'), {
    window,
    document: {
      getElementById: () => ({
        __vue__: {
          $store: { state: { IMSDK: { socket: { on() {} } }, userInfo: { mall_id: 'mall-1' } } },
        },
      }),
    },
    fetch,
    console,
    AbortSignal,
    Date,
    Math,
    Map,
    Object,
    Array,
    String,
    setTimeout,
    clearTimeout,
  });
  const b = window.__judeskBridge;
  return { b, im, fetch };
}

it('人工转接兼容旧 moveconv，并携带当前买家与目标客服', async () => {
  const moveconv = vi.fn(async () => undefined);
  const { b, im, fetch } = await transferFixture({ moveconv });
  expect(b.poll().capabilities.staffTransfer).toBe(true);
  await b.staff();
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/latitude/assign/getAssignCsList'),
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ wechatCheck: true }) }),
  );
  await b.transfer({ targetStaffId: 'cs-2', buyerId: 'buyer-1', note: '处理售后' });
  expect(moveconv).toHaveBeenCalledWith({
    csid: 'cs-2',
    uid: 'buyer-1',
    need_wx: false,
    remark: '处理售后',
  });
  expect(im.sendMsg).not.toHaveBeenCalled();
});

it.each([
  [{ result: 'ok', request_id: 'transfer-1' }, 'confirmed'],
  [{ result: 'fail', error_code: 100060, error_msg: '已收藏的会话不可转移' }, 'rejected'],
] as const)('新版 moveConversation 等待本次回调而非 void 返回值：%j', async (receipt, status) => {
  vi.useFakeTimers();
  const callbacks: Array<(raw: unknown) => void> = [];
  const moveConversation = vi.fn((_params, cb) => {
    callbacks.push(cb);
  });
  const moveconv = vi.fn();
  const { b, im } = await transferFixture({ moveConversation, moveconv });
  expect(b.poll()).toMatchObject({
    capabilities: { staffTransfer: true },
    diagnostics: { transferMethod: 'moveConversation' },
  });
  let finished = false;
  const pending = b
    .transfer({ targetStaffId: 'cs-2', buyerId: 'buyer-1', note: '售后问题' })
    .then((raw: unknown) => {
      finished = true;
      return transferResult('pinduoduo', raw);
    });
  await vi.advanceTimersByTimeAsync(100);
  expect(finished).toBe(false);
  expect(moveConversation).toHaveBeenCalledExactlyOnceWith(
    {
      csid: 'cs-2',
      uid: 'buyer-1',
      need_wx: false,
      remark: '售后问题',
    },
    expect.any(Function),
  );
  callbacks[0](receipt);
  expect((await pending).status).toBe(status);
  expect(vi.getTimerCount()).toBe(0);
  expect(moveconv).not.toHaveBeenCalled();
  expect(im.sendMsg).not.toHaveBeenCalled();
});

it('新版转接超时为待核对，不重试旧接口；迟到回执不会再发起转接', async () => {
  vi.useFakeTimers();
  let callback: (raw: unknown) => void;
  const moveConversation = vi.fn((_params, cb) => {
    callback = cb;
  });
  const moveconv = vi.fn();
  const { b } = await transferFixture({ moveConversation, moveconv });
  const pending = b.transfer({ targetStaffId: 'cs-2', buyerId: 'buyer-1', note: '' });
  await vi.advanceTimersByTimeAsync(12000);
  expect(transferResult('pinduoduo', await pending).status).toBe('unknown');
  callback!({ result: 'ok' });
  expect(transferResult('pinduoduo', await pending).status).toBe('unknown');
  expect(moveConversation).toHaveBeenCalledTimes(1);
  expect(moveconv).not.toHaveBeenCalled();
});

it('不同买家的并发转接分别等待自己的回执', async () => {
  vi.useFakeTimers();
  const callbacks = new Map<string, (raw: unknown) => void>();
  const moveConversation = vi.fn((params, cb) => {
    callbacks.set(params.uid, cb);
  });
  const { b } = await transferFixture({ moveConversation });
  const first = b.transfer({ targetStaffId: 'cs-2', buyerId: 'buyer-1', note: '' });
  const second = b.transfer({ targetStaffId: 'cs-3', buyerId: 'buyer-2', note: '' });
  await vi.advanceTimersByTimeAsync(0);
  callbacks.get('buyer-2')!({ result: 'fail', error_code: 403 });
  callbacks.get('buyer-1')!({ result: 'ok' });
  expect(transferResult('pinduoduo', await first).status).toBe('confirmed');
  expect(transferResult('pinduoduo', await second).status).toBe('rejected');
  expect(vi.getTimerCount()).toBe(0);
});

it('没有原生转接方法时不开放能力，也不查询客服或发送消息', async () => {
  const { b, fetch, im } = await transferFixture();
  expect(b.poll().capabilities.staffTransfer).toBe(false);
  await expect(b.staff()).rejects.toThrow('尚未提供可调用的转接接口');
  expect(fetch).not.toHaveBeenCalled();
  expect(im.sendMsg).not.toHaveBeenCalled();
});
