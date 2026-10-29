import { AccountAuth } from './components/account-auth';
import { useEffect, useRef, useState } from 'react';
import { RechargeQr } from './components/recharge-qr';
import { Cloud, CreditCard, RefreshCw, LogOut, ArrowRight, KeyRound, Wallet } from 'lucide-react';
import { api, client, useData, useUi } from './api';
import { Button, Badge, Field, Modal } from './components/ui';
import type { CloudCatalog } from '../../../../packages/core/src/license';
import './styles-license.css';
import './styles-cloud.css';

const money = (value: number, digits = 2) => `¥${Number(value || 0).toFixed(digits)}`;
const date = (value: any) => (value ? new Date(value).toLocaleString('zh-CN') : '—');
const orderStatus: Record<string, string> = {
  creating: '正在核实下单结果',
  pending: '等待扫码付款',
  paid: '支付成功',
  closed: '订单已关闭',
  refunding: '退款处理中',
  refunded: '已全额退款',
  refund_abnormal: '退款待核实',
  failed: '失败',
  succeeded: '成功',
  completed: '成功',
};

export function AccountPage({
  onContinue,
  onUseOwn,
}: {
  onContinue?: () => void;
  onUseOwn?: () => void;
}) {
  const ui = useUi();
  const { data: account, error, refetch } = useData('license.state');
  const catalog = useData<CloudCatalog>('license.cloudCatalog', {}, !!account?.configured);
  const accountScope = account?.user?.id || 'signed-out';
  const wallet = useData('license.cloudWallet', {}, !!account?.loggedIn, accountScope);
  const usage = useData('license.cloudUsage', {}, !!account?.loggedIn, accountScope);
  const recharges = useData<any[]>(
    'license.cloudRechargeOrders',
    {},
    !!account?.loggedIn,
    accountScope,
  );
  const { data: localModels = [] } = useData<any[]>('models.list');
  const [busy, setBusy] = useState(false);
  const [notice, notify] = useState('');
  const [tab, setTab] = useState<'models' | 'usage' | 'transactions'>('models');
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [proOpen, setProOpen] = useState(false);
  const [amount, setAmount] = useState('50');
  const [order, setOrder] = useState<any>();
  const [proOrder, setProOrder] = useState<any>();
  const [, refreshExpiry] = useState(0);
  const orderUnresolved = !!order && ['creating', 'pending'].includes(order.status);
  const orderExpired = !!order?.expiresAt && Date.parse(order.expiresAt) <= Date.now();
  const proUnresolved = !!proOrder && ['creating', 'pending'].includes(proOrder.status);
  const proExpired = !!proOrder?.expiresAt && Date.parse(proOrder.expiresAt) <= Date.now();
  const rechargeRequest = useRef<{ amountCents: number; requestId: string } | undefined>(undefined);
  const proRequest = useRef<{ planId: string; requestId: string } | undefined>(undefined);
  const proPlan = account?.software?.plans?.[0];
  useEffect(() => {
    setOrder(undefined);
    setProOrder(undefined);
    setRechargeOpen(false);
    setProOpen(false);
    rechargeRequest.current = undefined;
    proRequest.current = undefined;
  }, [accountScope]);
  useEffect(() => {
    if (!rechargeOpen || !order?.expiresAt) return;
    const delay = Date.parse(order.expiresAt) - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(
      () => refreshExpiry((value) => value + 1),
      Math.min(delay, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [rechargeOpen, order?.id, order?.expiresAt]);
  useEffect(() => {
    if (!proOpen || !proOrder?.expiresAt) return;
    const delay = Date.parse(proOrder.expiresAt) - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(
      () => refreshExpiry((value) => value + 1),
      Math.min(delay, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [proOpen, proOrder?.id, proOrder?.expiresAt]);

  async function act(method: Parameters<typeof api>[0], input = {}) {
    setBusy(true);
    notify('');
    try {
      const result = await api(method, input);
      await client.invalidateQueries();
      return result;
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败，请重试');
      return null;
    } finally {
      setBusy(false);
    }
  }
  function useOwn() {
    if (onUseOwn) return onUseOwn();
    ui.setSettingsSection('models');
  }
  async function selectModel(model: any) {
    if (busy) return;
    setBusy(true);
    notify('');
    try {
      const saved = await api('license.cloudUseModel', { modelId: model.id });
      await api('app.settings', {
        aiSetupMode: 'cloud',
        ...(model.kind === 'embedding'
          ? { embeddingProfileId: saved.id }
          : { defaultModelId: saved.id }),
      });
      await client.invalidateQueries();
      notify(`已设为${model.kind === 'embedding' ? '问答检索' : '默认对话'}模型。`);
      if (onContinue && model.kind !== 'embedding') onContinue();
    } catch (e) {
      notify(e instanceof Error ? e.message : '模型添加失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!account?.loggedIn || !catalog.data) return;
    void client.invalidateQueries();
  }, [account?.loggedIn, catalog.data]);
  useEffect(() => {
    if (!rechargeOpen || !order || !['creating', 'pending'].includes(order.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api('license.cloudRechargeStatus', { id: order.id });
        if (stopped) return;
        setOrder(next);
        if (!['creating', 'pending'].includes(next.status)) {
          await client.invalidateQueries();
          return;
        }
      } catch (e) {
        if (!stopped) notify(e instanceof Error ? e.message : '读取支付结果失败');
      }
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [rechargeOpen, order?.id, order?.status]);
  useEffect(() => {
    if (!proOpen || !proOrder || !['creating', 'pending'].includes(proOrder.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api('license.softwareOrder', { id: proOrder.id });
        if (stopped) return;
        setProOrder(next);
        if (next.status === 'paid') {
          await api('license.refresh', {});
          await client.invalidateQueries();
          notify('Pro 已开通，可以配置自己的 API Key。');
          return;
        }
        if (!['creating', 'pending'].includes(next.status)) {
          await client.invalidateQueries();
          return;
        }
      } catch (e) {
        if (!stopped) notify(e instanceof Error ? e.message : '读取 Pro 订单失败');
      }
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [proOpen, proOrder?.id, proOrder?.status]);

  if (!account)
    return (
      <div className="license-page">
        <p>{error?.message || '正在读取云端账号…'}</p>
        <Button onClick={() => refetch()}>刷新</Button>
      </div>
    );

  const remoteError = catalog.error || wallet.error || usage.error || recharges.error;
  const models = catalog.data?.models || [];
  const rows = usage.data?.items || [];
  const transactions = usage.data?.transactions || [];
  return (
    <div className={`license-page cloud-page ${onContinue ? 'license-welcome' : ''}`}>
      <header className="license-heading">
        <div>
          <Badge>
            {account.canUseByok
              ? account.subscription?.plan === 'pro'
                ? 'Pro · 可用自有 Key'
                : '软件免费 · 可用自有 Key'
              : '软件免费 · 自有 Key 需 Pro'}
          </Badge>
          <h1>云端 AI 与 Pro</h1>
          <p>
            接待与全部软件功能免费。云端模型按量计费；配置自己的 API Key 需要句达 Pro。
          </p>
        </div>
        <div className="license-actions">
          {account.canUseByok ? (
            <Button variant="secondary" onClick={useOwn}>
              <KeyRound size={15} /> 使用自己的 API Key
            </Button>
          ) : account.loggedIn ? (
            <Button
              variant="secondary"
              disabled={busy || !account.software?.plans?.length}
              onClick={() => {
                notify('');
                setProOpen(true);
              }}
            >
              <KeyRound size={15} /> 开通 Pro 使用自有 Key
            </Button>
          ) : (
            <Button variant="secondary" disabled>
              <KeyRound size={15} /> 自有 Key 需登录并开通 Pro
            </Button>
          )}
          {account.loggedIn && (
            <Button variant="ghost" disabled={busy} onClick={() => void act('license.refresh')}>
              <RefreshCw size={15} /> 刷新
            </Button>
          )}
        </div>
      </header>
      {(notice || error || remoteError) && (
        <div className="license-notice" role="status">
          {notice || error?.message || remoteError?.message}
        </div>
      )}
      {!account.configured ? (
        <section className="license-card cloud-unavailable">
          <Cloud size={30} />
          <h2>云端 AI 服务尚未配置</h2>
          <p>你可以先连接自己的模型服务，免费使用全部软件功能。云端服务开放后可随时登录。</p>
          <Button onClick={useOwn}>
            设置自己的 API Key <ArrowRight size={15} />
          </Button>
        </section>
      ) : !account.loggedIn ? (
        <section className="license-login license-card">
          <div>
            <Cloud size={32} />
            <h2>按需使用云端 AI</h2>
            <p>注册或登录后即可使用云端模型。模型请求按输入与输出用量计费，价格在调用前可查看。</p>
            <ul>
              <li>无限店铺、自动学习与高级定制免费开放</li>
              <li>账户余额与消费记录随时可查</li>
              <li>自有 API Key 需开通句达 Pro</li>
            </ul>
          </div>
          <AccountAuth act={act} busy={busy} notify={notify} />
        </section>
      ) : (
        <>
          <section className="license-card license-profile">
            <div className="license-user">
              <Cloud size={24} />
              <div>
                <h2>{account.user?.name || '云端账号'}</h2>
                <small>{account.user?.email}</small>
              </div>
            </div>
            <div className="license-profile-actions">
              {onContinue && (
                <Button onClick={() => onContinue()}>
                  进入工作空间 <ArrowRight size={15} />
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => void act('license.logout')}>
                <LogOut size={15} /> 退出账号
              </Button>
            </div>
          </section>
          <section className="cloud-wallet license-card">
            <div>
              <span>
                <KeyRound size={17} /> 软件套餐
              </span>
              <strong>
                {account.subscription?.plan === 'pro' ? '句达 Pro' : '免费版'}
              </strong>
              <small>
                {account.subscription?.plan === 'pro' && account.subscription.proExpiresAt
                  ? `有效期至 ${date(account.subscription.proExpiresAt)} · 可配置自有 API Key`
                  : '开通 Pro 后可填写自己的模型 Base URL 与 API Key'}
              </small>
            </div>
            <div className="cloud-wallet-action">
              <Button
                disabled={
                  busy ||
                  !account.software?.paymentEnabled ||
                  !account.software?.plans?.length
                }
                onClick={() => {
                  notify('');
                  setProOpen(true);
                }}
              >
                <CreditCard size={16} />{' '}
                {account.subscription?.plan === 'pro' ? '续费 Pro' : '开通 Pro'}
              </Button>
              {!account.software?.paymentEnabled && <small>在线购买尚未开放</small>}
            </div>
          </section>
          <section className="cloud-wallet license-card">
            <div>
              <span>
                <Wallet size={17} /> 可用余额
              </span>
              <strong>{wallet.data ? money(wallet.data.availableCny, 4) : '—'}</strong>
              <small>
                账户余额 {wallet.data ? money(wallet.data.balanceCny, 4) : '—'} ·
                进行中的请求可能预占部分余额
              </small>
            </div>
            <div className="cloud-wallet-action">
              <Button
                disabled={busy || !catalog.data?.paymentEnabled}
                onClick={() => {
                  notify('');
                  setRechargeOpen(true);
                }}
              >
                <CreditCard size={16} /> 充值余额
              </Button>
              {!catalog.data?.paymentEnabled && <small>在线充值尚未开放</small>}
            </div>
          </section>
          <div className="license-tabs" role="tablist" aria-label="云端 AI 管理">
            {(
              [
                ['models', '可用模型'],
                ['usage', '消费明细'],
                ['transactions', '余额流水'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {account.configured && (!account.loggedIn || tab === 'models') && (
        <section className="license-card cloud-models">
          <div className="cloud-section-heading">
            <div>
              <h2>云端模型与价格</h2>
              <p>
                单价为人民币 / 百万 token。登录后目录模型会自动加入本机可用列表，实际调用才计费。
              </p>
            </div>
          </div>
          {!models.length ? (
            <p>{catalog.isLoading ? '正在读取模型价格…' : '暂时没有可用的云端模型。'}</p>
          ) : (
            <div className="cloud-table-wrap">
              <table className="cloud-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>输入单价</th>
                    <th>输出单价</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model: any) => {
                    const added = localModels.some(
                      (local: any) => local.id === `cloud:${model.id}`,
                    );
                    return (
                      <tr key={model.id}>
                        <td>
                          <strong>{model.displayName || model.model}</strong>
                          <small>
                            {model.model} · {model.kind === 'embedding' ? '向量检索' : '对话模型'}
                          </small>
                        </td>
                        <td>{money(model.inputPriceCnyPerMillion, 4)}</td>
                        <td>
                          {model.kind === 'embedding'
                            ? '—'
                            : money(model.outputPriceCnyPerMillion, 4)}
                        </td>
                        <td>
                          <Button
                            variant={added ? 'secondary' : 'default'}
                            disabled={busy || !account.loggedIn}
                            onClick={() => void selectModel(model)}
                          >
                            {added ? '设为默认' : '同步中…'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {account.loggedIn && tab === 'usage' && (
        <section className="license-card">
          <h2>最近消费</h2>
          <p>费用按服务端记录的模型用量结算。</p>
          {rows.length ? (
            <div className="cloud-table-wrap">
              <table className="cloud-table">
                <thead>
                  <tr>
                    <th>时间 / 模型</th>
                    <th>输入 / 输出 token</th>
                    <th>费用</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: any) => (
                    <tr key={row.id}>
                      <td>
                        {date(row.createdAt)}
                        <small>{row.providerModel}</small>
                      </td>
                      <td>
                        {Number(row.promptTokens || 0).toLocaleString()} /{' '}
                        {Number(row.completionTokens || 0).toLocaleString()}
                      </td>
                      <td>{money(row.chargeCny, 6)}</td>
                      <td>
                        {row.status === 'pending'
                          ? '处理中'
                          : orderStatus[row.status] || row.status || '已结算'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>暂无云端模型消费记录。</p>
          )}
        </section>
      )}
      {account.loggedIn && tab === 'transactions' && (
        <>
          <section className="license-card">
            <h2>最近余额流水</h2>
            {transactions.length ? (
              <div className="cloud-table-wrap">
                <table className="cloud-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>类型</th>
                      <th>金额变动</th>
                      <th>变动后余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((row: any) => (
                      <tr key={row.id}>
                        <td>{date(row.createdAt)}</td>
                        <td>
                          {(
                            {
                              recharge: '充值',
                              consume: '模型消费',
                              refund: '退款',
                              adjust: '余额调整',
                            } as Record<string, string>
                          )[row.kind] || row.kind}
                          <small>{row.note}</small>
                        </td>
                        <td>
                          {Number(row.amountCny) > 0 ? '+' : ''}
                          {money(row.amountCny, 6)}
                        </td>
                        <td>{money(row.balanceAfterCny, 6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>暂无余额流水。</p>
            )}
          </section>
          <section className="license-card">
            <h2>充值订单</h2>
            {recharges.data?.length ? (
              recharges.data.map((item) => (
                <div className="license-row" key={item.id}>
                  <div>
                    <strong>{money(item.amountCents / 100)}</strong>
                    <small>
                      {date(item.createdAt)} · {item.outTradeNo || item.id}
                    </small>
                  </div>
                  <Badge>{orderStatus[item.status] || item.status}</Badge>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      const fresh = await act('license.cloudRechargeStatus', { id: item.id });
                      if (fresh) {
                        setOrder(fresh);
                        setRechargeOpen(true);
                      }
                    }}
                  >
                    {['creating', 'pending'].includes(item.status) ? '查看并支付' : '查看订单'}
                  </Button>
                </div>
              ))
            ) : (
              <p>暂无充值订单。</p>
            )}
          </section>
        </>
      )}
      {onContinue && account.loggedIn && (
        <div className="service-skip">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('app.settings', { aiSetupMode: 'cloud' });
                await client.invalidateQueries();
                onContinue();
              } catch (e) {
                notify(e instanceof Error ? e.message : '保存失败');
              } finally {
                setBusy(false);
              }
            }}
          >
            稍后选模型，先进入工作空间 <ArrowRight size={15} />
          </Button>
        </div>
      )}
      <Modal
        open={rechargeOpen}
        onOpenChange={(open) => !busy && setRechargeOpen(open)}
        title="充值云端 AI 余额"
        description="余额仅用于云端模型调用，软件功能全部免费。"
      >
        <div className="license-modal">
          {!order ? (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || !catalog.data?.paymentEnabled) return;
                const amountCents = Math.round(Number(amount) * 100);
                if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 1000000) {
                  notify('充值金额应在 1 到 10000 元之间');
                  return;
                }
                if (!rechargeRequest.current || rechargeRequest.current.amountCents !== amountCents)
                  rechargeRequest.current = { amountCents, requestId: crypto.randomUUID() };
                const result = await act('license.cloudRecharge', rechargeRequest.current);
                if (result) setOrder(result);
              }}
            >
              <Field label="充值金额（元）">
                <input
                  type="number"
                  min="1"
                  max="10000"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <div className="cloud-amounts">
                {[10, 50, 100, 200].map((value) => (
                  <Button
                    type="button"
                    key={value}
                    variant={amount === String(value) ? 'default' : 'secondary'}
                    disabled={busy}
                    onClick={() => setAmount(String(value))}
                  >
                    {value} 元
                  </Button>
                ))}
              </div>
              <Button disabled={busy || !catalog.data?.paymentEnabled} type="submit">
                {busy ? '正在创建订单…' : '生成微信支付二维码'}
              </Button>
            </form>
          ) : (
            <div className="license-payment">
              <h2>
                {money(
                  Number(order.amountCents ?? rechargeRequest.current?.amountCents ?? 0) / 100,
                )}
              </h2>
              <Badge tone={order.status === 'paid' ? 'green' : 'orange'}>
                {orderStatus[order.status] || order.status}
              </Badge>
              <RechargeQr key={order.id} order={order} />
              <p>
                {order.status === 'paid'
                  ? '充值成功，余额已更新。'
                  : order.status === 'closed'
                    ? '订单已关闭，可以重新创建充值订单。'
                    : orderUnresolved && orderExpired
                      ? '原订单付款结果仍待核实。如果已经付款，请勿重复支付；原订单保留在充值记录中，可继续查询。'
                      : '支付后将自动核实结果。关闭窗口不会取消订单。'}
              </p>
              <small>订单号：{order.outTradeNo || order.id}</small>
              {order.lastError && <p className="setup-error">{order.lastError}</p>}
              <div className="license-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={async () => {
                    const next = await act('license.cloudRechargeStatus', { id: order.id });
                    if (next) setOrder(next);
                  }}
                >
                  刷新支付状态
                </Button>
                {(!orderUnresolved || orderExpired) && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      notify(
                        orderUnresolved
                          ? '原订单付款结果仍待核实。如果已经付款，请勿重复支付；确认未付款后，再创建新的充值订单。原订单可在充值记录中继续查询。'
                          : '',
                      );
                      setOrder(undefined);
                      rechargeRequest.current = undefined;
                    }}
                  >
                    {orderUnresolved ? '返回金额选择' : '再次充值'}
                  </Button>
                )}
              </div>
            </div>
          )}
          {notice && (
            <div className="license-notice" role="status">
              {notice}
            </div>
          )}
        </div>
      </Modal>
      <Modal
        open={proOpen}
        onOpenChange={(open) => !busy && setProOpen(open)}
        title={account?.subscription?.plan === 'pro' ? '续费句达 Pro' : '开通句达 Pro'}
        description="Pro 解锁自有 API Key / 自建模型。云端按量 AI 仍单独充值。"
      >
        <div className="license-modal">
          {!proOrder ? (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || !proPlan || !account?.software?.paymentEnabled) return;
                if (!proRequest.current || proRequest.current.planId !== proPlan.id)
                  proRequest.current = { planId: proPlan.id, requestId: crypto.randomUUID() };
                const result = await act('license.softwarePurchase', proRequest.current);
                if (result) setProOrder(result);
              }}
            >
              {proPlan ? (
                <>
                  <div className="license-row">
                    <div>
                      <strong>{proPlan.name}</strong>
                      <small>
                        {proPlan.days} 天 · {proPlan.description || '解锁自有 API Key'}
                      </small>
                    </div>
                    <strong>{money(proPlan.priceCents / 100)}</strong>
                  </div>
                  <Button disabled={busy || !account?.software?.paymentEnabled} type="submit">
                    {busy ? '正在创建订单…' : '生成微信支付二维码'}
                  </Button>
                </>
              ) : (
                <p>暂无可售 Pro 套餐，请稍后刷新或联系管理员。</p>
              )}
            </form>
          ) : (
            <div className="license-payment">
              <h2>
                {money(Number(proOrder.amountCents ?? proPlan?.priceCents ?? 0) / 100)}
              </h2>
              <Badge tone={proOrder.status === 'paid' ? 'green' : 'orange'}>
                {orderStatus[proOrder.status] || proOrder.status}
              </Badge>
              <RechargeQr key={proOrder.id} order={proOrder} />
              <p>
                {proOrder.status === 'paid'
                  ? 'Pro 已开通，可以配置自己的 API Key。'
                  : proOrder.status === 'closed'
                    ? '订单已关闭，可以重新购买。'
                    : proUnresolved && proExpired
                      ? '原订单付款结果仍待核实。如果已经付款，请勿重复支付。'
                      : '支付后将自动核实并开通 Pro。关闭窗口不会取消订单。'}
              </p>
              <small>订单号：{proOrder.outTradeNo || proOrder.id}</small>
              {proOrder.lastError && <p className="setup-error">{proOrder.lastError}</p>}
              <div className="license-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={async () => {
                    const next = await act('license.softwareOrder', { id: proOrder.id });
                    if (next) {
                      setProOrder(next);
                      if (next.status === 'paid') {
                        await act('license.refresh', {});
                        notify('Pro 已开通，可以配置自己的 API Key。');
                      }
                    }
                  }}
                >
                  刷新支付状态
                </Button>
                {(!proUnresolved || proExpired) && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setProOrder(undefined);
                      proRequest.current = undefined;
                    }}
                  >
                    {proUnresolved ? '返回套餐' : '再次购买'}
                  </Button>
                )}
                {proOrder.status === 'paid' && account?.canUseByok && (
                  <Button onClick={useOwn}>
                    配置自有 API Key <ArrowRight size={15} />
                  </Button>
                )}
              </div>
            </div>
          )}
          {notice && (
            <div className="license-notice" role="status">
              {notice}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
