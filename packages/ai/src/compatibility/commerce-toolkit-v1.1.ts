import originalManifest from './commerce-toolkit-v1.1.manifest.json';
import { commerceToolkit } from '../commerce-toolkit';
import type { ExtensionManifest, ExtensionModule } from '../../../extension-sdk/src';

// Both descriptions shipped under 1.1.0. Keep their exact historical manifests;
// new runs resolve the current package without rewriting saved Agent/run hashes.
const original = originalManifest as unknown as ExtensionManifest;
const clarified: ExtensionManifest = {
  ...original,
  members: original.members.map((member) =>
    member.id === 'buyer-footprint'
      ? {
          ...member,
          description:
            '查询当前会话买家关联的商品候选。闲鱼等平台没有完整浏览足迹，可能只有当前咨询商品；多个候选时先确认，不自行认定买家说的“这个商品”。',
        }
      : member,
  ),
};
export const legacyCommerceV11Modules: ExtensionModule[] = [original, clarified].map(
  (manifest) => ({
    manifest,
    createTools: async (ctx) => {
      const tools = await commerceToolkit.createTools!(ctx);
      return Object.fromEntries(
        manifest.members.map((member) => {
          const id = `${manifest.assetId}/${member.id}`;
          return [id, tools[id]];
        }),
      );
    },
  }),
);
