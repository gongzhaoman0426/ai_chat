import { normalizeExtraQuery } from '../commerce-extra';
import { orderRemarkStateSchema } from '../../../contracts/src/commerce-tools';
import {
  commerceQuerySchemas,
  type CommerceQueryOperation,
  type CommerceQueryResult,
} from '../../../contracts/src/commerce-tools';
import { assert } from '../../../core/src/util';
import { record } from '../shared';
const text = (v: unknown, max = 2000) =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
const id = (v: unknown) =>
  typeof v === 'string' && v.length <= 500
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v)
      ? String(v)
      : undefined;
const compact = (v: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
const url = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
};
export function douyinPayload(raw: unknown): Record<string, unknown> {
  let value = record(raw);
  for (let depth = 0; depth < 3; depth++) {
    assert(Object.keys(value).length, '抖店返回了无法识别的数据', 'DOUYIN_SCHEMA');
    assert(
      value.success !== false &&
        !['code', 'st', 'status_code', 'err_no', 'errno', 'error_code'].some(
          (k) => value[k] != null && Number(value[k]) !== 0,
        ),
      '抖店拒绝查询，请检查平台登录和接口权限',
      'DOUYIN_REJECTED',
    );
    const spam = record(value.check_spam_resp);
    assert(
      !spam.decision || spam.decision === 'PASS',
      '抖店要求在平台完成验证，当前查询数据不可用',
      'DOUYIN_VERIFICATION_REQUIRED',
    );
    if (value.data && typeof value.data === 'object' && !Array.isArray(value.data))
      value = record(value.data);
    else return value;
  }
  return value;
}
const list = (p: Record<string, unknown>, keys: string[]) => {
  const found = keys.map((k) => p[k]).find(Array.isArray);
  assert(Array.isArray(found), '抖店列表结构尚未识别，不能将其视为空列表', 'DOUYIN_SCHEMA');
  return found;
};
// The native product list now keeps empty legacy fields alongside product_item.
// Its exact string ID is authoritative; SKU/base-info numeric IDs may already be rounded.
function productSource(raw: unknown) {
  const shell = record(raw);
  return Object.hasOwn(shell, 'product_item') ? record(shell.product_item) : shell;
}
const cents = (value: unknown) => {
  const digits = id(value);
  if (!digits || !/^\d{1,20}$/.test(digits)) return undefined;
  const amount = BigInt(digits);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
};
function productPrice(p: Record<string, unknown>) {
  const marketing = record(p.marketing_info);
  const sku = record(record(marketing.show_product_marketing_info).show_sku_info);
  const shown = record(record(sku.show_price).show_price);
  if (text(shown.show_amount))
    return `${text(shown.price_prefix, 30) || ''}${text(shown.show_amount, 100)}${text(shown.price_suffix, 30) || ''}`;
  const formatted = text(p.price_text) || text(p.price_str);
  if (formatted) return formatted;
  // Native *_price_str is still cents (confirmed against the Feige price renderer).
  // Do not infer units for unrelated numeric price fields.
  const min = cents(p.sku_min_price_str),
    max = cents(p.sku_max_price_str);
  return min ? `¥${min}${max && min !== max ? `–¥${max}` : ''}` : undefined;
}
function product(raw: unknown) {
  const p = productSource(raw),
    base = record(p.product_base_info);
  const sourceId = p.product_id ?? p.productId ?? p.goods_id ?? p.id;
  const goodsId = id(sourceId);
  assert(
    goodsId && /^\d{1,30}$/.test(goodsId),
    typeof sourceId === 'number' && !Number.isSafeInteger(sourceId)
      ? '抖店商品 ID 发生数字精度丢失，无法用于后续查询'
      : '抖店商品数据缺少有效的商品 ID（product_item.product_id / product_id）',
    'DOUYIN_SCHEMA',
  );
  return compact({
    goodsId,
    title: text(base.title) || text(p.product_name) || text(p.title) || text(p.name),
    imageUrl: url(base.main_img) || url(p.img) || url(p.image_url) || url(p.pic),
    priceText: productPrice(p),
    priceLabel: text(record(p.marketing_info).marketing_price_prefix, 100),
  });
}
function hasMore(p: Record<string, unknown>, parsed: Record<string, unknown>) {
  if (typeof p.has_more === 'boolean') return p.has_more;
  if (typeof p.hasMore === 'boolean') return p.hasMore;
  if (typeof p.total === 'number' && Number.isSafeInteger(p.total) && p.total >= 0)
    return Number(parsed.page) * Number(parsed.pageSize) < p.total;
  return null;
}
export function normalizeDouyinQuery(
  operation: CommerceQueryOperation,
  raw: unknown,
  input: Record<string, unknown>,
  buyerId: string,
): CommerceQueryResult {
  const parsed = commerceQuerySchemas[operation].parse(input) as Record<string, unknown>;
  const p = douyinPayload(raw);
  if (operation === 'order-remark-state')
    return {
      operation,
      subjectId: buyerId,
      queriedAt: new Date().toISOString(),
      partial: false,
      failedSections: [],
      data: orderRemarkStateSchema.parse(p),
    };
  const extra = normalizeExtraQuery(operation, p, parsed, buyerId, 'douyin');
  if (extra) return extra;
  let data: Record<string, unknown>;
  if (operation === 'goods' || operation === 'buyer-footprint') {
    data = {
      products: list(p, ['product_list', 'products', 'list', 'items', 'data'])
        .slice(0, Number(parsed.pageSize))
        .map(product),
      page: parsed.page,
      pageSize: parsed.pageSize,
      hasMore: hasMore(p, parsed),
    };
  } else if (operation === 'goods-detail') {
    const detail = productSource(p.product ?? p.product_detail ?? p.detail ?? p);
    const item = product(detail);
    assert(item.goodsId === parsed.goodsId, '抖店返回了其他商品的资料');
    const properties = Array.isArray(detail.properties)
      ? detail.properties.slice(0, 40).map((v) => {
          const a = record(v);
          return compact({ name: text(a.name), value: text(a.value) });
        })
      : [];
    data = {
      product: item,
      description: text(detail.description ?? detail.desc, 10000),
      properties,
      propertiesAvailable: Array.isArray(detail.properties),
    };
  } else if (operation === 'buyer-orders') {
    const rows = list(p, ['order_list', 'orders', 'list', 'items', 'data']);
    assert(
      rows.length > 0 ||
        (!(parsed.page === 1 && typeof p.total === 'number' && p.total > 0) &&
          (!p.componentized_data || Object.keys(Object(p.componentized_data)).length === 0)),
      '抖店返回了尚未识别的组件化订单，不能将其视为买家没有订单',
      'DOUYIN_SCHEMA',
    );
    const orders = rows.slice(0, Number(parsed.pageSize)).map((v) => {
      const o = record(v),
        orderSn = id(o.order_id ?? o.orderId ?? o.order_sn);
      assert(orderSn && /^\d+$/.test(orderSn), '抖店订单 ID 无效或发生数字精度丢失');
      return compact({
        orderSn,
        productTitle: text(o.product_name ?? o.product_title),
        goodsId: id(o.product_id),
        statusText: text(o.status_desc ?? o.order_status_text ?? o.status_name),
        amountText: text(o.pay_amount_text ?? o.amount_text),
        remark: text(o.remark),
        source: 'current_buyer',
      });
    });
    data = {
      orders,
      page: parsed.page,
      pageSize: parsed.pageSize,
      hasMore: hasMore(p, parsed),
    };
  } else if (operation === 'history') {
    const messages = list(p, ['msgList', 'messages', 'message_list', 'list', 'data'])
      .slice(0, Number(parsed.pageSize))
      .map((v) => {
        const m = record(v),
          body = record(m.messageBody ?? m),
          messageId = id(
            m.server_id ?? m.serverId ?? m.serverMessageId ?? m.message_id ?? m.msg_id,
          );
        assert(messageId, '历史消息缺少稳定消息 ID');
        return compact({
          messageId,
          text: text(body.content ?? body.text, 4000),
          type:
            text(record(body.ext).type) ||
            text(body.type ?? body.message_type, 100) ||
            id(body.msgType),
          timestamp: id(body.create_time ?? body.createTime ?? body.createdAt ?? body.timestamp),
          senderId: id(body.sender ?? body.sender_id),
        });
      });
    data = {
      messages,
      nextCursor: id(p.nextCursor ?? p.next_cursor ?? p.cursor) ?? null,
      hasMore: typeof p.has_more === 'boolean' ? p.has_more : null,
    };
  } else throw new Error('当前抖店适配器未提供该查询');
  return {
    operation,
    ...(['buyer-footprint', 'buyer-orders', 'history'].includes(operation)
      ? { subjectId: buyerId }
      : operation === 'goods-detail'
        ? { subjectId: String(parsed.goodsId) }
        : {}),
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data,
  };
}
