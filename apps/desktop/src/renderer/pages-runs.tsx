import { createContext, useContext, useEffect, useState } from 'react';
import './styles-runs.css';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { RunStep, RunStepKind } from '../../../../packages/contracts/src/run-trace';
import { api, date, useData, useUi } from './api';
import { Badge, Button, Empty } from './components/ui';
import { StoreScope } from './components/store-scope';
import { Attachment } from './pages-inbox';

const deliveryLabels: Record<string, string> = {
  prepared: '准备发送',
  dispatching: '发送中',
  confirmed: '发送成功',
  unknown: '发送待确认',
  rejected: '发送被拒绝',
  cancelled: '发送已取消',
};
const kinds: Record<RunStepKind, { label: string; icon: typeof Bot }> = {
  agent: { label: 'Agent', icon: Bot },
  model: { label: '模型回合', icon: Sparkles },
  tool: { label: '工具', icon: Wrench },
  workflow: { label: 'Workflow', icon: Layers },
  workflow_step: { label: '流程步骤', icon: ChevronRight },
  skill: { label: 'Skill', icon: Code2 },
  knowledge: { label: '问答检索', icon: Search },
};
const states: Record<string, string> = {
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已中断',
  superseded: '已失效',
  unknown: '待确认',
  skipped: '已跳过',
};
const duration = (start: string | Date, end?: string | Date | null) => {
  const ms = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};
function StatusIcon({ status }: { status: string }) {
  const Icon =
    status === 'running'
      ? LoaderCircle
      : status === 'succeeded'
        ? CheckCircle2
        : ['failed', 'cancelled'].includes(status)
          ? XCircle
          : AlertCircle;
  return (
    <Icon
      size={16}
      className={`trace-status trace-status-${status} ${status === 'running' ? 'trace-spin' : ''}`}
    />
  );
}
function RunStatus({ run, compact = false }: { run: any; compact?: boolean }) {
  const label =
    run.path === 'preflight'
      ? '启动检查失败'
      : run.status !== 'succeeded'
        ? (states[run.status] ?? run.status)
        : run.role === 'learning'
          ? '评估完成'
          : run.output?.action === 'handoff'
            ? '已转人工'
            : run.output?.reasonCode === 'platform_message_sent'
              ? '已发送平台消息'
              : run.output?.action === 'ignore'
                ? '无需回复'
                : run.path === 'direct_match'
                  ? '问答已匹配'
                  : 'AI 已生成';
  return (
    <div className="trace-run-status">
      <Badge
        tone={
          run.status === 'succeeded' ? 'green' : run.status === 'running' ? 'neutral' : 'orange'
        }
      >
        {label}
      </Badge>
      {!compact &&
        run.outbounds?.map((o: any) => (
          <Badge key={o.id} tone={o.status === 'confirmed' ? 'green' : 'orange'}>
            {deliveryLabels[o.status] ?? o.status}
          </Badge>
        ))}
    </div>
  );
}
function JsonValue({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <section className="trace-value">
      <div>
        <h4>{label}</h4>
        <button
          aria-label={`复制${label}`}
          title={`复制${label}`}
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => useUi.getState().notify('已复制'))
              .catch(() => useUi.getState().notify('复制失败'))
          }
        >
          <Copy size={13} />
        </button>
      </div>
      <pre tabIndex={0}>{text}</pre>
    </section>
  );
}
function TraceStep({ step, children }: { step: RunStep; children: RunStep[] }) {
  const [open, setOpen] = useState(step.status === 'failed' || step.status === 'unknown');
  const type = kinds[step.kind] ?? kinds.tool;
  const Icon = type.icon;
  const usage =
    typeof step.metadata.usage === 'object' && step.metadata.usage !== null
      ? (step.metadata.usage as Record<string, unknown>)
      : {};
  const tokenCounts: [string, unknown][] = [
    ['输入', usage.inputTokens],
    ['输出', usage.outputTokens],
    ['其中思考', usage.reasoningTokens],
    ['总计', usage.totalTokens],
    ['配置输出上限', step.metadata.maxOutputTokens],
  ];
  return (
    <article
      className={`trace-step trace-step-${step.status}`}
      data-step-id={step.id}
      data-step-kind={step.kind}
    >
      <button className="trace-step-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className={open ? 'trace-chevron-open' : ''} />
        <span className="trace-kind-icon">
          <Icon size={16} />
        </span>
        <span className="trace-step-name">
          <strong>{step.name}</strong>
          <small>
            {type.label}
            {step.toolName ? ` · ${step.toolName}` : ''}
          </small>
        </span>
        <span className="trace-step-state">
          <StatusIcon status={step.status} />
          <span>{states[step.status] ?? step.status}</span>
          <time>{duration(step.startedAt, step.finishedAt)}</time>
        </span>
      </button>
      {open && (
        <div className="trace-step-content">
          {step.error && (
            <div className="trace-error">
              <AlertCircle size={15} />
              <span>{step.error}</span>
            </div>
          )}
          {step.kind === 'model' && (
            <div className="trace-model-meta">
              <span>{String(step.metadata.model ?? '已配置模型')}</span>
              {tokenCounts.map(([label, value]) =>
                typeof value === 'number' && Number.isFinite(value) && value >= 0 ? (
                  <span key={label}>
                    {label} {value} tokens
                  </span>
                ) : null,
              )}
              <span>
                结束原因：
                {step.metadata.finishReason === 'length'
                  ? '达到输出上限（length）'
                  : String(
                      step.metadata.finishReason ??
                        (step.status === 'running' ? '等待返回' : '未返回'),
                    )}
              </span>
              <small>回合耗时包含本轮工具执行</small>
            </div>
          )}
          <div className="trace-values">
            <JsonValue label="输入参数" value={step.input} />
            {step.status === 'running' ? (
              <div className="trace-waiting">
                <LoaderCircle size={18} className="trace-spin" />
                等待执行结果…
              </div>
            ) : (
              <JsonValue label="返回结果" value={step.output} />
            )}
          </div>
        </div>
      )}
      {/* Calls remain visible when their parent details are collapsed. */}
      {!!children.length && (
        <div className="trace-children">
          {children.map((child) => (
            <TraceBranch key={child.id} step={child} />
          ))}
        </div>
      )}
    </article>
  );
}
// The tree is passed through a tiny explicit context to keep each toggle stable on refresh.
const StepsContext = createContext<RunStep[]>([]);
function TraceBranch({ step }: { step: RunStep }) {
  const steps = useContext(StepsContext);
  return <TraceStep step={step} children={steps.filter((s) => s.parentId === step.id)} />;
}
function RunDetail({ run, storeName }: { run: any; storeName?: string | null }) {
  const steps = run.steps as RunStep[];
  const roots = steps.filter(
    (s) => !s.parentId || !steps.some((parent) => parent.id === s.parentId),
  );
  return (
    <div className="trace-detail" data-testid="agent-run-detail">
      <header className="trace-detail-heading">
        <div>
          <span className="eyebrow">
            {run.role === 'learning' ? 'LEARNING AGENT' : 'REPLY AGENT'}
          </span>
          <h2>{run.agentName}</h2>
          <p>
            {storeName ? `${storeName} · ` : ''}
            {run.buyerName ?? '本店会话'} · {date(run.startedAt)}
          </p>
        </div>
        <RunStatus run={run} />
      </header>
      <div className="trace-question">
        <span>{run.role === 'learning' ? '学习来源' : '买家消息'}</span>
        <p>{run.question}</p>
      </div>
      <div className="trace-stats">
        <span>
          <Clock3 size={14} />
          {duration(run.startedAt, run.finishedAt)}
        </span>
        {run.traceVersion === 0 ? (
          <span>历史调用次数未采集</span>
        ) : (
          <>
            <span>{run.modelCalls} 次模型调用</span>
            <span>{run.toolCalls} 次工具调用</span>
          </>
        )}
        <span>{Number(run.usage?.totalTokens) || 0} tokens</span>
      </div>
      {run.error && (
        <div className="trace-error">
          <AlertCircle size={16} />
          <span>{run.error}</span>
        </div>
      )}
      <div className="trace-section-title">
        <h3>执行步骤</h3>
        {run.status === 'running' && (
          <span>
            <span className="status-dot" />
            实时更新
          </span>
        )}
      </div>
      {steps.length ? (
        <StepsContext.Provider value={steps}>
          <div className="trace-timeline">
            {roots.map((s) => (
              <TraceBranch key={s.id} step={s} />
            ))}
          </div>
        </StepsContext.Provider>
      ) : (
        <div className="trace-empty-steps">
          <Activity size={22} />
          <p>
            {run.path === 'preflight'
              ? '启动检查未通过，未调用回复模型。'
              : run.traceVersion === 0
                ? '这条历史记录未采集逐步调用。更新后的新运行会自动显示完整执行过程。'
                : run.status === 'running'
                  ? '正在准备执行，步骤将在运行时显示。'
                  : '本次没有可用的逐步调用记录。'}
          </p>
        </div>
      )}
      <section className="trace-final">
        <h3>{run.role === 'learning' ? '学习评估结果' : '本次处理结果'}</h3>
        {run.output?.text && <p className="trace-reply-text">{run.output.text}</p>}
        {run.output?.attachmentId && (
          <Attachment id={run.output.attachmentId} storeId={run.storeId} />
        )}
        {run.role === 'learning' ? (
          <>
            <p>{run.output?.reason || '等待评估结果'}</p>
            {run.status === 'succeeded' && (
              <p className="muted">
                生成 {run.output?.suggestions?.length ?? 0}{' '}
                条建议，学习建议需在“自动学习”中审批后生效。
              </p>
            )}
            <details>
              <summary>查看评估内容</summary>
              <JsonValue label="评估结果" value={run.output} />
            </details>
          </>
        ) : (
          !run.output?.text &&
          !run.output?.attachmentId && (
            <p>
              {run.output?.action === 'handoff'
                ? `交由人工处理：${run.output.reasonCode}`
                : run.output?.reasonCode === 'platform_message_sent'
                  ? '已发送平台消息'
                  : run.output?.action === 'ignore'
                    ? '本次无需回复买家。'
                    : '尚未生成可发送的回复。'}
            </p>
          )
        )}
        {run.outbounds?.map((o: any) => (
          <div key={o.id} className="trace-delivery" data-outbound-id={o.id}>
            <Badge tone={o.status === 'confirmed' ? 'green' : 'orange'}>
              {deliveryLabels[o.status]}
            </Badge>
            <span>{o.origin === 'handoff_notice' ? '转人工提示' : '平台发送回执'}</span>
            {o.error && <p>{o.error}</p>}
            {o.externalId && <small>平台消息 ID：{o.externalId}</small>}
          </div>
        ))}
        {run.role === 'reply' &&
          run.status === 'succeeded' &&
          ['reply', 'clarify'].includes(run.output?.action) &&
          !run.outbounds?.length && (
            <div className="trace-error">
              <AlertCircle size={15} />
              回复已生成，但尚未提交发送。
            </div>
          )}
      </section>
    </div>
  );
}
export function AgentRuns({ store }: { store?: any }) {
  const { data: stores = [] } = useData<any[]>('stores.list');
  const ui = useUi();
  const [allStores, setAllStores] = useState(true);
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const storeId = allStores
    ? undefined
    : stores.some((s) => s.id === ui.storeId)
      ? ui.storeId
      : (store?.id ?? stores[0]?.id);
  const input = {
    ...(storeId ? { storeId } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  };
  const list = useInfiniteQuery<{ runs: any[]; nextCursor: string | null }>({
    queryKey: ['runs.history', input],
    queryFn: ({ pageParam }) =>
      api('runs.history', { ...input, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: allStores || !!storeId,
    refetchInterval: 2000,
  });
  const rows =
    list.data?.pages
      .flatMap((p) => p.runs)
      .filter((r, i, all) => all.findIndex((a) => a.id === r.id) === i) ?? [];
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.id === selected)) setSelected(rows[0].id);
  }, [rows, selected]);
  const id = rows.some((r) => r.id === selected) ? selected : rows[0]?.id;
  const selectedRun = rows.find((r) => r.id === id);
  const detail = useQuery<any>({
    queryKey: ['runs.detail', selectedRun?.storeId, id],
    queryFn: () => api('runs.detail', { storeId: selectedRun!.storeId, id }),
    enabled: !!id && !!selectedRun?.storeId,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ||
      query.state.data?.outbounds?.some((o: any) => ['prepared', 'dispatching'].includes(o.status))
        ? 1000
        : false,
  });
  return (
    <>
      <StoreScope
        label="执行记录所属店铺"
        allowAll
        value={allStores ? '' : (storeId ?? '')}
        onChange={(id) => {
          setSelected(null);
          if (!id) setAllStores(true);
          else {
            setAllStores(false);
            ui.setStore(id);
          }
        }}
      />
      <div className="page-heading">
        <div>
          <div className="eyebrow">AGENT ACTIVITY</div>
          <h1>
            Agent 执行<span className="title-dot">.</span>
          </h1>
          <p>查看每次调用的输入、结果与耗时，了解助手如何完成这次接待。</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void list.refetch();
            if (id) void detail.refetch();
          }}
          disabled={list.isFetching}
        >
          <RefreshCw size={15} />
          刷新
        </Button>
      </div>
      <div className="page-body page-body-fill">
        {!stores.length ? (
          <Empty icon={<Bot size={32} />}>
            <h3>请先连接店铺</h3>
            <p>连接店铺后，可查看该店铺的 Agent 执行过程。</p>
          </Empty>
        ) : (
          <div className="trace-workspace">
            <aside className="card trace-run-list">
              <div className="trace-filters">
                <select
                  aria-label="执行类型"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setSelected(null);
                  }}
                >
                  <option value="">全部类型</option>
                  <option value="reply">自动回复</option>
                  <option value="learning">自动学习</option>
                </select>
                <select
                  aria-label="执行状态"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setSelected(null);
                  }}
                >
                  <option value="">全部状态</option>
                  <option value="running">执行中</option>
                  <option value="succeeded">已完成</option>
                  <option value="failed">失败/中断</option>
                </select>
              </div>
              {list.isPending ? (
                <Empty>正在加载执行记录…</Empty>
              ) : list.error ? (
                <Empty>
                  <p>{list.error.message}</p>
                  <Button onClick={() => void list.refetch()}>重新加载</Button>
                </Empty>
              ) : !rows.length ? (
                <Empty icon={<Activity size={24} />}>
                  <h3>暂无执行记录</h3>
                  <p>助手开始处理新消息或学习对话后，执行过程会显示在这里。</p>
                </Empty>
              ) : (
                <div className="trace-run-items" aria-label="Agent 运行列表">
                  {rows.map((run) => (
                    <button
                      key={run.id}
                      className={`trace-run-item ${run.id === id ? 'selected' : ''}`}
                      onClick={() => setSelected(run.id)}
                      data-run-id={run.id}
                      aria-pressed={run.id === id}
                    >
                      <div className="trace-run-head">
                        <strong>{run.agentName}</strong>
                        <RunStatus run={run} compact />
                        <time>{date(run.startedAt)}</time>
                      </div>
                      <p>
                        {run.question}
                        <small>
                          {' '}
                          {allStores && run.storeName ? `${run.storeName} · ` : ''}
                          {run.buyerName ?? (run.role === 'learning' ? '自动学习' : '自动回复')}
                        </small>
                      </p>
                    </button>
                  ))}
                </div>
              )}
              {list.hasNextPage && (
                <Button
                  variant="ghost"
                  disabled={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {list.isFetchingNextPage ? '加载中…' : '加载更早记录'}
                </Button>
              )}
            </aside>
            <section className="card trace-run-detail">
              {!id ? (
                <Empty icon={<Bot size={36} />}>
                  <h3>每一步，都有记录</h3>
                  <p>
                    选择一次运行，查看模型回合、工具调用、Skill 脚本与 Workflow 的实际执行结果。
                  </p>
                </Empty>
              ) : detail.isPending ? (
                <Empty>正在加载执行步骤…</Empty>
              ) : detail.error ? (
                <Empty>
                  <p>{detail.error.message}</p>
                  <Button onClick={() => void detail.refetch()}>重新加载</Button>
                </Empty>
              ) : (
                detail.data && (
                  <RunDetail
                    key={id}
                    run={detail.data}
                    storeName={allStores ? (detail.data.storeName ?? selectedRun?.storeName) : null}
                  />
                )
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
