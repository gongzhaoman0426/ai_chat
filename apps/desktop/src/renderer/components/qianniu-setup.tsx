import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, Play, Plus, RefreshCw } from 'lucide-react';
import type { QianniuSetupPhase, QianniuSetupState } from '../../../../../packages/contracts/src';
import { api, client, invalidateLocalData, useAvailablePlatforms, useData } from '../api';
import { Badge, Button } from './ui';
import '../styles-qianniu.css';

const phaseLabels: Record<QianniuSetupPhase, string> = {
  unavailable: '暂不可用',
  not_configured: '等待启动客户端',
  ready: '可以启动',
  starting: '正在启动千牛',
  waiting_login: '等待登录千牛',
  injecting: '正在连接消息',
  waiting_hook: '等待消息连接',
  connected: '已连接',
  error: '连接需要处理',
};
type Action = 'download' | 'launch' | 'addAccount' | 'retryHook';

export function QianniuSetup({ enabled = true }: { enabled?: boolean }) {
  const platforms = useAvailablePlatforms(enabled);
  if (!enabled || !platforms.includes('qianniu')) return null;
  return <QianniuSetupContent />;
}

function QianniuSetupContent() {
  const { data: state, error, refetch } = useData<QianniuSetupState>('qianniu.status');
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 2000);
    return () => clearInterval(timer);
  }, [refetch]);
  const run = async (action: Action) => {
    if (busy) return;
    setBusy(action);
    setActionError('');
    try {
      const next = await api<QianniuSetupState>(`qianniu.${action}`);
      if (next) client.setQueryData(['qianniu.status', {}], next);
      await invalidateLocalData();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作未完成，请重试。');
    } finally {
      setBusy(null);
    }
  };
  if (!state)
    return (
      <div className="qianniu-setup" aria-label="千牛接入引导">
        <p className="hint" role={error ? 'alert' : 'status'}>
          {error ? '无法读取千牛连接状态，请重新检查。' : '正在检查千牛连接…'}
        </p>
        {error && (
          <Button variant="secondary" onClick={() => void refetch()}>
            重新检查
          </Button>
        )}
      </div>
    );
  if (!state.supported) return null;
  const connected = state.phase === 'connected';
  const connectedCount = state.accounts.filter(
    (account) => account.websocket && account.tcp,
  ).length;
  const hasActiveAccount = state.accounts.some((account) => account.websocket || account.tcp);
  const starting = ['starting', 'injecting', 'waiting_hook'].includes(state.phase);
  const canRetry =
    state.accounts.some((account) => account.websocket && !account.tcp) && (!starting || connected);
  return (
    <section className="qianniu-setup" aria-label="千牛接入引导" aria-busy={!!busy}>
      <div className="qianniu-setup-heading">
        <div>
          <h3>连接千牛客户端</h3>
          <p>支持同时登录多个店铺。使用句达适配的千牛客户端，登录后自动连接消息。</p>
        </div>
        <Badge tone={connected ? 'green' : state.phase === 'error' ? 'orange' : 'neutral'}>
          {connectedCount > 0 ? `已连接 ${connectedCount} 个账号` : phaseLabels[state.phase]}
        </Badge>
      </div>
      <ol className="qianniu-steps">
        <li>
          <span className="qianniu-step-number">1</span>
          <div>
            <strong>下载适配客户端</strong>
            <p>句达会静默下载并解压适配客户端，之后可直接启动。</p>
            <Button
              variant="secondary"
              disabled={!!busy || !state.downloadUrl || state.downloading}
              onClick={() => void run('download')}
            >
              <Download size={15} />
              {busy === 'download' || state.downloading ? '正在下载解压…' : '下载千牛客户端'}
            </Button>
            {!state.downloadUrl && (
              <p className="qianniu-download-note">
                下载地址尚未配置。已安装适配客户端可直接启动。
              </p>
            )}
            {state.downloadUrl && (
              <p className="qianniu-download-note">首次下载可能需要几分钟，请保持网络畅通。</p>
            )}
          </div>
        </li>
        <li>
          <span className="qianniu-step-number">2</span>
          <div>
            <strong>{hasActiveAccount ? '登录其他店铺' : '启动千牛'}</strong>
            <p>
              {hasActiveAccount
                ? '打开千牛登录窗口，登录另一个店铺账号。现有账号可继续接待。'
                : '点击启动，句达会自动找到已安装的适配客户端。'}
            </p>
            <div className="qianniu-actions">
              <Button
                disabled={!!busy || starting}
                onClick={() => void run(hasActiveAccount ? 'addAccount' : 'launch')}
              >
                {busy === 'launch' || busy === 'addAccount' || state.phase === 'starting' ? (
                  <Loader2 className="qianniu-spinner" size={15} />
                ) : hasActiveAccount ? (
                  <Plus size={15} />
                ) : (
                  <Play size={15} />
                )}
                {state.phase === 'starting' || busy === 'launch' || busy === 'addAccount'
                  ? '正在打开…'
                  : hasActiveAccount
                    ? '登录其他店铺'
                    : '启动千牛'}
              </Button>
            </div>
          </div>
        </li>
        <li>
          <span className={`qianniu-step-number ${connected ? 'done' : ''}`}>
            {connected ? <CheckCircle2 size={17} /> : '3'}
          </span>
          <div>
            <strong>{connected ? '千牛已连接' : '登录后自动连接'}</strong>
            <p>在千牛中登录客服账号并进入聊天工作台，保持客户端运行。</p>
            <div
              className={`qianniu-connection ${state.phase === 'error' ? 'has-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {starting && <Loader2 className="qianniu-spinner" size={15} />}
              <span>{state.message || phaseLabels[state.phase]}</span>
            </div>
            {connected && <p>店铺识别后会显示在店铺列表中。请先验收消息收发，再开启自动接待。</p>}
            {state.accounts.length > 0 && (
              <ul className="qianniu-accounts" aria-label="千牛账号连接状态">
                {state.accounts.map((account) => (
                  <li key={account.loginId}>
                    <span>{account.loginId}</span>
                    <Badge tone={account.websocket && account.tcp ? 'green' : 'neutral'}>
                      {account.websocket && account.tcp
                        ? '已连接'
                        : account.websocket
                          ? '消息连接待完成'
                          : account.tcp
                            ? '等待聊天工作台'
                            : '已离线'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {canRetry && (
              <Button variant="secondary" disabled={!!busy} onClick={() => void run('retryHook')}>
                <RefreshCw size={15} />
                {busy === 'retryHook' ? '正在重新连接…' : '重新连接消息'}
              </Button>
            )}
          </div>
        </li>
      </ol>
      {(actionError || error) && (
        <p className="setup-error" role="alert">
          {actionError || '连接状态更新失败，请检查千牛是否仍在运行。'}
        </p>
      )}
    </section>
  );
}
