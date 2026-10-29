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
  typeof v === 'string' && /^[1-9]\d{0,29}$/.test(v)
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v) && v > 0
      ? String(v)
      : undefined;
const compact = (v: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));
const url = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
};
export function kuaishouPayload(raw: unknown): Record<string, unknown> {
  let p = record(raw);
  for (let i = 0; i < 3; i++) {
    assert(Object.keys(p).length > 0, '快手返回了无法识别的数据', 'KUAISHOU_SCHEMA');
    assert(
      p.success !== false &&
        (p.result == null || Number(p.result) === 1) &&
        (p.code == null || Number(p.code) === 0),
      `快手拒绝查询${p.result != null ? `（错误码 ${String(p.result).slice(0, 30)}）` : ''}：${text(p.error_msg ?? p.message, 250) || '请检查登录及账号权限'}`,
      'KUAISHOU_REJECTED',
    );
    if (p.data && typeof p.data === 'object' && !Array.isArray(p.data)) p = record(p.data);
    else return p;
  }
  return p;
}
function list(p: Record<string, unknown>, key: string) {
  assert(Array.isArray(p[key]), `快手响应缺少 ${key} 列表，不能将其视为空列表`, 'KUAISHOU_SCHEMA');
  return p[key] as unknown[];
}
export function kuaishouStaff(raw: unknown) {
  return list(kuaishouPayload(raw), 'stat').map((value) => {
    const row = record(value),
      userId = id(row.userId),
      name = text(row.userName, 200);
    assert(userId && name, '快手客服列表缺少有效的 userId/userName', 'KUAISHOU_SCHEMA');
    return compact({
      id: userId,
      name,
      statusText: text(row.onlineStatusDesc, 100),
      activeCount: typeof row.workingSession === 'number' ? row.workingSession : undefined,
    });
  });
}
const cents = (v: unknown) => {
  const value = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return undefined;
  const n = BigInt(value);
  return `¥${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
};
export function normalizeKuaishouQuery(
  operation: CommerceQueryOperation,
  raw: unknown,
  input: Record<string, unknown>,
  buyerId: string,
): CommerceQueryResult {
  const params = commerceQuerySchemas[operation].parse(input) as Record<string, unknown>;
  const p = kuaishouPayload(raw);
  let data: Record<string, unknown>,
    partial = false;
  if (operation === 'buyer-profile') {
    assert(p.buyerId === buyerId, '快手买家资料不属于当前会话');
    partial = p.unavailable === true;
    data = compact({
      buyerId,
      name: text(p.name, 200),
      avatar: url(p.avatar),
      ...(partial ? { note: '平台尚未提供当前买家的详细资料' } : {}),
    });
  } else if (operation === 'buyer-orders') {
    const orders = list(p, 'orderInfoList')
      .slice(0, Number(params.pageSize))
      .map((value) => {
        const row = record(value),
          base = record(row.orderBaseInfo),
          item = record(row.itemAndPriceInfo);
        const orderSn = id(base.oid);
        assert(
          orderSn,
          '快手订单缺少有效的 orderBaseInfo.oid，或订单号精度已丢失',
          'KUAISHOU_SCHEMA',
        );
        assert(base.buyerId == null || id(base.buyerId) === buyerId, '快手返回了其他买家的订单');
        const notes = Array.isArray(base.noteList)
          ? base.noteList.map((v) => text(record(v).text, 1000)).filter(Boolean)
          : [];
        const goods = compact({
          goodsId: id(item.itemId),
          title: text(item.itemTitle, 1000),
          imageUrl: url(item.itemPicUrl),
          spec: text(item.skuDesc),
          quantity: typeof item.itemNum === 'number' ? item.itemNum : undefined,
        });
        return compact({
          orderSn,
          buyerId,
          productTitle: goods.title,
          goods,
          statusText: text(base.statusDesc ?? base.statusName, 100),
          amountText: cents(record(item.paymentInfo).price),
          remark: notes.join('\n') || undefined,
          details: [
            ...(text(item.skuDesc) ? [{ label: '商品规格', value: text(item.skuDesc) }] : []),
            ...(typeof item.itemNum === 'number'
              ? [{ label: '数量', value: String(item.itemNum) }]
              : []),
          ],
        });
      });
    const total =
      typeof p.total === 'number' && Number.isSafeInteger(p.total) && p.total >= 0
        ? p.total
        : undefined;
    assert(
      !(params.page === 1 && total && !orders.length),
      '快手返回了订单总数但没有订单列表，请重试查询',
    );
    data = compact({
      orders,
      page: params.page,
      pageSize: params.pageSize,
      total,
      hasMore: total == null ? null : Number(params.page) * Number(params.pageSize) < total,
    });
  } else if (operation === 'goods' || operation === 'buyer-footprint') {
    const products = list(p, 'itemInfo')
      .slice(0, Number(params.pageSize))
      .map((value) => {
        const row = record(value);
        const goodsId = id(row.itemId);
        assert(
          goodsId,
          typeof row.itemId === 'number' && !Number.isSafeInteger(row.itemId)
            ? '快手商品 ID 发生数字精度丢失，无法用于后续查询'
            : '快手商品缺少有效的 itemId',
          'KUAISHOU_SCHEMA',
        );
        const images = Array.isArray(row.imageUrls) ? row.imageUrls : [];
        const imageUrl = url(images[0]) || url(row.itemPicUrl) || url(row.imageUrl);
        const min = cents(row.minPrice),
          max = cents(row.maxPrice);
        return compact({
          goodsId,
          title: text(row.title ?? row.itemTitle, 1000),
          imageUrl,
          priceText:
            min && max && min !== max ? `${min}–${max}` : min || max || cents(row.itemPrice),
          description: text(row.deliverDesc, 500),
        });
      });
    const total =
      typeof p.total === 'number' && Number.isSafeInteger(p.total) && p.total >= 0
        ? p.total
        : undefined;
    assert(
      !(params.page === 1 && total && !products.length),
      operation === 'buyer-footprint'
        ? '快手返回了足迹总数但没有商品列表，请重试查询'
        : '快手返回了商品总数但没有商品列表，请重试查询',
    );
    data = compact({
      products,
      page: params.page,
      pageSize: params.pageSize,
      total,
      hasMore: total == null ? null : Number(params.page) * Number(params.pageSize) < total,
    });
  } else if (operation === 'history') {
    data = {
      messages: list(p, 'messages').map((value) => {
        const m = record(value);
        assert(
          m.buyerId === buyerId && m.conversationId === `0_${buyerId}`,
          '快手历史消息不属于当前会话',
        );
        return compact({
          messageId: id(m.messageId),
          direction: m.direction,
          kind: m.kind,
          text: text(m.text, 10000),
          timestamp: text(m.timestamp, 100),
          imageUrl: url(m.imageUrl),
        });
      }),
      hasMore: p.hasMore === true,
      nextCursor: text(p.nextCursor, 100) || '',
    };
    partial = p.partial === true;
  } else if (operation === 'staff-groups') {
    data = {
      groups: list(p, 'groups').map((value) => {
        const g = record(value),
          groupId = id(g.groupId),
          name = text(g.groupName, 200);
        assert(groupId && name, '快手客服分组缺少有效 ID/名称');
        return compact({
          id: groupId,
          name,
          memberCount: g.memberCount,
          onlineCount: g.onlineCount,
        });
      }),
      ...(p.groupDispatch === false
        ? { note: text(p.groupDispatchCloseToast) || '平台未开启分组转接' }
        : {}),
    };
  } else if (operation === 'staff-statistics') {
    const staff = kuaishouStaff(raw),
      offset = (Number(params.page) - 1) * Number(params.pageSize);
    data = {
      staff: staff.slice(offset, offset + Number(params.pageSize)),
      page: params.page,
      pageSize: params.pageSize,
      hasMore: offset + Number(params.pageSize) < staff.length,
    };
  } else throw new Error('快手尚未提供此查询能力');
  return {
    operation,
    ...(['buyer-footprint', 'buyer-orders', 'history', 'buyer-profile'].includes(operation)
      ? { subjectId: buyerId }
      : {}),
    queriedAt: new Date().toISOString(),
    partial,
    failedSections: partial
      ? [
          {
            section: operation,
            reason: operation === 'history' ? '部分平台消息类型尚未识别' : '平台尚未提供详细资料',
          },
        ]
      : [],
    data,
  };
}
