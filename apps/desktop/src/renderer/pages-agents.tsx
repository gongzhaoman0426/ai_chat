import {
  ResourceScopeEditor,
  ResourceScopeBadge,
  initialStoreScope,
  scopeFor,
} from './components/resource-scope';
import {
  scopeAllows,
  type ResourceScopeRecord,
} from '../../../../packages/contracts/src/resource-scope';
import { platformNames, type PlatformId } from '../../../../packages/contracts/src/platform';
import type { SkillRecord } from '../../../../packages/contracts/src/index';
import { useState } from 'react';
import {
  Bot,
  BookOpenText,
  Plus,
  Play,
  Blocks,
  Waypoints,
  Braces,
  ArrowRight,
  RotateCcw,
  Info,
} from 'lucide-react';
import { useData, perform, useUi } from './api';
import { Button, Badge, Modal, Field } from './components/ui';
import { AgentStudio } from './components/agent-studio/studio';
import { CreateAgentDialog } from './components/agent-studio/dialogs';
import type { AgentRecord, AssetOption, ModelOption } from './components/agent-studio/draft';
import { publicationStatus } from './components/agent-studio/draft';

export function Agents() {
  const { data: catalog } = useData<{ agents: AgentRecord[] }>('agents.list');
  const { data: models = [] } = useData<ModelOption[]>('models.list');
  const { data: resources } = useData<{
    assets: AssetOption[];
    compatibilityAssets?: AssetOption[];
  }>('assets.list');
  const { data: skills = [] } = useData<SkillRecord[]>('skills.list');
  const [selected, setSelected] = useState<AgentRecord | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">AGENT STUDIO</div>
          <h1>Agent Studio</h1>
          <p>配置回复方式，挂载技能、工具、流程和子 Agent。学习使用独立内置 Agent。</p>
        </div>
        <div className="actions">
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            新建 Agent
          </Button>
        </div>
      </div>
      <div className="page-body">
        <div className="agent-grid">
          {catalog?.agents.map((agent) => (
            <button className="agent-card card" key={agent.id} onClick={() => setSelected(agent)}>
              <div className="agent-card-top">
                <div className="agent-avatar">
                  <Bot size={24} />
                </div>
                <Badge tone={agent.origin === 'builtin_default' ? 'green' : 'neutral'}>
                  {agent.origin === 'builtin_default' ? '默认 Agent' : '自定义'}
                </Badge>
              </div>
              <h3>{agent.name}</h3>
              <ResourceScopeBadge kind="agent" id={agent.id} />
              <p>{agent.draftConfig.description || '一个专注于店铺接待的回复 Agent'}</p>
              <div className="agent-tags">
                <span>
                  <BookOpenText size={13} />
                  {agent.draftConfig.skillIds.length} 技能
                </span>
                <span>
                  <Blocks size={13} />
                  {agent.draftConfig.toolkitIds.length} 工具集
                </span>
                <span>
                  <Waypoints size={13} />
                  {agent.draftConfig.workflowIds.length} 流程集
                </span>
                <span>
                  <Bot size={13} />
                  {agent.draftConfig.subAgents.length} 子 Agent
                </span>
              </div>
              <div className="agent-card-bottom">
                <span>{publicationStatus(agent)}</span>
                <ArrowRight size={16} />
              </div>
            </button>
          ))}
          {!catalog?.agents.some((agent) => agent.origin === 'builtin_default') && (
            <button
              className="agent-card restore-card"
              onClick={() =>
                perform('agents.restoreDefault', {}, '默认 Agent 已加回并设为全局工作 Agent')
              }
            >
              <RotateCcw size={28} />
              <h3>加回默认 Agent</h3>
              <p>恢复预置配置，并设为全局工作 Agent</p>
            </button>
          )}
        </div>
        <aside className="agent-publish-note" aria-label="发布后的接待">
          <div className="agent-publish-note-icon" aria-hidden="true">
            <Info size={18} />
          </div>
          <div className="agent-publish-note-copy">
            <strong>发布后，使用中的店铺自动更新</strong>
            <p>
              编辑会自动保存为草稿，点击发布后统一生效。首次安排店铺使用哪个
              Agent，在工作绑定中选择。
            </p>
          </div>
          <Button variant="ghost" onClick={() => useUi.getState().setPage('bindings')}>
            前往工作绑定
            <ArrowRight size={14} />
          </Button>
        </aside>
      </div>
      {creating && (
        <CreateAgentDialog
          models={models}
          onClose={() => setCreating(false)}
          onCreated={(record) => {
            setCreating(false);
            setSelected(record);
          }}
        />
      )}
      {selected && (
        <AgentStudio
          key={selected.id}
          initial={selected}
          agents={catalog?.agents || []}
          models={models}
          assets={[...(resources?.assets || []), ...(resources?.compatibilityAssets || [])]}
          skills={skills}
          onClose={() => setSelected(null)}
          onSwitch={setSelected}
        />
      )}
    </>
  );
}
export function Assets({ kind }: { kind: 'toolkit' | 'workflow' }) {
  const label = kind === 'toolkit' ? 'Toolkit' : 'Workflow';
  const { data } = useData('assets.list');
  const [selected, setSelected] = useState<any>(null);
  const [member, setMember] = useState('');
  const [input, setInput] = useState('{}');
  const [output, setOutput] = useState<any>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{label.toUpperCase()} LIBRARY</div>
          <h1>
            {kind === 'toolkit' ? 'Toolkit 工具库' : 'Workflow 流程库'}
            <span className="title-dot">.</span>
          </h1>
          <p>
            {kind === 'toolkit'
              ? '挂载一次，自动使用已安装、已启用的最新版。更新工具包后无需重新发布 Agent。'
              : '管理可复用的业务流程，挂载给 Agent 后作为能力调用。'}
          </p>
        </div>
        <Button
          onClick={async () => {
            if (window.confirm('安装你信任的本地 JavaScript 扩展？扩展以本地程序权限运行。'))
              await perform(
                'assets.install',
                { kind, storeScope: initialStoreScope() },
                `${label} 已安装`,
              );
          }}
        >
          <Plus size={16} />
          安装 {label}
        </Button>
      </div>
      <div className="page-body">
        <div className="agent-grid">
          {data?.assets
            ?.filter((a: any) => a.manifest.kind === kind)
            .map((a: any) => (
              <button
                key={a.id}
                disabled={!a.manifest.members.length}
                className="asset-card card"
                onClick={() => {
                  setSelected(a);
                  setMember(a.manifest.members[0].id);
                  setInput('{}');
                  setOutput(null);
                  setSettings({});
                }}
              >
                <div className={`asset-icon ${a.manifest.kind === 'workflow' ? 'purple' : ''}`}>
                  {a.manifest.kind === 'toolkit' ? <Blocks /> : <Waypoints />}
                </div>
                <Badge>{a.manifest.kind === 'toolkit' ? 'Toolkit' : 'Workflow'}</Badge>
                <h3>{a.manifest.name}</h3>
                <ResourceScopeBadge kind={kind} id={a.id} />
                <p>{a.manifest.description}</p>
                <div className="asset-bottom">
                  <span>{a.manifest.members.length} 个成员</span>
                  <code>v{a.version}</code>
                </div>
              </button>
            ))}
        </div>
        <div className="card sdk-card">
          <Braces size={32} />
          <div>
            <h3>为你的业务编写 {label}</h3>
            <p>
              {label} 在仓库里用 TypeScript 编写，打成含 manifest.json 与 index.mjs 的 ZIP
              后再安装。完整步骤见官网「使用说明」中的 Toolkit / Workflow 章节。
            </p>
          </div>
        </div>
      </div>
      <Modal
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.manifest.name || '扩展资源'}
        description={selected?.id}
        wide
      >
        {selected && (
          <>
            <ResourceScopeEditor kind={kind} id={selected.id} />
            <div className="form-two">
              <Field label="试跑成员">
                <select
                  value={member}
                  onChange={(e) => {
                    setMember(e.target.value);
                    setOutput(null);
                  }}
                >
                  {selected.manifest.members.map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="调用权限">
                <div className="member-caps">
                  {selected.manifest.members
                    .find((m: any) => m.id === member)
                    ?.requiresCapabilities.join(', ') || '纯计算 / 本地资料'}
                </div>
              </Field>
            </div>
            <div className="form-two">
              <Field label="输入 JSON">
                <textarea
                  className="code-input"
                  rows={9}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
              </Field>
              <Field label="输入 schema">
                <pre className="schema-box">
                  {JSON.stringify(
                    selected.manifest.members.find((m: any) => m.id === member)?.inputSchema,
                    null,
                    2,
                  )}
                </pre>
              </Field>
            </div>
            <Button
              onClick={async () => {
                try {
                  setOutput(
                    await perform('assets.test', {
                      assetId: selected.id,
                      memberId: member,
                      input: JSON.parse(input),
                    }),
                  );
                } catch {
                  useUi.getState().notify('输入不是有效 JSON');
                }
              }}
            >
              <Play size={15} />
              在隔离环境试跑
            </Button>
            {output !== null && <pre className="result-box">{JSON.stringify(output, null, 2)}</pre>}
            {selected.manifest.settingsFields.length > 0 && (
              <div className="form-grid section-space">
                <h3>集合默认配置</h3>
                {selected.manifest.settingsFields.map((f: any) => (
                  <Field key={f.key} label={f.label}>
                    <input
                      type={f.secret ? 'password' : 'text'}
                      value={settings[f.key] || ''}
                      onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })}
                    />
                  </Field>
                ))}
                <Button
                  onClick={() =>
                    perform(
                      'assets.settings',
                      {
                        assetId: selected.id,
                        scopeKey: 'global',
                        expectedRevision:
                          data.settings.find(
                            (s: any) => s.assetId === selected.id && s.scopeKey === 'global',
                          )?.revision || 0,
                        values: settings,
                      },
                      '集合配置已生效',
                    )
                  }
                >
                  保存设置
                </Button>
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
export function Bindings({ stores }: { stores: any[] }) {
  const { data } = useData('agents.list');
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKING AGENTS</div>
          <h1>工作绑定</h1>
          <p>
            为店铺选择一个已发布的 Agent。店铺专用设置优先，没有专用设置时继承全局；Agent
            重新发布后，所有使用它的店铺自动更新。
          </p>
        </div>
      </div>
      <div className="page-body">
        <div className="binding-list">
          {[
            {
              id: 'global',
              name: '全局默认回复',
              description: '所有未设置专用 Agent 的店铺使用此配置',
            },
            ...stores.map((s) => ({
              id: `store:${s.id}`,
              name: s.name,
              description: `${platformNames[s.platform as PlatformId]} · 店铺专用回复设置`,
            })),
          ].map((s) => (
            <Binding
              key={`${s.id}:${data?.bindings?.find((b: any) => b.scopeKey === s.id)?.revision}`}
              scope={s}
              catalog={data}
            />
          ))}
        </div>
        <div className="info-line">
          <SparklesIcon />
          内置学习 Agent 不在此选择；学习开关和模型在店铺管理的自动接待中设置。
        </div>
      </div>
    </>
  );
}
function Binding({ scope, catalog }: { scope: any; catalog: any }) {
  const { data: scopes = [], isSuccess: scopesLoaded } =
    useData<ResourceScopeRecord[]>('resources.scopes');
  const binding = catalog?.bindings?.find((b: any) => b.scopeKey === scope.id);
  const boundAgent = catalog?.agents?.find((a: AgentRecord) =>
    a.revisions.some((r) => r.id === binding?.agentRevisionId),
  );
  const [agentId, setAgentId] = useState(boundAgent?.id || '');
  return (
    <div className="card binding-card">
      <div>
        <div className="agent-avatar">
          <Bot size={22} />
        </div>
        <h3>{scope.name}</h3>
        <p>{scope.description}</p>
      </div>
      <div className="binding-fields">
        <Field label="工作回复 Agent" hint="选择后应用即可。之后发布此 Agent，店铺会自动更新。">
          <select
            aria-label="工作回复 Agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">
              {scope.id === 'global' ? '无 Agent，仅高阈值直答' : '继承全局默认'}
            </option>
            {catalog?.agents?.flatMap((a: any) => {
              const latest = a.revisions[0];
              if (!latest) return [];
              const allowed =
                scopesLoaded &&
                (scope.id === 'global'
                  ? (scopeFor(scopes, 'agent', a.id)?.mode ?? 'all') === 'all'
                  : scopeAllows(scopeFor(scopes, 'agent', a.id), scope.id.slice(6)));
              if (!allowed && a.id !== agentId) return [];
              return [
                <option value={a.id} key={a.id} disabled={!allowed}>
                  {!allowed ? '[未授权] ' : ''}
                  {a.name}
                </option>,
              ];
            })}
          </select>
        </Field>
      </div>
      <Button
        variant="secondary"
        onClick={() =>
          perform(
            'agents.bind',
            {
              scopeKey: scope.id,
              agentId: agentId || null,
              expectedRevision: binding?.revision ?? null,
            },
            '工作绑定已切换',
          )
        }
      >
        应用配置
      </Button>
    </div>
  );
}
const SparklesIcon = () => <Bot size={16} />;
