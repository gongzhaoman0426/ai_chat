import { findMountedAsset } from './draft';
import type { ResourceScopeRecord } from '../../../../../../packages/contracts/src/resource-scope';
import { ResourceScopeEditor, AgentStorePreview, scopeFor } from '../resource-scope';
import { platformNames, type PlatformId } from '../../../../../../packages/contracts/src/platform';
import type { SkillInput, SkillRecord } from '../../../../../../packages/contracts/src/index';
import { SkillEditor } from '../skills/editor';
import { SkillPicker } from '../skills/picker';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Blocks,
  BookOpenText,
  Bot,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Ellipsis,
  FileText,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Waypoints,
  X,
} from 'lucide-react';
import { api, client, date, useAvailablePlatforms, useUi } from '../../api';
import { Badge, Button, Empty, Field, Modal, Toggle } from '../ui';
import { AssetMountDialog, SubAgentDialog } from './dialogs';
import {
  errorText,
  mountKey,
  mountLabel,
  useAgentDraft,
  publicationStatus,
  type AgentRecord,
  type AgentRevision,
  type AssetOption,
  type ModelOption,
  type MountKind,
} from './draft';

type DebugOutput = {
  text?: string;
  result?: { text?: string; action?: string; reasonCode?: string };
  usage?: { totalTokens?: number };
};
type Trial = {
  input: string;
  revision: number;
  skillsVersion: string;
  output?: DebugOutput;
  error?: string;
};

export function AgentStudio({
  initial,
  agents,
  models,
  assets,
  skills,
  onClose,
  onSwitch,
}: {
  initial: AgentRecord;
  agents: AgentRecord[];
  models: ModelOption[];
  assets: AssetOption[];
  skills: SkillRecord[];
  onClose: () => void;
  onSwitch: (record: AgentRecord) => void;
}) {
  const platforms = useAvailablePlatforms();
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [tab, setTab] = useState<'persona' | 'memory'>('persona');
  const [mount, setMount] = useState<MountKind | null>(null);
  const [pickingSkills, setPickingSkills] = useState(false);
  const [skillEditor, setSkillEditor] = useState<{ initial?: SkillInput | SkillRecord } | null>(
    null,
  );
  const [subIndex, setSubIndex] = useState<number | null>(null);
  const [history, setHistory] = useState(false);
  const [restore, setRestore] = useState<AgentRevision | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testInput, setTestInput] = useState('');
  const [debugPlatform, setDebugPlatform] = useState<PlatformId>('pinduoduo');
  const [trials, setTrials] = useState<Trial[]>([]);
  const [runningInput, setRunningInput] = useState('');
  const editor = useAgentDraft(initial, !!busy || deleting || !!restore || leaving || reloading);
  const { record, config, patch, dirty, saving, saveError, validationError } = editor;
  const debugScroll = useRef<HTMLDivElement>(null);
  const chatModels = models.filter((m) => m.kind === 'chat');
  const model = chatModels.find((m) => m.id === config.modelProfileId);
  const notice = validationError || saveError || error;
  const lastTrial = trials.at(-1);
  const publishedState = publicationStatus(record, config);
  const skillsVersion = JSON.stringify(
    config.skillIds.map((id) => [id, skills.find((s) => s.id === id)?.revision ?? null]),
  );

  useEffect(() => {
    if (debugScroll.current) debugScroll.current.scrollTop = debugScroll.current.scrollHeight;
  }, [trials, busy]);

  useEffect(() => {
    if (!more) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.studio-more')) setMore(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [more]);

  const run = async (action: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setError(null);
    setMore(false);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  const close = () => {
    if (busyRef.current) return;
    if (dirty && (saveError || validationError)) {
      setLeaving(true);
      return;
    }
    void run('close', async () => {
      try {
        await editor.flush();
        onClose();
      } catch {
        setLeaving(true);
      }
    });
  };
  const debug = () => {
    if (busyRef.current || !testInput.trim() || !model || validationError) return;
    const input = testInput.trim();
    void run('debug', async () => {
      const saved = await editor.flush();
      setRunningInput(input);
      try {
        const output = await api<DebugOutput>('agents.debug', {
          id: saved.id,
          input,
          platform: debugPlatform,
        });
        setTrials((items) => [
          ...items,
          { input, revision: saved.draftRevision, skillsVersion, output },
        ]);
      } catch (e) {
        setTrials((items) => [
          ...items,
          { input, revision: saved.draftRevision, skillsVersion, error: errorText(e) },
        ]);
      } finally {
        setRunningInput('');
      }
    });
  };
  const saveStatus = saving
    ? '正在保存…'
    : saveError || (dirty && validationError)
      ? '草稿未保存'
      : dirty
        ? '等待自动保存'
        : '已保存到本机';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay agent-studio-overlay" />
        <Dialog.Content
          className="agent-studio-dialog"
          aria-describedby="agent-studio-description"
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById('studio-agent-name')?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (more) {
              event.preventDefault();
              setMore(false);
            }
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              void run('save', async () => {
                await editor.flush();
              });
            }
          }}
        >
          <Dialog.Title className="studio-sr-only">编排 Agent</Dialog.Title>
          <Dialog.Description className="studio-sr-only" id="agent-studio-description">
            编辑人设、挂载能力并隔离试运行。草稿自动保存，发布后自动更新所有使用此 Agent 的店铺。
          </Dialog.Description>
          <header className="studio-header">
            <div className="studio-identity">
              <div className="studio-avatar">
                <Bot size={24} strokeWidth={1.7} />
              </div>
              <div className="studio-identity-copy">
                <div className="studio-eyebrow">
                  AGENT STUDIO <span>/ 回复 Agent</span>
                </div>
                <input
                  id="studio-agent-name"
                  aria-label="Agent 名称"
                  value={config.name}
                  maxLength={80}
                  disabled={!!busy}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
            </div>
            <div className="studio-header-actions">
              <div className="studio-more">
                <Button
                  variant="ghost"
                  aria-label="更多 Agent 操作"
                  aria-expanded={more}
                  disabled={!!busy}
                  onClick={() => setMore(!more)}
                >
                  <Ellipsis size={19} />
                </Button>
                {more && (
                  <div className="studio-more-menu">
                    <button
                      onClick={() => {
                        setMore(false);
                        setHistory(true);
                      }}
                    >
                      <History size={15} />
                      发布记录
                    </button>
                    <button
                      onClick={() =>
                        void run('copy', async () => {
                          const saved = await editor.flush();
                          const sourceScope = scopeFor(
                            await api<ResourceScopeRecord[]>('resources.scopes'),
                            'agent',
                            saved.id,
                          );
                          const copy = await api<AgentRecord>('agents.save', {
                            storeScope: {
                              mode: sourceScope?.mode ?? 'all',
                              storeIds: sourceScope?.storeIds ?? [],
                            },
                            config: {
                              ...saved.draftConfig,
                              name: `${saved.name.slice(0, 77)} 副本`,
                            },
                          });
                          void client.invalidateQueries({ queryKey: ['agents.list'] });
                          onSwitch({ ...copy, revisions: [] });
                        })
                      }
                    >
                      <Copy size={15} />
                      复制为新 Agent
                    </button>
                    <button
                      onClick={() =>
                        void run('export', async () => {
                          const saved = await editor.flush();
                          await api('agents.export', { id: saved.id });
                        })
                      }
                    >
                      <Download size={15} />
                      导出配置
                    </button>
                    <button
                      className="is-danger"
                      onClick={() => {
                        setMore(false);
                        setDeleting(true);
                      }}
                    >
                      <Trash2 size={15} />
                      删除 Agent
                    </button>
                  </div>
                )}
              </div>
              <span className="studio-toolbar-divider" />
              <Button
                variant="secondary"
                disabled={!!busy || saving || !dirty || !!validationError}
                onClick={() =>
                  void run('save', async () => {
                    await editor.flush();
                  })
                }
              >
                {saving ? <Loader2 size={15} className="studio-spin" /> : <Save size={15} />}
                保存草稿
              </Button>
              <Button
                disabled={!!busy || !!validationError || !model}
                title={!model ? '先选择对话模型' : '发布后自动更新所有使用此 Agent 的店铺'}
                onClick={() =>
                  void run('publish', async () => {
                    const saved = await editor.flush();
                    const revision = await api<AgentRevision>('agents.publish', {
                      id: saved.id,
                      expectedRevision: saved.draftRevision,
                    });
                    editor.replace({
                      ...saved,
                      revisions: [revision, ...saved.revisions.filter((r) => r.id !== revision.id)],
                    });
                    void client.invalidateQueries();
                    useUi.getState().notify('已发布，所有使用此 Agent 的店铺已同步更新');
                  })
                }
              >
                {busy === 'publish' ? (
                  <Loader2 size={15} className="studio-spin" />
                ) : (
                  <Upload size={15} />
                )}
                发布
              </Button>
              <button
                className="studio-close"
                aria-label="关闭 Agent 编辑器"
                title="关闭"
                disabled={!!busy}
                onClick={close}
              >
                <X size={20} />
              </button>
            </div>
          </header>
          <div className="studio-statusbar">
            <div>
              <Badge
                tone={
                  publishedState === '已发布'
                    ? 'green'
                    : publishedState === '有修改待发布'
                      ? 'orange'
                      : 'neutral'
                }
              >
                {publishedState}
              </Badge>
              <span
                className={`studio-save-state ${dirty || saveError ? 'is-pending' : ''}`}
                role="status"
              >
                {saving ? (
                  <Loader2 size={12} className="studio-spin" />
                ) : dirty || saveError ? (
                  <span className="studio-status-dot" />
                ) : (
                  <CheckCircle2 size={12} />
                )}{' '}
                {saveStatus}
              </span>
            </div>
            <span>
              {record.revisions[0]
                ? `最近发布于 ${date(record.revisions[0].publishedAt)}`
                : '发布后可用于店铺接待'}
            </span>
          </div>
          {notice && (
            <div className="studio-notice" role="alert">
              <span>{notice}</span>
              {saveError && !validationError && (
                <div className="actions">
                  <Button
                    variant="ghost"
                    disabled={!!busy || saving}
                    onClick={() =>
                      void run('save', async () => {
                        await editor.flush();
                      })
                    }
                  >
                    重试保存
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!!busy || saving}
                    onClick={() => setReloading(true)}
                  >
                    重新加载草稿
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="studio-columns">
            <section className="studio-panel studio-persona">
              <header
                className="studio-panel-header studio-tabs"
                role="group"
                aria-label="配置分组"
              >
                <button aria-pressed={tab === 'persona'} onClick={() => setTab('persona')}>
                  <FileText size={14} />
                  人设与回复逻辑
                </button>
                <button aria-pressed={tab === 'memory'} onClick={() => setTab('memory')}>
                  <Settings2 size={14} />
                  记忆与执行
                </button>
              </header>
              <fieldset
                disabled={!!busy}
                className={`agent-fieldset studio-panel-scroll ${tab === 'persona' ? 'studio-persona-fields' : ''}`}
              >
                {tab === 'persona' ? (
                  <>
                    <Field label="对话模型">
                      <select
                        aria-label="对话模型"
                        value={config.modelProfileId || ''}
                        onChange={(e) => patch({ modelProfileId: e.target.value || null })}
                      >
                        <option value="">选择模型配置</option>
                        {config.modelProfileId && !model && (
                          <option aria-label="对话模型" value={config.modelProfileId}>
                            原模型已不可用，请重新选择
                          </option>
                        )}
                        {chatModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {!model && (
                      <p className="studio-model-hint">
                        {chatModels.length
                          ? '选好模型后，就可以试运行和发布。'
                          : '还没有对话模型，请先到系统设置添加。草稿可以继续编辑。'}
                      </p>
                    )}
                    <div className="studio-prompt-heading">
                      <label htmlFor="studio-prompt">
                        <Pencil size={14} />
                        系统提示词
                      </label>
                      <span>Markdown</span>
                    </div>
                    <textarea
                      id="studio-prompt"
                      className="studio-prompt-editor"
                      spellCheck={false}
                      maxLength={30000}
                      value={config.prompt}
                      onChange={(e) => patch({ prompt: e.target.value })}
                      placeholder={
                        '# 角色\n你是一位店铺客服…\n\n# 回复原则\n根据知识和工具结果回答，不确定时转人工。'
                      }
                    />
                    <div className="studio-prompt-footer">
                      <span>{config.prompt.length.toLocaleString()} / 30,000 字符</span>
                      <span>
                        <Sparkles size={12} />
                        定义角色、边界和回复方式
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="studio-setting-intro">
                      <Settings2 size={20} />
                      <h3>让每次执行有清晰的边界</h3>
                      <p>设置 Agent 能参考的消息数量，以及工具调用和协作的执行上限。</p>
                    </div>
                    <Field label="近期消息数" hint="纳入上下文的近期消息，范围 0–80 条。">
                      <input
                        type="number"
                        min={0}
                        max={80}
                        step={1}
                        aria-label="近期消息数"
                        value={config.memory.lastMessages}
                        onChange={(e) =>
                          patch({
                            memory: { ...config.memory, lastMessages: Number(e.target.value) },
                          })
                        }
                      />
                    </Field>
                    <div className="studio-memory-setting">
                      <Toggle
                        label="启用会话工作记忆"
                        checked={config.memory.workingMemory}
                        disabled={!!busy}
                        onChange={(workingMemory) =>
                          patch({ memory: { ...config.memory, workingMemory } })
                        }
                      />
                      <p>保留当前会话的工作信息，帮助后续回复延续上下文。</p>
                    </div>
                    <div className="studio-section-divider" />
                    <Field label="最大执行步骤" hint="单次执行最多允许 1–20 个步骤。">
                      <input
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        aria-label="最大执行步骤"
                        value={config.maxSteps}
                        onChange={(e) => patch({ maxSteps: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="子 Agent 最大深度" hint="子 Agent 协作的嵌套深度，范围 1–4 层。">
                      <input
                        type="number"
                        min={1}
                        max={4}
                        step={1}
                        aria-label="子 Agent 最大深度"
                        value={config.maxDepth}
                        onChange={(e) => patch({ maxDepth: Number(e.target.value) })}
                      />
                    </Field>
                  </>
                )}
              </fieldset>
            </section>
            <section className="studio-panel studio-capabilities">
              <header className="studio-panel-header">
                <h2>
                  <Blocks size={15} />
                  能力配置
                </h2>
                <span className="studio-count">
                  {config.skillIds.length +
                    config.toolkitIds.length +
                    config.workflowIds.length +
                    config.subAgents.length}
                </span>
              </header>
              <fieldset disabled={!!busy} className="agent-fieldset studio-panel-scroll">
                <ResourceScopeEditor kind="agent" id={record.id} />
                <AgentStorePreview
                  agentId={record.id}
                  config={config}
                  agents={agents}
                  assets={assets}
                  skills={skills}
                />
                <p className="studio-capability-intro">
                  组合技能、工具、流程和专业助手。“店铺客服工具”会随当前接待店铺自动选择平台能力。
                </p>
                <details className="studio-capability" open>
                  <summary>
                    <BookOpenText size={16} />
                    <strong>Skills</strong>
                    <span className="studio-count">{config.skillIds.length}</span>
                    <ChevronDown size={14} />
                  </summary>
                  <div className="studio-capability-content">
                    {config.skillIds.map((id) => {
                      const skill = skills.find((s) => s.id === id);
                      return (
                        <div className={`studio-mounted ${!skill ? 'is-missing' : ''}`} key={id}>
                          <div className="studio-resource-icon skill">
                            <BookOpenText size={16} />
                          </div>
                          <button
                            className="studio-mounted-copy studio-mounted-edit"
                            aria-label={`编辑技能 ${skill?.name || id}`}
                            disabled={!skill}
                            onClick={() => setSkillEditor({ initial: skill })}
                          >
                            <strong title={skill?.description}>
                              {skill?.name || '技能已删除或缺失'}
                            </strong>
                            <small>
                              {skill
                                ? `${Object.keys(skill.references).length} 份资料 · ${Object.keys(skill.scripts).length} 个脚本 · ${date(skill.updatedAt)} 更新`
                                : '请移除或替换后再发布'}
                            </small>
                          </button>
                          <button
                            className="studio-icon-button"
                            aria-label={`移除技能 ${skill?.name || id}`}
                            onClick={() =>
                              patch({ skillIds: config.skillIds.filter((v) => v !== id) })
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                    {!config.skillIds.length && (
                      <p className="studio-capability-empty">
                        添加处理方法和参考资料，Agent 按需加载。
                      </p>
                    )}
                    <button className="studio-add" onClick={() => setPickingSkills(true)}>
                      <Plus size={14} />
                      添加 Skill
                    </button>
                    <button
                      className="studio-add"
                      disabled={config.skillIds.length >= 30}
                      onClick={() => setSkillEditor({})}
                    >
                      <Plus size={14} />
                      新建并挂载技能
                    </button>
                  </div>
                </details>
                {(['toolkit', 'workflow'] as const).map((kind) => {
                  const ids = config[mountKey[kind]];
                  const Icon = kind === 'toolkit' ? Blocks : Waypoints;
                  return (
                    <details key={kind} className="studio-capability" open>
                      <summary>
                        <Icon size={16} />
                        <strong>{mountLabel[kind]}</strong>
                        <span className="studio-count">{ids.length}</span>
                        <ChevronDown size={14} />
                      </summary>
                      <div className="studio-capability-content">
                        {ids.map((id) => {
                          const asset = findMountedAsset(assets, kind, id);
                          return (
                            <div
                              className={`studio-mounted ${asset?.status !== 'enabled' ? 'is-missing' : ''}`}
                              key={id}
                            >
                              <div className={`studio-resource-icon ${kind}`}>
                                <Icon size={16} />
                              </div>
                              <div className="studio-mounted-copy">
                                <strong title={id}>{asset?.manifest.name || '资源已缺失'}</strong>
                                <small>
                                  {asset
                                    ? `${kind === 'toolkit' ? '自动跟随最新 · 当前 ' : ''}v${asset.version} · ${asset.manifest.members.length} 个成员${asset.status !== 'enabled' ? ' · 已停用' : ''}`
                                    : id}
                                </small>
                              </div>
                              <button
                                className="studio-icon-button"
                                aria-label={`移除 ${asset?.manifest.name || id}`}
                                onClick={() =>
                                  patch({ [mountKey[kind]]: ids.filter((v) => v !== id) })
                                }
                              >
                                <X size={14} />
                              </button>
                            </div>
                          );
                        })}
                        {!ids.length && (
                          <p className="studio-capability-empty">
                            {kind === 'toolkit'
                              ? '添加查询、计算等可调用工具。'
                              : '添加可复用的业务处理流程。'}
                          </p>
                        )}
                        <button className="studio-add" onClick={() => setMount(kind)}>
                          <Plus size={14} />
                          添加 {mountLabel[kind]}
                        </button>
                      </div>
                    </details>
                  );
                })}
                <details className="studio-capability" open>
                  <summary>
                    <Bot size={16} />
                    <strong>子 Agent</strong>
                    <span className="studio-count">{config.subAgents.length}</span>
                    <ChevronDown size={14} />
                  </summary>
                  <div className="studio-capability-content">
                    {config.subAgents.map((sub, index) => {
                      const agent = agents.find((a) =>
                        a.revisions.some((r) => r.id === sub.revisionId),
                      );
                      const revision = agent?.revisions.find((r) => r.id === sub.revisionId);
                      return (
                        <div
                          className={`studio-mounted ${!agent ? 'is-missing' : ''}`}
                          key={`${index}:${sub.alias}`}
                        >
                          <div className="studio-resource-icon subagent">
                            <Bot size={16} />
                          </div>
                          <button
                            className="studio-mounted-copy studio-mounted-edit"
                            aria-label={`编辑子 Agent ${sub.alias}`}
                            onClick={() => setSubIndex(index)}
                          >
                            <strong>{agent?.name || 'Agent 已不可用'}</strong>
                            <small>
                              {sub.alias} · {revision ? '使用已发布配置' : '发布记录缺失'}
                            </small>
                          </button>
                          <button
                            className="studio-icon-button"
                            aria-label={`移除子 Agent ${sub.alias}`}
                            onClick={() =>
                              patch({ subAgents: config.subAgents.filter((_, i) => i !== index) })
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                    {!config.subAgents.length && (
                      <p className="studio-capability-empty">让专业助手分担特定任务。</p>
                    )}
                    <button
                      className="studio-add"
                      disabled={!!busy || config.subAgents.length >= 8}
                      onClick={() => setSubIndex(-1)}
                    >
                      <Plus size={14} />
                      添加子 Agent
                    </button>
                  </div>
                </details>
                <details className="studio-capability studio-basic-info">
                  <summary>
                    <FileText size={16} />
                    <strong>基本信息</strong>
                    <ChevronDown size={14} />
                  </summary>
                  <div className="studio-capability-content">
                    <Field label="Agent 说明" hint="帮助你在列表中识别这个 Agent。">
                      <textarea
                        rows={4}
                        maxLength={1000}
                        value={config.description}
                        placeholder="这个 Agent 负责什么工作？"
                        onChange={(e) => patch({ description: e.target.value })}
                      />
                    </Field>
                  </div>
                </details>
              </fieldset>
            </section>
            <section className="studio-panel studio-preview">
              <header className="studio-panel-header">
                <h2>
                  <MessageSquare size={15} />
                  预览与调试
                </h2>
                <button
                  className="studio-icon-button"
                  aria-label="清空试运行记录"
                  title="清空试运行记录"
                  disabled={!!busy || !trials.length}
                  onClick={() => setTrials([])}
                >
                  <RotateCcw size={15} />
                </button>
              </header>
              <div className="studio-debug-notice">
                <ShieldCheck size={13} />
                <span>隔离试运行 · 不向真实买家发送消息</span>
              </div>
              <Field label="模拟店铺平台">
                <select
                  aria-label="模拟店铺平台"
                  value={debugPlatform}
                  disabled={!!runningInput}
                  onChange={(event) => setDebugPlatform(event.target.value as PlatformId)}
                >
                  {platforms.map((id) => (
                    <option key={id} value={id}>
                      {platformNames[id]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="studio-debug-scroll" ref={debugScroll} aria-live="polite">
                {!trials.length && !runningInput && (
                  <div className="studio-debug-empty">
                    <div>
                      <Bot size={32} strokeWidth={1.3} />
                    </div>
                    <h3>从一条买家消息开始</h3>
                    <p>
                      看看它如何回答、使用工具，
                      <br />
                      以及何时选择转人工。
                    </p>
                    <span>每次试运行都是独立场景</span>
                  </div>
                )}
                {trials.map((trial, index) => (
                  <div className="studio-trial" key={index}>
                    <div className="studio-user-message">{trial.input}</div>
                    <div className="studio-trial-heading">
                      <Bot size={14} />
                      <strong>Agent</strong>
                      <span>草稿试运行</span>
                    </div>
                    {trial.error ? (
                      <p className="studio-error" role="alert">
                        {trial.error}
                      </p>
                    ) : (
                      <>
                        <div className="studio-agent-message">
                          {trial.output?.text ||
                            trial.output?.result?.text ||
                            trial.output?.result?.reasonCode ||
                            '本次未生成文字回复'}
                        </div>
                        <div className="studio-trial-meta">
                          <Badge
                            tone={trial.output?.result?.action === 'reply' ? 'green' : 'neutral'}
                          >
                            {trial.output?.result?.action === 'handoff'
                              ? '转人工'
                              : trial.output?.result?.action === 'reply'
                                ? '生成回复'
                                : '执行完成'}
                          </Badge>
                          {trial.output?.usage?.totalTokens !== undefined && (
                            <span>{trial.output.usage.totalTokens.toLocaleString()} tokens</span>
                          )}
                        </div>
                        <details className="studio-trial-details">
                          <summary>
                            运行详情
                            <ChevronDown size={12} />
                          </summary>
                          <pre>{JSON.stringify(trial.output, null, 2)}</pre>
                        </details>
                      </>
                    )}
                  </div>
                ))}
                {runningInput && (
                  <div className="studio-trial">
                    <div className="studio-user-message">{runningInput}</div>
                    <div className="studio-debug-running">
                      <Loader2 size={16} className="studio-spin" />
                      Agent 正在试运行…
                    </div>
                  </div>
                )}
              </div>
              <div className="studio-debug-composer">
                {lastTrial &&
                  (dirty ||
                    lastTrial.revision !== record.draftRevision ||
                    lastTrial.skillsVersion !== skillsVersion) && (
                    <p className="studio-preview-stale">配置已更新，重新试运行可查看效果。</p>
                  )}
                {!trials.length && (
                  <div className="studio-test-examples">
                    <button disabled={!!busy} onClick={() => setTestInput('什么时候发货？')}>
                      什么时候发货？
                    </button>
                    <button disabled={!!busy} onClick={() => setTestInput('帮我转人工')}>
                      帮我转人工
                    </button>
                  </div>
                )}
                <textarea
                  aria-label="试运行买家消息"
                  placeholder="输入一条买家消息…"
                  rows={3}
                  maxLength={10000}
                  value={testInput}
                  disabled={!!busy}
                  onChange={(e) => setTestInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      debug();
                    }
                  }}
                />
                <div className="studio-debug-submit">
                  <span>{model ? '点击时调用所选模型' : '请先选择对话模型'}</span>
                  <Button
                    disabled={!!busy || !model || !testInput.trim() || !!validationError}
                    onClick={debug}
                  >
                    {busy === 'debug' ? (
                      <Loader2 size={14} className="studio-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    试运行
                  </Button>
                </div>
              </div>
            </section>
          </div>
          <footer className="studio-footer">
            <span>
              <ShieldCheck size={13} />
              草稿自动保存。点击发布，所有使用此 Agent 的店铺自动更新。
            </span>
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() =>
                void run('bindings', async () => {
                  await editor.flush();
                  onClose();
                  useUi.getState().setPage('bindings');
                })
              }
            >
              前往工作绑定
              <ArrowRight size={14} />
            </Button>
          </footer>

          {pickingSkills && (
            <SkillPicker
              skills={skills}
              value={config.skillIds}
              onApply={(skillIds) => patch({ skillIds })}
              onClose={() => setPickingSkills(false)}
            />
          )}
          {skillEditor && (
            <SkillEditor
              initial={skillEditor.initial}
              onClose={() => setSkillEditor(null)}
              onSaved={(skill) => {
                if (!config.skillIds.includes(skill.id))
                  patch({ skillIds: [...config.skillIds, skill.id] });
                setSkillEditor(null);
              }}
            />
          )}
          {mount && (
            <AssetMountDialog
              kind={mount}
              assets={assets}
              value={config[mountKey[mount]]}
              onApply={(value) => patch({ [mountKey[mount]]: value })}
              onClose={() => setMount(null)}
            />
          )}
          {subIndex !== null && (
            <SubAgentDialog
              agents={agents}
              currentId={record.id}
              siblings={config.subAgents.filter((_, i) => i !== subIndex)}
              initial={config.subAgents[subIndex]}
              onApply={(value) =>
                patch({
                  subAgents:
                    subIndex < 0
                      ? [...config.subAgents, value]
                      : config.subAgents.map((sub, i) => (i === subIndex ? value : sub)),
                })
              }
              onClose={() => setSubIndex(null)}
            />
          )}
          {history && (
            <Modal
              open
              onOpenChange={(open) => !open && !busyRef.current && setHistory(false)}
              title="发布记录"
              description="按时间查看发布记录。恢复为草稿后，再次发布才会更新店铺接待。"
            >
              <div className="studio-history-list">
                {record.revisions.map((revision, index) => (
                  <div key={revision.id}>
                    <div className="studio-history-icon">
                      <History size={17} />
                    </div>
                    <div>
                      <strong>
                        {date(revision.publishedAt)}{' '}
                        {index === 0 && <Badge tone="green">当前发布</Badge>}
                      </strong>
                      <small>{index === 0 ? '当前生效的配置' : '此前发布的配置'}</small>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={!!busy}
                      onClick={() => setRestore(revision)}
                    >
                      恢复为草稿
                    </Button>
                  </div>
                ))}
              </div>
              {!record.revisions.length && (
                <Empty icon={<History size={24} />}>
                  尚无发布记录。准备好后，点击右上角的「发布」。
                </Empty>
              )}
            </Modal>
          )}
          {restore && (
            <Modal
              open
              onOpenChange={(open) => !open && !busyRef.current && setRestore(null)}
              title="恢复发布记录为草稿"
              description={`使用 ${date(restore.publishedAt)} 的配置替换草稿，再次发布后生效。`}
            >
              <div className="modal-actions">
                <Button variant="secondary" disabled={!!busy} onClick={() => setRestore(null)}>
                  取消
                </Button>
                <Button
                  disabled={!!busy || saving}
                  onClick={() =>
                    void run('restore', async () => {
                      const saved = await editor.settle();
                      const restored = await api<AgentRecord>('agents.restoreRevision', {
                        revisionId: restore.id,
                        expectedRevision: saved.draftRevision,
                      });
                      editor.replace({ ...restored, revisions: saved.revisions });
                      void client.invalidateQueries({ queryKey: ['agents.list'] });
                      setRestore(null);
                      setHistory(false);
                    })
                  }
                >
                  确认恢复
                </Button>
              </div>
              {error && (
                <p className="studio-error" role="alert">
                  {error}
                </p>
              )}
            </Modal>
          )}
          {deleting && (
            <Modal
              open
              onOpenChange={(open) => !open && !busyRef.current && setDeleting(false)}
              title={`删除「${record.name}」？`}
              description="删除后会解除此 Agent 的工作绑定，发布记录和执行记录仍会保留。"
            >
              <div className="modal-actions">
                <Button variant="secondary" disabled={!!busy} onClick={() => setDeleting(false)}>
                  取消
                </Button>
                <Button
                  variant="danger"
                  disabled={!!busy || saving}
                  onClick={() =>
                    void run('delete', async () => {
                      await editor.settle();
                      await api('agents.delete', { id: record.id });
                      void client.invalidateQueries({ queryKey: ['agents.list'] });
                      onClose();
                    })
                  }
                >
                  删除 Agent
                </Button>
              </div>
              {error && (
                <p className="studio-error" role="alert">
                  {error}
                </p>
              )}
            </Modal>
          )}
          {leaving && (
            <Modal
              open
              onOpenChange={(open) => !open && setLeaving(false)}
              title="还有未保存的修改"
              description="草稿尚未保存成功。可以继续编辑，或放弃本次未保存的修改。"
            >
              <p className="studio-error">{validationError || saveError}</p>
              <div className="modal-actions">
                <Button variant="secondary" onClick={onClose}>
                  放弃未保存修改
                </Button>
                <Button onClick={() => setLeaving(false)}>继续编辑</Button>
              </div>
            </Modal>
          )}
          {reloading && (
            <Modal
              open
              onOpenChange={(open) => !open && !busyRef.current && setReloading(false)}
              title="重新加载已保存的草稿"
              description="当前未保存的修改会被替换为本机资料库中的最新草稿。"
            >
              <div className="modal-actions">
                <Button variant="secondary" disabled={!!busy} onClick={() => setReloading(false)}>
                  取消
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void run('reload', async () => {
                      await editor.settle();
                      const latest = await api<{ agents: AgentRecord[] }>('agents.list');
                      const current = latest.agents.find((a) => a.id === record.id);
                      if (!current) throw new Error('此 Agent 已被删除，请关闭编辑器。');
                      editor.replace(current);
                      setReloading(false);
                    })
                  }
                >
                  重新加载
                </Button>
              </div>
              {error && (
                <p className="studio-error" role="alert">
                  {error}
                </p>
              )}
            </Modal>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
