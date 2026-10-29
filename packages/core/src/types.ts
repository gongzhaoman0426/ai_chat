import type { RunTrace } from './run-trace';
import type { PlatformId, PlatformConversationContext } from '../../contracts/src/platform';
import type { PublishedConfig } from '../../agent-config/src/index';
import type {
  QaInput,
  ReplyResult,
  LearningResult,
  Capabilities,
  PlatformHost,
} from '../../contracts/src/index';
export const BUILTIN_LEARNING_VERSION = 'learning-evidence-v6-image-text';
export interface KnowledgeMatch {
  storeId?: string | null;
  entryId: string;
  revisionId: string;
  intent: string;
  qa: QaInput;
  score: number;
}
export interface ReplyContext {
  trace?: RunTrace;
  mode?: 'production' | 'debug';
  platform?: PlatformId;
  conversationKey?: string;
  platformContext?: PlatformConversationContext;
  settingsSnapshot?: Record<string, Record<string, unknown>>;
  agentTree?: Record<string, PublishedConfig>;
  storeId: string;
  conversationId: string;
  accountId: string;
  buyerId: string;
  runId: string;
  configEpoch: number;
  question: string;
  messages: Array<{ id: string; origin: string; text: string; attachmentId?: string | null }>;
  matches: KnowledgeMatch[];
  knowledgeSearch?: { query: string; status: 'completed' | 'failed' };
  config: PublishedConfig;
  revisionId: string;
  capabilities: Capabilities;
  signal: AbortSignal;
  guard: () => Promise<void>;
}
export interface AiPort {
  search(storeId: string, query: string): Promise<KnowledgeMatch[]>;
  index(revisionId: string): Promise<void>;
  reply(
    context: ReplyContext,
  ): Promise<{ result: ReplyResult; usage: unknown; evidenceIds: string[] }>;
  evaluate(
    input: unknown,
    modelId: string,
    signal: AbortSignal,
    onUsage?: (usage: unknown) => Promise<void>,
    trace?: RunTrace,
  ): Promise<{ result: LearningResult; usage: unknown }>;
}
export interface AppHost extends PlatformHost {
  // Local service port installed by Engine. Business messages use the ordinary durable outbox.
  sendBusinessMessage?(input: {
    conversationId: string;
    richContent: import('../../contracts/src/commerce-extra').RichContent;
    intentKey: string;
    runId?: string;
    human: boolean;
    guard: () => Promise<void>;
  }): Promise<{ id: string; status: string; error: string | null }>;
  secretPut(value: string, ref?: string): Promise<string>;
  secretGet(ref: string): Promise<string>;
  pickFile(
    kind: 'image' | 'knowledge' | 'extension' | 'skill' | 'agent' | 'backup',
  ): Promise<string | null>;
  pickFiles(kind: 'image'): Promise<string[]>;
  saveFile(name: string): Promise<string | null>;
  validateImage(data: Buffer): Promise<{ width: number; height: number; mime: string }>;
  connect(accountId?: string, platform?: PlatformId): Promise<unknown>;
  disconnect(accountId: string): Promise<void>;
  forgetPartition(partition: string): Promise<void>;
  verify(accountId: string): Promise<unknown>;
  maintenance(paused: boolean): Promise<void>;
  stageRestore(file: string): Promise<void>;
}
