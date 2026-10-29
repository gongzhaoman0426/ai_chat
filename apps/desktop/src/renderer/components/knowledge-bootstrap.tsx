import { useEffect, useState } from 'react';
import { Check, Pencil, RefreshCw, Sparkles } from 'lucide-react';
import { qaSchema, type QaInput } from '../../../../../packages/contracts/src/index';
import type { KnowledgeBootstrapState } from '../../../../../packages/contracts/src/knowledge-bootstrap';
import { api, client, useData, useUi } from '../api';
import { QaFields } from '../pages-knowledge';
import { Attachment } from '../pages-inbox';
import { Badge, Button, Modal } from './ui';
import './knowledge-bootstrap.css';

type Draft = KnowledgeBootstrapState['drafts'][number];

export function KnowledgeBootstrap({
  storeId,
  disabled = false,
}: {
  storeId: string;
  disabled?: boolean;
}) {
  return <StoreKnowledgeBootstrap key={storeId} storeId={storeId} disabled={disabled} />;
}

function StoreKnowledgeBootstrap({ storeId, disabled }: { storeId: string; disabled: boolean }) {
  const {
    data: state,
    error: loadError,
    isPending,
    refetch,
  } = useData<KnowledgeBootstrapState | null>('knowledge.bootstrapState', { storeId });
  const [action, setAction] = useState<'start' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, QaInput>>({});
  const [editing, setEditing] = useState<Draft | null>(null);
  const [editError, setEditError] = useState('');
  const running = state?.status === 'running';
  const busy = disabled || !!action;
  const drafts = (state?.drafts ?? []).map((draft) => ({
    ...draft,
    qa: edits[draft.id] ?? draft.qa,
  }));
  const selected = drafts.filter((draft) => !excluded.has(draft.id));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refetch(), 2500);
    return () => window.clearInterval(timer);
  }, [running, refetch]);

  const updateState = (next: KnowledgeBootstrapState) => {
    client.setQueryData(['knowledge.bootstrapState', { storeId }], next);
  };
  const start = async () => {
    if (busy || running) return;
    setAction('start');
    setError('');
    try {
      updateState(await api<KnowledgeBootstrapState>('knowledge.bootstrapStart', { storeId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法开始生成，请重试');
    } finally {
      setAction(null);
    }
  };
  const save = async () => {
    if (busy || running || !state || !selected.length) return;
    setAction('save');
    setError('');
    let saved = 0;
    try {
      // Keep each request within the API limit, including when several runs accumulated drafts.
      for (let index = 0; index < selected.length; index += 100) {
        const rows = selected.slice(index, index + 100).map(({ id, qa }) => ({ id, qa }));
        const next = await api<KnowledgeBootstrapState>('knowledge.bootstrapApply', {
          storeId,
          runId: state.runId,
          rows,
        });
        updateState(next);
        saved += rows.length;
      }
      useUi.getState().notify(`已保存 ${saved} 条本店问答`);
    } catch (e) {
      setError(
        `${saved ? `已保存 ${saved} 条。` : ''}${e instanceof Error ? e.message : '保存失败，请重试'}`,
      );
    } finally {
      await Promise.all([refetch(), client.invalidateQueries({ queryKey: ['knowledge.list'] })]);
      setAction(null);
    }
  };

  return (
    <section className="knowledge-bootstrap" aria-label="生成店铺默认问答">
      <div className="knowledge-bootstrap-heading">
        <div>
          <h3>
            <Sparkles size={17} />
            生成店铺默认问答
          </h3>
          <p>读取商品资料和历史聊天，整理成可编辑的问答草稿，确认保存后用于本店接待。</p>
        </div>
        <Button
          variant="secondary"
          disabled={busy || running || isPending}
          onClick={() => void start()}
        >
          <RefreshCw size={14} />
          {action === 'start'
            ? '正在开始…'
            : running
              ? '正在生成…'
              : state
                ? '重新读取并生成'
                : '读取并生成默认问答'}
        </Button>
      </div>
      <p className="knowledge-bootstrap-note">
        请保持店铺登录。读取范围取决于平台开放的商品和聊天记录；再次生成会保留未保存的草稿。
      </p>
      {isPending && <p className="hint">正在读取生成进度…</p>}
      {loadError && (
        <div className="setup-error" role="alert">
          无法读取生成进度：{loadError.message}
          <Button variant="ghost" onClick={() => void refetch()}>
            重新加载
          </Button>
        </div>
      )}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      {state && (
        <>
          <div className="knowledge-bootstrap-progress" role="status" aria-live="polite">
            <Badge tone={running ? 'orange' : state.status === 'failed' ? 'orange' : 'green'}>
              {running ? '生成中' : state.status === 'failed' ? '生成未完成' : '已完成'}
            </Badge>
            <span>{state.phase}</span>
            <small>
              已读取 {state.products} 件商品 · {state.conversations} 段会话 · {state.messages}{' '}
              条消息
            </small>
            {!!state.saved && <small>已保存 {state.saved} 条问答</small>}
          </div>
          {running && (
            <p className="knowledge-bootstrap-note">可以离开此页面，任务会继续在后台运行。</p>
          )}
          {state.error && (
            <p className="setup-error" role="alert">
              {state.error}
            </p>
          )}
          {!!state.warnings.length && (
            <details className="knowledge-bootstrap-warnings" open>
              <summary>读取范围与提示（{state.warnings.length}）</summary>
              <ul>
                {state.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {!!drafts.length && (
            <>
              <div className="knowledge-bootstrap-selection">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.length === drafts.length}
                    disabled={busy}
                    onChange={(event) =>
                      setExcluded(
                        event.target.checked ? new Set() : new Set(drafts.map((draft) => draft.id)),
                      )
                    }
                  />
                  全选草稿（{selected.length} / {drafts.length}）
                </label>
                <span>核对答案和适用商品，可逐条编辑</span>
              </div>
              <div className="knowledge-bootstrap-drafts">
                {drafts.map((draft) => (
                  <article className="knowledge-bootstrap-draft" key={draft.id}>
                    <label className="knowledge-bootstrap-draft-check">
                      <input
                        type="checkbox"
                        aria-label={`选择草稿：${draft.qa.intent}`}
                        checked={!excluded.has(draft.id)}
                        disabled={busy}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setExcluded((current) => {
                            const next = new Set(current);
                            if (checked) next.delete(draft.id);
                            else next.add(draft.id);
                            return next;
                          });
                        }}
                      />
                    </label>
                    <div className="knowledge-bootstrap-draft-content">
                      <strong>{draft.qa.intent}</strong>
                      {draft.qa.answerKind === 'image' ? (
                        <>
                          {draft.qa.answerBefore && <p>{draft.qa.answerBefore}</p>}
                          {draft.qa.attachmentId && <Attachment id={draft.qa.attachmentId} />}
                          {draft.qa.answerAfter && <p>{draft.qa.answerAfter}</p>}
                        </>
                      ) : (
                        <p>{draft.qa.answer}</p>
                      )}
                      {!!draft.qa.scope.productIds.length && (
                        <small>限定 {draft.qa.scope.productIds.length} 件商品</small>
                      )}
                      {draft.qa.scope.conditions && (
                        <small>适用前提：{draft.qa.scope.conditions}</small>
                      )}
                      <small>来源：{draft.source}</small>
                      {edits[draft.id] && <small>已修改，待保存</small>}
                    </div>
                    <Button
                      variant="ghost"
                      aria-label={`编辑草稿：${draft.qa.intent}`}
                      disabled={busy}
                      onClick={() => {
                        setEditing(draft);
                        setEditError('');
                      }}
                    >
                      <Pencil size={14} />
                      编辑
                    </Button>
                  </article>
                ))}
              </div>
              <div className="knowledge-bootstrap-footer">
                <small>保存后立即加入本店问答库；未勾选的草稿继续保留。</small>
                <Button disabled={busy || running || !selected.length} onClick={() => void save()}>
                  <Check size={15} />
                  {action === 'save' ? '正在保存…' : `保存并启用选中的 ${selected.length} 条`}
                </Button>
              </div>
            </>
          )}
          {!running && !drafts.length && (
            <p className="knowledge-bootstrap-note">
              {state.saved
                ? '生成的草稿已保存，可前往问答库继续维护。'
                : '暂无可用的问答草稿。请检查上方提示，确认店铺资料可读取后重试。'}
            </p>
          )}
        </>
      )}
      <Modal
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        title="编辑默认问答草稿"
        description="核对答案和适用范围。确认修改后，仍需在草稿列表点击保存并启用。"
        wide
      >
        {editing && (
          <QaFields
            qa={editing.qa}
            setQa={(qa) => setEditing({ ...editing, qa })}
            storeId={storeId}
          />
        )}
        {editError && (
          <p className="setup-error" role="alert">
            {editError}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (!editing) return;
              const result = qaSchema.safeParse(editing.qa);
              if (!result.success) {
                setEditError(result.error.issues[0]?.message || '请检查问答内容');
                return;
              }
              setEdits((current) => ({ ...current, [editing.id]: result.data }));
              setEditing(null);
            }}
          >
            确认修改
          </Button>
        </div>
      </Modal>
    </section>
  );
}
