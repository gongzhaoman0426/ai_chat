import { resourceScopeInput, storeScopeSchema } from './resource-scope';
import { workbenchInputs } from './workbench';
export * from './resource-scope';
import type { OrderRemarkCommand, OrderRemarkPreview, PlatformActionResult } from './pdd-tools';
import { z } from 'zod';
import { platformSchema, type PlatformConversationContext } from './platform';
export * from './platform';
export { getAutoReplyReadiness, getReplyEligibility } from './reply-readiness';
export const id = z.string().min(1).max(200);
export const role = z.literal('reply');
export const capabilitiesSchema = z.object({
  receive: z.boolean(),
  sendText: z.boolean(),
  sendImage: z.boolean(),
  history: z.boolean(),
  goods: z.boolean(),
  orders: z.boolean(),
  orderRemark: z.boolean().optional(),
  buyerProfile: z.boolean().optional(),
  shipment: z.boolean().optional(),
  staffTransfer: z.boolean().optional(),
  markRead: z.boolean().optional(),
  sendVideo: z.boolean().optional(),
  sendProductCard: z.boolean().optional(),
  videoMaterials: z.boolean().optional(),
  staffGroups: z.boolean().optional(),
  quickActions: z.boolean().optional(),
  operations: z.array(z.string().max(100)).max(50).optional(),
  verified: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const pddConnectionSchema = z
  .object({
    accountId: z.string().min(1),
    phase: z.enum([
      'connecting',
      'waiting_chat',
      'waiting_sdk',
      'online',
      'needs_login',
      'error',
      'offline',
    ]),
    reason: z.string().max(500),
    capabilities: capabilitiesSchema,
    diagnostics: z
      .record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()]))
      .optional(),
  })
  .strict();
export type PddConnectionState = z.infer<typeof pddConnectionSchema>;
export const platformConnectionSchema = pddConnectionSchema;
export type PlatformConnectionState = PddConnectionState;

export const disabledCapabilities: Capabilities = {
  receive: false,
  sendText: false,
  sendImage: false,
  history: false,
  goods: false,
  orders: false,
  verified: false,
};
export const qaSchema = z
  .object({
    intent: z.string().trim().min(1).max(2000),
    answerKind: z.enum(['text', 'image']),
    answer: z.string().max(10000).default(''),
    answerBefore: z.string().max(10000).optional(),
    answerAfter: z.string().max(10000).optional(),
    attachmentId: id.optional(),
    scope: z
      .object({
        productIds: z.array(id).default([]),
        conditions: z.string().max(2000).default(''),
        overridesEntryId: id.optional(),
      })
      .default({ productIds: [], conditions: '' }),
    validUntil: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.answerKind === 'text' && !v.answer.trim())
      c.addIssue({ code: 'custom', message: '请填写文字答案', path: ['answer'] });
    if (v.answerKind === 'image' && !v.attachmentId)
      c.addIssue({ code: 'custom', message: '请选择已入库图片', path: ['attachmentId'] });
  });
export type QaInput = z.infer<typeof qaSchema>;
export const knowledgeAssistHistorySchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
export const knowledgeAssistModelSchema = z
  .object({
    reply: z.string().trim().min(1).max(4000),
    proposals: z
      .array(
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('create'), qa: qaSchema }).strict(),
          z
            .object({
              action: z.literal('update'),
              entryId: id,
              qa: qaSchema,
              storeId: id.nullable().optional(),
            })
            .strict(),
          z.object({ action: z.enum(['enable', 'disable', 'delete']), entryId: id }).strict(),
        ]),
      )
      .max(8)
      .default([]),
  })
  .strict();
export type KnowledgeAssistModel = z.infer<typeof knowledgeAssistModelSchema>;
export const knowledgeAssistProposalSchema = z
  .object({
    key: id,
    action: z.enum(['create', 'update', 'enable', 'disable', 'delete']),
    entryId: id.optional(),
    expectedRevisionId: id.optional(),
    expectedStoreId: id.nullable().optional(),
    storeId: id.nullable(),
    title: z.string().min(1).max(200),
    detail: z.string().max(2000),
    qa: qaSchema.optional(),
  })
  .strict();
export const knowledgeAssistResultSchema = z
  .object({
    reply: z.string().min(1).max(4000),
    proposals: z.array(knowledgeAssistProposalSchema).max(8),
  })
  .strict();
export type KnowledgeAssistResult = z.infer<typeof knowledgeAssistResultSchema>;
// Skill reference paths are relative to the skill root, not the host filesystem.
export const skillReferencePath = z
  .string()
  .max(240)
  .refine(
    (path) =>
      /^references\//.test(path) &&
      !/[\\\x00-\x1f:]/.test(path) &&
      path
        .split('/')
        .every(
          (part) => !!part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part),
        ),
    '资料路径须位于 references/ 下，不能包含空目录、..、反斜线或特殊路径',
  );
export const skillScriptPath = z
  .string()
  .max(240)
  .refine(
    (path) =>
      /^scripts\//.test(path) &&
      /\.(?:[cm]?js|[cm]?ts|py|sh)$/.test(path) &&
      !/[\\\x00-\x1f:]/.test(path) &&
      path
        .split('/')
        .every(
          (part) => !!part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part),
        ),
    '脚本须位于 scripts/ 下，支持 TS、JS、Python 和 Shell，不能包含越界路径',
  );
export const skillScriptCallSchema = z
  .object({
    path: skillScriptPath,
    args: z
      .array(
        z
          .string()
          .max(2048)
          .refine((v) => !v.includes('\0'), '参数不能包含 NUL'),
      )
      .max(50)
      .default([]),
    stdin: z.string().max(64000).default(''),
    timeoutMs: z.number().int().min(100).max(30000).default(10000),
  })
  .strict();
export type SkillScriptCall = z.infer<typeof skillScriptCallSchema>;
export type SkillScriptResult = {
  executionId: string;
  skillId: string;
  skillName: string;
  skillRevision: number;
  contentHash: string;
  path: string;
  runtime: string;
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'output_limit';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
};
export const skillInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '名称只能使用小写字母、数字和单个连字符'),
    description: z.string().trim().min(1).max(1024),
    instructions: z
      .string()
      .min(1)
      .max(200000)
      .refine((v) => !!v.trim(), '请填写 SKILL.md 正文'),
    references: z.record(skillReferencePath, z.string().max(200000)).default({}),
    scripts: z.record(skillScriptPath, z.string().max(200000)).default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    const paths = [...Object.keys(v.references), ...Object.keys(v.scripts)];
    if (paths.length > 99)
      ctx.addIssue({
        code: 'custom',
        path: ['scripts'],
        message: '参考资料和脚本合计最多 99 个文件',
      });
    if (paths.some((path) => paths.some((parent) => path.startsWith(parent + '/'))))
      ctx.addIssue({ code: 'custom', message: '文件路径与目录冲突，请修改文件名' });
    if (new TextEncoder().encode(JSON.stringify(v)).length > 5 * 1024 * 1024)
      ctx.addIssue({ code: 'custom', message: '技能内容总计不能超过 5 MB' });
  });
// Pending sends are separate from confirmed Message records and learning sources.
export type ManualOutbound = {
  id: string;
  intentKey: string;
  conversationId: string;
  storeId: string;
  body: {
    text: string;
    attachmentId?: string;
    richContent?: import('./commerce-extra').RichContent;
  };
  status: 'prepared' | 'dispatching' | 'confirmed' | 'rejected' | 'unknown' | 'cancelled';
  externalId: string | null;
  error: string | null;
  createdAt: string | Date;
};
export type SkillInput = z.infer<typeof skillInputSchema>;
export type SkillRecord = SkillInput & {
  id: string;
  revision: number;
  updatedAt: string;
  mountedBy: Array<{ id: string; name: string }>;
};
export const agentConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(1000).default(''),
    prompt: z.string().min(1).max(30000),
    modelProfileId: id.nullable().default(null),
    toolkitIds: z.array(id).max(30).default([]),
    workflowIds: z.array(id).max(20).default([]),
    skillIds: z.array(id).max(30).default([]),
    subAgents: z
      .array(
        z
          .object({ alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), revisionId: id })
          .strict(),
      )
      .max(8)
      .default([]),
    memory: z
      .object({
        lastMessages: z.number().int().min(0).max(80).default(20),
        workingMemory: z.boolean().default(false),
      })
      .default({ lastMessages: 20, workingMemory: false }),
    maxSteps: z.number().int().min(1).max(20).default(8),
    maxDepth: z.number().int().min(1).max(4).default(2),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export const modelSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['chat', 'embedding']),
    provider: z.string().min(1).max(80).default('openai'),
    model: z.string().min(1).max(200),
    baseUrl: z
      .url()
      .refine((v) => ['https:', 'http:'].includes(new URL(v).protocol), '仅支持 HTTP(S) 模型服务'),
    apiKey: z.string().max(4096).optional(),
    dimensions: z.preprocess(
      (value) => (value === null || value === '' ? undefined : value),
      z.number().int().min(1).max(8192).optional(),
    ),
    maxTokens: z.number().int().min(128).max(16384).default(2048),
    timeoutMs: z.number().int().min(1000).max(180000).default(60000),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.kind === 'embedding' && data.dimensions == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'Embedding 模型需要向量维度',
      });
    }
  });
export const replySchema = z.object({
  action: z.enum(['reply', 'clarify', 'handoff', 'ignore']),
  text: z.string().max(10000).default(''),
  attachmentId: z.string().optional(),
  textAfter: z.string().max(10000).optional(),
  evidenceIds: z.array(z.string()).default([]),
  reasonCode: z.string(),
});
export type ReplyResult = z.infer<typeof replySchema>;
export const learningSchema = z.object({
  matchVerdict: z.enum(['correct', 'incorrect', 'uncertain', 'not_applicable']),
  replyVerdict: z.enum(['reasonable', 'unreasonable', 'uncertain']),
  reuseVerdict: z.enum(['reusable', 'conditional', 'not_reusable', 'uncertain']),
  reason: z.string(),
  evidenceIds: z.array(z.string()),
  suggestions: z
    .array(
      z.object({
        action: z.enum(['create_qa', 'revise_qa', 'add_intent_variant', 'disable_qa']),
        targetEntryId: z.string().optional(),
        qa: qaSchema,
        reason: z.string(),
      }),
    )
    .max(5),
});
export type LearningResult = z.infer<typeof learningSchema>;
const storeInput = z.object({ storeId: id }).strict();
const empty = z.object({}).strict();
export const apiInputs = {
  ...workbenchInputs,
  'qianniu.status': empty,
  'qianniu.download': empty,
  'qianniu.launch': empty,
  'qianniu.addAccount': empty,
  'qianniu.retryHook': empty,
  'app.state': empty,
  'app.settings': z
    .object({
      developerModeEnabled: z.boolean().optional(),
      aiSetupMode: z.enum(['own', 'later']).optional(),
      setupGuideState: z.enum(['active', 'dismissed', 'completed']).optional(),
      embeddingProfileId: id.nullable().optional(),
      defaultModelId: id.nullable().optional(),
    })
    .strict(),
  'onboarding.state': z.object({ storeId: id.optional() }).strict(),
  'onboarding.configure': z
    .object({ storeId: id, modelId: id, expectedConfigEpoch: z.number().int().positive() })
    .strict(),
  'onboarding.enable': z
    .object({ storeId: id, expectedConfigEpoch: z.number().int().positive() })
    .strict(),
  'stores.list': empty,
  'stores.goods': storeInput
    .extend({
      page: z.number().int().min(1).max(100).default(1),
      pageSize: z.number().int().min(1).max(30).default(20),
      keyword: z.string().trim().max(100).optional(),
    })
    .strict(),
  'stores.configuration': storeInput,
  'stores.policy': storeInput
    .extend({
      autoReplyEnabled: z.boolean().optional(),
      autoLearnEnabled: z.boolean().optional(),
      directMatchThreshold: z.number().min(0.5).max(1).optional(),
      builtinModelRef: id.nullable().optional(),
    })
    .strict(),
  'accounts.connect': z
    .object({ accountId: id.optional(), platform: platformSchema.optional() })
    .strict(),
  'accounts.verify': z.object({ accountId: id }).strict(),
  'accounts.disconnect': z.object({ accountId: id }).strict(),
  'accounts.remove': z.object({ accountId: id }).strict(),
  'conversations.list': z
    .object({
      storeId: id.nullable().optional(),
      search: z.string().max(200).default(''),
      filter: z.enum(['all', 'unread', 'handoff', 'waiting', 'human']).default('all'),
      before: z.object({ id, updatedAt: z.string().datetime() }).strict().optional(),
    })
    .strict(),
  'conversations.get': z.object({ conversationId: id }).strict(),
  'conversations.groups': z.object({ conversationId: id }).strict(),
  'conversations.associate': z.object({ messageId: id, groupId: id }).strict(),
  'conversations.messages': z.object({ conversationId: id, before: id.optional() }).strict(),
  'conversations.outbounds': z.object({ conversationId: id }).strict(),
  'conversations.open': z.object({ conversationId: id.nullable() }).strict(),
  'conversations.reception': z
    .object({
      conversationId: id,
      mode: z.enum(['human', 'ai']),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  'conversations.handoff': z
    .object({ conversationId: id, reason: z.string().min(1).max(500) })
    .strict(),
  'messages.send': z
    .object({
      conversationId: id,
      text: z.string().max(10000).default(''),
      attachmentId: id.optional(),
      textAfter: z.string().max(10000).optional(),
      requestId: id,
    })
    .strict()
    .refine((v) => !v.textAfter?.trim() || !!v.attachmentId, {
      message: '图片后文字需要同时选择图片',
      path: ['textAfter'],
    }),
  'outbound.list': storeInput,
  'outbound.reconcile': z.object({ id: id }).strict(),
  'outbound.resolve': z
    .object({ id: id, externalId: id, evidence: z.string().min(4).max(1000) })
    .strict(),
  // 历史「发送待确认」人工核对：已在原平台确认送达，或放弃等待以便交还 AI。
  'outbound.acknowledge': z
    .object({
      id: id,
      outcome: z.enum(['delivered', 'failed']),
      note: z.string().trim().min(2).max(300),
    })
    .strict(),
  'knowledge.list': z
    .object({
      storeId: id.nullable().default(null),
      search: z.string().max(200).default(''),
      scope: z.enum(['available', 'owned', 'all']).default('available'),
    })
    .strict(),
  'knowledge.save': z
    .object({
      storeId: id.nullable().default(null),
      entryId: id.optional(),
      expectedRevisionId: id.nullable().optional(),
      expectedStoreId: id.nullable().optional(),
      qa: qaSchema,
    })
    .strict(),
  'knowledge.status': z
    .object({ id: id, status: z.enum(['enabled', 'disabled']), expectedRevisionId: id })
    .strict(),
  'knowledge.delete': z.object({ id, expectedRevisionId: id }).strict(),
  'knowledge.history': z.object({ id: id }).strict(),
  'knowledge.bootstrapState': storeInput,
  'knowledge.bootstrapStart': storeInput,
  'knowledge.bootstrapApply': storeInput
    .extend({
      runId: id,
      rows: z
        .array(z.object({ id, qa: qaSchema }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  'knowledge.importPreview': z.object({ storeId: id.nullable().default(null) }).strict(),
  'knowledge.importApply': z
    .object({ token: id, rows: z.array(z.number().int().min(0)).max(5000) })
    .strict(),
  'knowledge.export': z
    .object({
      storeId: id.nullable().default(null),
      scope: z.enum(['available', 'owned', 'all']).default('owned'),
    })
    .strict(),
  'knowledge.assist': z
    .object({
      storeId: id.nullable().default(null),
      scope: z.enum(['available', 'owned', 'all']).default('available'),
      text: z.string().trim().max(2000).default(''),
      attachmentIds: z.array(id).max(8).default([]),
      history: z.array(knowledgeAssistHistorySchema).max(16).default([]),
    })
    .strict()
    .superRefine((v, c) => {
      if (!v.text && !v.attachmentIds.length)
        c.addIssue({ code: 'custom', message: '请输入说明或上传图片', path: ['text'] });
    }),
  'attachments.pick': z.object({ storeId: id.nullable().default(null) }).strict(),
  'attachments.pickMany': z.object({ storeId: id.nullable().default(null) }).strict(),
  'attachments.get': z.object({ id: id }).strict(),
  'learning.list': storeInput.extend({
    status: z
      .enum(['pending_review', 'approved', 'rejected', 'stale', 'all'])
      .default('pending_review'),
  }),
  'learning.evaluations': storeInput,
  'learning.review': z
    .object({
      candidateId: id,
      candidateVersion: z.number().int(),
      contentHash: id,
      requestId: id,
      decision: z.enum(['approved', 'rejected']),
      editedQa: qaSchema.optional(),
      targetStoreId: id.nullable().optional(),
      reason: z.string().max(1000).optional(),
    })
    .strict(),
  'agents.list': empty,
  'agents.save': z
    .object({
      id: id.optional(),
      expectedRevision: z.number().int().optional(),
      config: agentConfigSchema,
      storeScope: storeScopeSchema.optional(),
    })
    .strict(),
  'agents.publish': z.object({ id: id, expectedRevision: z.number().int() }).strict(),
  'agents.delete': z.object({ id: id }).strict(),
  'agents.restoreDefault': empty,
  'agents.restoreRevision': z
    .object({ revisionId: id, expectedRevision: z.number().int() })
    .strict(),
  'agents.bind': z
    .object({
      scopeKey: z.string().min(1).max(220),
      agentId: id.nullable().optional(),
      revisionId: id.nullable().optional(), // Legacy callers only; the UI selects an Agent.
      expectedRevision: z.number().int().nullable(),
    })
    .strict()
    .refine((input) => (input.agentId !== undefined) !== (input.revisionId !== undefined), {
      message: '请选择一个工作 Agent',
    }),
  'agents.debug': z
    .object({ id: id, input: z.string().min(1).max(10000), platform: platformSchema.optional() })
    .strict(),
  'agents.export': z.object({ id: id }).strict(),
  'skills.list': empty,
  'skills.save': z
    .object({
      id: id.optional(),
      expectedRevision: z.number().int().optional(),
      config: skillInputSchema,
      storeScope: storeScopeSchema.optional(),
    })
    .strict(),
  'skills.delete': z.object({ id, expectedRevision: z.number().int() }).strict(),
  'skills.import': empty,
  'skills.export': z.object({ id }).strict(),
  'skills.test': z
    .object({ runId: z.string().uuid(), config: skillInputSchema, call: skillScriptCallSchema })
    .strict(),
  'skills.cancelTest': z.object({ runId: z.string().uuid() }).strict(),
  'resources.scopes': empty,
  'resources.setScope': resourceScopeInput,
  'assets.list': empty,
  'assets.install': z
    .object({
      kind: z.enum(['toolkit', 'workflow']).optional(),
      storeScope: storeScopeSchema.optional(),
    })
    .strict(),
  'assets.settings': z
    .object({
      assetId: id,
      scopeKey: id,
      expectedRevision: z.number().int(),
      values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    })
    .strict(),
  'assets.test': z.object({ assetId: id, memberId: id, input: z.unknown() }).strict(),
  'models.list': empty,
  'models.save': modelSchema,
  'models.test': z.object({ id: id }).strict(),
  'models.discover': z
    .object({
      id: id.optional(),
      baseUrl: modelSchema.shape.baseUrl,
      apiKey: z.string().max(4096).optional(),
    })
    .strict(),
  'runs.list': storeInput,
  'runs.history': z
    .object({
      storeId: id.optional(),
      role: z.enum(['reply', 'learning']).optional(),
      status: z.enum(['running', 'succeeded', 'failed']).optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  'runs.detail': storeInput.extend({ id }).strict(),
  'reception.state': storeInput,
  'jobs.retry': z.object({ id: id }).strict(),
  'backup.create': empty,
  'backup.restore': empty,
  'diagnostics.export': empty,
} as const;
export type Method = keyof typeof apiInputs;
export type Input<M extends Method> = z.input<(typeof apiInputs)[M]>;
export type DesktopUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'not-available'
  | 'error';
export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  mode: 'manual' | 'automatic';
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  size?: number;
  progress?: number;
  downloadUrl?: string;
  error?: string;
}
export const developerMethods = new Set<Method>([
  'agents.list',
  'agents.save',
  'agents.publish',
  'agents.delete',
  'agents.restoreRevision',
  'agents.bind',
  'agents.debug',
  'agents.export',
  'skills.list',
  'skills.save',
  'skills.delete',
  'skills.import',
  'skills.export',
  'skills.test',
  'skills.cancelTest',
  'resources.scopes',
  'resources.setScope',
  'assets.list',
  'assets.install',
  'assets.settings',
  'assets.test',
]);
export interface DesktopApi {
  call<T = unknown>(method: Method, input?: unknown): Promise<T>;
  onChanged(callback: () => void): () => void;
  onNotice?(callback: (message: string) => void): () => void;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onUpdate(callback: (state: DesktopUpdateState) => void): () => void;
}
export interface IncomingMessage {
  accountId: string;
  externalId: string;
  eventKey: string;
  buyerId: string;
  buyerName: string;
  conversationKey: string;
  platformContext?: PlatformConversationContext;
  direction: 'in' | 'out';
  origin: 'buyer' | 'human' | 'ai' | 'qa_direct' | 'unknown';
  kind: 'text' | 'image' | 'system' | 'video' | 'product_card' | 'review_card';
  richContent?: import('./commerce-extra').RichContent;
  text: string;
  attachmentId?: string;
  remoteImageUrl?: string;
  timestamp: string;
  raw: unknown;
  replyToExternalId?: string;
  withdrawn?: boolean;
  historical?: boolean;
}
export type SendResult =
  | { status: 'confirmed'; externalId: string }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string };
export interface SendCommand {
  conversationKey?: string;
  platformContext?: PlatformConversationContext;
  id: string;
  token: string;
  accountId: string;
  buyerId: string;
  kind: 'text' | 'image' | 'video' | 'product_card' | 'review_card';
  richContent?: import('./commerce-extra').RichContent;
  text: string;
  imageData?: string;
  imageMime?: string;
}
export interface PlatformHost {
  executeQuickAction?(
    command: import('./commerce-extra').QuickCommand,
    authorize: (preview: import('./commerce-extra').QuickPreview) => Promise<void>,
  ): Promise<PlatformActionResult>;
  staff?(accountId: string): Promise<import('./workbench').PlatformStaff[]>;
  executeTransfer?(
    command: import('./workbench').TransferCommand,
    authorize: (preview: import('./workbench').TransferPreview) => Promise<void>,
  ): Promise<PlatformActionResult>;
  markRead?(
    accountId: string,
    input: {
      conversationKey: string;
      buyerId: string;
      messageIds: string[];
      platformContext?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  executeShipment?(
    command: import('./commerce-tools').ShipmentCommand,
    authorize: (preview: import('./commerce-tools').ShipmentPreview) => Promise<void>,
  ): Promise<PlatformActionResult>;
  executeAction?(
    command: OrderRemarkCommand,
    authorize: (preview: OrderRemarkPreview) => Promise<void>,
  ): Promise<PlatformActionResult>;
  send(command: SendCommand): Promise<SendResult>;
  query(accountId: string, operation: string, input: Record<string, unknown>): Promise<unknown>;
}
export type UiRow = Record<string, unknown>;
