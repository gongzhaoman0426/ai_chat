import { useEffect, useState } from 'react';

export type RechargePayment = {
  id: string;
  status: string;
  provider?: 'hupijiao';
  qrCodeUrl?: string | null;
  expiresAt?: string | null;
};

export function rechargeQrSource(order: RechargePayment, now = Date.now()) {
  if (order.status !== 'pending') return null;
  if (order.expiresAt && !(Date.parse(order.expiresAt) > now)) return null;
  try {
    const image = new URL(order.qrCodeUrl || '');
    if (image.protocol === 'https:' && !image.username && !image.password) return image.href;
  } catch {
    // Missing or malformed payment images are not displayed.
  }
  return null;
}

export function RechargeQr({ order }: { order: RechargePayment }) {
  const [now, setNow] = useState(Date.now);
  const [failedSource, setFailedSource] = useState('');
  const source = rechargeQrSource(order, now);

  useEffect(() => {
    setFailedSource('');
  }, [order]);

  useEffect(() => {
    setNow(Date.now());
    if (!order.expiresAt) return;
    const delay = Date.parse(order.expiresAt) - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2147483647));
    return () => clearTimeout(timer);
  }, [order.id, order.expiresAt]);

  if (order.status !== 'pending') return null;
  if (order.expiresAt && Date.parse(order.expiresAt) <= now)
    return <p className="setup-error">支付二维码已过期，请刷新支付状态。</p>;
  if (!source || failedSource === source)
    return <p className="setup-error">支付二维码暂不可用，请刷新支付状态。</p>;
  return (
    <img
      src={source}
      alt="微信充值支付二维码"
      width={240}
      height={240}
      referrerPolicy="no-referrer"
      onError={() => setFailedSource(source)}
    />
  );
}
