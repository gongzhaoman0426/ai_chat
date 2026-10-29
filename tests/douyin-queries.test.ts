import { describe, expect, it } from 'vitest';
import { normalizeDouyinQuery } from '../packages/platforms/src/douyin/queries';
import {
  douyinGoods,
  douyinDetail,
  douyinHistory,
  douyinEmptyOrders,
} from './fixtures-douyin-query';

describe('飞鸽真实响应结构回归', () => {
  it.each(['goods', 'buyer-footprint'] as const)(
    '%s 使用 product_item，忽略空旧字段和已舍入的 SKU ID',
    (operation) => {
      const result = normalizeDouyinQuery(operation, structuredClone(douyinGoods), {}, 'buyer');
      expect(result.data).toMatchObject({
        products: [
          {
            goodsId: '3737994268627829217',
            title: '测试休闲椅',
            imageUrl: 'https://p9-aio.ecombdimg.com/example.jpg',
            priceText: '¥100.00',
            priceLabel: '惠后价',
          },
        ],
        page: 1,
        pageSize: 10,
        hasMore: false,
      });
      expect(result.subjectId).toBe(operation === 'goods' ? undefined : 'buyer');
    },
  );
  it('详情的分单位字符串转换为元，并保留价格区间；不把字符串 10000 报成一万元', () => {
    const result = normalizeDouyinQuery(
      'goods-detail',
      douyinDetail,
      { goodsId: '3737994268627829217' },
      'buyer',
    );
    expect(result.data.product).toMatchObject({
      goodsId: '3737994268627829217',
      title: '测试休闲椅',
      priceText: '¥100.00',
    });
    expect(result.data.propertiesAvailable).toBe(false);
    expect(
      normalizeDouyinQuery(
        'goods-detail',
        { ...douyinDetail, data: { ...douyinDetail.data, sku_max_price_str: '12999' } },
        { goodsId: '3737994268627829217' },
        'buyer',
      ).data.product,
    ).toMatchObject({ priceText: '¥100.00–¥129.99' });
    expect(() =>
      normalizeDouyinQuery(
        'goods-detail',
        douyinDetail,
        { goodsId: '3737994268627829218' },
        'buyer',
      ),
    ).toThrow('其他商品');
  });
  it('历史 msgList 解析 messageBody 与精确 nextCursor，保留正文、类型和时间', () => {
    expect(normalizeDouyinQuery('history', douyinHistory, {}, 'buyer').data).toEqual({
      messages: [
        {
          messageId: '7650740519126992135',
          text: '商品有哪些颜色',
          type: 'text',
          timestamp: '1788878584337',
          senderId: 'test-buyer',
        },
      ],
      nextCursor: '1788878584337124',
      hasMore: null,
    });
  });
  it('真实空订单是空列表；分页依据平台 total 而不是猜测是否还有下一页', () => {
    expect(normalizeDouyinQuery('buyer-orders', douyinEmptyOrders, {}, 'buyer').data).toMatchObject(
      { orders: [], hasMore: false },
    );
    expect(
      normalizeDouyinQuery('goods', { ...douyinGoods, total: 11 }, { page: 1 }, 'buyer').data
        .hasMore,
    ).toBe(true);
    expect(
      normalizeDouyinQuery('goods', { ...douyinGoods, total: 11 }, { page: 2 }, 'buyer').data
        .hasMore,
    ).toBe(false);
  });
  it('仅有不安全数字 ID 仍拒绝，不能用空旧字段或四舍五入的 ID 掩盖未知结构', () => {
    const raw = structuredClone(douyinGoods);
    (raw.data[0].product_item as any).product_id = Number('3737994268627829217');
    expect(() => normalizeDouyinQuery('goods', raw, {}, 'buyer')).toThrow('精度丢失');
    raw.data[0].product_item.product_id = '';
    expect(() => normalizeDouyinQuery('goods', raw, {}, 'buyer')).toThrow('缺少有效');
  });
  it('空旧订单列表不能掩盖尚未适配的组件化订单', () => {
    expect(() =>
      normalizeDouyinQuery(
        'buyer-orders',
        {
          ...douyinEmptyOrders,
          total: 1,
          componentized_data: [{ component: 'new-order-card' }],
        },
        {},
        'buyer',
      ),
    ).toThrow('不能将其视为买家没有订单');
  });
  it.each(['VERIFY', 'BLOCK'])('平台返回 %s 时拒绝使用脱敏/受限数据', (decision) => {
    expect(() =>
      normalizeDouyinQuery('goods', { ...douyinGoods, check_spam_resp: { decision } }, {}, 'buyer'),
    ).toThrow('在平台完成验证');
  });
});
