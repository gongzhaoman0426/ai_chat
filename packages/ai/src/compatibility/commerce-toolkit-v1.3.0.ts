import manifest from './commerce-toolkit-v1.3.0.manifest.json';
import { commerceToolkit } from '../commerce-toolkit';
import type { ExtensionManifest, ExtensionModule } from '../../../extension-sdk/src';

export const legacyCommerceV130: ExtensionModule = {
  manifest: manifest as unknown as ExtensionManifest,
  createTools: async (ctx) => {
    const tools = await commerceToolkit.createTools!(ctx);
    return Object.fromEntries(
      manifest.members.map((member) => {
        const id = `builtin/commerce/${member.id}`;
        return [id, tools[id]];
      }),
    );
  },
};
