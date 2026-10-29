import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { get } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { WebSocket } from 'ws';
import { QianniuSendError, QianniuTransport } from '../apps/desktop/src/main/qianniu-transport';

const servers: QianniuTransport[] = [];
const clients: Array<WebSocket | Socket> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0))
    'terminate' in client ? client.terminate() : client.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function start() {
  const transport = new QianniuTransport({ httpPort: 0, tcpPort: 0 });
  servers.push(transport);
  await transport.start();
  const port = (transport as any).http.address().port;
  const tcpPort = (transport as any).tcp.address().port;
  const url = `http://127.0.0.1:${port}/qianniu-inject`;
  const response = await fetch(url);
  const source = await response.text();
  const websocketUrl = /"websocketUrl":"([^"]+)"/.exec(source)![1];
  return { transport, url, source, websocketUrl, tcpPort };
}
async function page(url: string, loginId: string, origin = 'null') {
  const ws = new WebSocket(url, { origin });
  clients.push(ws);
  await once(ws, 'open');
  const messages: any[] = [];
  ws.on('message', (value) => messages.push(JSON.parse(value.toString())));
  ws.send(JSON.stringify({ type: 'hello', identity: { loginId } }));
  return { ws, messages };
}
async function hook(port: number, username: unknown) {
  const socket = connect(port, '127.0.0.1');
  clients.push(socket);
  const frames: any[] = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\r\n\r\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 4);
    }
  });
  await once(socket, 'connect');
  await vi.waitFor(() => expect(frames).toEqual([{ method: 'getusername' }]));
  socket.write(JSON.stringify({ username }) + '\r\n\r\n');
  return { socket, frames };
}

describe('Qianniu loopback transport', () => {
  it('serves only the fixed route and refuses remote origins, rebinding hosts, and unauthenticated WS', async () => {
    const { url, source, websocketUrl } = await start();
    expect(source).toContain('im.singlemsg.GetNewMsg');
    expect((await fetch(url)).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(url.replace('/qianniu-inject', '/other'))).status).toBe(404);
    expect((await fetch(url, { headers: { Origin: 'https://attacker.example' } })).status).toBe(
      403,
    );
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(url, { headers: { Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(rebindingStatus).toBe(403);
    for (const [wsUrl, origin] of [
      [websocketUrl.replace(/token=.*/, 'token=wrong'), 'null'],
      [websocketUrl, 'https://attacker.example'],
    ]) {
      const ws = new WebSocket(wsUrl, { origin });
      clients.push(ws);
      const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
      expect(error.message).toContain('403');
    }
    expect(() => new QianniuTransport({ host: '0.0.0.0' })).toThrow('127.0.0.1');
  });

  it('accepts the Qianniu resource origin and pairs its page with the exact object username', async () => {
    const { transport, url, websocketUrl, tcpPort } = await start();
    const response = await fetch(url, { headers: { Origin: 'https://alires-webui' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('im.singlemsg.GetNewMsg');
    await page(websocketUrl, 'shop:staff', 'https://alires-webui');
    await hook(tcpPort, { nick: 'shop:staff', targetId: '12345' });
    await vi.waitFor(() =>
      expect(transport.states()).toEqual([
        {
          loginId: 'shop:staff',
          identity: { loginId: 'shop:staff' },
          websocket: true,
          tcp: true,
        },
      ]),
    );
  });

  it.each([
    'https://alires-webui.attacker.example',
    'https://sub.alires-webui',
    'http://alires-webui',
    'https://alires-webui:444',
  ])('refuses Qianniu resource origin lookalike %s for HTTP and WebSocket', async (origin) => {
    const { transport, url, websocketUrl } = await start();
    expect((await fetch(url, { headers: { Origin: origin } })).status).toBe(403);
    const ws = new WebSocket(websocketUrl, { origin });
    clients.push(ws);
    const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(error.message).toContain('403');
    expect(transport.states()).toEqual([]);
  });

  it('matches TCP to the exact page login and serializes replies without request IDs', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    await page(websocketUrl, 'seller-a');
    const wrong = await hook(tcpPort, 'seller-b');
    await expect(
      transport.send('seller-a', 'sendtext', { id: 'buyer', text: 'hello' }),
    ).rejects.toThrow('同时连接');
    const right = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() =>
      expect(transport.states()[0]).toMatchObject({ websocket: true, tcp: true }),
    );
    const firstDispatch = vi.fn(),
      secondDispatch = vi.fn();
    const first = transport.send(
      'seller-a',
      'sendtext',
      { id: 'buyer-1', text: 'one' },
      firstDispatch,
    );
    const second = transport.send(
      'seller-a',
      'sendtext',
      { id: 'buyer-2', text: 'two' },
      secondDispatch,
    );
    await vi.waitFor(() => expect(right.frames).toHaveLength(2));
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(secondDispatch).not.toHaveBeenCalled();
    expect(wrong.frames).toHaveLength(1);
    right.socket.write('{"result":"suc');
    right.socket.write('cess"}\r\n\r\n');
    await expect(first).resolves.toEqual({ result: 'success' });
    await vi.waitFor(() => expect(right.frames).toHaveLength(3));
    expect(secondDispatch).toHaveBeenCalledOnce();
    expect(right.frames[2]).toMatchObject({ id: 'buyer-2', method: 'sendtext' });
    right.socket.write('{"result":"failed"}\r\n\r\n');
    await expect(second).rejects.toMatchObject({
      name: 'QianniuSendError',
      message: expect.stringContaining('failed'),
      outcome: 'rejected',
    });
  });

  it('matches object usernames by the exact subaccount nick rather than target ID', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    await page(websocketUrl, 'shop:staff');
    const wrong = await hook(tcpPort, { nick: 'shop:other', targetId: '12345' });
    await expect(
      transport.send('shop:staff', 'sendtext', { id: 'buyer', text: 'hello' }),
    ).rejects.toThrow('同时连接');
    const right = await hook(tcpPort, { nick: 'shop:staff', targetId: '12345' });
    await vi.waitFor(() =>
      expect(transport.states()).toContainEqual({
        loginId: 'shop:staff',
        identity: { loginId: 'shop:staff' },
        websocket: true,
        tcp: true,
      }),
    );
    const result = transport.send('shop:staff', 'sendtext', { id: 'buyer', text: 'hello' });
    await vi.waitFor(() => expect(right.frames).toHaveLength(2));
    expect(wrong.frames).toHaveLength(1);
    right.socket.write('{"result":"success"}\r\n\r\n');
    await expect(result).resolves.toEqual({ result: 'success' });
  });

  it.each([
    {},
    { nick: '', targetId: 12345 },
    { nick: 12345, targetId: '12345' },
    { nick: ' ', display: 'shop:staff', targetId: '12345' },
  ])(
    'leaves malformed object username %j disconnected without fabricating an account',
    async (username) => {
      const { transport, websocketUrl, tcpPort } = await start();
      await page(websocketUrl, 'shop:staff');
      await vi.waitFor(() => expect(transport.states()[0]?.websocket).toBe(true));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const tcp = await hook(tcpPort, username);
      await vi.advanceTimersByTimeAsync(10001);
      vi.useRealTimers();
      await vi.waitFor(() => expect(tcp.socket.destroyed).toBe(true));
      expect(transport.states()).toEqual([
        {
          loginId: 'shop:staff',
          identity: { loginId: 'shop:staff' },
          websocket: true,
          tcp: false,
        },
      ]);
      await expect(
        transport.send('shop:staff', 'sendtext', { id: 'buyer', text: 'hello' }),
      ).rejects.toThrow('同时连接');
    },
  );

  it('retires a TCP socket when its object username changes to another subaccount', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    await page(websocketUrl, 'shop:staff');
    await page(websocketUrl, 'shop:other');
    const tcp = await hook(tcpPort, { nick: 'shop:staff', targetId: '12345' });
    await vi.waitFor(() =>
      expect(transport.states().find((row) => row.loginId === 'shop:staff')?.tcp).toBe(true),
    );
    tcp.socket.write(
      JSON.stringify({ username: { nick: 'shop:other', targetId: '67890' } }) + '\r\n\r\n',
    );
    await vi.waitFor(() => expect(tcp.socket.destroyed).toBe(true));
    expect(transport.states().every((row) => row.websocket && !row.tcp)).toBe(true);
  });

  it('ACKs only after the ingestion callback and remembers ACKs across reconnects', async () => {
    const { transport, websocketUrl } = await start();
    let ack: (() => void) | undefined;
    const received: unknown[] = [];
    transport.on('message', (data, callback) => {
      received.push(data);
      ack = callback;
    });
    const first = await page(websocketUrl, 'seller-a');
    const envelope = {
      type: 'messages',
      loginId: 'seller-a',
      eventKey: 'evt-1',
      data: { result: [{ msgid: 'm1' }] },
    };
    first.ws.send(JSON.stringify(envelope));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(first.messages).toEqual([]);
    first.ws.send(JSON.stringify(envelope));
    ack!();
    await vi.waitFor(() =>
      expect(first.messages).toContainEqual({
        type: 'ack',
        loginId: 'seller-a',
        eventKey: 'evt-1',
      }),
    );
    first.ws.close();
    await once(first.ws, 'close');
    const second = await page(websocketUrl, 'seller-a');
    second.ws.send(JSON.stringify(envelope));
    second.ws.send(JSON.stringify({ ...envelope, loginId: 'seller-other', eventKey: 'bad' }));
    await vi.waitFor(() => expect(second.messages).toHaveLength(1));
    expect(received).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ type: 'ack', eventKey: 'evt-1' });
  });

  it('retires an active TCP socket when its page disconnects so a late response cannot confirm a later send', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    const firstPage = await page(websocketUrl, 'seller-a');
    const tcp = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() => expect(transport.states()[0]?.tcp).toBe(true));
    const result = transport
      .send('seller-a', 'sendtext', { id: 'buyer', text: 'old' })
      .catch((error) => error);
    await vi.waitFor(() => expect(tcp.frames).toHaveLength(2));
    firstPage.ws.close();
    await expect(result).resolves.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(tcp.socket.destroyed).toBe(true));
    await page(websocketUrl, 'seller-a');
    await expect(
      transport.send('seller-a', 'sendtext', { id: 'buyer', text: 'new' }),
    ).rejects.toThrow('同时连接');
  });

  it('retires idle TCP on logout and requires a fresh username handshake', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    const firstPage = await page(websocketUrl, 'seller-a');
    const tcp = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() => expect(transport.states()[0]?.tcp).toBe(true));
    firstPage.ws.close();
    await vi.waitFor(() => expect(tcp.socket.destroyed).toBe(true));
    await page(websocketUrl, 'seller-b');
    await expect(
      transport.send('seller-b', 'sendtext', { id: 'buyer', text: 'new' }),
    ).rejects.toThrow('同时连接');
    const fresh = await hook(tcpPort, 'seller-b');
    await vi.waitFor(() =>
      expect(transport.states().find((row) => row.loginId === 'seller-b')?.tcp).toBe(true),
    );
    const result = transport.send('seller-b', 'sendtext', { id: 'buyer', text: 'new' });
    await vi.waitFor(() => expect(fresh.frames).toHaveLength(2));
    fresh.socket.write('{"result":"success"}\r\n\r\n');
    await expect(result).resolves.toEqual({ result: 'success' });
    expect(tcp.frames).toHaveLength(1);
  });

  it('preserves TCP when a newer page replaces the same logged-in account', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    const firstPage = await page(websocketUrl, 'seller-a');
    const tcp = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() => expect(transport.states()[0]?.tcp).toBe(true));
    const oldClosed = once(firstPage.ws, 'close');
    const replacement = await page(websocketUrl, 'seller-a');
    await oldClosed;
    expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
    expect(tcp.socket.destroyed).toBe(false);
    const result = transport.send('seller-a', 'sendtext', { id: 'buyer', text: 'same account' });
    await vi.waitFor(() => expect(tcp.frames).toHaveLength(2));
    tcp.socket.write('{"result":"success"}\r\n\r\n');
    await expect(result).resolves.toEqual({ result: 'success' });
  });

  it('retires TCP after a no-ID response timeout and rejects queued sends', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    await page(websocketUrl, 'seller-a');
    const tcp = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() => expect(transport.states()[0]?.tcp).toBe(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = transport.send('seller-a', 'sendtext', { text: 'one' }).catch((error) => error);
    const second = transport.send('seller-a', 'sendtext', { text: 'two' }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(15001);
    expect(((await first) as Error).message).toContain('超时');
    expect(((await second) as Error).message).toContain('超时');
    expect(await first).toMatchObject({ outcome: 'unknown' });
    expect(await second).toMatchObject({ outcome: 'rejected' });
    vi.useRealTimers();
    await vi.waitFor(() => expect(tcp.socket.destroyed).toBe(true));
  });

  it('does not write a queued command when its dispatch guard rejects', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    await page(websocketUrl, 'seller-a');
    const tcp = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() => expect(transport.states()[0]?.tcp).toBe(true));
    const first = transport.send('seller-a', 'sendtext', { text: 'first' });
    const guard = vi.fn(() => {
      throw new Error('账号已变化');
    });
    const second = transport
      .send('seller-a', 'sendtext', { text: 'stale' }, guard)
      .catch((error) => error);
    await vi.waitFor(() => expect(tcp.frames).toHaveLength(2));
    expect(guard).not.toHaveBeenCalled();
    tcp.socket.write('{"result":"success"}\r\n\r\n');
    await first;
    expect(await second).toBeInstanceOf(QianniuSendError);
    expect(await second).toMatchObject({ outcome: 'rejected', message: '账号已变化' });
    expect(guard).toHaveBeenCalledOnce();
    expect(tcp.frames).toHaveLength(2);
  });

  it('keeps unrecognized native receipts unknown and retires the socket before another send', async () => {
    const { transport, websocketUrl, tcpPort } = await start();
    await page(websocketUrl, 'seller-a');
    const tcp = await hook(tcpPort, 'seller-a');
    await vi.waitFor(() => expect(transport.states()[0]?.tcp).toBe(true));
    const active = transport
      .send('seller-a', 'sendtext', { text: 'submitted' })
      .catch((error) => error);
    const queued = transport
      .send('seller-a', 'sendtext', { text: 'not submitted' })
      .catch((error) => error);
    await vi.waitFor(() => expect(tcp.frames).toHaveLength(2));
    tcp.socket.write('{"result":"unrecognized-version-response"}\r\n\r\n');
    expect(await active).toMatchObject({ outcome: 'unknown' });
    expect(await queued).toMatchObject({ outcome: 'rejected' });
    await vi.waitFor(() => expect(tcp.socket.destroyed).toBe(true));
    expect(tcp.frames).toHaveLength(2);
  });

  it('correlates SDK replies to their owning page and rejects them after disconnect', async () => {
    const { transport, websocketUrl } = await start();
    const seller = await page(websocketUrl, 'seller');
    const other = await page(websocketUrl, 'other');
    await vi.waitFor(() => expect(transport.states()).toHaveLength(2));
    const result = transport.invoke('seller', 'application.lookup', { id: '1' });
    await vi.waitFor(() => expect(seller.messages).toHaveLength(1));
    const request = seller.messages[0];
    other.ws.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        success: true,
        data: 'wrong',
      }),
    );
    seller.ws.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        success: true,
        data: 'right',
      }),
    );
    await expect(result).resolves.toBe('right');
    const interrupted = transport
      .invoke('seller', 'application.lookup', {})
      .catch((error) => error);
    seller.ws.close();
    expect(await interrupted).toBeInstanceOf(Error);
  });

  it('releases partially started servers on bind failure and can restart after closing', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const port = (occupied.address() as { port: number }).port;
    const transport = new QianniuTransport({ httpPort: 0, tcpPort: port });
    servers.push(transport);
    await expect(transport.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await transport.start();
    expect((transport as any).http.listening).toBe(true);
    await transport.close();
    await transport.start();
    expect((transport as any).tcp.listening).toBe(true);
  });
});
