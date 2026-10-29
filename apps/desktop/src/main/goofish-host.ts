import { WorkbenchHost } from './workbench-host';
import { GOOFISH_URL, normalizeGoofishMessage } from '../../../../packages/platforms/src/goofish';
import { normalizeGoofishQuery } from '../../../../packages/platforms/src/goofish/queries';
import {
  shipmentCommandSchema,
  shipmentPreviewSchema,
  platformActionResultSchema,
  type ShipmentCommand,
  type PlatformActionResult,
} from '../../../../packages/contracts/src/commerce-tools';
import { Mutex, assert } from '../../../../packages/core/src/util';
export class GoofishHost extends WorkbenchHost {
  private shipmentLocks = new Map<string, Mutex>();
  private shipmentResults = new Map<string, Promise<PlatformActionResult>>();
  constructor(
    bridgeFile: string,
    request: (data: Record<string, unknown>) => Promise<any>,
    notify: (data: unknown) => void,
    reloadBridge = false,
  ) {
    super(bridgeFile, request, notify, reloadBridge, {
      platform: 'goofish',
      name: '闲鱼',
      url: GOOFISH_URL,
      isLoginPage: (url) =>
        /\/login|\/newlogin|\/passport/.test(url.pathname) ||
        /(^|\.)(login|passport|havanalogin|sso)\./i.test(url.hostname),
      shouldOpenChat: (url) =>
        /(^|\.)(goofish|taobao)\.com$/i.test(url.hostname) && !url.pathname.startsWith('/im'),
      sessionReadyOnLoginPage:
        '(() => { try { return /(?:^|;\\s*)(_m_h5_tk|unb|_tb_token_|cookie2)=/.test(document.cookie); } catch { return false; } })()',
      allowedHost: (host) =>
        ['goofish.com', 'taobao.com', 'alicdn.com', 'alipay.com', 'alibaba.com'].some(
          (d) => host === d || host.endsWith('.' + d),
        ),
      pageAllowed: (url) => /(^|\.)goofish\.com$/i.test(url.hostname),
      chatPage: (url) =>
        /(^|\.)goofish\.com$/i.test(url.hostname) && /^\/im(\/|$)/.test(url.pathname),
      imageHost: (host) =>
        ['alicdn.com', 'goofish.com', 'taobaocdn.com'].some(
          (d) => host === d || host.endsWith('.' + d),
        ),
      normalizeMessage: normalizeGoofishMessage,
      normalizeQuery: normalizeGoofishQuery,
    });
  }
  async markRead(
    accountId: string,
    input: { conversationKey: string; buyerId: string; messageIds: string[] },
  ) {
    const entry = this.get(accountId),
      generation = entry.generation;
    await this.verify(accountId);
    assert(entry.ready && !entry.paused && generation === entry.generation, '闲鱼会话已变化');
    return entry.view.webContents.executeJavaScript(
      `window.__judeskBridge.markRead(${JSON.stringify(input)})`,
    );
  }
  async executeShipment(value: ShipmentCommand): Promise<PlatformActionResult> {
    const command = shipmentCommandSchema.parse(value);
    const existing = this.shipmentResults.get(command.id);
    if (existing) return existing;
    const entry = this.get(command.accountId),
      key = `${entry.mallId}:${command.orderSn}`;
    const lock = this.shipmentLocks.get(key) ?? new Mutex();
    this.shipmentLocks.set(key, lock);
    const promise = lock.run(async () => {
      const generation = entry.generation;
      const check = () =>
        assert(
          entry.ready && !entry.paused && entry.generation === generation,
          '发货期间闲鱼会话已变化',
        );
      await this.verify(command.accountId);
      check();
      const preview = shipmentPreviewSchema.parse(
        await entry.view.webContents.executeJavaScript(
          `window.__judeskBridge.prepareShipment(${JSON.stringify(command)})`,
        ),
      );
      check();
      assert(preview.sellerId === entry.mallId, '发货订单不属于当前店铺');
      await this.verify(command.accountId);
      check();
      await this.request({ type: 'platform_shipment_guard', actionId: command.id, preview });
      check();
      return platformActionResultSchema.parse(
        await entry.view.webContents.executeJavaScript(
          `window.__judeskBridge.commitShipment(${JSON.stringify(command)})`,
        ),
      );
    });
    this.shipmentResults.set(command.id, promise);
    void promise
      .finally(() => {
        if (this.shipmentResults.size > 500)
          this.shipmentResults.delete(this.shipmentResults.keys().next().value!);
      })
      .catch(() => {});
    return promise;
  }
}
