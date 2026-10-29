import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ExtensionModule } from '../../../packages/extension-sdk/src/index';
const input = z.object({ text: z.string() });
const output = z.object({ text: z.string() });
export default {
  manifest: {
    apiVersion: 1,
    assetId: 'local/shop-helpers',
    version: '1.0.0',
    kind: 'toolkit',
    name: '店铺话术助手',
    description: '一个可以复制修改的双工具 Toolkit 示例',
    settingsFields: [{ key: 'shopName', label: '店铺称呼', required: true, secret: false }],
    members: [
      {
        id: 'greeting',
        name: '生成问候',
        description: '生成带店铺称呼的问候语',
        inputSchema: z.toJSONSchema(input),
        outputSchema: z.toJSONSchema(output),
        requiresCapabilities: [],
      },
      {
        id: 'trim',
        name: '整理空白',
        description: '清理多余空白',
        inputSchema: z.toJSONSchema(input),
        outputSchema: z.toJSONSchema(output),
        requiresCapabilities: [],
      },
    ],
  },
  createTools: (context) => ({
    'local/shop-helpers/greeting': createTool({
      id: 'local/shop-helpers/greeting',
      description: '生成店铺问候',
      inputSchema: input,
      outputSchema: output,
      execute: async ({ text }) => ({
        text: `您好，欢迎来到${context.settings.shopName || '本店'}。${text}`,
      }),
    }),
    'local/shop-helpers/trim': createTool({
      id: 'local/shop-helpers/trim',
      description: '整理文本空白',
      inputSchema: input,
      outputSchema: output,
      execute: async ({ text }) => ({ text: text.trim().replace(/\n{3,}/g, '\n\n') }),
    }),
  }),
} satisfies ExtensionModule;
