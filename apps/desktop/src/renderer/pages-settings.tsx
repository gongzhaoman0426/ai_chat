import { useEffect, useState } from 'react';
import { defaultModel, ModelFields, modelSaveInput } from './setup-fields';
import { openSetupGuide } from './pages-setup';
import {
  Activity,
  Plus,
  KeyRound,
  Database,
  Code2,
  RotateCcw,
  Download,
  Play,
  CheckCircle2,
  ArrowUpRight,
  Cloud,
  RefreshCw,
} from 'lucide-react';
import { api, client, useData, perform, useUi } from './api';
import { Button, Field, Modal, Toggle } from './components/ui';
import type { DesktopUpdateState } from '../../../../packages/contracts/src/index';

function UpdatePanel() {
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    void window.judesk.getUpdateState().then((state) => mounted && setUpdate(state));
    const off = window.judesk.onUpdate((state) => mounted && setUpdate(state));
    return () => {
      mounted = false;
      off();
    };
  }, []);
  const run = async (action: 'checkForUpdates' | 'downloadUpdate' | 'installUpdate') => {
    setBusy(true);
    try {
      const state = await window.judesk[action]();
      if (state) setUpdate(state);
    } catch (error) {
      setUpdate((current) => ({
        ...(current ?? { status: 'error', currentVersion: '未知', mode: 'manual' }),
        status: 'error',
        error: error instanceof Error ? error.message : '更新操作失败',
      }));
    } finally {
      setBusy(false);
    }
  };
  if (!update) return null;
  const statusText: Record<DesktopUpdateState['status'], string> = {
    disabled: '当前环境不支持更新检查',
    idle: '尚未检查',
    checking: '正在检查更新…',
    available: `发现新版本 ${update.version ?? ''}`,
    downloading: `正在下载 ${Math.round(update.progress ?? 0)}%`,
    downloaded: `新版本 ${update.version ?? ''} 已下载`,
    installing: '正在准备重启…',
    'not-available': '已是最新版本',
    error: update.error || '更新失败',
  };
  return (
    <div className="update-panel" aria-live="polite">
      <div>
        <strong>版本更新</strong>
        <p>
          当前版本 v{update.currentVersion} · {statusText[update.status]}
        </p>
        {update.mode === 'manual' && update.status !== 'available' && (
          <small>当前为手动安装模式，发现新版本后会打开下载链接。</small>
        )}
        {update.releaseNotes &&
          (update.status === 'available' || update.status === 'downloaded') && (
            <small>{update.releaseNotes}</small>
          )}
        {update.mode === 'manual' && update.status === 'available' && (
          <small>下载后请退出句达，再打开安装包完成更新。</small>
        )}
      </div>
      <div className="actions">
        {update.status === 'available' && (
          <Button disabled={busy} onClick={() => void run('downloadUpdate')}>
            {update.mode === 'manual' ? <ArrowUpRight size={15} /> : <Download size={15} />}
            {update.mode === 'manual' ? '打开下载链接' : '下载更新'}
          </Button>
        )}
        {update.status === 'downloaded' && (
          <Button disabled={busy} onClick={() => void run('installUpdate')}>
            <RefreshCw size={15} /> 更新并重启
          </Button>
        )}
        {update.status !== 'disabled' && update.status !== 'installing' && (
          <Button
            variant="secondary"
            disabled={busy || update.status === 'downloading'}
            onClick={() => void run('checkForUpdates')}
          >
            <RefreshCw size={15} /> 检查更新
          </Button>
        )}
      </div>
    </div>
  );
}
export function SettingsPage({ state, onChooseAi }: { state: any; onChooseAi?: () => void }) {
  const { data: models = [] } = useData<any[]>('models.list');
  const { data: account } = useData('license.state');
  const canUseByok = !!account && (!account.configured || !!account.canUseByok);
  const [model, setModel] = useState<any>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<any>(null);
  const ui = useUi();
  const section = ui.settingsSection === 'accounts' ? 'models' : ui.settingsSection;
  const setSection = ui.setSettingsSection;
  const [saving, setSaving] = useState(false);
  const [modelError, setModelError] = useState('');
  const applyToStore = () => ui.openStoreSettings(undefined, 2);

  return (
    <>
      <div className="page-heading settings-heading">
        <div>
          <h1>系统设置</h1>
          <p>管理模型连接、开发者功能与本地数据。各店接待配置在店铺管理中维护。</p>
        </div>
        <div className="setup-topbar-actions">
          {onChooseAi && (
            <Button variant="secondary" onClick={onChooseAi}>
              选择 AI 服务
            </Button>
          )}
          <Button variant="secondary" onClick={() => void openSetupGuide()}>
            打开上手引导
            <ArrowUpRight size={15} />
          </Button>
        </div>
      </div>
      <div className="page-body settings-body">
        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {[
            ['models', '模型服务', '管理可选用的模型'],
            ['advanced', '高级定制', '助手、技能与业务扩展'],
            ['data', '数据与备份', '本地数据管理'],
          ].map(([id, title, detail]) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              role="tab"
              aria-selected={section === id}
              aria-controls={`settings-panel-${id}`}
              onClick={() => {
                setSection(id as typeof section);
              }}
            >
              <strong>{title}</strong>
              <small>{detail}</small>
            </button>
          ))}
        </div>
        <div
          className="settings-grid"
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
        >
          {section === 'models' && (
            <section className="card settings-section">
              <div className="settings-title">
                <KeyRound size={21} />
                <div>
                  <h3>模型服务</h3>
                  <p>
                    {canUseByok
                      ? '可配置自有 API Key，或登录选用按量计费的云端 AI。'
                      : '免费版请使用云端按量 AI；配置自有 API Key 需要句达 Pro。'}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => ui.setPage('account')}>
                  <Cloud size={15} /> {canUseByok ? '云端 AI' : '云端 AI / 开通 Pro'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!canUseByok) {
                      ui.setPage('account');
                      return;
                    }
                    setModel(defaultModel());
                    setModelError('');
                  }}
                >
                  <Plus size={15} />
                  {canUseByok ? '添加自有模型' : '开通 Pro 添加自有模型'}
                </Button>
              </div>
              {models.length ? (
                <div className="model-list">
                  {models.map((m) => (
                    <div key={m.id}>
                      <div className="model-icon">{m.kind === 'embedding' ? 'E' : 'M'}</div>
                      <div>
                        <strong>{m.name}</strong>
                        <small>
                          {m.model} · {m.kind === 'embedding' ? 'Embedding' : '对话模型'}{' '}
                          {m.source === 'cloud'
                            ? '· 句达云端 AI'
                            : m.hasKey
                              ? '· 自有密钥'
                              : '· 自有服务'}
                        </small>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (m.source === 'cloud') {
                            ui.setPage('account');
                            return;
                          }
                          if (!canUseByok) {
                            ui.setPage('account');
                            return;
                          }
                          setModel({ ...m, apiKey: '' });
                          setModelError('');
                        }}
                      >
                        {m.source === 'cloud' ? '云端管理' : canUseByok ? '编辑' : '需 Pro'}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={testing === m.id}
                        onClick={async () => {
                          setTesting(m.id);
                          const result = await perform('models.test', { id: m.id });
                          setTestResult(result ? m.name : null);
                          setTesting(null);
                        }}
                      >
                        <Play size={14} />
                        {testing === m.id ? '测试中' : '测试'}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint">
                  添加兼容 OpenAI 协议的对话与 Embedding 模型。未配置模型时，人工接待仍可使用。
                </p>
              )}
              {models.length > 0 && (
                <div className="settings-model-next">
                  <div>
                    <strong>为店铺指定回复模型</strong>
                    <p>
                      前往店铺管理，为客服助手选择模型。已有本店助手修改模型参数后，也需要重新应用。
                    </p>
                  </div>
                  <Button variant="secondary" onClick={applyToStore}>
                    前往店铺配置助手
                    <ArrowUpRight size={15} />
                  </Button>
                </div>
              )}
              <details className="settings-advanced">
                <summary>
                  全局默认与知识检索 <span>可选，适用于多店共用与语义检索</span>
                </summary>
                <div className="form-two">
                  <Field
                    label="全局默认助手模型"
                    hint="更改后应用到使用全局默认助手的店铺，也供未单独选模型的学习任务使用。日常换模型请使用「店铺管理 → 客服助手」。"
                  >
                    <select
                      value={state?.settings.defaultModelId || ''}
                      onChange={(e) =>
                        perform(
                          'app.settings',
                          { defaultModelId: e.target.value || null },
                          '默认模型已更新',
                        )
                      }
                    >
                      <option value="" disabled>
                        尚未配置
                      </option>
                      {models
                        .filter((m) => m.kind === 'chat')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field
                    label="意图向量模型"
                    hint="用于按含义检索问答，不负责生成回复。切换后会后台重建知识索引。"
                  >
                    <select
                      value={state?.settings.embeddingProfileId || ''}
                      onChange={(e) =>
                        perform(
                          'app.settings',
                          { embeddingProfileId: e.target.value || null },
                          '已安排索引更新',
                        )
                      }
                    >
                      <option value="">尚未配置</option>
                      {models
                        .filter((m) => m.kind === 'embedding')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              </details>
              <p className="hint">
                测试会发起一次简短模型请求，云端 AI 按用量扣费。自有 API Key 使用操作系统加密存储。
              </p>
              {testResult && (
                <p className="model-save-status" role="status">
                  <CheckCircle2 size={16} />「{testResult}」连接测试通过
                </p>
              )}
            </section>
          )}
          {section === 'advanced' && (
            <section className="card settings-section">
              <div className="settings-title">
                <Code2 size={21} />
                <div>
                  <h3>开发者模式</h3>
                  <p>免费使用 Agent、Skills、Toolkit、Workflow、子 Agent 及 Agent 执行过程</p>
                </div>
              </div>
              <Toggle
                label="显示开发者工具"
                checked={!!state?.settings.developerModeEnabled}
                onChange={(v) => perform('app.settings', { developerModeEnabled: v })}
              />
              <p className="hint">
                开启后在侧栏显示助手、工具与执行过程入口。关闭会隐藏这些页面，不改变当前工作绑定，也不停止自动接待。
              </p>
              {!state?.hasDefaultAgent && (
                <div className="restore-default">
                  <div>
                    <strong>默认回复 Agent 已删除</strong>
                    <p>知识直答仍可运行；未命中时转人工。不会因重启而自动重建。</p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => perform('agents.restoreDefault', {}, '默认 Agent 已加回')}
                  >
                    <RotateCcw size={15} />
                    加回默认 Agent
                  </Button>
                </div>
              )}
            </section>
          )}
          {section === 'data' && (
            <section className="card settings-section">
              <div className="settings-title">
                <Database size={21} />
                <div>
                  <h3>本地数据</h3>
                  <p>会话、知识、审批和任务记录保存在本机</p>
                </div>
              </div>
              <div className="data-path">{state?.dataDir || '正在读取数据目录'}</div>
              <div className="actions">
                <Button
                  variant="secondary"
                  onClick={() => perform('backup.create', {}, '备份已保存')}
                >
                  <Download size={15} />
                  创建完整备份
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (
                      window.confirm(
                        '恢复将用所选备份替换本地业务数据，并保留当前数据副本。恢复后应用重启，自动回复保持关闭。',
                      )
                    )
                      void perform('backup.restore');
                  }}
                >
                  <RotateCcw size={15} />
                  恢复备份
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => perform('diagnostics.export', {}, '诊断已导出')}
                >
                  <Activity size={15} />
                  导出诊断
                </Button>
              </div>
              <UpdatePanel />
              <p className="hint">
                账号 Cookie 和 API Key
                不随知识或诊断导出。模型请求仍会将必要上下文发送给你配置的服务。
              </p>
            </section>
          )}
        </div>
      </div>
      <Modal
        open={!!model}
        onOpenChange={(open) => !open && !saving && setModel(null)}
        title={model?.id ? '编辑模型服务' : '添加模型服务'}
        description="填写模型服务商的三个连接信息。保存后可在店铺接待中应用到助手。"
      >
        {model && (
          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              if (saving) return;
              setSaving(true);
              setModelError('');
              try {
                await api('models.save', modelSaveInput(model));
                await client.invalidateQueries();
                setModel(null);
                setTestResult(null);
                ui.notify('模型服务已保存，可到店铺接待中应用到助手');
              } catch (e) {
                setModelError(e instanceof Error ? e.message : '保存失败');
              } finally {
                setSaving(false);
              }
            }}
          >
            <fieldset disabled={saving}>
              <ModelFields model={model} onChange={setModel} />
              {modelError && (
                <p className="setup-error" role="alert">
                  {modelError}
                </p>
              )}
              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={() => setModel(null)}>
                  取消
                </Button>
                <Button type="submit">{saving ? '保存中…' : '保存模型服务'}</Button>
              </div>
            </fieldset>
          </form>
        )}
      </Modal>
    </>
  );
}
