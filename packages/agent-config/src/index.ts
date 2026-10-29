import { cancelGeneratingReplies } from '../../core/src/configuration-change';
import { currentToolkit, assetSettingsRows } from './toolkit-resolution';
import { currentAgentPublication } from './agent-publication';
import {
  getResourceScope,
  resourceAllowed,
  assertResourceAllowed,
  saveResourceScope,
} from './resource-scope';
import type { StoreScope } from '../../contracts/src/resource-scope';
import { retirePddToolkits } from './retire-pdd-tools';
import {
  COMMERCE_TOOLKIT_ID,
  LEGACY_COMMERCE_TOOLKIT_ID,
  RETIRED_PDD_TOOLKIT_IDS,
  toolkitReferences,
  toolkitIdentity,
  normalizeAgentToolkits,
} from '../../contracts/src/toolkit-catalog';
import { snapshotSkills, publishedSkills, type PublishedSkill } from './skills';
import type { PrismaClient, Tx } from '../../database/src/index';
import { json } from '../../database/src/index';
import { agentConfigSchema, type AgentConfig } from '../../contracts/src/index';
import { assert, hash } from '../../core/src/util';
import {
  DEFAULT_REPLY_PROMPT,
  DEFAULT_REPLY_DESCRIPTION,
} from '../../contracts/src/reply-guidance';
export const DEFAULT_PROMPT = DEFAULT_REPLY_PROMPT;
export const defaultConfig = (modelProfileId: string | null = null): AgentConfig =>
  agentConfigSchema.parse({
    name: '默认自动回复',
    description: DEFAULT_REPLY_DESCRIPTION,
    prompt: DEFAULT_PROMPT,
    modelProfileId,
    toolkitIds: ['builtin/utilities', 'builtin/commerce'],
  });
export type PublishedConfig = AgentConfig & {
  modelSnapshot: Record<string, unknown> | null;
  assetLock: Array<{ id: string; hash: string }>;
  skills?: PublishedSkill[]; // Old immutable revisions have no skills.
};
export class AgentService {
  constructor(private db: PrismaClient) {}
  async initialize() {
    if (await this.db.appSetting.findUnique({ where: { key: 'initialized' } })) return;
    await this.db.$transaction(async (tx) => {
      await tx.appSetting.create({ data: { key: 'initialized', value: true } });
      await tx.appSetting.create({ data: { key: 'developerModeEnabled', value: false } });
      await this.createDefault(tx);
    });
  }
  async retirePddToolkits() {
    return this.db.$transaction((tx) => retirePddToolkits(tx, (scope) => this.bump(tx, scope)));
  }
  // Upgrade only untouched built-in templates. Published history and custom Agents remain immutable.
  async upgradeBuiltinDefaults() {
    await this.db.$transaction(async (tx) => {
      const agents = await tx.agentDefinition.findMany({
        where: { status: 'active', origin: { in: ['builtin_default', 'builtin_setup'] } },
        include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
      });
      for (const agent of agents) {
        const latest = agent.revisions[0];
        if (!latest) continue;
        const {
          modelSnapshot: _,
          assetLock: __,
          skills: ___,
          ...published
        } = latest.configSnapshot as unknown as PublishedConfig;
        const draft = agentConfigSchema.safeParse(agent.draftConfig);
        const config = agentConfigSchema.safeParse(published);
        if (!draft.success || !config.success || hash(draft.data) !== hash(config.data)) continue;
        const templates = [
          COMMERCE_TOOLKIT_ID,
          LEGACY_COMMERCE_TOOLKIT_ID,
          ...RETIRED_PDD_TOOLKIT_IDS,
        ].map((toolkitId) => ({
          ...defaultConfig(config.data.modelProfileId),
          toolkitIds: ['builtin/utilities@1.0.0', toolkitId],
          name: config.data.name,
        }));
        if (!templates.some((template) => hash(template) === hash(config.data))) continue;
        const upgraded = {
          ...config.data,
          toolkitIds: defaultConfig().toolkitIds,
        };
        if (hash(upgraded) === hash(config.data)) continue;
        const changedTools = hash(upgraded.toolkitIds) !== hash(config.data.toolkitIds);
        // A template update must not silently adopt edited model settings or secrets.
        const snapshot: PublishedConfig = {
          ...(latest.configSnapshot as unknown as PublishedConfig),
          ...upgraded,
        };
        if (changedTools) {
          const assets = await Promise.all(
            upgraded.toolkitIds.map((id) => currentToolkit(tx, id).catch(() => null)),
          );
          if (assets.some((asset) => !asset)) continue;
          snapshot.assetLock = assets.map((asset) => ({
            id: asset!.id,
            hash: asset!.artifactHash,
          }));
        }
        const revision = await tx.agentRevision.create({
          data: {
            agentId: agent.id,
            revision: latest.revision + 1,
            configSnapshot: json(snapshot),
            configHash: hash(snapshot),
          },
        });
        await tx.agentDefinition.update({
          where: { id: agent.id },
          data: { draftConfig: json(upgraded), draftRevision: { increment: 1 } },
        });
        const bindings = await tx.agentBinding.findMany({ where: { agentRevisionId: latest.id } });
        await tx.agentBinding.updateMany({
          where: { agentRevisionId: latest.id },
          data: { agentRevisionId: revision.id, revision: { increment: 1 } },
        });
        for (const binding of bindings) await this.bump(tx, binding.scopeKey);
        await tx.auditEvent.create({
          data: {
            type: 'agent.commerce_tools_upgraded',
            scope: agent.id,
            actor: 'system',
            details: json({
              previousRevisionId: latest.id,
              revisionId: revision.id,
              changedTools,
              scopes: bindings.map((b) => b.scopeKey),
            }),
          },
        });
      }
    });
  }
  private async createDefault(tx: Tx) {
    const existing = await tx.agentDefinition.findFirst({
      where: { origin: 'builtin_default', status: 'active' },
      include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
    });
    let rev = existing?.revisions[0];
    if (!existing) {
      const setting = await tx.appSetting.findUnique({ where: { key: 'defaultModelId' } });
      const config = defaultConfig(typeof setting?.value === 'string' ? setting.value : null);
      const agent = await tx.agentDefinition.create({
        data: { name: config.name, origin: 'builtin_default', draftConfig: json(config) },
      });
      const snapshot = await this.snapshot(tx, config, true);
      rev = await tx.agentRevision.create({
        data: {
          agentId: agent.id,
          revision: 1,
          configSnapshot: json(snapshot),
          configHash: hash(snapshot),
        },
      });
    }
    assert(rev, '默认 Agent 尚未发布');
    await tx.agentBinding.upsert({
      where: { scopeKey: 'global' },
      create: { scopeKey: 'global', agentRevisionId: rev.id },
      update: { agentRevisionId: rev.id, revision: { increment: 1 } },
    });
    await this.bump(tx, 'global');
    return rev;
  }
  async restoreDefault() {
    return this.db.$transaction(async (tx) => {
      const rev = await this.createDefault(tx);
      await this.audit(tx, 'agent.restore_default', rev.agentId, {});
      return rev;
    });
  }
  async list() {
    return {
      agents: await this.db.agentDefinition
        .findMany({
          where: { status: 'active' },
          include: { revisions: { orderBy: { revision: 'desc' } } },
          orderBy: { createdAt: 'asc' },
        })
        .then((agents) =>
          agents.map((a) => ({ ...a, draftConfig: agentConfigSchema.parse(a.draftConfig) })),
        ),
      bindings: await this.db.agentBinding.findMany(),
    };
  }
  async save(input: {
    id?: string;
    expectedRevision?: number;
    config: AgentConfig;
    storeScope?: StoreScope;
  }) {
    const parsed = agentConfigSchema.parse(input.config);
    const config = { ...parsed, toolkitIds: toolkitReferences(parsed.toolkitIds) };
    return this.db.$transaction(async (tx) => {
      let agent;
      if (!input.id)
        agent = await tx.agentDefinition.create({
          data: { name: config.name, draftConfig: json(config) },
        });
      else {
        const result = await tx.agentDefinition.updateMany({
          where: { id: input.id, status: 'active', draftRevision: input.expectedRevision ?? -1 },
          data: { name: config.name, draftConfig: json(config), draftRevision: { increment: 1 } },
        });
        assert(result.count === 1, '草稿已被修改，请重新加载后保存', 'CONFLICT');
        agent = await tx.agentDefinition.findUniqueOrThrow({ where: { id: input.id } });
      }
      if (!input.id && input.storeScope)
        await saveResourceScope(
          tx,
          {
            kind: 'agent',
            resourceId: agent.id,
            expectedRevision: 0,
            ...input.storeScope,
          },
          { invalidateRuns: false },
        );
      return agent;
    });
  }
  private async snapshot(
    tx: Tx,
    config: AgentConfig,
    allowUnconfigured = false,
  ): Promise<PublishedConfig> {
    config = { ...config, toolkitIds: toolkitReferences(config.toolkitIds) };
    const model = config.modelProfileId
      ? await tx.modelProfile.findUnique({ where: { id: config.modelProfileId } })
      : null;
    assert(allowUnconfigured || model?.kind === 'chat', '请先选择有效的对话模型');
    const ids = [...config.toolkitIds, ...config.workflowIds];
    assert(new Set(ids).size === ids.length, '请勿重复挂载资源');
    const assets = [
      ...(await Promise.all(config.toolkitIds.map((id) => currentToolkit(tx, id)))),
      ...(await tx.installedExtension.findMany({
        where: { id: { in: config.workflowIds }, status: 'enabled' },
      })),
    ];
    assert(assets.length === ids.length, '挂载资源缺失或未启用');
    assert(
      new Set(assets.map((a) => a.assetId)).size === assets.length,
      '同一资源只能挂载一个版本，请移除旧版本再发布',
    );
    for (const a of assets) {
      const manifest = a.manifest as { kind: string };
      assert(
        (config.toolkitIds.includes(toolkitIdentity(a.id)) ? 'toolkit' : 'workflow') ===
          manifest.kind,
        '资源集合类型不匹配',
      );
    }
    assert(
      new Set(config.subAgents.map((s) => s.alias)).size === config.subAgents.length,
      '子 Agent 别名重复',
    );
    return {
      ...config,
      skills: await snapshotSkills(tx, config.skillIds),
      modelSnapshot: model ? JSON.parse(JSON.stringify(model)) : null,
      assetLock: assets.map((a) => ({ id: a.id, hash: a.artifactHash })),
    };
  }
  async prepareDraft(id: string) {
    return this.db.$transaction(async (tx) => {
      const agent = await tx.agentDefinition.findFirst({ where: { id, status: 'active' } });
      assert(agent, 'Agent 不存在');
      const config = agentConfigSchema.parse(agent.draftConfig);
      for (const child of config.subAgents)
        await this.validateTree(
          (await currentAgentPublication(tx, child.revisionId)).id,
          [id],
          1,
          tx,
        );
      return this.snapshot(tx, config);
    });
  }
  async validateTree(
    revisionId: string,
    path: string[] = [],
    depth = 0,
    tx: Tx = this.db,
  ): Promise<void> {
    assert(depth <= 4, '子 Agent 嵌套过深');
    const rev = await tx.agentRevision.findUnique({
      where: { id: revisionId },
      include: { agent: true },
    });
    assert(rev && rev.agent.status === 'active', '回复 Agent 或子 Agent 已删除');
    assert(!path.includes(rev.agentId), '子 Agent 不能形成调用环路');
    const c = rev.configSnapshot as unknown as PublishedConfig;
    publishedSkills(c);
    for (const id of c.toolkitIds) {
      const current = await currentToolkit(tx, id);
      const recorded = c.assetLock?.find((lock) => lock.id === current.id);
      assert(!recorded || recorded.hash === current.artifactHash, '资源版本不可用');
    }
    for (const a of c.assetLock ?? []) {
      if (!c.workflowIds.includes(a.id)) continue;
      const asset = await tx.installedExtension.findUnique({ where: { id: a.id } });
      assert(asset?.status === 'enabled' && asset.artifactHash === a.hash, '资源版本不可用');
    }
    for (const child of c.subAgents) {
      const current = await currentAgentPublication(tx, child.revisionId);
      await this.validateTree(current.id, [...path, rev.agentId], depth + 1, tx);
    }
  }
  async publish(agentId: string, expectedRevision: number, transaction?: Tx) {
    const apply = async (tx: Tx) => {
      const a = await tx.agentDefinition.findUnique({
        where: { id: agentId },
        include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
      });
      assert(a?.status === 'active', 'Agent 不存在');
      assert(a.draftRevision === expectedRevision, '草稿已变化', 'CONFLICT');
      const c = agentConfigSchema.parse(a.draftConfig);
      for (const sub of c.subAgents)
        await this.validateTree(
          (await currentAgentPublication(tx, sub.revisionId)).id,
          [a.id],
          1,
          tx,
        );
      const snapshot = await this.snapshot(tx, c);
      if (a.revisions[0]?.configHash === hash(snapshot)) return a.revisions[0];
      const rev = await tx.agentRevision.create({
        data: {
          agentId,
          revision: (a.revisions[0]?.revision ?? 0) + 1,
          configSnapshot: json(snapshot),
          configHash: hash(snapshot),
        },
      });
      for (const sub of c.subAgents)
        await tx.agentRevisionSubAgent.create({
          data: { parentRevisionId: rev.id, alias: sub.alias, childRevisionId: sub.revisionId },
        });
      // Check the newly published graph as a whole, including indirect references back to us.
      await this.validateTree(rev.id, [], 0, tx);
      await this.audit(tx, 'agent.publish', a.id, { revision: rev.revision });
      const applied = await this.retargetBindings(tx, agentId, rev.id);
      await this.audit(tx, 'agent.publish.apply', a.id, {
        revision: rev.revision,
        revisionId: rev.id,
        scopes: applied.map((b) => b.scopeKey),
      });
      return rev;
    };
    return transaction ? apply(transaction) : this.db.$transaction(apply);
  }
  /** Direct bindings and parents using this Agent receive the publication atomically. */
  private async retargetBindings(tx: Tx, agentId: string, revisionId: string) {
    const previous = await tx.agentRevision.findMany({
      where: { agentId, id: { not: revisionId } },
      select: { id: true },
    });
    if (!previous.length) return [];
    const allBindings = await tx.agentBinding.findMany();
    const bindings: typeof allBindings = [];
    const usesAgent = async (reference: string, seen = new Set<string>()): Promise<boolean> => {
      const selected = await tx.agentRevision.findUnique({ where: { id: reference } });
      if (!selected || seen.has(selected.agentId)) return false;
      if (selected.agentId === agentId) return true;
      seen.add(selected.agentId);
      const config = selected.configSnapshot as unknown as PublishedConfig;
      for (const sub of config.subAgents) {
        const current = await currentAgentPublication(tx, sub.revisionId).catch(() => null);
        if (current && (await usesAgent(current.id, seen))) return true;
      }
      return false;
    };
    for (const binding of allBindings)
      if (await usesAgent(binding.agentRevisionId)) bindings.push(binding);
    if (!bindings.length) return [];
    await this.validateTree(revisionId, [], 0, tx);
    for (const binding of bindings) {
      const direct = previous.some((r) => r.id === binding.agentRevisionId);
      const target = direct ? revisionId : binding.agentRevisionId;
      const root = await tx.agentRevision.findUniqueOrThrow({ where: { id: target } });
      const scope = await getResourceScope(tx, 'agent', root.agentId);
      await this.validateTree(target, [], 0, tx);
      if (binding.scopeKey === 'global')
        assert(scope.mode === 'all', '全局工作 Agent 必须允许全部店铺使用');
      else {
        assert(
          await tx.store.findFirst({
            where: { id: binding.scopeKey.slice(6), accounts: { some: {} } },
          }),
          '店铺不存在或已移除',
        );
        await assertResourceAllowed(tx, 'agent', root.agentId, binding.scopeKey.slice(6));
      }
      if (binding.scopeKey === 'global') {
        for (const store of await tx.store.findMany({
          where: { accounts: { some: {} } },
          select: { id: true },
        }))
          await this.validateSettings(tx, target, `store:${store.id}`);
      } else await this.validateSettings(tx, target, binding.scopeKey);
    }
    await tx.agentBinding.updateMany({
      where: { agentRevisionId: { in: previous.map((r) => r.id) } },
      data: { agentRevisionId: revisionId, revision: { increment: 1 } },
    });
    for (const binding of bindings) await this.bump(tx, binding.scopeKey);
    const storeIds = await this.storesForScopes(
      tx,
      bindings.map((b) => b.scopeKey),
    );
    if (storeIds.length)
      await cancelGeneratingReplies(
        tx,
        storeIds,
        '工作 Agent 的接待配置已更新，本轮旧回复已取消，请人工处理当前问题',
      );
    return bindings;
  }
  private async storesForScopes(tx: Tx, scopeKeys: string[]) {
    const ids = new Set<string>();
    for (const key of scopeKeys) if (key.startsWith('store:')) ids.add(key.slice(6));
    if (!scopeKeys.includes('global')) return [...ids];
    const overrides = await tx.agentBinding.findMany({
      where: { scopeKey: { startsWith: 'store:' } },
      select: { scopeKey: true },
    });
    const stores = await tx.store.findMany({
      where: { id: { notIn: overrides.map((x) => x.scopeKey.slice(6)) } },
      select: { id: true },
    });
    for (const store of stores) ids.add(store.id);
    return [...ids];
  }
  async resolve(storeId: string) {
    const binding =
      (await this.db.agentBinding.findUnique({ where: { scopeKey: `store:${storeId}` } })) ??
      (await this.db.agentBinding.findUnique({ where: { scopeKey: 'global' } }));
    if (!binding) return null;
    await this.validateTree(binding.agentRevisionId);
    const revision = await this.db.agentRevision.findUniqueOrThrow({
      where: { id: binding.agentRevisionId },
    });
    await assertResourceAllowed(this.db, 'agent', revision.agentId, storeId);
    return { binding, revision, config: revision.configSnapshot as unknown as PublishedConfig };
  }

  private async validateSettings(
    tx: Tx,
    revisionId: string,
    scopeKey: string,
    seen = new Set<string>(),
  ) {
    if (seen.has(revisionId)) return;
    seen.add(revisionId);
    const rev = await tx.agentRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const config = rev.configSnapshot as unknown as PublishedConfig;
    for (const reference of [...config.toolkitIds, ...config.workflowIds]) {
      const kind = config.toolkitIds.includes(reference) ? 'toolkit' : 'workflow';
      const assetId = kind === 'toolkit' ? (await currentToolkit(tx, reference)).id : reference;
      if (scopeKey !== 'global' && !(await resourceAllowed(tx, kind, assetId, scopeKey.slice(6))))
        continue;
      if (scopeKey !== 'global') {
        const [asset, store] = await Promise.all([
          tx.installedExtension.findUniqueOrThrow({ where: { id: assetId } }),
          tx.store.findUniqueOrThrow({ where: { id: scopeKey.slice(6) } }),
        ]);
        const platforms = (asset.manifest as { platforms?: string[] }).platforms;
        if (platforms && !platforms.includes(store.platform)) continue;
      }
      await this.validateAssetSettings(tx, assetId, scopeKey);
    }
    for (const child of config.subAgents) {
      const childRev = await currentAgentPublication(tx, child.revisionId);
      if (
        scopeKey !== 'global' &&
        !(await resourceAllowed(tx, 'agent', childRev.agentId, scopeKey.slice(6)))
      )
        continue;
      await this.validateSettings(tx, childRev.id, scopeKey, seen);
    }
  }
  private async validateAssetSettings(tx: Tx, assetId: string, scopeKey: string) {
    const asset = await tx.installedExtension.findUniqueOrThrow({ where: { id: assetId } });
    const rows = await assetSettingsRows(tx, assetId, scopeKey.replace(/^store:/, ''));
    const values = {
      ...(rows.find((r) => r.scopeKey === 'global')?.values as object),
      ...(rows.find((r) => r.scopeKey === scopeKey)?.values as object),
    } as Record<string, unknown>;
    const fields =
      (
        asset.manifest as {
          settingsFields?: Array<{ key: string; label: string; required: boolean }>;
        }
      ).settingsFields ?? [];
    for (const field of fields)
      assert(
        !field.required ||
          (values[field.key] !== undefined &&
            values[field.key] !== null &&
            values[field.key] !== ''),
        `资源设置缺失：${asset.assetId} / ${field.label}`,
      );
  }
  async bind(
    input: {
      scopeKey: string;
      agentId?: string | null;
      revisionId?: string | null;
      expectedRevision: number | null;
    },
    transaction?: Tx,
  ) {
    const apply = async (tx: Tx) => {
      assert(input.scopeKey === 'global' || input.scopeKey.startsWith('store:'), '无效绑定范围');
      if (input.scopeKey !== 'global')
        assert(
          await tx.store.findFirst({
            where: { id: input.scopeKey.slice(6), accounts: { some: {} } },
          }),
          '店铺不存在或已移除',
        );
      const old = await tx.agentBinding.findUnique({ where: { scopeKey: input.scopeKey } });
      assert(
        (old?.revision ?? null) === input.expectedRevision,
        '工作绑定已变化，请刷新',
        'CONFLICT',
      );
      assert(
        (input.agentId !== undefined) !== (input.revisionId !== undefined),
        '请选择一个工作 Agent',
      );
      let revisionId = input.revisionId;
      if (input.agentId) {
        const current = await tx.agentRevision.findFirst({
          where: { agentId: input.agentId, agent: { status: 'active' } },
          orderBy: { revision: 'desc' },
        });
        assert(current, 'Agent 已删除或尚未发布');
        revisionId = current.id;
      }
      if (revisionId) {
        const selected = await tx.agentRevision.findUnique({ where: { id: revisionId } });
        assert(selected, 'Agent 的发布记录不存在');
        const scope = await getResourceScope(tx, 'agent', selected.agentId);
        if (input.scopeKey === 'global')
          assert(scope.mode === 'all', '全局工作 Agent 必须允许全部店铺使用');
        else await assertResourceAllowed(tx, 'agent', selected.agentId, input.scopeKey.slice(6));
        const latest = await tx.agentRevision.findFirst({
          where: { agentId: selected.agentId },
          orderBy: { revision: 'desc' },
        });
        assert(latest?.id === revisionId, 'Agent 已重新发布，请刷新后选择');
        await this.validateTree(revisionId, [], 0, tx);
        if (input.scopeKey === 'global') {
          for (const store of await tx.store.findMany({
            where: { accounts: { some: {} } },
            select: { id: true },
          }))
            await this.validateSettings(tx, revisionId, `store:${store.id}`);
        } else await this.validateSettings(tx, revisionId, input.scopeKey);
        if (old?.agentRevisionId === revisionId) return { ok: true };
        await tx.agentBinding.upsert({
          where: { scopeKey: input.scopeKey },
          create: {
            scopeKey: input.scopeKey,
            agentRevisionId: revisionId,
          },
          update: {
            agentRevisionId: revisionId,
            revision: { increment: 1 },
          },
        });
      } else if (old) await tx.agentBinding.delete({ where: { scopeKey: input.scopeKey } });
      await this.bump(tx, input.scopeKey);
      await this.audit(tx, 'agent.bind', input.scopeKey, input);
      return { ok: true };
    };
    return transaction ? apply(transaction) : this.db.$transaction(apply);
  }
  async remove(id: string) {
    return this.db.$transaction(async (tx) => {
      const a = await tx.agentDefinition.findUnique({
        where: { id },
        include: { revisions: true },
      });
      assert(a?.status === 'active', 'Agent 不存在');
      const childRefs = await tx.agentRevisionSubAgent.findMany({
        where: { childRevisionId: { in: a.revisions.map((r) => r.id) } },
      });
      for (const ref of childRefs) {
        const parent = await tx.agentRevision.findUnique({
          where: { id: ref.parentRevisionId },
          include: { agent: true },
        });
        assert(parent?.agent.status !== 'active', '该 Agent 仍被其他 Agent 挂载，请先解除引用');
      }
      const binds = await tx.agentBinding.findMany({
        where: { agentRevisionId: { in: a.revisions.map((r) => r.id) } },
      });
      await tx.agentBinding.deleteMany({
        where: { scopeKey: { in: binds.map((b) => b.scopeKey) } },
      });
      await tx.agentDefinition.update({ where: { id }, data: { status: 'deleted' } });
      for (const b of binds) await this.bump(tx, b.scopeKey);
      await this.audit(tx, 'agent.delete', id, { detached: binds.map((b) => b.scopeKey) });
      return { ok: true };
    });
  }
  async restoreRevision(revisionId: string, expectedRevision: number) {
    const r = await this.db.agentRevision.findUniqueOrThrow({ where: { id: revisionId } });
    const {
      modelSnapshot: _,
      assetLock: __,
      skills: ___,
      ...config
    } = r.configSnapshot as unknown as PublishedConfig;
    return this.save({ id: r.agentId, expectedRevision, config });
  }
  // Copy a built-in default for one store, or update that store's own starter.
  // Model-only changes preserve the published prompt and resource snapshots, including customizations.
  async canChangeStarterModel(storeId: string, revisionId: string, tx: Tx = this.db) {
    const revision = await tx.agentRevision.findUnique({
      where: { id: revisionId },
      include: { agent: true },
    });
    if (
      !revision ||
      !['builtin_default', 'builtin_setup'].includes(revision.agent.origin) ||
      revision.agent.status !== 'active'
    )
      return false;
    const {
      modelSnapshot: _,
      assetLock: __,
      skills: ___,
      ...published
    } = revision.configSnapshot as unknown as PublishedConfig;
    const current = agentConfigSchema.safeParse(published);
    const draft = agentConfigSchema.safeParse(revision.agent.draftConfig);
    if (!current.success || !draft.success) return false;
    if (hash(normalizeAgentToolkits(draft.data)) !== hash(normalizeAgentToolkits(current.data)))
      return false;
    const revisions = await tx.agentRevision.findMany({
      where: { agentId: revision.agentId },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    if (revisions[0]?.id !== revisionId) return false;
    if (revision.agent.origin === 'builtin_default') return true;
    const bindings = await tx.agentBinding.findMany({
      where: { agentRevisionId: { in: revisions.map((r) => r.id) } },
    });
    return (
      bindings.length === 1 &&
      bindings[0].scopeKey === `store:${storeId}` &&
      bindings[0].agentRevisionId === revisionId
    );
  }
  async configureStarter(input: { storeId: string; modelId: string; expectedConfigEpoch: number }) {
    return this.db.$transaction(async (tx) => {
      const store = await tx.store.findUnique({
        where: { id: input.storeId },
        include: { accounts: true },
      });
      assert(store?.accounts.length, '请先连接这家店铺');
      assert(
        store.replyConfigEpoch === input.expectedConfigEpoch,
        '接待配置已变化，请刷新引导后继续',
        'CONFLICT',
      );
      const binding =
        (await tx.agentBinding.findUnique({ where: { scopeKey: `store:${store.id}` } })) ??
        (await tx.agentBinding.findUnique({ where: { scopeKey: 'global' } }));
      const current = binding
        ? await tx.agentRevision.findUnique({
            where: { id: binding.agentRevisionId },
            include: { agent: true },
          })
        : null;
      const canChange = !!current && (await this.canChangeStarterModel(store.id, current.id, tx));
      const changeStarter = canChange && current!.agent.origin === 'builtin_setup';
      if (binding) {
        assert(
          canChange,
          '已有工作助手配置，请保留当前助手或到高级定制中调整；引导不会替换现有绑定',
          'CONFLICT',
        );
        await this.validateTree(current!.id, [], 0, tx);
        await assertResourceAllowed(tx, 'agent', current!.agentId, store.id);
      }
      let config = defaultConfig(input.modelId);
      let snapshot: PublishedConfig;
      if (current) {
        const previous = current.configSnapshot as unknown as PublishedConfig;
        const { modelSnapshot: _, assetLock: __, skills: ___, ...published } = previous;
        const model = await tx.modelProfile.findUnique({ where: { id: input.modelId } });
        assert(model?.kind === 'chat', '请先选择有效的对话模型');
        config = normalizeAgentToolkits({
          ...agentConfigSchema.parse(published),
          modelProfileId: input.modelId,
        });
        config.name = changeStarter ? config.name : `${store.name.slice(0, 73)} · 客服助手`;
        // Do not re-snapshot resources: changing the model must not adopt newer Skill content
        // or replace legacy toolkits behind the user's back.
        snapshot = { ...previous, ...config, modelSnapshot: JSON.parse(JSON.stringify(model)) };
      } else {
        config.name = `${store.name.slice(0, 73)} · 客服助手`;
        snapshot = await this.snapshot(tx, config);
      }
      const agent = changeStarter
        ? await tx.agentDefinition.update({
            where: { id: current!.agentId, draftRevision: current!.agent.draftRevision },
            data: { draftConfig: json(config), draftRevision: { increment: 1 } },
          })
        : await tx.agentDefinition.create({
            data: { name: config.name, origin: 'builtin_setup', draftConfig: json(config) },
          });
      if (!changeStarter)
        await saveResourceScope(
          tx,
          {
            kind: 'agent',
            resourceId: agent.id,
            expectedRevision: 0,
            mode: 'selected',
            storeIds: [store.id],
          },
          { invalidateRuns: false },
        );
      else await assertResourceAllowed(tx, 'agent', agent.id, store.id);
      const revision = await tx.agentRevision.create({
        data: {
          agentId: agent.id,
          revision: changeStarter ? current!.revision + 1 : 1,
          configSnapshot: json(snapshot),
          configHash: hash(snapshot),
        },
      });
      for (const sub of config.subAgents)
        await tx.agentRevisionSubAgent.create({
          data: {
            parentRevisionId: revision.id,
            alias: sub.alias,
            childRevisionId: sub.revisionId,
          },
        });
      await tx.agentBinding.upsert({
        where: { scopeKey: `store:${store.id}` },
        create: { scopeKey: `store:${store.id}`, agentRevisionId: revision.id },
        update: { agentRevisionId: revision.id, revision: { increment: 1 } },
      });
      await this.bump(tx, `store:${store.id}`);
      await this.audit(tx, 'onboarding.configure', store.id, {
        agentId: agent.id,
        revisionId: revision.id,
        modelId: input.modelId,
      });
      return { ok: true };
    });
  }
  async setDefaultModel(modelId: string) {
    const a = await this.db.agentDefinition.findFirst({
      where: { origin: 'builtin_default', status: 'active' },
    });
    if (!a) return;
    const c = agentConfigSchema.parse(a.draftConfig);
    if (c.modelProfileId === modelId) {
      const latest = await this.db.agentRevision.findFirst({
        where: { agentId: a.id },
        orderBy: { revision: 'desc' },
      });
      const model = await this.db.modelProfile.findUniqueOrThrow({ where: { id: modelId } });
      if (
        (latest?.configSnapshot as unknown as PublishedConfig)?.modelSnapshot?.revision ===
        model.revision
      )
        return;
    }
    const saved = await this.save({
      id: a.id,
      expectedRevision: a.draftRevision,
      config: { ...c, modelProfileId: modelId },
    });
    await this.publish(saved.id, saved.draftRevision);
  }
  async bump(tx: Tx, scopeKey: string) {
    const overrides = await tx.agentBinding.findMany({
      where: { scopeKey: { startsWith: 'store:' } },
    });
    const where =
      scopeKey === 'global'
        ? { id: { notIn: overrides.map((x) => x.scopeKey.slice(6)) } }
        : { id: scopeKey.slice(6) };
    await tx.store.updateMany({ where, data: { replyConfigEpoch: { increment: 1 } } });
  }
  private audit(tx: Tx, type: string, scope: string, details: unknown) {
    return tx.auditEvent.create({
      data: { type, scope, actor: 'local-user', details: json(details) },
    });
  }
}
