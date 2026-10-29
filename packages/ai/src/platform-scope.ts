import {
  platformSchema,
  platformContextSchema,
  type PlatformId,
} from '../../contracts/src/platform';
import type { Capabilities } from '../../contracts/src';
import { commerceQueryCapability } from '../../contracts/src/commerce-tools';
import type { ExtensionManifest, ScopedAssetContext } from '../../extension-sdk/src';
import type { PrismaClient } from '../../database/src';
import type { ReplyContext } from '../../core/src/types';
import { assert } from '../../core/src/util';
export {
  operationCapabilities,
  availableOperations,
} from '../../contracts/src/platform-operations';
import { operationCapabilities } from '../../contracts/src/platform-operations';
export { resolveReplyScope } from '../../core/src/commerce-scope';
export function supportsAsset(manifest: ExtensionManifest, platform?: PlatformId) {
  if (!platform) return true; // isolated extension fixtures may be platform-neutral
  // Immutable legacy manifests predate platforms; do not rewrite their artifact hashes.
  if (manifest.assetId === 'builtin/pdd') return platform === 'pinduoduo';
  return !manifest.platforms || manifest.platforms.includes(platform);
}
export function memberOperations(
  manifest: ExtensionManifest,
  member: ExtensionManifest['members'][number],
) {
  if (member.requiresOperations) return member.requiresOperations;
  if (manifest.assetId === 'builtin/pdd' && member.id in operationCapabilities) return [member.id];
  return Object.entries(operationCapabilities)
    .filter(([, caps]) => caps.every((c) => member.requiresCapabilities.includes(c)))
    .map(([op]) => op);
}
export function supportsMember(
  manifest: ExtensionManifest,
  member: ExtensionManifest['members'][number],
  context: ScopedAssetContext,
) {
  if (!supportsAsset(manifest, context.platform.id)) return false;
  const required =
    member.requiresOperations ??
    (manifest.assetId === 'builtin/pdd' && member.id in operationCapabilities ? [member.id] : []);
  return (
    !context.platform.operations ||
    required.every((op) => context.platform.operations!.includes(op))
  );
}
