import { platformSchema, type PlatformId } from '../../contracts/src/platform';
import { z } from 'zod';
import type { ToolsInput } from '@mastra/core/agent';
import type { AnyWorkflow } from '@mastra/core/workflows';
export const manifestSchema = z
  .object({
    apiVersion: z.literal(1),
    assetId: z.string().regex(/^(builtin|local)\/[a-z][a-z0-9-]{0,60}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    kind: z.enum(['toolkit', 'workflow']),
    platforms: z.array(platformSchema).min(1).optional(),
    name: z.string().min(1).max(100),
    description: z.string().max(2000),
    settingsFields: z
      .array(
        z.object({
          key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          label: z.string(),
          required: z.boolean().default(false),
          secret: z.boolean().default(false),
        }),
      )
      .default([]),
    members: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),
          name: z.string(),
          description: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
          outputSchema: z.record(z.string(), z.unknown()),
          requiresCapabilities: z.array(z.string()).default([]),
          requiresOperations: z.array(z.string().max(100)).max(50).optional(),
          // Read-only compatibility for installed v1 packages. Retired entry members
          // are not listed, exposed to Agents, or executable; new installs reject them.
          contract: z.literal('reply.v1').optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ExtensionManifest = z.infer<typeof manifestSchema>;
export interface ScopedAssetContext {
  readonly role: 'reply' | 'debug';
  readonly storeId: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly knowledge: { search(query: string): Promise<unknown> };
  readonly platform: {
    readonly id?: PlatformId;
    readonly operations?: readonly string[];
    query(operation: string, input: Record<string, unknown>): Promise<unknown>;
    action?(operation: string, input: Record<string, unknown>): Promise<unknown>;
  };
  readonly agents: {
    runSub(alias: string, input: string): Promise<unknown>;
  };
  readonly logger: { info(message: string): void };
}
export interface ExtensionModule {
  manifest: ExtensionManifest;
  createTools?: (context: ScopedAssetContext) => ToolsInput | Promise<ToolsInput>;
  createWorkflows?: (
    context: ScopedAssetContext,
  ) => Record<string, AnyWorkflow> | Promise<Record<string, AnyWorkflow>>;
}
export type ToolkitModule = ExtensionModule;
export type WorkflowModule = ExtensionModule;
export type ToolMap = ToolsInput;
export type WorkflowMap = Record<string, AnyWorkflow>;
export const defineExtension = (extension: ExtensionModule) => extension;
