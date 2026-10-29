import {
  disabledCapabilities,
  type Capabilities,
  type SendCommand,
  type SendResult,
} from '../../../contracts/src';
import {
  commerceQuerySchemas,
  type CommerceQueryOperation,
  type CommerceQueryResult,
  type PlatformActionResult,
} from '../../../contracts/src/commerce-tools';
import {
  quickCommandSchema,
  type QuickCommand,
  type QuickPreview,
} from '../../../contracts/src/commerce-extra';
import {
  staffSchema,
  transferCommandSchema,
  type PlatformStaff,
  type TransferCommand,
  type TransferPreview,
} from '../../../contracts/src/workbench';
import { record } from '../shared';

// Methods and native response fields are documented in qianniu-platform-gateway/docs/qianniu.md.
// No HTTP cookies or customer/account IDs are copied from its example fixtures.
const API = {
  contact: 'mtop.taobao.qianniu.airisland.contact.search',
  goods: 'mtop.taobao.qianniu.cs.item.search',
  profile: 'mtop.taobao.qianniu.cs.user.query',
  footprint: 'mtop.taobao.qianniu.cs.item.record.query',
  orders: 'mtop.taobao.qianniu.cs.trade.query',
  logistics: 'mtop.alibaba.fulfillment.printorder.consign.logistics.query',
  staff: 'mtop.taobao.qianniu.cloudkefu.accountstatus.getbyid',
  groups: 'mtop.taobao.qianniu.cloudkefu.dispatchgroups.get',
  forward: 'mtop.taobao.qianniu.cloudkefu.forward',
  card: 'mtop.taobao.qianniu.cs.item.recommend.send',
  invite: 'mtop.taobao.qianniu.airisland.invite.order.send',
} as const;
export const QIANNIU_COMMERCE_OPERATIONS = [
  'goods',
  'goods-detail',
  'buyer-profile',
  'buyer-footprint',
  'buyer-orders',
  'order-detail',
  'order-logistics',
  'staff-groups',
  'staff-statistics',
  'send-product-card',
  'invite-order',
  'transfer-group',
] as const;
export function qianniuCapabilities(online: boolean, historyAvailable = false): Capabilities {
  return {
    ...disabledCapabilities,
    receive: online,
    sendText: online,
    sendImage: online,
    goods: online,
    orders: online,
    buyerProfile: online,
    staffTransfer: online,
    staffGroups: online,
    sendProductCard: online,
    quickActions: online,
    history: online && historyAvailable,
    operations: online
      ? [...QIANNIU_COMMERCE_OPERATIONS, ...(historyAvailable ? ['history'] : [])]
      : [],
  };
}
const requireValue: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};
const string = (value: unknown, max = 1000) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const numericId = (value: unknown) =>
  typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : undefined;
const integer = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const compact = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const money = (value: unknown) =>
  typeof value === 'string' && /^\d{1,16}(?:\.\d{1,2})?$/.test(value) ? `¥${value}` : undefined;
const media = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !['alicdn.com', 'taobaocdn.com', 'taobao.com', 'tmall.com'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    )
      return;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return;
  }
};
class QianniuRejected extends Error {}
function checkBusiness(value: Record<string, unknown>) {
  const rejected =
    value.success === false ||
    ['code', 'errorCode'].some((key) => value[key] != null && String(value[key]) !== '0');
  if (rejected)
    throw new QianniuRejected(
      `千牛拒绝请求：${string(value.message ?? value.msg ?? value.errorMsg, 300) || '账号权限或业务状态不允许'}`,
    );
}
export function qianniuMtopPayload(raw: unknown, expectedApi: string): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('千牛返回了无效 JSON');
    }
  }
  let response = record(value);
  for (let depth = 0; depth < 4; depth++) {
    checkBusiness(response);
    if (Object.hasOwn(response, 'ret')) {
      requireValue(
        Array.isArray(response.ret) && response.ret.length > 0,
        '千牛响应缺少有效 MTop 状态',
      );
      if (!response.ret.every((item) => typeof item === 'string' && /^SUCCESS(?:::|$)/.test(item)))
        throw new QianniuRejected(
          `千牛拒绝请求：${response.ret.map(String).join('；').slice(0, 400)}`,
        );
      requireValue(
        response.api == null || response.api === expectedApi,
        '千牛返回了其他操作的响应',
      );
      requireValue(
        response.data !== null &&
          typeof response.data === 'object' &&
          !Array.isArray(response.data),
        '千牛响应缺少业务数据',
      );
      const payload = record(response.data);
      checkBusiness(payload);
      return payload;
    }
    requireValue(
      response.data !== null && typeof response.data === 'object' && !Array.isArray(response.data),
      '千牛响应缺少明确 MTop 成功状态',
    );
    response = record(response.data);
  }
  throw new Error('千牛响应嵌套层级异常');
}
function section(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (let depth = 0; depth < 3; depth++) {
    checkBusiness(payload);
    if (keys.some((key) => Object.hasOwn(payload, key))) return payload;
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data))
      payload = record(payload.data);
    else break;
  }
  return payload;
}
function list(value: unknown, label: string, max = 1000): Record<string, unknown>[] {
  requireValue(Array.isArray(value), `千牛响应缺少 ${label} 列表，不能视为空列表`);
  requireValue(value.length <= max, `千牛 ${label} 列表超出处理上限`);
  return value.map((item) => {
    const row = record(item);
    requireValue(Object.keys(row).length > 0, `千牛 ${label} 列表中存在无效记录`);
    return row;
  });
}
function properties(row: Record<string, unknown>) {
  return (string(row.propsName, 8000) || '')
    .split(';')
    .flatMap((item) => {
      const parts = item.split(':');
      return parts.length >= 4 && parts[2]
        ? [{ label: parts[2].slice(0, 200), value: parts.slice(3).join(':').slice(0, 1000) }]
        : [];
    })
    .slice(0, 80);
}
function product(row: Record<string, unknown>) {
  const goodsId = numericId(row.itemId);
  requireValue(goodsId, '千牛商品缺少有效 itemId，或编号已丢失精度');
  return compact({
    goodsId,
    title: string(row.title),
    imageUrl: media(row.pic),
    priceText: money(row.price),
    stock: integer(row.quantity),
    soldQuantity: integer(row.soldQuantity),
    statusText: row.approveStatus === 'onsale' ? '在售' : string(row.approveStatus, 100),
    description:
      properties(row)
        .map((item) => `${item.label}：${item.value}`)
        .join('；') || undefined,
  });
}
type Scope = {
  buyerId: string;
  conversationKey?: string;
  platformContext: Record<string, unknown>;
};
type Buyer = { accountId: string; nick: string; encryptId: string };
type GoodsLocation = { page: number; pageSize: number; keyword?: string };
type StaffRow = PlatformStaff & {
  online: boolean;
  suspended: boolean;
  mainAccountId?: string;
  rawNick: string;
};
type Group = {
  id: string;
  name: string;
  memberCount: number;
  onlineCount?: number;
  statusText: string;
  enabled: boolean;
  userId: string;
};

export class QianniuCommerce {
  private goodsLocations = new Map<string, GoodsLocation>();
  constructor(
    private readonly invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly loginId: string,
  ) {}

  private async mtop(api: string, param: Record<string, unknown>, version = '1.0') {
    return qianniuMtopPayload(
      await this.invoke('application.invokeMTopChannelService', {
        method: api,
        param,
        httpMethod: 'post',
        version,
      }),
      api,
    );
  }
  private scope(input: Record<string, unknown>): Scope {
    const buyerId = string(input.buyerId, 500);
    requireValue(buyerId && buyerId === input.buyerId, '缺少当前千牛会话的买家标识');
    const platformContext = record(input.platformContext);
    const conversationKey = string(input.conversationKey, 1000);
    requireValue(
      !platformContext.securityConversationId ||
        platformContext.securityConversationId === conversationKey,
      '千牛会话上下文不匹配',
    );
    return { buyerId, conversationKey, platformContext };
  }
  private async buyer(scope: Scope): Promise<Buyer> {
    const observedNick = string(scope.platformContext.buyerNick, 200);
    const response = await this.mtop(API.contact, {
      accessKey: 'qianniu-pc',
      accessSecret: 'qianniu-pc-secret',
      accountType: '3',
      searchQuery: observedNick || scope.buyerId,
    });
    const candidates = list(section(response, ['data']).data, '买家搜索', 200).filter((row) => {
      if (String(row.accountType) !== '3') return false;
      const accountId = numericId(row.accountId);
      return (
        [accountId, row.nick, row.encryptAccountId].includes(scope.buyerId) &&
        (!observedNick || row.nick === observedNick)
      );
    });
    const identities = new Map<string, Buyer>();
    for (const row of candidates) {
      const accountId = numericId(row.accountId),
        nick = string(row.nick, 200),
        encryptId = string(row.encryptAccountId, 500);
      requireValue(
        accountId && nick && encryptId,
        '千牛买家搜索缺少有效身份字段，或编号已丢失精度',
      );
      requireValue(
        !scope.platformContext.securityUserId || scope.platformContext.securityUserId === encryptId,
        '千牛买家加密标识与当前会话不匹配',
      );
      identities.set(`${accountId}\0${nick}\0${encryptId}`, { accountId, nick, encryptId });
    }
    requireValue(
      identities.size === 1,
      identities.size
        ? '千牛返回了多个不一致的买家身份，无法安全操作'
        : '千牛未返回与当前买家精确匹配的身份，请重新进入该会话',
    );
    return [...identities.values()][0];
  }
  private checkBuyer(row: Record<string, unknown>, buyer: Buyer) {
    for (const key of ['buyerId', 'buyerUid'])
      if (row[key] != null)
        requireValue(
          numericId(row[key]) === buyer.accountId || row[key] === buyer.encryptId,
          '千牛返回了其他买家的资料',
        );
    for (const key of ['encryptId', 'securityBuyerUid'])
      if (row[key] != null) requireValue(row[key] === buyer.encryptId, '千牛返回了其他买家的资料');
    if (row.buyerNick != null)
      requireValue(row.buyerNick === buyer.nick, '千牛返回了其他买家的资料');
  }
  private rememberGoods(rows: Record<string, unknown>[], location: GoodsLocation) {
    for (const row of rows) {
      const id = numericId(row.itemId);
      requireValue(id, '千牛商品编号无效或已丢失精度');
      this.goodsLocations.set(id, location);
    }
    while (this.goodsLocations.size > 1000)
      this.goodsLocations.delete(this.goodsLocations.keys().next().value!);
  }
  private async goodsPage(buyer: Buyer, location: GoodsLocation) {
    const payload = await this.mtop(API.goods, {
      pageSize: location.pageSize,
      pageNo: location.page,
      keyWord: location.keyword || '',
      sortKey: 'sold',
      desc: true,
      type: 0,
      queryGift: false,
      encryptId: buyer.encryptId,
    });
    const body = section(payload, ['data', 'totalCount']);
    const rows = list(body.data, '商品', 1000);
    if (body.page != null)
      requireValue(Number(body.page) === location.page, '千牛商品分页响应与请求不一致');
    this.rememberGoods(rows, location);
    return {
      rows,
      total: integer(body.totalCount),
      hasMore:
        integer(body.totalCount) == null
          ? null
          : location.page * location.pageSize < Number(body.totalCount),
    };
  }
  private async findProduct(buyer: Buyer, goodsId: string): Promise<Record<string, unknown>> {
    requireValue(numericId(goodsId), '商品编号无效');
    const location = this.goodsLocations.get(goodsId);
    if (location) {
      const found = (await this.goodsPage(buyer, location)).rows.find(
        (row) => numericId(row.itemId) === goodsId,
      );
      if (found) return found;
    }
    // There is no documented item-detail endpoint. Revalidate a bounded current catalog, never
    // turn an arbitrary supplied ID into an outgoing recommendation.
    for (let page = 1; page <= 10; page++) {
      const result = await this.goodsPage(buyer, { page, pageSize: 30 });
      const found = result.rows.find((row) => numericId(row.itemId) === goodsId);
      if (found) return found;
      if (result.hasMore === false || !result.rows.length) break;
    }
    throw new Error('商品已不在当前可核验列表中，请重新搜索店铺商品后再操作');
  }
  private order(row: Record<string, unknown>, scope: Scope, buyer: Buyer) {
    this.checkBuyer(row, buyer);
    const orderSn = numericId(row.bizOrderId);
    requireValue(orderSn, '千牛订单缺少有效 bizOrderId，或订单号已丢失精度');
    const items = list(row.itemList, '订单商品', 100);
    const goods = items.map((item) => {
      if (item.bizOrderId != null)
        requireValue(numericId(item.bizOrderId) === orderSn, '订单商品不属于当前主订单');
      return compact({
        goodsId: numericId(item.auctionId),
        title: string(item.auctionTitle),
        imageUrl: media(item.picUrl),
        priceText: money(item.price),
        quantity: integer(item.buyAmount),
        spec: string(item.skuText ?? item.skuInfo, 1000),
      });
    });
    const details: Array<{ label: string; value: string }> = [];
    for (const [key, label] of [
      ['createTime', '创建时间'],
      ['payTime', '付款时间'],
      ['consignTime', '发货时间'],
      ['afterSaleText', '售后'],
      ['receiverName', '收货人'],
      ['receiverMobilePhone', '收货电话'],
      ['receiverAddress', '收货地址'],
    ] as const) {
      const value = string(row[key]);
      if (value) details.push({ label, value });
    }
    for (const item of goods.slice(0, 20))
      details.push({
        label: '订单商品',
        value:
          `${item.title || item.goodsId || '商品'}${item.quantity != null ? ` × ${item.quantity}` : ''}`.slice(
            0,
            1000,
          ),
      });
    return compact({
      orderSn,
      buyerId: scope.buyerId,
      productTitle: goods[0]?.title,
      goods: goods[0],
      items: goods,
      statusText: string(row.cardTypeText, 100),
      amountText: money(row.orderPrice),
      details,
    });
  }
  private async orders(buyer: Buyer) {
    const response = await this.mtop(API.orders, {
      orderStatus: '',
      securityBuyerUid: buyer.encryptId,
    });
    const body = section(response, ['orders']);
    const rows = list(body.orders, '买家订单');
    for (const row of rows) {
      this.checkBuyer(row, buyer);
      const orderSn = numericId(row.bizOrderId);
      requireValue(orderSn, '千牛订单号无效或已丢失精度');
    }
    return {
      rows,
      incomplete:
        body.hasMore === true || Number(body.totalCount ?? body.total ?? rows.length) > rows.length,
    };
  }
  private async findOrder(buyer: Buyer, orderSn: string) {
    requireValue(numericId(orderSn), '缺少当前买家已核验的订单号');
    const found = (await this.orders(buyer)).rows.find(
      (row) => numericId(row.bizOrderId) === orderSn,
    );
    if (found) return found;
    throw new Error('订单不在当前买家的可核验订单列表中，请重新查询后选择');
  }

  async query(operation: string, input: Record<string, unknown>): Promise<CommerceQueryResult> {
    requireValue(
      QIANNIU_COMMERCE_OPERATIONS.includes(operation as any) && operation in commerceQuerySchemas,
      '千牛尚未提供此查询',
    );
    const {
      buyerId: _buyerId,
      conversationKey: _conversationKey,
      platformContext: _platformContext,
      orderSn,
      ...publicInput
    } = input;
    const params = commerceQuerySchemas[operation as CommerceQueryOperation].parse(
      publicInput,
    ) as Record<string, unknown>;
    requireValue(operation === 'goods' || !params.keyword, '千牛此查询不支持关键词搜索');
    const scope = this.scope(input);
    let data: Record<string, unknown>;
    let partial = false;
    const reasons: Array<{ section: string; reason: string }> = [];
    const page = Number(params.page || 1),
      pageSize = Number(params.pageSize || 10);
    if (operation === 'staff-groups') {
      data = {
        groups: (await this.groups()).map(
          ({ enabled: _enabled, userId: _userId, ...group }) => group,
        ),
      };
    } else if (operation === 'staff-statistics') {
      const rows = await this.staffRows();
      const offset = (page - 1) * pageSize;
      data = {
        staff: rows
          .slice(offset, offset + pageSize)
          .map(({ rawNick: _raw, mainAccountId: _main, ...row }) => row),
        page,
        pageSize,
        total: rows.length,
        hasMore: offset + pageSize < rows.length,
      };
    } else {
      const buyer = await this.buyer(scope);
      if (operation === 'goods') {
        const result = await this.goodsPage(buyer, {
          page,
          pageSize,
          keyword: string(params.keyword, 100),
        });
        data = compact({
          products: result.rows.slice(0, pageSize).map(product),
          page,
          pageSize,
          total: result.total,
          hasMore: result.hasMore,
        });
      } else if (operation === 'goods-detail') {
        const row = await this.findProduct(buyer, String(params.goodsId));
        data = {
          product: product(row),
          properties: properties(row),
          propertiesAvailable: typeof row.propsName === 'string',
          note: '详情来自当前店铺商品列表，不包含平台未返回的 SKU 明细。',
        };
        partial = true;
        reasons.push({ section: 'goods-detail', reason: '仅核验并展示商品列表提供的详情与属性' });
      } else if (operation === 'buyer-profile') {
        const body = await this.mtop(API.profile, { encryptId: buyer.encryptId });
        this.checkBuyer(body, buyer);
        requireValue(
          [
            'buyerCreditLevel',
            'buyerCreditScore',
            'isNewCustomer',
            'isShopFans',
            'vipLevel',
            'hasMembership',
          ].some((key) => Object.hasOwn(body, key)),
          '千牛客户资料字段尚未识别',
        );
        const summary = [
          integer(body.buyerCreditLevel) != null ? `买家信用等级：${body.buyerCreditLevel}` : '',
          integer(body.buyerCreditScore) != null ? `信用积分：${body.buyerCreditScore}` : '',
          body.isNewCustomer === true ? '新客户' : body.isNewCustomer === false ? '老客户' : '',
          body.isShopFans === true ? '店铺粉丝' : '',
          body.hasMembership === true ? '店铺会员' : '',
        ]
          .filter(Boolean)
          .join('；');
        data = compact({
          buyerId: scope.buyerId,
          name: buyer.nick,
          introduction: summary,
          creditLevel: integer(body.buyerCreditLevel),
          creditScore: integer(body.buyerCreditScore),
          isNewCustomer: typeof body.isNewCustomer === 'boolean' ? body.isNewCustomer : undefined,
          isShopFans: typeof body.isShopFans === 'boolean' ? body.isShopFans : undefined,
        });
      } else if (operation === 'buyer-footprint') {
        const body = await this.mtop(API.footprint, { encryptId: buyer.encryptId });
        this.checkBuyer(body, buyer);
        const fields = ['underInquiryItemList', 'recentlyBoughtItemList', 'footPointItemList'];
        requireValue(
          fields.some((field) => Object.hasOwn(body, field)),
          '千牛响应缺少关联商品列表',
        );
        const products = new Map<string, Record<string, unknown>>();
        for (const field of fields)
          if (Object.hasOwn(body, field))
            for (const row of list(body[field], field)) {
              const normalized = product(row),
                key = String(normalized.goodsId);
              if (!products.has(key))
                products.set(key, {
                  ...normalized,
                  relation:
                    field === 'underInquiryItemList'
                      ? '咨询'
                      : field === 'recentlyBoughtItemList'
                        ? '购买'
                        : '浏览',
                });
            }
        const rows = [...products.values()],
          offset = (page - 1) * pageSize;
        data = {
          products: rows.slice(offset, offset + pageSize),
          page,
          pageSize,
          total: rows.length,
          hasMore: offset + pageSize < rows.length,
          note: '分页展示千牛当前返回的咨询、购买和浏览记录。',
        };
        if (body.hasMoreFootPrint === true) {
          partial = true;
          reasons.push({
            section: 'buyer-footprint',
            reason: '千牛提示还有更早足迹，但参考协议未提供继续加载接口',
          });
        }
      } else if (operation === 'buyer-orders') {
        const result = await this.orders(buyer);
        const offset = (page - 1) * pageSize;
        data = compact({
          orders: result.rows
            .slice(offset, offset + pageSize)
            .map((row) => this.order(row, scope, buyer)),
          page,
          pageSize,
          total: result.rows.length,
          hasMore: offset + pageSize < result.rows.length,
          note: '分页展示千牛当前返回的近三个月订单；分页在本地完成。',
        });
        if (result.incomplete) {
          partial = true;
          reasons.push({
            section: 'buyer-orders',
            reason: '千牛提示订单列表尚不完整，当前协议仅核验已返回订单',
          });
        }
      } else if (operation === 'order-detail' || operation === 'order-logistics') {
        const order = await this.findOrder(buyer, String(orderSn || ''));
        if (operation === 'order-detail') {
          data = {
            order: this.order(order, scope, buyer),
            note: '来自刚刚核验的当前买家订单列表。',
          };
        } else {
          const body = await this.mtop(API.logistics, { bizOrderId: orderSn });
          const rows = list(body.logisticsInfoList, '物流');
          const records: Array<{ label: string; value: string }> = [];
          for (const parcel of rows) {
            if (parcel.goodsList != null)
              for (const item of list(parcel.goodsList, '物流商品', 100))
                if (item.taobaoTradeId != null)
                  requireValue(
                    numericId(item.taobaoTradeId) === orderSn,
                    '千牛返回了其他订单的物流',
                  );
            for (const item of list(parcel.logisticsDetailList, '物流轨迹', 200)) {
              const value = string(item.desc),
                label = string(item.time, 100) || string(item.title, 100) || '物流';
              requireValue(value, '千牛物流轨迹缺少说明');
              records.push({ label, value });
            }
          }
          if (body.orderDetailList != null)
            for (const item of list(body.orderDetailList, '物流订单', 100))
              if (item.mainBizOrderId != null)
                requireValue(
                  numericId(item.mainBizOrderId) === orderSn,
                  '千牛返回了其他订单的物流',
                );
          const receiver = record(body.receiver);
          for (const [key, label] of [
            ['name', '收货人'],
            ['phone', '电话'],
            ['noSplitCharDetailAddress', '地址'],
          ] as const) {
            const value = string(receiver[key]);
            if (value) records.push({ label, value });
          }
          data = { orderSn, records: records.slice(0, 80) };
        }
      } else throw new Error('千牛尚未提供此查询');
    }
    return {
      operation,
      ...(operation === 'goods-detail'
        ? { subjectId: String(params.goodsId) }
        : [
              'buyer-profile',
              'buyer-footprint',
              'buyer-orders',
              'order-detail',
              'order-logistics',
            ].includes(operation)
          ? { subjectId: scope.buyerId }
          : {}),
      queriedAt: new Date().toISOString(),
      partial,
      failedSections: reasons,
      data,
    };
  }

  private async staffRows(): Promise<StaffRow[]> {
    const payload = await this.mtop(API.staff, { pageSize: 100 });
    const body = section(payload, ['module', 'accounts']);
    const rows = list(body.module ?? body.accounts, '客服', 500);
    return rows.map((row) => {
      const id = numericId(row.accountId),
        rawNick = string(row.nick, 200);
      requireValue(id && rawNick, '千牛客服列表缺少编号/昵称，或编号已丢失精度');
      const suspended = row.suspend === true;
      const online =
        typeof row.pcOnline === 'boolean' || typeof row.mobileOnline === 'boolean'
          ? row.pcOnline === true || row.mobileOnline === true
          : row.status === 1 || row.status === 2;
      const statusText = suspended
        ? '已挂起'
        : online
          ? row.status === 2
            ? '忙碌'
            : '在线'
          : '离线';
      return {
        ...staffSchema.parse({ id, name: rawNick, statusText }),
        online,
        suspended,
        mainAccountId: numericId(row.mainAccountId),
        rawNick,
      };
    });
  }
  private isSelf(row: StaffRow) {
    return (
      row.id === this.loginId ||
      row.rawNick === this.loginId ||
      (this.loginId.includes(':') &&
        row.rawNick === this.loginId.slice(this.loginId.indexOf(':') + 1))
    );
  }
  async staff(): Promise<PlatformStaff[]> {
    return (await this.staffRows())
      .filter((row) => row.online && !row.suspended && !this.isSelf(row))
      .map(({ id, name, statusText }) => ({ id, name, statusText }));
  }
  private async groups(): Promise<Group[]> {
    const payload = await this.mtop(API.groups, { login_domain: 'cntaobao' }, '2.0');
    let body = payload;
    if (typeof body.result === 'string') {
      try {
        body = record(JSON.parse(body.result));
      } catch {
        throw new Error('千牛客服分组返回了无效 JSON');
      }
      checkBusiness(body);
    }
    return list(body.module, '客服分组', 100).flatMap((row) => {
      if (row.groupName === 'GetGroupAccountInfo_UnDispatchGroup' && row.id == null) return [];
      const id = numericId(row.id),
        userId = numericId(row.userId),
        name = string(row.groupName, 200);
      requireValue(id && userId && name, '千牛客服分组缺少有效编号或名称');
      const members = list(row.accounts, '客服组成员', 500);
      const enabled = row.status === 1;
      return [
        {
          id,
          userId,
          name,
          memberCount: members.length,
          onlineCount: integer(row.onlineUserNumbersInGroup),
          enabled,
          statusText: enabled ? '可转接' : '未启用',
        },
      ];
    });
  }

  private actionResult(
    payload: Record<string, unknown>,
    kind: 'forward' | 'invite',
  ): PlatformActionResult {
    const marker = kind === 'forward' ? payload.module : payload.data;
    if (marker === true)
      return {
        status: 'confirmed',
        reasonCode: 'platform_acknowledged',
        message: kind === 'forward' ? '千牛已确认转接' : '千牛已确认发送下单邀请',
      };
    if (marker === false)
      return { status: 'rejected', reasonCode: 'platform_rejected', message: '千牛拒绝了本次操作' };
    return {
      status: 'unknown',
      reasonCode: 'receipt_missing',
      message: '千牛未返回明确业务回执，请在千牛核对，勿重复提交',
    };
  }
  private actionFailure(error: unknown): PlatformActionResult {
    return {
      status: error instanceof QianniuRejected ? 'rejected' : 'unknown',
      reasonCode: error instanceof QianniuRejected ? 'platform_rejected' : 'receipt_missing',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 800),
    };
  }
  private assertConversation(scope: Scope, buyer: Buyer) {
    requireValue(scope.conversationKey, '缺少当前千牛会话标识');
    const participants = scope.conversationKey.match(/^(\d+)\.\d+-(\d+)\.\d+#\d+@cntaobao$/);
    requireValue(
      participants && participants.slice(1).includes(buyer.accountId),
      '千牛会话标识不属于当前已核验买家',
    );
  }
  async transfer(
    command: TransferCommand,
    authorize: (preview: TransferPreview) => Promise<void>,
  ): Promise<PlatformActionResult> {
    command = transferCommandSchema.parse(command);
    const scope = this.scope(command),
      buyer = await this.buyer(scope);
    this.assertConversation(scope, buyer);
    const target = (await this.staff()).find((row) => row.id === command.targetStaffId);
    requireValue(target, '目标客服已离线、挂起或不在当前可转接列表中');
    await authorize({
      buyerId: command.buyerId,
      conversationKey: command.conversationKey,
      targetStaffId: target.id,
      targetName: target.name,
    });
    try {
      return this.actionResult(
        await this.mtop(
          API.forward,
          {
            buyerId: buyer.accountId,
            toId: target.id,
            reason: command.note || '句达客服转接',
            options: JSON.stringify({
              appCid: command.conversationKey,
              buyerDomain: 'cntaobao',
              loginDomain: 'cntaobao',
            }),
          },
          '3.0',
        ),
        'forward',
      );
    } catch (error) {
      return this.actionFailure(error);
    }
  }
  private allowProductAction(row: Record<string, unknown>, code: string) {
    requireValue(row.approveStatus === 'onsale', '商品当前不在售，请重新选择');
    if (Array.isArray(row.buttons))
      requireValue(
        row.buttons.some((item) => record(item).code === code && record(item).hidden === false),
        '千牛当前未开放此商品操作',
      );
  }
  async sendRich(command: SendCommand, beforeDispatch?: () => void): Promise<SendResult> {
    let param: Record<string, unknown>;
    try {
      requireValue(
        command.kind === 'product_card' && command.richContent?.kind === 'product_card',
        '千牛尚未提供此富媒体发送能力',
      );
      const scope = this.scope(command as unknown as Record<string, unknown>),
        buyer = await this.buyer(scope);
      this.assertConversation(scope, buyer);
      const row = await this.findProduct(buyer, command.richContent.goodsId);
      this.allowProductAction(row, 'sendItem');
      param = {
        encryptId: buyer.encryptId,
        batchItemIds: `[${command.richContent.goodsId}]`,
        type: -1,
      };
      beforeDispatch?.();
    } catch (error) {
      return {
        status: 'rejected',
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 800),
      };
    }
    try {
      const payload = await this.mtop(API.card, param);
      if (payload.sendCard === false)
        return { status: 'rejected', reason: '千牛拒绝发送此商品卡片' };
      // sendCard/sendUrl confirm an API operation, not an IM message ID. Outbox confirmation must
      // come from the separately captured real outgoing message, never an invented receipt.
      return {
        status: 'unknown',
        reason:
          payload.sendCard === true
            ? '千牛已受理商品卡片，等待真实消息回执'
            : '千牛未返回明确商品卡片回执，请核对后再操作',
      };
    } catch (error) {
      return {
        status: error instanceof QianniuRejected ? 'rejected' : 'unknown',
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 800),
      };
    }
  }
  async quick(
    command: QuickCommand,
    authorize: (preview: QuickPreview) => Promise<void>,
  ): Promise<PlatformActionResult> {
    command = quickCommandSchema.parse(command);
    const scope = this.scope(command),
      buyer = await this.buyer(scope);
    this.assertConversation(scope, buyer);
    let param: Record<string, unknown>;
    let api: string;
    if (command.operation === 'transfer-group') {
      const group = (await this.groups()).find((row) => row.id === command.targetId);
      requireValue(
        group?.enabled && group.onlineCount != null && group.onlineCount > 0,
        '客服组未启用、没有在线客服或状态尚未确认',
      );
      param = {
        buyerId: buyer.accountId,
        toId: group.userId,
        reason: command.note || '句达客服转接',
        options: JSON.stringify({
          groupId: group.id,
          appCid: command.conversationKey,
          forwardType: 2,
          charset: 'utf-8',
          exceptUsers: '',
          buyerDomain: 'cntaobao',
          loginDomain: 'cntaobao',
        }),
      };
      api = API.forward;
    } else {
      requireValue(command.targetId, '请选择当前店铺商品');
      const row = await this.findProduct(buyer, command.targetId);
      this.allowProductAction(row, 'inviteBuy');
      // Keep numeric IDs as exact decimal literals inside the protocol's JSON string.
      param = {
        encryptId: buyer.encryptId,
        bizDomain: 'taobao',
        encrypType: 'internal',
        buyerNick: buyer.nick,
        itemProps: `[{"itemId":${command.targetId},"quantity":1,"context":{}}]`,
      };
      api = API.invite;
    }
    await authorize({
      operation: command.operation,
      buyerId: command.buyerId,
      conversationKey: command.conversationKey,
      targetId: command.targetId,
    });
    try {
      return this.actionResult(
        await this.mtop(api, param, api === API.forward ? '3.0' : '1.0'),
        api === API.forward ? 'forward' : 'invite',
      );
    } catch (error) {
      return this.actionFailure(error);
    }
  }
}
