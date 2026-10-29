import { normalizeExtraQuery } from '../commerce-extra';
import {
  pddQuerySchemas,
  type PddQueryOperation,
  type PddQueryResult,
  type OrderRemarkState,
} from '../../../contracts/src/pdd-tools';
import { assert } from '../../../core/src/util';
import { normalizePddMessage } from './index';
import { isPddRejected, pddFailureReason } from './response';

import { record } from '../shared';
export { record } from '../shared';
const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const id = (v: unknown) =>
  typeof v === 'string' && v.length <= 100
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v)
      ? String(v)
      : undefined;
const number = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const url = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 1500) return undefined;
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};
const compact = (v: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));
export function pddPayload(raw: unknown): unknown {
  const r = record(raw);
  assert(Object.keys(r).length > 0, '拼多多返回了无法识别的数据', 'PDD_SCHEMA');
  assert(!isPddRejected(r), `拼多多拒绝查询${pddFailureReason(r)}`, 'PDD_REJECTED');
  if (r.success === true) {
    assert('result' in r || 'data' in r, '拼多多响应缺少 result', 'PDD_SCHEMA');
    return r.result ?? r.data ?? null;
  }
  // Chat list uses {result:"ok", messages, has_more}; some storefront endpoints return data directly.
  return r.result != null && typeof r.result === 'object' ? r.result : r;
}
function product(raw: unknown) {
  const p = record(raw),
    goodsId = id(p.goodsId ?? p.goods_id);
  assert(goodsId && /^\d+$/.test(goodsId), '商品列表存在无效商品 ID', 'PDD_SCHEMA');
  return compact({
    goodsId,
    title: text(p.goodsName ?? p.goods_name),
    imageUrl: url(p.thumbUrl ?? p.thumb_url),
    // Confirmed in the platform's SKU selector; values are cents, not a final payable price.
    groupPriceMinCents: number(p.minOnSaleGroupPrice),
    groupPriceMaxCents: number(p.maxOnSaleGroupPrice),
  });
}
export function normalizePddQuery(
  operation: PddQueryOperation,
  raw: unknown,
  input: Record<string, unknown>,
  buyerId: string,
  queriedAt = new Date().toISOString(),
): PddQueryResult {
  const parsed = pddQuerySchemas[operation].parse(input) as Record<string, unknown>;
  if (operation === 'order-remark-state') {
    const r = record(raw);
    return {
      operation,
      subjectId: buyerId,
      queriedAt,
      partial: false,
      failedSections: [],
      data: normalizeOrderRemark(r.note, r.tag),
    };
  }
  if (operation === 'video-materials') {
    const envelope = record(raw);
    // /latitude/user/file/list uses success:true + snake_case 1000000, unlike
    // the chat protocol. Keep this exception local; conflicting errors still fail.
    const videoRaw =
      envelope.success === true && [1000000, '1000000'].includes(envelope.error_code as any)
        ? { ...envelope, error_code: 0 }
        : raw;
    return normalizeExtraQuery(operation, pddPayload(videoRaw), parsed, buyerId, 'pinduoduo')!;
  }
  const failedSections: PddQueryResult['failedSections'] = [];
  let data: Record<string, unknown>;
  const pagination = (p: Record<string, unknown>, pageSize = parsed.pageSize) => ({
    page: parsed.page,
    pageSize,
    ...(pageSize !== parsed.pageSize ? { requestedPageSize: parsed.pageSize } : {}),
    reportedTotal: number(p.total) ?? null,
    hasMore: typeof p.hasMore === 'boolean' ? p.hasMore : null,
  });
  if (operation === 'goods-detail') {
    const sections = record(raw);
    data = { goodsId: parsed.goodsId };
    for (const section of ['detail', 'properties']) {
      try {
        const result = record(sections[section]);
        assert(result.ok === true, text(result.error) || '请求失败', 'PDD_QUERY');
        const p = record(pddPayload(result.data));
        const responseId = id(p.goods_id ?? p.goodsId);
        assert(!responseId || responseId === parsed.goodsId, '商品 ID 与查询不一致', 'PDD_SCOPE');
        if (section === 'properties') {
          assert(Array.isArray(p.properties), '属性响应缺少 properties', 'PDD_SCHEMA');
          data.properties = p.properties.slice(0, 40).map((raw) => {
            const item = record(raw);
            assert(
              typeof item.name === 'string' &&
                Array.isArray(item.values) &&
                item.values.every((v) => typeof v === 'string'),
              '属性数据格式变化',
              'PDD_SCHEMA',
            );
            return {
              name: text(item.name, 100),
              values: item.values.slice(0, 10).map((v) => text(v)),
            };
          });
          data.propertiesTruncated =
            p.properties.length > 40 ||
            p.properties.some((v) => (record(v).values as unknown[])?.length > 10);
        } else {
          const title = text(p.goods_name ?? p.goodsName),
            description = text(p.goods_desc ?? p.goodsDesc, 2500);
          assert(
            title !== undefined || description !== undefined,
            '详情响应未识别到名称或描述',
            'PDD_SCHEMA',
          );
          data.detail = compact({ title, description });
          data.descriptionTruncated =
            typeof (p.goods_desc ?? p.goodsDesc) === 'string' &&
            String(p.goods_desc ?? p.goodsDesc).length > 2500;
        }
      } catch (e) {
        failedSections.push({
          section,
          reason: e instanceof Error ? e.message.slice(0, 300) : '查询失败',
        });
      }
    }
    assert(
      failedSections.length < 2,
      `商品详情查询失败：${failedSections.map((s) => s.reason).join('；')}`,
      'PDD_QUERY',
    );
  } else {
    const p = record(pddPayload(raw));
    if (operation === 'goods' || operation === 'buyer-footprint') {
      const keys = [
        'goodsList',
        'onSaleGoods',
        'todayBrowseGoods',
        'historyBrowseGoods',
        'recommendGoods',
      ];
      const present = keys.filter((k) => Array.isArray(p[k]));
      assert(present.length > 0, '商品查询响应没有可识别的商品列表', 'PDD_SCHEMA');
      let remaining = 30;
      const groups = present.map((category) => {
        const items = p[category] as unknown[],
          selected = items.slice(0, remaining);
        remaining -= selected.length;
        return {
          category,
          items: selected.map(product),
          returnedCount: items.length,
          truncated: items.length > selected.length,
        };
      });
      data = {
        groups,
        // Keep aligned with the PDD bridge's recommendGoods request. Never label
        // a native ten-item page as five items or infer that an error is empty.
        pagination: pagination(p, Math.max(10, Number(parsed.pageSize))),
        truncated: groups.some((g) => g.truncated),
        meaning:
          operation === 'buyer-footprint'
            ? '当前买家关联商品候选；不是完整浏览时间线，也不证明唯一意向商品。'
            : '平台分页返回的店铺商品；不是全店关键词搜索。',
      };
    } else if (operation === 'goods-skus') {
      assert(
        !id(p.goodsId ?? p.goods_id) || id(p.goodsId ?? p.goods_id) === parsed.goodsId,
        'SKU 商品与查询不一致',
        'PDD_SCOPE',
      );
      assert(Array.isArray(p.sku), 'SKU 响应缺少 sku 列表', 'PDD_SCHEMA');
      const offset = Number(parsed.offset),
        limit = Number(parsed.limit);
      const items = p.sku.slice(offset, offset + limit).map((raw) => {
        const s = record(raw),
          skuId = id(s.skuId);
        assert(skuId && Array.isArray(s.specs), 'SKU 响应格式变化', 'PDD_SCHEMA');
        return compact({
          skuId,
          specs: s.specs.slice(0, 10).map((raw) => {
            const spec = record(raw);
            assert(
              typeof spec.specKey === 'string' && typeof spec.specValue === 'string',
              'SKU 规格格式变化',
              'PDD_SCHEMA',
            );
            return { name: text(spec.specKey, 100), value: text(spec.specValue, 200) };
          }),
          imageUrl: url(s.thumbUrl),
          groupPriceCents: number(s.groupPrice),
          quantity: number(s.quantity),
        });
      });
      data = {
        goodsId: parsed.goodsId,
        items,
        total: p.sku.length,
        offset,
        nextOffset: offset + limit < p.sku.length ? offset + limit : null,
        meaning: '查询时的拼团标价（分）和库存；不是最终优惠结算价或库存承诺。',
      };
    } else if (operation === 'buyer-orders') {
      // userAllOrder returns orders:null with total:0 for a buyer without orders.
      // Require that explicit count; missing or contradictory data is still an error.
      const empty = p.orders === null && p.total === 0;
      const source = empty ? [] : p.orders;
      assert(Array.isArray(source), '拼多多订单数据格式异常，请刷新后重试', 'PDD_SCHEMA');
      const orders = source.slice(0, Number(parsed.pageSize)).map((raw) => {
        const o = record(raw),
          orderSn = id(o.orderSn);
        assert(orderSn && /^[0-9-]{6,80}$/.test(orderSn), '订单号格式无法识别', 'PDD_SCHEMA');
        // The endpoint is scoped by uid; reject an explicit contradictory owner if supplied.
        assert(o.uid == null || id(o.uid) === buyerId, '平台返回了其他买家的订单', 'PDD_SCOPE');
        const g = record(o.orderGoodsList);
        return compact({
          orderSn,
          status: text(o.orderStatusStr),
          createdAt: number(o.createdAt),
          goods: compact({
            goodsId: id(g.goodsId),
            title: text(g.goodsName),
            quantity: number(g.goodsNumber),
            spec: text(g.spec),
          }),
        });
      });
      data = {
        orders,
        pagination: { ...pagination(p), ...(empty ? { hasMore: false } : {}) },
        truncated: source.length > orders.length,
      };
    } else {
      assert(Array.isArray(p.messages), '历史响应缺少 messages 列表', 'PDD_SCHEMA');
      const selected = p.messages.slice(0, Number(parsed.pageSize));
      const messages = selected.flatMap((raw) => {
        const m = normalizePddMessage('', raw);
        if (!m || m.kind === 'system') return [];
        assert(m.buyerId === buyerId, '平台返回了其他买家的历史消息', 'PDD_SCOPE');
        return [
          {
            messageId: m.externalId,
            direction: m.direction,
            kind: m.kind,
            text: m.text.slice(0, 1000),
            timestamp: m.timestamp,
            ...(m.remoteImageUrl ? { imageUrl: url(m.remoteImageUrl) } : {}),
          },
        ];
      });
      const oldest = selected
        .map(record)
        .filter((m) => id(m.msg_id) && number(Number(m.ts)) != null)
        .sort((a, b) => Number(a.ts) - Number(b.ts))[0];
      const hasMore = typeof p.has_more === 'boolean' ? p.has_more : null;
      data = {
        messages,
        omittedMessageCount: selected.length - messages.length,
        truncated:
          p.messages.length > selected.length || messages.some((m) => m.text.length === 1000),
        hasMore,
        nextCursor:
          hasMore !== false && oldest && id(oldest.msg_id) !== parsed.cursor
            ? id(oldest.msg_id)
            : null,
        meaning: '历史资料只供查询，不触发新消息处理；图片 URL 不代表已理解图片内容。',
      };
    }
  }
  return {
    operation,
    queriedAt,
    subjectId:
      typeof parsed.goodsId === 'string'
        ? parsed.goodsId
        : ['buyer-footprint', 'buyer-orders', 'history'].includes(operation)
          ? buyerId
          : undefined,
    partial: failedSections.length > 0,
    failedSections,
    data,
  };
}
export function normalizeOrderRemark(noteRaw: unknown, tagRaw: unknown): OrderRemarkState {
  const note = record(noteRaw);
  pddPayload(noteRaw);
  assert(
    note.success === true &&
      'result' in note &&
      (note.result == null || typeof note.result === 'string'),
    '无法核验原订单备注',
    'PDD_SCHEMA',
  );
  const tagPayload = pddPayload(tagRaw);
  assert(
    tagPayload && typeof tagPayload === 'object' && !Array.isArray(tagPayload),
    '无法核验原备注标签',
    'PDD_SCHEMA',
  );
  const tag = record(tagPayload);
  assert(
    'tag' in tag ||
      'tagName' in tag ||
      (Object.keys(tag).length === 0 && record(tagRaw).success === true),
    '备注标签响应格式变化',
    'PDD_SCHEMA',
  );
  assert(
    tag.tag == null || typeof tag.tag === 'string' || typeof tag.tag === 'number',
    '无法核验原备注标签',
    'PDD_SCHEMA',
  );
  assert(
    tag.tagName == null || typeof tag.tagName === 'string',
    '无法核验原备注标签名称',
    'PDD_SCHEMA',
  );
  return {
    remark: typeof note.result === 'string' ? note.result : '',
    tag: (tag.tag ?? '') as string | number,
    tagName: (tag.tagName ?? '') as string,
  };
}
