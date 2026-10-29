import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type IncomingMessage,
  type SendCommand,
  type SendResult,
} from '../../../../packages/contracts/src';
import {
  normalizeQianniuMessage,
  readQianniuMessages,
} from '../../../../packages/platforms/src/qianniu';
import {
  QianniuCommerce,
  qianniuCapabilities,
} from '../../../../packages/platforms/src/qianniu/commerce';
import {
  quickCommandSchema,
  type QuickCommand,
} from '../../../../packages/contracts/src/commerce-extra';
import {
  transferCommandSchema,
  type TransferCommand,
} from '../../../../packages/contracts/src/workbench';
import {
  commerceQuerySchemas,
  type PlatformActionResult,
} from '../../../../packages/contracts/src/commerce-tools';
import { platformContextSchema } from '../../../../packages/contracts/src/platform';
import type { PlatformDriver } from './platform-hosts';
import type { PlatformAccount } from './workbench-host';
import { QianniuSendError, type QianniuIdentity, type QianniuTransport } from './qianniu-transport';

type Options = {
  transport: QianniuTransport;
  request: (data: Record<string, unknown>) => Promise<any>;
  notify: (data: unknown) => void;
  native: {
    start(): Promise<unknown>;
    onLogin(identity: QianniuIdentity): Promise<void>;
    close?(): void;
    setMaintenance?(value: boolean): void;
  };
  platform?: NodeJS.Platform;
  imageDirectory: string;
  ignoredAccountsPath?: string;
  onError?: (error?: unknown) => void;
  fetchImage?: typeof fetch;
};
type PendingSend = {
  command: SendCommand;
  started: number;
  externalId?: string;
  imageHash?: string;
  echoMismatchReason?: string;
};
const caps = (online: boolean) => qianniuCapabilities(online, true);
const messageText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).slice(0, 400);
export const qianniuPartition = (loginId: string) =>
  `qianniu:${createHash('sha256').update(loginId).digest('hex')}`;

/** The native client owns its session; JuDesk only routes identities confirmed by both bridges. */
export class QianniuHost implements PlatformDriver {
  private readonly platform: NodeJS.Platform;
  private accounts = new Map<string, PlatformAccount>();
  private blocked = new Set<string>();
  private ignored = new Set<string>();
  private loadedIgnored?: Promise<void>;
  private ignoredWrite: Promise<unknown> = Promise.resolve();
  private queues = new Map<string, Promise<unknown>>();
  private sends = new Map<string, Promise<SendResult>>();
  private pending = new Map<string, PendingSend>();
  private epochs = new Map<string, number>();
  private commerceAdapters = new Map<
    string,
    { generation: number; epoch: number; account: PlatformAccount; adapter: QianniuCommerce }
  >();
  private actions = new Map<string, { fingerprint: string; task: Promise<PlatformActionResult> }>();
  private maintenance = false;
  private closed = true;
  private generation = 0;
  private startTask?: Promise<void>;

  constructor(private options: Options) {
    this.platform = options.platform ?? process.platform;
    options.transport.on('bridge-error', (error: unknown) => options.onError?.(error));
    options.transport.on('identity', (identity: QianniuIdentity) => {
      this.enqueue(identity.loginId, () => this.register(identity));
    });
    options.transport.on('connection', (loginId: string) => {
      this.epochs.set(loginId, (this.epochs.get(loginId) ?? 0) + 1);
      this.enqueue(loginId, () => this.report(loginId));
    });
    options.transport.on(
      'message',
      (envelope: { loginId: string; eventKey: string; data: unknown }, ack: () => void) => {
        this.enqueue(envelope.loginId, () => this.ingest(envelope, ack));
      },
    );
  }

  private assertUsable() {
    if (this.platform !== 'win32') throw new Error('千牛仅支持 Windows');
    if (this.maintenance) throw new Error('JuDesk 正在维护，请稍后重试');
  }

  async start(): Promise<void> {
    this.assertUsable();
    if (this.startTask) return this.startTask;
    this.closed = false;
    const task = this.loadIgnored()
      .then(() => this.options.transport.start())
      .then(
        () => {
          this.options.onError?.();
        },
        (error) => {
          this.options.onError?.(error);
          throw error;
        },
      );
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = undefined;
    }
  }

  private get ignoredPath() {
    return (
      this.options.ignoredAccountsPath ?? join(this.options.imageDirectory, 'ignored-accounts.json')
    );
  }

  private loadIgnored(): Promise<void> {
    if (!this.loadedIgnored)
      this.loadedIgnored = (async () => {
        try {
          const value: unknown = JSON.parse(await readFile(this.ignoredPath, 'utf8'));
          if (
            !Array.isArray(value) ||
            value.some(
              (partition) => typeof partition !== 'string' || !partition.startsWith('qianniu:'),
            )
          )
            throw new Error('千牛已移除账号记录格式无效');
          for (const partition of value) {
            this.ignored.add(partition);
            this.blocked.add(partition);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      })().catch((error) => {
        this.loadedIgnored = undefined;
        throw error;
      });
    return this.loadedIgnored;
  }

  private saveIgnored(): Promise<void> {
    const content = JSON.stringify([...this.ignored]);
    const task = this.ignoredWrite
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.ignoredPath), { recursive: true });
        await writeFile(`${this.ignoredPath}.tmp`, content, { mode: 0o600 });
        await rename(`${this.ignoredPath}.tmp`, this.ignoredPath);
      });
    this.ignoredWrite = task;
    return task;
  }

  private enqueue(loginId: string, task: () => Promise<unknown>) {
    if (this.closed || this.maintenance || this.platform !== 'win32') return;
    const generation = this.generation;
    const next = (this.queues.get(loginId) ?? Promise.resolve())
      .then(async () => {
        if (this.closed || this.maintenance || generation !== this.generation) return;
        await task();
      })
      .catch((error) => {
        this.options.notify({ type: 'connection_notice', message: `千牛：${messageText(error)}` });
      });
    this.queues.set(loginId, next);
    void next.finally(() => {
      if (this.queues.get(loginId) === next) this.queues.delete(loginId);
    });
  }

  private online(loginId: string) {
    return (
      !this.closed &&
      !this.maintenance &&
      !this.blocked.has(qianniuPartition(loginId)) &&
      this.options.transport
        .states()
        .some((state) => state.loginId === loginId && state.websocket && state.tcp)
    );
  }

  private session(accountId: string) {
    this.assertUsable();
    const entry = [...this.accounts].find(([, account]) => account.id === accountId);
    if (!entry || !this.online(entry[0])) throw new Error('千牛账号未连接，请先启动千牛并登录');
    const [loginId, account] = entry;
    const generation = this.generation,
      epoch = this.epochs.get(loginId) ?? 0;
    const check = () => {
      if (
        this.generation !== generation ||
        (this.epochs.get(loginId) ?? 0) !== epoch ||
        this.accounts.get(loginId) !== account ||
        !this.online(loginId)
      )
        throw new Error('操作期间千牛账号或连接已变化，请重新查询后再试');
    };
    return { loginId, account, generation, epoch, check };
  }

  private commerce(accountId: string) {
    const session = this.session(accountId);
    let cached = this.commerceAdapters.get(session.loginId);
    if (
      !cached ||
      cached.generation !== session.generation ||
      cached.epoch !== session.epoch ||
      cached.account !== session.account
    ) {
      const adapter = new QianniuCommerce(async (method, params) => {
        session.check();
        const result = await this.options.transport.invoke(session.loginId, method, params);
        session.check();
        return result;
      }, session.loginId);
      cached = {
        generation: session.generation,
        epoch: session.epoch,
        account: session.account,
        adapter,
      };
      this.commerceAdapters.set(session.loginId, cached);
    }
    return { ...session, adapter: cached.adapter };
  }

  private async imageBytes(url: string): Promise<Buffer | undefined> {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        !['alicdn.com', 'taobaocdn.com', 'tbcdn.cn', 'taobao.com', 'tmall.com'].some(
          (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
        )
      )
        return;
      const response = await (this.options.fetchImage ?? fetch)(parsed.href, {
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get('content-length') ?? 0) > 8 * 1024 * 1024
      )
        return;
      const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 8 * 1024 * 1024) return;
          parts.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      return length ? Buffer.concat(parts) : undefined;
    } catch {
      return; /* Keep the actual message when its image cannot be retrieved. */
    }
  }

  private async register(identity: QianniuIdentity) {
    const generation = this.generation;
    const partition = qianniuPartition(identity.loginId);
    if (this.blocked.has(partition)) return;
    let account = this.accounts.get(identity.loginId);
    if (!account) {
      // loginID is available before optional seller metadata and stays stable for subaccounts.
      const mainNick = identity.loginId.split(':')[0];
      account = (await this.options.request({
        type: 'account',
        input: {
          platform: 'qianniu',
          partition,
          mallId: `qianniu:${mainNick}`,
          mallName: identity.sellerName || mainNick,
          externalId: identity.loginId,
          name: identity.loginId,
          capabilities: caps(this.online(identity.loginId)),
        },
      })) as PlatformAccount;
      if (this.closed || generation !== this.generation || this.blocked.has(partition)) return;
      this.accounts.set(identity.loginId, account);
    }
    await this.report(identity.loginId);
    if (
      !this.closed &&
      generation === this.generation &&
      !this.maintenance &&
      !this.blocked.has(partition) &&
      this.options.transport
        .states()
        .some((state) => state.loginId === identity.loginId && state.websocket)
    )
      await this.options.native.onLogin(identity);
  }

  private async report(loginId: string) {
    const account = this.accounts.get(loginId);
    if (!account) return;
    const online = this.online(loginId);
    const blocked = this.blocked.has(account.sessionPartition);
    const state = this.options.transport.states().find((row) => row.loginId === loginId);
    await this.options.request({
      type: 'connection',
      input: {
        accountId: account.id,
        phase: online ? 'online' : !blocked && state?.websocket ? 'waiting_sdk' : 'offline',
        reason: blocked
          ? '千牛账号已断开'
          : online
            ? '千牛消息监听与发送已连接'
            : state?.websocket
              ? '正在自动连接千牛发送通道'
              : '等待千牛登录',
        capabilities: caps(online),
        diagnostics: { websocket: Boolean(state?.websocket), tcp: Boolean(state?.tcp) },
      },
    });
  }

  private async ingest(
    envelope: { loginId: string; eventKey: string; data: unknown },
    ack: () => void,
  ) {
    const generation = this.generation;
    const partition = qianniuPartition(envelope.loginId);
    if (this.blocked.has(partition)) return;
    if (!this.accounts.has(envelope.loginId)) {
      const state = this.options.transport
        .states()
        .find((row) => row.loginId === envelope.loginId && row.websocket);
      if (!state) return;
      await this.register(state.identity);
    }
    const account = this.accounts.get(envelope.loginId);
    if (!account || this.closed || this.maintenance || this.blocked.has(partition)) return;
    for (const raw of readQianniuMessages(envelope.data)) {
      const message = normalizeQianniuMessage(raw, account.id, envelope.loginId, envelope.eventKey);
      if (!message) continue;
      const imageBytes = message.remoteImageUrl
        ? await this.imageBytes(message.remoteImageUrl)
        : undefined;
      if (
        this.closed ||
        generation !== this.generation ||
        this.maintenance ||
        this.blocked.has(partition)
      )
        return;
      const pending = this.matchEcho(message, imageBytes);
      if (pending) {
        await this.options.request({
          type: 'confirmed',
          outboundId: pending.command.id,
          externalId: message.externalId,
        });
        pending.externalId = message.externalId;
      } else {
        await this.options.request({
          type: 'incoming',
          input: message,
          ...(imageBytes ? { imageBytes } : {}),
        });
      }
      if (
        this.closed ||
        generation !== this.generation ||
        this.maintenance ||
        this.blocked.has(partition)
      )
        return;
    }
    // Failed persistence leaves the envelope unacknowledged for the page's replay queue.
    ack();
  }

  private matchEcho(message: IncomingMessage, imageBytes?: Buffer): PendingSend | undefined {
    if (message.direction !== 'out' || !['text', 'image', 'product_card'].includes(message.kind))
      return;
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp)) return;
    const imageHash = imageBytes
      ? createHash('sha256').update(imageBytes).digest('hex')
      : undefined;
    const candidates = [...this.pending.values()].filter((pending) => {
      if (!pending.started) return false;
      if (
        pending.command.accountId !== message.accountId ||
        pending.command.conversationKey !== message.conversationKey ||
        pending.command.buyerId !== message.buyerId ||
        pending.command.kind !== message.kind ||
        (pending.externalId && pending.externalId !== message.externalId)
      )
        return false;
      const sameContent =
        message.kind === 'text'
          ? pending.command.text === message.text
          : message.kind === 'image'
            ? Boolean(imageHash && pending.imageHash === imageHash)
            : pending.command.richContent?.kind === 'product_card' &&
              message.richContent?.kind === 'product_card' &&
              pending.command.richContent.goodsId === message.richContent.goodsId;
      if (!sameContent) return false;
      // Only tolerate the platform's second precision. Widening this window can
      // incorrectly confirm a new send using an earlier identical human reply.
      if (
        timestamp < Math.floor(pending.started / 1000) * 1000 ||
        timestamp > pending.started + 60_000
      ) {
        pending.echoMismatchReason =
          '收到同内容的千牛记录，但消息时间与本次发送不匹配；请核对平台记录，并在 Windows「日期和时间」中同步时钟，请勿重复发送';
        return false;
      }
      return !message.historical;
    });
    // Identical concurrent sends cannot be distinguished by this native protocol.
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** Observe the native queue without consuming messages needed by the Qianniu UI. */
  private async awaitSendEcho(
    loginId: string,
    conversationKey: string,
    pending: PendingSend,
    checkSession: () => void,
  ) {
    if (pending.externalId) return;
    for (let attempt = 0; attempt < 3 && !pending.externalId; attempt++) {
      try {
        checkSession();
      } catch {
        return;
      }
      let settled = false;
      void this.options.transport
        .invoke(loginId, 'im.singlemsg.PeekNewMsg', { ccode: conversationKey })
        .catch(() => {})
        .finally(() => {
          settled = true;
        });
      // Bound the wait even if the SDK hangs, and do not stack further requests
      // on a slow page. A late reply can still confirm through normal ingestion.
      // Count timer intervals so correcting Windows wall time cannot prolong this wait.
      for (let tick = 0; tick < 30 && !pending.externalId; tick++) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          timer.unref?.();
        });
      }
      if (!settled) return;
    }
  }

  async connect(account?: PlatformAccount): Promise<unknown> {
    this.assertUsable();
    await this.loadIgnored();
    if (account) {
      this.blocked.delete(account.sessionPartition);
      this.ignored.delete(account.sessionPartition);
      this.accounts.set(account.externalId, account);
    } else {
      this.blocked.clear();
      this.ignored.clear();
    }
    await this.saveIgnored();
    await this.start();
    for (const state of this.options.transport.states())
      if (state.websocket && (!account || account.externalId === state.loginId))
        this.enqueue(state.loginId, () => this.register(state.identity));
    return this.options.native.start();
  }

  async restore(accounts: PlatformAccount[]): Promise<void> {
    if (this.platform !== 'win32') return;
    this.generation++;
    const wanted = new Set(accounts.map((account) => account.id));
    // Keep manually disconnected accounts disconnected when the patched client is still running.
    try {
      const stores = await this.options.request({ type: 'call', method: 'stores.list', input: {} });
      for (const store of Array.isArray(stores) ? stores : [])
        if (store.platform === 'qianniu')
          for (const account of store.accounts ?? [])
            if (!wanted.has(account.id)) this.blocked.add(account.sessionPartition);
    } catch (error) {
      this.options.notify({ type: 'connection_notice', message: `千牛：${messageText(error)}` });
      return;
    }
    this.accounts.clear();
    for (const account of accounts) {
      this.blocked.delete(account.sessionPartition);
      this.accounts.set(account.externalId, account);
    }
    try {
      await this.start();
      for (const state of this.options.transport.states())
        if (state.websocket) this.enqueue(state.loginId, () => this.register(state.identity));
      for (const account of accounts)
        this.enqueue(account.externalId, () => this.report(account.externalId));
    } catch {
      /* The setup status exposes bind errors and allows a retry. */
    }
  }

  async verify(accountId: string) {
    this.assertUsable();
    const entry = [...this.accounts].find(([, account]) => account.id === accountId);
    if (!entry || !this.online(entry[0])) throw new Error('千牛尚未同时连接消息监听和发送通道');
    return { identity: { loginId: entry[0] }, capabilities: caps(true) };
  }

  async query(
    accountId: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const session = this.commerce(accountId);
    if (operation === 'history') {
      const { buyerId, conversationKey, platformContext, ...params } = input;
      if (
        typeof buyerId !== 'string' ||
        !buyerId ||
        buyerId.length > 200 ||
        typeof conversationKey !== 'string' ||
        !conversationKey ||
        conversationKey.length > 1000
      )
        throw new Error('缺少当前买家和会话标识，请重新打开会话');
      platformContextSchema.parse(platformContext ?? {});
      const parsed = commerceQuerySchemas.history.parse(params);
      const result = await this.options.request({
        type: 'platform_local_history',
        input: { accountId, buyerId, conversationKey, ...parsed },
      });
      session.check();
      return result;
    }
    const result = await session.adapter.query(operation, input);
    session.check();
    return result;
  }

  async staff(accountId: string) {
    const session = this.commerce(accountId);
    const result = await session.adapter.staff();
    session.check();
    return result;
  }

  private action(key: string, command: unknown, execute: () => Promise<PlatformActionResult>) {
    const fingerprint = JSON.stringify(command),
      existing = this.actions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error('操作标识已用于其他请求，请重新提交');
      return existing.task;
    }
    const task = execute();
    this.actions.set(key, { fingerprint, task });
    void task
      .finally(() => {
        if (this.actions.size > 500) this.actions.delete(this.actions.keys().next().value!);
      })
      .catch(() => {});
    return task;
  }

  async executeTransfer(value: TransferCommand): Promise<PlatformActionResult> {
    const command = transferCommandSchema.parse(value);
    return this.action(`transfer:${command.id}`, command, async () => {
      const session = this.commerce(command.accountId);
      const result = await session.adapter.transfer(command, async (preview) => {
        session.check();
        await this.options.request({
          type: 'platform_transfer_guard',
          actionId: command.id,
          preview,
        });
        session.check();
      });
      session.check();
      return result;
    });
  }

  async executeQuickAction(value: QuickCommand): Promise<PlatformActionResult> {
    const command = quickCommandSchema.parse(value);
    return this.action(`quick:${command.id}`, command, async () => {
      const session = this.commerce(command.accountId);
      const result = await session.adapter.quick(command, async (preview) => {
        session.check();
        await this.options.request({ type: 'platform_quick_guard', actionId: command.id, preview });
        session.check();
      });
      session.check();
      return result;
    });
  }

  async send(command: SendCommand): Promise<SendResult> {
    this.assertUsable();
    const existing = this.sends.get(command.id);
    if (existing) return existing;
    const promise = this.dispatch(command);
    this.sends.set(command.id, promise);
    void promise
      .finally(() => {
        if (this.sends.size > 500) this.sends.delete(this.sends.keys().next().value!);
        for (const [id, pending] of this.pending)
          if (pending.started < Date.now() - 10 * 60_000) this.pending.delete(id);
        while (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value!);
      })
      .catch(() => {});
    return promise;
  }

  private async dispatch(command: SendCommand): Promise<SendResult> {
    const entry = [...this.accounts].find(([, account]) => account.id === command.accountId);
    if (!entry || !this.online(entry[0])) return { status: 'rejected', reason: '千牛账号未连接' };
    if (!command.conversationKey)
      return { status: 'rejected', reason: '缺少已观察到的千牛会话标识' };
    const session = this.commerce(command.accountId);
    if (command.kind === 'product_card') {
      const pending: PendingSend = { command, started: 0 };
      try {
        const result = await session.adapter.sendRich(command, () => {
          session.check();
          pending.started = Date.now();
          this.pending.set(command.id, pending);
        });
        session.check();
        if (pending.externalId) return { status: 'confirmed', externalId: pending.externalId };
        if (result.status === 'rejected') this.pending.delete(command.id);
        return result;
      } catch (error) {
        if (pending.externalId) return { status: 'confirmed', externalId: pending.externalId };
        if (!pending.started)
          return { status: 'rejected', reason: `千牛商品卡片未提交：${messageText(error)}` };
        return { status: 'unknown', reason: `千牛商品卡片发送结果待核实：${messageText(error)}` };
      }
    }
    if (command.kind !== 'text' && command.kind !== 'image')
      return { status: 'rejected', reason: '千牛当前支持文字、图片和商品卡片' };
    const params: Record<string, unknown> = { id: command.conversationKey, keep: 'off' };
    let imageHash: string | undefined;
    if (command.kind === 'text') {
      if (!command.text.trim()) return { status: 'rejected', reason: '消息不能为空' };
      params.text = command.text;
    } else {
      const extension = (
        {
          'image/png': 'png',
          'image/jpeg': 'jpg',
          'image/gif': 'gif',
          'image/webp': 'webp',
        } as Record<string, string>
      )[command.imageMime ?? ''];
      if (
        !extension ||
        !command.imageData ||
        !/^[a-z\d+/]*={0,2}$/i.test(command.imageData) ||
        command.imageData.length > 12 * 1024 * 1024
      )
        return { status: 'rejected', reason: '图片格式或大小不支持' };
      const bytes = Buffer.from(command.imageData, 'base64');
      if (!bytes.length || bytes.length > 8 * 1024 * 1024)
        return { status: 'rejected', reason: '图片大小不支持' };
      await mkdir(this.options.imageDirectory, { recursive: true });
      // Retain the local file: a Hook success reply does not prove it has finished reading it.
      const path = join(
        this.options.imageDirectory,
        `${createHash('sha256').update(command.id).digest('hex')}.${extension}`,
      );
      await writeFile(path, bytes, { mode: 0o600 });
      params.image = path;
      imageHash = createHash('sha256').update(bytes).digest('hex');
    }
    try {
      session.check();
    } catch {
      return { status: 'rejected', reason: '发送前千牛账号或连接已变化' };
    }
    const pending: PendingSend = {
      command,
      started: 0,
      ...(imageHash ? { imageHash } : {}),
    };
    try {
      const result = await this.options.transport.send(
        entry[0],
        command.kind === 'text' ? 'sendtext' : 'sendimage',
        params,
        () => {
          session.check();
          pending.started = Date.now();
          this.pending.set(command.id, pending);
        },
      );
      if (pending.externalId) return { status: 'confirmed', externalId: pending.externalId };
      if (
        result &&
        typeof result === 'object' &&
        (('error' in result && Boolean(result.error)) ||
          ('success' in result && result.success === false) ||
          ('result' in result && [false, 'failed', 'fail', 'error'].includes(result.result as any)))
      ) {
        this.pending.delete(command.id);
        return { status: 'rejected', reason: '千牛拒绝了发送请求' };
      }
      await this.awaitSendEcho(entry[0], command.conversationKey, pending, session.check);
      if (pending.externalId) return { status: 'confirmed', externalId: pending.externalId };
      return {
        status: 'unknown',
        reason:
          pending.echoMismatchReason ?? '已提交千牛，等待带有平台消息 ID 的发送回执，请勿重复发送',
      };
    } catch (error) {
      if (!pending.started || (error instanceof QianniuSendError && error.outcome === 'rejected')) {
        this.pending.delete(command.id);
        return { status: 'rejected', reason: `千牛未发送消息：${messageText(error)}` };
      }
      if (pending.externalId) return { status: 'confirmed', externalId: pending.externalId };
      return { status: 'unknown', reason: `千牛发送结果待核实：${messageText(error)}` };
    }
  }

  disconnect(accountId: string) {
    const entry = [...this.accounts].find(([, account]) => account.id === accountId);
    if (!entry) return;
    this.epochs.set(entry[0], (this.epochs.get(entry[0]) ?? 0) + 1);
    this.blocked.add(entry[1].sessionPartition);
    this.options.notify({ type: 'offline', accountId });
  }

  async forgetPartition(partition: string) {
    await this.loadIgnored();
    this.blocked.add(partition);
    this.ignored.add(partition);
    await this.saveIgnored();
    for (const [loginId, account] of this.accounts)
      if (account.sessionPartition === partition) this.accounts.delete(loginId);
  }

  setMaintenance(paused: boolean) {
    this.maintenance = paused;
    this.generation++;
    this.options.native.setMaintenance?.(paused);
    if (!paused && !this.closed)
      for (const state of this.options.transport.states())
        if (state.websocket) this.enqueue(state.loginId, () => this.register(state.identity));
  }

  async close() {
    this.closed = true;
    this.generation++;
    this.commerceAdapters.clear();
    this.options.native.close?.();
    for (const account of this.accounts.values())
      this.options.notify({ type: 'offline', accountId: account.id });
    await this.startTask?.catch(() => {});
    await this.options.transport.close();
    await Promise.allSettled([...this.queues.values()]);
  }
}
