import { toolkitIdentity } from '../../../../../../packages/contracts/src/toolkit-catalog';
import { StoreScopeField, initialStoreScope } from '../resource-scope';
import { useRef, useState } from 'react';
import { ArrowRight, Blocks, Bot, Check, Loader2, Search, Waypoints } from 'lucide-react';
import { api, client } from '../../api';
import { Badge, Button, Empty, Field, Modal } from '../ui';
import {
  errorText,
  mountLabel,
  newAgent,
  type AgentConfig,
  type AgentRecord,
  type AssetOption,
  type ModelOption,
  type MountKind,
} from './draft';

export function CreateAgentDialog({
  models,
  onClose,
  onCreated,
}: {
  models: ModelOption[];
  onClose: () => void;
  onCreated: (record: AgentRecord) => void;
}) {
  const [storeScope, setStoreScope] = useState(initialStoreScope);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !inFlight.current && onClose()}
      title="创建 Agent"
      description="先定义它的角色，再为它编排能力。"
    >
      <form
        className="agent-create-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (inFlight.current || !name.trim()) return;
          inFlight.current = true;
          setBusy(true);
          setError(null);
          try {
            const record = await api<AgentRecord>('agents.save', {
              storeScope,
              config: {
                ...newAgent(),
                name: name.trim(),
                description,
                modelProfileId: models.find((m) => m.kind === 'chat')?.id || null,
              },
            });
            void client.invalidateQueries({ queryKey: ['agents.list'] });
            onCreated({ ...record, revisions: [] });
          } catch (e) {
            setError(errorText(e));
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        <div className="agent-create-hero">
          <div className="agent-create-avatar">
            <Bot size={30} strokeWidth={1.6} />
          </div>
          <div>
            <h3>从一个角色开始</h3>
            <p>让它成为熟悉你店铺的客服助手。</p>
          </div>
          <Badge tone="green">回复 Agent</Badge>
        </div>
        <fieldset disabled={busy} className="agent-fieldset">
          <Field label="Agent 名称" hint="用一个容易识别的名称，描述它负责的工作。">
            <input
              autoFocus
              aria-label="Agent 名称"
              required
              maxLength={80}
              placeholder="例如：售前咨询助手"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="说明（选填）">
            <textarea
              rows={3}
              maxLength={1000}
              placeholder="例如：解答商品规格、使用方式与发货问题。"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <StoreScopeField value={storeScope} onChange={setStoreScope} />
        </fieldset>
        <div className="agent-create-next">
          <span>接下来</span>
          <span>设置人设</span>
          <ArrowRight size={12} />
          <span>挂载能力</span>
          <ArrowRight size={12} />
          <span>试运行</span>
        </div>
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? <Loader2 size={15} className="studio-spin" /> : <ArrowRight size={15} />}
            创建并编排
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AssetMountDialog({
  kind,
  assets,
  value,
  onApply,
  onClose,
}: {
  kind: MountKind;
  assets: AssetOption[];
  value: string[];
  onApply: (value: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(
    kind === 'toolkit' ? [...new Set(value.map(toolkitIdentity))] : value,
  );
  const limit = kind === 'toolkit' ? 30 : 20;
  const Icon = kind === 'toolkit' ? Blocks : Waypoints;
  const catalog = assets
    .filter((a) => a.manifest.kind === kind && (!a.legacy || value.includes(a.id)))
    .map((a) => (kind === 'toolkit' ? { ...a, id: toolkitIdentity(a.id) } : a));
  const missing = selected.filter((id) => !catalog.some((a) => a.id === id));
  const options = [
    ...catalog,
    ...missing.map((id) => ({
      id,
      version: '',
      status: 'missing',
      manifest: { name: id, kind, description: '此资源已缺失，请移除或重新安装。', members: [] },
    })),
  ];
  const shown = options.filter((a) =>
    `${a.manifest.name} ${a.manifest.description} ${a.id} ${a.manifest.members.map((m) => m.name).join(' ')}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const unavailable = selected.some(
    (id) => !catalog.some((a) => a.id === id && a.status === 'enabled'),
  );
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`挂载 ${mountLabel[kind]}`}
      description={
        kind === 'toolkit'
          ? '挂载后自动使用本机已安装、已启用的最新版。工具包更新后，无需重新挂载或发布 Agent。'
          : '选择已安装的工作流版本，发布 Agent 后生效。'
      }
    >
      <div className="studio-search">
        <Search size={16} />
        <input
          aria-label="搜索资源"
          placeholder="搜索名称、说明或成员…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="studio-picker-meta">
        <span>本地资源 · {options.length} 个集合</span>
        <span>
          已选 {selected.length} / {limit}
        </span>
      </div>
      <div className="studio-picker-list">
        {shown.map((asset) => {
          const checked = selected.includes(asset.id);
          const replacesVersion = selected.some(
            (id) => id.split('@')[0] === asset.id.split('@')[0],
          );
          const disabled =
            !checked &&
            (asset.status !== 'enabled' || (selected.length >= limit && !replacesVersion));
          return (
            <label
              key={asset.id}
              className={`studio-pick-option ${checked ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}`}
            >
              <input
                type="checkbox"
                aria-label={asset.manifest.name}
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  setSelected(
                    checked
                      ? selected.filter((id) => id !== asset.id)
                      : [
                          ...selected.filter((id) => id.split('@')[0] !== asset.id.split('@')[0]),
                          asset.id,
                        ],
                  )
                }
              />
              <div className={`studio-resource-icon ${kind}`}>
                <Icon size={19} />
              </div>
              <div className="studio-pick-copy">
                <strong>{asset.manifest.name}</strong>
                <p>{asset.manifest.description}</p>
                <small>
                  {asset.version &&
                    (kind === 'toolkit'
                      ? `自动跟随最新 · 当前 v${asset.version} · `
                      : `v${asset.version} · `)}
                  {asset.status === 'enabled'
                    ? `${asset.manifest.members.length} 个成员`
                    : '不可用'}
                  {asset.manifest.members.length > 0 &&
                    ` · ${asset.manifest.members.map((m) => m.name).join('、')}`}
                </small>
              </div>
            </label>
          );
        })}
        {!shown.length && (
          <Empty icon={<Search size={22} />}>
            {query
              ? '没有匹配的资源，试试其他关键词。'
              : `暂无可用集合，请先在 ${mountLabel[kind]} 资源库中安装。`}
          </Empty>
        )}
      </div>
      {unavailable && (
        <p className="studio-error" role="alert">
          已选资源中有不可用项，请取消勾选后再确认。
        </p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={unavailable}
          onClick={() => {
            onApply(selected);
            onClose();
          }}
        >
          <Check size={15} />
          确认挂载
        </Button>
      </div>
    </Modal>
  );
}

export function SubAgentDialog({
  agents,
  currentId,
  siblings,
  initial,
  onApply,
  onClose,
}: {
  agents: AgentRecord[];
  currentId: string;
  siblings: AgentConfig['subAgents'];
  initial?: AgentConfig['subAgents'][number];
  onApply: (value: AgentConfig['subAgents'][number]) => void;
  onClose: () => void;
}) {
  const available = agents.filter((a) => a.id !== currentId && a.revisions.length > 0);
  const [query, setQuery] = useState('');
  const [agentId, setAgentId] = useState(
    available.find((a) => a.revisions.some((r) => r.id === initial?.revisionId))?.id || '',
  );
  const [revisionId, setRevisionId] = useState(initial?.revisionId || '');
  const [alias, setAlias] = useState(() => {
    if (initial) return initial.alias;
    let n = 1;
    while (siblings.some((s) => s.alias === `helper${n}`)) n++;
    return `helper${n}`;
  });
  const selected = available.find((a) => a.id === agentId);
  const invalidAlias =
    !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(alias) || siblings.some((s) => s.alias === alias);
  const shown = available.filter((a) =>
    `${a.name} ${a.draftConfig.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial ? '编辑子 Agent' : '挂载子 Agent'}
      description="选择一个已发布的 Agent 并设置调用别名。它重新发布后，后续接待自动使用更新后的配置。"
    >
      <div className="studio-search">
        <Search size={16} />
        <input
          aria-label="搜索子 Agent"
          placeholder="搜索已发布的 Agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="studio-picker-list studio-sub-picker" role="group" aria-label="选择子 Agent">
        {shown.map((agent) => (
          <button
            key={agent.id}
            className={`studio-pick-option ${agent.id === agentId ? 'is-selected' : ''}`}
            aria-pressed={agent.id === agentId}
            onClick={() => {
              setAgentId(agent.id);
              setRevisionId(agent.revisions[0].id);
            }}
          >
            <div className="studio-resource-icon subagent">
              <Bot size={20} />
            </div>
            <div className="studio-pick-copy">
              <strong>{agent.name}</strong>
              <p>{agent.draftConfig.description || '已发布的回复 Agent'}</p>
            </div>
            {agent.id === agentId && <Check size={16} />}
          </button>
        ))}
        {!shown.length && (
          <Empty icon={<Bot size={24} />}>
            {query ? '没有匹配的 Agent。' : '先发布另一个 Agent，就能在这里挂载。'}
          </Empty>
        )}
      </div>
      <Field label="调用别名" hint="字母开头，支持字母、数字、下划线，最多 40 字符。">
        <input
          aria-label="调用别名"
          value={alias}
          maxLength={40}
          onChange={(e) => setAlias(e.target.value)}
        />
      </Field>
      {invalidAlias && (
        <p role="alert" className="studio-error">
          请使用符合格式且未被占用的调用别名。
        </p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={invalidAlias || !selected?.revisions.some((r) => r.id === revisionId)}
          onClick={() => {
            onApply({ alias, revisionId });
            onClose();
          }}
        >
          <Check size={15} />
          {initial ? '保存挂载' : '确认挂载'}
        </Button>
      </div>
    </Modal>
  );
}
