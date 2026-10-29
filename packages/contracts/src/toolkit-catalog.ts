export const COMMERCE_TOOLKIT_ID = 'builtin/commerce@1.4.0';
export const LEGACY_COMMERCE_TOOLKIT_ID = 'builtin/commerce@1.0.0';
export const RETIRED_PDD_TOOLKIT_IDS = ['builtin/pdd@1.0.0', 'builtin/pdd@2.0.0'] as const;
// Agent mounts name a package. Legacy versioned references have the same meaning.
export function toolkitIdentity(id: string) {
  const name = id.split('@')[0];
  return name === 'builtin/pdd' ? 'builtin/commerce' : name;
}
export function toolkitReferences(ids: string[]) {
  return replaceRetiredToolkits(ids).map(toolkitIdentity);
}
export function normalizeAgentToolkits<T extends { toolkitIds: string[] }>(config: T): T {
  return { ...config, toolkitIds: toolkitReferences(config.toolkitIds) };
}
export function compareVersions(a: string, b: string) {
  const left = a.split('.').map(BigInt),
    right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
export function latestToolkits<
  T extends { assetId: string; version: string; status: string; manifest: unknown },
>(rows: T[]) {
  const current = new Map<string, T>();
  for (const row of rows) {
    if ((row.manifest as { kind?: string }).kind !== 'toolkit') continue;
    const previous = current.get(row.assetId);
    if (
      !previous ||
      (row.status === 'enabled' && previous.status !== 'enabled') ||
      ((row.status === 'enabled') === (previous.status === 'enabled') &&
        compareVersions(row.version, previous.version) > 0)
    )
      current.set(row.assetId, row);
  }
  return [...current.values()];
}
export function isRetiredToolkit(id: string) {
  return (RETIRED_PDD_TOOLKIT_IDS as readonly string[]).includes(id);
}
export function replaceRetiredToolkits(ids: string[], upgradeCommerce = false) {
  // Only coalesce the replacement, preserving ordinary duplicate validation and unrelated IDs.
  const upgrading = upgradeCommerce || ids.some(isRetiredToolkit);
  const replaces = (id: string) =>
    isRetiredToolkit(id) || (upgrading && id === LEGACY_COMMERCE_TOOLKIT_ID);
  if (!ids.some(replaces)) return ids;
  let commerceSeen = false;
  return ids.flatMap((id) => {
    const current = replaces(id) ? COMMERCE_TOOLKIT_ID : id;
    if (current !== COMMERCE_TOOLKIT_ID) return [current];
    if (commerceSeen) return [];
    commerceSeen = true;
    return [current];
  });
}
