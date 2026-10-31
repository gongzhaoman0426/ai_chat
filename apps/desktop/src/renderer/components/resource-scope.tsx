import { findMountedAsset } from './agent-studio/draft';
import { useState } from 'react';
import { Store as StoreIcon } from 'lucide-react';
import {
  scopeAllows,
  type ResourceKind,
  type ResourceScopeRecord,
  type StoreScope,
} from '../../../../../packages/contracts/src/resource-scope';
import { platformNames, type PlatformId } from '../../../../../packages/contracts/src/platform';
import { useData, useUi, api, client } from '../api';
import { Badge, Button, Field, Modal } from './ui';
import type { AgentConfig, AgentRecord, AssetOption } from './agent-studio/draft';
import type { SkillRecord } from '../../../../../packages/contracts/src';

export function initialStoreScope(): StoreScope {
  const id = useUi.getState().storeId;
  return id ? { mode: 'selected', storeIds: [id] } : { mode: 'all', storeIds: [] };
}
export function scopeFor(rows: ResourceScopeRecord[], kind: ResourceKind, id: string) {
  const identity = kind === 'toolkit' ? id.split('@')[0] : id;
  return rows.find((s) => s.kind === kind && s.resourceId === identity);
}
const scopeLabel = (s?: StoreScope) =>
  !s || s.mode === 'all'
    ? '全部店铺'
    : s.storeIds.length
      ? `${s.storeIds.length} 家指定店铺`
      : '暂无可用店铺';
export function StoreScopeField({
  value,
  onChange,
}: {
  value: StoreScope;
  onChange: (value: StoreScope) => void;
}) {
  const { data: stores = [], isSuccess } = useData<any[]>('stores.list');
  return (
    <Field label="可用店铺" hint="控制资源可在哪些店铺运行；挂载和工作绑定仍需单独配置。">
      <div className="scope-field">
        <select
          aria-label="可用店铺范围"
          value={value.mode}
          onChange={(e) => onChange({ ...value, mode: e.target.value as StoreScope['mode'] })}
        >
          <option value="all">全部店铺（含以后新增的店铺）</option>
          <option value="selected">指定店铺</option>
        </select>
        {value.mode === 'selected' && (
          <div className="scope-store-list">
            {stores.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={value.storeIds.includes(s.id)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      storeIds: e.target.checked
                        ? [...value.storeIds, s.id]
                        : value.storeIds.filter((id) => id !== s.id),
                    })
                  }
                />
                <span>
                  {s.name}
                  <small>{platformNames[s.platform as PlatformId]}</small>
                </span>
              </label>
            ))}
            {isSuccess &&
              value.storeIds
                .filter((id) => !stores.some((s) => s.id === id))
                .map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        onChange({ ...value, storeIds: value.storeIds.filter((s) => s !== id) })
                      }
                    />
                    <span>
                      已移除店铺<small>取消此绑定后保存</small>
                    </span>
                  </label>
                ))}
            {!stores.length && <p className="muted">暂无已添加店铺。</p>}
            {!value.storeIds.length && <p className="muted">未选择店铺时，此资源不可用于接待。</p>}
          </div>
        )}
      </div>
    </Field>
  );
}
export function ResourceScopeBadge({ kind, id }: { kind: ResourceKind; id: string }) {
  const { data: rows = [], isSuccess } = useData<ResourceScopeRecord[]>('resources.scopes');
  return <Badge>{isSuccess ? scopeLabel(scopeFor(rows, kind, id)) : '加载店铺范围…'}</Badge>;
}
export function ResourceScopeEditor({ kind, id }: { kind: ResourceKind; id: string }) {
  const { data: rows = [], isSuccess } = useData<ResourceScopeRecord[]>('resources.scopes');
  const [draft, setDraft] = useState<(StoreScope & { revision: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = scopeFor(rows, kind, id);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const current = scopeFor(await api<ResourceScopeRecord[]>('resources.scopes'), kind, id);
      setDraft({
        mode: current?.mode ?? 'all',
        storeIds: [...(current?.storeIds ?? [])],
        revision: current?.revision ?? 0,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取配置失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="resource-scope-editor">
      <Button
        type="button"
        variant="secondary"
        disabled={!isSuccess || busy}
        onClick={() => void load()}
      >
        <StoreIcon size={14} />
        可用店铺：{isSuccess ? scopeLabel(scope) : '加载中…'}
      </Button>
      {error && !draft && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      <Modal
        layer={120}
        open={!!draft}
        onOpenChange={(v) => !v && !busy && setDraft(null)}
        title="配置可用店铺"
        description="保存后立即生效，已发布版本同样遵守此范围。不会自动挂载资源或切换工作 Agent。"
      >
        {draft && (
          <StoreScopeField value={draft} onChange={(value) => setDraft({ ...draft, ...value })} />
        )}
        {error && (
          <div role="alert">
            <p className="studio-error">{error}</p>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void load()}>
              重新加载配置
            </Button>
          </div>
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || !draft}
            onClick={async () => {
              if (!draft) return;
              setBusy(true);
              try {
                setError('');
                await api('resources.setScope', {
                  kind,
                  resourceId: id,
                  mode: draft.mode,
                  storeIds: draft.storeIds,
                  expectedRevision: draft.revision,
                });
                await client.invalidateQueries();
                setDraft(null);
                useUi.getState().notify('可用店铺已更新');
              } catch (e) {
                setError(e instanceof Error ? e.message : '保存失败');
              } finally {
                setBusy(false);
              }
            }}
          >
            保存可用店铺
          </Button>
        </div>
      </Modal>
    </div>
  );
}
export function AgentStorePreview({
  agentId,
  config,
  agents,
  assets,
  skills,
}: {
  agentId: string;
  config: AgentConfig;
  agents: AgentRecord[];
  assets: AssetOption[];
  skills: SkillRecord[];
}) {
  const { data: stores = [] } = useData<any[]>('stores.list');
  const { data: scopes = [], isSuccess } = useData<ResourceScopeRecord[]>('resources.scopes');
  const [storeId, setStoreId] = useState(useUi.getState().storeId);
  const store = stores.find((s) => s.id === storeId);
  const agentAllowed = !!store && scopeAllows(scopeFor(scopes, 'agent', agentId), storeId);
  const mounted: {
    kind: ResourceKind;
    id: string;
    name: string;
    missing?: boolean;
    platforms?: string[];
  }[] = [
    ...config.skillIds.map((id) => ({
      kind: 'skill' as const,
      id,
      name: skills.find((s) => s.id === id)?.name ?? '已删除 Skill',
      missing: !skills.some((s) => s.id === id),
    })),
    ...config.toolkitIds.map((id) => {
      const a = findMountedAsset(assets, 'toolkit', id);
      return {
        kind: 'toolkit' as const,
        id,
        name: a?.manifest.name ?? '已删除资源',
        missing: !a,
        platforms: a?.manifest.platforms,
      };
    }),
    ...config.subAgents.map((sub) => {
      const a = agents.find((a) => a.revisions.some((r) => r.id === sub.revisionId));
      return {
        kind: 'agent' as const,
        id: a?.id ?? '',
        name: `${sub.alias} · 子 Agent`,
        missing: !a,
      };
    }),
  ];
  return (
    <details className="agent-scope-preview">
      <summary>预览店铺的有效挂载</summary>
      <select
        aria-label="预览店铺"
        value={store ? storeId : ''}
        onChange={(e) => setStoreId(e.target.value)}
      >
        <option value="" disabled>
          选择店铺查看
        </option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {platformNames[s.platform as PlatformId]}
          </option>
        ))}
      </select>
      {store && isSuccess && (
        <>
          {!agentAllowed && <p className="muted">此 Agent 未授权该店铺，不能在该店运行。</p>}
          {mounted.map((r) => {
            const reason = r.missing
              ? '已删除或缺失'
              : !agentAllowed
                ? 'Agent 未授权'
                : !scopeAllows(scopeFor(scopes, r.kind, r.id), store.id)
                  ? '未授权本店'
                  : r.platforms && !r.platforms.includes(store.platform)
                    ? '平台不支持'
                    : '可用';
            return (
              <div className="scope-preview-row" key={`${r.kind}:${r.id}:${r.name}`}>
                <span>{r.name}</span>
                <Badge tone={reason === '可用' ? 'green' : 'neutral'}>{reason}</Badge>
              </div>
            );
          })}
          <p className="muted">
            按当前草稿预览。工具成员还会按平台及登录账号能力裁剪，子 Agent 内部资源也分别校验。
          </p>
        </>
      )}
    </details>
  );
}
