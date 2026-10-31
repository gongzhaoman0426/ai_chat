import {
  platformMarks,
  platformNames,
  type PlatformId,
} from '../../../../packages/contracts/src/platform';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  PlugZap,
  Sparkles,
  ShieldCheck,
  BookOpen,
  Bot,
  RefreshCw,
  CircleHelp,
  ScanSearch,
} from 'lucide-react';
import type { OnboardingState } from '../../../../packages/core/src/onboarding';
import { getAutoReplyReadiness } from '../../../../packages/contracts/src/index';
import { api, client, perform, useAvailablePlatforms, useUi } from './api';
import { Button, Badge, Field } from './components/ui';
import { BrandMark } from './brand-mark';
import { AssistantModelSettings } from './components/assistant-model-settings';
import { EmbeddingModelSettings } from './components/embedding-model-settings';
import { AccountVerificationDialog } from './setup-fields';
import { QianniuSetup } from './components/qianniu-setup';
import { KnowledgeBootstrap } from './components/knowledge-bootstrap';

export async function openSetupGuide() {
  const result = await perform('app.settings', { setupGuideState: 'active' });
  if (result) useUi.getState().setPage('setup');
}
export function SetupGuide({
  data,
  stores,
  refresh,
  loading = false,
}: {
  data: OnboardingState;
  stores: any[];
  refresh: () => unknown;
  loading?: boolean;
}) {
  const ui = useUi();
  const platforms = useAvailablePlatforms();
  const [platform, setPlatform] = useState<PlatformId>('pinduoduo');
  const [step, setStep] = useState(data.nextStep);
  const [action, setBusy] = useState('');
  const busy = action || (loading ? 'refresh' : '');
  const [error, setError] = useState('');
  const [editingModel, setEditingModel] = useState(false);
  const [verify, setVerify] = useState<any>(null);
  const [learning, setLearning] = useState(false);
  const [enabledHere, setEnabledHere] = useState(false);
  const previousStore = useRef(data.store?.id);
  const selectedStore = stores.find((store) => store.id === data.store?.id);
  const connectedAccounts = (selectedStore?.accounts ?? []).filter(
    (account: any) => getAutoReplyReadiness([{ ...account, verifiedAt: true }]).ready,
  );
  useEffect(() => {
    if (previousStore.current !== data.store?.id) {
      const wasConnected = !!previousStore.current;
      previousStore.current = data.store?.id;
      setStep(wasConnected ? data.nextStep : 1);
      setError('');
      setEnabledHere(false);
      setLearning(false);
      setEditingModel(false);
    }
  }, [data.store?.id, data.nextStep]);
  const run = async (name: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      await client.invalidateQueries();
      setBusy('');
    }
  };
  const leave = (page: 'inbox' | 'knowledge' | 'learning' | 'settings', completed = false) =>
    run('leave', async () => {
      await api('app.settings', {
        setupGuideState: completed || enabledHere ? 'completed' : 'dismissed',
      });
      if (page === 'inbox') {
        ui.setInboxStore(data.store?.id ?? null);
      }
      ui.setPage(page);
    });
  const next = (value: number) => {
    setStep(value);
    setError('');
  };
  const complete = step === 5;
  return (
    <div className="setup-shell" aria-busy={!!busy}>
      <header className="setup-topbar">
        <div className="setup-brand">
          <div className="brand-icon">
            <BrandMark size={20} />
          </div>
          <strong>句达</strong>
          <Badge>接待配置</Badge>
        </div>
        <div className="setup-topbar-actions">
          <Button variant="ghost" disabled={!!busy} onClick={() => void leave('inbox', complete)}>
            {complete || data.enabled ? '返回接待中心' : '先人工接待，稍后配置'}
            <ArrowRight size={15} />
          </Button>
        </div>
      </header>
      <main className="setup-main">
        {!complete && (
          <ol className="setup-stepper" aria-label="首次配置进度">
            {[
              {
                id: 1,
                title: '连接店铺',
                detail: '接入平台消息',
                done: data.connected,
              },
              {
                id: 2,
                title: '问答检索',
                detail: '全局 Embedding',
                done: data.embedding.ready,
              },
              {
                id: 3,
                title: '配置助手',
                detail: '准备对话模型',
                done: data.agent.ready,
              },
              {
                id: 4,
                title: '开始接待',
                detail: '检查收发并开启',
                done: data.ready && data.enabled,
              },
            ].map((item) => (
              <li
                key={item.id}
                className={`${step === item.id ? 'current' : ''} ${item.done ? 'done' : ''}`}
              >
                <button
                  disabled={!!busy || (item.id > 1 && !data.store)}
                  aria-current={step === item.id ? 'step' : undefined}
                  onClick={() => next(item.id)}
                >
                  <span className="setup-step-number">
                    {item.done ? <Check size={16} /> : item.id}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className={`setup-content ${complete ? 'setup-complete' : ''}`}>
          {error && (
            <div className="setup-error" role="alert">
              {error}
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  void run('refresh', async () => {
                    await refresh();
                  })
                }
              >
                <RefreshCw size={14} />
                重新检查
              </Button>
            </div>
          )}
          {step === 1 && (
            <>
              <div className="setup-intro">
                <span className="setup-kicker">第 1 步 / 共 4 步</span>
                <h1>先把你的店铺连进来</h1>
                <p>选择平台并登录客服账号，进入聊天工作台。句达会自动识别店铺并连接消息。</p>
              </div>
              <section className="setup-card">
                <Field label="选择平台">
                  <select
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value as PlatformId)}
                    disabled={!!busy}
                  >
                    {platforms.map((id) => (
                      <option key={id} value={id}>
                        {platformNames[id]}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="setup-platform">
                  <span className="platform-icon">{platformMarks[platform]}</span>
                  <div>
                    <h2>{platformNames[platform]}</h2>
                    <p>
                      {platform === 'qianniu'
                        ? '登录在千牛客户端中完成，句达会自动识别店铺。'
                        : '登录在平台窗口中完成，无需向句达填写账号密码。'}
                    </p>
                  </div>
                  <Badge>已支持</Badge>
                </div>
                {!!stores.length && (
                  <Field label="本次配置的店铺">
                    <select
                      value={data.store?.id || ''}
                      disabled={!!busy}
                      onChange={(e) => ui.setStore(e.target.value)}
                    >
                      {stores
                        .filter((s) => s.accounts?.length)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {platformNames[s.platform as PlatformId]} · {s.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                )}
                {selectedStore?.accounts?.map((account: any) => {
                  const connected = getAutoReplyReadiness([{ ...account, verifiedAt: true }]).ready;
                  return (
                    <div className="setup-account" key={account.id}>
                      <div>
                        <strong>{account.name}</strong>
                        <p>
                          {account.connection?.reason ||
                            (connected
                              ? '消息通道已连接，可以继续。'
                              : '打开平台并进入客服聊天页，句达会自动检测连接。')}
                        </p>
                      </div>
                      <Badge tone={connected ? 'green' : 'orange'}>
                        {connected ? '已连接' : '等待连接'}
                      </Badge>
                      <Button
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void run('connect', async () => {
                            await api('accounts.connect', { accountId: account.id });
                          })
                        }
                      >
                        打开平台
                      </Button>
                    </div>
                  );
                })}
                {platform === 'qianniu' && <QianniuSetup />}
                {platform !== 'qianniu' && !selectedStore?.accounts?.length && (
                  <ol className="setup-instructions">
                    <li>
                      <span>1</span>打开下方的平台登录窗口
                    </li>
                    <li>
                      <span>2</span>登录客服账号，并进入客服聊天页
                    </li>
                    <li>
                      <span>3</span>回到这里，等待显示“已连接”
                    </li>
                  </ol>
                )}
                {platform !== 'qianniu' && (
                  <Button
                    variant={selectedStore ? 'secondary' : 'default'}
                    disabled={!!busy}
                    onClick={() =>
                      void run('connect', async () => {
                        await api('accounts.connect', { platform });
                      })
                    }
                  >
                    <PlugZap size={16} />
                    {busy === 'connect'
                      ? '正在打开…'
                      : selectedStore
                        ? '连接另一个账号'
                        : `登录${platformNames[platform]}`}
                  </Button>
                )}
                <p className="setup-note">
                  保持平台登录，消息会在后台同步。多个已连接平台可同时接待。
                </p>
              </section>
              <div className="setup-footer">
                <span>
                  {data.connected
                    ? '店铺已连接，下一步先设置全店共用的问答检索模型。'
                    : '连接成功后即可继续；也可以先用人工接待。'}
                </span>
                <Button disabled={!data.connected || !!busy} onClick={() => next(2)}>
                  下一步：设置问答检索
                  <ArrowRight size={16} />
                </Button>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="setup-intro">
                <span className="setup-kicker">第 2 步 / 共 4 步 · 全局配置</span>
                <h1>先设置问答检索模型</h1>
                <p>
                  这是全店共用的 Embedding，用来按含义匹配已有问答。填写 OpenAI 兼容的向量服务即可。
                </p>
              </div>
              <section className="setup-card">
                <EmbeddingModelSettings
                  key={`${data.store?.id || 'unconnected'}-embedding`}
                  data={data}
                  disabled={!!busy}
                />
              </section>
              <div className="setup-footer">
                <Button variant="ghost" disabled={!!busy} onClick={() => next(1)}>
                  <ArrowLeft size={16} />
                  上一步
                </Button>
                <Button disabled={!!busy} onClick={() => next(3)}>
                  {data.embedding.ready ? '下一步：配置助手' : '暂时跳过，配置助手'}
                  <ArrowRight size={16} />
                </Button>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="setup-intro">
                <span className="setup-kicker">第 3 步 / 共 4 步 · {data.store?.name}</span>
                <h1>给客服助手接上 AI</h1>
                <p>
                  选择或添加对话模型，直接应用到当前店铺的默认客服助手。已有配置也可以在这里更换。
                </p>
              </div>
              <section className="setup-card">
                <AssistantModelSettings
                  key={data.store?.id || 'unconnected'}
                  data={data}
                  disabled={!!busy}
                  onEditingChange={setEditingModel}
                  onAdvanced={() =>
                    void leave('settings').then(() => ui.setSettingsSection('advanced'))
                  }
                />
              </section>
              {data.store && (
                <KnowledgeBootstrap storeId={data.store.id} disabled={!!busy || editingModel} />
              )}
              <div className="setup-footer">
                <Button variant="ghost" disabled={!!busy} onClick={() => next(2)}>
                  <ArrowLeft size={16} />
                  上一步
                </Button>
                <Button
                  disabled={!data.agent.ready || !!busy || editingModel}
                  onClick={() => next(4)}
                >
                  下一步：开始接待
                  <ArrowRight size={16} />
                </Button>
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <div className="setup-intro">
                <span className="setup-kicker">第 4 步 / 共 4 步 · {data.store?.name}</span>
                <h1>检查好了，再交给 AI</h1>
                <p>
                  {data.enabled
                    ? '自动接待已经开启，可以在这里复核店铺、模型和收发状态。'
                    : '先用测试会话确认消息收发正常。点击下方按钮后，AI 才会开始接待新的买家消息。'}
                </p>
              </div>
              <section className="setup-card">
                <div className="setup-check-row">
                  <span className={data.connected ? 'passed' : ''}>
                    <PlugZap size={20} />
                  </span>
                  <div>
                    <h3>店铺消息已连接</h3>
                    <p>{data.store?.name || '请先连接店铺'}</p>
                  </div>
                  {data.connected ? (
                    <Badge tone="green">已完成</Badge>
                  ) : (
                    <Button variant="secondary" onClick={() => next(1)}>
                      去连接
                    </Button>
                  )}
                </div>
                <div className="setup-check-row">
                  <span className={data.agent.ready ? 'passed' : ''}>
                    <Sparkles size={20} />
                  </span>
                  <div>
                    <h3>AI 客服助手已配置</h3>
                    <p>
                      {data.agent.ready
                        ? `${data.agent.name} · ${data.agent.model}`
                        : '选择一个对话模型，准备好客服助手。'}
                    </p>
                  </div>
                  {data.agent.ready ? (
                    <Badge tone="green">已完成</Badge>
                  ) : (
                    <Button variant="secondary" onClick={() => next(3)}>
                      去配置
                    </Button>
                  )}
                </div>
                <div className="setup-check-row">
                  <span className={data.embedding.ready ? 'passed' : ''}>
                    <ScanSearch size={20} />
                  </span>
                  <div>
                    <h3>全局问答检索</h3>
                    <p>
                      {data.embedding.ready
                        ? `${data.embedding.name || data.embedding.model} · ${data.embedding.dimensions || '—'} 维`
                        : '可选。没配也能开接待，相近问法不会走语义直答。'}
                    </p>
                  </div>
                  {data.embedding.ready ? (
                    <Badge tone="green">已完成</Badge>
                  ) : (
                    <Button variant="secondary" onClick={() => next(2)}>
                      去设置
                    </Button>
                  )}
                </div>
                <div className="setup-check-row">
                  <span className={data.readiness.ready ? 'passed' : ''}>
                    <ShieldCheck size={20} />
                  </span>
                  <div>
                    <h3>确认账号收发正常</h3>
                    <p>
                      {data.readiness.ready
                        ? '已有账号完成收发确认，可以自动接待。'
                        : '用测试买家发消息、人工回复，确认双方都能收到。'}
                    </p>
                  </div>
                  {data.readiness.ready && <Badge tone="green">已完成</Badge>}
                </div>
                {!data.readiness.ready && (
                  <div className="setup-verification">
                    <p>先在接待中心完成一次人工收发测试，再回来确认。</p>
                    <div className="actions">
                      <Button
                        variant="secondary"
                        onClick={() => {
                          ui.setInboxStore(data.store?.id ?? null);
                          ui.setPage('inbox');
                        }}
                      >
                        去接待中心做收发测试
                        <ArrowRight size={15} />
                      </Button>
                      {connectedAccounts.map((account: any) => (
                        <Button
                          key={account.id}
                          disabled={!!busy}
                          variant="secondary"
                          onClick={() => setVerify(account)}
                        >
                          确认「{account.name}」收发正常
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {data.readiness.ready && selectedStore?.accounts?.length > 1 && (
                  <p className="setup-note">{data.readiness.reason}</p>
                )}
                <div className="setup-tip">
                  <CircleHelp size={18} />
                  <p>
                    查看会话或人工回复不影响 AI
                    接待；如需暂停，请点击“接管会话”。处理完成后点击“交还 AI”，只接待之后的新消息。
                  </p>
                </div>
              </section>
              <div className="setup-footer">
                <Button variant="ghost" disabled={!!busy} onClick={() => next(3)}>
                  <ArrowLeft size={16} />
                  上一步
                </Button>
                <Button
                  disabled={!data.ready || !!busy}
                  onClick={() =>
                    void run('enable', async () => {
                      if (!data.store) return;
                      await api('onboarding.enable', {
                        storeId: data.store.id,
                        expectedConfigEpoch: data.store.configEpoch,
                      });
                      setEnabledHere(true);
                      next(5);
                    })
                  }
                >
                  {busy === 'enable'
                    ? '正在开启…'
                    : data.enabled
                      ? '完成配置，进入下一步'
                      : '开启自动接待'}
                  <ArrowRight size={16} />
                </Button>
              </div>
            </>
          )}
          {complete && (
            <>
              <div className="setup-success-icon">
                <CheckCircle2 size={40} />
              </div>
              <div className="setup-intro">
                <span className="setup-kicker">配置完成</span>
                <h1>可以开始接待了</h1>
                <p>
                  「{data.store?.name}」的 AI
                  自动回复已开启。用测试买家发一条新消息，就能检验接待效果。
                </p>
              </div>
              <Button
                className="setup-enter"
                disabled={!!busy}
                onClick={() => void leave('inbox', true)}
              >
                进入接待中心
                <ArrowRight size={17} />
              </Button>
              <div className="setup-optional-heading">
                <h2>用起来之后，再慢慢完善</h2>
                <span>以下都不是开始接待的前提</span>
              </div>
              <div className="setup-optional-grid">
                <article>
                  <BookOpen size={23} />
                  <h3>补充店铺问答</h3>
                  <p>录入常见问题、发货和售后规则，让回复有据可依。支持文字和图片。</p>
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => void leave('knowledge', true)}
                  >
                    去完善问答库
                  </Button>
                </article>
                <article>
                  <Sparkles size={23} />
                  <h3>开启自动学习</h3>
                  <p>后台评估实际问答，积累可复用内容。所有新增或修改建议都先交给你审批。</p>
                  <Button
                    variant="secondary"
                    disabled={!!busy || learning || !!data.store?.autoLearnEnabled}
                    onClick={() =>
                      void run('learning', async () => {
                        if (!data.store) return;
                        await api('stores.policy', {
                          storeId: data.store.id,
                          autoLearnEnabled: true,
                          ...(selectedStore?.learningPolicy?.builtinModelRef
                            ? {}
                            : data.agent.modelId
                              ? { builtinModelRef: data.agent.modelId }
                              : {}),
                        });
                        setLearning(true);
                      })
                    }
                  >
                    {learning || data.store?.autoLearnEnabled
                      ? '自动学习已开启'
                      : '开启学习（另有模型用量）'}
                  </Button>
                </article>
                <article>
                  <Bot size={23} />
                  <h3>高级定制</h3>
                  <p>想自己编排 Agent、Skills 或 Toolkit？在系统设置中打开高级定制。</p>
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => void leave('settings', true)}
                  >
                    以后在设置中调整
                  </Button>
                </article>
              </div>
            </>
          )}
        </div>
        {!complete && (
          <p className="setup-bottom-note">
            配置会保存在本机，下次打开可以接着完成。任何时候都能从侧栏的“上手引导”回到这里。
          </p>
        )}
      </main>
      {verify && <AccountVerificationDialog account={verify} onClose={() => setVerify(null)} />}
    </div>
  );
}
