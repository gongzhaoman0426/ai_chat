import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { generateQianniuInjectionScript } from '../../../../packages/platforms/src/qianniu/bridge';
import {
  QIANNIU_HTTP_PORT,
  QIANNIU_TCP_PORT,
  QIANNIU_SCRIPT_PATH,
} from '../../../../packages/platforms/src/qianniu';

export { QIANNIU_HTTP_PORT, QIANNIU_TCP_PORT, QIANNIU_SCRIPT_PATH };
export type QianniuIdentity = { loginId: string; sellerId?: string; sellerName?: string };
/** Whether a send is definitively rejected or may already have reached Qianniu. */
export class QianniuSendError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
  ) {
    super(message);
    this.name = 'QianniuSendError';
  }
}
type Deferred = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
};
type TcpRequest = Deferred & { frame: string; onDispatch?: () => void };
type TcpClient = {
  socket: Socket;
  loginId?: string;
  buffer: Buffer;
  queue: TcpRequest[];
  active?: TcpRequest;
  handshake: NodeJS.Timeout;
};
type PageClient = {
  socket: WebSocket;
  loginId?: string;
  alive: boolean;
  requests: Map<string, Deferred>;
  handshake: NodeJS.Timeout;
};
const MAX_FRAME = 4 * 1024 * 1024;
const SEND_TIMEOUT = 15000;
const identifier = (value: unknown): string =>
  typeof value === 'string' && value.trim().length <= 200 ? value.trim() : '';
const object = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isLoopback = (address?: string) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** Qianniu serves bundled chat pages from its local alires-webui HTTPS scheme handler. */
function trustedOrigin(origin?: string): boolean {
  if (!origin || origin === 'null' || origin === 'file://') return true;
  try {
    const url = new URL(origin);
    if (url.origin === 'https://alires-webui') return true;
    return (
      url.protocol === 'https:' &&
      ['taobao.com', 'tmall.com', 'alibaba.com', 'alicdn.com'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

export class QianniuTransport extends EventEmitter {
  private readonly host: string;
  private readonly httpPort: number;
  private readonly tcpPort: number;
  private http?: HttpServer;
  private tcp?: TcpServer;
  private websocket?: WebSocketServer;
  private starting?: Promise<void>;
  private heartbeat?: NodeJS.Timeout;
  private token = '';
  private pages = new Set<PageClient>();
  private sockets = new Set<TcpClient>();
  private identities = new Map<string, QianniuIdentity>();
  private pageByLogin = new Map<string, PageClient>();
  private tcpByLogin = new Map<string, TcpClient>();
  private acknowledged = new Set<string>();
  private inFlight = new Map<string, number>();

  constructor(options: { httpPort?: number; tcpPort?: number; host?: string } = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    if (this.host !== '127.0.0.1') throw new Error('千牛桥接服务只能监听 127.0.0.1');
    this.httpPort = options.httpPort ?? QIANNIU_HTTP_PORT;
    this.tcpPort = options.tcpPort ?? QIANNIU_TCP_PORT;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.http?.listening && this.tcp?.listening) return;
    this.starting = this.listen();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async listen(): Promise<void> {
    this.token = randomBytes(32).toString('hex');
    const http = (this.http = createServer((request, response) => {
      if (!this.accepts(request)) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname !== QIANNIU_SCRIPT_PATH || !['GET', 'HEAD'].includes(request.method || '')) {
        response.writeHead(404).end();
        return;
      }
      const port = (http.address() as { port: number }).port;
      const source = generateQianniuInjectionScript({
        scriptUrl: `http://127.0.0.1:${port}${QIANNIU_SCRIPT_PATH}`,
        websocketUrl: `ws://127.0.0.1:${port}/qianniu-ws?token=${this.token}`,
      });
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': Buffer.byteLength(source),
      });
      response.end(request.method === 'HEAD' ? undefined : source);
    }));
    const websocket = (this.websocket = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME,
    }));
    http.on('upgrade', (request, socket, head) => {
      let token = '';
      let path = '';
      try {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        token = url.searchParams.get('token') || '';
        path = url.pathname;
      } catch {}
      const secret = Buffer.from(this.token);
      const submitted = Buffer.from(token);
      if (
        !this.accepts(request) ||
        path !== '/qianniu-ws' ||
        submitted.length !== secret.length ||
        !timingSafeEqual(secret, submitted)
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      websocket.handleUpgrade(request, socket, head, (ws) => this.connectPage(ws));
    });
    const tcp = (this.tcp = createTcpServer((socket) => this.connectTcp(socket)));
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(this.httpPort, this.host, () => {
          http.off('error', reject);
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(this.tcpPort, this.host, () => {
          tcp.off('error', reject);
          resolve();
        });
      });
      http.on('error', (error) => this.emit('bridge-error', error));
      tcp.on('error', (error) => this.emit('bridge-error', error));
      this.heartbeat = setInterval(() => {
        for (const page of this.pages) {
          if (!page.alive) {
            page.socket.terminate();
            continue;
          }
          page.alive = false;
          page.socket.ping();
        }
        const cutoff = Date.now() - 15000;
        for (const [key, timestamp] of this.inFlight)
          if (timestamp < cutoff) this.inFlight.delete(key);
      }, 15000);
      this.heartbeat.unref();
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  private accepts(request: IncomingMessage): boolean {
    const address = this.http?.address();
    const port = address && typeof address !== 'string' ? address.port : this.httpPort;
    return (
      isLoopback(request.socket.remoteAddress) &&
      request.headers.host === `127.0.0.1:${port}` &&
      trustedOrigin(request.headers.origin)
    );
  }

  states() {
    return [...this.identities].map(([loginId, identity]) => ({
      loginId,
      identity,
      websocket: this.pageByLogin.get(loginId)?.socket.readyState === WebSocket.OPEN,
      tcp: !!this.tcpByLogin.get(loginId) && !this.tcpByLogin.get(loginId)!.socket.destroyed,
    }));
  }

  private connectPage(socket: WebSocket) {
    const page: PageClient = {
      socket,
      alive: true,
      requests: new Map(),
      handshake: setTimeout(() => socket.close(1008, 'login required'), 30000),
    };
    page.handshake.unref();
    this.pages.add(page);
    socket.on('error', () => {});
    socket.on('pong', () => {
      page.alive = true;
    });
    socket.on('message', (buffer) => {
      let message: Record<string, any>;
      try {
        message = object(JSON.parse(buffer.toString()));
      } catch {
        socket.close(1008, 'invalid JSON');
        return;
      }
      page.alive = true;
      if (message.type === 'hello') {
        const identity = object(message.identity);
        const loginId = identifier(identity.loginId);
        if (!loginId || (page.loginId && page.loginId !== loginId)) {
          socket.close(1008, 'identity changed');
          return;
        }
        clearTimeout(page.handshake);
        page.loginId = loginId;
        const previous = this.pageByLogin.get(loginId);
        this.pageByLogin.set(loginId, page);
        if (previous && previous !== page) previous.socket.close(1000, 'replaced');
        const account: QianniuIdentity = { loginId };
        if (typeof identity.sellerId === 'string' && /^\d{1,30}$/.test(identity.sellerId))
          account.sellerId = identity.sellerId;
        if (identifier(identity.sellerName)) account.sellerName = identifier(identity.sellerName);
        this.identities.set(loginId, account);
        this.emit('identity', account);
        this.emit('connection', loginId);
      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      } else if (page.loginId && this.pageByLogin.get(page.loginId) === page) {
        if (
          message.type === 'messages' &&
          message.loginId === page.loginId &&
          typeof message.eventKey === 'string' &&
          message.eventKey.length > 0 &&
          message.eventKey.length <= 200
        ) {
          const key = `${page.loginId}\0${message.eventKey}`;
          const ack = () => {
            this.inFlight.delete(key);
            this.acknowledged.add(key);
            while (this.acknowledged.size > 2000)
              this.acknowledged.delete(this.acknowledged.values().next().value!);
            if (socket.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({ type: 'ack', loginId: page.loginId, eventKey: message.eventKey }),
              );
          };
          if (this.acknowledged.has(key)) {
            ack();
            return;
          }
          if (Date.now() - (this.inFlight.get(key) || 0) < 5000) return;
          if (this.inFlight.size >= 2000) return;
          this.inFlight.set(key, Date.now());
          try {
            this.emit(
              'message',
              { loginId: page.loginId, eventKey: message.eventKey, data: message.data },
              ack,
            );
          } catch {
            this.inFlight.delete(key);
          }
        } else if (message.type === 'response') {
          const pending = page.requests.get(message.requestId);
          if (!pending) return;
          page.requests.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.success === true) pending.resolve(message.data);
          else
            pending.reject(
              new Error(
                typeof message.error === 'string'
                  ? message.error.slice(0, 1000)
                  : '千牛 SDK 调用失败',
              ),
            );
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(page.handshake);
      this.pages.delete(page);
      for (const request of page.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('千牛页面已断开'));
      }
      page.requests.clear();
      if (page.loginId && this.pageByLogin.get(page.loginId) === page) {
        this.pageByLogin.delete(page.loginId);
        const tcp = this.tcpByLogin.get(page.loginId);
        if (tcp) {
          this.rejectTcp(tcp, new Error('千牛页面已断开，发送已停止'));
          // Logging out can leave the DLL socket alive under its old username.
          // Reconnect and identify again before routing any later account's send.
          tcp.socket.destroy();
        }
        this.emit('connection', page.loginId);
      }
    });
  }

  private connectTcp(socket: Socket) {
    if (!isLoopback(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const client: TcpClient = {
      socket,
      buffer: Buffer.alloc(0),
      queue: [],
      handshake: setTimeout(() => socket.destroy(), 10000),
    };
    client.handshake.unref();
    this.sockets.add(client);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(client.handshake);
      this.sockets.delete(client);
      this.rejectTcp(client, new Error('千牛 Hook 连接已断开'));
      if (client.loginId && this.tcpByLogin.get(client.loginId) === client) {
        this.tcpByLogin.delete(client.loginId);
        this.emit('connection', client.loginId);
      }
    });
    socket.on('data', (chunk) => {
      if (client.buffer.length + chunk.length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      client.buffer = Buffer.concat([client.buffer, chunk]);
      let offset: number;
      while ((offset = client.buffer.indexOf('\r\n\r\n')) >= 0) {
        const frame = client.buffer.subarray(0, offset);
        client.buffer = client.buffer.subarray(offset + 4);
        let data: Record<string, any>;
        try {
          data = object(JSON.parse(frame.toString('utf8')));
        } catch {
          socket.destroy();
          return;
        }
        const value = data.username || data.nick || data.loginID;
        // The native component also returns IM user objects on supported clients.
        const username = identifier(typeof value === 'string' ? value : object(value).nick);
        if (username) {
          if (client.loginId && client.loginId !== username) {
            socket.destroy();
            return;
          }
          clearTimeout(client.handshake);
          client.loginId = username;
          const previous = this.tcpByLogin.get(username);
          this.tcpByLogin.set(username, client);
          if (previous && previous !== client) previous.socket.destroy();
          this.emit('connection', username);
        } else if (Object.hasOwn(data, 'result') && client.loginId) {
          const pending = client.active;
          if (!pending) continue;
          clearTimeout(pending.timer);
          client.active = undefined;
          if (data.result === 'success') pending.resolve(data);
          else if ([false, 'failed', 'fail', 'error'].includes(data.result))
            pending.reject(
              new QianniuSendError(
                `千牛 Hook 调用失败：${String(data.result).slice(0, 300)}`,
                'rejected',
              ),
            );
          else {
            const error = new QianniuSendError(
              '千牛 Hook 返回了无法识别的发送结果，请核对平台记录',
              'unknown',
            );
            pending.reject(error);
            this.rejectTcp(client, error);
            client.socket.destroy();
            return;
          }
          this.drain(client);
        }
      }
    });
    socket.write(`${JSON.stringify({ method: 'getusername' })}\r\n\r\n`);
  }

  private rejectTcp(client: TcpClient, error: Error) {
    if (client.active) {
      clearTimeout(client.active.timer);
      client.active.reject(new QianniuSendError(error.message, 'unknown'));
      client.active = undefined;
    }
    for (const pending of client.queue)
      pending.reject(new QianniuSendError(error.message, 'rejected'));
    client.queue = [];
  }

  private drain(client: TcpClient) {
    if (client.active || !client.queue.length) return;
    if (
      !client.loginId ||
      this.tcpByLogin.get(client.loginId) !== client ||
      this.pageByLogin.get(client.loginId)?.socket.readyState !== WebSocket.OPEN ||
      client.socket.destroyed
    ) {
      this.rejectTcp(client, new Error('千牛账号的页面与 Hook 尚未同时连接'));
      return;
    }
    const pending = (client.active = client.queue.shift()!);
    try {
      // A queued send must be re-authorized and registered for echo matching only
      // when it reaches the socket, not while an earlier request is still active.
      pending.onDispatch?.();
    } catch (error) {
      client.active = undefined;
      pending.reject(
        new QianniuSendError(error instanceof Error ? error.message : String(error), 'rejected'),
      );
      this.drain(client);
      return;
    }
    pending.timer = setTimeout(() => {
      // Replies have no request IDs. Retiring this socket prevents a late reply confirming another send.
      this.rejectTcp(client, new Error('千牛 Hook 响应超时，发送结果未知'));
      client.socket.destroy();
    }, SEND_TIMEOUT);
    pending.timer.unref();
    client.socket.write(pending.frame);
  }

  async send(
    loginId: string,
    method: 'sendtext' | 'sendimage' | 'sendvideo',
    params: Record<string, unknown>,
    onDispatch?: () => void,
  ): Promise<unknown> {
    const client = this.tcpByLogin.get(loginId);
    if (
      !client ||
      client.socket.destroyed ||
      this.pageByLogin.get(loginId)?.socket.readyState !== WebSocket.OPEN
    )
      throw new QianniuSendError('千牛账号的页面与 Hook 尚未同时连接', 'rejected');
    if (!['sendtext', 'sendimage', 'sendvideo'].includes(method))
      throw new QianniuSendError('不支持的千牛发送方法', 'rejected');
    if (client.queue.length >= 100) throw new QianniuSendError('千牛发送队列已满', 'rejected');
    const frame = `${JSON.stringify({ ...params, method })}\r\n\r\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME)
      throw new QianniuSendError('千牛发送内容过大', 'rejected');
    return new Promise((resolve, reject) => {
      client.queue.push({ frame, onDispatch, resolve, reject });
      this.drain(client);
    });
  }

  async invoke(loginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const page = this.pageByLogin.get(loginId);
    if (!page || page.socket.readyState !== WebSocket.OPEN) throw new Error('千牛页面尚未连接');
    if (!method || method.length > 200 || page.requests.size >= 100)
      throw new Error('千牛 SDK 请求无效或队列已满');
    const requestId = randomUUID();
    const payload = JSON.stringify({ type: 'invoke', loginId, requestId, method, params });
    if (Buffer.byteLength(payload) > MAX_FRAME) throw new Error('千牛 SDK 请求过大');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        page.requests.delete(requestId);
        reject(new Error('千牛 SDK 响应超时'));
      }, SEND_TIMEOUT);
      timer.unref();
      page.requests.set(requestId, { resolve, reject, timer });
      page.socket.send(payload);
    });
  }

  async close(): Promise<void> {
    if (this.starting) {
      try {
        await this.starting;
      } catch {}
    }
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const page of this.pages) page.socket.terminate();
    for (const client of this.sockets) client.socket.destroy();
    const http = this.http;
    const tcp = this.tcp;
    const websocket = this.websocket;
    this.http = undefined;
    this.tcp = undefined;
    this.websocket = undefined;
    await Promise.all([
      new Promise<void>((resolve) => {
        if (http?.listening) {
          http.close(() => resolve());
          http.closeAllConnections();
        } else resolve();
      }),
      new Promise<void>((resolve) => {
        if (tcp?.listening) tcp.close(() => resolve());
        else resolve();
      }),
      new Promise<void>((resolve) => {
        if (websocket) websocket.close(() => resolve());
        else resolve();
      }),
    ]);
    this.pages.clear();
    this.sockets.clear();
    this.pageByLogin.clear();
    this.tcpByLogin.clear();
    this.identities.clear();
    this.acknowledged.clear();
    this.inFlight.clear();
  }
}
