import {
  orderRemarkCommandSchema,
  orderRemarkStateSchema,
  type OrderRemarkCommand,
  type PlatformActionResult,
} from '../../../../packages/contracts/src/commerce-tools';
import { executeOrderRemark } from '../../../../packages/platforms/src/pdd/order-remark';
import { assert, Mutex } from '../../../../packages/core/src/util';
import { WorkbenchHost } from './workbench-host';
import {
  DOUYIN_LOGIN_URL,
  DOUYIN_URL,
  normalizeDouyinMessage,
} from '../../../../packages/platforms/src/douyin';
import { normalizeDouyinQuery } from '../../../../packages/platforms/src/douyin/queries';
export class DouyinHost extends WorkbenchHost {
  private orderLock = new Mutex();
  private orderResults = new Map<string, Promise<PlatformActionResult>>();
  async executeAction(value: OrderRemarkCommand): Promise<PlatformActionResult> {
    const command = orderRemarkCommandSchema.parse(value);
    const existing = this.orderResults.get(command.id);
    if (existing) return existing;
    const task = this.orderLock.run(async () => {
      const entry = this.get(command.accountId),
        generation = entry.generation;
      const check = () =>
        assert(
          entry.ready && !entry.paused && generation === entry.generation,
          '备注操作期间平台会话已变化',
        );
      const scope = {
        buyerId: command.buyerId,
        conversationKey: command.conversationKey,
        platformContext: command.platformContext,
      };
      return executeOrderRemark(
        command,
        {
          ownsOrder: async () => {
            const r = await this.query(command.accountId, 'buyer-orders', {
              ...scope,
              page: command.page,
              pageSize: command.pageSize,
              keyword: command.keyword,
            });
            return (r.data.orders as any[]).some((o) => o.orderSn === command.orderSn);
          },
          read: async () => {
            await this.verify(command.accountId);
            check();
            const raw = await entry.view.webContents.executeJavaScript(
              `window.__judeskBridge.orderState(${JSON.stringify({ ...scope, orderSn: command.orderSn })})`,
            );
            check();
            return orderRemarkStateSchema.parse(raw);
          },
          authorize: async (preview) => {
            await this.verify(command.accountId);
            check();
            await this.request({ type: 'platform_action_guard', actionId: command.id, preview });
            check();
          },
          write: (state) => {
            check();
            return entry.view.webContents.executeJavaScript(
              `window.__judeskBridge.writeOrderRemark(${JSON.stringify({ ...scope, orderSn: command.orderSn, remark: state.remark, remarkTag: state.tag })})`,
            );
          },
        },
        {
          name: '抖店',
          rejected: (v: any) =>
            v?.success === false ||
            ['code', 'st', 'status_code', 'err_no', 'errno', 'error_code'].some(
              (k) => v?.[k] != null && Number(v[k]) !== 0,
            ),
          failureReason: () => '',
        },
      );
    });
    this.orderResults.set(command.id, task);
    void task
      .finally(() => {
        if (this.orderResults.size > 500)
          this.orderResults.delete(this.orderResults.keys().next().value!);
      })
      .catch(() => {});
    return task;
  }

  constructor(
    bridgeFile: string,
    request: (data: Record<string, unknown>) => Promise<any>,
    notify: (data: unknown) => void,
    reloadBridge = false,
  ) {
    super(bridgeFile, request, notify, reloadBridge, {
      platform: 'douyin',
      name: '抖店',
      url: DOUYIN_URL,
      startUrl: DOUYIN_LOGIN_URL,
      isLoginPage: (url) =>
        url.pathname.includes('/login') ||
        url.pathname.includes('/passport') ||
        /(^|\.)(sso|passport)\./i.test(url.hostname),
      shouldOpenChat: (url) =>
        url.hostname === 'fxg.jinritemai.com' || url.hostname.endsWith('.fxg.jinritemai.com'),
      allowedHost: (hostname) =>
        ['jinritemai.com', 'douyin.com', 'bytedance.com', 'bytedance.net'].some(
          (domain) => hostname === domain || hostname.endsWith('.' + domain),
        ),
      pageAllowed: (url) => url.origin === 'https://im.jinritemai.com',
      chatPage: (url) =>
        url.origin === 'https://im.jinritemai.com' && url.pathname.startsWith('/pc_seller_v2'),
      imageHost: (hostname) =>
        ['byteimg.com', 'pstatp.com', 'douyincdn.com', 'ibytedtos.com'].some(
          (domain) => hostname === domain || hostname.endsWith('.' + domain),
        ),
      normalizeMessage: normalizeDouyinMessage,
      normalizeQuery: normalizeDouyinQuery,
    });
  }
}
