import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RechargeQr,
  rechargeQrSource,
  type RechargePayment,
} from '../apps/desktop/src/renderer/components/recharge-qr';

const payment: RechargePayment = {
  id: 'hupijiao-order',
  provider: 'hupijiao',
  status: 'pending',
  qrCodeUrl: 'https://pay.example.test/qr/order.png',
};

describe('充值支付二维码', () => {
  it('虎皮椒二维码图片直接显示原 HTTPS 地址，不把图片网址重新编码', () => {
    const html = renderToStaticMarkup(createElement(RechargeQr, { order: payment }));
    expect(html).toContain('<img src="https://pay.example.test/qr/order.png"');
    expect(html).not.toContain('data:image');
    expect(rechargeQrSource(payment)).toBe(payment.qrCodeUrl);
  });

  it.each([null, '', 'http://pay.example.test/qr.png', 'javascript:alert(1)', 'not-a-url'])(
    '虎皮椒图片缺失或不安全时不展示二维码：%s',
    (qrCodeUrl) => {
      expect(rechargeQrSource({ ...payment, qrCodeUrl })).toBeNull();
    },
  );

  it.each(['creating', 'paid', 'closed', 'refunding', 'refunded', 'failed'])(
    '%s 订单不能继续显示付款二维码',
    (status) => {
      const order = { ...payment, status };
      expect(rechargeQrSource(order)).toBeNull();
      expect(renderToStaticMarkup(createElement(RechargeQr, { order }))).not.toContain('<img');
    },
  );

  it('到达有效期时隐藏二维码，即使服务器暂时仍返回 pending', () => {
    const expiresAt = '2026-09-18T06:05:00.000Z';
    const expires = Date.parse(expiresAt);
    expect(rechargeQrSource({ ...payment, expiresAt }, expires - 1)).toBe(payment.qrCodeUrl);
    expect(rechargeQrSource({ ...payment, expiresAt }, expires)).toBeNull();
    expect(rechargeQrSource({ ...payment, expiresAt: 'invalid' })).toBeNull();
    const html = renderToStaticMarkup(
      createElement(RechargeQr, { order: { ...payment, expiresAt: '2000-01-01T00:00:00Z' } }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('支付二维码已过期');
  });
});
