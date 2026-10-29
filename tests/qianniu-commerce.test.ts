import { describe, expect, it, vi } from 'vitest';
import {
  QianniuCommerce,
  qianniuCapabilities,
  qianniuMtopPayload,
} from '../packages/platforms/src/qianniu/commerce';
import type { SendCommand } from '../packages/contracts/src';
import type { TransferCommand } from '../packages/contracts/src/workbench';
import type { QuickCommand } from '../packages/contracts/src/commerce-extra';

const apis = {
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
};
const buyer = {
  accountId: '220000000001',
  accountType: 3,
  nick: '买家甲',
  encryptAccountId: 'ENCRYPTED_BUYER_A',
};
const scope = {
  buyerId: buyer.accountId,
  conversationKey: `${buyer.accountId}.1-1001.1#11001@cntaobao`,
  platformContext: { buyerNick: buyer.nick },
};
const goodsId = '90071992547409931';
const goods = {
  itemId: goodsId,
  title: '测试商品',
  pic: '//img.alicdn.com/test.png',
  price: '12.30',
  quantity: 9,
  soldQuantity: 8,
  propsName: '20000:100:品牌:测试品牌;20001:101:服务方式:线上交付',
  approveStatus: 'onsale',
  buttons: [
    { code: 'sendItem', hidden: false },
    { code: 'inviteBuy', hidden: false },
  ],
};
const orderSn = '4900000000000000123';
const order = {
  bizOrderId: orderSn,
  buyerId: buyer.accountId,
  cardTypeText: '待发货',
  orderPrice: '12.30',
  createTime: '2026-09-01 12:00:00',
  receiverName: '买**',
  receiverAddress: '上海市***',
  itemList: [
    {
      bizOrderId: orderSn,
      auctionId: goodsId,
      auctionTitle: goods.title,
      price: '12.30',
      buyAmount: 1,
      picUrl: goods.pic,
    },
  ],
};
const accounts = [
  { accountId: 9001, mainAccountId: 1001, nick: '接待', pcOnline: true, suspend: false },
  { accountId: 9002, mainAccountId: 1001, nick: '售后', pcOnline: true, suspend: false },
  { accountId: 9003, mainAccountId: 1001, nick: '离线', pcOnline: false, suspend: false },
  { accountId: 9004, mainAccountId: 1001, nick: '挂起', pcOnline: true, suspend: true },
];
const groups = [
  {
    id: 5001,
    userId: 1001,
    groupName: '售后组',
    status: 1,
    onlineUserNumbersInGroup: 1,
    accounts: [accounts[1]],
  },
  { groupName: 'GetGroupAccountInfo_UnDispatchGroup', userId: 1001, accounts: [] },
];
const receipt = (api: string, data: unknown) => ({
  api,
  data,
  ret: ['SUCCESS::调用成功'],
  v: '1.0',
});
type Handler = unknown | ((param: any) => unknown | Promise<unknown>);
function fixture(overrides: Partial<Record<keyof typeof apis, Handler>> = {}) {
  const data: Record<keyof typeof apis, Handler> = {
    contact: { code: '0', data: [buyer] },
    goods: (param: any) => ({
      data: [goods],
      page: param.pageNo,
      pageSize: param.pageSize,
      totalCount: 1,
    }),
    profile: { buyerCreditLevel: 8, buyerCreditScore: 260, isNewCustomer: false, isShopFans: true },
    footprint: {
      underInquiryItemList: [goods],
      recentlyBoughtItemList: [goods],
      footPointItemList: [{ ...goods, itemId: '952' }],
      hasMoreFootPrint: true,
    },
    orders: { orders: [order], pageNum: 1 },
    logistics: {
      logisticsInfoList: [
        {
          goodsList: [{ taobaoTradeId: orderSn }],
          logisticsDetailList: [{ time: '2026-09-01 12:00:00', desc: '商品已下单' }],
        },
      ],
      orderDetailList: [{ mainBizOrderId: orderSn }],
      receiver: { name: '买**', phone: '****1000', noSplitCharDetailAddress: '上海市***' },
    },
    staff: { errorCode: 0, module: accounts },
    groups: { result: JSON.stringify({ errorCode: 0, module: groups, success: true }) },
    forward: { errorCode: 0, module: true },
    card: { sendCard: true, sendUrl: `https://item.taobao.com/item.htm?id=${goodsId}` },
    invite: { code: '0', data: true },
    ...overrides,
  };
  const calls: Array<{ method: string; param: any; version: string }> = [];
  const invoke = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    expect(method).toBe('application.invokeMTopChannelService');
    const key = (Object.keys(apis) as Array<keyof typeof apis>).find(
      (name) => apis[name] === payload.method,
    );
    if (!key) throw new Error(`Unexpected method ${payload.method}`);
    calls.push({
      method: String(payload.method),
      param: payload.param,
      version: String(payload.version),
    });
    const handler = data[key];
    return receipt(
      apis[key],
      typeof handler === 'function' ? await handler(payload.param) : handler,
    );
  });
  return { adapter: new QianniuCommerce(invoke, 'shop:接待'), invoke, calls, data };
}
const transfer: TransferCommand = {
  ...scope,
  id: 'b84b5215-12f6-4c90-80c6-b7b37d4e2dfb',
  accountId: 'account',
  targetStaffId: '9002',
  note: '请协助售后',
};
const quick = (operation: QuickCommand['operation'], targetId: string): QuickCommand => ({
  ...scope,
  id: transfer.id,
  accountId: 'account',
  operation,
  targetId,
  note: '售后协助',
});
const card: SendCommand = {
  ...scope,
  id: 'send-card',
  token: 'token',
  accountId: 'account',
  kind: 'product_card',
  text: '测试商品',
  richContent: { kind: 'product_card', goodsId, title: goods.title },
};
const orderRef = 'order:b84b5215-12f6-4c90-80c6-b7b37d4e2dfb:0';

describe('Qianniu MTop protocol validation', () => {
  it('requires explicit MTop success and rejects nested failures or the wrong method', () => {
    expect(qianniuMtopPayload({ data: receipt(apis.goods, { data: [] }) }, apis.goods)).toEqual({
      data: [],
    });
    for (const raw of [
      { data: [] },
      { api: apis.goods, data: { data: [] }, ret: ['NOT_SUCCESS::failed'] },
      receipt(apis.goods, { code: '403' }),
      receipt(apis.orders, { orders: [] }),
    ])
      expect(() => qianniuMtopPayload(raw, apis.goods)).toThrow();
  });
  it('does not advertise unavailable platform mutations or pretend offline capabilities work', () => {
    expect(qianniuCapabilities(false).operations).toEqual([]);
    const capabilities = qianniuCapabilities(true, true);
    expect(capabilities.staffTransfer).toBe(true);
    expect(capabilities.operations).toContain('order-logistics');
    expect(capabilities.operations).toContain('history');
    expect(capabilities.operations).not.toContain('ship-order');
    expect(capabilities.operations).not.toContain('goods-skus');
  });
});

describe('Qianniu commerce queries', () => {
  it('uses the observed buyer for keyword/paged goods and preserves large decimal IDs', async () => {
    const f = fixture();
    const result = await f.adapter.query('goods', {
      ...scope,
      keyword: '服务',
      page: 2,
      pageSize: 5,
    });
    expect(f.calls[0].param.searchQuery).toBe(buyer.nick);
    expect(f.calls[1]).toMatchObject({
      method: apis.goods,
      param: { pageNo: 2, pageSize: 5, keyWord: '服务', encryptId: buyer.encryptAccountId },
    });
    expect(result.subjectId).toBeUndefined();
    expect(result.data.products).toEqual([
      expect.objectContaining({
        goodsId,
        title: goods.title,
        priceText: '¥12.30',
        stock: 9,
        imageUrl: 'https://img.alicdn.com/test.png',
      }),
    ]);
  });
  it('never takes the first fuzzy buyer match or accepts conflicting observed identities', async () => {
    const f = fixture({
      contact: {
        code: '0',
        data: [{ ...buyer, accountId: '220000000002', nick: '其他买家' }, buyer],
      },
    });
    await f.adapter.query('buyer-profile', scope);
    expect(f.calls[1].param.encryptId).toBe(buyer.encryptAccountId);
    await expect(
      f.adapter.query('buyer-profile', { ...scope, platformContext: { buyerNick: '其他买家' } }),
    ).rejects.toThrow('精确匹配');
    await expect(
      f.adapter.query('buyer-profile', {
        ...scope,
        platformContext: { buyerNick: buyer.nick, securityUserId: 'WRONG' },
      }),
    ).rejects.toThrow('不匹配');
    f.data.contact = { data: [buyer, { ...buyer, encryptAccountId: 'OTHER_ENCRYPTION' }] };
    await expect(f.adapter.query('buyer-profile', scope)).rejects.toThrow('多个不一致');
  });
  it('rejects unsafe numeric IDs and absent lists while accepting genuine empty lists', async () => {
    const f = fixture({ goods: { data: [{ ...goods, itemId: Number(goodsId) }] } });
    await expect(f.adapter.query('goods', scope)).rejects.toThrow('精度');
    f.data.goods = { totalCount: 0 };
    await expect(f.adapter.query('goods', scope)).rejects.toThrow('列表');
    f.data.goods = { data: [], totalCount: 0 };
    expect((await f.adapter.query('goods', scope)).data.products).toEqual([]);
  });
  it('revalidates the known product page for detail and marks the available detail scope', async () => {
    const f = fixture();
    await f.adapter.query('goods', { ...scope, page: 3, pageSize: 5, keyword: '服务' });
    const result = await f.adapter.query('goods-detail', { ...scope, goodsId });
    expect(f.calls.at(-1)!.param).toMatchObject({ pageNo: 3, pageSize: 5, keyWord: '服务' });
    expect(result).toMatchObject({
      subjectId: goodsId,
      partial: true,
      data: {
        product: { goodsId },
        properties: [
          { label: '品牌', value: '测试品牌' },
          { label: '服务方式', value: '线上交付' },
        ],
      },
    });
    f.data.goods = { data: [], totalCount: 0 };
    await expect(f.adapter.query('goods-detail', { ...scope, goodsId })).rejects.toThrow(
      '重新搜索',
    );
  });
  it('normalizes credit profile and deduplicated footprint with explicit incomplete-history status', async () => {
    const f = fixture();
    const profile = await f.adapter.query('buyer-profile', scope);
    expect(profile).toMatchObject({
      subjectId: buyer.accountId,
      data: { buyerId: buyer.accountId, name: buyer.nick, creditLevel: 8 },
    });
    expect(String(profile.data.introduction)).toContain('店铺粉丝');
    const footprint = await f.adapter.query('buyer-footprint', { ...scope, page: 2, pageSize: 1 });
    expect(footprint.partial).toBe(true);
    expect(footprint.data.products).toEqual([
      expect.objectContaining({ goodsId: '952', relation: '浏览' }),
    ]);
    expect(footprint.data.hasMore).toBe(false);
  });
  it('returns buyer-scoped orders and refreshes them before detail and logistics', async () => {
    const f = fixture();
    const result = await f.adapter.query('buyer-orders', { ...scope, page: 1, pageSize: 5 });
    expect(f.calls.at(-1)!.param).toEqual({
      orderStatus: '',
      securityBuyerUid: buyer.encryptAccountId,
    });
    expect(result.data.orders).toEqual([
      expect.objectContaining({
        orderSn,
        buyerId: buyer.accountId,
        amountText: '¥12.30',
        goods: expect.objectContaining({ goodsId }),
      }),
    ]);
    const detail = await f.adapter.query('order-detail', { ...scope, orderRef, orderSn });
    expect(detail).toMatchObject({ subjectId: buyer.accountId, data: { order: { orderSn } } });
    expect(f.calls.at(-1)!.method).toBe(apis.orders);
    const logistics = await f.adapter.query('order-logistics', { ...scope, orderRef, orderSn });
    expect(f.calls.at(-1)!).toMatchObject({
      method: apis.logistics,
      param: { bizOrderId: orderSn },
    });
    expect(logistics.data.records).toContainEqual({
      label: '2026-09-01 12:00:00',
      value: '商品已下单',
    });
    expect(logistics.data.records).toContainEqual({ label: '电话', value: '****1000' });
  });
  it('refuses orders belonging to another buyer and never calls logistics for unverified IDs', async () => {
    const f = fixture({ orders: { orders: [{ ...order, buyerId: '220000000002' }], pageNum: 1 } });
    await expect(f.adapter.query('buyer-orders', scope)).rejects.toThrow('其他买家');
    f.data.orders = { orders: [], pageNum: 0 };
    await expect(
      f.adapter.query('order-logistics', { ...scope, orderRef, orderSn }),
    ).rejects.toThrow('当前买家');
    expect(f.calls.some((call) => call.method === apis.logistics)).toBe(false);
  });
  it('paginates the returned recent orders locally without inventing remote page parameters', async () => {
    const second = {
      ...order,
      bizOrderId: '4900000000000000124',
      itemList: [{ ...order.itemList[0], bizOrderId: '4900000000000000124' }],
    };
    const f = fixture({ orders: { orders: [order, second], pageNum: 1, hasMore: true } });
    const result = await f.adapter.query('buyer-orders', { ...scope, page: 2, pageSize: 1 });
    expect(result.data.orders).toEqual([expect.objectContaining({ orderSn: second.bizOrderId })]);
    expect(result.data.hasMore).toBe(false);
    expect(result.partial).toBe(true);
    expect(f.calls.at(-1)!.param).toEqual({
      orderStatus: '',
      securityBuyerUid: buyer.encryptAccountId,
    });
  });
  it('rejects logistics whose included order IDs conflict with the verified request', async () => {
    const f = fixture({
      logistics: {
        logisticsInfoList: [
          { goodsList: [{ taobaoTradeId: '4900000000000000124' }], logisticsDetailList: [] },
        ],
      },
    });
    await expect(
      f.adapter.query('order-logistics', { ...scope, orderRef, orderSn }),
    ).rejects.toThrow('其他订单');
  });
  it('reads native module staff status, excludes self/offline/suspended, and parses serialized groups', async () => {
    const f = fixture();
    expect(await f.adapter.staff()).toEqual([{ id: '9002', name: '售后', statusText: '在线' }]);
    const result = await f.adapter.query('staff-groups', scope);
    expect(result.data.groups).toEqual([
      { id: '5001', name: '售后组', memberCount: 1, onlineCount: 1, statusText: '可转接' },
    ]);
    const stats = await f.adapter.query('staff-statistics', { ...scope, page: 2, pageSize: 2 });
    expect(stats.data.staff).toEqual([
      expect.objectContaining({ id: '9003', statusText: '离线' }),
      expect.objectContaining({ id: '9004', statusText: '已挂起' }),
    ]);
    expect(stats.data.hasMore).toBe(false);
  });
});

describe('Qianniu guarded commerce actions', () => {
  it('revalidates the target then authorizes immediately before individual transfer', async () => {
    const f = fixture();
    const authorize = vi.fn(async (preview) => {
      expect(f.calls.at(-1)!.method).toBe(apis.staff);
      expect(f.calls.some((call) => call.method === apis.forward)).toBe(false);
      expect(preview).toEqual({
        buyerId: buyer.accountId,
        conversationKey: scope.conversationKey,
        targetStaffId: '9002',
        targetName: '售后',
      });
    });
    expect(await f.adapter.transfer(transfer, authorize)).toMatchObject({ status: 'confirmed' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(f.calls.at(-1)!).toMatchObject({
      method: apis.forward,
      version: '3.0',
      param: { buyerId: buyer.accountId, toId: '9002', reason: transfer.note },
    });
    expect(JSON.parse(f.calls.at(-1)!.param.options)).toMatchObject({
      appCid: scope.conversationKey,
    });
  });
  it('does not transfer after guard rejection or to offline/current targets', async () => {
    const f = fixture();
    await expect(
      f.adapter.transfer(transfer, async () => {
        throw new Error('guard refused');
      }),
    ).rejects.toThrow('guard refused');
    for (const targetStaffId of ['9001', '9003', '9004'])
      await expect(
        f.adapter.transfer({ ...transfer, targetStaffId }, async () => {}),
      ).rejects.toThrow('目标客服');
    expect(f.calls.some((call) => call.method === apis.forward)).toBe(false);
  });
  it('uses the revalidated group owner and numeric buyer identity for group transfer', async () => {
    const f = fixture();
    const authorize = vi.fn(async () => {});
    expect(await f.adapter.quick(quick('transfer-group', '5001'), authorize)).toMatchObject({
      status: 'confirmed',
    });
    expect(authorize).toHaveBeenCalledWith({
      operation: 'transfer-group',
      buyerId: buyer.accountId,
      conversationKey: scope.conversationKey,
      targetId: '5001',
    });
    expect(f.calls.at(-1)!.param).toMatchObject({
      buyerId: buyer.accountId,
      toId: '1001',
      reason: '售后协助',
    });
    expect(JSON.parse(f.calls.at(-1)!.param.options)).toMatchObject({
      groupId: '5001',
      forwardType: 2,
      appCid: scope.conversationKey,
    });
  });
  it('keeps exact decimal item IDs in invited-order JSON and obtains a business receipt', async () => {
    const f = fixture();
    expect(await f.adapter.quick(quick('invite-order', goodsId), async () => {})).toMatchObject({
      status: 'confirmed',
    });
    expect(f.calls.at(-1)!.param).toMatchObject({
      encryptId: buyer.encryptAccountId,
      buyerNick: buyer.nick,
      itemProps: `[{"itemId":${goodsId},"quantity":1,"context":{}}]`,
    });
  });
  it('rejects invalid catalog/conversation prechecks before marking a card as dispatched', async () => {
    const f = fixture({ goods: { data: [], totalCount: 0 } });
    const dispatch = vi.fn();
    expect(await f.adapter.sendRich(card, dispatch)).toMatchObject({ status: 'rejected' });
    expect(dispatch).not.toHaveBeenCalled();
    f.data.goods = { data: [goods], totalCount: 1 };
    expect(
      await f.adapter.sendRich(
        { ...card, conversationKey: 'other.1-1001.1#11001@cntaobao' },
        dispatch,
      ),
    ).toMatchObject({ status: 'rejected' });
    expect(f.calls.some((call) => call.method === apis.card)).toBe(false);
  });
  it('does not manufacture a message ID from product-card API acknowledgement', async () => {
    const f = fixture();
    const dispatch = vi.fn(() => {
      expect(f.calls.at(-1)!.method).toBe(apis.goods);
      expect(f.calls.some((call) => call.method === apis.card)).toBe(false);
    });
    const result = await f.adapter.sendRich(card, dispatch);
    expect(result).toMatchObject({ status: 'unknown' });
    expect(result).not.toHaveProperty('externalId');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.calls.at(-1)!.param.batchItemIds).toBe(`[${goodsId}]`);
  });
  it('distinguishes explicit rejection from missing receipt or a lost SDK response', async () => {
    const f = fixture({ forward: { errorCode: 403, message: '权限不足' } });
    expect(await f.adapter.transfer(transfer, async () => {})).toMatchObject({
      status: 'rejected',
    });
    f.data.forward = { errorCode: 0 };
    expect(await f.adapter.transfer(transfer, async () => {})).toMatchObject({ status: 'unknown' });
    f.data.forward = () => {
      throw new Error('SDK timeout');
    };
    expect(await f.adapter.transfer(transfer, async () => {})).toMatchObject({ status: 'unknown' });
    f.data.card = { sendCard: false };
    expect(await f.adapter.sendRich(card)).toMatchObject({ status: 'rejected' });
  });
});
