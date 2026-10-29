import { z } from 'zod';
import { qaSchema, type QaInput } from './index';

export const knowledgeBootstrapResultSchema = z
  .object({
    drafts: z
      .array(
        z
          .object({
            qa: qaSchema,
            sourceIds: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

export type KnowledgeBootstrapSource = {
  id: string;
  kind: 'product' | 'conversation';
  label: string;
  productIds: string[];
  content: unknown;
};

export type KnowledgeBootstrapState = {
  runId: string;
  storeId: string;
  status: 'running' | 'completed' | 'failed';
  phase: string;
  products: number;
  conversations: number;
  messages: number;
  warnings: string[];
  error?: string;
  drafts: Array<{ id: string; qa: QaInput; source: string }>;
  saved: number;
  updatedAt: string;
};
