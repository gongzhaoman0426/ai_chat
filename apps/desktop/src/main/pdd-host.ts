import {
  orderRemarkCommandSchema,
  type OrderRemarkCommand,
  type PlatformActionResult,
} from '../../../../packages/contracts/src/commerce-tools';
import {
  normalizePddQuery,
  normalizeOrderRemark,
  record,
} from '../../../../packages/platforms/src/pdd/queries';
import { executeOrderRemark } from '../../../../packages/platforms/src/pdd/order-remark';
import { Mutex, assert } from '../../../../packages/core/src/util';
import { PDD_URL, normalizePddMessage } from '../../../../packages/platforms/src';
import { WorkbenchHost } from './workbench-host';
export class PddHost extends WorkbenchHost {
  private orderLocks = new Map<string, Mutex>();
  private actionResults = new Map<string, Promise<PlatformActionResult>>();
  constructor(
    bridgeFile: string,
    request: (data: Record<string, unknown>) => Promise<any>,
    notify: (data: unknown) => void,
    reloadBridge = false,
  ) {
    super(bridgeFile, request, notify, reloadBridge, {
      platform: 'pinduoduo',
      name: '拼多多',
      url: PDD_URL,
      allowedHost: (hostname) =>
        ['pinduoduo.com', 'yangkeduo.com', 'weixin.qq.com', 'qq.com'].some(
          (domain) => hostname === domain || hostname.endsWith('.' + domain),
        ),
      pageAllowed: (url) => url.origin === 'https://mms.pinduoduo.com',
      chatPage: (url) => url.pathname.includes('chat-merchant'),
      imageHost: (hostname) => hostname === 'pddpic.com' || hostname.endsWith('.pddpic.com'),
      normalizeMessage: normalizePddMessage,
      normalizeQuery: normalizePddQuery,
    });
  }
  async executeAction(value: OrderRemarkCommand): Promise<PlatformActionResult> {
    const command = orderRemarkCommandSchema.parse(value);
    const existing = this.actionResults.get(command.id);
    if (existing) return existing;
    const entry = this.get(command.accountId);
    const key = entry.mallId!;
    const lock = this.orderLocks.get(key) ?? new Mutex();
    this.orderLocks.set(key, lock);
    const promise = lock.run(async () => {
      const generation = entry.generation;
      const check = () =>
        assert(
          entry.ready && !entry.paused && generation === entry.generation,
          '平台会话在操作期间已变化',
        );
      const read = async () => {
        check();
        const raw = await entry.view.webContents.executeJavaScript(
          `window.__judeskBridge.orderState(${JSON.stringify({ orderSn: command.orderSn })})`,
        );
        check();
        await this.verify(command.accountId);
        check();
        return normalizeOrderRemark(raw.note, raw.tag);
      };
      await this.verify(command.accountId);
      return executeOrderRemark(command, {
        ownsOrder: async () => {
          const result = await this.query(command.accountId, 'buyer-orders', {
            page: command.page,
            pageSize: command.pageSize,
            buyerId: command.buyerId,
          });
          return (record(result.data).orders as unknown[]).some(
            (o) => record(o).orderSn === command.orderSn,
          );
        },
        read,
        authorize: async (preview) => {
          await this.verify(command.accountId);
          check();
          await this.request({ type: 'platform_action_guard', actionId: command.id, preview });
          check();
        },
        write: (state) => {
          check();
          return entry.view.webContents.executeJavaScript(
            `window.__judeskBridge.writeOrderRemark(${JSON.stringify({ orderSn: command.orderSn, remark: state.remark, remarkTag: state.tag, remarkTagName: state.tagName })})`,
          );
        },
      });
    });
    this.actionResults.set(command.id, promise);
    // Durable deduplication is in the service. Bound the in-memory receipt cache.
    void promise
      .finally(() => {
        if (this.actionResults.size > 500)
          this.actionResults.delete(this.actionResults.keys().next().value!);
      })
      .catch(() => {});
    return promise;
  }
}
