import manifest from './commerce-toolkit-v1.2.1.manifest.json';
import { commerceToolkit } from '../commerce-toolkit';
import type { ExtensionManifest, ExtensionModule } from '../../../extension-sdk/src';
export const legacyCommerceV121: ExtensionModule = {
  manifest: manifest as unknown as ExtensionManifest,
  createTools: async (ctx) => {
    const tools = await commerceToolkit.createTools!(ctx);
    return Object.fromEntries(
      manifest.members.map((m) => {
        const id = `builtin/commerce/${m.id}`;
        return [id, tools[id]];
      }),
    );
  },
};
