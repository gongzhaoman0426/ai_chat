import { afterEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ windows: [] as any[], views: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    contentView = { addChildView: vi.fn() };
    show = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
    setTitle = vi.fn();
    getContentSize = () => [1180, 820];
    isDestroyed = () => false;
    constructor() {
      super();
      electron.windows.push(this);
    }
  }
  class Contents extends EventEmitter {
    url = 'https://mms.pinduoduo.com/chat-merchant/index.html';
    identity = { mallId: 'mall-1', mallName: '测试店', externalId: 'cs-1', name: '测试客服' };
    state: any = {
      attached: true,
      events: [],
      overflow: false,
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: true,
        orders: false,
      },
    };
    session = {
      setPermissionRequestHandler: vi.fn(),
      setProxy: vi.fn(async () => {}),
      setUserAgent: vi.fn(),
    };
    setWindowOpenHandler = vi.fn();
    isDestroyed = () => false;
    close = vi.fn();
    getURL = () => this.url;
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
      this.emit(
        'did-start-navigation',
        { isMainFrame: true, isSameDocument: false },
        url,
        false,
        true,
      );
      this.emit('did-finish-load');
    });
    executeJavaScript = vi.fn(async (code: string) => {
      if (code === 'window.__judeskBridge.identity()') return this.identity;
      if (code === 'window.__judeskBridge.poll()') return this.state;
      return { installed: true };
    });
  }
  class View {
    webContents = new Contents();
    setBounds = vi.fn();
    constructor() {
      electron.views.push(this);
    }
  }
  return { BrowserWindow: Window, WebContentsView: View, session: { fromPartition: vi.fn() } };
});
import { PddHost } from '../apps/desktop/src/main/pdd-host';
import { DouyinHost } from '../apps/desktop/src/main/douyin-host';
import { DOUYIN_LOGIN_URL, DOUYIN_URL } from '../packages/platforms/src/douyin';
import { PDD_URL } from '../packages/platforms/src';
let host: PddHost | DouyinHost | undefined;
afterEach(() => {
  host?.close();
  host = undefined;
  electron.windows.length = 0;
  electron.views.length = 0;
  vi.useRealTimers();
});
function setup(saved = false) {
  const account = {
    id: 'account-1',
    storeId: 'store-1',
    externalId: 'cs-1',
    sessionPartition: 'persist:test',
  };
  const request = vi.fn(async (data: any) => (data.type === 'account' ? account : { ok: true }));
  const notify = vi.fn();
  host = new PddHost('resources/pdd-bridge.js', request, notify);
  const poll = () => (host as any).poll([...(host as any).entries.values()][0]);
  return { account, request, notify, poll, open: () => host!.connect(saved ? account : undefined) };
}

it.each([
  [{ result: 'ok' }, 'confirmed'],
  [undefined, 'unknown'],
  [{ result: 'fail', error_code: 403 }, 'rejected'],
] as const)('拼多多宿主使用客服路由 ID 转接，排除自身并去重提交：%j', async (receipt, status) => {
  const f = setup(true);
  await f.open();
  await f.poll();
  const wc = electron.views[0].webContents;
  const original = wc.executeJavaScript.getMockImplementation();
  const transfers: any[] = [];
  wc.executeJavaScript.mockImplementation(async (code: string) => {
    if (code === 'window.__judeskBridge.staff()')
      return {
        success: true,
        errorCode: 1000000,
        result: {
          csList: {
            'routing-self': { id: 'cs-1', nickname: '', username: '当前客服' },
            'routing-other': { id: 'account-other', nickname: '售后客服' },
          },
        },
      };
    if (code.startsWith('window.__judeskBridge.transfer(')) {
      expect(f.request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'platform_transfer_guard',
          preview: expect.objectContaining({ targetStaffId: 'routing-other', buyerId: 'buyer-1' }),
        }),
      );
      transfers.push(JSON.parse(code.slice('window.__judeskBridge.transfer('.length, -1)));
      return receipt;
    }
    return original!(code);
  });
  expect(await host!.staff(f.account.id)).toEqual([{ id: 'routing-other', name: '售后客服' }]);
  const command = {
    id: 'cf6a0ff3-4f4f-4b4b-8b8b-aaaaaaaaaaaa',
    accountId: f.account.id,
    buyerId: 'buyer-1',
    conversationKey: 'buyer:buyer-1',
    platformContext: {},
    targetStaffId: 'routing-other',
    note: '请处理售后',
  };
  const [first, repeat] = await Promise.all([
    host!.executeTransfer(command),
    host!.executeTransfer(command),
  ]);
  expect(first.status).toBe(status);
  expect(repeat).toEqual(first);
  expect(transfers).toEqual([command]);
  await expect(
    host!.executeTransfer({
      ...command,
      id: 'cf6a0ff3-4f4f-4b4b-8b8b-bbbbbbbbbbbb',
      targetStaffId: 'routing-self',
    }),
  ).rejects.toThrow('已不在平台可转接列表');
  expect(transfers).toHaveLength(1);
});

describe('拼多多宿主连接状态', () => {
  it('已保存账号重启后重新识别并同步在线能力，恢复 mallId 供验证使用', async () => {
    const f = setup(true);
    await f.open();
    await f.poll();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'account' }));
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({
          phase: 'online',
          accountId: f.account.id,
          capabilities: expect.objectContaining({ receive: true, sendText: true }),
        }),
      }),
    );
    await expect(host!.verify(f.account.id)).resolves.toHaveProperty('identity.mallId', 'mall-1');
  });
  it('从登录首页跳转聊天页后不残留离线状态', async () => {
    const f = setup();
    await f.open();
    const wc = electron.views[0].webContents;
    wc.url = 'https://mms.pinduoduo.com/home/';
    wc.state = {
      ...wc.state,
      attached: false,
      capabilities: {
        receive: false,
        sendText: false,
        sendImage: false,
        history: false,
        goods: false,
        orders: false,
      },
    };
    await f.poll();
    expect(wc.loadURL).toHaveBeenLastCalledWith(PDD_URL);
    wc.state = {
      ...wc.state,
      attached: true,
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: true,
        orders: false,
      },
    };
    await f.poll();
    expect(f.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({ phase: 'online' }),
      }),
    );
  });
  it('iframe 与同文档导航不会使聊天通道离线', async () => {
    const f = setup();
    await f.open();
    await f.poll();
    f.request.mockClear();
    f.notify.mockClear();
    const wc = electron.views[0].webContents;
    wc.emit(
      'did-start-navigation',
      { isMainFrame: false, isSameDocument: false },
      'https://example.com/frame',
      false,
      false,
    );
    wc.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: true },
      PDD_URL + '#chat',
      true,
      true,
    );
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    await expect(host!.verify(f.account.id)).resolves.toBeTruthy();
  });
  it('SDK 未就绪时显示等待原因，恢复后更新能力而非只更新内存', async () => {
    const f = setup(true);
    await f.open();
    const wc = electron.views[0].webContents;
    wc.state.attached = false;
    wc.state.capabilities.receive = false;
    await f.poll();
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({ phase: 'waiting_sdk' }),
      }),
    );
    await expect(host!.verify(f.account.id)).rejects.toThrow();
    wc.state.attached = true;
    wc.state.capabilities.receive = true;
    await f.poll();
    expect(f.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({ phase: 'online' }),
      }),
    );
  });
  it('重新登录成其他身份时拒绝复用原账号的消息路由', async () => {
    const f = setup(true);
    await f.open();
    electron.views[0].webContents.identity.externalId = 'another-cs';
    await f.poll();
    expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'account' }));
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({ phase: 'error' }),
      }),
    );
    await expect(host!.verify(f.account.id)).rejects.toThrow();
  });
});

describe('拼多多发送回执', () => {
  const command = {
    id: 'outbound-test',
    token: 'dispatch-token',
    accountId: 'account-1',
    buyerId: 'buyer',
    kind: 'text' as const,
    text: '您好',
  };
  async function sendingFixture(initial: any, late: any) {
    const f = setup(true);
    await f.open();
    await f.poll();
    clearInterval([...(host as any).entries.values()][0].timer);
    const wc = electron.views[0].webContents;
    const original = wc.executeJavaScript.getMockImplementation();
    wc.executeJavaScript.mockImplementation(async (code: string) => {
      if (code.startsWith('window.__judeskBridge.send(')) return initial;
      if (code.startsWith('window.__judeskBridge.sends.get(')) return late;
      return original(code);
    });
    return { ...f, wc };
  }
  it('发送没有明确回执时保留桥接具体原因', async () => {
    vi.useFakeTimers();
    const result = { status: 'unknown', reason: '未观察到该命令提交请求，请查看平台窗口' };
    await sendingFixture(result, result);
    const sending = host!.send(command);
    await vi.advanceTimersByTimeAsync(3100);
    expect(await sending).toEqual(result);
  });
  it('等待阶段迟到的明确拒绝立即返回，不覆盖为 unknown', async () => {
    vi.useFakeTimers();
    const rejected = { status: 'rejected', reason: '拼多多拒绝发送（10006）：客服不在线' };
    const f = await sendingFixture({ status: 'unknown', reason: '待确认' }, rejected);
    const sending = host!.send(command);
    await vi.advanceTimersByTimeAsync(260);
    expect(await sending).toEqual(rejected);
    expect(
      f.wc.executeJavaScript.mock.calls.filter(([code]: [string]) =>
        code.startsWith('window.__judeskBridge.send('),
      ),
    ).toHaveLength(1);
  });
  it('迟到拒绝持久化完成后才 ACK；持久化失败保留事件供下一轮处理', async () => {
    const f = await sendingFixture(undefined, undefined);
    f.wc.state.events = [
      { type: 'send_rejected', outboundId: command.id, reason: '会话已关闭', sequence: 9 },
    ];
    const originalRequest = f.request.getMockImplementation()!;
    let stored = false;
    f.request.mockImplementation(async (data: any) => {
      if (data.type === 'send_rejected') throw new Error('temporary database failure');
      return originalRequest(data);
    });
    await f.poll();
    expect(f.wc.executeJavaScript).not.toHaveBeenCalledWith('window.__judeskBridge.ack(9)');
    const originalExecute = f.wc.executeJavaScript.getMockImplementation();
    f.wc.executeJavaScript.mockImplementation(async (code: string) => {
      if (code === 'window.__judeskBridge.ack(9)') expect(stored).toBe(true);
      return originalExecute(code);
    });
    f.request.mockImplementation(async (data: any) => {
      if (data.type === 'send_rejected') stored = true;
      return originalRequest(data);
    });
    await f.poll();
    expect(f.request).toHaveBeenCalledWith({
      type: 'send_rejected',
      outboundId: command.id,
      reason: '会话已关闭',
    });
    expect(f.wc.executeJavaScript).toHaveBeenCalledWith('window.__judeskBridge.ack(9)');
  });
});

it('订单备注在宿主中按买家重新核验，并在写入前请求业务服务复核；同 actionId 只执行一次', async () => {
  const f = setup(true);
  await f.open();
  await f.poll();
  const wc = electron.views[0].webContents;
  const oldExecute = wc.executeJavaScript.getMockImplementation();
  let note = '人工已有备注',
    tag = 2,
    writes = 0;
  wc.executeJavaScript.mockImplementation(async (code: string) => {
    if (code.startsWith('window.__judeskBridge.query(')) {
      expect(code).toContain('"buyerId":"buyer-1"');
      return { success: true, result: { orders: [{ orderSn: '260908-12345', uid: 'buyer-1' }] } };
    }
    if (code.startsWith('window.__judeskBridge.orderState('))
      return {
        note: { success: true, result: note },
        tag: { success: true, result: { tag, tagName: '黄色' } },
      };
    if (code.startsWith('window.__judeskBridge.writeOrderRemark(')) {
      const input = JSON.parse(code.slice('window.__judeskBridge.writeOrderRemark('.length, -1));
      writes++;
      note = input.remark;
      tag = input.remarkTag;
      expect(f.request).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'platform_action_guard' }),
      );
      return { success: true };
    }
    return oldExecute!(code);
  });
  const command = {
    id: 'cf6a0ff3-4f4f-4b4b-8b8b-aaaaaaaaaaaa',
    accountId: f.account.id,
    buyerId: 'buyer-1',
    orderSn: '260908-12345',
    page: 1,
    pageSize: 10,
    note: '请加固包装',
  };
  const [a, b] = await Promise.all([
    (host as PddHost).executeAction(command),
    (host as PddHost).executeAction(command),
  ]);
  expect(a.status).toBe('confirmed');
  expect(b).toEqual(a);
  expect(writes).toBe(1);
  expect(note).toBe('人工已有备注\n请加固包装');
  expect(tag).toBe(2);
});

it('宿主查询过程中登录身份变化，或业务服务在提交前取消，订单写入均被阻止', async () => {
  const f = setup(true);
  await f.open();
  await f.poll();
  const wc = electron.views[0].webContents;
  const oldExecute = wc.executeJavaScript.getMockImplementation();
  let changeIdentity = false,
    writes = 0;
  wc.executeJavaScript.mockImplementation(async (code: string) => {
    if (code.startsWith('window.__judeskBridge.query(')) {
      if (changeIdentity) wc.identity = { ...wc.identity, mallId: 'another-mall' };
      return { success: true, result: { orders: [{ orderSn: '260908-12345' }] } };
    }
    if (code.startsWith('window.__judeskBridge.orderState('))
      return { note: { success: true, result: '' }, tag: { success: true, result: {} } };
    if (code.startsWith('window.__judeskBridge.writeOrderRemark(')) {
      writes++;
      return { success: true };
    }
    return oldExecute!(code);
  });
  f.request.mockImplementation(async (data: any) => {
    if (data.type === 'platform_action_guard') throw new Error('STALE:买家发送了新消息');
    return { ok: true };
  });
  const command = {
    id: 'cf6a0ff3-4f4f-4b4b-8b8b-bbbbbbbbbbbb',
    accountId: f.account.id,
    buyerId: 'buyer-1',
    orderSn: '260908-12345',
    page: 1,
    pageSize: 10,
    note: '加固包装',
  };
  expect((await (host as PddHost).executeAction(command)).status).toBe('rejected');
  expect(writes).toBe(0);
  changeIdentity = true;
  expect(
    (
      await (host as PddHost).executeAction({
        ...command,
        id: 'cf6a0ff3-4f4f-4b4b-8b8b-cccccccccccc',
      })
    ).status,
  ).toBe('rejected');
  expect(writes).toBe(0);
});

it.each([true, false])('抖店评价邀请发送前再次核验当前买家订单，匹配=%s', async (matches) => {
  const account = {
    id: 'dy-account',
    storeId: 'dy-store',
    externalId: 'cs-1',
    sessionPartition: 'persist:dy-review-test',
  };
  host = new DouyinHost(
    'resources/douyin-bridge.js',
    async (data) => (data.type === 'account' ? account : {}),
    () => {},
  );
  await host.connect(account);
  const wc = electron.views[0].webContents;
  wc.url = DOUYIN_URL;
  await (host as any).poll([...(host as any).entries.values()][0]);
  const query = vi.spyOn(host, 'query').mockResolvedValue({
    operation: 'buyer-orders',
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: { orders: [{ orderSn: matches ? '123456789' : '999999999' }] },
  });
  const original = wc.executeJavaScript.getMockImplementation();
  wc.executeJavaScript.mockImplementation(async (code: string) =>
    code.startsWith('window.__judeskBridge.send(')
      ? { status: 'confirmed', externalId: 'review-message' }
      : original(code),
  );
  const result = await host.send({
    id: 'invite',
    token: 'local',
    accountId: account.id,
    buyerId: 'dy-buyer',
    conversationKey: 'dy-conversation',
    platformContext: { userId: 'dy-buyer' },
    kind: 'review_card',
    text: '邀请评价',
    richContent: { kind: 'review_card', orderSn: '123456789', title: '邀请评价' },
  });
  expect(query).toHaveBeenCalledWith(
    account.id,
    'buyer-orders',
    expect.objectContaining({ buyerId: 'dy-buyer', keyword: '123456789' }),
  );
  expect(result.status).toBe(matches ? 'confirmed' : 'rejected');
  expect(
    wc.executeJavaScript.mock.calls.filter(([code]: [string]) =>
      code.startsWith('window.__judeskBridge.send('),
    ),
  ).toHaveLength(matches ? 1 : 0);
});
it('抖店宿主复用隔离窗口与 ACK；注册平台身份，进入真实飞鸽入口并恢复收发能力', async () => {
  const account = {
    id: 'dy-account',
    storeId: 'dy-store',
    externalId: 'cs-1',
    sessionPartition: 'persist:dy-test',
  };
  const requests: any[] = [];
  host = new DouyinHost(
    'resources/douyin-bridge.js',
    async (data) => {
      requests.push(data);
      return data.type === 'account' ? account : {};
    },
    () => {},
  );
  await host.connect(account);
  const wc = electron.views[0].webContents;
  expect(wc.loadURL).toHaveBeenCalledWith(DOUYIN_LOGIN_URL);
  await (host as any).poll([...(host as any).entries.values()][0]);
  expect(requests.at(-1)).toMatchObject({ type: 'connection', input: { phase: 'needs_login' } });
  expect(wc.loadURL).toHaveBeenLastCalledWith(DOUYIN_LOGIN_URL);
  wc.url = 'https://sso.douyin.com/';
  await (host as any).poll([...(host as any).entries.values()][0]);
  expect(wc.loadURL).toHaveBeenLastCalledWith(DOUYIN_LOGIN_URL);
  wc.url = 'https://fxg.jinritemai.com/ffa/morder/order/list';
  await (host as any).poll([...(host as any).entries.values()][0]);
  expect(requests).toContainEqual(
    expect.objectContaining({
      type: 'connection',
      input: expect.objectContaining({ phase: 'waiting_chat' }),
    }),
  );
  expect(wc.loadURL).toHaveBeenLastCalledWith(DOUYIN_URL);
  wc.url = DOUYIN_URL;
  wc.state.events = [
    {
      type: 'message',
      sequence: 1,
      message: {
        messageId: 'dy-mid',
        conversationId: 'opaque-dy',
        buyerId: 'dy-buyer',
        buyerName: '抖店买家',
        direction: 'in',
        kind: 'text',
        text: '抖店咨询',
        timestamp: new Date().toISOString(),
        platformContext: { securityUserId: 'security-buyer' },
      },
    },
  ];
  await (host as any).poll([...(host as any).entries.values()][0]);
  expect(requests).toContainEqual(
    expect.objectContaining({
      type: 'account',
      input: expect.objectContaining({ platform: 'douyin', partition: account.sessionPartition }),
    }),
  );
  expect(requests).toContainEqual(
    expect.objectContaining({
      type: 'incoming',
      input: expect.objectContaining({
        accountId: account.id,
        externalId: 'dy-mid',
        conversationKey: 'opaque-dy',
      }),
    }),
  );
  expect(wc.executeJavaScript).toHaveBeenCalledWith('window.__judeskBridge.ack(1)');
  expect(requests).toContainEqual(
    expect.objectContaining({
      type: 'connection',
      input: expect.objectContaining({ phase: 'online' }),
    }),
  );
  wc.url = 'https://fxg.jinritemai.com/login';
  await (host as any).poll([...(host as any).entries.values()][0]);
  expect(requests.at(-1)).toMatchObject({ type: 'connection', input: { phase: 'needs_login' } });
  wc.url = DOUYIN_URL;
  const entry = [...(host as any).entries.values()][0];
  entry.identityValid = false;
  wc.executeJavaScript.mockImplementation(async (code: string) => {
    if (code === 'window.__judeskBridge.identity()') throw new Error('抖店登录身份不可用');
    if (code === 'window.__judeskBridge.poll()') return wc.state;
    return { installed: true };
  });
  await (host as any).poll(entry);
  expect(wc.loadURL).toHaveBeenLastCalledWith(DOUYIN_LOGIN_URL);
});
