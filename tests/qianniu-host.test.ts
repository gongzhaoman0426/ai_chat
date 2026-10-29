import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, SendCommand } from '../packages/contracts/src';
import {
  QianniuSendError,
  type QianniuTransport,
  type QianniuIdentity,
} from '../apps/desktop/src/main/qianniu-transport';
import { QianniuHost, qianniuPartition } from '../apps/desktop/src/main/qianniu-host';
import { QianniuCommerce } from '../packages/platforms/src/qianniu/commerce';
import type { TransferCommand } from '../packages/contracts/src/workbench';
import type { QuickCommand } from '../packages/contracts/src/commerce-extra';

vi.mock('../packages/platforms/src/qianniu', () => ({
  readQianniuMessages: (data: unknown) => (Array.isArray(data) ? data : [data]),
  normalizeQianniuMessage: (raw: Record<string, unknown>, accountId: string) =>
    raw.valid === false ? null : { ...raw, accountId },
}));

class FakeTransport extends EventEmitter {
  rows: Array<{ loginId: string; identity: QianniuIdentity; websocket: boolean; tcp: boolean }> =
    [];
  start = vi.fn(async () => {});
  close = vi.fn(async () => {});
  send = vi.fn(async (...args: unknown[]): Promise<unknown> => {
    (args[3] as (() => void) | undefined)?.();
    return { result: 'success' };
  });
  invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
  states() {
    return this.rows;
  }
  identity(loginId = 'shop:staff', tcp = true) {
    const identity = { loginId, sellerName: '测试店铺' };
    this.rows = [
      ...this.rows.filter((row) => row.loginId !== loginId),
      { loginId, identity, websocket: true, tcp },
    ];
    this.emit('identity', identity);
  }
}
const directories: string[] = [];
const hosts: QianniuHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});
async function fixture(platform: NodeJS.Platform = 'win32', imageDirectory?: string) {
  const directory = imageDirectory ?? (await mkdtemp(join(tmpdir(), 'judesk-qianniu-host-')));
  if (!imageDirectory) directories.push(directory);
  const transport = new FakeTransport();
  const request = vi.fn(async (data: Record<string, unknown>): Promise<any> => {
    if (data.type === 'call') return [];
    if (data.type === 'account') {
      const input = data.input as any;
      return {
        id: input.externalId,
        externalId: input.externalId,
        storeId: input.mallId,
        sessionPartition: input.partition,
      };
    }
  });
  const native = {
    start: vi.fn(async () => {}),
    onLogin: vi.fn(async () => {}),
    close: vi.fn(),
    setMaintenance: vi.fn(),
  };
  const notify = vi.fn(),
    onError = vi.fn();
  const fetchImage = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  const host = new QianniuHost({
    transport: transport as unknown as QianniuTransport,
    request,
    native,
    notify,
    platform,
    imageDirectory: directory,
    onError,
    fetchImage,
  });
  hosts.push(host);
  return { host, transport, request, native, notify, onError, directory, fetchImage };
}
const drain = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
async function login(f: Awaited<ReturnType<typeof fixture>>, loginId = 'shop:staff', tcp = true) {
  await f.host.start();
  f.transport.identity(loginId, tcp);
  await drain();
}
const command = (overrides: Partial<SendCommand> = {}): SendCommand => ({
  id: 'out-1',
  token: 'token',
  accountId: 'shop:staff',
  buyerId: 'buyer',
  conversationKey: 'observed-cid',
  kind: 'text',
  text: '你好',
  ...overrides,
});
const incoming = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  accountId: 'ignored',
  externalId: 'real-message-id',
  eventKey: 'event',
  buyerId: 'buyer',
  buyerName: '买家',
  conversationKey: 'observed-cid',
  direction: 'in',
  origin: 'buyer',
  kind: 'text',
  text: '你好',
  timestamp: new Date().toISOString(),
  raw: {},
  historical: false,
  ...overrides,
});
function emitMessage(
  f: Awaited<ReturnType<typeof fixture>>,
  message = incoming(),
  loginId = 'shop:staff',
) {
  const ack = vi.fn();
  f.transport.emit('message', { loginId, eventKey: 'envelope', data: [message] }, ack);
  return ack;
}

describe('QianniuHost', () => {
  it('is unavailable outside Windows and restore never starts the native client', async () => {
    const mac = await fixture('darwin');
    await mac.host.restore([]);
    await expect(mac.host.connect()).rejects.toThrow('Windows');
    expect(mac.transport.start).not.toHaveBeenCalled();
    const win = await fixture();
    await win.host.restore([]);
    expect(win.transport.start).toHaveBeenCalledOnce();
    expect(win.native.start).not.toHaveBeenCalled();
  });

  it('retries a failed bind and reports the failure without rejecting restore', async () => {
    const f = await fixture();
    f.transport.start.mockRejectedValueOnce(new Error('port in use'));
    await f.host.restore([]);
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'port in use' }));
    await f.host.start();
    expect(f.transport.start).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenLastCalledWith();
  });

  it('registers stable shop/subaccount identities and requires both bridges to be online', async () => {
    const f = await fixture();
    await login(f, 'shop:staff', false);
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'account',
        input: expect.objectContaining({
          platform: 'qianniu',
          mallId: 'qianniu:shop',
          externalId: 'shop:staff',
          partition: qianniuPartition('shop:staff'),
          capabilities: expect.objectContaining({ sendText: false }),
        }),
      }),
    );
    expect(f.native.onLogin).toHaveBeenCalledWith(
      expect.objectContaining({ loginId: 'shop:staff' }),
    );
    await expect(f.host.verify('shop:staff')).rejects.toThrow('尚未');
    f.transport.rows[0].tcp = true;
    f.transport.emit('connection', 'shop:staff');
    await drain();
    expect(f.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({ phase: 'online' }),
      }),
    );
    expect(await f.host.verify('shop:staff')).toMatchObject({
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: true,
        orders: true,
        goods: true,
        history: true,
        staffTransfer: true,
      },
    });
    f.transport.emit('identity', { loginId: 'shop:staff', sellerId: '12345' });
    await drain();
    expect(f.request.mock.calls.filter(([data]) => data.type === 'account')).toHaveLength(1);
  });

  it('keeps multiple shops and subaccounts online and confirms identical sends within each account', async () => {
    const f = await fixture();
    const logins = ['shop:staff', 'other:staff', 'shop:second'];
    for (const loginId of logins) await login(f, loginId);

    const registered = f.request.mock.calls
      .filter(([data]) => data.type === 'account')
      .map(([data]) => data.input);
    expect(registered).toEqual(
      logins.map((loginId) =>
        expect.objectContaining({
          externalId: loginId,
          mallId: `qianniu:${loginId.split(':')[0]}`,
          partition: qianniuPartition(loginId),
        }),
      ),
    );
    for (const loginId of logins)
      expect(await f.host.verify(loginId)).toMatchObject({
        identity: { loginId },
        capabilities: { receive: true, sendText: true },
      });

    f.transport.send.mockImplementation(async (...args) => {
      const loginId = args[0] as string;
      (args[3] as () => void)();
      emitMessage(
        f,
        incoming({ direction: 'out', origin: 'human', externalId: `receipt:${loginId}` }),
        loginId,
      );
      await drain();
      return { result: 'success' };
    });
    const results = await Promise.all(
      logins.map((loginId) => f.host.send(command({ id: `send:${loginId}`, accountId: loginId }))),
    );
    expect(results).toEqual(
      logins.map((loginId) => ({ status: 'confirmed', externalId: `receipt:${loginId}` })),
    );
    expect(f.transport.send.mock.calls.map(([loginId]) => loginId)).toEqual(logins);
    for (const loginId of logins)
      expect(f.request).toHaveBeenCalledWith({
        type: 'confirmed',
        outboundId: `send:${loginId}`,
        externalId: `receipt:${loginId}`,
      });
  });

  it.each(['page', 'hook', 'manual'] as const)(
    'keeps another shop receiving and sending when one account loses its %s connection',
    async (failure) => {
      const f = await fixture();
      await login(f, 'shop:staff');
      await login(f, 'other:staff');
      let finishSend!: () => void;
      f.transport.send.mockImplementationOnce(async (...args) => {
        (args[3] as () => void)();
        await new Promise<void>((resolve) => {
          finishSend = resolve;
        });
        return { result: 'success' };
      });
      const sending = f.host.send(command());
      await drain();

      if (failure === 'manual') f.host.disconnect('other:staff');
      else {
        const other = f.transport.rows.find((row) => row.loginId === 'other:staff')!;
        if (failure === 'page') other.websocket = false;
        else other.tcp = false;
        f.transport.emit('connection', 'other:staff');
      }
      await drain();
      await expect(f.host.verify('other:staff')).rejects.toThrow('尚未');
      expect(await f.host.verify('shop:staff')).toMatchObject({
        capabilities: { receive: true, sendText: true },
      });
      await expect(
        f.host.send(command({ id: 'blocked-other-send', accountId: 'other:staff' })),
      ).resolves.toMatchObject({ status: 'rejected' });

      const received = emitMessage(f, incoming({ externalId: 'still-receiving' }));
      const confirmed = emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
      await drain();
      expect(received).toHaveBeenCalledOnce();
      expect(confirmed).toHaveBeenCalledOnce();
      expect(f.request).toHaveBeenCalledWith({
        type: 'incoming',
        input: expect.objectContaining({ accountId: 'shop:staff', externalId: 'still-receiving' }),
      });
      finishSend();
      await expect(sending).resolves.toEqual({
        status: 'confirmed',
        externalId: 'real-message-id',
      });
      expect(f.transport.send).toHaveBeenCalledOnce();
      expect(f.transport.send.mock.calls[0][0]).toBe('shop:staff');
    },
  );

  it('acknowledges only after durable ingestion and leaves failed envelopes for replay', async () => {
    const f = await fixture();
    await login(f);
    let resolveIngest!: () => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveIngest = resolve;
        }),
    );
    const ack = emitMessage(f);
    await drain();
    expect(ack).not.toHaveBeenCalled();
    resolveIngest();
    await drain();
    expect(ack).toHaveBeenCalledOnce();
    f.request.mockRejectedValueOnce(new Error('database unavailable'));
    const failedAck = emitMessage(f);
    await drain();
    expect(failedAck).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('database unavailable') }),
    );
    const replayAck = emitMessage(f);
    await drain();
    expect(replayAck).toHaveBeenCalledOnce();
  });

  it('does not reactivate native injection after the page disconnects during registration', async () => {
    const f = await fixture();
    await f.host.start();
    let finishRegistration!: (account: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRegistration = resolve;
        }),
    );
    f.transport.identity('shop:staff', false);
    await drain();
    f.transport.rows[0].websocket = false;
    f.transport.emit('connection', 'shop:staff');
    finishRegistration({
      id: 'shop:staff',
      externalId: 'shop:staff',
      storeId: 'store',
      sessionPartition: qianniuPartition('shop:staff'),
    });
    await drain();
    expect(f.native.onLogin).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'connection',
        input: expect.objectContaining({ phase: 'offline' }),
      }),
    );
  });

  it('retains human outbound messages and does not confuse another account or historical echo', async () => {
    const f = await fixture();
    await login(f);
    await login(f, 'other:staff');
    await f.host.send(command());
    f.request.mockClear();
    emitMessage(f, incoming({ direction: 'out', origin: 'human' }), 'other:staff');
    emitMessage(f, incoming({ direction: 'out', origin: 'human', historical: true }));
    emitMessage(f, incoming({ direction: 'out', origin: 'human', conversationKey: 'different' }));
    await drain();
    expect(f.request.mock.calls.filter(([data]) => data.type === 'incoming')).toHaveLength(3);
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
  });

  it('keeps Hook success unknown and confirms a later matching live echo with its real message ID', async () => {
    const f = await fixture();
    await login(f);
    const result = await f.host.send(command());
    expect(result.status).toBe('unknown');
    expect(f.transport.send).toHaveBeenCalledWith(
      'shop:staff',
      'sendtext',
      { id: 'observed-cid', text: '你好', keep: 'off' },
      expect.any(Function),
    );
    expect(f.transport.invoke).toHaveBeenCalledWith('shop:staff', 'im.singlemsg.PeekNewMsg', {
      ccode: 'observed-cid',
    });
    const ack = emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
    await drain();
    expect(ack).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith({
      type: 'confirmed',
      outboundId: 'out-1',
      externalId: 'real-message-id',
    });
    await f.host.send(command());
    expect(f.transport.send).toHaveBeenCalledOnce();
  });

  it('confirms Hook success when PeekNewMsg returns the matching outbound echo', async () => {
    const f = await fixture();
    await login(f);
    f.transport.invoke.mockImplementationOnce(async () => {
      queueMicrotask(() => {
        emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
      });
      return { result: [] };
    });
    const sending = f.host.send(command());
    await drain();
    await expect(sending).resolves.toEqual({
      status: 'confirmed',
      externalId: 'real-message-id',
    });
  });

  it('bounds a stalled SDK pull and still confirms its late echo without resending', async () => {
    const f = await fixture();
    await login(f);
    vi.useFakeTimers();
    try {
      f.transport.invoke.mockImplementationOnce(() => new Promise(() => {}));
      const sending = f.host.send(command());
      await vi.advanceTimersByTimeAsync(1500);
      expect(await sending).toMatchObject({ status: 'unknown' });
      expect(f.transport.invoke).toHaveBeenCalledOnce();
      emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
      await drain();
      expect(f.request).toHaveBeenCalledWith({
        type: 'confirmed',
        outboundId: 'out-1',
        externalId: 'real-message-id',
      });
      expect(f.transport.send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pull from a replaced page session after native submission', async () => {
    const f = await fixture();
    await login(f);
    f.transport.send.mockImplementationOnce(async (...args) => {
      (args[3] as () => void)();
      f.transport.emit('connection', 'shop:staff');
      return { result: 'success' };
    });
    expect(await f.host.send(command())).toMatchObject({ status: 'unknown' });
    expect(f.transport.invoke).not.toHaveBeenCalled();
  });

  it.each([1000, 606000])(
    'does not confirm an earlier identical message with a %i ms time mismatch',
    async (skew) => {
      const f = await fixture();
      await login(f);
      vi.useFakeTimers();
      try {
        f.transport.invoke.mockImplementationOnce(async () => {
          emitMessage(
            f,
            incoming({
              direction: 'out',
              origin: 'human',
              timestamp: new Date(Date.now() - skew).toISOString(),
              historical: skew > 60000,
            }),
          );
          return { result: [] };
        });
        const sending = f.host.send(command());
        await vi.advanceTimersByTimeAsync(4500);
        expect(await sending).toMatchObject({
          status: 'unknown',
          reason: expect.stringContaining('同步时钟'),
        });
        expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
        expect(f.transport.send).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('leaves identical ambiguous sends unconfirmed', async () => {
    const f = await fixture();
    await login(f);
    await f.host.send(command());
    await f.host.send(command({ id: 'out-2', token: 'token-2' }));
    f.request.mockClear();
    emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
    await drain();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'incoming' }));
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
  });

  it('confirms repeated text as distinct sends and never assigns a replayed ID to the next send', async () => {
    const f = await fixture();
    await login(f);
    vi.useFakeTimers();
    try {
      f.transport.invoke.mockImplementationOnce(async () => {
        emitMessage(f, incoming({ direction: 'out', origin: 'human', externalId: 'server-first' }));
        return {};
      });
      const first = f.host.send(command());
      await vi.advanceTimersByTimeAsync(50);
      expect(await first).toEqual({ status: 'confirmed', externalId: 'server-first' });
      f.transport.invoke.mockImplementationOnce(async () => {
        emitMessage(f, incoming({ direction: 'out', origin: 'human', externalId: 'server-first' }));
        emitMessage(
          f,
          incoming({ direction: 'out', origin: 'human', externalId: 'server-second' }),
        );
        return {};
      });
      const second = f.host.send(command({ id: 'out-2', token: 'token-2' }));
      await vi.advanceTimersByTimeAsync(50);
      expect(await second).toEqual({ status: 'confirmed', externalId: 'server-second' });
      expect(f.transport.send).toHaveBeenCalledTimes(2);
      expect(f.request).not.toHaveBeenCalledWith({
        type: 'confirmed',
        outboundId: 'out-2',
        externalId: 'server-first',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards rejected send candidates so later human messages cannot confirm them', async () => {
    const f = await fixture();
    await login(f);
    f.transport.send.mockImplementationOnce(async (...args) => {
      (args[3] as () => void)();
      throw new QianniuSendError('千牛 Hook 调用失败：failed', 'rejected');
    });
    expect(await f.host.send(command())).toMatchObject({ status: 'rejected' });
    f.request.mockClear();
    emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
    await drain();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'incoming' }));
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
    const error = new Error('async server failure');
    f.transport.emit('bridge-error', error);
    expect(f.onError).toHaveBeenLastCalledWith(error);
  });

  it('does not turn transport errors into fake successful sends and rejects missing conversation IDs', async () => {
    const f = await fixture();
    await login(f);
    f.transport.send.mockImplementationOnce(async (...args) => {
      (args[3] as () => void)();
      throw new QianniuSendError('timeout', 'unknown');
    });
    expect(await f.host.send(command())).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('timeout'),
    });
    expect(
      await f.host.send(command({ id: 'without-cid', conversationKey: undefined })),
    ).toMatchObject({ status: 'rejected' });
    await expect(f.host.query('shop:staff', 'unsupported-operation', {})).rejects.toThrow();
  });

  it('never matches a queued send and rechecks its account immediately before dispatch', async () => {
    const f = await fixture();
    await login(f);
    let dispatch!: () => void;
    let finish!: (value: unknown) => void;
    f.transport.send.mockImplementationOnce((...args) => {
      dispatch = args[3] as () => void;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const result = f.host.send(command());
    emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
    await drain();
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'incoming' }));
    f.host.disconnect('shop:staff');
    expect(dispatch).toThrow('连接已变化');
    finish({ result: 'failed' });
    expect(await result).toMatchObject({ status: 'rejected' });
  });

  it('rejects a send that never reaches TCP without retaining a matching candidate', async () => {
    const f = await fixture();
    await login(f);
    f.transport.send.mockRejectedValueOnce(new QianniuSendError('队列已满', 'rejected'));
    expect(await f.host.send(command())).toMatchObject({ status: 'rejected' });
    f.request.mockClear();
    emitMessage(f, incoming({ direction: 'out', origin: 'human' }));
    await drain();
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'incoming' }));
  });

  it('stages images under an opaque filename and never confirms unrelated image echoes', async () => {
    const f = await fixture();
    await login(f);
    const bytes = Buffer.from('fake bytes supplied by the validated attachment store');
    const result = await f.host.send(
      command({
        id: '../escape',
        kind: 'image',
        imageData: bytes.toString('base64'),
        imageMime: 'image/png',
      }),
    );
    expect(result.status).toBe('unknown');
    const [loginId, method, params] = f.transport.send.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
    ];
    expect(loginId).toBe('shop:staff');
    expect(method).toBe('sendimage');
    expect(dirname(params.image)).toBe(f.directory);
    expect(await readFile(params.image)).toEqual(bytes);
    f.request.mockClear();
    emitMessage(f, incoming({ direction: 'out', origin: 'human', kind: 'image' }));
    await drain();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'incoming' }));
  });

  it('blocks disconnected accounts and respects saved manual disconnects on restore', async () => {
    const f = await fixture();
    await login(f);
    f.host.disconnect('shop:staff');
    const ack = emitMessage(f);
    await drain();
    expect(ack).not.toHaveBeenCalled();
    expect(await f.host.send(command())).toMatchObject({ status: 'rejected' });
    const other = await fixture();
    other.request.mockResolvedValueOnce([
      {
        platform: 'qianniu',
        accounts: [{ id: 'shop:staff', sessionPartition: qianniuPartition('shop:staff') }],
      },
    ]);
    await other.host.restore([]);
    other.transport.identity();
    await drain();
    expect(other.request.mock.calls.some(([data]) => data.type === 'account')).toBe(false);
  });

  it('persists removed account tombstones until an explicit setup launch', async () => {
    const f = await fixture();
    await login(f);
    await f.host.forgetPartition(qianniuPartition('shop:staff'));
    await f.host.close();
    const next = await fixture('win32', f.directory);
    await login(next);
    expect(next.request.mock.calls.some(([data]) => data.type === 'account')).toBe(false);
    await next.host.connect();
    await drain();
    expect(next.native.start).toHaveBeenCalledOnce();
    expect(next.request.mock.calls.some(([data]) => data.type === 'account')).toBe(true);
  });

  it('pauses intake for maintenance and restarts the transport after close', async () => {
    const f = await fixture();
    await login(f);
    f.host.setMaintenance(true);
    const ack = emitMessage(f);
    await drain();
    expect(ack).not.toHaveBeenCalled();
    await expect(f.host.send(command())).rejects.toThrow('维护');
    f.host.setMaintenance(false);
    await drain();
    await f.host.close();
    expect(f.native.close).toHaveBeenCalled();
    await f.host.restore([]);
    expect(f.transport.start).toHaveBeenCalledTimes(2);
  });
});

describe('QianniuHost commerce and image handling', () => {
  const transfer = (overrides: Partial<TransferCommand> = {}): TransferCommand => ({
    id: randomUUID(),
    accountId: 'shop:staff',
    buyerId: 'buyer',
    conversationKey: 'observed-cid',
    platformContext: {},
    targetStaffId: 'staff-2',
    note: '请继续跟进',
    ...overrides,
  });
  const quick = (overrides: Partial<QuickCommand> = {}): QuickCommand => ({
    id: randomUUID(),
    operation: 'transfer-group',
    accountId: 'shop:staff',
    buyerId: 'buyer',
    conversationKey: 'observed-cid',
    platformContext: {},
    targetId: 'group-2',
    ...overrides,
  });
  const confirmed = {
    status: 'confirmed' as const,
    reasonCode: 'platform_acknowledged',
    message: '平台已确认',
  };

  it('routes goods and staff through the account adapter and invalidates queries across reconnection', async () => {
    const f = await fixture();
    await login(f);
    const goods = { operation: 'goods', data: { goods: [{ goodsId: '123', name: '商品' }] } };
    const query = vi.spyOn(QianniuCommerce.prototype, 'query').mockResolvedValue(goods as any);
    vi.spyOn(QianniuCommerce.prototype, 'staff').mockResolvedValue([
      { id: 'staff-2', name: '客服乙' },
    ]);
    expect(
      await f.host.query('shop:staff', 'goods', { buyerId: 'buyer', page: 1, pageSize: 10 }),
    ).toBe(goods);
    expect(await f.host.staff('shop:staff')).toEqual([{ id: 'staff-2', name: '客服乙' }]);
    let finish!: (value: any) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.host.query('shop:staff', 'goods', { buyerId: 'buyer' });
    f.transport.emit('connection', 'shop:staff');
    finish(goods);
    await expect(pending).rejects.toThrow('连接已变化');
  });

  it('routes real adapter SDK calls by account and blocks subsequent requests after a connection change', async () => {
    const f = await fixture();
    await login(f);
    const contactApi = 'mtop.taobao.qianniu.airisland.contact.search';
    f.transport.invoke.mockImplementation(async (loginId, method, params) => {
      expect(loginId).toBe('shop:staff');
      expect(method).toBe('application.invokeMTopChannelService');
      const api = (params as any).method;
      return {
        api,
        ret: ['SUCCESS::调用成功'],
        data:
          api === contactApi
            ? {
                data: [
                  {
                    accountType: '3',
                    accountId: '100',
                    nick: 'buyer',
                    encryptAccountId: 'enc-buyer',
                  },
                ],
              }
            : { data: [], totalCount: 0, page: 1 },
      };
    });
    const scope = {
      buyerId: '100',
      conversationKey: '100.1-999.1#11001@cntaobao',
      platformContext: { buyerNick: 'buyer' },
      page: 1,
      pageSize: 10,
    };
    expect(await f.host.query('shop:staff', 'goods', scope)).toMatchObject({
      operation: 'goods',
      data: { products: [] },
    });
    expect(f.transport.invoke).toHaveBeenCalledTimes(2);
    f.transport.invoke.mockClear();
    let finish!: (value: unknown) => void;
    f.transport.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.host.query('shop:staff', 'goods', scope);
    f.transport.emit('connection', 'shop:staff');
    finish({
      api: contactApi,
      ret: ['SUCCESS::调用成功'],
      data: {
        data: [
          { accountType: '3', accountId: '100', nick: 'buyer', encryptAccountId: 'enc-buyer' },
        ],
      },
    });
    await expect(pending).rejects.toThrow('连接已变化');
    expect(f.transport.invoke).toHaveBeenCalledOnce();
  });

  it('authorizes a transfer immediately before writing and deduplicates the same action', async () => {
    const f = await fixture();
    await login(f);
    const write = vi.fn();
    const operation = vi
      .spyOn(QianniuCommerce.prototype, 'transfer')
      .mockImplementation(async (command, authorize) => {
        await authorize({
          buyerId: command.buyerId,
          conversationKey: command.conversationKey,
          targetStaffId: command.targetStaffId,
          targetName: '客服乙',
        });
        write();
        return confirmed;
      });
    const command = transfer();
    expect(await f.host.executeTransfer(command)).toEqual(confirmed);
    expect(await f.host.executeTransfer(command)).toEqual(confirmed);
    expect(operation).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith({
      type: 'platform_transfer_guard',
      actionId: command.id,
      preview: {
        buyerId: 'buyer',
        conversationKey: 'observed-cid',
        targetStaffId: 'staff-2',
        targetName: '客服乙',
      },
    });
    await expect(f.host.executeTransfer({ ...command, targetStaffId: 'staff-3' })).rejects.toThrow(
      '标识',
    );
  });

  it('integrates the real commerce adapter with host transfer guards and product-card receipts', async () => {
    const f = await fixture();
    await login(f);
    const operations: string[] = [];
    f.transport.invoke.mockImplementation(async (loginId, method, payload) => {
      expect(loginId).toBe('shop:staff');
      expect(method).toBe('application.invokeMTopChannelService');
      const api = (payload as any).method as string;
      operations.push(api);
      let data: unknown;
      if (api.endsWith('.contact.search'))
        data = {
          data: [
            { accountId: '100', accountType: 3, nick: 'buyer', encryptAccountId: 'enc-buyer' },
          ],
        };
      else if (api.endsWith('.accountstatus.getbyid'))
        data = {
          module: [
            {
              accountId: '9002',
              mainAccountId: '999',
              nick: '售后',
              pcOnline: true,
              suspend: false,
            },
          ],
        };
      else if (api.endsWith('.cloudkefu.forward')) data = { errorCode: 0, module: true };
      else if (api.endsWith('.item.search'))
        data = {
          data: [
            {
              itemId: '123',
              title: '商品',
              approveStatus: 'onsale',
              buttons: [{ code: 'sendItem', hidden: false }],
            },
          ],
          page: 1,
          totalCount: 1,
        };
      else if (api.endsWith('.item.recommend.send')) data = { sendCard: true };
      else throw new Error('Unexpected SDK write');
      return { api, ret: ['SUCCESS::调用成功'], data };
    });
    f.request.mockImplementation(async (data) => {
      if (data.type === 'platform_transfer_guard') operations.push('guard');
    });
    const scope = {
      buyerId: '100',
      conversationKey: '100.1-999.1#11001@cntaobao',
      platformContext: { buyerNick: 'buyer' },
    };
    const value = transfer({ ...scope, targetStaffId: '9002' });
    expect(await f.host.executeTransfer(value)).toMatchObject({ status: 'confirmed' });
    expect(operations.slice(-2)).toEqual(['guard', 'mtop.taobao.qianniu.cloudkefu.forward']);
    const beforeRefusal = operations.filter((op) => op.endsWith('.cloudkefu.forward')).length;
    f.request.mockRejectedValueOnce(new Error('authorization refused'));
    await expect(f.host.executeTransfer({ ...value, id: randomUUID() })).rejects.toThrow(
      'authorization refused',
    );
    expect(operations.filter((op) => op.endsWith('.cloudkefu.forward'))).toHaveLength(
      beforeRefusal,
    );
    const rich = command({
      ...scope,
      kind: 'product_card',
      richContent: { kind: 'product_card', goodsId: '123', title: '商品' },
    });
    expect(await f.host.send(rich)).toMatchObject({ status: 'unknown' });
    expect(operations.at(-1)).toBe('mtop.taobao.qianniu.cs.item.recommend.send');
    const ack = emitMessage(
      f,
      incoming({
        ...scope,
        kind: 'product_card',
        direction: 'out',
        origin: 'human',
        externalId: 'sdk-card-id',
        richContent: { kind: 'product_card', goodsId: '123', title: '商品' },
      }),
    );
    await drain();
    expect(ack).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith({
      type: 'confirmed',
      outboundId: rich.id,
      externalId: 'sdk-card-id',
    });
  });

  it('prevents transfer or group mutation if authorization rejects or the connection changes while authorizing', async () => {
    const f = await fixture();
    await login(f);
    const write = vi.fn();
    vi.spyOn(QianniuCommerce.prototype, 'transfer').mockImplementation(
      async (command, authorize) => {
        await authorize({
          buyerId: command.buyerId,
          conversationKey: command.conversationKey,
          targetStaffId: command.targetStaffId,
          targetName: '客服乙',
        });
        write();
        return confirmed;
      },
    );
    f.request.mockRejectedValueOnce(new Error('会话接待权已变化'));
    await expect(f.host.executeTransfer(transfer())).rejects.toThrow('接待权');
    expect(write).not.toHaveBeenCalled();
    vi.spyOn(QianniuCommerce.prototype, 'quick').mockImplementation(async (command, authorize) => {
      await authorize({
        operation: command.operation,
        buyerId: command.buyerId,
        conversationKey: command.conversationKey,
        targetId: command.targetId,
      });
      write();
      return confirmed;
    });
    f.request.mockImplementationOnce(async () => {
      f.transport.emit('connection', 'shop:staff');
    });
    await expect(f.host.executeQuickAction(quick())).rejects.toThrow('连接已变化');
    expect(write).not.toHaveBeenCalled();
  });

  it('dispatches product cards through the SDK adapter without fabricating a delivery ID', async () => {
    const f = await fixture();
    await login(f);
    const sdk = vi
      .spyOn(QianniuCommerce.prototype, 'sendRich')
      .mockResolvedValue({ status: 'unknown', reason: '未取得平台消息 ID' });
    const value = command({
      kind: 'product_card',
      richContent: { kind: 'product_card', goodsId: '123', title: '商品' },
    });
    expect(await f.host.send(value)).toEqual({ status: 'unknown', reason: '未取得平台消息 ID' });
    await f.host.send(value);
    expect(sdk).toHaveBeenCalledOnce();
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('matches product-card receipts only after submission and only for the same actual product', async () => {
    const f = await fixture();
    await login(f);
    vi.spyOn(QianniuCommerce.prototype, 'sendRich').mockImplementation(
      async (_command, beforeDispatch) => {
        beforeDispatch?.();
        return { status: 'unknown', reason: '等待实际消息回执' };
      },
    );
    await f.host.send(
      command({
        kind: 'product_card',
        richContent: { kind: 'product_card', goodsId: '123', title: '商品' },
      }),
    );
    f.request.mockClear();
    emitMessage(
      f,
      incoming({
        kind: 'product_card',
        direction: 'out',
        origin: 'human',
        richContent: { kind: 'product_card', goodsId: '456', title: '其他商品' },
      }),
    );
    await drain();
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
    emitMessage(
      f,
      incoming({
        kind: 'product_card',
        direction: 'out',
        origin: 'human',
        externalId: 'real-card-id',
        richContent: { kind: 'product_card', goodsId: '123', title: '商品' },
      }),
    );
    await drain();
    expect(f.request).toHaveBeenCalledWith({
      type: 'confirmed',
      outboundId: 'out-1',
      externalId: 'real-card-id',
    });
  });

  it('reads local history through the scoped service RPC and refuses missing buyer context', async () => {
    const f = await fixture();
    await login(f);
    const history = {
      operation: 'history',
      partial: true,
      data: { source: 'local', messages: [] },
    };
    f.request.mockResolvedValueOnce(history);
    expect(
      await f.host.query('shop:staff', 'history', {
        buyerId: 'buyer',
        conversationKey: 'observed-cid',
        pageSize: 20,
        cursor: '',
      }),
    ).toBe(history);
    expect(f.request).toHaveBeenLastCalledWith({
      type: 'platform_local_history',
      input: {
        accountId: 'shop:staff',
        buyerId: 'buyer',
        conversationKey: 'observed-cid',
        pageSize: 20,
        cursor: '',
      },
    });
    await expect(f.host.query('shop:staff', 'history', { buyerId: 'buyer' })).rejects.toThrow(
      '会话标识',
    );
    expect(f.transport.invoke).not.toHaveBeenCalled();
  });

  it('downloads trusted image attachments and waits for ingestion before acknowledging', async () => {
    const f = await fixture();
    await login(f);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    f.fetchImage.mockResolvedValueOnce(
      new Response(bytes, { headers: { 'content-type': 'image/png' } }),
    );
    const ack = emitMessage(
      f,
      incoming({ kind: 'image', remoteImageUrl: 'https://img.alicdn.com/actual.png' }),
    );
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    expect(f.fetchImage).toHaveBeenCalledWith(
      'https://img.alicdn.com/actual.png',
      expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
    );
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'incoming', imageBytes: Buffer.from(bytes) }),
    );
  });

  it('keeps image messages without fetching untrusted URLs or retaining oversized payloads', async () => {
    const f = await fixture();
    await login(f);
    for (const url of [
      'http://img.alicdn.com/x.png',
      'https://alicdn.com.attacker.example/x.png',
      'https://127.0.0.1/x.png',
      'https://user:pass@img.alicdn.com/x.png',
    ]) {
      const ack = emitMessage(f, incoming({ kind: 'image', remoteImageUrl: url }));
      await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    }
    expect(f.fetchImage).not.toHaveBeenCalled();
    f.fetchImage.mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    f.request.mockClear();
    const ack = emitMessage(
      f,
      incoming({ kind: 'image', remoteImageUrl: 'https://img.alicdn.com/huge.png' }),
    );
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    expect(f.request).toHaveBeenCalledWith({
      type: 'incoming',
      input: expect.objectContaining({ kind: 'image' }),
    });
  });

  it('confirms an image only when a real outbound echo matches its exact downloaded bytes and conversation', async () => {
    const f = await fixture();
    await login(f);
    const bytes = new Uint8Array([137, 80, 78, 71, 12, 23, 34]);
    const value = command({
      kind: 'image',
      text: '[图片]',
      imageMime: 'image/png',
      imageData: Buffer.from(bytes).toString('base64'),
    });
    expect(await f.host.send(value)).toMatchObject({ status: 'unknown' });
    f.request.mockClear();
    f.fetchImage.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const different = emitMessage(
      f,
      incoming({
        kind: 'image',
        direction: 'out',
        origin: 'human',
        remoteImageUrl: 'https://img.alicdn.com/different.png',
      }),
    );
    await vi.waitFor(() => expect(different).toHaveBeenCalledOnce());
    expect(f.request.mock.calls.some(([data]) => data.type === 'confirmed')).toBe(false);
    f.fetchImage.mockResolvedValueOnce(new Response(bytes));
    const actual = emitMessage(
      f,
      incoming({
        kind: 'image',
        direction: 'out',
        origin: 'human',
        externalId: 'real-image-id',
        remoteImageUrl: 'https://img.alicdn.com/actual.png',
      }),
    );
    await vi.waitFor(() => expect(actual).toHaveBeenCalledOnce());
    expect(f.request).toHaveBeenCalledWith({
      type: 'confirmed',
      outboundId: 'out-1',
      externalId: 'real-image-id',
    });
  });
});
