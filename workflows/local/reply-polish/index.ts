import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import type { ExtensionModule } from '../../../packages/extension-sdk/src/index';
const input = z.object({ text: z.string() });
const output = z.object({ text: z.string() });
const splitOutput = z.object({ paragraphs: z.array(z.string()) });
export default {
  manifest: {
    apiVersion: 1,
    assetId: 'local/reply-polish',
    version: '1.1.0',
    kind: 'workflow',
    name: '客服文本流程',
    description: '挂载给 Agent 按需调用的多成员文本处理流程，无需模型请求',
    settingsFields: [],
    members: [
      {
        id: 'normalize',
        name: '清理文本',
        description: '清理首尾空白并统一换行',
        inputSchema: z.toJSONSchema(input),
        outputSchema: z.toJSONSchema(output),
        requiresCapabilities: [],
      },
      {
        id: 'paragraphs',
        name: '拆分段落',
        description: '按空行拆分文本，返回非空段落列表',
        inputSchema: z.toJSONSchema(input),
        outputSchema: z.toJSONSchema(splitOutput),
        requiresCapabilities: [],
      },
    ],
  },
  createWorkflows: () => ({
    'local/reply-polish/normalize': createWorkflow({
      id: 'local/reply-polish/normalize',
      inputSchema: input,
      outputSchema: output,
    })
      .then(
        createStep({
          id: 'normalize',
          inputSchema: input,
          outputSchema: output,
          execute: async ({ inputData }) => ({
            text: inputData.text.trim().replace(/\r\n?/g, '\n'),
          }),
        }),
      )
      .commit(),
    'local/reply-polish/paragraphs': createWorkflow({
      id: 'local/reply-polish/paragraphs',
      inputSchema: input,
      outputSchema: splitOutput,
    })
      .then(
        createStep({
          id: 'normalize',
          inputSchema: input,
          outputSchema: output,
          execute: async ({ inputData }) => ({
            text: inputData.text.trim().replace(/\r\n?/g, '\n'),
          }),
        }),
      )
      .then(
        createStep({
          id: 'split',
          inputSchema: output,
          outputSchema: splitOutput,
          execute: async ({ inputData }) => ({
            paragraphs: inputData.text
              .split(/\n\s*\n/)
              .map((text) => text.trim())
              .filter(Boolean),
          }),
        }),
      )
      .commit(),
  }),
} satisfies ExtensionModule;
