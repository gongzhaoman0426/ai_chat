import { RefreshCw } from 'lucide-react';
import type { ReceptionState } from '../../../../packages/core/src/reception';
import { useData, date } from './api';
import { Badge, Button, Empty } from './components/ui';

export function ReceptionCheck({ storeId }: { storeId?: string }) {
  const { data, error, isFetching, refetch } = useData<ReceptionState>(
    'reception.state',
    { storeId },
    !!storeId,
  );
  if (!storeId) return <Empty>请先选择店铺。</Empty>;
  if (error)
    return (
      <Empty>
        接待检查失败：{error.message}
        <Button onClick={() => refetch()}>重试</Button>
      </Empty>
    );
  if (!data) return <Empty>正在检查本机接待状态…</Empty>;
  const store = data.stores[0];
  if (!store) return <Empty>当前店铺已不存在，请重新选择。</Empty>;
  const checks = [
    {
      name: '自动回复开关',
      ok: store.autoReplyEnabled,
      detail: store.autoReplyEnabled
        ? '已开启，按会话接待状态处理新消息。'
        : '尚未开启，请到“系统设置 → 店铺接待 → 开启接待”开启 AI 自动回复。',
    },
    { name: '账号接待条件', ok: store.readiness.ready, detail: store.readiness.reason },
    { name: '工作回复 Agent', ok: store.agent.ready, detail: store.agent.reason },
    {
      name: '后台调度',
      ok: data.scheduler.running,
      detail: data.scheduler.running
        ? `正在运行，${store.pendingReplies} 个回复任务等待或执行中。`
        : '后台调度未运行，请重新启动工作台。',
    },
  ];
  const formatDate = (value: Date | string) => date(String(value));
  return (
    <div className="reception-check">
      <div className="reception-heading">
        <div>
          <h3>当前接待条件</h3>
          <p>本地检查不发起模型请求。以下为当前状态，新消息到达时的判断见下方记录。</p>
        </div>
        <Button variant="secondary" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={14} />
          {isFetching ? '检查中…' : '重新检查'}
        </Button>
      </div>
      <div className="reception-checks">
        {checks.map((check) => (
          <div className="reception-item" key={check.name}>
            <div>
              <strong>{check.name}</strong>
              <Badge tone={check.ok ? 'green' : 'orange'}>{check.ok ? '正常' : '需处理'}</Badge>
            </div>
            <p>{check.detail}</p>
            {check.name === '工作回复 Agent' && store.agent.name && (
              <small>
                {store.agent.name} · {store.agent.model || '未配置模型'}
              </small>
            )}
          </div>
        ))}
      </div>
      {data.scheduler.lastError && (
        <p className="reception-note">
          最近一次调度异常（{formatDate(data.scheduler.lastError.at)}）：
          {data.scheduler.lastError.message}
        </p>
      )}
      <div className="reception-accounts">
        {store.accounts.map((account) => (
          <div key={account.id}>
            <strong>{account.name}</strong>
            <Badge tone={account.readiness.ready ? 'green' : 'orange'}>
              {account.readiness.ready
                ? '可接待'
                : account.readiness.action === 'verify'
                  ? '待验收确认'
                  : '通道未连接'}
            </Badge>
            <span>{account.connection?.reason || account.readiness.reason}</span>
          </div>
        ))}
      </div>
      <p className="reception-note">
        {store.latestBuyerMessage
          ? `最近收到买家消息：${formatDate(store.latestBuyerMessage.receivedAt)}。`
          : '当前店铺尚未收到买家消息，请确认已打开平台客服聊天页。'}{' '}
        当前有 {store.conversations.openedByHuman} 个会话由人工接待、
        {store.conversations.awaitingHuman} 个等待人工、{store.conversations.pendingHumanSends}{' '}
        条人工消息正在发送。
      </p>
      <div className="reception-heading">
        <div>
          <h3>新消息触发记录</h3>
          <p>记录消息到达时是否进入自动回复队列。执行步骤和发送结果请查看 Agent 执行。</p>
        </div>
      </div>
      {store.decisions.length ? (
        <div className="reception-table">
          <table>
            <thead>
              <tr>
                <th>收到时间</th>
                <th>会话</th>
                <th>当时结果</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {store.decisions.map((decision) => (
                <tr key={decision.id}>
                  <td>{formatDate(decision.createdAt)}</td>
                  <td title={decision.conversationId}>{decision.conversationId.slice(0, 8)}</td>
                  <td>
                    <Badge tone={decision.eligible ? 'green' : 'orange'}>
                      {decision.eligible ? '已入队' : '未触发'}
                    </Badge>
                  </td>
                  <td>{decision.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>
          此版本还没有记录到新买家消息。更新前的消息不会补发；请用测试账号发送一条新消息查看触发原因。
        </Empty>
      )}
      <small className="muted">
        {data.runtime.platform} / {data.runtime.arch} · 检查时间 {formatDate(data.checkedAt)}
      </small>
    </div>
  );
}
