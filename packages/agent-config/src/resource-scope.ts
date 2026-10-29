import type { PrismaClient, Tx } from '../../database/src';
import { json } from '../../database/src';
import {
  resourceScopeInput,
  scopeAllows,
  type ResourceKind,
  type ResourceScopeRecord,
  type StoreScope,
} from '../../contracts/src/resource-scope';
import { assert } from '../../core/src/util';

type Db = PrismaClient | Tx;
export const resourceIdentity = (kind: ResourceKind, id: string) => {
  const identity = kind === 'toolkit' || kind === 'workflow' ? id.split('@')[0] : id;
  return kind === 'toolkit' && identity === 'builtin/pdd' ? 'builtin/commerce' : identity;
};
export async function getResourceScope(db: Db, kind: ResourceKind, id: string) {
  const resourceId = resourceIdentity(kind, id);
  const row = await db.resourceScope.findUnique({
    where: { kind_resourceId: { kind, resourceId } },
  });
  return row
    ? { ...row, kind, storeIds: row.storeIds as string[], mode: row.mode as StoreScope['mode'] }
    : { kind, resourceId, mode: 'all' as const, storeIds: [], revision: 0 };
}
export async function resourceAllowed(db: Db, kind: ResourceKind, id: string, storeId: string) {
  return scopeAllows(await getResourceScope(db, kind, id), storeId);
}
export async function assertResourceAllowed(
  db: Db,
  kind: ResourceKind,
  id: string,
  storeId: string,
) {
  assert(
    await resourceAllowed(db, kind, id, storeId),
    `${kind} 未授权当前店铺使用`,
    'RESOURCE_SCOPE_DENIED',
  );
}
export async function saveResourceScope(
  tx: Tx,
  raw: {
    kind: ResourceKind;
    resourceId: string;
    expectedRevision: number;
    mode: 'all' | 'selected';
    storeIds?: string[];
  },
  options: { invalidateRuns?: boolean } = {},
): Promise<ResourceScopeRecord> {
  const input = resourceScopeInput.parse(raw);
  const resourceId = resourceIdentity(input.kind, input.resourceId);
  const exists =
    input.kind === 'agent'
      ? await tx.agentDefinition.findFirst({ where: { id: resourceId, status: 'active' } })
      : input.kind === 'skill'
        ? await tx.skillDefinition.findFirst({ where: { id: resourceId, status: 'active' } })
        : await tx.installedExtension.findFirst({
            where: { assetId: resourceId, status: 'enabled' },
          });
  assert(exists, '资源已删除或不存在');
  if (input.kind === 'toolkit' || input.kind === 'workflow')
    assert(
      (exists as { manifest: { kind?: string } }).manifest.kind === input.kind,
      '资源类型不匹配',
    );
  const storeIds = input.mode === 'all' ? [] : [...new Set(input.storeIds)].sort();
  const active = await tx.store.count({ where: { id: { in: storeIds }, accounts: { some: {} } } });
  assert(active === storeIds.length, '所选店铺已移除，请重新选择', 'STORE_REMOVED');
  const old = await getResourceScope(tx, input.kind, resourceId);
  assert(old.revision === input.expectedRevision, '可用店铺配置已变化，请刷新', 'CONFLICT');
  const data = { mode: input.mode, storeIds: json(storeIds), revision: old.revision + 1 };
  const saved = await tx.resourceScope.upsert({
    where: { kind_resourceId: { kind: input.kind, resourceId } },
    create: { kind: input.kind, resourceId, ...data },
    update: data,
  });
  // Revoke in-flight work too; immutable published snapshots never confer authorization.
  if (options.invalidateRuns !== false)
    await tx.store.updateMany({
      where:
        old.mode === 'all' || input.mode === 'all'
          ? {}
          : { id: { in: [...old.storeIds, ...storeIds] } },
      data: { replyConfigEpoch: { increment: 1 } },
    });
  await tx.auditEvent.create({
    data: {
      type: 'resource.scope',
      scope: resourceId,
      actor: 'local-user',
      details: json({ ...input, storeIds }),
    },
  });
  return { ...saved, kind: input.kind, mode: input.mode, storeIds };
}
