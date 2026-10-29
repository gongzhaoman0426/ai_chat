import { useEffect, useState } from 'react';
import { ArrowRight, Check, Plus, Trash2, Unplug } from 'lucide-react';
import type { OnboardingState } from '../../../../../packages/core/src/onboarding';
import { getAutoReplyReadiness } from '../../../../../packages/contracts/src';
import { api, client, useData, useUi } from '../api';
import { AccountVerificationDialog, ConnectPlatformDialog } from '../setup-fields';
import { AssistantModelSettings } from './assistant-model-settings';
import { WorkingConfigurationCard } from './working-configuration';
import { QianniuSetup } from './qianniu-setup';
import { KnowledgeBootstrap } from './knowledge-bootstrap';
import { Badge, Button, Field, Toggle } from './ui';

type ReceptionStep = 1 | 2 | 3;

export function StoreReceptionSettings({
  store,
  models,
  developerMode,
  defaultModelId,
  initialStep,
  management = false,
}: {
  store: any;
  models: any[];
  developerMode: boolean;
  defaultModelId?: string;
  initialStep?: number;
  management?: boolean;
}) {
  const { data, error, refetch } = useData<OnboardingState>('onboarding.state', {
    storeId: store.id,
  });
  const [selectedStep, setStep] = useState<ReceptionStep | null>(
    initialStep === 1 || initialStep === 2 || initialStep === 3 ? initialStep : null,
  );
  const [connecting, setConnecting] = useState(false);
  const [verify, setVerify] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState('');
  // Store settings have three steps; the full setup guide also includes embedding setup.
  const nextStep: ReceptionStep = !data?.connected ? 1 : !data.agent.ready ? 2 : 3;
  const step = selectedStep ?? nextStep;
  useEffect(() => {
    if (selectedStep === null && data) setStep(nextStep);
  }, [selectedStep, data, nextStep]);
  const ui = useUi();
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      await client.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  if (error)
    return (
      <div className="setup-error" role="alert">
        无法读取店铺配置。
        <Button variant="ghost" onClick={() => void refetch()}>
          重新加载
        </Button>
      </div>
    );
  if (!data) return <p className="hint">正在检查店铺配置…</p>;
  const steps = [
    {
      id: 1,
      title: management ? '平台账号' : '连接店铺',
      detail: data.connected ? '消息通道已连接' : '登录平台客服账号',
      done: data.connected,
    },
    {
      id: 2,
      title: management ? '客服助手' : '配置助手',
      detail: data.agent.ready ? data.agent.model : '选择回复使用的模型',
      done: data.agent.ready,
    },
    {
      id: 3,
      title: management ? '自动接待' : '开启接待',
      detail: data.enabled ? (data.ready ? '自动接待已开启' : '接待需要处理') : '确认收发后开启 AI',
      done: data.ready && data.enabled,
    },
  ] as const;
  return (
    <>
      <ol
        className={`settings-progress ${management ? 'management-tabs' : ''}`}
        aria-label="店铺配置步骤"
      >
        {steps.map((item) => (
          <li key={item.id}>
            <button
              aria-pressed={step === item.id}
              disabled={busy || (editing && step === 2 && item.id !== 2)}
              onClick={() => {
                setStep(item.id);
                setError('');
              }}
            >
              <span className={item.done ? 'done' : ''}>
                {item.done ? <Check size={17} /> : item.id}
              </span>
              <div>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </div>
            </button>
          </li>
        ))}
      </ol>
      {actionError && (
        <p className="setup-error" role="alert">
          {actionError}
        </p>
      )}
      <section className="card settings-section reception-step" aria-label={steps[step - 1].title}>
        <div className="settings-step-title">
          <div>
            <h2>
              {step === 1 ? '平台客服账号' : step === 2 ? '客服助手与模型' : '自动回复与学习'}
            </h2>
            <p>
              {step === 1
                ? '登录后保持平台窗口连接，消息会在后台同步。'
                : step === 2
                  ? '一个对话模型就能开始。选择模型后保存，直接用于本店助手。'
                  : '只接待开启后的新消息；查看会话、人工回复不暂停 AI，手动接管后需要交还 AI。'}
            </p>
          </div>
        </div>
        {step === 1 && (
          <>
            {store.platform === 'qianniu' && <QianniuSetup />}
            {store.accounts.map((account: any) => {
              const connected = getAutoReplyReadiness([{ ...account, verifiedAt: true }]).ready;
              return (
                <div className="reception-account" key={account.id}>
                  <div className="reception-account-info">
                    <strong>{account.name}</strong>
                    <p>
                      {account.connection?.reason ||
                        (connected
                          ? '已接入买家消息与文字发送。'
                          : '打开平台并进入客服聊天页，等待连接。')}
                    </p>
                    <small>
                      {account.verifiedAt ? '已确认收发正常' : '请在自动接待中确认消息收发'}
                    </small>
                  </div>
                  <Badge tone={connected ? 'green' : 'orange'}>
                    {connected ? '已连接' : '待连接'}
                  </Badge>
                  <div className="actions">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void run(async () => {
                          await api('accounts.connect', { accountId: account.id });
                        })
                      }
                      disabled={busy}
                    >
                      打开平台
                    </Button>
                    <details className="account-more">
                      <summary>更多</summary>
                      <div>
                        {connected && (
                          <Button variant="ghost" onClick={() => setVerify(account)}>
                            验收确认
                          </Button>
                        )}
                        {connected && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void run(async () => {
                                await api('accounts.disconnect', { accountId: account.id });
                              })
                            }
                          >
                            <Unplug size={14} />
                            断开连接
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (
                              window.confirm(
                                `删除「${account.name}」会断开连接并清除该账号的登录状态。店铺问答和会话会保留。`,
                              )
                            )
                              void run(async () => {
                                await api('accounts.remove', { accountId: account.id });
                              });
                          }}
                        >
                          <Trash2 size={14} />
                          移除账号
                        </Button>
                      </div>
                    </details>
                  </div>
                </div>
              );
            })}
            <div className="settings-step-footer">
              <Button variant="ghost" onClick={() => setConnecting(true)}>
                <Plus size={15} />
                连接其他账号
              </Button>
              <Button disabled={!data.connected || busy} onClick={() => setStep(2)}>
                下一步：配置助手
                <ArrowRight size={15} />
              </Button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <AssistantModelSettings
              key={store.id}
              data={data}
              disabled={busy}
              onEditingChange={setEditing}
              onAdvanced={() => ui.setSettingsSection('advanced')}
            />
            <KnowledgeBootstrap storeId={store.id} disabled={busy || editing} />
            <div className="settings-step-footer">
              <span>已保存的模型服务可以供多家店铺选用。</span>
              <Button disabled={!data.agent.ready || editing || busy} onClick={() => setStep(3)}>
                下一步：开启接待
                <ArrowRight size={15} />
              </Button>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <div className="reception-review">
              <div>
                <span>店铺连接</span>
                <strong>{data.connected ? '已连接' : '未连接'}</strong>
                {!data.connected && (
                  <Button variant="ghost" onClick={() => setStep(1)}>
                    去连接
                  </Button>
                )}
              </div>
              <div>
                <span>回复助手</span>
                <strong>
                  {data.agent.ready ? `${data.agent.name} · ${data.agent.model}` : '尚未配置模型'}
                </strong>
                <Button variant="ghost" onClick={() => setStep(2)}>
                  {data.agent.ready ? '更换模型' : '去配置'}
                </Button>
              </div>
              <div>
                <span>收发确认</span>
                <strong>
                  {data.readiness.ready
                    ? '已确认'
                    : data.readiness.action === 'verify'
                      ? '待确认收发，请完成下方验证'
                      : data.readiness.reason}
                </strong>
              </div>
            </div>
            {!data.readiness.ready && (
              <div className="settings-verification">
                <p>先在接待中心用测试会话检查买家消息和人工回复都能送达，再确认账号。</p>
                <div className="actions">
                  <Button variant="secondary" onClick={() => ui.setPage('inbox')}>
                    去接待中心验证
                  </Button>
                  {store.accounts
                    .filter(
                      (a: any) =>
                        getAutoReplyReadiness([{ ...a, verifiedAt: true }]).ready && !a.verifiedAt,
                    )
                    .map((a: any) => (
                      <Button key={a.id} variant="secondary" onClick={() => setVerify(a)}>
                        确认「{a.name}」收发正常
                      </Button>
                    ))}
                </div>
              </div>
            )}
            <div className="reception-enable">
              <div>
                <strong>AI 自动回复</strong>
                <p>
                  {data.enabled
                    ? data.ready
                      ? '本店正在自动接待新消息。'
                      : '开关已打开，请先处理上方未完成的配置。'
                    : '开启后，本店的新消息将交给已配置的助手处理。'}
                </p>
              </div>
              <Toggle
                label="AI 自动回复"
                checked={data.enabled}
                disabled={busy || (!data.enabled && !data.ready)}
                onChange={(enabled) =>
                  void run(async () => {
                    if (enabled)
                      await api('onboarding.enable', {
                        storeId: store.id,
                        expectedConfigEpoch: data.store!.configEpoch,
                      });
                    else await api('stores.policy', { storeId: store.id, autoReplyEnabled: false });
                  })
                }
              />
            </div>
            <details className="settings-advanced">
              <summary>
                自动学习与接待参数 <span>可选，日常使用后再调整</span>
              </summary>
              <ReceptionPreferences
                key={`${store.id}:${store.replyPolicy.version}:${store.learningPolicy.version}`}
                store={store}
                models={models}
                agentModelId={data.agent.modelId}
                defaultModelId={defaultModelId}
              />
            </details>
          </>
        )}
      </section>
      <details className="settings-config-detail">
        <summary>查看当前生效配置与工具</summary>
        <WorkingConfigurationCard
          storeId={store.id}
          developerMode={developerMode}
          onConfigureAssistant={
            data.agent.canConfigure || data.agent.canChangeModel ? () => setStep(2) : undefined
          }
          openSection={(section) =>
            ui.setSettingsSection(section as 'accounts' | 'models' | 'advanced')
          }
        />
      </details>
      <ConnectPlatformDialog open={connecting} onClose={() => setConnecting(false)} />
      {verify && <AccountVerificationDialog account={verify} onClose={() => setVerify(null)} />}
    </>
  );
}

function ReceptionPreferences({
  store,
  models,
  agentModelId,
  defaultModelId,
}: {
  store: any;
  models: any[];
  agentModelId?: string;
  defaultModelId?: string;
}) {
  const [values, setValues] = useState({
    builtinModelRef: store.learningPolicy.builtinModelRef || defaultModelId || agentModelId || '',
    directMatchThreshold: store.replyPolicy.directMatchThreshold,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="reception-preferences">
      <Toggle
        label="自动学习问答"
        checked={!!store.learningPolicy.autoLearnEnabled}
        disabled={busy}
        onChange={async (enabled) => {
          setBusy(true);
          setError('');
          try {
            await api('stores.policy', {
              storeId: store.id,
              autoLearnEnabled: enabled,
              ...(enabled && values.builtinModelRef
                ? { builtinModelRef: values.builtinModelRef }
                : {}),
            });
            await client.invalidateQueries();
          } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
          } finally {
            setBusy(false);
          }
        }}
      />
      <p className="hint">
        评估本店的 AI
        回复和人工作答，提出新增或修改建议。问答库原文直答不再评估。建议审批通过后才写入问答库。
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api('stores.policy', {
              storeId: store.id,
              ...values,
              builtinModelRef: values.builtinModelRef || null,
            });
            await client.invalidateQueries();
            useUi.getState().notify('本店接待参数已保存');
          } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <Field label="自动学习使用的模型" hint="可以与回复助手使用同一个对话模型。">
            <select
              value={values.builtinModelRef}
              onChange={(e) => setValues({ ...values, builtinModelRef: e.target.value })}
            >
              <option value="">选择学习模型</option>
              {models
                .filter((m) => m.kind === 'chat')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.model}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="问答直答阈值"
            hint="匹配分数严格超过此值才直接采用问答；不确定时保留默认值。"
          >
            <input
              type="number"
              min={0.5}
              max={1}
              step={0.01}
              required
              value={values.directMatchThreshold}
              onChange={(e) =>
                setValues({ ...values, directMatchThreshold: Number(e.target.value) })
              }
            />
          </Field>
          {error && (
            <p role="alert" className="setup-error">
              {error}
            </p>
          )}
          <Button type="submit" variant="secondary">
            {busy ? '保存中…' : '保存接待参数'}
          </Button>
        </fieldset>
      </form>
    </div>
  );
}
