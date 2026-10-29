import {
  PlatformSearch,
  PlatformActionButton,
  VideoMaterials,
  OrderRemark,
  GroupTransfer,
} from './workbench-extra';
import { useState, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import {
  Package,
  ShoppingBag,
  RefreshCw,
  ArrowRightLeft,
  ExternalLink,
  X,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  ImageOff,
} from 'lucide-react';
import { api, client, useData, useUi, date, invalidateLocalData } from '../../api';
import { Badge, Button, Empty, Field, Modal } from '../ui';

import type {
  WorkbenchContext,
  WorkbenchQueryResult,
} from '../../../../../../packages/contracts/src/workbench';
import {
  useWorkbenchQuery,
  products,
  productPrice,
  rows,
  object,
  money,
  morePages,
} from './workbench-data';
import { supportsCommerceKeywordSearch } from '../../../../../../packages/contracts/src/commerce-tools';

export function WorkbenchPanel({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const ctx = useQuery({
    queryKey: ['workbench.context', { conversationId }],
    queryFn: () => api<WorkbenchContext>('workbench.context', { conversationId }),
    staleTime: 60000,
    refetchInterval: 60000,
    retry: false,
  });
  return (
    <aside className="workbench-panel" aria-label="客户与订单">
      <div className="pane-heading">
        <h3>客户与订单</h3>
        <button className="desk-close" aria-label="收起客户与订单" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      {ctx.error ? (
        <div className="desk-error" role="alert">
          {ctx.error.message}
          <Button variant="ghost" onClick={() => void ctx.refetch()}>
            重新读取
          </Button>
        </div>
      ) : ctx.data ? (
        <PanelContent key={ctx.data.sessionId} ctx={ctx.data} refresh={() => void ctx.refetch()} />
      ) : (
        <p className="desk-muted">正在读取会话资料…</p>
      )}
    </aside>
  );
}
function PanelContent({ ctx, refresh }: { ctx: WorkbenchContext; refresh: () => void }) {
  const hasProducts = ['goods', 'buyer-footprint', 'conversation-item'].some((op) =>
    ctx.operations.includes(op),
  );
  const [tab, setTab] = useState(hasProducts ? 'products' : 'customer');
  const [transfer, setTransfer] = useState(false);
  const can = (op: string) => ctx.operations.includes(op);
  return (
    <>
      <div className="desk-customer">
        <div className="desk-scope-caption">
          <span>{ctx.storeName}</span>
          <small>接待账号 · {ctx.accountName}</small>
        </div>
        <div className="desk-actions">
          <Button variant="ghost" onClick={refresh}>
            <RefreshCw size={13} />
            刷新侧栏
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void api('accounts.connect', { accountId: ctx.accountId }).catch((e) =>
                useUi.getState().notify(e.message),
              )
            }
          >
            <ExternalLink size={13} />
            打开原平台
          </Button>
          <GroupTransfer ctx={ctx} />
          {can('transfer-conversation') && (
            <Button variant="ghost" onClick={() => setTransfer(true)}>
              <ArrowRightLeft size={13} />
              转接客服
            </Button>
          )}
        </div>
        {!ctx.online && (
          <p className="desk-error">
            账号未连接，重连后可查询业务资料。<button onClick={refresh}>刷新连接</button>
          </p>
        )}
      </div>
      <nav className="desk-tabs" aria-label="会话业务资料">
        {[
          ['customer', '客户'],
          ...(hasProducts ? [['products', '商品']] : []),
          ...(can('buyer-orders') ? [['orders', '订单']] : []),
          ...(can('video-materials') ? [['materials', '视频']] : []),
          ['records', '记录'],
        ].map(([id, name]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {name}
          </button>
        ))}
      </nav>
      <div className="desk-scroll">
        {!ctx.online && tab !== 'records' && (
          <p className="desk-muted">连接账号后可读取平台资料。</p>
        )}
        {ctx.online && tab === 'customer' && <Customer ctx={ctx} />}
        {ctx.online && tab === 'products' && <Products ctx={ctx} />}
        {ctx.online && tab === 'orders' && <Orders ctx={ctx} />}
        {ctx.online && tab === 'materials' && <VideoMaterials ctx={ctx} />}
        {tab === 'records' && <Records conversationId={ctx.conversationId} />}
      </div>
      {transfer && <Transfer ctx={ctx} onClose={() => setTransfer(false)} />}
    </>
  );
}
function QueryState({
  query,
  children,
  empty,
  emptyContent,
  refreshLabel = '刷新平台资料',
  refreshDisabled = false,
}: {
  query: UseQueryResult<WorkbenchQueryResult, Error>;
  children: ReactNode;
  empty?: boolean;
  emptyContent?: ReactNode;
  refreshLabel?: string;
  refreshDisabled?: boolean;
}) {
  if (query.isPending) return <p className="desk-muted">正在从平台读取…</p>;
  if (query.error)
    return (
      <div className="desk-error" role="alert">
        {query.error.message}
        <Button
          variant="ghost"
          disabled={refreshDisabled || query.isFetching}
          onClick={() => void query.refetch()}
        >
          重试查询
        </Button>
      </div>
    );
  return (
    <>
      {query.data?.partial && (
        <p className="desk-warning">
          平台仅返回部分资料。{query.data.failedSections.map((s) => s.reason).join('；')}
        </p>
      )}
      {empty ? (emptyContent ?? <p className="desk-muted">平台没有返回相关资料。</p>) : children}
      <div className="desk-query-time">
        <span>
          {query.isFetching ? '更新中…' : `查询于 ${query.data ? date(query.data.queriedAt) : ''}`}
        </span>
        <button
          aria-label={refreshLabel}
          title={refreshLabel}
          disabled={refreshDisabled || query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </>
  );
}
function Photo({ src, title }: { src?: string; title?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <div className="desk-photo">
      {src && src !== failedSrc ? (
        <img
          key={src}
          src={src}
          alt={title || '商品图片'}
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <ImageOff size={22} />
      )}
    </div>
  );
}
function Customer({ ctx }: { ctx: WorkbenchContext }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const supported = ctx.operations.includes('buyer-profile');
  const q = useWorkbenchQuery(ctx, 'buyer-profile');
  return (
    <>
      <h4>客户资料</h4>
      <dl className="desk-fields">
        <dt>买家</dt>
        <dd>{ctx.buyerName}</dd>
        <dt>买家标识</dt>
        <dd>{ctx.buyerId}</dd>
      </dl>
      {supported && (
        <QueryState query={q}>
          {q.data && (
            <>
              <p>{String(q.data.data.name || '')}</p>
              {q.data.data.avatar && <Photo src={String(q.data.data.avatar)} title="客户头像" />}
              <p>{String(q.data.data.introduction || '')}</p>
            </>
          )}
        </QueryState>
      )}
      {ctx.operations.includes('history') && (
        <details className="desk-history" onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
          <summary>
            {ctx.platform === 'qianniu' ? '查看本机已同步消息' : '查看平台聊天历史'}
          </summary>
          {historyOpen && <PlatformHistory ctx={ctx} />}
        </details>
      )}
      {!supported && <p className="desk-muted">当前平台仅提供会话中的客户资料。</p>}
    </>
  );
}
function PlatformHistory({ ctx }: { ctx: WorkbenchContext }) {
  const [cursor, setCursor] = useState('');
  const q = useWorkbenchQuery(ctx, 'history', { cursor, pageSize: 20 });
  const messages = rows(q.data?.data.messages);
  return (
    <QueryState query={q} empty={!messages.length}>
      <div className="desk-history-messages">
        {messages.map((m, i) => (
          <div key={m.messageId || i}>
            <small>
              {m.direction === 'in' || m.senderId === ctx.buyerId
                ? ctx.buyerName
                : m.direction === 'out' || m.senderId
                  ? '客服'
                  : '平台消息'}{' '}
              · {m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) ? date(m.timestamp) : ''}
            </small>
            <p>{m.text || (m.kind === 'image' ? '图片消息' : '平台消息')}</p>
            {m.imageUrl && <Photo src={m.imageUrl} title="历史消息图片" />}
          </div>
        ))}
      </div>
      {!!q.data?.data.nextCursor && q.data.data.nextCursor !== cursor && (
        <Button variant="ghost" onClick={() => setCursor(String(q.data!.data.nextCursor))}>
          {ctx.platform === 'qianniu' ? '更早的本机消息' : '更早的平台消息'}
        </Button>
      )}
      <p className="desk-muted">查询历史不会触发自动回复或补发消息。</p>
      {ctx.platform === 'qianniu' && (
        <p className="desk-muted">仅本机已同步消息，无法补全千牛登录前或离线期间的记录。</p>
      )}
    </QueryState>
  );
}
function Pager({
  page,
  setPage,
  more,
  count,
  fetching,
}: {
  page: number;
  setPage: (v: number) => void;
  more: boolean | null;
  count: number;
  fetching: boolean;
}) {
  return (
    <div className="desk-pager">
      <button
        aria-label="上一页"
        disabled={page <= 1 || fetching}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeft size={15} />
      </button>
      <span>第 {page} 页</span>
      <button
        aria-label="下一页"
        disabled={page >= 100 || fetching || more === false || count === 0}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}
function Products({ ctx }: { ctx: WorkbenchContext }) {
  const [keyword, setKeyword] = useState('');
  const [requestedMode, setMode] = useState(
    ['conversation-item', 'buyer-footprint', 'goods'].find((op) => ctx.operations.includes(op)) ??
      'goods',
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, any> | null>(null);
  const available = ['conversation-item', 'buyer-footprint', 'goods'].filter((op) =>
    ctx.operations.includes(op),
  );
  const mode = available.includes(requestedMode) ? requestedMode : (available[0] ?? 'goods');
  const q = useWorkbenchQuery(
    ctx,
    mode,
    mode === 'conversation-item'
      ? {}
      : {
          page,
          pageSize: 10,
          ...(mode === 'goods' && supportsCommerceKeywordSearch(ctx.platform, 'goods')
            ? { keyword }
            : {}),
        },
  );
  const list = products(q.data?.data);
  if (!available.length)
    return <Empty icon={<Package size={26} />}>此账号尚未提供商品查询。</Empty>;
  return (
    <>
      <div className="desk-section-heading">
        <h4>咨询相关商品</h4>
        <select
          aria-label="商品来源"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setPage(1);
          }}
        >
          {available.map((op) => (
            <option key={op} value={op}>
              {
                {
                  'conversation-item': '当前咨询',
                  'buyer-footprint': '关联商品',
                  goods: '店铺商品',
                }[op]
              }
            </option>
          ))}
        </select>
      </div>
      {mode === 'goods' && supportsCommerceKeywordSearch(ctx.platform, 'goods') && (
        <PlatformSearch
          placeholder="搜索店铺商品"
          onSearch={(v) => {
            setKeyword(v);
            setPage(1);
          }}
        />
      )}
      {mode === 'buyer-footprint' && (
        <p className="desk-muted">以下为平台关联候选，请结合聊天确认客户咨询哪款商品。</p>
      )}
      <QueryState query={q} empty={!list.length}>
        {list.map((p) => (
          <button key={p.goodsId} className="desk-product" onClick={() => setSelected(p)}>
            <Photo src={p.imageUrl} title={p.title} />
            <div>
              <strong>{p.title || `商品 ${p.goodsId}`}</strong>
              <b>{productPrice(p)}</b>
              <small>
                查看详情 <ChevronRight size={11} />
              </small>
            </div>
          </button>
        ))}
      </QueryState>
      {mode !== 'conversation-item' && (
        <Pager
          page={page}
          setPage={setPage}
          more={morePages(q.data?.data)}
          count={list.length}
          fetching={q.isFetching}
        />
      )}
      {selected && <ProductDetail ctx={ctx} product={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
function ProductDetail({
  ctx,
  product,
  onClose,
}: {
  ctx: WorkbenchContext;
  product: Record<string, any>;
  onClose: () => void;
}) {
  const [sku, setSku] = useState(false);
  const [offset, setOffset] = useState(0);
  const q = useWorkbenchQuery(ctx, 'goods-detail', { goodsId: product.goodsId });
  const skus = useWorkbenchQuery(
    ctx,
    'goods-skus',
    { goodsId: product.goodsId, offset, limit: 20 },
    sku,
  );
  const p = object(q.data?.data.product ?? q.data?.data.detail);
  return (
    <Modal open onOpenChange={(v) => !v && onClose()} title="商品详情" description={ctx.storeName}>
      <div className="desk-detail">
        <div className="desk-product-hero">
          <Photo src={p.imageUrl || product.imageUrl} title={p.title || product.title} />
          <div>
            <strong>{product.title || p.title || product.goodsId}</strong>
            <p>{productPrice(product)}</p>
            <small>商品编号 {product.goodsId}</small>
          </div>
        </div>
        {ctx.operations.includes('goods-detail') && (
          <QueryState query={q}>
            <p>{p.description || (q.data?.data.description as string)}</p>
            <dl className="desk-fields">
              {rows(q.data?.data.properties).map((f, i) => (
                <div key={i}>
                  <dt>{f.name || f.label}</dt>
                  <dd>
                    {f.value ||
                      (Array.isArray(f.values)
                        ? f.values.map((v: any) => (typeof v === 'object' ? v.value : v)).join('、')
                        : '')}
                  </dd>
                </div>
              ))}
            </dl>
          </QueryState>
        )}
        {ctx.operations.includes('goods-skus') && (
          <>
            <Button variant="secondary" onClick={() => setSku(!sku)}>
              规格与库存
            </Button>
            {sku && (
              <QueryState query={skus} empty={!rows(skus.data?.data.items).length}>
                {rows(skus.data?.data.items).map((s) => (
                  <div className="desk-sku" key={s.skuId}>
                    <strong>
                      {rows(s.specs)
                        .map((v) => `${v.name}：${v.value}`)
                        .join(' / ') || s.skuId}
                    </strong>
                    <span>{money(s.groupPriceCents)}</span>
                    <small>{s.quantity == null ? '未提供库存' : `库存 ${s.quantity}`}</small>
                  </div>
                ))}
                {skus.data?.data.nextOffset != null && (
                  <Button
                    variant="ghost"
                    onClick={() => setOffset(Number(skus.data!.data.nextOffset))}
                  >
                    更多规格
                  </Button>
                )}
              </QueryState>
            )}
          </>
        )}
        <div className="desk-order-actions">
          <PlatformActionButton
            key={product.productRef}
            ctx={ctx}
            operation="send-product-card"
            input={{ productRef: product.productRef }}
            title="发送商品卡片"
            disabled={!product.productRef}
          />
          <PlatformActionButton
            ctx={ctx}
            operation="invite-order"
            input={{ productRef: product.productRef }}
            title="邀请下单"
            disabled={!product.productRef}
          />
        </div>
        <p className="desk-muted">价格和库存为查询时的平台信息，以实际结算为准。</p>
      </div>
    </Modal>
  );
}
function Orders({ ctx }: { ctx: WorkbenchContext }) {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Record<string, any> | null>(null);
  const q = useWorkbenchQuery(ctx, 'buyer-orders', {
    page,
    pageSize: 10,
    ...(['douyin', 'kuaishou'].includes(ctx.platform) ? { keyword } : {}),
  });
  const list = rows(q.data?.data.orders);
  if (!ctx.operations.includes('buyer-orders'))
    return <Empty icon={<ShoppingBag size={26} />}>此账号尚未提供订单查询。</Empty>;
  return (
    <>
      <h4>{ctx.platform === 'goofish' ? '当前会话关联订单' : '当前客户订单'}</h4>
      {['douyin', 'kuaishou'].includes(ctx.platform) && (
        <PlatformSearch
          placeholder={
            ctx.platform === 'kuaishou' ? '按商品名称搜索当前客户订单' : '搜索当前客户订单'
          }
          onSearch={(v) => {
            setKeyword(v);
            setPage(1);
          }}
        />
      )}
      <QueryState
        query={q}
        empty={!list.length}
        emptyContent={<p className="desk-muted">当前查询范围内暂无订单。</p>}
      >
        {list.map((o) => (
          <button className="desk-order" key={o.orderRef} onClick={() => setSelected(o)}>
            <div>
              <Badge>{o.statusText || o.status || '平台未提供状态'}</Badge>
              <span>{o.amountText || ''}</span>
            </div>
            <strong>{o.productTitle || object(o.goods).title || '订单商品'}</strong>
            <small>{o.orderSn}</small>
            <span>
              查看订单与可用操作 <ChevronRight size={12} />
            </span>
          </button>
        ))}
      </QueryState>
      <Pager
        page={page}
        setPage={setPage}
        more={morePages(q.data?.data)}
        count={list.length}
        fetching={q.isFetching}
      />
      {selected && <OrderDetail ctx={ctx} order={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
function OrderDetail({
  ctx,
  order,
  onClose,
}: {
  ctx: WorkbenchContext;
  order: Record<string, any>;
  onClose: () => void;
}) {
  const [action, setAction] = useState<'order-remark' | 'ship-order' | null>(null);
  const [logistics, setLogistics] = useState(false);
  const detail = useWorkbenchQuery(ctx, 'order-detail', { orderRef: order.orderRef });
  const ship = useWorkbenchQuery(ctx, 'order-logistics', { orderRef: order.orderRef }, logistics);
  const current = object(detail.data?.data.order ?? order);
  const content = (
    <>
      <div className="desk-order-head">
        {object(current.goods).imageUrl && (
          <Photo src={object(current.goods).imageUrl} title={current.productTitle || '订单商品'} />
        )}
        <strong>{order.productTitle || object(order.goods).title || '订单信息'}</strong>
        <Badge>{current.statusText || order.status || '平台未提供状态'}</Badge>
      </div>
      <dl className="desk-fields">
        <dt>订单编号</dt>
        <dd>{order.orderSn}</dd>
        <dt>买家</dt>
        <dd>{ctx.buyerName}</dd>
        {current.amountText && (
          <>
            <dt>实付金额</dt>
            <dd>{current.amountText}</dd>
          </>
        )}
        {(order.remark || object(order.goods).spec) && (
          <>
            <dt>{order.remark ? '订单备注' : '规格'}</dt>
            <dd>{order.remark || object(order.goods).spec}</dd>
          </>
        )}
        {rows(current.details).map((r, i) => (
          <div key={i}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="订单详情"
      description={`${ctx.storeName} · ${ctx.accountName}`}
    >
      <div className="desk-detail">
        {ctx.operations.includes('order-detail') ? (
          <QueryState query={detail}>{content}</QueryState>
        ) : (
          content
        )}
        {ctx.operations.includes('order-logistics') && (
          <>
            <Button variant="secondary" onClick={() => setLogistics(!logistics)}>
              物流与交付记录
            </Button>
            {logistics && (
              <QueryState query={ship} empty={!rows(ship.data?.data.records).length}>
                <dl className="desk-fields">
                  {rows(ship.data?.data.records).map((r, i) => (
                    <div key={i}>
                      <dt>{r.label}</dt>
                      <dd>{r.value}</dd>
                    </div>
                  ))}
                </dl>
              </QueryState>
            )}
          </>
        )}
        {ctx.operations.includes('order-remark-state') && (
          <OrderRemark ctx={ctx} orderRef={order.orderRef} />
        )}
        <div className="desk-order-actions">
          <PlatformActionButton
            ctx={ctx}
            operation="invite-review"
            input={{ orderRef: order.orderRef }}
            title="邀请评价"
            description="向当前客户发送该订单的评价邀请。请先确认订单适合评价，避免重复邀请。"
          />
          {ctx.operations.includes('order-remark') && (
            <Button variant="secondary" onClick={() => setAction('order-remark')}>
              追加订单备注
            </Button>
          )}
          {ctx.operations.includes('ship-order') && current.canShipWithoutLogistics === true && (
            <Button onClick={() => setAction('ship-order')}>无需物流发货</Button>
          )}
        </div>
        <p className="desk-muted">更多售后操作可在原平台处理。</p>
      </div>
      {action && (
        <ActionDialog
          ctx={ctx}
          order={order}
          operation={action}
          onClose={() => {
            setAction(null);
            void client.invalidateQueries({
              queryKey: ['workbench.query', ctx.sessionId, 'buyer-orders'],
            });
            if (ctx.operations.includes('order-detail')) void detail.refetch();
          }}
        />
      )}
    </Modal>
  );
}
function ActionDialog({
  ctx,
  order,
  operation,
  onClose,
}: {
  ctx: WorkbenchContext;
  order: Record<string, any>;
  operation: 'order-remark' | 'ship-order';
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [delivered, setDelivered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; message: string } | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const title = operation === 'ship-order' ? '无需物流发货' : '追加订单备注';
  const submit = async () => {
    setBusy(true);
    try {
      const result = await api('workbench.action', {
        sessionId: ctx.sessionId,
        requestId,
        operation,
        input: {
          orderRef: order.orderRef,
          note,
          ...(operation === 'ship-order' ? { deliveryMode: 'no_logistics', delivered } : {}),
        },
      });
      await invalidateLocalData();
      setResult(result);
    } catch (e) {
      setResult({
        status: 'unknown',
        message: e instanceof Error ? e.message : '操作结果未确认，请查看处理记录或原平台',
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(v) => !v && !busy && onClose()}
      title={title}
      description={`${ctx.storeName} · ${ctx.buyerName} · ${order.orderSn}`}
    >
      <p className="desk-muted">此操作不会暂停 AI。如需暂停，请先接管会话，处理完成后再交还 AI。</p>
      <Field
        label={operation === 'ship-order' ? '交付说明' : '追加备注'}
        hint={
          operation === 'order-remark'
            ? '自动保留平台已有备注与标签。'
            : '仅适用于已经真实交付的无需物流订单。'
        }
      >
        <textarea
          aria-label="操作说明"
          rows={3}
          maxLength={300}
          value={note}
          disabled={busy || !!result}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {operation === 'ship-order' && (
        <label className="desk-checkbox">
          <input
            type="checkbox"
            checked={delivered}
            disabled={busy || !!result}
            onChange={(e) => setDelivered(e.target.checked)}
          />
          我已完成真实交付，确认将此订单标为无需物流发货
        </label>
      )}
      {result && (
        <div
          role="status"
          className={result.status === 'confirmed' ? 'desk-success' : 'desk-warning'}
        >
          {result.message}
        </div>
      )}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {result ? '关闭' : '取消'}
        </Button>
        {!result && (
          <Button
            disabled={busy || !note.trim() || (operation === 'ship-order' && !delivered)}
            onClick={() => void submit()}
          >
            {busy ? '正在提交…' : `确认${title}`}
          </Button>
        )}
      </div>
    </Modal>
  );
}
function Transfer({ ctx, onClose }: { ctx: WorkbenchContext; onClose: () => void }) {
  const q = useWorkbenchQuery(
    { ...ctx, operations: [...ctx.operations, 'staff-list'] },
    'staff-list',
  );
  const [staffRef, setStaff] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const staff = rows(q.data?.data.staff);
  const selectedStaff = staff.find((s) => s.staffRef === staffRef);
  return (
    <Modal
      open
      onOpenChange={(v) => !v && !busy && onClose()}
      title="转接平台客服"
      description={`${ctx.storeName} · ${ctx.buyerName}`}
    >
      <p className="desk-muted">当前接待账号：{ctx.accountName}（已从转接目标中排除）</p>
      <QueryState
        query={q}
        empty={!staff.length}
        refreshLabel="刷新客服列表"
        refreshDisabled={busy || !!result}
        emptyContent={
          <div>
            <p role="status">暂无其他可转接客服</p>
            <p className="desk-muted">
              平台当前未返回其他可转接目标。请确认其他客服已上线，并具有接待和转接权限后刷新。
              {ctx.platform === 'douyin' &&
                '若飞鸽启用了分组分流，请同时在「客服管理 → 分流排队 → 规则设置」核对客服分组。'}
            </p>
          </div>
        }
      >
        <Field label="目标客服">
          <select
            aria-label="目标客服"
            disabled={busy || !!result || q.isFetching}
            value={selectedStaff ? staffRef : ''}
            onChange={(e) => setStaff(e.target.value)}
          >
            <option value="">选择平台可转接客服</option>
            {staff.map((s) => (
              <option value={s.staffRef} key={s.id}>
                {s.name}
                {s.statusText ? ` · ${s.statusText}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </QueryState>
      <Field
        label="交接说明"
        hint={ctx.platform === 'douyin' ? '说明保存在本地处理记录中。' : '说明会随转接提交到平台。'}
      >
        <textarea
          aria-label="交接说明"
          rows={3}
          maxLength={300}
          value={note}
          disabled={busy || !!result}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <p className="desk-muted">转接后本机 AI 暂停此会话。平台未返回明确回执时，请在原平台核对。</p>
      {result && (
        <p
          role="status"
          className={result.status === 'confirmed' ? 'desk-success' : 'desk-warning'}
        >
          {result.message}
        </p>
      )}
      <div className="modal-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void api('accounts.connect', { accountId: ctx.accountId }).catch((e) =>
              useUi.getState().notify(e.message),
            )
          }
        >
          打开原平台
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {result ? '关闭' : '取消'}
        </Button>
        {!result && (
          <Button
            disabled={busy || !selectedStaff || q.isFetching || !!q.error}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(
                  await api('workbench.action', {
                    sessionId: ctx.sessionId,
                    requestId,
                    operation: 'transfer-conversation',
                    input: { staffRef, note },
                  }),
                );
              } catch (e) {
                setResult({
                  status: 'unknown',
                  message: e instanceof Error ? e.message : '转接未确认',
                });
              } finally {
                setBusy(false);
                await invalidateLocalData();
              }
            }}
          >
            {busy ? '正在转接…' : '确认转接'}
          </Button>
        )}
      </div>
    </Modal>
  );
}
function Records({ conversationId }: { conversationId: string }) {
  const q = useData<any[]>('workbench.records', { conversationId });
  const [review, setReview] = useState<any>(null);
  const status: Record<string, string> = {
    prepared: '准备提交',
    dispatched: '已提交',
    confirmed: '已完成',
    rejected: '已拒绝',
    unknown: '待核对',
  };
  return (
    <>
      <div className="desk-section-heading">
        <h4>业务处理记录</h4>
        <Button
          variant="ghost"
          onClick={() =>
            void api('workbench.export', { conversationId })
              .then((r: any) => r.exported && useUi.getState().notify('操作记录已导出'))
              .catch((e) => useUi.getState().notify(e.message))
          }
        >
          导出
        </Button>
      </div>
      <p className="desk-muted">
        显示本会话最近 100 笔人工与 AI 的平台操作；导出包含本会话全部记录。
      </p>
      {q.error ? (
        <p role="alert" className="desk-error">
          {q.error.message}
        </p>
      ) : !q.data ? (
        <p>正在读取…</p>
      ) : q.data.length ? (
        q.data.map((r) => (
          <article className="desk-record" key={r.id}>
            <div>
              <strong>{r.name}</strong>
              <Badge tone={r.status === 'confirmed' ? 'green' : 'orange'}>
                {status[r.status] || r.status}
              </Badge>
            </div>
            <small>
              {r.origin} · {date(r.createdAt)}
            </small>
            <small>目标：{r.targetId}</small>
            {r.note && <p>{r.note}</p>}
            <p>{r.message}</p>
            {r.reviewedAt ? (
              <p className="desk-muted">已人工核对：{r.reviewNote}</p>
            ) : (
              (r.status === 'unknown' ||
                (r.operation === 'transfer-conversation' && r.status === 'confirmed')) && (
                <Button variant="secondary" onClick={() => setReview(r)}>
                  已在原平台核对
                </Button>
              )
            )}
          </article>
        ))
      ) : (
        <Empty icon={<ClipboardList size={24} />}>此会话还没有业务操作。</Empty>
      )}
      {review && <ReviewAction action={review} onClose={() => setReview(null)} />}
    </>
  );
}

function ReviewAction({ action, onClose }: { action: any; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      open
      title="记录平台核对结果"
      description={action.name}
      onOpenChange={(v) => !v && !busy && onClose()}
    >
      <p className="desk-muted">
        请先在原平台确认操作结果；如涉及转接，还需确认当前账号仍可接待此客户。保存核对记录后，可以手动交还
        AI。此操作不会更改平台状态或把未知回执改为成功。
      </p>
      <Field label="核对结果">
        <textarea
          aria-label="核对结果"
          maxLength={300}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </Field>
      {error && (
        <p role="alert" className="desk-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={busy || !note.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api('workbench.review', { actionId: action.id, note });
              await client.invalidateQueries({ queryKey: ['workbench.records'] });
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          保存核对记录
        </Button>
      </div>
    </Modal>
  );
}
