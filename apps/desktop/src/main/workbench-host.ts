import {
  quickCommandSchema,
  type QuickCommand,
} from '../../../../packages/contracts/src/commerce-extra';
import { BrowserWindow, WebContentsView, session } from 'electron';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assert } from '../../../../packages/core/src/util';
import {
  transferCommandSchema,
  type TransferCommand,
} from '../../../../packages/contracts/src/workbench';
import { normalizeStaff, transferResult } from '../../../../packages/platforms/src/staff';
import type { PlatformActionResult } from '../../../../packages/contracts/src/commerce-tools';
import {
  commerceQuerySchemas,
  type CommerceQueryOperation,
} from '../../../../packages/contracts/src/commerce-tools';
import {
  platformContextSchema,
  type PlatformId,
} from '../../../../packages/contracts/src/platform';
import {
  disabledCapabilities,
  type IncomingMessage,
  type Capabilities,
  type PddConnectionState,
  type SendCommand,
  type SendResult,
} from '../../../../packages/contracts/src/index';
export type PlatformAccount = {
  id: string;
  sessionPartition: string;
  storeId: string;
  externalId: string;
};
export type WorkbenchEntry = {
  window: BrowserWindow;
  view: WebContentsView;
  partition: string;
  account?: PlatformAccount;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
  pollController?: AbortController;
  ready: boolean;
  mallId?: string;
  paused: boolean;
  redirectedToChat?: boolean;
  navigating?: boolean;
  loadFailures: number;
  generation: number;
  registered: boolean;
  identityValid: boolean;
  identityCheckedAt: number;
  publishedConnection?: string;
  publishedAt?: number;
  reportQueue: Promise<unknown>;
};
export interface WorkbenchAdapter {
  platform: PlatformId;
  name: string;
  url: string;
  startUrl?: string;
  isLoginPage?(url: URL): boolean;
  /** Official login redirect for an expired-session interstitial. */
  loginRedirect?(url: URL): string | undefined;
  shouldOpenChat?(url: URL): boolean;
  /** Page JS that returns true once the login host already has a usable session. */
  sessionReadyOnLoginPage?: string;
  allowedHost(hostname: string): boolean;
  pageAllowed(url: URL): boolean;
  chatPage(url: URL): boolean;
  imageHost(hostname: string): boolean;
  normalizeMessage(accountId: string, raw: unknown): IncomingMessage | null;
  normalizeQuery(
    operation: CommerceQueryOperation,
    raw: unknown,
    input: Record<string, unknown>,
    buyerId: string,
  ): unknown;
}
export class WorkbenchHost {
  protected entries = new Map<string, WorkbenchEntry>();
  private script = '';
  private maintenance = false;
  private transferResults = new Map<string, Promise<PlatformActionResult>>();
  setMaintenance(paused: boolean) {
    this.maintenance = paused;
  }
  constructor(
    private bridgeFile: string,
    protected request: (data: Record<string, unknown>) => Promise<any>,
    private notify: (data: unknown) => void,
    private reloadBridge: boolean,
    protected adapter: WorkbenchAdapter,
  ) {}
  async restore(accounts: PlatformAccount[]) {
    for (const entry of this.entries.values()) {
      if (entry.account && !accounts.some((a) => a.id === entry.account!.id)) {
        this.dispose(entry);
        continue;
      }
      entry.generation++;
      entry.pollController?.abort();
      entry.busy = false;
      entry.ready = false;
      entry.registered = false;
      entry.identityValid = false;
      entry.publishedConnection = undefined;
    }
    await Promise.allSettled(accounts.map((account) => this.connect(account, false)));
  }
  async connect(account?: PlatformAccount, visible = true) {
    const current = account
      ? [...this.entries.values()].find((e) => e.account?.id === account.id)
      : [...this.entries.values()].find((e) => !e.account && !e.paused);
    if (current) {
      if (visible && !current.window.isDestroyed()) current.window.show();
      if (!current.ready) {
        current.identityValid = false;
        current.redirectedToChat = false;
        void this.poll(current);
      }
      return { opened: true };
    }
    this.script ||= await readFile(this.bridgeFile, 'utf8');
    const partition =
      account?.sessionPartition ?? `persist:judesk-${this.adapter.platform}-${randomUUID()}`;
    const window = new BrowserWindow({
      show: visible,
      width: 1180,
      height: 820,
      title: `${this.adapter.name}商家登录 · 句达`,
      backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    const ses = view.webContents.session;
    ses.setUserAgent(
      process.platform === 'win32'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
    await ses.setProxy({ mode: 'system' }).catch(() => {});
    window.contentView.addChildView(view);
    const resize = () => {
      if (window.isDestroyed() || view.webContents.isDestroyed()) return;
      const [width, height] = window.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    resize();
    window.on('resize', resize);
    const entry: WorkbenchEntry = {
      window,
      view,
      partition,
      account,
      busy: false,
      ready: false,
      paused: false,
      generation: 0,
      registered: false,
      loadFailures: 0,
      identityValid: false,
      identityCheckedAt: 0,
      reportQueue: Promise.resolve(),
    };
    this.entries.set(partition, entry);
    window.on('close', (event) => {
      if (entry.paused) return;
      event.preventDefault();
      if (!entry.account) {
        this.dispose(entry);
        return;
      }
      window.hide();
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (
          u.protocol === 'https:' &&
          this.adapter.allowedHost(u.hostname) &&
          !view.webContents.isDestroyed()
        )
          void this.openPage(entry, url);
      } catch {
        /* ignore malformed popup urls */
      }
      return { action: 'deny' };
    });
    view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    view.webContents.on('will-navigate', (event, url) => {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !this.adapter.allowedHost(u.hostname))
          event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    view.webContents.on('did-start-navigation', (details, _url, isSameDocument, isMainFrame) => {
      // PDD embeds frames and changes SPA routes; neither drops the main document's bridge.
      if (!(details.isMainFrame ?? isMainFrame) || (details.isSameDocument ?? isSameDocument))
        return;
      entry.generation++;
      entry.pollController?.abort();
      entry.busy = false;
      entry.ready = false;
      entry.identityValid = false;
      void this.report(
        entry,
        'connecting',
        `正在加载${this.adapter.name}页面并建立消息通道。`,
      ).catch(() => {});
    });
    view.webContents.on('did-fail-load', (_event, code, description, failed, isMainFrame) => {
      if (!isMainFrame || entry.paused || code === -3) return;
      entry.navigating = false;
      void this.report(
        entry,
        'error',
        `${this.adapter.name}页面加载失败（${description || code}）。若使用系统代理，请允许 Electron 走代理或改为 TUN 模式后重试。`,
      ).catch(() => {});
      if (entry.loadFailures < 4)
        void this.openPage(entry, failed || this.adapter.startUrl || this.adapter.url, true);
    });
    view.webContents.on('did-finish-load', () => {
      entry.navigating = false;
      entry.loadFailures = 0;
    });
    view.webContents.on('dom-ready', () => {
      entry.navigating = false;
    });
    view.webContents.on('render-process-gone', () => {
      entry.generation++;
      entry.pollController?.abort();
      entry.busy = false;
      entry.ready = false;
      entry.identityValid = false;
      void this.report(
        entry,
        'error',
        `${this.adapter.name}页面进程已退出，请重启句达恢复连接。`,
      ).catch(() => {});
    });
    entry.timer = setInterval(() => void this.poll(entry), 1000);
    // Login can navigate before loadURL settles. Start detection independently of that promise.
    void this.openPage(entry, this.adapter.startUrl ?? this.adapter.url);
    return { opened: true };
  }
  private async openPage(entry: WorkbenchEntry, url: string, retry = false) {
    if (entry.paused || entry.navigating || entry.view.webContents.isDestroyed()) return;
    try {
      if (!retry && entry.view.webContents.getURL() === url) return;
    } catch {
      /* getURL can throw while the view is tearing down */
    }
    if (retry) {
      entry.loadFailures++;
      await new Promise((resolve) => setTimeout(resolve, 800 * entry.loadFailures));
      if (entry.paused || entry.view.webContents.isDestroyed()) return;
    }
    entry.navigating = true;
    try {
      await entry.view.webContents.loadURL(url);
    } catch {
      entry.navigating = false;
    }
  }
  private isLoginPage(url: URL) {
    return this.adapter.isLoginPage?.(url) ?? url.pathname.includes('/login');
  }
  private report(
    entry: WorkbenchEntry,
    phase: PddConnectionState['phase'],
    reason: string,
    capabilities: Capabilities = disabledCapabilities,
    diagnostics?: PddConnectionState['diagnostics'],
  ) {
    if (entry.paused) return Promise.resolve();
    if (!entry.account) {
      const signature = JSON.stringify({ phase, reason });
      if (entry.publishedConnection !== signature) {
        entry.publishedConnection = signature;
        if (!entry.window.isDestroyed()) entry.window.setTitle(`${this.adapter.name} · ${reason}`);
        if (phase === 'error')
          this.notify({ type: 'connection_notice', message: `${this.adapter.name}：${reason}` });
      }
      return Promise.resolve();
    }
    const input: PddConnectionState = {
      accountId: entry.account.id,
      phase,
      reason,
      capabilities,
      diagnostics,
    };
    const signature = JSON.stringify(input);
    // Publish in order so a late "online" RPC cannot overwrite a later disconnect.
    const queued = entry.reportQueue
      .catch(() => {})
      .then(async () => {
        if (entry.paused) return;
        if (
          entry.publishedConnection === signature &&
          Date.now() - (entry.publishedAt ?? 0) < 30000
        )
          return;
        await this.request({ type: 'connection', input });
        entry.publishedConnection = signature;
        entry.publishedAt = Date.now();
      });
    entry.reportQueue = queued;
    return queued;
  }
  private async inspectPage(entry: WorkbenchEntry, code: string, signal: AbortSignal) {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('页面检查已取消'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('页面检查超时，将自动重试')), 15000);
    });
    try {
      return await Promise.race([entry.view.webContents.executeJavaScript(code), stopped]);
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener('abort', abort);
    }
  }
  private async poll(entry: WorkbenchEntry) {
    if (
      this.maintenance ||
      entry.busy ||
      entry.paused ||
      entry.navigating ||
      entry.view.webContents.isDestroyed()
    )
      return;
    entry.busy = true;
    const controller = new AbortController();
    entry.pollController = controller;
    const inspect = (code: string) => this.inspectPage(entry, code, controller.signal);
    const generation = entry.generation;
    const current = () =>
      !entry.paused && !entry.view.webContents.isDestroyed() && entry.generation === generation;
    let stage = '页面连接';
    let url: URL | undefined;
    try {
      url = new URL(entry.view.webContents.getURL() || 'about:blank');
      if (
        url.protocol === 'chrome-error:' ||
        url.protocol === 'chrome:' ||
        url.href === 'about:blank'
      ) {
        await this.report(
          entry,
          'connecting',
          `正在重新打开${this.adapter.name}页面。若长时间失败，请检查系统代理或改为 TUN 模式。`,
        );
        await this.openPage(entry, this.adapter.startUrl ?? this.adapter.url);
        return;
      }
      if (this.isLoginPage(url)) {
        entry.ready = false;
        entry.identityValid = false;
        const loginRedirect = this.adapter.loginRedirect?.(url);
        if (loginRedirect) {
          const destination = new URL(loginRedirect);
          assert(
            destination.protocol === 'https:' && this.adapter.allowedHost(destination.hostname),
            '平台登录地址不可用',
          );
          await this.openPage(entry, loginRedirect);
          return;
        }
        if (this.adapter.sessionReadyOnLoginPage && !entry.redirectedToChat) {
          const ready = await inspect(this.adapter.sessionReadyOnLoginPage).catch(() => false);
          if (ready && current()) {
            entry.redirectedToChat = true;
            await this.report(
              entry,
              'waiting_chat',
              `账号已登录，正在打开${this.adapter.name}聊天工作台。`,
            );
            await this.openPage(entry, this.adapter.url);
            return;
          }
        }
        entry.redirectedToChat = false;
        await this.report(entry, 'needs_login', '当前未进入商家聊天页，请在平台窗口完成登录。');
        return;
      }
      if (!this.adapter.chatPage(url)) {
        entry.ready = false;
        entry.identityValid = false;
        if (this.adapter.pageAllowed(url) || this.adapter.shouldOpenChat?.(url)) {
          await this.report(
            entry,
            'waiting_chat',
            `账号已登录，正在打开${this.adapter.name}聊天工作台。`,
          );
          if (current() && !entry.redirectedToChat) {
            entry.redirectedToChat = true;
            await this.openPage(entry, this.adapter.url);
          }
          return;
        }
        await this.report(entry, 'needs_login', '当前未进入商家聊天页，请在平台窗口完成登录。');
        return;
      }
      entry.redirectedToChat = false;
      if (this.reloadBridge) this.script = await readFile(this.bridgeFile, 'utf8');
      stage = '消息桥接';
      await inspect(this.script);
      if (!current()) return;
      stage = '账号识别';
      if (!entry.identityValid || Date.now() - entry.identityCheckedAt > 30000) {
        const identity = await inspect('window.__judeskBridge.identity()');
        if (!current()) return;
        assert(
          !entry.account || identity.externalId === entry.account.externalId,
          '登录身份已改变，请为新身份添加账号。',
        );
        assert(
          !entry.mallId || identity.mallId === entry.mallId,
          '登录店铺已改变，请为新店铺添加账号。',
        );
        if (!entry.registered) {
          const account = await this.request({
            type: 'account',
            input: {
              ...identity,
              platform: this.adapter.platform,
              partition: entry.partition,
              capabilities: disabledCapabilities,
            },
          });
          if (!current()) return;
          entry.account = account;
          entry.registered = true;
        }
        entry.mallId = identity.mallId;
        entry.identityValid = true;
        entry.identityCheckedAt = Date.now();
        if (!entry.window.isDestroyed())
          entry.window.setTitle(`${identity.mallName} · ${identity.name} · ${this.adapter.name}`);
      }
      stage = '消息通道';
      const polled = await inspect('window.__judeskBridge.poll()');
      if (!current()) return;
      const capabilities: Capabilities = {
        ...disabledCapabilities,
        ...polled.capabilities,
        verified: false,
      };
      const diagnostics = polled.diagnostics;
      if (polled.overflow) {
        entry.ready = false;
        await this.report(
          entry,
          'error',
          '消息缓冲已满，接收已暂停；请核对平台记录后重新打开平台。',
          disabledCapabilities,
          diagnostics,
        );
        return;
      }
      const connected = Boolean(
        polled.attached &&
          capabilities.receive &&
          capabilities.sendText &&
          diagnostics?.sendReceiptHook !== false,
      );
      entry.ready = connected;
      const reason = connected
        ? '句达消息监听和发送通道已连接；平台登录与自动接待验收分别记录。'
        : !polled.attached || !capabilities.receive
          ? '账号已登录，尚未接入聊天消息监听；请确认平台窗口已进入聊天工作台。'
          : !capabilities.sendText
            ? `已监听聊天消息，等待${this.adapter.name}发送接口就绪。`
            : '已连接聊天页面，等待发送回执接口就绪。';
      await this.report(
        entry,
        connected ? 'online' : 'waiting_sdk',
        reason,
        capabilities,
        diagnostics,
      );
      if (!current()) return;
      for (const event of polled.events ?? []) {
        if (!current()) return;
        await this.ingest(entry, event);
        if (!current()) return;
        await entry.view.webContents.executeJavaScript(
          `window.__judeskBridge.ack(${Number(event.sequence)})`,
        );
      }
    } catch (error) {
      if (!current()) return;
      entry.ready = false;
      const message = error instanceof Error ? error.message : String(error);
      // Persist a useful stage without logging platform payloads, cookies or customer content.
      const needsLogin = stage === '账号识别' && /尚未登录|登录身份不可用/.test(message);
      if (needsLogin && this.adapter.startUrl && url && !this.isLoginPage(url) && current()) {
        entry.redirectedToChat = false;
        await this.openPage(entry, this.adapter.startUrl ?? this.adapter.url);
      }
      await this.report(
        entry,
        needsLogin ? 'needs_login' : 'error',
        needsLogin
          ? '平台登录已失效，请打开平台重新登录。'
          : `${stage}未完成：${message.slice(0, 240)}`,
      ).catch(() => {});
    } finally {
      if (entry.pollController === controller) {
        entry.busy = false;
        entry.pollController = undefined;
      }
    }
  }
  private async ingest(entry: WorkbenchEntry, event: any) {
    if (!entry.account) return;
    if (
      event.type === 'send_rejected' &&
      typeof event.outboundId === 'string' &&
      typeof event.reason === 'string'
    ) {
      await this.request({
        type: 'send_rejected',
        outboundId: event.outboundId,
        reason: event.reason,
      });
      return;
    }
    if (
      event.type === 'confirmed' &&
      typeof event.outboundId === 'string' &&
      typeof event.externalId === 'string'
    ) {
      await this.request({
        type: 'confirmed',
        outboundId: event.outboundId,
        externalId: event.externalId,
      });
      return;
    }
    if (event.type !== 'message') return;
    if (event.outboundId) {
      await this.request({
        type: 'confirmed',
        id: undefined,
        outboundId: event.outboundId,
        externalId: String(event.message.msg_id),
      });
      return;
    }
    const message = this.adapter.normalizeMessage(entry.account.id, event.message);
    if (!message && this.adapter.platform !== 'pinduoduo') {
      await this.report(
        entry,
        'waiting_sdk',
        `收到${this.adapter.name}事件，但尚不能确认消息身份或格式。`,
        disabledCapabilities,
        { unrecognizedMessage: true },
      );
      return;
    }
    if (message) {
      let imageBytes: Buffer | undefined;
      if (message.remoteImageUrl)
        try {
          const url = new URL(message.remoteImageUrl);
          assert(
            url.protocol === 'https:' && this.adapter.imageHost(url.hostname),
            '未识别的图片来源',
          );
          const response = await entry.view.webContents.session.fetch(url.href, {
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          });
          assert(
            response.ok && Number(response.headers.get('content-length') ?? 0) <= 8 * 1024 * 1024,
            '图片下载失败或过大',
          );
          const reader = response.body!.getReader();
          const parts: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.length;
              assert(length <= 8 * 1024 * 1024, '图片过大');
              parts.push(chunk.value);
            }
          } finally {
            await reader.cancel();
          }
          imageBytes = Buffer.concat(parts);
        } catch {
          /* Keep the actual message even if its image is unavailable. */
        }
      await this.request({ type: 'incoming', input: message, imageBytes });
    }
  }
  protected get(accountId: string) {
    const entry = [...this.entries.values()].find((e) => e.account?.id === accountId);
    assert(entry?.ready && !entry.paused, '句达消息通道尚未就绪，请查看账号下方的连接原因。');
    return entry;
  }
  async verify(accountId: string) {
    const entry = this.get(accountId);
    const identity = await entry.view.webContents.executeJavaScript(
      'window.__judeskBridge.identity()',
    );
    assert(
      identity.externalId === entry.account?.externalId && identity.mallId === entry.mallId,
      '登录身份已改变',
    );
    const state = await entry.view.webContents.executeJavaScript('window.__judeskBridge.poll()');
    assert(
      state.capabilities.receive && state.capabilities.sendText,
      '消息监听或发送 SDK 尚未就绪',
    );
    return { identity, capabilities: state.capabilities };
  }
  async send(command: SendCommand): Promise<SendResult> {
    const entry = this.get(command.accountId);
    const generation = entry.generation;
    await this.verify(command.accountId);
    if (command.kind === 'review_card') {
      try {
        assert(
          this.adapter.platform === 'douyin' && command.richContent?.kind === 'review_card',
          '当前平台不支持邀请评价',
        );
        const orders = await this.query(command.accountId, 'buyer-orders', {
          buyerId: command.buyerId,
          conversationKey: command.conversationKey,
          platformContext: command.platformContext,
          page: 1,
          pageSize: 30,
          keyword: command.richContent.orderSn,
        });
        assert(
          (orders.data.orders as any[]).some(
            (o) => o.orderSn === (command.richContent as any).orderSn,
          ),
          '当前买家未查到目标订单',
        );
        assert(
          entry.ready && !entry.paused && generation === entry.generation,
          '邀请评价前账号已变化',
        );
      } catch (e) {
        return {
          status: 'rejected',
          reason: `未发送评价邀请：${e instanceof Error ? e.message : '订单核验失败'}`,
        };
      }
    }
    const result = await entry.view.webContents.executeJavaScript(
      `window.__judeskBridge.send(${JSON.stringify(command)})`,
    );
    if (entry.paused || entry.generation !== generation)
      return { status: 'unknown', reason: '发送期间页面会话已变化，请核对平台记录' };
    if (result?.status === 'confirmed' && typeof result.externalId === 'string') return result;
    if (result?.status === 'rejected') return result;
    // Wait only for a definitive result from this command, including late rejections.
    let latest = result;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const confirmed = await entry.view.webContents.executeJavaScript(
        `window.__judeskBridge.sends.get(${JSON.stringify(command.id)})`,
      );
      if (confirmed?.status === 'confirmed' || confirmed?.status === 'rejected') return confirmed;
      if (confirmed?.status === 'unknown') latest = confirmed;
    }
    return {
      status: 'unknown',
      reason: latest?.reason || '未收到对应平台消息的确认，请核对平台记录',
    };
  }
  async query(accountId: string, operation: string, input: Record<string, unknown>) {
    assert(
      operation === 'conversations' || Object.hasOwn(commerceQuerySchemas, operation),
      'unsupported',
    );
    const entry = this.get(accountId),
      generation = entry.generation;
    await this.verify(accountId);
    const { buyerId, conversationKey, platformContext, orderSn, ...params } = input;
    const isOrderQuery = ['order-detail', 'order-logistics', 'order-remark-state'].includes(
      operation,
    );
    assert(
      !isOrderQuery || (typeof orderSn === 'string' && /^\d[0-9-]{0,79}$/.test(orderSn)),
      '缺少已核验的订单编号',
    );
    assert(isOrderQuery || orderSn === undefined, '查询参数无效');
    const parsed =
      operation === 'conversations'
        ? {}
        : commerceQuerySchemas[operation as CommerceQueryOperation].parse(params);
    assert(operation === 'conversations' || typeof buyerId === 'string', '缺少当前买家');
    const raw = await entry.view.webContents.executeJavaScript(
      `window.__judeskBridge.query(${JSON.stringify(operation)},${JSON.stringify({ ...parsed, buyerId, ...(isOrderQuery ? { orderSn } : {}), ...(this.adapter.platform !== 'pinduoduo' ? { conversationKey, platformContext: platformContextSchema.parse(platformContext ?? {}) } : {}) })})`,
    );
    assert(
      entry.ready && !entry.paused && entry.generation === generation,
      '平台会话在查询期间已变化',
    );
    await this.verify(accountId);
    return operation === 'conversations'
      ? raw
      : this.adapter.normalizeQuery(
          operation as CommerceQueryOperation,
          raw,
          parsed,
          String(buyerId),
        );
  }
  async markRead(
    accountId: string,
    input: {
      conversationKey: string;
      buyerId: string;
      messageIds: string[];
      platformContext?: Record<string, unknown>;
    },
  ) {
    const entry = this.get(accountId),
      generation = entry.generation;
    await this.verify(accountId);
    const result = await entry.view.webContents.executeJavaScript(
      `window.__judeskBridge.markRead(${JSON.stringify(input)})`,
    );
    assert(
      entry.ready && !entry.paused && generation === entry.generation,
      '已读同步期间账号已变化',
    );
    return result;
  }
  async executeQuickAction(value: QuickCommand): Promise<PlatformActionResult> {
    const command = quickCommandSchema.parse(value);
    assert(
      this.adapter.platform === 'douyin' ||
        (this.adapter.platform === 'kuaishou' && command.operation === 'transfer-group'),
      '此平台不支持该快捷操作',
    );
    const existing = this.transferResults.get(command.id);
    if (existing) return existing;
    const task = (async (): Promise<PlatformActionResult> => {
      const entry = this.get(command.accountId),
        generation = entry.generation;
      const check = () =>
        assert(
          entry.ready && !entry.paused && generation === entry.generation,
          '操作期间账号已变化',
        );
      const scope = {
        buyerId: command.buyerId,
        conversationKey: command.conversationKey,
        platformContext: command.platformContext,
      };
      if (command.operation === 'transfer-group') {
        const result = await this.query(command.accountId, 'staff-groups', scope);
        assert(
          (result.data.groups as any[]).some((g) => g.id === command.targetId),
          '客服组已不在当前可转接列表',
        );
      }
      if (command.operation === 'invite-order')
        await this.query(command.accountId, 'goods-detail', {
          ...scope,
          goodsId: command.targetId,
        });
      await this.verify(command.accountId);
      check();
      await this.request({
        type: 'platform_quick_guard',
        actionId: command.id,
        preview: {
          operation: command.operation,
          buyerId: command.buyerId,
          conversationKey: command.conversationKey,
          targetId: command.targetId,
        },
      });
      check();
      const raw = await entry.view.webContents.executeJavaScript(
        `window.__judeskBridge.quickAction(${JSON.stringify(command)})`,
      );
      check();
      const result = transferResult(this.adapter.platform, raw);
      return {
        ...result,
        message:
          result.status === 'confirmed'
            ? '平台已确认操作'
            : result.status === 'rejected'
              ? '平台拒绝操作，请检查权限和目标状态'
              : '平台未返回明确回执，请在原平台核对，勿重复提交',
      };
    })();
    this.transferResults.set(command.id, task);
    void task
      .finally(() => {
        if (this.transferResults.size > 500)
          this.transferResults.delete(this.transferResults.keys().next().value!);
      })
      .catch(() => {});
    return task;
  }
  async staff(accountId: string) {
    assert(this.adapter.platform !== 'goofish', '当前平台尚未提供客服转接');
    const entry = this.get(accountId),
      generation = entry.generation;
    await this.verify(accountId);
    const raw = await entry.view.webContents.executeJavaScript('window.__judeskBridge.staff()');
    assert(
      entry.ready && !entry.paused && entry.generation === generation,
      '查询期间平台账号已变化',
    );
    return normalizeStaff(this.adapter.platform, raw, entry.account!.externalId);
  }
  async executeTransfer(value: TransferCommand): Promise<PlatformActionResult> {
    const command = transferCommandSchema.parse(value);
    const pending = this.transferResults.get(command.id);
    if (pending) return pending;
    const task = (async (): Promise<PlatformActionResult> => {
      const entry = this.get(command.accountId),
        generation = entry.generation;
      const check = () =>
        assert(
          entry.ready && !entry.paused && entry.generation === generation,
          '转接期间平台账号已变化',
        );
      const target = (await this.staff(command.accountId)).find(
        (s) => s.id === command.targetStaffId,
      );
      assert(target, '该客服已不在平台可转接列表中');
      await this.verify(command.accountId);
      check();
      await this.request({
        type: 'platform_transfer_guard',
        actionId: command.id,
        preview: {
          targetStaffId: target.id,
          targetName: target.name,
          buyerId: command.buyerId,
          conversationKey: command.conversationKey,
        },
      });
      check();
      const raw = await entry.view.webContents.executeJavaScript(
        `window.__judeskBridge.transfer(${JSON.stringify(command)})`,
      );
      check();
      return transferResult(this.adapter.platform, raw);
    })();
    this.transferResults.set(command.id, task);
    void task
      .finally(() => {
        if (this.transferResults.size > 500)
          this.transferResults.delete(this.transferResults.keys().next().value!);
      })
      .catch(() => {});
    return task;
  }
  disconnect(accountId: string) {
    const entry = [...this.entries.values()].find((e) => e.account?.id === accountId);
    if (entry) this.dispose(entry);
  }
  async forgetPartition(partition: string) {
    const entry = this.entries.get(partition);
    if (entry) this.dispose(entry);
    if (partition.startsWith('persist:')) await session.fromPartition(partition).clearStorageData();
  }
  close() {
    const entries = [...this.entries.values()];
    const flushes = entries.map((entry) =>
      Promise.resolve().then(() => {
        const flush = (
          entry.view.webContents.session as Electron.Session & {
            flushStorageData?: () => Promise<void>;
          }
        ).flushStorageData;
        return typeof flush === 'function' ? flush.call(entry.view.webContents.session) : undefined;
      }),
    );
    for (const entry of entries) this.dispose(entry);
    return Promise.allSettled(flushes).then(() => undefined);
  }
  private dispose(entry: WorkbenchEntry) {
    if (entry.paused) return;
    entry.paused = true;
    entry.generation++;
    entry.pollController?.abort();
    entry.ready = false;
    if (entry.account) this.notify({ type: 'offline', accountId: entry.account.id });
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = undefined;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    if (!entry.window.isDestroyed()) entry.window.destroy();
    this.entries.delete(entry.partition);
  }
}
