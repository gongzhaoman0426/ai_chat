import { useState, type ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';
import type { WorkbenchContext } from '../../../../../../packages/contracts/src/workbench';
import { richContentSchema } from '../../../../../../packages/contracts/src/commerce-extra';
import { api, invalidateLocalData, useUi } from '../../api';
import { Button, Field, Modal } from '../ui';
import { rows, useWorkbenchQuery } from './workbench-data';

export function RichMessage({
  value,
  fallback = '请在原平台查看此消息',
}: {
  value: unknown;
  fallback?: string;
}) {
  const parsed = richContentSchema.safeParse(value);
  if (!parsed.success) return <span>{fallback}</span>;
  const v = parsed.data;
  return (
    <div className="desk-rich-message">
      {v.kind === 'video' ? (
        v.url ? (
          <video controls preload="none" poster={v.coverUrl} src={v.url} />
        ) : (
          <>
            {v.coverUrl && <img src={v.coverUrl} alt="视频封面" referrerPolicy="no-referrer" />}
            <small>平台未提供播放地址，可在原平台观看</small>
          </>
        )
      ) : v.kind === 'product_card' ? (
        v.imageUrl && <img src={v.imageUrl} alt={v.title} referrerPolicy="no-referrer" />
      ) : null}
      <strong>{v.title}</strong>
      {v.kind === 'product_card' && <small>商品编号 {v.goodsId}</small>}
      {v.kind === 'review_card' && <small>订单 {v.orderSn}</small>}
    </div>
  );
}
export function PlatformSearch({
  placeholder,
  onSearch,
}: {
  placeholder: string;
  onSearch: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      className="desk-search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(value.trim());
      }}
    >
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        maxLength={100}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button variant="secondary" type="submit">
        搜索
      </Button>
    </form>
  );
}
function QueryView({
  q,
  empty,
  emptyText = '当前查询范围内暂无资料。',
  children,
}: {
  q: ReturnType<typeof useWorkbenchQuery>;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  if (q.isPending) return <p className="desk-muted">正在读取平台资料…</p>;
  if (q.error)
    return (
      <p className="desk-error">
        {q.error.message}
        <Button variant="ghost" onClick={() => void q.refetch()}>
          重试查询
        </Button>
      </p>
    );
  return (
    <>
      {q.data?.partial && <p className="desk-warning">平台只返回了部分资料</p>}
      {empty ? <p className="desk-muted">{emptyText}</p> : children}
    </>
  );
}
function Pages({
  page,
  setPage,
  q,
  count,
}: {
  page: number;
  setPage: (n: number) => void;
  q: ReturnType<typeof useWorkbenchQuery>;
  count: number;
}) {
  return (
    <div className="desk-pager">
      <Button
        variant="ghost"
        disabled={page === 1 || q.isFetching}
        onClick={() => setPage(page - 1)}
      >
        上一页
      </Button>
      <span>第 {page} 页</span>
      <Button
        variant="ghost"
        disabled={page >= 100 || q.isFetching || !count || q.data?.data.hasMore === false}
        onClick={() => setPage(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
export function PlatformActionButton({
  ctx,
  operation,
  input,
  title,
  description,
  disabled,
}: {
  ctx: WorkbenchContext;
  operation: string;
  input: Record<string, unknown>;
  title: string;
  description?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<any>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  if (!ctx.operations.includes(operation)) return null;
  const send = operation.startsWith('send-');
  const perform = async () => {
    setBusy(true);
    try {
      const result: any = await api('workbench.action', {
        sessionId: ctx.sessionId,
        requestId,
        operation,
        input,
      });
      setResult(result);
      if (send) useUi.getState().notify(result.message);
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作结果待确认';
      setResult({ status: 'unknown', message });
      if (send) useUi.getState().notify(message);
    } finally {
      setBusy(false);
      await invalidateLocalData();
    }
  };
  return (
    <>
      <Button
        variant="secondary"
        disabled={disabled || busy || !!result}
        onClick={() => (send ? void perform() : setOpen(true))}
      >
        {busy
          ? '处理中…'
          : result && send
            ? result.status === 'queued'
              ? '发送中'
              : result.status === 'confirmed'
                ? '已发送'
                : '查看聊天中的发送状态'
            : title}
      </Button>
      {open && (
        <Modal
          open
          onOpenChange={(v) => !busy && setOpen(v)}
          title={title}
          description={`${ctx.storeName} · ${ctx.buyerName}`}
        >
          <p>{description ?? `确认对当前客户执行“${title}”？`}</p>
          <p className="desk-muted">
            {operation === 'transfer-group'
              ? '确认转接后本机 AI 暂停此会话。结果会保存在处理记录中。'
              : operation === 'invite-review'
                ? '发送不会暂停 AI，可在聊天中查看发送状态。如需暂停，请接管会话。'
                : '此操作不会暂停 AI，结果会保存在处理记录中。如需暂停，请接管会话。'}
          </p>
          {result && (
            <p
              role="status"
              className={result.status === 'confirmed' ? 'desk-success' : 'desk-warning'}
            >
              {result.message}
            </p>
          )}
          <div className="modal-actions">
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              {result ? '关闭' : '取消'}
            </Button>
            {!result && (
              <Button disabled={busy} onClick={() => void perform()}>
                {busy ? '处理中…' : `确认${title}`}
              </Button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
export function VideoMaterials({ ctx }: { ctx: WorkbenchContext }) {
  const [page, setPage] = useState(1),
    [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const folder = path.at(-1)?.id;
  const q = useWorkbenchQuery(ctx, 'video-materials', {
    page,
    pageSize: 10,
    ...(folder ? { folderId: folder } : {}),
  });
  const materials = rows(q.data?.data.materials),
    folders = rows(q.data?.data.folders);
  return (
    <>
      <div className="desk-section-heading">
        <h4>店铺视频素材</h4>
        <Button variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
          刷新
        </Button>
      </div>
      <p className="desk-muted">选择店铺已有视频发送给当前客户；可预览的信息以平台返回为准。</p>
      {ctx.platform === 'douyin' && (
        <nav className="desk-material-path" aria-label="视频素材目录">
          <Button
            variant="ghost"
            aria-current={!path.length ? 'page' : undefined}
            onClick={() => {
              setPath([]);
              setPage(1);
            }}
          >
            全部视频
          </Button>
          {path.map((item, index) => (
            <Button
              key={item.id}
              variant="ghost"
              aria-current={index === path.length - 1 ? 'page' : undefined}
              onClick={() => {
                setPath(path.slice(0, index + 1));
                setPage(1);
              }}
            >
              / {item.name}
            </Button>
          ))}
        </nav>
      )}
      <QueryView
        q={q}
        empty={!materials.length && !folders.length}
        emptyText={
          page > 1
            ? '当前页暂无视频素材。'
            : ctx.platform === 'pinduoduo'
              ? '店铺暂无审核通过的视频素材，请先在拼多多商家后台添加视频。'
              : path.length
                ? '当前文件夹暂无视频。'
                : '店铺暂无视频素材，请先在飞鸽素材中心添加视频。'
        }
      >
        {folders.map((item) => (
          <Button
            key={item.id}
            variant="secondary"
            className="desk-material-folder"
            onClick={() => {
              setPath([...path, { id: item.id, name: item.name }]);
              setPage(1);
            }}
          >
            <FolderOpen size={16} aria-hidden="true" /> {item.name}
          </Button>
        ))}
        {materials.map((v) => (
          <div className="desk-material" key={v.materialRef}>
            <RichMessage
              value={{
                kind: 'video',
                materialId: v.materialId,
                title: v.title,
                url: v.url,
                videoId: v.videoId,
                coverUrl: v.coverUrl,
                width: v.width,
                height: v.height,
                duration: v.duration,
              }}
            />
            {v.sendable ? (
              <PlatformActionButton
                ctx={ctx}
                operation="send-video"
                input={{ materialRef: v.materialRef }}
                title="发送给客户"
              />
            ) : (
              <p className="desk-muted">
                {v.unavailableReason || '平台未提供完整的可发送信息，请在原平台发送。'}
              </p>
            )}
          </div>
        ))}
      </QueryView>
      <Pages page={page} setPage={setPage} q={q} count={materials.length + folders.length} />
    </>
  );
}
export function OrderRemark({ ctx, orderRef }: { ctx: WorkbenchContext; orderRef: string }) {
  const q = useWorkbenchQuery(ctx, 'order-remark-state', { orderRef });
  return (
    <section className="desk-remark">
      <div className="desk-section-heading">
        <h4>平台订单备注</h4>
        <Button variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>
          刷新备注
        </Button>
      </div>
      <QueryView q={q}>
        <p className="desk-preserve">{String(q.data?.data.remark || '暂无备注')}</p>
        <small>
          {ctx.platform === 'douyin' ? '星标' : '标签'}：
          {String(q.data?.data.tagName ?? '平台未提供')}
        </small>
      </QueryView>
    </section>
  );
}
export function GroupTransfer({ ctx }: { ctx: WorkbenchContext }) {
  const [open, setOpen] = useState(false),
    [groupRef, setGroup] = useState('');
  const q = useWorkbenchQuery(ctx, 'staff-groups', {}, open);
  const stats = useWorkbenchQuery(ctx, 'staff-statistics', { page: 1, pageSize: 20 }, open);
  const groups = rows(q.data?.data.groups),
    selected = groups.find((g) => g.groupRef === groupRef);
  if (!ctx.operations.includes('transfer-group')) return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        转接客服组
      </Button>
      {open && (
        <Modal
          open
          onOpenChange={setOpen}
          title="转接客服组"
          description={`${ctx.storeName} · ${ctx.buyerName}`}
        >
          <QueryView q={q} empty={!groups.length}>
            <Field label="接待分组">
              <select value={groupRef} onChange={(e) => setGroup(e.target.value)}>
                <option value="">选择客服组</option>
                {groups.map((g) => (
                  <option key={g.groupRef} value={g.groupRef}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
          </QueryView>
          <details>
            <summary>平台客服状态</summary>
            <QueryView q={stats} empty={!rows(stats.data?.data.staff).length}>
              {rows(stats.data?.data.staff).map((s, i) => (
                <p key={s.id ?? i}>
                  {s.name || '客服'} · {s.statusText || '平台未提供状态'}
                  {s.activeCount != null && ` · 接待中 ${s.activeCount}`}
                </p>
              ))}
            </QueryView>
          </details>
          <p className="desk-muted">
            转接后本机 AI 暂停此会话。平台不保证分组内具体由哪位客服接待。
          </p>
          {selected && (
            <PlatformActionButton
              key={groupRef}
              ctx={ctx}
              operation="transfer-group"
              input={{ groupRef, note: '' }}
              title="转接客服组"
              description={`将当前客户转接至“${selected.name}”。`}
            />
          )}
        </Modal>
      )}
    </>
  );
}
