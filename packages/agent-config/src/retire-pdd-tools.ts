import { agentConfigSchema } from '../../contracts/src';
import {
  COMMERCE_TOOLKIT_ID,
  LEGACY_COMMERCE_TOOLKIT_ID,
  isRetiredToolkit,
  replaceRetiredToolkits,
} from '../../contracts/src/toolkit-catalog';
import { json, type Tx } from '../../database/src';
import { assert, hash } from '../../core/src/util';
import type { PublishedConfig } from './index';

export async function retirePddToolkits(tx: Tx, bump: (scopeKey: string) => Promise<void>) {
  const agents = await tx.agentDefinition.findMany({
    where: { status: 'active' },
    include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
  });
  const latestById = new Map(agents.flatMap((a) => a.revisions.map((r) => [r.id, r] as const)));
  const replacements = new Map<string, string>();
  const visiting = new Set<string>();
  const commerce = await tx.installedExtension.findUnique({ where: { id: COMMERCE_TOOLKIT_ID } });
  const scopes = new Set<string>();
  const migrateRevision = async (id: string): Promise<string> => {
    if (replacements.has(id)) return replacements.get(id)!;
    const latest = latestById.get(id);
    if (!latest) return id; // Historical pins remain immutable and use the compatibility adapter.
    assert(!visiting.has(id), '子 Agent 不能形成调用环路');
    visiting.add(id);
    const before = latest.configSnapshot as unknown as PublishedConfig;
    const toolkitIds = replaceRetiredToolkits(before.toolkitIds);
    const subAgents = [];
    for (const child of before.subAgents)
      subAgents.push({ ...child, revisionId: await migrateRevision(child.revisionId) });
    const toolsChanged = hash(toolkitIds) !== hash(before.toolkitIds);
    const childrenChanged = hash(subAgents) !== hash(before.subAgents);
    visiting.delete(id);
    if (!toolsChanged && !childrenChanged) {
      replacements.set(id, id);
      return id;
    }
    assert(commerce?.status === 'enabled', '店铺客服工具不可用，无法迁移旧工具挂载');
    const snapshot: PublishedConfig = {
      ...before,
      toolkitIds,
      subAgents,
      assetLock: toolsChanged
        ? [
            ...before.assetLock.filter(
              (a) =>
                !isRetiredToolkit(a.id) &&
                a.id !== COMMERCE_TOOLKIT_ID &&
                a.id !== LEGACY_COMMERCE_TOOLKIT_ID,
            ),
            { id: commerce.id, hash: commerce.artifactHash },
          ]
        : before.assetLock,
    };
    const revision = await tx.agentRevision.create({
      data: {
        agentId: latest.agentId,
        revision: latest.revision + 1,
        configSnapshot: json(snapshot),
        configHash: hash(snapshot),
      },
    });
    for (const child of subAgents)
      await tx.agentRevisionSubAgent.create({
        data: {
          parentRevisionId: revision.id,
          alias: child.alias,
          childRevisionId: child.revisionId,
        },
      });
    const bindings = await tx.agentBinding.findMany({ where: { agentRevisionId: id } });
    await tx.agentBinding.updateMany({
      where: { agentRevisionId: id },
      data: { agentRevisionId: revision.id, revision: { increment: 1 } },
    });
    for (const binding of bindings) scopes.add(binding.scopeKey);
    await tx.auditEvent.create({
      data: {
        type: 'agent.pdd_toolkits_retired',
        scope: latest.agentId,
        actor: 'system',
        details: json({
          previousRevisionId: id,
          revisionId: revision.id,
          toolsChanged,
          childrenChanged,
          scopes: bindings.map((b) => b.scopeKey),
        }),
      },
    });
    replacements.set(id, revision.id);
    return revision.id;
  };
  for (const id of latestById.keys()) await migrateRevision(id);
  // Migrate drafts independently; never publish pending prompt/model/resource edits.
  for (const agent of agents) {
    const parsed = agentConfigSchema.safeParse(agent.draftConfig);
    if (!parsed.success) continue;
    const before = parsed.data;
    const draft = {
      ...before,
      toolkitIds: replaceRetiredToolkits(before.toolkitIds),
      subAgents: before.subAgents.map((child) => ({
        ...child,
        revisionId: replacements.get(child.revisionId) ?? child.revisionId,
      })),
    };
    if (hash(draft) === hash(before)) continue;
    await tx.agentDefinition.update({
      where: { id: agent.id },
      data: { draftConfig: json(draft), draftRevision: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        type: 'agent.pdd_draft_migrated',
        scope: agent.id,
        actor: 'system',
        details: json({
          previousDraftRevision: agent.draftRevision,
          draftRevision: agent.draftRevision + 1,
        }),
      },
    });
  }
  // Global changes exclude store overrides, so each affected store advances once.
  for (const scope of scopes) await bump(scope);
  return { migratedRevisions: [...replacements].filter(([old, next]) => old !== next).length };
}
