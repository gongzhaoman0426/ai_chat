import { afterEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ windows: [] as any[], views: [] as any[], holdLoad: false }));
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
    url = 'about:blank';
    session = {
      setProxy: vi.fn(async () => {}),
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    setWindowOpenHandler = vi.fn();
    isDestroyed = () => false;
    close = vi.fn();
    getURL = () => this.url;
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      this.emit('dom-ready');
      if (electron.holdLoad) await new Promise(() => {});
      this.emit('did-finish-load');
    });
    executeJavaScript = vi.fn(async (code: string): Promise<any> => {
      if (code === 'window.__judeskBridge.identity()')
        return { externalId: '101', mallId: '101', name: '闲鱼账号', mallName: '闲鱼店铺' };
      if (code === 'window.__judeskBridge.poll()')
        return { attached: false, events: [], capabilities: { receive: false, sendText: false } };
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
  return { BrowserWindow: Window, WebContentsView: View, session: {} };
});
import { GoofishHost } from '../apps/desktop/src/main/goofish-host';
import { KuaishouHost } from '../apps/desktop/src/main/kuaishou-host';
import { KUAISHOU_LOGIN_URL } from '../packages/platforms/src/kuaishou';
let host: GoofishHost | KuaishouHost | undefined;
afterEach(() => {
  host?.close();
  host = undefined;
  electron.windows.length = 0;
  electron.views.length = 0;
  electron.holdLoad = false;
  vi.useRealTimers();
});
async function setup(platform: 'goofish' | 'kuaishou' = 'goofish') {
  const request = vi.fn(async (data: any) =>
    data.type === 'account'
      ? {
          id: 'account',
          externalId: data.input.externalId,
          storeId: 'store',
          sessionPartition: data.input.partition,
        }
      : { ok: true },
  );
  const notify = vi.fn();
  host =
    platform === 'kuaishou'
      ? new KuaishouHost('resources/kuaishou-bridge.js', request, notify)
      : new GoofishHost('resources/goofish-bridge.js', request, notify);
  await host.connect();
  const entry = [...(host as any).entries.values()][0];
  clearInterval(entry.timer);
  return {
    request,
    notify,
    entry,
    wc: electron.views[0].webContents,
    poll: () => (host as any).poll(entry),
  };
}

it('首次加载 Promise 未结束也启动识别；没有任何聊天和 IM 未就绪也注册已登录账号', async () => {
  electron.holdLoad = true;
  const f = await setup();
  await f.poll();
  expect(f.request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'account',
      input: expect.objectContaining({ platform: 'goofish', mallId: '101' }),
    }),
  );
  expect(f.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'connection',
      input: expect.objectContaining({ phase: 'waiting_sdk', accountId: 'account' }),
    }),
  );
});

it('快手没有买家消息且 SDK 未连接，也自动登记店铺；新账号分区隔离，重启复用原分区', async () => {
  const f = await setup('kuaishou');
  await f.wc.loadURL('https://im.kwaixiaodian.com/');
  await f.poll();
  expect(f.entry.partition).toMatch(/^persist:judesk-kuaishou-/);
  expect(f.request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'account',
      input: expect.objectContaining({ platform: 'kuaishou', partition: f.entry.partition }),
    }),
  );
  expect(f.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'connection',
      input: expect.objectContaining({ phase: 'waiting_sdk' }),
    }),
  );
  const account = { ...f.entry.account, sessionPartition: f.entry.partition };
  host!.close();
  await host!.restore([account]);
  expect([...(host as any).entries.keys()]).toEqual([account.sessionPartition]);
});

it('快手登录失效中转页自动跳转到官方登录地址', async () => {
  const f = await setup('kuaishou');
  f.wc.url =
    'https://im.kwaixiaodian.com/workbench/not-login?from_url=https%3A%2F%2Fim.kwaixiaodian.com%2F';
  await f.poll();
  expect(f.wc.loadURL).toHaveBeenCalledWith(KUAISHOU_LOGIN_URL);
});

it('登录跳转取消永不返回的旧身份检查；新页面注册，旧任务不能清除新任务的忙碌状态', async () => {
  const f = await setup();
  const normal = f.wc.executeJavaScript.getMockImplementation();
  let calls = 0;
  let finishNew: (v: unknown) => void = () => {};
  f.wc.executeJavaScript.mockImplementation((code: string) => {
    if (code === 'window.__judeskBridge.identity()') {
      calls++;
      if (calls === 1) return new Promise(() => {});
      return new Promise((resolve) => {
        finishNew = resolve;
      });
    }
    return normal(code);
  });
  const old = f.poll();
  await vi.waitFor(() => expect(calls).toBe(1));
  f.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  f.wc.emit('did-finish-load');
  const next = f.poll();
  await vi.waitFor(() => expect(calls).toBe(2));
  await old;
  expect(f.entry.busy).toBe(true);
  finishNew({ externalId: '101', mallId: '101', name: '账号', mallName: '店铺' });
  await next;
  expect(f.request.mock.calls.filter(([r]: any) => r.type === 'account')).toHaveLength(1);
  expect(f.entry.busy).toBe(false);
});

it('识别超时和首次连接错误可见，之后可重试；重复添加复用尚未识别的登录窗口', async () => {
  const f = await setup();
  await host!.connect();
  expect(electron.views).toHaveLength(1);
  // Let the reused-window poll finish before exercising its timeout.
  await vi.waitFor(() => expect(f.entry.busy).toBe(false));
  f.entry.account = undefined;
  f.entry.registered = false;
  f.entry.identityValid = false;
  vi.useFakeTimers();
  const normal = f.wc.executeJavaScript.getMockImplementation();
  f.wc.executeJavaScript.mockImplementation((code: string) =>
    code === 'window.__judeskBridge.identity()' ? new Promise(() => {}) : normal(code),
  );
  const pending = f.poll();
  await vi.advanceTimersByTimeAsync(15001);
  await pending;
  expect(f.notify).toHaveBeenCalledWith({
    type: 'connection_notice',
    message: expect.stringContaining('超时'),
  });
  expect(electron.windows[0].setTitle).toHaveBeenCalledWith(
    expect.stringContaining('账号识别未完成'),
  );
  expect(f.entry.busy).toBe(false);
  f.wc.executeJavaScript.mockImplementation(normal);
  await f.poll();
  expect(f.entry.registered).toBe(true);
});
