import { describe, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { generateQianniuInjectionScript } from '../packages/platforms/src/qianniu/bridge';
import { normalizeQianniuMessage, readQianniuMessages } from '../packages/platforms/src/qianniu';
import { QianniuHost, qianniuPartition } from '../apps/desktop/src/main/qianniu-host';
import type { QianniuTransport } from '../apps/desktop/src/main/qianniu-transport';

const config = {
  websocketUrl: 'ws://127.0.0.1:3000/qianniu-ws?token=one',
  scriptUrl: 'http://127.0.0.1:3000/qianniu-inject',
};
function harness() {
  const sockets: FakeSocket[] = [];
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const scripts: any[] = [];
  const listeners: Array<(value: unknown) => void> = [];
  const events = new Map<string, (value: unknown) => void>();
  class FakeSocket {
    readyState = 0;
    bufferedAmount = 0;
    sent: any[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(value: string) {
      this.sent.push(JSON.parse(value));
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    receive(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  const parent = { appendChild: (script: any) => scripts.push(script) };
  const page: any = { _vs: {}, _conversationId: { ccode: 'conversation' } };
  const sdk = {
    on: vi.fn((names: string[], fn: (value: unknown) => void) => {
      for (const name of names) events.set(name, fn);
      return listeners.push(fn);
    }),
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ result: [] })),
  };
  const context = createContext({
    window: page,
    WebSocket: FakeSocket,
    document: {
      head: parent,
      body: parent,
      documentElement: parent,
      createElement: () => ({ remove() {} }),
    },
    setInterval: (callback: () => void, ms: number) => intervals.push({ callback, ms }),
    sdk,
  });
  runInContext('let imsdk; let TASK_CACHE = {};', context);
  const source = generateQianniuInjectionScript(config);
  runInContext(source, context);
  const tick = () => intervals.find((item) => item.ms === 1000)!.callback();
  const flush = () => intervals.find((item) => item.ms === 3000)!.callback();
  const ready = (loginId: string | { nick?: unknown; targetId?: unknown } = 'seller') => {
    page._vs.loginID = loginId;
    runInContext(
      'imsdk = sdk; window.onInvokeNotify = function(sid) { delete TASK_CACHE[sid]; return 42; };',
      context,
    );
    tick();
    sockets.at(-1)!.open();
  };
  const notify = (message: any, live = true) => {
    if (live) listeners[0]([{ ccode: 'conversation' }]);
    runInContext(
      'TASK_CACHE.task = { config: { fn: "im.singlemsg.GetNewMsg", param: { ccode: "conversation" } } };',
      context,
    );
    return page.onInvokeNotify('task', 0, JSON.stringify({ result: [message] }));
  };
  return {
    page,
    sockets,
    scripts,
    listeners,
    emit: (name: string, value: unknown) => events.get(name)?.(value),
    sdk,
    source,
    context,
    tick,
    flush,
    ready,
    notify,
    intervals,
  };
}

describe('Qianniu page bridge', () => {
  it('announces a Qianniu 9.52 subaccount nickname and uses it as message provenance', () => {
    const app = harness();
    app.ready({ nick: ' 店铺:客服 ', targetId: '98765' });
    const socket = app.sockets.at(-1)!;
    expect(socket.sent).toContainEqual({
      type: 'hello',
      identity: { loginId: '店铺:客服' },
    });
    app.notify({ msgid: 'subaccount-message' });
    expect(socket.sent.find((message) => message.type === 'messages')).toMatchObject({
      loginId: '店铺:客服',
      data: {
        result: [{ msgid: 'subaccount-message' }],
        __judesk: { loginId: '店铺:客服', historical: false },
      },
    });
  });

  it.each([undefined, null, '', '   ', 98765, ['店铺:客服'], 'x'.repeat(201)])(
    'does not use a numeric targetId when the login nickname is invalid: %j',
    (nick) => {
      const app = harness();
      app.ready({ nick, targetId: '98765' });
      app.notify({ msgid: 'unbound-message' });
      app.flush();
      expect(app.sockets.at(-1)!.sent).toEqual([]);
    },
  );

  it('isolates accounts when the Qianniu login object nickname changes in place', () => {
    const app = harness();
    const identity = { nick: '店铺:客服甲', targetId: '98765' };
    app.ready(identity);
    const old = app.sockets.at(-1)!;
    app.notify({ msgid: 'a' });
    const original = old.sent.find((message) => message.type === 'messages');

    identity.nick = '店铺:客服乙';
    old.receive({
      type: 'invoke',
      loginId: '店铺:客服甲',
      requestId: 'old',
      method: 'send',
      params: {},
    });
    expect(app.sdk.invoke).not.toHaveBeenCalled();
    expect(old.readyState).toBe(3);
    expect(old.sent.some((message) => message.type === 'response')).toBe(false);

    app.tick();
    const current = app.sockets.at(-1)!;
    current.open();
    expect(current.sent).toEqual([{ type: 'hello', identity: { loginId: '店铺:客服乙' } }]);
    app.notify({ msgid: 'b' }, false);
    expect(current.sent.find((message) => message.type === 'messages')).toMatchObject({
      loginId: '店铺:客服乙',
      data: { __judesk: { loginId: '店铺:客服乙', historical: true } },
    });

    identity.nick = '店铺:客服甲';
    app.tick();
    const previous = app.sockets.at(-1)!;
    previous.open();
    expect(current.readyState).toBe(3);
    expect(previous.sent).toContainEqual(original);
    expect(previous.sent.some((message) => message.loginId === '店铺:客服乙')).toBe(false);
  });

  it('retries a failed SDK subscription without announcing a receive-ready page', () => {
    const app = harness();
    app.sdk.on.mockImplementationOnce(() => {
      throw new Error('SDK not ready');
    });
    app.ready();
    expect(app.sockets.at(-1)!.sent).toEqual([]);
    app.tick();
    app.sockets.at(-1)!.open();
    expect(app.sockets.at(-1)!.sent).toContainEqual({
      type: 'hello',
      identity: { loginId: 'seller' },
    });
    expect(app.sdk.on).toHaveBeenCalledTimes(4);
  });

  it('waits for lexical SDK and callback readiness, then wraps without disrupting the original delegate', () => {
    const app = harness();
    app.page._vs.loginID = 'seller';
    app.tick();
    app.sockets.at(-1)!.open();
    expect(app.sockets.at(-1)!.sent).toEqual([]);
    expect(app.scripts[0].src).toBe('https://iseiya.taobao.com/imsupport');
    app.ready();
    const socket = app.sockets.at(-1)!;
    expect(socket.sent).toContainEqual({ type: 'hello', identity: { loginId: 'seller' } });
    expect(app.notify({ msgid: 'm1' })).toBe(42);
    const delivered = socket.sent.find((message) => message.type === 'messages');
    expect(delivered.data).toMatchObject({
      result: [{ msgid: 'm1' }],
      __judesk: { loginId: 'seller', historical: false },
    });
    expect(runInContext('TASK_CACHE.task', app.context)).toBeUndefined();
    app.tick();
    expect(app.sdk.on).toHaveBeenCalledTimes(3);
  });

  it('replays unacknowledged deliveries after reconnect and clears only the matching ACK', () => {
    const app = harness();
    app.ready();
    const old = app.sockets.at(-1)!;
    app.notify({ msgid: 'm1' });
    const delivered = old.sent.find((message) => message.type === 'messages');
    old.close();
    app.tick();
    const next = app.sockets.at(-1)!;
    next.open();
    expect(next.sent).toContainEqual(delivered);
    next.receive({ type: 'ack', loginId: 'wrong', eventKey: delivered.eventKey });
    next.sent = [];
    app.flush();
    expect(next.sent).toEqual([delivered]);
    next.receive({ type: 'ack', loginId: 'seller', eventKey: delivered.eventKey });
    next.sent = [];
    app.flush();
    expect(next.sent).toEqual([]);
  });

  it('renews the socket secret by reloading the fixed URL without duplicate hooks or timers', () => {
    const app = harness();
    app.ready();
    app.sockets.at(-1)!.close();
    expect(app.scripts.some((script) => script.src.startsWith(`${config.scriptUrl}?reload=`))).toBe(
      true,
    );
    runInContext(
      generateQianniuInjectionScript({
        ...config,
        websocketUrl: config.websocketUrl.replace('one', 'two'),
      }),
      app.context,
    );
    expect(app.sockets.at(-1)!.url).toContain('token=two');
    expect(app.intervals).toHaveLength(2);
    expect(app.sdk.on).toHaveBeenCalledTimes(3);
  });

  it('keeps buffered messages bound to their original login and clears live provenance on account changes', () => {
    const app = harness();
    app.ready('seller-a');
    app.notify({ msgid: 'a' });
    const original = app.sockets.at(-1)!.sent.find((message) => message.type === 'messages');
    app.page._vs.loginID = 'seller-b';
    app.tick();
    const other = app.sockets.at(-1)!;
    other.open();
    expect(other.sent.some((message) => message.type === 'messages')).toBe(false);
    app.notify({ msgid: 'b' }, false);
    expect(other.sent.find((message) => message.type === 'messages').data.__judesk.historical).toBe(
      true,
    );
    app.page._vs.loginID = 'seller-a';
    app.tick();
    const previous = app.sockets.at(-1)!;
    previous.open();
    expect(previous.sent).toContainEqual(original);
    expect(previous.sent.some((message) => message.loginId === 'seller-b')).toBe(false);
  });

  it('bounds its unacknowledged delivery buffer', () => {
    const app = harness();
    app.ready();
    const socket = app.sockets.at(-1)!;
    socket.readyState = 0;
    for (let i = 0; i < 550; i++) app.notify({ msgid: String(i) });
    socket.sent = [];
    socket.readyState = 1;
    app.flush();
    expect(socket.sent).toHaveLength(500);
    expect(socket.sent[0].data.result[0].msgid).toBe('50');
  });

  it('binds the first incoming event after an account switch before the next polling tick', () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    app.page._vs.loginID = 'seller-b';
    app.notify({ msgid: 'first-b' });
    expect(old.readyState).toBe(3);
    expect(old.sent.some((message) => message.type === 'messages')).toBe(false);
    const current = app.sockets.at(-1)!;
    current.open();
    expect(current.sent.find((message) => message.type === 'messages')).toMatchObject({
      loginId: 'seller-b',
      data: {
        result: [{ msgid: 'first-b' }],
        __judesk: { loginId: 'seller-b', historical: false },
      },
    });
  });

  it('does not assign a newly created active-conversation task to the previous login', () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    app.page._vs.loginID = 'seller-b';
    runInContext(
      'TASK_CACHE.firstB = { config: { fn: "im.singlemsg.GetNewMsg", param: { ccode: "conversation" } } };',
      app.context,
    );
    app.listeners[0]([{ ccode: 'conversation' }]);
    app.page.onInvokeNotify('firstB', 0, JSON.stringify({ result: [{ msgid: 'first-b' }] }));
    const current = app.sockets.at(-1)!;
    current.open();
    expect(old.sent.some((message) => message.type === 'messages')).toBe(false);
    expect(current.sent.find((message) => message.type === 'messages')).toMatchObject({
      loginId: 'seller-b',
      data: {
        result: [{ msgid: 'first-b' }],
        __judesk: { loginId: 'seller-b', historical: false },
      },
    });
  });

  it('refreshes login for direct native callbacks even without a ReceiveNewMsg event', () => {
    const app = harness();
    app.ready('seller-a');
    app.page._vs.loginID = 'seller-b';
    app.notify({ msgid: 'outgoing-b' }, false);
    const current = app.sockets.at(-1)!;
    current.open();
    expect(current.sent.find((message) => message.type === 'messages')).toMatchObject({
      loginId: 'seller-b',
      data: { result: [{ msgid: 'outgoing-b' }], __judesk: { loginId: 'seller-b' } },
    });
  });

  it('never invokes an old account command when the page switched before the next polling tick', () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    app.page._vs.loginID = 'seller-b';
    old.receive({
      type: 'invoke',
      loginId: 'seller-a',
      requestId: 'old',
      method: 'send',
      params: {},
    });
    expect(app.sdk.invoke).not.toHaveBeenCalled();
    expect(old.readyState).toBe(3);
    expect(old.sent.some((message) => message.type === 'response')).toBe(false);
  });

  it('does not return an SDK result from a page that switched accounts while awaiting it', async () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    let resolve!: (result: Awaited<ReturnType<typeof app.sdk.invoke>>) => void;
    app.sdk.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    old.receive({
      type: 'invoke',
      loginId: 'seller-a',
      requestId: 'old',
      method: 'query',
      params: {},
    });
    app.page._vs.loginID = 'seller-b';
    resolve({ result: [] });
    await vi.waitFor(() => expect(old.readyState).toBe(3));
    expect(old.sent.some((message) => message.type === 'response')).toBe(false);
  });

  it('converts a legacy host GetNewMsg request to PeekNewMsg and replays its result until ACK', async () => {
    const app = harness();
    app.ready('seller');
    const socket = app.sockets.at(-1)!;
    const raw = {
      mcode: { messageId: 'server-outgoing-id' },
      cid: { ccode: 'conversation' },
      fromid: { targetId: 'seller' },
      toid: { targetId: 'buyer' },
      loginid: { targetId: 'seller' },
      timestamp: Date.now(),
      originalData: { text: '你好' },
    };
    app.sdk.invoke.mockResolvedValueOnce({ result: [raw] });
    socket.receive({
      type: 'invoke',
      loginId: 'seller',
      requestId: 'pull-echo',
      method: 'im.singlemsg.GetNewMsg',
      params: { ccode: 'conversation' },
    });
    await vi.waitFor(() => expect(socket.sent.some((item) => item.type === 'response')).toBe(true));
    expect(app.sdk.invoke).toHaveBeenCalledWith('im.singlemsg.PeekNewMsg', {
      ccode: 'conversation',
    });
    const delivery = socket.sent.find((item) => item.type === 'messages');
    expect(delivery).toMatchObject({ loginId: 'seller', data: { result: [raw] } });
    expect(
      normalizeQianniuMessage(readQianniuMessages(delivery.data)[0], 'account', 'seller', 'echo'),
    ).toMatchObject({ externalId: 'server-outgoing-id', direction: 'out', historical: false });
    socket.sent = [];
    app.flush();
    expect(socket.sent).toEqual([delivery]);
    socket.receive({ type: 'ack', loginId: 'seller', eventKey: delivery.eventKey });
    socket.sent = [];
    app.flush();
    expect(socket.sent).toEqual([]);
  });

  it('does not capture a host-requested pull after the page changes accounts', async () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    let finish!: (data: any) => void;
    app.sdk.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    old.receive({
      type: 'invoke',
      loginId: 'seller-a',
      requestId: 'old-pull',
      method: 'im.singlemsg.GetNewMsg',
      params: { ccode: 'conversation' },
    });
    app.page._vs.loginID = 'seller-b';
    finish({ result: [{ msgid: 'old-message' }] });
    await vi.waitFor(() => expect(old.readyState).toBe(3));
    app.tick();
    const next = app.sockets.at(-1)!;
    next.open();
    app.flush();
    expect([...old.sent, ...next.sent].some((item) => item.type === 'messages')).toBe(false);
  });

  it('peeks at the currently open conversation without consuming the native UI queue', async () => {
    const app = harness();
    app.ready('seller');
    app.sdk.invoke.mockResolvedValueOnce({ result: [{ msgid: 'open-chat' }] });
    app.listeners[0]([{ ccode: 'conversation' }]);
    await vi.waitFor(() =>
      expect(app.sdk.invoke).toHaveBeenCalledWith('im.singlemsg.PeekNewMsg', {
        ccode: 'conversation',
      }),
    );
    await vi.waitFor(() =>
      expect(app.sockets.at(-1)!.sent.find((message) => message.type === 'messages')).toMatchObject(
        {
          loginId: 'seller',
          data: {
            result: [{ msgid: 'open-chat' }],
            __judesk: { loginId: 'seller', historical: false },
          },
        },
      ),
    );
  });

  it('accepts wrapped or single-conversation ReceiveNewMsg payloads', async () => {
    const app = harness();
    app.ready('seller');
    app.sdk.invoke.mockResolvedValue({ result: [{ msgid: 'wrapped' }] });
    app.listeners[0]({ result: [{ ccode: 'conversation-b' }] });
    await vi.waitFor(() =>
      expect(app.sdk.invoke).toHaveBeenCalledWith('im.singlemsg.PeekNewMsg', {
        ccode: 'conversation-b',
      }),
    );
    app.sdk.invoke.mockClear();
    app.sdk.invoke.mockResolvedValue({ result: [{ msgid: 'single' }] });
    app.listeners[0]({ ccode: 'conversation-c' });
    await vi.waitFor(() =>
      expect(app.sdk.invoke).toHaveBeenCalledWith('im.singlemsg.PeekNewMsg', {
        ccode: 'conversation-c',
      }),
    );
  });

  it('retries a partial subscription without registering the receive listener twice', () => {
    const app = harness();
    const subscribe = app.sdk.on.getMockImplementation()!;
    app.sdk.on.mockImplementationOnce(subscribe).mockImplementationOnce(() => {
      throw new Error('send events not ready');
    });
    app.ready();
    app.tick();
    expect(
      app.sdk.on.mock.calls.filter(([names]) => names.includes('im.singlemsg.onReceiveNewMsg')),
    ).toHaveLength(1);
    expect(
      app.sdk.on.mock.calls.filter(([names]) => names.includes('im.singlemsg.onMsgSendUpdate')),
    ).toHaveLength(1);
  });

  it('pulls messages on SendNewMsg even without an inbound notification', async () => {
    const app = harness();
    app.ready('seller');
    app.emit('im.singlemsg.onSendNewMsg', [
      { cid: { ccode: 'conversation' }, mcode: { clientId: 'local-1' } },
    ]);
    await vi.waitFor(() =>
      expect(app.sdk.invoke).toHaveBeenCalledWith('im.singlemsg.PeekNewMsg', {
        ccode: 'conversation',
      }),
    );
  });

  it.each(['send-event', 'receive-event', 'host-peek', 'legacy-host-get'])(
    'leaves the native new-message queue intact after %s so Qianniu can render sent messages',
    async (source) => {
      const app = harness();
      app.ready('seller');
      const message = {
        cid: { ccode: 'conversation' },
        mcode: { messageId: 'server-id', clientId: 'local-id' },
        status: 0,
        sendTime: Date.now(),
        fromid: { targetId: 'seller' },
        toid: { targetId: 'buyer' },
        loginid: { targetId: 'seller' },
        originalData: { text: '界面应显示这条消息' },
      };
      const nativeQueue = [message];
      app.sdk.invoke.mockImplementation(async (method) => {
        if (method === 'im.singlemsg.GetNewMsg') return { result: nativeQueue.splice(0) };
        if (method === 'im.singlemsg.PeekNewMsg') return { result: [...nativeQueue] };
        throw new Error(`Unexpected method ${method}`);
      });
      if (source === 'send-event') {
        app.emit('im.singlemsg.onSendNewMsg', [{ cid: message.cid, mcode: message.mcode }]);
      } else if (source === 'receive-event') {
        app.emit('im.singlemsg.onReceiveNewMsg', [message.cid]);
      } else {
        app.sockets.at(-1)!.receive({
          type: 'invoke',
          loginId: 'seller',
          requestId: 'peek-test',
          method: source === 'host-peek' ? 'im.singlemsg.PeekNewMsg' : 'im.singlemsg.GetNewMsg',
          params: { ccode: 'conversation' },
        });
      }
      await vi.waitFor(() =>
        expect(app.sockets.at(-1)!.sent.some((item) => item.type === 'messages')).toBe(true),
      );
      // The page's normal receive/render path must still receive the entire message.
      expect(await app.sdk.invoke('im.singlemsg.GetNewMsg', { ccode: 'conversation' })).toEqual({
        result: [message],
      });
    },
  );

  it.each(['message-first', 'status-first'])(
    'confirms a native client-only message when the original-message API uses code instead of mcode: %s',
    async (order) => {
      const app = harness();
      app.ready({ nick: 'shop:staff', targetId: '1001' });
      const sendTime = Date.now();
      const pending = {
        templateId: 101,
        mcode: { messageId: '', clientId: '7511016228278763000' },
        cid: { ccode: 'conversation' },
        fromid: { targetId: '1001', nick: 'shop:staff' },
        toid: { targetId: '2001', nick: 'buyer' },
        loginid: { targetId: '1001', nick: 'shop:staff' },
        sendTime: sendTime - 20,
        status: 1,
        originalData: { jsview: [{ type: 0, value: { text: '相同的回复' } }] },
      };
      const update = {
        cid: pending.cid,
        mcode: { clientId: pending.mcode.clientId, messageId: '4324952821000.PNM' },
        sendStatus: 0,
        sendTime,
      };
      // Actual 9.52 callback observed in AliRender.log: this is not a Banama
      // message. The complete native message and status delta are sufficient.
      app.sdk.invoke.mockResolvedValue([{ msgType: 101, code: update.mcode }]);
      if (order === 'message-first') app.notify(pending, false);
      app.emit('im.singlemsg.onMsgSendUpdate', [update]);
      if (order === 'status-first') {
        await vi.waitFor(() => expect(app.sdk.invoke).toHaveBeenCalled());
        app.notify(pending, false);
      }
      await vi.waitFor(() => {
        const normalized = app.sockets
          .at(-1)!
          .sent.filter((item) => item.type === 'messages')
          .flatMap((item) => readQianniuMessages(item.data))
          .map((raw) => normalizeQianniuMessage(raw, 'account', 'shop:staff', 'receipt'))
          .filter(Boolean);
        expect(normalized).toEqual([
          expect.objectContaining({
            externalId: update.mcode.messageId,
            conversationKey: 'conversation',
            buyerId: '2001',
            direction: 'out',
            text: '相同的回复',
            timestamp: new Date(sendTime).toISOString(),
            historical: false,
          }),
        ]);
      });
      expect(pending.status).toBe(1);
      expect(pending.mcode.messageId).toBe('');
    },
  );

  it.each(['client', 'conversation', 'account', 'failed', 'server-id'])(
    'does not join a native message to a mismatched %s receipt',
    async (mismatch) => {
      const app = harness();
      app.ready('seller');
      const pending = {
        cid: { ccode: 'conversation' },
        mcode: { clientId: 'local', messageId: mismatch === 'server-id' ? 'different-id' : '' },
        fromid: { targetId: 'seller' },
        toid: { targetId: 'buyer' },
        sendTime: Date.now(),
        status: 1,
        originalData: { text: '相同的回复' },
      };
      app.notify(pending, false);
      app.sockets.at(-1)!.sent = [];
      if (mismatch === 'account') app.ready('other-seller');
      app.emit('im.singlemsg.onMsgSendUpdate', [
        {
          cid: { ccode: mismatch === 'conversation' ? 'other-conversation' : 'conversation' },
          mcode: {
            clientId: mismatch === 'client' ? 'other-client' : 'local',
            messageId: 'server-id',
          },
          sendStatus: mismatch === 'failed' ? 13 : 0,
          sendTime: Date.now(),
        },
      ]);
      await Promise.resolve();
      await Promise.resolve();
      expect(app.sockets.at(-1)!.sent.some((item) => item.type === 'messages')).toBe(false);
    },
  );

  it('retrieves distinct server messages for repeated text after client-only sends get their IDs', async () => {
    const app = harness();
    app.ready('seller');
    const raw = (id: string) => ({
      cid: { ccode: 'conversation' },
      mcode: { messageId: id, clientId: `local-${id}` },
      fromid: { targetId: 'seller' },
      toid: { targetId: 'buyer' },
      loginid: { targetId: 'seller' },
      sendTime: Date.now(),
      status: 0,
      originalData: { text: '相同的回复' },
    });
    app.notify(raw('0'), false);
    const initial = app.sockets.at(-1)!.sent.find((item) => item.type === 'messages');
    expect(
      normalizeQianniuMessage(readQianniuMessages(initial.data)[0], 'account', 'seller', 'initial'),
    ).toBeNull();
    app.sockets.at(-1)!.receive({ type: 'ack', loginId: 'seller', eventKey: initial.eventKey });
    app.sockets.at(-1)!.sent = [];
    app.sdk.invoke.mockImplementation(async (method: any, params: any) => {
      expect(method).toBe('im.singlemsg.GetOriginalMsgByID');
      return [raw(params.mcodes[0].messageId)];
    });
    for (const id of ['server-1', 'server-2']) {
      app.emit('im.singlemsg.onMsgSendUpdate', [
        {
          cid: { ccode: 'conversation' },
          mcode: { messageId: id, clientId: `local-${id}` },
          sendStatus: 0,
        },
      ]);
    }
    await vi.waitFor(() => expect(app.sdk.invoke).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const deliveries = app.sockets.at(-1)!.sent.filter((item) => item.type === 'messages');
      const ids = new Set(
        deliveries.map((item) => {
          const message = normalizeQianniuMessage(
            readQianniuMessages(item.data)[0],
            'account',
            'seller',
            'echo',
          );
          expect(message).toMatchObject({
            direction: 'out',
            historical: false,
            text: '相同的回复',
          });
          return message!.externalId;
        }),
      );
      expect([...ids]).toEqual(['server-1', 'server-2']);
    });
  });

  it.each([
    { sendStatus: 13, messageId: 'failed-id' },
    { sendStatus: 1, messageId: 'pending-id' },
    { sendStatus: 0, messageId: '0' },
    { sendStatus: 0, messageId: undefined },
  ])(
    'does not treat pending or failed native status as delivery: %j',
    async ({ sendStatus, messageId }) => {
      const app = harness();
      app.ready('seller');
      app.emit('im.singlemsg.onMsgSendUpdate', [
        { cid: { ccode: 'conversation' }, mcode: { messageId, clientId: 'local' }, sendStatus },
      ]);
      await Promise.resolve();
      expect(app.sdk.invoke).not.toHaveBeenCalled();
      expect(app.sockets.at(-1)!.sent.some((item) => item.type === 'messages')).toBe(false);
    },
  );

  it('ignores a receipt lookup returning another conversation or server ID', async () => {
    const app = harness();
    app.ready('seller');
    app.sdk.invoke.mockResolvedValueOnce([
      { cid: { ccode: 'other' }, mcode: { messageId: 'wanted' }, status: 0 },
      { cid: { ccode: 'conversation' }, mcode: { messageId: 'different' }, status: 0 },
      { cid: { ccode: 'conversation' }, mcode: { messageId: 'wanted' }, status: 13 },
    ]);
    app.emit('im.singlemsg.onMsgSendUpdate', [
      { cid: { ccode: 'conversation' }, mcode: { messageId: 'wanted' }, sendStatus: 0 },
    ]);
    await vi.waitFor(() => expect(app.sdk.invoke).toHaveBeenCalledOnce());
    expect(app.sockets.at(-1)!.sent.some((item) => item.type === 'messages')).toBe(false);
  });

  it('discards receipt lookups across account changes and coalesces duplicate updates', async () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    let finish!: (value: unknown) => void;
    app.sdk.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const update = [
      { cid: { ccode: 'conversation' }, mcode: { messageId: 'server-id' }, sendStatus: 0 },
    ];
    app.emit('im.singlemsg.onMsgSendUpdate', update);
    app.emit('im.singlemsg.onMsgSendUpdate', update);
    await vi.waitFor(() => expect(app.sdk.invoke).toHaveBeenCalledOnce());
    app.page._vs.loginID = 'seller-b';
    finish([{ cid: { ccode: 'conversation' }, mcode: { messageId: 'server-id' }, status: 0 }]);
    await vi.waitFor(() => expect(old.readyState).toBe(3));
    app.tick();
    app.sockets.at(-1)!.open();
    app.flush();
    expect(app.sockets.at(-1)!.sent.some((item) => item.type === 'messages')).toBe(false);
  });

  it.each(['native-cache', 'original-lookup'])(
    'confirms repeated sends through the page status event and real host normalizer using %s',
    async (receiptSource) => {
      const app = harness();
      app.ready('seller');
      let sequence = 0;
      const messages = new Map<string, unknown>();
      const transport = Object.assign(new EventEmitter(), {
        start: async () => {},
        close: async () => {},
        states: () => [
          { loginId: 'seller', identity: { loginId: 'seller' }, websocket: true, tcp: true },
        ],
        invoke: async () => ({ result: [] }),
        send: vi.fn(
          async (_login: string, _method: string, params: any, onDispatch: () => void) => {
            onDispatch();
            const id = `server-${++sequence}`;
            const cid = { ccode: params.id };
            const mcode = { messageId: id, clientId: `local-${sequence}` };
            messages.set(id, {
              cid,
              mcode,
              status: 0,
              sendTime: Date.now(),
              fromid: { targetId: 'seller' },
              toid: { targetId: 'buyer' },
              loginid: { targetId: 'seller' },
              originalData: { text: params.text },
            });
            if (receiptSource === 'native-cache') {
              app.notify(
                {
                  ...(messages.get(id) as Record<string, unknown>),
                  mcode: { ...mcode, messageId: '' },
                  status: 1,
                },
                false,
              );
            }
            // GetNewMsg was already consumed by Qianniu. Only its status delta arrives.
            queueMicrotask(() =>
              app.emit('im.singlemsg.onMsgSendUpdate', [{ cid, mcode, sendStatus: 0 }]),
            );
            return { result: 'success' };
          },
        ),
      });
      app.sdk.invoke.mockImplementation(async (method: any, params: any) => {
        expect(method).toBe('im.singlemsg.GetOriginalMsgByID');
        if (receiptSource === 'native-cache') return [{ msgType: 101, code: params.mcodes[0] }];
        return [messages.get(params.mcodes[0].messageId)];
      });
      const request = vi.fn(async (data: any) => {
        if (data.type === 'account')
          return {
            id: 'account',
            externalId: 'seller',
            storeId: 'store',
            sessionPartition: qianniuPartition('seller'),
          };
        if (data.type === 'call') return [];
      });
      const host = new QianniuHost({
        transport: transport as unknown as QianniuTransport,
        request,
        notify: () => {},
        platform: 'win32',
        imageDirectory: tmpdir(),
        native: { start: async () => {}, onLogin: async () => {} },
      });
      const socket = app.sockets.at(-1)!;
      const originalSend = socket.send.bind(socket);
      socket.send = (payload: string) => {
        originalSend(payload);
        const envelope = JSON.parse(payload);
        if (envelope.type === 'messages')
          transport.emit('message', envelope, () => {
            socket.receive({ type: 'ack', loginId: envelope.loginId, eventKey: envelope.eventKey });
          });
      };
      try {
        await host.start();
        transport.emit('identity', { loginId: 'seller' });
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection' })),
        );
        for (const n of [1, 2]) {
          expect(
            await host.send({
              id: `out-${n}`,
              token: `token-${n}`,
              accountId: 'account',
              buyerId: 'buyer',
              conversationKey: 'conversation',
              kind: 'text',
              text: '相同的回复',
            }),
          ).toEqual({ status: 'confirmed', externalId: `server-${n}` });
          expect(request).toHaveBeenCalledWith({
            type: 'confirmed',
            outboundId: `out-${n}`,
            externalId: `server-${n}`,
          });
        }
        expect(transport.send).toHaveBeenCalledTimes(2);
        if (receiptSource === 'native-cache') expect(app.sdk.invoke).not.toHaveBeenCalled();
        expect(request.mock.calls.some(([data]) => data.type === 'incoming')).toBe(false);
      } finally {
        await host.close();
      }
    },
  );

  it('does not query another account when login changes before queued PeekNewMsg runs', async () => {
    const app = harness();
    app.ready('seller-a');
    const old = app.sockets.at(-1)!;
    app.listeners[0]([{ ccode: 'another-conversation' }]);
    app.page._vs.loginID = 'seller-b';
    await vi.waitFor(() => expect(old.readyState).toBe(3));
    expect(app.sdk.invoke).not.toHaveBeenCalled();
  });

  it('keeps an old GetNewMsg callback attached to its originating account after switching login', () => {
    const app = harness();
    app.ready('seller-a');
    runInContext(
      'TASK_CACHE.delayed = { config: { fn: "im.singlemsg.GetNewMsg", param: { ccode: "conversation-a" } } };',
      app.context,
    );
    app.tick(); // Its old-account provenance is observed before the page switches.
    app.page._vs.loginID = 'seller-b';
    app.tick();
    const current = app.sockets.at(-1)!;
    current.open();
    app.page.onInvokeNotify('delayed', 0, JSON.stringify({ result: [{ msgid: 'delayed-a' }] }));
    app.flush();
    expect(current.sent.some((message) => message.type === 'messages')).toBe(false);
    app.page._vs.loginID = 'seller-a';
    app.tick();
    const previous = app.sockets.at(-1)!;
    previous.open();
    expect(previous.sent.find((message) => message.type === 'messages')).toMatchObject({
      loginId: 'seller-a',
      data: {
        result: [{ msgid: 'delayed-a' }],
        __judesk: { loginId: 'seller-a', historical: true },
      },
    });
  });
});

describe('Qianniu message normalization', () => {
  const raw = {
    msgid: 'real-message-id',
    cid: { ccode: 'buyer.1-seller.1#11001@cntaobao' },
    fromid: { targetId: 'buyer', nick: '买家' },
    toid: { targetId: 'seller' },
    loginid: { targetId: 'seller' },
    originalData: { text: '你好' },
    timestamp: 1900000000,
    __judesk: { loginId: 'seller', startedAt: 1800000000000, historical: false },
  };
  it('normalizes actual IDs and preserves provenance through envelopes', () => {
    const messages = readQianniuMessages(JSON.stringify({ result: [raw], __judesk: raw.__judesk }));
    const message = normalizeQianniuMessage(messages[0], 'account', 'seller', 'delivery');
    expect(message).toMatchObject({
      accountId: 'account',
      externalId: 'real-message-id',
      eventKey: 'message:real-message-id',
      buyerId: 'buyer',
      direction: 'in',
      origin: 'buyer',
      text: '你好',
      historical: false,
      timestamp: new Date(1900000000000).toISOString(),
    });
  });
  it('preserves human outgoing messages and refuses unknown/mismatched identities', () => {
    const outgoing = { ...raw, fromid: { targetId: 'seller' }, toid: { targetId: 'buyer' } };
    expect(normalizeQianniuMessage(outgoing, 'account', 'seller', 'delivery')).toMatchObject({
      direction: 'out',
      origin: 'human',
      buyerId: 'buyer',
    });
    expect(normalizeQianniuMessage(raw, 'account', 'other', 'delivery')).toBeNull();
    expect(
      normalizeQianniuMessage({ ...raw, msgid: undefined }, 'account', 'seller', 'delivery'),
    ).toBeNull();
    expect(
      normalizeQianniuMessage({ ...raw, cid: undefined }, 'account', 'seller', 'delivery'),
    ).toBeNull();
  });
  it('marks missing timestamps, backlog, and unproven capture as historical', () => {
    for (const message of [
      { ...raw, timestamp: undefined },
      { ...raw, timestamp: 1700000000 },
      { ...raw, __judesk: {} },
    ]) {
      expect(normalizeQianniuMessage(message, 'account', 'seller', 'delivery')?.historical).toBe(
        true,
      );
    }
    expect(readQianniuMessages('{bad json')).toEqual([]);
    expect(readQianniuMessages({ unexpected: 'event' })).toEqual([]);
  });

  it('keeps a fresh seller send live even when this client emits no inbound notification for it', () => {
    const outgoing = {
      ...raw,
      fromid: { targetId: 'seller' },
      toid: { targetId: 'buyer' },
      __judesk: { ...raw.__judesk, historical: true },
    };
    expect(normalizeQianniuMessage(outgoing, 'account', 'seller', 'delivery')).toMatchObject({
      direction: 'out',
      historical: false,
    });
    expect(
      normalizeQianniuMessage({ ...outgoing, isHistory: true }, 'account', 'seller', 'delivery')
        ?.historical,
    ).toBe(true);
    expect(
      normalizeQianniuMessage(
        { ...outgoing, timestamp: 1700000000 },
        'account',
        'seller',
        'delivery',
      )?.historical,
    ).toBe(true);
  });

  it('normalizes structured image payloads and preserves observed buyer aliases for scoped commerce lookup', () => {
    const message = normalizeQianniuMessage(
      {
        ...raw,
        fromid: { targetId: '12345', nick: '实际买家', encryptAccountId: 'encrypted-buyer' },
        toid: { targetId: '98765', nick: 'seller' },
        loginid: { targetId: '98765', nick: 'seller' },
        originalData: JSON.stringify({ image: { url: '//img.alicdn.com/test.png' } }),
      },
      'account',
      'seller',
      'delivery',
    );
    expect(message).toMatchObject({
      kind: 'image',
      buyerId: '12345',
      remoteImageUrl: 'https://img.alicdn.com/test.png',
      platformContext: {
        buyerNick: '实际买家',
        securityUserId: 'encrypted-buyer',
        sellerId: '98765',
      },
    });
    expect(
      normalizeQianniuMessage(
        { ...raw, originalData: { imageUrl: 'https://user:password@img.alicdn.com/a.png' } },
        'account',
        'seller',
        'delivery',
      )?.remoteImageUrl,
    ).toBeUndefined();
    expect(
      normalizeQianniuMessage(
        { ...raw, originalData: { imageUrl: 'file:///private/image.png' } },
        'account',
        'seller',
        'delivery',
      )?.remoteImageUrl,
    ).toBeUndefined();
  });

  it('keeps only explicit product card metadata with a precise platform item ID', () => {
    const message = {
      ...raw,
      msgType: 'product_card',
      originalData: {
        itemId: '12345678901234567890',
        title: '测试商品',
        pic: 'https://img.alicdn.com/a.png',
      },
    };
    expect(normalizeQianniuMessage(message, 'account', 'seller', 'delivery')).toMatchObject({
      kind: 'product_card',
      richContent: { kind: 'product_card', goodsId: '12345678901234567890', title: '测试商品' },
    });
    expect(
      normalizeQianniuMessage(
        { ...message, originalData: { ...message.originalData, itemId: 12345678901234567890 } },
        'account',
        'seller',
        'delivery',
      )?.richContent,
    ).toBeUndefined();
  });

  it('rejects another seller’s delayed message even when callback metadata names the current account', () => {
    const relabeled = {
      ...raw,
      loginid: undefined,
      __judesk: { ...raw.__judesk, loginId: 'seller-b' },
    };
    expect(normalizeQianniuMessage(relabeled, 'account-b', 'seller-b', 'delivery')).toBeNull();
    expect(
      normalizeQianniuMessage({ ...relabeled, selfState: 1 }, 'account-b', 'seller-b', 'delivery'),
    ).toBeNull();
    expect(
      normalizeQianniuMessage(
        { ...raw, loginid: undefined, toid: undefined },
        'account',
        'seller',
        'delivery',
      ),
    ).toBeNull();
    expect(
      normalizeQianniuMessage({ ...raw, loginid: undefined }, 'account', 'seller', 'delivery'),
    ).toMatchObject({ direction: 'in', buyerId: 'buyer' });
  });
});
