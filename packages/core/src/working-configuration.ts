import { agentConfigSchema, capabilitiesSchema, getAutoReplyReadiness } from '../../contracts/src';
import { platformSchema } from '../../contracts/src/platform';
import { resourceAllowed } from '../../agent-config/src/resource-scope';
import { normalizeAgentToolkits } from '../../contracts/src/toolkit-catalog';
import { currentToolkit, assetSettingsRows } from '../../agent-config/src/toolkit-resolution';
import { currentAgentPublication } from '../../agent-config/src/agent-publication';
import { currentSkills, type PublishedSkill } from '../../agent-config/src/skills';
import type { PublishedConfig } from '../../agent-config/src';
import { manifestSchema } from '../../extension-sdk/src';
import { availableOperations, memberOperations, supportsAsset } from '../../ai/src/platform-scope';
import { assert, errorText, hash } from './util';
import type { Engine } from './engine';

type Issue = {
  message: string;
  target: 'accounts' | 'models' | 'agents' | 'bindings' | 'toolkits' | 'skills';
};
type Resource = {
  id: string;
  name: string;
  kind: 'skill' | 'toolkit' | 'agent';
  version: string;
  path: string;
  status: 'available' | 'partial' | 'unavailable';
  reason: string;
  members: Array<{ name: string; availableAccounts: string[]; reason: string }>;
};
const modelSummary = (m: Record<string, unknown> | null | undefined) =>
  m
    ? {
        name: String(m.name ?? ''),
        model: String(m.model ?? ''),
        provider: String(m.provider ?? ''),
        maxTokens: Number(m.maxTokens) || 2048,
      }
    : null;

// Only summaries leave the service: never expose settings values, prompts, secrets or secret references.
export async function workingConfiguration(engine: Engine, storeId: string) {
  const db = engine.db;
  const store = await db.store.findFirst({
    where: { id: storeId, accounts: { some: {} } },
    include: { accounts: true, replyPolicy: true, learningPolicy: true },
  });
  assert(store, '店铺不存在或已移除');
  const platform = platformSchema.parse(store.platform);
  const readiness = getAutoReplyReadiness(store.accounts);
  const blockers: Issue[] = [];
  const notices: Issue[] = [];
  const resources: Resource[] = [];
  const skillCache = new Map<string, PublishedSkill | null>();
  const binding =
    (await db.agentBinding.findUnique({ where: { scopeKey: `store:${storeId}` } })) ??
    (await db.agentBinding.findUnique({ where: { scopeKey: 'global' } }));
  const revision = binding
    ? await db.agentRevision.findUnique({
        where: { id: binding.agentRevisionId },
        include: { agent: { include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } } },
      })
    : null;
  let resolutionError = '';
  if (binding) {
    try {
      await engine.agents.resolve(storeId);
    } catch (error) {
      resolutionError = errorText(error);
      blockers.push({ message: resolutionError, target: 'agents' });
    }
  } else
    notices.push({
      message: '尚未绑定工作 Agent，仅可使用符合条件的问答直答。',
      target: 'bindings',
    });
  if (!readiness.ready) blockers.push({ message: readiness.reason, target: 'accounts' });
  const config = revision?.configSnapshot as unknown as PublishedConfig | undefined;
  const currentModel = config?.modelProfileId
    ? await db.modelProfile.findUnique({ where: { id: config.modelProfileId } })
    : null;
  const modelChanged =
    !!config?.modelSnapshot &&
    (!currentModel || currentModel.revision !== config.modelSnapshot.revision);
  if (config && !config.modelSnapshot)
    blockers.push({ message: '已发布的 Agent 未配置回复模型。', target: 'agents' });
  if (modelChanged)
    notices.push({
      message: '模型配置已有更新，当前接待仍使用发布时的模型设置。请重新发布。',
      target: 'agents',
    });
  const latest = revision?.agent.revisions[0];
  let draftChanged = false;
  if (revision && latest) {
    const draft = agentConfigSchema.safeParse(revision.agent.draftConfig);
    const {
      modelSnapshot: _model,
      assetLock: _assets,
      skills: _skills,
      ...publishedConfig
    } = latest.configSnapshot as unknown as PublishedConfig;
    const published = agentConfigSchema.safeParse(publishedConfig);
    draftChanged = !!(
      draft.success &&
      published.success &&
      hash(normalizeAgentToolkits(draft.data)) !== hash(normalizeAgentToolkits(published.data))
    );
    if (draftChanged)
      notices.push({ message: '有尚未发布的草稿修改，当前接待不受草稿影响。', target: 'agents' });
    if (latest.id !== revision.id)
      notices.push({
        message: '本店的 Agent 接待配置尚未同步，请在工作绑定中重新应用。',
        target: 'bindings',
      });
  }
  const accounts = store.accounts.map((a) => {
    const parsed = capabilitiesSchema.safeParse(a.capabilities);
    const caps = parsed.success
      ? parsed.data
      : {
          receive: false,
          sendText: false,
          sendImage: false,
          history: false,
          goods: false,
          orders: false,
          verified: false,
        };
    return {
      id: a.id,
      name: a.name,
      ready: getAutoReplyReadiness([a]).ready,
      allowed: new Set(
        Object.entries(caps)
          .filter(([, v]) => v === true)
          .map(([k]) => k),
      ),
      operations: new Set(availableOperations(platform, caps)),
    };
  });
  const walk = async (
    c: PublishedConfig,
    path: string,
    parents: typeof accounts,
    parentError = '',
    depth = 0,
  ) => {
    if (depth > 4) return;
    if (c.workflowIds?.length)
      notices.push({
        message: `${path}：发布时挂载的 Workflow 已停用，不再生效；重新发布该助手即可移除。`,
        target: 'agents',
      });
    const mounted = await Promise.all(
      c.toolkitIds.map(async (id) => {
        const kind = 'toolkit' as const;
        const [asset, permitted] = await Promise.all([
          currentToolkit(db, id).catch(() => null),
          resourceAllowed(db, kind, id, storeId),
        ]);
        const parsed = manifestSchema.safeParse(asset?.manifest);
        const manifest = parsed.success ? parsed.data : null;
        const expected = c.assetLock?.find((a) => a.id === (asset?.id ?? id))?.hash;
        let reason =
          parentError ||
          (!permitted
            ? '未授权此店铺使用'
            : !asset || asset.status !== 'enabled' || (expected && expected !== asset.artifactHash)
              ? '挂载版本缺失或未启用'
              : !manifest
                ? '资源描述无法读取'
                : !supportsAsset(manifest, platform)
                  ? '不支持当前店铺平台'
                  : '');
        if (!reason && manifest) {
          const rows = await assetSettingsRows(db, asset!.id, storeId);
          const values = {
            ...(rows.find((r) => r.scopeKey === 'global')?.values as object),
            ...(rows.find((r) => r.scopeKey === `store:${storeId}`)?.values as object),
          } as Record<string, unknown>;
          const missing = manifest.settingsFields.filter(
            (f) =>
              f.required &&
              (values[f.key] === undefined || values[f.key] === null || values[f.key] === ''),
          );
          if (missing.length) {
            reason = `缺少配置：${missing.map((f) => f.label).join('、')}`;
            blockers.push({
              message: `${manifest.name}：${reason}`,
              target: 'toolkits',
            });
          }
        }
        return { id: asset?.id ?? id, kind, asset, manifest, permitted, reason };
      }),
    );
    const declaredCaps = new Set<string>();
    const declaredOps = new Set<string>();
    for (const m of mounted)
      if (m.permitted && m.manifest && supportsAsset(m.manifest, platform)) {
        for (const member of m.manifest.members) {
          member.requiresCapabilities.forEach((v) => declaredCaps.add(v));
          memberOperations(m.manifest, member).forEach((v) => declaredOps.add(v));
        }
      }
    const local = parents.map((a) => ({
      ...a,
      allowed: new Set([...a.allowed].filter((v) => declaredCaps.has(v))),
      operations: new Set([...a.operations].filter((v) => declaredOps.has(v))),
    }));
    for (const m of mounted) {
      const members = (m.manifest?.members ?? [])
        .filter((member) => !member.contract)
        .map((member) => {
          const requiredOps =
            member.requiresOperations ?? (m.manifest!.assetId === 'builtin/pdd' ? [member.id] : []);
          const availableAccounts = !m.reason
            ? local
                .filter(
                  (a) =>
                    a.ready &&
                    member.requiresCapabilities.every((cap) => a.allowed.has(cap)) &&
                    requiredOps.every((op) => a.operations.has(op)),
                )
                .map((a) => a.name)
            : [];
          return {
            name: member.name,
            availableAccounts,
            reason:
              m.reason || (!availableAccounts.length ? '当前账号连接或平台操作能力不可用' : ''),
          };
        });
      const count = members.filter((m) => m.availableAccounts.length).length;
      resources.push({
        id: m.id,
        name: m.manifest?.name ?? m.id,
        kind: m.kind,
        version: m.asset?.version ?? '',
        path,
        members,
        status:
          m.reason || !count
            ? 'unavailable'
            : count < members.length ||
                members.some((m) => m.availableAccounts.length < accounts.length)
              ? 'partial'
              : 'available',
        reason:
          m.reason ||
          (!count
            ? '当前账号没有可调用的成员'
            : `${count} / ${members.length} 项能力可用，按会话账号选择`),
      });
    }
    try {
      for (const skill of await currentSkills(db, c, skillCache)) {
        const permitted = await resourceAllowed(db, 'skill', skill.id, storeId);
        const reason =
          parentError ||
          (!permitted
            ? '未授权此店铺使用'
            : skillCache.get(skill.id)
              ? '使用技能库中最新保存的内容，无需重新发布 Agent'
              : '技能已从库中移除，继续使用 Agent 保留的副本');
        resources.push({
          id: skill.id,
          name: skill.name,
          kind: 'skill',
          version: '',
          path,
          status: parentError || !permitted ? 'unavailable' : 'available',
          reason,
          members: [],
        });
      }
    } catch (error) {
      blockers.push({ message: errorText(error), target: 'skills' });
    }
    for (const child of c.subAgents) {
      const rev = await currentAgentPublication(db, child.revisionId).catch(() => null);
      const permitted = !!rev && (await resourceAllowed(db, 'agent', rev.agentId, storeId));
      const childConfig = rev?.configSnapshot as unknown as PublishedConfig | undefined;
      const reason =
        parentError ||
        (!rev || rev.agent.status !== 'active'
          ? '子 Agent 已删除或尚未发布'
          : !permitted
            ? '未授权此店铺使用'
            : !childConfig?.modelSnapshot
              ? '子 Agent 未配置模型'
              : '');
      resources.push({
        id: rev?.id ?? child.revisionId,
        name: rev?.agent.name ?? child.alias,
        kind: 'agent',
        version: String(rev?.revision ?? ''),
        path,
        status: reason ? 'unavailable' : 'available',
        reason: reason || '沿用父 Agent 的店铺与账号能力',
        members: [],
      });
      if (childConfig && !reason)
        await walk(childConfig, `${path} / ${child.alias}`, local, '', depth + 1);
    }
  };
  if (config)
    await walk(
      config,
      revision!.agent.name,
      accounts,
      resolutionError || (!config.modelSnapshot ? '工作 Agent 缺少模型' : ''),
    );
  const fallback = await db.appSetting.findUnique({ where: { key: 'defaultModelId' } });
  const learningModelId =
    store.learningPolicy?.builtinModelRef ??
    (typeof fallback?.value === 'string' ? fallback.value : null);
  const learningModel = learningModelId
    ? await db.modelProfile.findUnique({ where: { id: learningModelId } })
    : null;
  if (store.learningPolicy?.autoLearnEnabled && !learningModel)
    notices.push({
      message: '自动学习已开启，但学习模型缺失，请检查学习模型设置。',
      target: 'models',
    });
  return {
    storeId,
    storeName: store.name,
    platform,
    configEpoch: store.replyConfigEpoch,
    replyEnabled: !!store.replyPolicy?.autoReplyEnabled,
    ready: readiness.ready && !blockers.length,
    agent: revision
      ? {
          id: revision.agentId,
          name: config?.name ?? revision.agent.name,
          revision: revision.revision,
          revisionId: revision.id,
          latestRevision: latest?.revision ?? revision.revision,
          latestRevisionId: latest?.id ?? revision.id,
          source: binding!.scopeKey === 'global' ? ('global' as const) : ('store' as const),
          bindingRevision: binding!.revision,
          draftChanged,
          modelChanged,
          model: modelSummary(config?.modelSnapshot),
        }
      : null,
    learning: {
      enabled: !!store.learningPolicy?.autoLearnEnabled,
      source: store.learningPolicy?.builtinModelRef ? 'store' : 'global',
      model: modelSummary(learningModel as unknown as Record<string, unknown>),
    },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, ready: a.ready })),
    blockers,
    notices,
    resources,
  };
}
export type WorkingConfiguration = Awaited<ReturnType<typeof workingConfiguration>>;
