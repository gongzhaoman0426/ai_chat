import type { PrismaClient, Tx } from '../../database/src';
import { latestToolkits, toolkitIdentity } from '../../contracts/src/toolkit-catalog';
import { assert } from '../../core/src/util';
import type { PublishedConfig } from './index';
import { currentAgentPublication } from './agent-publication';
import { currentSkills, type PublishedSkill } from './skills';
type Db = PrismaClient | Tx;

export async function currentToolkit(db: Db, reference: string) {
  const rows = await db.installedExtension.findMany({
    where: { assetId: toolkitIdentity(reference), status: 'enabled' },
  });
  const row = latestToolkits(rows)[0];
  assert(row, `资源版本不可用：${toolkitIdentity(reference)} 没有已启用的 Toolkit`);
  return row;
}

// Resolve all packages and skills before model/tool calls, including lazy sub-Agents.
// Immutable Agent history is untouched; this tree records the actual resources used by one run.
export async function resolveRuntimeToolkits(db: Db, root: PublishedConfig, revisionId: string) {
  const tree: Record<string, PublishedConfig> = {};
  const packages = new Map<string, Awaited<ReturnType<typeof currentToolkit>>>();
  const agents = new Map<string, Awaited<ReturnType<typeof currentAgentPublication>>>();
  const skills = new Map<string, PublishedSkill | null>();
  const visiting = new Set<string>();
  const visit = async (config: PublishedConfig, id: string, depth: number) => {
    assert(depth <= 4 && !visiting.has(id), '子 Agent 嵌套过深或存在环路');
    if (tree[id]) return;
    visiting.add(id);
    const identities = [...new Set(config.toolkitIds.map(toolkitIdentity))];
    for (const identity of identities)
      if (!packages.has(identity)) packages.set(identity, await currentToolkit(db, identity));
    const toolkits = identities.map((identity) => packages.get(identity)!);
    const children = [];
    for (const child of config.subAgents) {
      const selected = await db.agentRevision.findUniqueOrThrow({
        where: { id: child.revisionId },
        select: { agentId: true },
      });
      if (!agents.has(selected.agentId))
        agents.set(selected.agentId, await currentAgentPublication(db, child.revisionId));
      children.push({ alias: child.alias, revision: agents.get(selected.agentId)! });
    }
    tree[id] = {
      ...config,
      skills: await currentSkills(db, config, skills),
      subAgents: children.map(({ alias, revision }) => ({ alias, revisionId: revision.id })),
      toolkitIds: toolkits.map((row) => row.id),
      assetLock: [
        ...(config.assetLock ?? []).filter((lock) => config.workflowIds.includes(lock.id)),
        ...toolkits.map((row) => ({ id: row.id, hash: row.artifactHash })),
      ],
    };
    for (const { revision } of children) {
      await visit(revision.configSnapshot as unknown as PublishedConfig, revision.id, depth + 1);
    }
    visiting.delete(id);
  };
  await visit(root, revisionId, 0);
  return tree;
}

// Toolkit settings follow the package as well. Old version-scoped settings remain readable;
// the newest explicit save in each scope wins, and store values override global values.
export async function assetSettingsRows(db: Db, reference: string, storeId: string) {
  const identity = toolkitIdentity(reference);
  const row = await db.installedExtension.findFirst({ where: { assetId: identity } });
  const toolkit = (row?.manifest as { kind?: string } | undefined)?.kind === 'toolkit';
  const rows = await db.assetSetting.findMany({
    where: {
      ...(toolkit
        ? { OR: [{ assetId: identity }, { assetId: { startsWith: `${identity}@` } }] }
        : { assetId: reference }),
      scopeKey: { in: ['global', `store:${storeId}`] },
    },
    orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
  });
  return [
    rows.find((r) => r.scopeKey === 'global'),
    rows.find((r) => r.scopeKey !== 'global'),
  ].filter((row): row is NonNullable<typeof row> => !!row);
}
