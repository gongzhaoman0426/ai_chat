import {
  sameKnowledgeIntent,
  conditionalKnowledge,
} from '../../../../packages/contracts/src/knowledge-rules';
import { platformNames, type PlatformId } from '../../../../packages/contracts/src/platform';
import { useEffect, useRef, useState } from 'react';
import { StoreScope } from './components/store-scope';
import { Attachment } from './pages-inbox';
import {
  BookOpen,
  Plus,
  Upload,
  Download,
  Search,
  Image as ImageIcon,
  Pencil,
  Check,
  ShieldCheck,
  Sparkles,
  ArrowUpRight,
  XCircle,
  FileText,
  Trash2,
} from 'lucide-react';
import { useData, useUi, perform, date, statusText } from './api';
import { Button, Badge, Empty, Field, Modal, Toggle } from './components/ui';
import { StoreProductField, productLabel } from './components/store-product-field';
import { KnowledgeChat } from './components/knowledge-chat';
import { KnowledgeAnswer } from './components/knowledge-answer';
import { KnowledgeBootstrap } from './components/knowledge-bootstrap';
const blank = () => ({
  intent: '',
  answerKind: 'text',
  answer: '',
  answerBefore: '',
  answerAfter: '',
  scope: { productIds: [], conditions: '' },
  attachmentId: undefined as string | undefined,
  validUntil: null as string | null,
});
export function QaFields({
  qa,
  setQa,
  storeId,
  entryId,
}: {
  qa: any;
  setQa: (v: any) => void;
  storeId: string | null;
  entryId?: string;
}) {
  const [imageName, setImageName] = useState('');
  const { data: rules = [] } = useData<any[]>('knowledge.list', { storeId });
  const common = rules.filter((r) => r.storeId === null && r.id !== entryId);
  const related = rules.filter(
    (r) =>
      r.id !== entryId &&
      (sameKnowledgeIntent(r.revisions[0]?.intent || '', qa.intent) ||
        r.id === qa.scope?.overridesEntryId),
  );
  const active = useRef(true);
  const latestQa = useRef(qa);
  latestQa.current = qa;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <div className="form-grid">
      <Field label="买家意图 / 常见问法">
        <textarea
          rows={2}
          value={qa.intent}
          placeholder="例如：这款商品多久可以发货？"
          onChange={(e) => setQa({ ...qa, intent: e.target.value })}
        />
      </Field>
      {storeId !== null && (
        <Field
          label="覆盖通用问答（可选）"
          hint="本店回答不同但问法不同名时，可在此指定覆盖。相同意图的本店规则自动优先；商品和条件仍需核对。"
        >
          <select
            aria-label="覆盖通用问答"
            value={qa.scope?.overridesEntryId || ''}
            onChange={(e) =>
              setQa({
                ...qa,
                scope: { ...qa.scope, overridesEntryId: e.target.value || undefined },
              })
            }
          >
            <option value="">不指定覆盖 · 相同意图按店铺优先</option>
            {qa.scope?.overridesEntryId &&
              !common.some((r) => r.id === qa.scope.overridesEntryId) && (
                <option value={qa.scope.overridesEntryId}>原通用问答不可用，请重新选择</option>
              )}
            {common.map((r) => (
              <option value={r.id} key={r.id}>
                {r.revisions[0]?.intent}
                {r.status === 'disabled' ? '（已停用）' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!!related.length && (
        <div className="knowledge-rule-notice" role="status">
          <strong>相关规则与生效顺序</strong>
          <p>
            {conditionalKnowledge(qa)
              ? '当前问答有限定条件；AI 需核对商品或条件后使用，存在这些规则时不会直接套用通用答案。'
              : storeId
                ? '本店规则覆盖下列同意图或已指定的通用答案。若本店存在多个不同答案，将暂停直答，由 Agent 核对。'
                : '同一意图存在多个答案时将暂停直答。各店的专属规则仍优先于通用规则。'}
          </p>
          {related.map((r) => (
            <div key={r.id} className="knowledge-rule-row">
              <Badge>
                {r.storeId === null ? '通用' : '本店'} · {r.status === 'enabled' ? '启用' : '停用'}
              </Badge>
              <strong>{r.revisions[0]?.intent}</strong>
              <KnowledgeAnswer qa={r.revisions[0]} />
            </div>
          ))}
        </div>
      )}
      <Field label="答案类型">
        <div className="segmented">
          {[
            ['text', '文字回答'],
            ['image', '图片回答'],
          ].map(([v, l]) => (
            <button
              key={v}
              className={qa.answerKind === v ? 'active' : ''}
              onClick={() => setQa({ ...qa, answerKind: v })}
            >
              {v === 'text' ? <FileText size={15} /> : <ImageIcon size={15} />} {l}
            </button>
          ))}
        </div>
      </Field>
      {qa.answerKind === 'text' ? (
        <Field label="答案原文" hint="高阈值命中时会原样发送这段文字。">
          <textarea
            rows={5}
            value={qa.answer}
            placeholder="填写经过确认的标准回答…"
            onChange={(e) => setQa({ ...qa, answer: e.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field
            label="图片前文字（可选）"
            hint="有内容时先原样发送这段文字，再发送图片；留空只发送图片。"
          >
            <textarea
              rows={2}
              value={qa.answerBefore ?? ''}
              placeholder="例如：请参考下面的尺码表。"
              onChange={(e) => setQa({ ...qa, answerBefore: e.target.value })}
            />
          </Field>
          <Field label="答案图片" hint="支持 PNG、JPEG、WebP、GIF，单张不超过 8 MB。">
            <button
              className="upload-zone"
              onClick={async () => {
                const a = await perform('attachments.pick', { storeId });
                if (a && active.current && latestQa.current.answerKind === 'image') {
                  setQa({ ...latestQa.current, attachmentId: a.id });
                  setImageName(a.name);
                }
              }}
            >
              <ImageIcon size={26} />
              {qa.attachmentId && <Attachment id={qa.attachmentId} />}
              <span>
                {imageName || (qa.attachmentId ? '已选图片 · 点击替换' : '点击选择本地图片')}
              </span>
            </button>
          </Field>
          <Field label="图片后文字（可选）" hint="图片发送成功后原样发送这段文字；留空不追加文字。">
            <textarea
              rows={2}
              value={qa.answerAfter ?? ''}
              placeholder="例如：介于两个尺码之间时，建议选择大一码。"
              onChange={(e) => setQa({ ...qa, answerAfter: e.target.value })}
            />
          </Field>
          {qa.attachmentId && (
            <div className="qa-answer-preview">
              <small>发送顺序预览</small>
              <KnowledgeAnswer qa={qa} />
            </div>
          )}
        </>
      )}
      <StoreProductField
        storeId={storeId}
        selected={qa.scope?.productIds || []}
        onChange={(productIds) => setQa({ ...qa, scope: { ...qa.scope, productIds } })}
      />
      <Field label="有效期（可选）">
        <input
          type="date"
          value={qa.validUntil?.slice(0, 10) || ''}
          onChange={(e) =>
            setQa({
              ...qa,
              validUntil: e.target.value
                ? new Date(e.target.value + 'T23:59:59').toISOString()
                : null,
            })
          }
        />
      </Field>
      <Field
        label="使用这条回答的前提（可选）"
        hint="没有额外限制就留空。例如“仅限非预售商品”；填写后，AI 会先核对条件再使用这条回答。"
      >
        <input
          value={qa.scope?.conditions || ''}
          placeholder="没有限制可留空，如：仅限非预售商品"
          onChange={(e) => setQa({ ...qa, scope: { ...qa.scope, conditions: e.target.value } })}
        />
      </Field>
    </div>
  );
}
export function Knowledge({ store }: { store: any }) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<any>(null);
  const [targetStoreId, setTargetStoreId] = useState(store?.id || '');
  const [library, setLibrary] = useState<'all' | 'available' | 'owned' | 'global'>('all');
  const { data: stores = [], isSuccess: storesLoaded } = useData<any[]>('stores.list');
  const storeLabel = (id: string | null) => {
    if (id === null) return '通用';
    const name = stores.find((s) => s.id === id)?.name;
    if (name) return `${name}专属`;
    return id === store?.id ? '本店专属' : '店铺专属';
  };
  const [qa, setQa] = useState<any>(blank());
  const [preview, setPreview] = useState<any>(null);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const exportScope = library === 'all' ? 'all' : library === 'available' ? 'available' : 'owned';
  const {
    data: rows = [],
    error: listError,
    isPending: listLoading,
    refetch: reloadList,
  } = useData<any[]>('knowledge.list', {
    storeId: library === 'global' ? null : (store?.id ?? null),
    search,
    scope: exportScope,
  });
  useEffect(() => {
    if (
      editing &&
      targetStoreId &&
      targetStoreId !== '__removed__' &&
      storesLoaded &&
      !stores.some((s) => s.id === targetStoreId)
    ) {
      setTargetStoreId('__removed__');
      setQa((current: any) => ({
        ...current,
        attachmentId: undefined,
        scope: { ...current.scope, productIds: [], overridesEntryId: undefined },
      }));
      useUi.getState().notify('所选店铺已移除，请重新选择所属店铺');
    }
  }, [editing, targetStoreId, stores, storesLoaded]);
  const edit = (entry?: any) => {
    setEditing(entry || { new: true });
    setTargetStoreId(
      entry
        ? (entry.storeId ?? '')
        : library === 'global' || library === 'all'
          ? ''
          : store?.id || '',
    );
    const r = entry?.revisions[0];
    setQa(
      r
        ? {
            intent: r.intent,
            answerKind: r.answerKind,
            answer: r.answer,
            answerBefore: r.answerBefore ?? '',
            answerAfter: r.answerAfter ?? '',
            attachmentId: r.attachmentId || undefined,
            scope: r.scope,
            validUntil: r.validUntil,
          }
        : blank(),
    );
  };
  const save = async () => {
    if (busy || (targetStoreId && !stores.some((s) => s.id === targetStoreId))) return;
    const savedStoreId = targetStoreId;
    setBusy(true);
    const r = await perform(
      'knowledge.save',
      {
        storeId: savedStoreId || null,
        ...(!editing.new
          ? {
              entryId: editing.id,
              expectedRevisionId: editing.activeRevisionId,
              expectedStoreId: editing.storeId,
            }
          : {}),
        qa,
      },
      '问答已保存，索引将在后台更新',
    );
    setBusy(false);
    if (r) {
      setEditing(null);
      setLibrary(savedStoreId ? 'available' : 'global');
      if (savedStoreId) useUi.getState().setStore(savedStoreId);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>问答库</h1>
          <p>维护客服可直接使用的标准回答。通用问答适用所有店铺，专属问答只在所属店铺使用。</p>
        </div>
        <div className="actions">
          <Button
            variant="secondary"
            title={
              library === 'all'
                ? '导出全部店铺与通用问答'
                : library === 'available'
                  ? '导出本店与通用问答'
                  : library === 'global' || !store
                    ? '导出通用问答'
                    : '导出当前店铺专属问答'
            }
            onClick={async () => {
              const r = await perform('knowledge.export', {
                storeId: library === 'global' ? null : (store?.id ?? null),
                scope: exportScope,
              });
              if (r) useUi.getState().notify(`已导出 ${r.count} 条问答`);
            }}
          >
            <Download size={15} />
            导出
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              setImportTarget(
                library === 'owned' || library === 'available' ? (store?.id ?? '') : '',
              )
            }
          >
            <Upload size={15} />
            导入问答
          </Button>
          <Button onClick={() => edit()}>
            <Plus size={16} />
            新建问答
          </Button>
        </div>
      </div>
      <div className="page-body page-body-fill knowledge-layout">
        <div className="knowledge-main">
          <div className="knowledge-toolbar">
            <label className="scope-select-label">
              所属范围
              <select
                aria-label="问答所属范围"
                value={
                  library === 'global'
                    ? 'global'
                    : library === 'all'
                      ? library
                      : (store?.id ?? 'all')
                }
                onChange={(e) => {
                  const value = e.target.value;
                  if (['all', 'global'].includes(value)) setLibrary(value as typeof library);
                  else {
                    useUi.getState().setStore(value);
                    setLibrary('owned');
                  }
                }}
              >
                <option value="all">全部店铺与通用</option>
                <option value="global">通用问答</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {(library === 'owned' || library === 'available') && (
              <label className="include-common">
                <input
                  type="checkbox"
                  checked={library === 'available'}
                  onChange={(e) => setLibrary(e.target.checked ? 'available' : 'owned')}
                />
                同时查看通用问答
              </label>
            )}
            <div className="search">
              <Search size={16} />
              <input
                aria-label="搜索问答"
                placeholder="搜索问题或意图"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          {(library === 'owned' || library === 'available') && store?.id && (
            <KnowledgeBootstrap storeId={store.id} />
          )}
          <div className="collection-summary">
            <span>{rows.length} 条问答</span>
            <span>{rows.filter((r) => r.status === 'enabled').length} 条启用</span>
            <span>
              {rows.filter((r) => r.revisions[0]?.answerKind === 'image').length} 条图片回答
            </span>
          </div>
          <div className="card table-card knowledge-table">
            {listError ? (
              <Empty>
                <strong>问答读取失败</strong>
                <p>{listError.message}</p>
                <Button variant="ghost" onClick={() => reloadList()}>
                  重新加载
                </Button>
              </Empty>
            ) : listLoading ? (
              <p className="list-loading">正在读取问答…</p>
            ) : rows.length ? (
              <table>
                <thead>
                  <tr>
                    <th>意图与回答</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>更新于</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="qa-cell">
                        <strong>{r.revisions[0]?.intent}</strong>
                        <Badge>{storeLabel(r.storeId)}</Badge>
                        <div className="qa-answer-preview">
                          <KnowledgeAnswer qa={r.revisions[0]} />
                        </div>
                      </td>
                      <td>
                        <Badge>{r.revisions[0]?.answerKind === 'image' ? '图片' : '文字'}</Badge>
                      </td>
                      <td>
                        <Badge tone={r.status === 'enabled' ? 'green' : 'neutral'}>
                          {statusText[r.status]}
                        </Badge>
                      </td>
                      <td className="muted">{date(r.updatedAt)}</td>
                      <td>
                        <div className="row-actions">
                          <Button variant="ghost" title="编辑问答" onClick={() => edit(r)}>
                            <Pencil size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              perform('knowledge.status', {
                                id: r.id,
                                status: r.status === 'enabled' ? 'disabled' : 'enabled',
                                expectedRevisionId: r.activeRevisionId,
                              })
                            }
                          >
                            {r.status === 'enabled' ? '停用' : '启用'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={async () =>
                              setHistory(await perform('knowledge.history', { id: r.id }))
                            }
                          >
                            历史
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={`删除问答 ${r.revisions[0]?.intent || ''}`}
                            onClick={() => setDeleting(r)}
                          >
                            <Trash2 size={15} />
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty
                icon={<BookOpen size={32} />}
                action={
                  <Button onClick={() => edit()}>
                    <Plus size={16} />
                    创建第一条问答
                  </Button>
                }
              >
                <h3>从一个好回答开始</h3>
                <p>手工录入常见问题，或导入 JSON / 含图片的 ZIP 知识包。</p>
              </Empty>
            )}
          </div>
          <div className="info-line">
            <ShieldCheck size={16} />
            <span>
              人工维护的问答直接生效；自动学习产生的建议需要先审批。删除问答后不能恢复。接待只用通用
              + 当前会话店铺。
            </span>
          </div>
        </div>
        <KnowledgeChat
          storeId={library === 'owned' || library === 'available' ? (store?.id ?? null) : null}
          storeName={store?.name}
          scope={library === 'all' ? 'all' : library === 'global' ? 'owned' : 'available'}
        />
      </div>
      {deleting && (
        <Modal
          open
          onOpenChange={(v) => !v && !deleteBusy && setDeleting(null)}
          title="删除这条问答？"
          description="删除后将从问答库移除，无法恢复。历史聊天和已产生的引用记录仍会保留。"
        >
          <div className="qa-cell">
            <Badge>{storeLabel(deleting.storeId)}</Badge>
            <strong>{deleting.revisions[0]?.intent}</strong>
            <div className="qa-answer-preview">
              <KnowledgeAnswer qa={deleting.revisions[0]} />
            </div>
          </div>
          <div className="modal-actions">
            <Button variant="secondary" disabled={deleteBusy} onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={deleteBusy}
              onClick={async () => {
                setDeleteBusy(true);
                try {
                  if (
                    await perform(
                      'knowledge.delete',
                      {
                        id: deleting.id,
                        expectedRevisionId: deleting.activeRevisionId,
                      },
                      '问答已删除',
                    )
                  )
                    setDeleting(null);
                } finally {
                  setDeleteBusy(false);
                }
              }}
            >
              {deleteBusy ? '删除中…' : '确认删除'}
            </Button>
          </div>
        </Modal>
      )}
      <Modal
        open={!!editing}
        onOpenChange={(v) => !v && !busy && setEditing(null)}
        title={editing?.new ? '新建问答' : '编辑问答'}
        description="设置所属店铺和标准回答，保存后即可在接待中使用。"
        wide
      >
        <Field
          label="所属店铺"
          hint={
            editing?.new
              ? '不绑定即为通用问答，所有店铺均可使用。切换范围会清除已选图片和适用商品。'
              : '可以改为通用或指定店铺。保存后按新范围使用；切换范围会清除已选图片和适用商品。通用问答的修改影响所有店铺。'
          }
        >
          <select
            aria-label="所属店铺"
            value={targetStoreId}
            disabled={busy}
            onChange={(e) => {
              setTargetStoreId(e.target.value);
              setQa((current: any) => ({
                ...current,
                attachmentId: undefined,
                scope: { ...current.scope, productIds: [], overridesEntryId: undefined },
              }));
            }}
          >
            <option value="">不绑定店铺 · 通用问答</option>
            {targetStoreId === '__removed__' && (
              <option value="__removed__" disabled>
                原店铺已移除，请重新选择范围
              </option>
            )}
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {platformNames[s.platform as PlatformId] ?? s.platform}
              </option>
            ))}
          </select>
        </Field>
        {editing && (
          <QaFields
            key={`${editing.id || 'new'}:${targetStoreId}`}
            qa={qa}
            setQa={setQa}
            storeId={targetStoreId || null}
            entryId={editing.id}
          />
        )}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button
            disabled={busy || (!!targetStoreId && !stores.some((s) => s.id === targetStoreId))}
            onClick={save}
          >
            {busy ? '保存中…' : '保存并启用'}
          </Button>
        </div>
      </Modal>
      <Modal
        open={importTarget !== null}
        onOpenChange={(v) => !v && !busy && setImportTarget(null)}
        title="导入问答"
        description="先确认问答的所属范围，再选择文件预览。"
      >
        <Field label="导入到">
          <select
            aria-label="导入到"
            value={importTarget ?? ''}
            onChange={(e) => setImportTarget(e.target.value)}
            disabled={busy}
          >
            <option value="">通用问答 · 所有店铺可用</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}专属问答
              </option>
            ))}
          </select>
        </Field>
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={() => setImportTarget(null)}>
            取消
          </Button>
          <Button
            disabled={busy || (!!importTarget && !stores.some((s) => s.id === importTarget))}
            onClick={async () => {
              const target = importTarget || null;
              setBusy(true);
              const result = await perform('knowledge.importPreview', { storeId: target });
              setBusy(false);
              if (result) {
                setPreview({ ...result, targetLabel: storeLabel(target) });
                setImportTarget(null);
              }
            }}
          >
            {busy ? '正在读取…' : '选择文件并预览'}
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!preview}
        onOpenChange={(v) => !v && setPreview(null)}
        title="导入预览"
        description={`导入到：${preview?.targetLabel ?? ''}。错误或意图冲突行会跳过，其余行经确认后写入。`}
        wide
      >
        <div className="import-preview">
          {preview?.rows?.map((r: any) => (
            <div key={r.index} className="preview-row">
              <Badge tone={r.error ? 'red' : r.conflict ? 'orange' : 'green'}>
                第 {r.index + 1} 行
              </Badge>
              <span>{r.error || r.conflict || r.qa.intent}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setPreview(null)}>
            取消
          </Button>
          <Button
            onClick={async () => {
              const r = await perform(
                'knowledge.importApply',
                {
                  token: preview.token,
                  rows: preview.rows
                    .filter((r: any) => !r.error && !r.conflict)
                    .map((r: any) => r.index),
                },
                '有效问答已导入',
              );
              if (r) setPreview(null);
            }}
          >
            确认导入有效行
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!history}
        onOpenChange={(v) => !v && setHistory(null)}
        title="知识版本历史"
        wide
      >
        {history?.map((r: any) => (
          <div key={r.id} className="history-row">
            <Badge>v{r.version}</Badge>
            <strong>{r.intent}</strong>
            <KnowledgeAnswer qa={r} />
            <small>
              {date(r.createdAt)} · {r.sourceKind} · 人工生效
            </small>
          </div>
        ))}
      </Modal>
    </>
  );
}
export function Metric({
  label,
  value,
  description,
  icon,
}: {
  label: string;
  value: number | string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div>
        <span>{label}</span>
        <div className="metric-icon">{icon}</div>
      </div>
      <strong>{value}</strong>
      <small>{description}</small>
    </div>
  );
}
export function Learning({ store }: { store: any }) {
  const [filter, setFilter] = useState('pending_review');
  const [selected, setSelected] = useState<any>(null);
  const [qa, setQa] = useState<any>(blank());
  const [editing, setEditing] = useState(false);
  const [targetStoreId, setTargetStoreId] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: stores = [], isSuccess: storesLoaded } = useData<any[]>('stores.list');
  const resetDraft = (candidate: any) => {
    const approved = candidate.reviews?.find(
      (r: any) =>
        r.candidateVersion === candidate.candidateVersion &&
        r.contentHash === candidate.contentHash,
    );
    setTargetStoreId(
      approved?.publicationScope ? (approved.publicationScope.storeId ?? '') : candidate.storeId,
    );
    setQa(candidate.content);
    setEditing(false);
  };
  const targetStoreValid = !targetStoreId || stores.some((s) => s.id === targetStoreId);
  const targetStoreName = targetStoreId
    ? (stores.find((s) => s.id === targetStoreId)?.name ?? '原店铺已移除')
    : '全部店铺';
  const {
    data: candidates = [],
    error: candidateError,
    isPending: candidatesLoading,
    refetch: reloadCandidates,
  } = useData<any[]>('learning.list', { storeId: store?.id, status: filter }, !!store);
  const { data: evaluations = [] } = useData<any[]>(
    'learning.evaluations',
    { storeId: store?.id },
    !!store,
  );
  const { data: reviewKnowledge = [] } = useData<any[]>(
    'knowledge.list',
    { storeId: targetStoreId || null },
    !!selected,
  );
  const { data: reviewGoods } = useData<{
    products: { goodsId: string; title?: string }[];
  }>(
    'stores.goods',
    { storeId: targetStoreId, page: 1, pageSize: 20 },
    !!targetStoreId && !!selected && targetStoreValid,
  );
  const reviewCatalog = Object.fromEntries(
    (reviewGoods?.products || []).map((item) => [item.goodsId, item]),
  );
  const review = async (decision: 'approved' | 'rejected') => {
    if (busy || !selected || (decision === 'approved' && (!storesLoaded || !targetStoreValid)))
      return;
    setBusy(true);
    try {
      const result = await perform('learning.review', {
        candidateId: selected.id,
        candidateVersion: selected.candidateVersion,
        contentHash: selected.contentHash,
        requestId: crypto.randomUUID(),
        decision,
        ...(decision === 'approved'
          ? { targetStoreId: targetStoreId || null, ...(editing ? { editedQa: qa } : {}) }
          : {}),
      });
      if (result) {
        useUi
          .getState()
          .notify(
            result.status === 'stale'
              ? '来源已变化，需要重新评估'
              : decision === 'approved'
                ? selected.action === 'disable_qa'
                  ? '已批准，原问答将在后台停用'
                  : `已批准，将发布到${targetStoreName}的问答库`
                : '已拒绝，正式知识保持不变',
          );
        setSelected(null);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>学习审核</h1>
          <p>
            {store
              ? `以下建议来自${store.name}的对话。默认用于本店，也可在审批时选择其他店铺或全部店铺。`
              : '选择店铺后查看该店学习建议。'}
          </p>
        </div>
        <div className="learning-switch">
          <StoreScope label="学习店铺" />
          <Toggle
            disabled={!store}
            label="自动学习"
            checked={!!store?.learningPolicy?.autoLearnEnabled}
            onChange={(v) => perform('stores.policy', { storeId: store.id, autoLearnEnabled: v })}
          />
        </div>
      </div>
      <div className="page-body">
        <div className="learning-queue-intro">
          <div>
            <ShieldCheck size={18} />
            <span>
              <strong>审核通过后，回答才会进入问答库</strong>
              <small>
                {store?.learningPolicy?.autoLearnEnabled
                  ? '自动学习已开启，有新的实际回答时生成建议。'
                  : '自动学习已关闭，已有建议仍可审核。'}
              </small>
            </span>
          </div>
          <button onClick={() => useUi.getState().openStoreSettings(store?.id, 3)}>
            学习设置
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="card table-card">
          <div className="card-toolbar">
            <div className="tabs">
              {[
                ['pending_review', '待审批'],
                ['approved', '已批准'],
                ['rejected', '已拒绝'],
                ['stale', '已过期'],
                ['all', '全部'],
              ].map(([v, l]) => (
                <button
                  className={filter === v ? 'active' : ''}
                  key={v}
                  onClick={() => setFilter(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          {!store ? (
            <Empty>
              <h3>先连接店铺</h3>
              <p>学习建议按店铺独立管理。</p>
              <Button variant="secondary" onClick={() => useUi.getState().setPage('stores')}>
                前往店铺管理
              </Button>
            </Empty>
          ) : candidateError ? (
            <Empty>
              <strong>建议读取失败</strong>
              <p>{candidateError.message}</p>
              <Button variant="ghost" onClick={() => reloadCandidates()}>
                重新加载
              </Button>
            </Empty>
          ) : candidatesLoading ? (
            <p className="list-loading">正在读取学习建议…</p>
          ) : candidates.length ? (
            <div className="candidate-list">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  className="candidate-row"
                  onClick={() => {
                    setSelected(c);
                    resetDraft(c);
                  }}
                >
                  <div className="candidate-icon">
                    <Sparkles size={19} />
                  </div>
                  <div>
                    <strong>{c.content.intent}</strong>
                    <KnowledgeAnswer qa={c.content} />
                    <small>
                      {date(c.createdAt)} ·{' '}
                      {c.action === 'create_qa'
                        ? '新增问答'
                        : c.action === 'disable_qa'
                          ? '停用建议'
                          : '修订建议'}
                    </small>
                  </div>
                  <Badge
                    tone={
                      c.status === 'pending_review'
                        ? 'orange'
                        : c.status === 'approved'
                          ? 'green'
                          : 'neutral'
                    }
                  >
                    {statusText[c.status]}
                  </Badge>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={<Sparkles size={32} />}>
              <h3>暂时没有{filter === 'pending_review' ? '待审批' : ''}建议</h3>
              <p>
                有新的 AI 回复或人工作答后，学习 Agent 会评估是否值得沉淀。问答库原文直答不再评估。
                <br />
                无需新增知识的回合只保存评估报告。
              </p>
            </Empty>
          )}
        </div>
        {evaluations.length > 0 && (
          <details className="card evaluations">
            <summary>最近评估记录 · {evaluations.length} 轮</summary>
            {evaluations.slice(0, 8).map((e) => (
              <div key={e.id}>
                <Badge>
                  {e.result.replyVerdict === 'reasonable'
                    ? '回答合理'
                    : e.result.replyVerdict === 'unreasonable'
                      ? '需改进'
                      : '待核实'}
                </Badge>
                <p>{e.result.reason}</p>
                <small>{date(e.createdAt)}</small>
              </div>
            ))}
          </details>
        )}
      </div>
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && !busy && setSelected(null)}
        title="审批学习建议"
        description="核对回答内容和适用店铺，批准后才会生效。"
        wide
      >
        {selected && (
          <>
            <div className="review-evidence">
              <Badge>原始依据</Badge>
              <p>{selected.evaluation.result.reason}</p>
              <div className="evidence-columns">
                <div>
                  <small>买家问题</small>
                  {selected.evaluation.inputSnapshot.questions?.map((m: any) => (
                    <p key={m.id}>{m.text}</p>
                  ))}
                </div>
                <div>
                  <small>实际回答</small>
                  {selected.evaluation.inputSnapshot.answers?.map((a: any) => (
                    <p key={a.id}>
                      {a.message?.text} <Badge>{statusText[a.origin]}</Badge>
                    </p>
                  ))}
                </div>
              </div>
            </div>
            <Field
              label="适用店铺"
              hint={
                selected.action === 'disable_qa'
                  ? '停用建议只针对来源店铺的原问答，不能更换店铺。'
                  : '默认用于来源店铺；选择全部店铺即发布为通用问答。切换店铺会清除已选图片和商品，请按新范围重新选择。'
              }
            >
              <select
                aria-label="适用店铺"
                value={targetStoreId}
                disabled={
                  busy || selected.status !== 'pending_review' || selected.action === 'disable_qa'
                }
                onChange={(e) => {
                  setTargetStoreId(e.target.value);
                  setEditing(true);
                  setQa((current: any) => ({
                    ...current,
                    attachmentId: undefined,
                    scope: { ...current.scope, productIds: [], overridesEntryId: undefined },
                  }));
                }}
              >
                <option value="">全部店铺 · 通用问答</option>
                {targetStoreId && !targetStoreValid && (
                  <option value={targetStoreId} disabled>
                    {storesLoaded ? '原店铺已移除，请重新选择' : '正在读取店铺…'}
                  </option>
                )}
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {platformNames[s.platform as PlatformId]}
                  </option>
                ))}
              </select>
            </Field>
            {selected.action === 'revise_qa' && targetStoreId !== selected.storeId && (
              <p className="muted">更改适用店铺后，将新增一条问答，来源店铺的原问答保持不变。</p>
            )}
            {editing ? (
              <QaFields
                key={`${selected.id}:${targetStoreId}`}
                qa={qa}
                setQa={setQa}
                storeId={targetStoreId || null}
                entryId={targetStoreId === selected.storeId ? selected.targetEntryId : undefined}
              />
            ) : (
              <div className="review-proposal">
                <small>拟生效内容</small>
                <h3>{selected.content.intent}</h3>
                <KnowledgeAnswer qa={selected.content} />
                <div className="review-rule-scope">
                  <Badge>{targetStoreId ? `仅 ${targetStoreName}` : '全部店铺'}</Badge>
                  {!!selected.content.scope?.productIds?.length && (
                    <p>
                      适用商品：
                      {selected.content.scope.productIds
                        .map((id: string) => productLabel(id, reviewCatalog))
                        .join('、')}
                    </p>
                  )}
                  {!!selected.content.scope?.conditions && (
                    <p>使用前提：{selected.content.scope.conditions}</p>
                  )}
                  {!!selected.content.scope?.overridesEntryId && (
                    <p>
                      覆盖通用问答：
                      {reviewKnowledge.find((r) => r.id === selected.content.scope.overridesEntryId)
                        ?.revisions[0]?.intent || '原通用问答不可用，请编辑后重新选择'}
                    </p>
                  )}
                </div>
                <small>
                  来源版本 {selected.sourceRevision} · 候选 v{selected.candidateVersion}
                </small>
              </div>
            )}
            {selected.status === 'pending_review' ? (
              <div className="modal-actions">
                <Button variant="danger" disabled={busy} onClick={() => review('rejected')}>
                  <XCircle size={16} />
                  拒绝
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || selected.action === 'disable_qa'}
                  onClick={() => (editing ? resetDraft(selected) : setEditing(true))}
                >
                  <Pencil size={15} />
                  {editing ? '取消编辑' : '编辑内容'}
                </Button>
                <Button
                  disabled={busy || !storesLoaded || !targetStoreValid}
                  onClick={() => review('approved')}
                >
                  <Check size={16} />
                  {busy ? '正在提交…' : editing ? '批准编辑后的版本' : '批准当前版本'}
                </Button>
              </div>
            ) : (
              <Badge>{statusText[selected.status]}</Badge>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
