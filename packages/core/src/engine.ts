import {
  richContentSchema,
  richMessageTarget,
  richMessageOperation,
  richActionCapabilities,
  type RichContent,
} from '../../contracts/src/commerce-extra';
import {
  resolveRuntimeToolkits,
  assetSettingsRows,
} from '../../agent-config/src/toolkit-resolution';
import { resolveKnowledgeMatches, decideKnowledgeReply } from './knowledge-resolution';
import { knowledgeAllowed } from './knowledge-scope';
import { sameKnowledgeAnswer } from '../../contracts/src/knowledge-rules';
import { RunTrace } from './run-trace';
import type { Account, Conversation } from '@prisma/client';
import { platformSchema, platformContextSchema } from '../../contracts/src/platform';
import type { PrismaClient, Tx } from '../../database/src/index';
import { json } from '../../database/src/index';
import {
  type IncomingMessage,
  type Capabilities,
  type SendResult,
  type ReplyResult,
  qaSchema,
  disabledCapabilities,
  pddConnectionSchema,
  type PddConnectionState,
  getAutoReplyReadiness,
  getReplyEligibility,
} from '../../contracts/src/index';
import { AgentService } from '../../agent-config/src/index';
import { KnowledgeService } from './knowledge';
import {
  buildLearningEvidence,
  resolveLearningEvidence,
  learningMessage,
} from './learning-evidence';
import { humanLearningContext, HUMAN_LEARNING_SETTLE_MS } from './human-learning';
import { BUILTIN_LEARNING_VERSION, type AiPort, type AppHost, type KnowledgeMatch } from './types';
import { DomainError, Mutex, assert, hash, uid, errorText, isRetiredCloudModel } from './util';
const mutableJobs = ['pending', 'retry_wait', 'running'];
export class Engine {
  readonly lock = new Mutex();
  readonly agents: AgentService;
  readonly knowledge: KnowledgeService;
  readonly stopHandlers = new Set<() => Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<string>();
  private stopped = false;
  private scanning = false;
  private viewedConversationId: string | null = null;
  private manualQueues = new Map<string, Promise<void>>();
  private queuedManualIds = new Set<string>();
  private lastTickAt: Date | null = null;
  private schedulerError: { at: Date; message: string } | null = null;
  get schedulerState() {
    return {
      running: !!this.timer && !this.stopped,
      lastTickAt: this.lastTickAt,
      activeTasks: this.controllers.size,
      lastError: this.schedulerError,
    };
  }
  onChanged = () => {};
  constructor(
    readonly db: PrismaClient,
    readonly dir: string,
    readonly host: AppHost,
    readonly ai: AiPort,
  ) {
    this.host.sendBusinessMessage = (input) => this.sendBusinessMessage(input);
    this.agents = new AgentService(db);
    this.knowledge = new KnowledgeService(db, this.lock, dir, host);
  }
  // Workspaces from builds with hosted AI may still point at `cloud:` profiles; send them back
  // to the model setup step instead of failing at reply time.
  private async retireCloudSettings() {
    const settings = await this.db.appSetting.findMany({
      where: { key: { in: ['defaultModelId', 'embeddingProfileId', 'aiSetupMode'] } },
    });
    const stale = settings
      .filter((s) =>
        s.key === 'aiSetupMode' ? s.value === 'cloud' : isRetiredCloudModel({ id: s.value }),
      )
      .map((s) => s.key);
    if (stale.length) await this.db.appSetting.deleteMany({ where: { key: { in: stale } } });
  }
  async initialize() {
    this.viewedConversationId = null;
    await this.agents.initialize();
    await this.agents.retirePddToolkits();
    await this.agents.upgradeBuiltinDefaults();
    await this.retireCloudSettings();
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        await tx.aiRunStep.updateMany({
          where: { status: 'running' },
          data: {
            status: 'cancelled',
            error: '应用重启，该步骤未取得完整结果',
            finishedAt: new Date(),
          },
        });
        await tx.aiRun.updateMany({
          where: { status: 'running' },
          data: { status: 'failed', error: '应用重启，运行已中断', finishedAt: new Date() },
        });
        await tx.outboundMessage.updateMany({
          where: { status: 'dispatching' },
          data: { status: 'unknown', error: '上次发送期间进程中断，请核对平台回执' },
        });
        await tx.platformAction.updateMany({
          where: { status: 'prepared' },
          data: {
            status: 'rejected',
            result: json({
              status: 'rejected',
              reasonCode: 'restart_before_submission',
              message: '应用重启，操作未提交。',
            }),
          },
        });
        await tx.platformAction.updateMany({
          where: { status: 'dispatched' },
          data: {
            status: 'unknown',
            result: json({
              status: 'unknown',
              reasonCode: 'restart_after_submission',
              message: '提交期间应用重启，请在原平台核对，勿重复操作。',
            }),
          },
        });
        await tx.job.updateMany({
          where: { status: 'running' },
          data: { status: 'retry_wait', leaseToken: null, leaseUntil: null, runAfter: new Date() },
        });
        // Restart never replays stale replies. Durable learning / approved publication can resume.
        await tx.outboundMessage.updateMany({
          where: { status: 'prepared' },
          data: { status: 'cancelled', error: '重启后取消未提交发送，请按当前会话重新处理' },
        });
        await tx.job.updateMany({
          where: { kind: 'reply', status: { in: mutableJobs } },
          data: { status: 'cancelled', leaseToken: null, leaseUntil: null },
        });
        await tx.messageGroup.updateMany({
          where: { state: 'waiting_answer' },
          data: { autoEligible: false },
        });
        await tx.account.updateMany({
          data: { status: 'offline', capabilities: json(disabledCapabilities) },
        });
        await tx.appSetting.deleteMany({ where: { key: { startsWith: 'platform.connection:' } } });
        // Explicit human reception survives restart; only the view is ephemeral.
      }),
    );
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 350);
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.stopHandlers].map((stop) => stop()));
    while (this.scanning) await new Promise((r) => setTimeout(r, 20));
    for (const c of this.controllers.values()) c.abort();
    while (this.active.size) await new Promise((r) => setTimeout(r, 30));
    await Promise.allSettled([...this.manualQueues.values()]);
  }
  async tick() {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    this.lastTickAt = new Date();
    try {
      await this.captureLearning();
      // At most two tasks, only one learning request. High priority reception is selected first.
      if (this.controllers.size >= 2) return;
      const job = await this.lock.run(() =>
        this.db.$transaction(async (tx) => {
          const enabledLearning = new Set(
            (
              await tx.learningPolicy.findMany({
                where: { autoLearnEnabled: true },
                select: { storeId: true },
              })
            ).map((p) => p.storeId),
          );
          const rows = await tx.job.findMany({
            where: {
              status: { in: ['pending', 'retry_wait'] },
              runAfter: { lte: new Date() },
              OR: [
                { kind: { not: 'learn' } },
                { kind: 'learn', storeId: { in: [...enabledLearning] } },
              ],
            },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
            take: 20,
          });
          const candidate = rows.find(
            (j) =>
              (j.kind !== 'learn' || enabledLearning.has(j.storeId!)) &&
              !this.active.has(j.conversationId ?? j.id) &&
              !(j.kind === 'learn' && this.active.has('learning')),
          );
          if (!candidate) return null;
          const leaseToken = uid();
          const updated = await tx.job.updateMany({
            where: { id: candidate.id, status: candidate.status },
            data: {
              status: 'running',
              leaseToken,
              leaseUntil: new Date(Date.now() + 240000),
              attempts: { increment: 1 },
            },
          });
          return updated.count
            ? { ...candidate, leaseToken, attempts: candidate.attempts + 1 }
            : null;
        }),
      );
      if (!job) return;
      const key = job.conversationId ?? job.id;
      this.active.add(key);
      if (job.kind === 'learn') this.active.add('learning');
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      void (async () => {
        try {
          const payload = job.payload as Record<string, unknown>;
          if (job.kind === 'reply') await this.reply(job.id, payload, controller.signal);
          else if (job.kind === 'learn') await this.learn(job.id, payload, controller.signal);
          else if (job.kind === 'index') await this.ai.index(String(payload.revisionId));
          else if (job.kind === 'publish') await this.knowledge.apply(String(payload.changeId));
          await this.db.job.updateMany({
            where: { id: job.id, leaseToken: job.leaseToken, status: 'running' },
            data: { status: 'succeeded', leaseToken: null, leaseUntil: null, error: null },
          });
        } catch (e) {
          const cancelled = controller.signal.aborted || errorText(e).startsWith('STALE:');
          const blocked =
            e instanceof DomainError &&
            (e.code === 'REPLY_NOT_READY' || e.code.startsWith('LEARNING_OUTPUT_'));
          await this.db.job.updateMany({
            where: { id: job.id, leaseToken: job.leaseToken, status: 'running' },
            data: {
              status: cancelled
                ? 'cancelled'
                : blocked || job.attempts >= 4
                  ? 'failed'
                  : 'retry_wait',
              error: errorText(e),
              leaseToken: null,
              leaseUntil: null,
              runAfter: new Date(Date.now() + Math.min(60000, 2000 * 2 ** job.attempts)),
            },
          });
        } finally {
          this.controllers.delete(job.id);
          this.active.delete(key);
          if (job.kind === 'learn') this.active.delete('learning');
          this.onChanged();
          void this.tick();
        }
      })();
    } catch (e) {
      this.schedulerError = { at: new Date(), message: errorText(e) };
      console.error('scheduler:', errorText(e));
    } finally {
      this.scanning = false;
    }
  }
  async registerAccount(input: {
    platform?: import('../../contracts/src/platform').PlatformId;
    partition: string;
    mallId: string;
    mallName: string;
    externalId: string;
    name: string;
    capabilities: Capabilities;
  }) {
    const platform = platformSchema.parse(input.platform ?? 'pinduoduo');
    const result = await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        let store = await tx.store.findUnique({
          where: { platform_externalId: { platform, externalId: input.mallId } },
        });
        if (!store)
          store = await tx.store.create({
            data: {
              platform,
              externalId: input.mallId,
              name: input.mallName,
              replyPolicy: { create: {} },
              learningPolicy: { create: {} },
            },
          });
        const old = await tx.account.findUnique({ where: { sessionPartition: input.partition } });
        assert(
          !old || (old.storeId === store.id && old.externalId === input.externalId),
          '登录身份与该账号分区不一致，请新增账号',
        );
        const account = await tx.account.upsert({
          where: { storeId_externalId: { storeId: store.id, externalId: input.externalId } },
          create: {
            storeId: store.id,
            externalId: input.externalId,
            name: input.name,
            sessionPartition: input.partition,
            status:
              input.capabilities.receive && input.capabilities.sendText ? 'online' : 'offline',
            capabilities: json({ ...input.capabilities, verified: false }),
            lastSeenAt: new Date(),
          },
          update: {
            status:
              input.capabilities.receive && input.capabilities.sendText ? 'online' : 'offline',
            lastSeenAt: new Date(),
            capabilities: json({ ...input.capabilities, verified: old?.verifiedAt != null }),
            name: input.name,
          },
        });
        assert(account.sessionPartition === input.partition, '这个客服账号已在其他登录分区连接');
        await tx.appSetting.upsert({
          where: { key: `platform.autoconnect:${account.id}` },
          create: { key: `platform.autoconnect:${account.id}`, value: true },
          update: { value: true },
        });
        await this.repairStoreRoutes(tx, account);
        return account;
      }),
    );
    this.onChanged();
    return result;
  }
  async updateConnection(raw: PddConnectionState) {
    const input = pddConnectionSchema.parse(raw);
    assert(
      input.phase !== 'online' || (input.capabilities.receive && input.capabilities.sendText),
      '消息监听和发送能力尚未就绪',
    );
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const account = await tx.account.findUnique({ where: { id: input.accountId } });
        if (!account) return; // An in-flight callback must not recreate a removed account.
        const online = input.phase === 'online';
        const capabilities = { ...input.capabilities, verified: account.verifiedAt !== null };
        const updated = await tx.account.update({
          where: { id: account.id },
          data: {
            status: online ? 'online' : 'offline',
            capabilities: json(capabilities),
            ...(online ? { lastSeenAt: new Date() } : {}),
          },
        });
        if (online) await this.repairStoreRoutes(tx, updated);
        const value = json({ ...input, capabilities, updatedAt: new Date().toISOString() });
        await tx.appSetting.upsert({
          where: { key: `platform.connection:${account.id}` },
          create: { key: `platform.connection:${account.id}`, value },
          update: { value },
        });
      }),
    );
    this.onChanged();
    return { ok: true };
  }
  async markOffline(accountId: string) {
    await this.updateConnection({
      accountId,
      phase: 'offline',
      reason: '句达消息通道已断开；平台登录状态保留，点击打开平台重新连接。',
      capabilities: disabledCapabilities,
    });
  }
  async removeAccount(accountId: string) {
    const account = await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const account = await tx.account.findUnique({ where: { id: accountId } });
        assert(account, '账号不存在');
        await tx.appSetting.deleteMany({
          where: {
            key: {
              in: [`platform.autoconnect:${account.id}`, `platform.connection:${account.id}`],
            },
          },
        });
        const conversations = await tx.conversation.findMany({ where: { accountId } });
        for (const conversation of conversations)
          await this.invalidateConversationRoute(
            tx,
            conversation.id,
            '发送账号已移除，请重新连接店铺后发送',
          );
        await tx.conversation.updateMany({
          where: { accountId },
          data: { routeVersion: { increment: 1 }, revision: { increment: 1 } },
        });
        await tx.account.delete({ where: { id: account.id } });
        await this.pruneEmptyStore(tx, account.storeId);
        return account;
      }),
    );
    // Release the database lock before asking the host to close its connection;
    // closing can itself produce a connection-state callback to this engine.
    try {
      await this.host.disconnect(account.id);
      await this.host.forgetPartition(account.sessionPartition);
    } finally {
      this.onChanged();
    }
  }
  private async pruneEmptyStore(tx: Tx, storeId: string) {
    const remaining = await tx.account.count({ where: { storeId } });
    if (remaining) return;
    const [conversations, knowledge] = await Promise.all([
      tx.conversation.count({ where: { storeId } }),
      tx.knowledgeEntry.count({ where: { storeId } }),
    ]);
    if (conversations || knowledge) return;
    await tx.replyPolicy.deleteMany({ where: { storeId } });
    await tx.learningPolicy.deleteMany({ where: { storeId } });
    await tx.store.delete({ where: { id: storeId } });
  }
  private async invalidateConversationRoute(tx: Tx, conversationId: string, reason: string) {
    // Include queued human sends. In-flight / unknown / finished sends retain their
    // original account and receipt state, and are never replayed on a new route.
    await tx.outboundMessage.updateMany({
      where: { conversationId, status: 'prepared' },
      data: { status: 'cancelled', error: reason },
    });
    await this.cancelConversation(tx, conversationId);
  }
  private async rebindConversation(
    tx: Tx,
    conversation: Conversation,
    account: Pick<Account, 'id' | 'storeId'>,
    reason: 'account_reconnected' | 'manual_send' | 'live_message',
  ) {
    assert(
      account.storeId === conversation.storeId,
      '发送账号不属于当前店铺',
      'ACCOUNT_SCOPE_MISMATCH',
    );
    await this.invalidateConversationRoute(
      tx,
      conversation.id,
      '会话发送账号已变化，请核对后重新发送',
    );
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        accountId: account.id,
        routeVersion: { increment: 1 },
        revision: { increment: 1 },
      },
    });
    await tx.auditEvent.create({
      data: {
        type: 'conversation.route_recovered',
        scope: conversation.storeId,
        actor: 'system',
        details: json({
          conversationId: conversation.id,
          previousAccountId: conversation.accountId,
          accountId: account.id,
          routeVersion: updated.routeVersion,
          reason,
        }),
      },
    });
    return updated;
  }
  private async repairStoreRoutes(tx: Tx, account: Account) {
    if (account.status !== 'online') return;
    const accounts = await tx.account.findMany({ select: { id: true, storeId: true } });
    // Count offline accounts too: connection order must not choose a staff member
    // in a multi-account store. Never replace an existing route, even if offline.
    if (accounts.filter((a) => a.storeId === account.storeId).length !== 1) return;
    const conversations = await tx.conversation.findMany({
      where: { storeId: account.storeId, accountId: { notIn: accounts.map((a) => a.id) } },
    });
    for (const conversation of conversations)
      await this.rebindConversation(tx, conversation, account, 'account_reconnected');
  }
  private async resolveManualRoute(tx: Tx, conversation: Conversation) {
    const current = await tx.account.findUnique({ where: { id: conversation.accountId } });
    if (current) {
      assert(
        current.storeId === conversation.storeId,
        '发送账号不属于当前店铺',
        'ACCOUNT_SCOPE_MISMATCH',
      );
      return conversation;
    }
    // Repair old databases as well, without requiring a new buyer message first.
    const candidates = await tx.account.findMany({
      where: { storeId: conversation.storeId },
      take: 2,
    });
    assert(candidates.length, '该会话的账号已移除，请重新添加该店铺账号后发送', 'ACCOUNT_REMOVED');
    assert(
      candidates.length === 1,
      '该会话的原账号已移除，店铺有多个账号，无法确定发送账号；请先在对应平台回复此会话以恢复绑定',
      'ACCOUNT_ROUTE_AMBIGUOUS',
    );
    assert(
      candidates[0].status === 'online',
      '该店铺的消息通道未连接，请打开平台连接成功后再发送',
      'ACCOUNT_OFFLINE',
    );
    return this.rebindConversation(tx, conversation, candidates[0], 'manual_send');
  }
  async verifyAccount(accountId: string) {
    const checked = await this.host.verify(accountId);
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
        const readiness = getAutoReplyReadiness([{ ...account, verifiedAt: true }]);
        assert(readiness.ready, readiness.reason);
        const capabilities = {
          ...(account.capabilities as unknown as Capabilities),
          verified: true,
        };
        await tx.account.update({
          where: { id: accountId },
          data: { verifiedAt: new Date(), capabilities: json(capabilities) },
        });
        const key = `platform.connection:${accountId}`;
        const connection = await tx.appSetting.findUnique({ where: { key } });
        if (connection) {
          const state = connection.value as unknown as PddConnectionState & { updatedAt: string };
          await tx.appSetting.update({
            where: { key },
            data: { value: json({ ...state, capabilities }) },
          });
        }
        await tx.auditEvent.create({
          data: {
            type: 'account.verified',
            scope: account.storeId,
            actor: 'local-user',
            details: json({ accountId }),
          },
        });
      }),
    );
    this.onChanged();
    return checked;
  }
  async setPolicy(input: {
    storeId: string;
    autoReplyEnabled?: boolean;
    autoLearnEnabled?: boolean;
    directMatchThreshold?: number;
    builtinModelRef?: string | null;
    guidedConfigEpoch?: number;
  }) {
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const store = await tx.store.findUnique({ where: { id: input.storeId } });
        assert(store, '店铺不存在');
        if (input.guidedConfigEpoch !== undefined) {
          assert(
            store.replyConfigEpoch === input.guidedConfigEpoch,
            '接待配置已变化，请重新检查后开启',
            'CONFLICT',
          );
          const binding =
            (await tx.agentBinding.findUnique({ where: { scopeKey: `store:${store.id}` } })) ??
            (await tx.agentBinding.findUnique({ where: { scopeKey: 'global' } }));
          assert(binding, '请先设置 AI 客服助手');
          await this.agents.validateTree(binding.agentRevisionId, [], 0, tx);
          const revision = await tx.agentRevision.findUniqueOrThrow({
            where: { id: binding.agentRevisionId },
          });
          assert(
            (revision.configSnapshot as { modelSnapshot?: unknown }).modelSnapshot,
            '工作助手尚未配置模型',
          );
        }
        if (input.autoReplyEnabled === true) {
          const accounts = await tx.account.findMany({ where: { storeId: input.storeId } });
          const readiness = getAutoReplyReadiness(accounts);
          assert(readiness.ready, readiness.reason, 'REPLY_NOT_READY');
          if (
            input.guidedConfigEpoch !== undefined &&
            (await tx.replyPolicy.findUnique({ where: { storeId: input.storeId } }))
              ?.autoReplyEnabled
          ) {
            await tx.appSetting.upsert({
              where: { key: 'setupGuideState' },
              create: { key: 'setupGuideState', value: 'completed' },
              update: { value: 'completed' },
            });
            return;
          }
        }
        if (input.builtinModelRef)
          assert(
            (await tx.modelProfile.findUnique({ where: { id: input.builtinModelRef } }))?.kind ===
              'chat',
            '学习需要对话模型',
          );
        if (input.autoReplyEnabled !== undefined || input.directMatchThreshold !== undefined) {
          await tx.replyPolicy.update({
            where: { storeId: input.storeId },
            data: {
              autoReplyEnabled: input.autoReplyEnabled,
              directMatchThreshold: input.directMatchThreshold,
              version: { increment: 1 },
            },
          });
          await tx.store.update({
            where: { id: input.storeId },
            data: { replyConfigEpoch: { increment: 1 } },
          });
          if (input.autoReplyEnabled === false) {
            await tx.messageGroup.updateMany({
              where: { conversation: { storeId: input.storeId }, state: 'waiting_answer' },
              data: { autoEligible: false },
            });
            await tx.job.updateMany({
              where: { storeId: input.storeId, kind: 'reply', status: { in: mutableJobs } },
              data: { status: 'cancelled' },
            });
            await tx.outboundMessage.updateMany({
              where: { storeId: input.storeId, status: 'prepared', origin: { not: 'human' } },
              data: { status: 'cancelled' },
            });
          }
        }
        if (input.autoLearnEnabled !== undefined || input.builtinModelRef !== undefined) {
          const old = await tx.learningPolicy.findUniqueOrThrow({
            where: { storeId: input.storeId },
          });
          let learningModelRef = input.builtinModelRef;
          // A new guide-created workspace has no global default model. When the
          // user explicitly enables learning later, reuse its basic assistant's
          // model unless a learning/default model was already selected.
          if (
            input.autoLearnEnabled === true &&
            learningModelRef === undefined &&
            !old.builtinModelRef
          ) {
            const fallback = await tx.appSetting.findUnique({ where: { key: 'defaultModelId' } });
            if (typeof fallback?.value !== 'string' || !fallback.value) {
              const binding = await tx.agentBinding.findUnique({
                where: { scopeKey: `store:${store.id}` },
              });
              const revision =
                binding &&
                (await tx.agentRevision.findUnique({
                  where: { id: binding.agentRevisionId },
                  include: { agent: true },
                }));
              const modelId = (revision?.configSnapshot as { modelProfileId?: string } | undefined)
                ?.modelProfileId;
              if (
                revision?.agent.origin === 'builtin_setup' &&
                modelId &&
                (await tx.modelProfile.findUnique({ where: { id: modelId } }))?.kind === 'chat'
              )
                learningModelRef = modelId;
            }
          }
          const toggled =
            input.autoLearnEnabled !== undefined && old.autoLearnEnabled !== input.autoLearnEnabled;
          await tx.learningPolicy.update({
            where: { storeId: input.storeId },
            data: {
              autoLearnEnabled: input.autoLearnEnabled,
              builtinModelRef: learningModelRef,
              version: { increment: 1 },
              ...(toggled ? { enableEpoch: { increment: 1 } } : {}),
            },
          });
          await tx.store.update({
            where: { id: input.storeId },
            data: { learningConfigEpoch: { increment: 1 } },
          });
        }
        if (input.guidedConfigEpoch !== undefined)
          await tx.appSetting.upsert({
            where: { key: 'setupGuideState' },
            create: { key: 'setupGuideState', value: 'completed' },
            update: { value: 'completed' },
          });
        await tx.auditEvent.create({
          data: {
            type: 'store.policy',
            scope: input.storeId,
            actor: 'local-user',
            details: json(input),
          },
        });
      }),
    );
    this.onChanged();
  }
  // Viewing only marks messages as read. It must not invalidate an in-flight reply.
  async setOpened(conversationId: string | null) {
    await this.lock.run(async () => {
      if (conversationId)
        await this.db.conversation.update({ where: { id: conversationId }, data: { unread: 0 } });
      this.viewedConversationId = conversationId;
    });
    this.onChanged();
    if (conversationId && this.host.markRead)
      void this.markViewedRead(conversationId).catch(async (e) => {
        await this.db.auditEvent
          .create({
            data: {
              type: 'platform_read_failed',
              scope: conversationId,
              actor: 'system',
              details: json({ reason: errorText(e) }),
            },
          })
          .catch(() => {});
      });
  }
  private async markViewedRead(conversationId: string) {
    const c = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!c || this.viewedConversationId !== conversationId) return;
    const store = await this.db.store.findUnique({ where: { id: c.storeId } });
    if (!store) return;
    const account = await this.db.account.findUnique({ where: { id: c.accountId } });
    if (
      !account ||
      account.status !== 'online' ||
      (store.platform !== 'goofish' && !(account.capabilities as any).markRead)
    )
      return;
    const messages = await this.db.message.findMany({
      where: { conversationId, origin: 'buyer', withdrawn: false },
      orderBy: { timestamp: 'desc' },
      take: 50,
      select: { externalId: true },
    });
    if (messages.length)
      await this.host.markRead?.(c.accountId, {
        conversationKey: c.externalKey,
        buyerId: c.buyerId,
        messageIds: messages.map((m) => m.externalId),
        platformContext: platformContextSchema.parse(c.platformContext),
      });
  }
  async setReception(conversationId: string, mode: 'human' | 'ai', expectedRevision?: number) {
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const c = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
        assert(
          expectedRevision === undefined || c.revision === expectedRevision,
          '会话已有新消息或接待状态变化，请刷新后操作',
          'CONFLICT',
        );
        if (mode === 'ai') {
          const pending = await tx.outboundMessage.findFirst({
            where: { conversationId, status: { in: ['prepared', 'dispatching', 'unknown'] } },
          });
          assert(!pending, '仍有消息正在发送或送达情况待确认，请核实后再交还 AI', 'SEND_PENDING');
          const business = await tx.platformAction.findFirst({
            where: {
              conversationId,
              reviewedAt: null,
              OR: [
                { status: { in: ['prepared', 'dispatched', 'unknown'] } },
                { operation: 'transfer-conversation', status: 'confirmed' },
              ],
            },
          });
          assert(
            !business,
            '仍有业务操作或平台转接需要核对，请在工作台的记录中核对后再交还 AI',
            'ACTION_PENDING',
          );
        }
        await this.cancelConversation(tx, conversationId);
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            openedByHuman: mode === 'human',
            ...(mode === 'ai'
              ? { awaitingHuman: false, humanSentAfterHandoff: false, handoffReason: null }
              : {}),
            revision: { increment: 1 },
          },
        });
        await tx.auditEvent.create({
          data: {
            type: 'conversation.reception',
            scope: c.storeId,
            actor: 'local-user',
            details: json({ conversationId, mode, resume: 'future_messages_only' }),
          },
        });
      }),
    );
    this.onChanged();
  }
  private async cancelConversation(tx: Tx, conversationId: string) {
    await tx.messageGroup.updateMany({
      where: { conversationId, state: 'waiting_answer' },
      data: { autoEligible: false },
    });
    await tx.job.updateMany({
      where: { conversationId, kind: 'reply', status: { in: mutableJobs } },
      data: { status: 'cancelled' },
    });
    await tx.outboundMessage.updateMany({
      where: { conversationId, status: 'prepared', origin: { not: 'human' } },
      data: { status: 'cancelled' },
    });
  }
  async handoff(conversationId: string, reason: string) {
    await this.lock.run(() =>
      this.db.$transaction((tx) => this.handoffTx(tx, conversationId, reason)),
    );
    this.onChanged();
  }
  private async handoffTx(tx: Tx, id: string, reason: string) {
    const c = await tx.conversation.findUniqueOrThrow({ where: { id } });
    await tx.conversation.update({
      where: { id },
      data: {
        awaitingHuman: true,
        handoffReason: reason,
        revision: { increment: 1 },
        ...(!c.awaitingHuman ? { humanSentAfterHandoff: false } : {}),
      },
    });
    await this.cancelConversation(tx, id);
    await tx.auditEvent.create({
      data: {
        type: 'conversation.handoff',
        createdAt: new Date(),
        scope: c.storeId,
        actor: 'system',
        details: json({ conversationId: id, reason }),
      },
    });
  }
  private async finishAgentHandoff(input: {
    conversationId: string;
    groupId: string;
    jobId: string;
    runId: string;
    result: ReplyResult;
    usage: unknown;
    guard: () => Promise<void>;
  }) {
    const notice = await this.lock.run(async () => {
      // Keep the original eligibility check, including real human / input / policy races.
      await input.guard();
      return this.db.$transaction(async (tx) => {
        // Finish this job before cancelling the conversation's other reply jobs. All of
        // these changes commit together, so a successful handoff cannot cancel itself.
        const completed = await tx.job.updateMany({
          where: { id: input.jobId, status: 'running' },
          data: { status: 'succeeded', leaseToken: null, leaseUntil: null, error: null },
        });
        assert(completed.count === 1, 'STALE:转人工任务已取消或完成');
        await this.handoffTx(tx, input.conversationId, input.result.reasonCode);
        await tx.aiRun.update({
          where: { id: input.runId },
          data: {
            status: 'succeeded',
            output: json(input.result),
            usage: json(input.usage),
            error: null,
            finishedAt: new Date(),
          },
        });
        const c = await tx.conversation.findUniqueOrThrow({
          where: { id: input.conversationId },
          include: { store: true },
        });
        return tx.outboundMessage.create({
          data: {
            intentKey: `handoff:${c.id}:${input.groupId}`,
            conversationId: c.id,
            storeId: c.storeId,
            accountId: c.accountId,
            routeVersion: c.routeVersion,
            conversationRevision: c.revision,
            replyConfigEpoch: c.store.replyConfigEpoch,
            origin: 'handoff_notice',
            body: { text: '已为您转人工，请稍候。' },
            aiRunId: input.runId,
          },
        });
      });
    });
    this.onChanged();
    try {
      await this.dispatch(notice.id);
    } catch (e) {
      // The handoff has committed. Record a notice failure on the outbox, without
      // undoing waiting-for-human, relabelling the AI run, or retrying a possible send.
      await this.lock.run(() =>
        this.db.$transaction(async (tx) => {
          await tx.outboundMessage.updateMany({
            where: { id: notice.id, status: 'prepared' },
            data: { status: 'rejected', error: errorText(e) },
          });
          await tx.outboundMessage.updateMany({
            where: { id: notice.id, status: 'dispatching' },
            data: { status: 'unknown', error: errorText(e) },
          });
        }),
      );
      this.onChanged();
    }
  }
  async ingest(input: IncomingMessage) {
    const result = await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const account = await tx.account.findUnique({ where: { id: input.accountId } });
        assert(account, '消息来源账号已移除，请重新连接店铺', 'ACCOUNT_REMOVED');
        const store = await tx.store.findUniqueOrThrow({
          where: { id: account.storeId },
          include: { replyPolicy: true },
        });
        const exists = await tx.message.findUnique({
          where: { storeId_externalId: { storeId: store.id, externalId: input.externalId } },
        });
        if (exists) {
          await tx.messageReceipt.upsert({
            where: { accountId_eventKey: { accountId: account.id, eventKey: input.eventKey } },
            create: { messageId: exists.id, accountId: account.id, eventKey: input.eventKey },
            update: {},
          });
          if (input.withdrawn && !exists.withdrawn) {
            await tx.message.update({ where: { id: exists.id }, data: { withdrawn: true } });
            const turns = await tx.answeredTurn.findMany({
              where: { conversationId: exists.conversationId },
              include: { questionGroup: true, answers: true },
            });
            for (const turn of turns) {
              if (
                !(turn.questionGroup.messageIds as string[]).includes(exists.id) &&
                !turn.answers.some((a) => a.messageId === exists.id) &&
                !(turn.contextMessageIds as string[]).includes(exists.id)
              )
                continue;
              const changed = await tx.answeredTurn.update({
                where: { id: turn.id },
                data: { sourceRevision: { increment: 1 }, status: 'invalidated' },
              });
              await this.turnEvent(tx, changed, 'turn.invalidated');
            }
            const groups = await tx.messageGroup.findMany({
              where: { conversationId: exists.conversationId, state: 'waiting_answer' },
            });
            for (const g of groups)
              if ((g.messageIds as string[]).includes(exists.id))
                await tx.messageGroup.update({
                  where: { id: g.id },
                  data: { revision: { increment: 1 }, autoEligible: false },
                });
            await this.cancelConversation(tx, exists.conversationId);
          }
          return exists;
        }
        let conversation = await tx.conversation.findUnique({
          where: { storeId_externalKey: { storeId: store.id, externalKey: input.conversationKey } },
        });
        if (!conversation)
          conversation = await tx.conversation.create({
            data: {
              storeId: store.id,
              externalKey: input.conversationKey,
              platformContext: json(platformContextSchema.parse(input.platformContext ?? {})),
              buyerId: input.buyerId,
              buyerName: input.buyerName,
              accountId: account.id,
            },
          });
        assert(conversation.buyerId === input.buyerId, '平台会话与买家身份不一致');
        if (
          conversation.accountId !== account.id &&
          !input.historical &&
          !input.withdrawn &&
          input.kind !== 'system' &&
          !(await tx.account.findUnique({ where: { id: conversation.accountId } }))
        ) {
          // A fresh observed message can establish a missing route even when the
          // shop has several accounts. History and duplicate echoes cannot choose it.
          conversation = await this.rebindConversation(tx, conversation, account, 'live_message');
        }
        if (input.platformContext) {
          conversation = await tx.conversation.update({
            where: { id: conversation.id },
            data: {
              platformContext: json({
                ...platformContextSchema.parse(conversation.platformContext),
                ...platformContextSchema.parse(input.platformContext),
              }),
            },
          });
        }
        const outbound =
          input.direction === 'out'
            ? await tx.outboundMessage.findFirst({
                where: { storeId: store.id, externalId: input.externalId },
              })
            : null;
        const unresolved =
          input.direction === 'out' && !outbound
            ? await tx.outboundMessage.findFirst({
                where: {
                  conversationId: conversation.id,
                  status: { in: ['dispatching', 'unknown'] },
                },
              })
            : null;
        const origin = outbound?.origin ?? (unresolved ? 'unknown' : input.origin);
        const msg = await tx.message.create({
          data: {
            conversationId: conversation.id,
            storeId: store.id,
            externalId: input.externalId,
            direction: input.direction,
            origin,
            kind: input.kind,
            text: input.text,
            attachmentId: input.attachmentId,
            timestamp: new Date(input.timestamp),
            raw: json({
              ...(input.raw && typeof input.raw === 'object' ? input.raw : {}),
              ...(input.richContent ? { richContent: input.richContent } : {}),
            }),
            withdrawn: input.withdrawn ?? false,
          },
        });
        await tx.messageReceipt.create({
          data: { messageId: msg.id, accountId: account.id, eventKey: input.eventKey },
        });
        if (input.historical || (outbound?.origin === 'ai' && (outbound.body as any).richContent))
          return msg;
        conversation = await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            preview: input.kind === 'image' ? '[图片]' : input.text,
            updatedAt: new Date(),
            // Outgoing replies and platform echoes do not change reception mode
            // or invalidate an AI reply already in progress.
            ...(input.direction === 'in' ? { revision: { increment: 1 } } : {}),
            unread:
              input.direction === 'in' && this.viewedConversationId !== conversation.id
                ? { increment: 1 }
                : conversation.unread,
          },
        });
        if (input.direction === 'in' && input.kind !== 'system' && !input.withdrawn) {
          const decision = getReplyEligibility({
            autoReplyEnabled: !!store.replyPolicy?.autoReplyEnabled,
            openedByHuman: conversation.openedByHuman,
            awaitingHuman: conversation.awaitingHuman,
            account,
          });
          const eligible = decision.eligible;
          const previous = await tx.messageGroup.findFirst({
            where: { conversationId: conversation.id, state: 'waiting_answer' },
            orderBy: { createdAt: 'desc' },
          });
          let group;
          if (
            previous &&
            previous.autoEligible === eligible &&
            Date.now() - previous.createdAt.getTime() < 3000
          ) {
            group = await tx.messageGroup.update({
              where: { id: previous.id },
              data: {
                messageIds: json([...(previous.messageIds as string[]), msg.id]),
                revision: { increment: 1 },
                sealedAt: new Date(Date.now() + 900),
              },
            });
          } else {
            if (previous && previous.autoEligible)
              await tx.messageGroup.update({
                where: { id: previous.id },
                data: { autoEligible: false },
              });
            group = await tx.messageGroup.create({
              data: {
                conversationId: conversation.id,
                messageIds: json([msg.id]),
                autoEligible: eligible,
                sealedAt: new Date(Date.now() + 900),
              },
            });
          }
          await tx.outboundMessage.updateMany({
            where: {
              conversationId: conversation.id,
              status: 'prepared',
              origin: { not: 'human' },
            },
            data: { status: 'cancelled' },
          });
          await tx.auditEvent.create({
            data: {
              type: 'reply.eligibility',
              scope: store.id,
              actor: 'system',
              details: json({
                ...decision,
                accountId: account.id,
                conversationId: conversation.id,
                messageId: msg.id,
                groupId: group.id,
                groupRevision: group.revision,
              }),
            },
          });
          if (eligible)
            await tx.job.create({
              data: {
                kind: 'reply',
                storeId: store.id,
                conversationId: conversation.id,
                dedupKey: `reply:${group.id}:${group.revision}`,
                priority: 10,
                runAfter: group.sealedAt,
                payload: json({
                  groupId: group.id,
                  groupRevision: group.revision,
                  conversationRevision: conversation.revision,
                }),
              },
            });
        } else if (input.direction === 'out')
          await this.associate(
            tx,
            msg.id,
            conversation.id,
            origin,
            outbound?.id,
            outbound?.questionGroupId ?? undefined,
          );
        return msg;
      }),
    );
    this.onChanged();
    if (
      result &&
      input.direction === 'in' &&
      !input.historical &&
      this.viewedConversationId === result.conversationId &&
      this.host.markRead
    )
      void this.markViewedRead(result.conversationId).catch(() => {});
    return result;
  }
  private async associate(
    tx: Tx,
    messageId: string,
    conversationId: string,
    origin: string,
    outboundId?: string,
    questionGroupId?: string,
  ) {
    // A transfer acknowledgement is neither a substantive answer nor a human takeover.
    if (origin === 'unknown' || origin === 'handoff_notice') return;
    const existing = await tx.turnAnswer.findFirst({ where: { messageId } });
    if (existing) return;
    const c = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
    if (message.withdrawn || message.kind === 'system') return;
    if (origin === 'human') {
      let currentHandoff = c.awaitingHuman;
      if (currentHandoff && outboundId) {
        const local = await tx.outboundMessage.findUniqueOrThrow({ where: { id: outboundId } });
        const handoffId = (local.body as { handoffId?: string }).handoffId;
        const latest = handoffId
          ? await tx.auditEvent.findFirst({
              where: {
                type: 'conversation.handoff',
                scope: c.storeId,
                details: { path: '$.conversationId', equals: c.id },
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            })
          : null;
        currentHandoff = !!handoffId && latest?.id === handoffId;
      }
      if (currentHandoff)
        await tx.conversation.update({
          where: { id: conversationId },
          data: { humanSentAfterHandoff: true },
        });
    }
    const humanContext =
      origin === 'human' && !questionGroupId
        ? await humanLearningContext(tx, message, outboundId)
        : null;
    const waiting =
      questionGroupId || origin === 'human'
        ? []
        : await tx.messageGroup.findMany({
            where: { conversationId, state: 'waiting_answer' },
            take: 2,
          });
    const group =
      humanContext?.group ??
      (questionGroupId
        ? await tx.messageGroup.findUnique({ where: { id: questionGroupId } })
        : waiting.length === 1
          ? waiting[0]
          : null);
    if (!group) {
      await tx.message.update({
        where: { id: messageId },
        data: {
          associationStatus: origin === 'human' ? 'no_question_context' : 'needs_association',
        },
      });
      return;
    }
    assert(group.conversationId === conversationId, '回答关联不属于当前会话');
    const questions = await tx.message.findMany({
      where: { id: { in: group.messageIds as string[] } },
    });
    assert(
      questions.length > 0 &&
        questions.every((q) => q.conversationId === conversationId && !q.withdrawn),
      '问题来源缺失或已撤回',
    );
    if (questions.some((q) => q.timestamp > message.timestamp)) {
      await tx.message.update({
        where: { id: messageId },
        data: { associationStatus: 'needs_association' },
      });
      return;
    }
    await tx.message.update({
      where: { id: messageId },
      data: { associationStatus: 'associated' },
    });
    const before = await tx.answeredTurn.findUnique({ where: { questionGroupId: group.id } });
    const contextData = humanContext
      ? {
          associationMode: 'conversation_context',
          contextMessageIds: json(humanContext.contextMessageIds),
        }
      : {};
    const turn = before
      ? await tx.answeredTurn.update({
          where: { id: before.id },
          data: {
            sourceRevision: { increment: 1 },
            answeredAt: new Date(),
            status: 'answered',
            ...contextData,
          },
        })
      : await tx.answeredTurn.create({
          data: { storeId: c.storeId, conversationId, questionGroupId: group.id, ...contextData },
        });
    await tx.turnAnswer.create({ data: { turnId: turn.id, messageId, origin, outboundId } });
    await tx.messageGroup.update({
      where: { id: group.id },
      data: { state: 'answered', autoEligible: false },
    });
    if (await this.turnHasLearnableAnswer(tx, turn.id))
      await this.turnEvent(tx, turn, before ? 'turn.revised' : 'turn.answered');
  }
  async associateManual(messageId: string, groupId: string) {
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const message = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
        assert(
          message.direction === 'out' &&
            message.origin !== 'unknown' &&
            message.origin !== 'handoff_notice' &&
            !message.withdrawn &&
            message.associationStatus === 'needs_association',
          '该消息不允许手动关联',
        );
        await this.associate(
          tx,
          message.id,
          message.conversationId,
          message.origin,
          undefined,
          groupId,
        );
        await tx.auditEvent.create({
          data: {
            type: 'answer.associated',
            actor: 'human',
            scope: message.storeId,
            details: json({ messageId, groupId }),
          },
        });
      }),
    );
    this.onChanged();
  }
  private async turnHasLearnableAnswer(tx: Tx, turnId: string) {
    const answers = await tx.turnAnswer.findMany({ where: { turnId }, select: { origin: true } });
    return answers.some((answer) => answer.origin !== 'qa_direct');
  }
  private async turnEvent(
    tx: Tx,
    turn: { id: string; storeId: string; sourceRevision: number },
    type: string,
  ) {
    const policy = await tx.learningPolicy.findUniqueOrThrow({ where: { storeId: turn.storeId } });
    await tx.businessEvent.upsert({
      where: { eventKey: `${type}:${turn.id}:${turn.sourceRevision}` },
      create: {
        eventKey: `${type}:${turn.id}:${turn.sourceRevision}`,
        storeId: turn.storeId,
        type,
        aggregateId: turn.id,
        sourceRevision: turn.sourceRevision,
        learningCaptureEpoch: policy.autoLearnEnabled ? policy.enableEpoch : null,
      },
      update: {},
    });
    const evaluations = await tx.learningEvaluation.findMany({
      where: { turnId: turn.id, sourceRevision: { lt: turn.sourceRevision } },
      select: { id: true },
    });
    await tx.knowledgeCandidate.updateMany({
      where: {
        evaluationId: { in: evaluations.map((e) => e.id) },
        status: { in: ['pending_review', 'approved'] },
      },
      data: { status: 'stale' },
    });
  }
  private async captureLearning() {
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const policies = await tx.learningPolicy.findMany({ where: { autoLearnEnabled: true } });
        for (const p of policies) {
          const sub = await tx.learningSubscription.upsert({
            where: { storeId: p.storeId },
            create: { storeId: p.storeId },
            update: {},
          });
          const events = await tx.businessEvent.findMany({
            where: { storeId: p.storeId, sequence: { gt: sub.eventCursor } },
            orderBy: { sequence: 'asc' },
            take: 50,
          });
          for (const e of events) {
            if (e.learningCaptureEpoch == null || e.type === 'turn.invalidated') continue;
            const turn = await tx.answeredTurn.findUnique({ where: { id: e.aggregateId } });
            if (
              !turn ||
              turn.status !== 'answered' ||
              turn.sourceRevision !== e.sourceRevision ||
              !(await this.turnHasLearnableAnswer(tx, turn.id))
            )
              continue;
            await tx.job.upsert({
              where: { dedupKey: `learn-event:${e.sequence}` },
              create: {
                kind: 'learn',
                storeId: p.storeId,
                dedupKey: `learn-event:${e.sequence}`,
                priority: 60,
                runAfter: new Date(
                  Math.max(
                    Date.now() + 800,
                    turn.answeredAt.getTime() +
                      (turn.associationMode === 'conversation_context'
                        ? HUMAN_LEARNING_SETTLE_MS
                        : 800),
                  ),
                ),
                payload: json({ turnId: e.aggregateId, sourceRevision: e.sourceRevision }),
              },
              update: {},
            });
          }
          if (events.length)
            await tx.learningSubscription.update({
              where: { storeId: p.storeId },
              data: { eventCursor: events.at(-1)!.sequence },
            });
        }
      }),
    );
  }
  private async reply(jobId: string, payload: Record<string, unknown>, signal: AbortSignal) {
    const group = await this.db.messageGroup.findUniqueOrThrow({
      where: { id: String(payload.groupId) },
      include: { conversation: { include: { store: { include: { replyPolicy: true } } } } },
    });
    const c = group.conversation;
    const store = c.store;
    const guard = async () => {
      signal.throwIfAborted();
      const current = await this.db.conversation.findUniqueOrThrow({
        where: { id: c.id },
        include: { store: { include: { replyPolicy: true } } },
      });
      const g = await this.db.messageGroup.findUniqueOrThrow({ where: { id: group.id } });
      assert(
        g.autoEligible &&
          g.state === 'waiting_answer' &&
          g.revision === Number(payload.groupRevision) &&
          current.revision === Number(payload.conversationRevision) &&
          current.accountId === c.accountId &&
          current.routeVersion === c.routeVersion &&
          current.store.replyConfigEpoch === store.replyConfigEpoch &&
          current.store.replyPolicy?.autoReplyEnabled &&
          !current.openedByHuman &&
          !current.awaitingHuman,
        'STALE:回复上下文或接待资格已变化',
      );
    };
    let question = '';
    let matches: KnowledgeMatch[] = [];
    let result: ReplyResult;
    let usage: unknown = {};
    let evidenceIds: string[] = [];
    let path = 'direct_match';
    let configSnapshot: unknown;
    let runId: string | undefined;
    let stage = 'eligibility';
    let trace: RunTrace | undefined;
    let knowledgeStartedAt: Date | undefined, knowledgeFinishedAt: Date | undefined;
    let knowledgeError: unknown;
    let knowledgeSearchStatus: 'completed' | 'failed' = 'failed';
    const recordKnowledge = async () =>
      trace?.record({
        kind: 'knowledge',
        name: '匹配本店问答',
        input: { query: question },
        output: { matches },
        error: knowledgeError,
        ...(knowledgeError && errorText(knowledgeError).includes('尚未配置 Embedding 模型')
          ? { status: 'skipped' as const }
          : {}),
        startedAt: knowledgeStartedAt,
        finishedAt: knowledgeFinishedAt,
      });
    try {
      await guard();
      stage = 'account';
      const account = await this.db.account.findUnique({ where: { id: c.accountId } });
      assert(account, '会话账号已移除，请重新连接店铺', 'ACCOUNT_REMOVED');
      assert(account.storeId === c.storeId, '发送账号不属于当前店铺', 'ACCOUNT_SCOPE_MISMATCH');
      const readiness = getAutoReplyReadiness([account]);
      assert(readiness.ready, readiness.reason, 'REPLY_NOT_READY');
      const messages = await this.db.message.findMany({
        where: { id: { in: group.messageIds as string[] }, withdrawn: false },
        orderBy: { timestamp: 'asc' },
      });
      question = messages.map((m) => m.text).join('\n');
      stage = 'knowledge';
      knowledgeStartedAt = new Date();
      try {
        matches = await resolveKnowledgeMatches(
          this.db,
          store.id,
          await this.ai.search(store.id, question),
        );
        knowledgeSearchStatus = 'completed';
      } catch (error) {
        knowledgeError = error;
        /* Agent may use read-only knowledge fallback. */
      }
      knowledgeFinishedAt = new Date();
      const knowledgeDecision = decideKnowledgeReply(
        matches,
        store.replyPolicy!.directMatchThreshold,
      );
      const direct = messages.every((m) => m.kind === 'text')
        ? knowledgeDecision.direct
        : undefined;
      evidenceIds = matches.map((m) => m.revisionId);
      configSnapshot = {
        replyConfigEpoch: store.replyConfigEpoch,
        matches,
        knowledgeDecision: knowledgeDecision.reason,
        threshold: store.replyPolicy!.directMatchThreshold,
      };
      if (direct)
        result = {
          action: 'reply',
          text:
            direct.qa.answerKind === 'image' ? (direct.qa.answerBefore ?? '') : direct.qa.answer,
          attachmentId: direct.qa.answerKind === 'image' ? direct.qa.attachmentId : undefined,
          textAfter: direct.qa.answerKind === 'image' ? direct.qa.answerAfter : undefined,
          evidenceIds: [direct.revisionId],
          reasonCode: 'qa_direct',
        };
      else {
        stage = 'agent_config';
        const resolved = await this.agents.resolve(store.id);
        assert(
          resolved,
          `${knowledgeDecision.reason}；未配置工作回复 Agent`,
          'REPLY_AGENT_MISSING',
        );
        assert(
          resolved.config.modelSnapshot,
          '工作回复 Agent 尚未配置模型，请配置模型后发布并绑定',
          'REPLY_MODEL_MISSING',
        );
        const agentTree = await resolveRuntimeToolkits(
          this.db,
          resolved.config,
          resolved.revision.id,
        );
        resolved.config = agentTree[resolved.revision.id];
        const settingsSnapshot: Record<string, Record<string, unknown>> = {};
        const settingsRevisions: Record<string, unknown> = {};
        const seen = new Set<string>();
        const collect = async (config: typeof resolved.config) => {
          for (const assetId of [...config.toolkitIds, ...config.workflowIds]) {
            if (seen.has(assetId)) continue;
            seen.add(assetId);
            const rows = await assetSettingsRows(this.db, assetId, store.id);
            settingsRevisions[assetId] = [
              rows.find((r) => r.scopeKey === 'global'),
              rows.find((r) => r.scopeKey !== 'global'),
            ]
              .filter(Boolean)
              .map((r) => ({ id: r!.id, scopeKey: r!.scopeKey, revision: r!.revision }));
            settingsSnapshot[assetId] = {
              ...(rows.find((r) => r.scopeKey === 'global')?.values as object),
              ...(rows.find((r) => r.scopeKey !== 'global')?.values as object),
            };
          }
          for (const sub of config.subAgents) {
            await collect(agentTree[sub.revisionId]);
          }
        };
        await collect(resolved.config);
        path = 'agent';
        configSnapshot = {
          ...resolved,
          agentTree,
          settingsSnapshot,
          settingsRevisions,
          replyConfigEpoch: store.replyConfigEpoch,
        };
        const snap = await this.db.runConfigSnapshot.create({
          data: {
            storeId: store.id,
            role: 'reply',
            configEpoch: store.replyConfigEpoch,
            config: json(configSnapshot),
            configHash: hash(configSnapshot),
          },
        });
        const run = await this.db.aiRun.create({
          data: {
            jobId,
            traceVersion: 1,
            storeId: store.id,
            conversationId: c.id,
            role: 'reply',
            path,
            snapshotId: snap.id,
            input: json({ question, messageIds: group.messageIds }),
            output: {},
            evidence: json(matches),
            usage: {},
          },
        });
        runId = run.id;
        trace = new RunTrace(this.db, run.id, () => this.onChanged());
        await recordKnowledge();
        const history = await this.db.message.findMany({
          where: { conversationId: c.id, withdrawn: false },
          orderBy: { timestamp: 'desc' },
          take: resolved.config.memory.lastMessages,
        });
        stage = 'agent';
        const ai = await this.ai.reply({
          trace,
          agentTree,
          settingsSnapshot,
          platform: platformSchema.parse(store.platform),
          conversationKey: c.externalKey,
          platformContext: platformContextSchema.parse(c.platformContext),
          storeId: store.id,
          conversationId: c.id,
          accountId: account.id,
          buyerId: c.buyerId,
          runId: run.id,
          configEpoch: store.replyConfigEpoch,
          question,
          messages: history.reverse().map((m) => ({
            id: m.id,
            origin: m.origin,
            text: m.text,
            attachmentId: m.attachmentId,
          })),
          matches,
          knowledgeSearch: { query: question, status: knowledgeSearchStatus },
          config: resolved.config,
          revisionId: resolved.revision.id,
          capabilities: account.capabilities as unknown as Capabilities,
          signal,
          guard,
        });
        result = ai.result;
        usage = ai.usage;
        evidenceIds = [...evidenceIds, ...ai.evidenceIds, ...history.map((m) => m.id)];
      }
      await guard();
      assert(
        result.evidenceIds.every((id) => evidenceIds.includes(id)),
        'Agent 引用了本轮不存在的依据',
      );
      if (result.action === 'handoff') {
        assert(runId, '转人工缺少 Agent 运行记录');
        await this.finishAgentHandoff({
          conversationId: c.id,
          groupId: group.id,
          jobId,
          runId,
          result,
          usage,
          guard,
        });
        return;
      }
      if (runId)
        await this.db.aiRun.update({
          where: { id: runId },
          data: {
            status: 'succeeded',
            output: json(result),
            usage: json(usage),
            finishedAt: new Date(),
          },
        });
      else {
        const snap = await this.db.runConfigSnapshot.create({
          data: {
            storeId: store.id,
            role: 'reply',
            configEpoch: store.replyConfigEpoch,
            config: json(configSnapshot),
            configHash: hash(configSnapshot),
          },
        });
        runId = (
          await this.db.aiRun.create({
            data: {
              jobId,
              traceVersion: 1,
              storeId: store.id,
              conversationId: c.id,
              role: 'reply',
              path,
              snapshotId: snap.id,
              input: json({ question }),
              output: json(result),
              evidence: json(matches),
              usage: {},
              status: 'succeeded',
              finishedAt: new Date(),
            },
          })
        ).id;
        trace = new RunTrace(this.db, runId, () => this.onChanged());
        await recordKnowledge();
      }
      if (result.action === 'ignore') {
        if (result.reasonCode === 'platform_message_sent' && runId)
          await this.lock.run(() =>
            this.db.$transaction(async (tx) => {
              const sent = await tx.outboundMessage.findMany({
                where: { aiRunId: runId, conversationId: c.id, status: 'confirmed' },
              });
              for (const o of sent) {
                if (!(o.body as any).richContent || !o.externalId) continue;
                const message = await tx.message.findUnique({
                  where: { storeId_externalId: { storeId: c.storeId, externalId: o.externalId } },
                });
                if (message) await this.associate(tx, message.id, c.id, o.origin, o.id, group.id);
              }
            }),
          );
        return;
      }
      assert(result.text.trim() || result.attachmentId, '回复为空');
      stage = 'send';
      await this.prepareAndSend({
        conversationId: c.id,
        text: result.text,
        attachmentId: result.attachmentId,
        textAfter: result.textAfter,
        origin: direct ? 'qa_direct' : 'ai',
        intentKey: `reply:${c.id}:${group.id}`,
        groupId: group.id,
        aiRunId: runId,
        guard,
      });
    } catch (e) {
      let failure = e;
      await this.lock.run(async () => {
        // Workflows may wrap STALE as a generic step failure. Recheck the actual state
        // under the same lock as the fallback handoff, so it cannot overwrite a takeover.
        try {
          await guard();
        } catch (stale) {
          failure = stale;
        }
        await this.db.$transaction(async (tx) => {
          const cancelled = signal.aborted || errorText(failure).startsWith('STALE:');
          const message = signal.aborted
            ? 'STALE:回复任务已取消或应用正在停止'
            : errorText(failure);
          // Finalize before handoff cancels other reply jobs. A failed preflight must
          // never fall through to the scheduler's success update or automatic replay.
          await tx.job.updateMany({
            where: { id: jobId, status: { in: [...mutableJobs, 'cancelled'] } },
            data: {
              status: cancelled ? 'cancelled' : 'failed',
              error: message,
              leaseToken: null,
              leaseUntil: null,
            },
          });
          if (runId)
            await tx.aiRun.update({
              where: { id: runId },
              data: { status: 'failed', error: message, finishedAt: new Date() },
            });
          else if (!cancelled)
            await tx.aiRun.create({
              data: {
                jobId,
                traceVersion: 1,
                storeId: store.id,
                conversationId: c.id,
                role: 'reply',
                path: 'preflight',
                status: 'failed',
                input: json({ question, messageIds: group.messageIds }),
                output: {},
                evidence: json(matches),
                usage: json({ stage, modelCalled: false }),
                error: message,
                finishedAt: new Date(),
              },
            });
          if (!cancelled && !(failure instanceof DomainError && failure.code === 'REPLY_NOT_READY'))
            await this.handoffTx(tx, c.id, `自动回复暂停：${message}`);
        });
      });
      this.onChanged();
      if (signal.aborted || errorText(failure).startsWith('STALE:')) {
        const current = await this.db.conversation.findUniqueOrThrow({
          where: { id: c.id },
          include: { store: true },
        });
        if (current.store.replyConfigEpoch !== store.replyConfigEpoch)
          await this.requeueReply(group.id);
      }
    } finally {
      await trace?.finishPending();
    }
  }
  async requeueReply(groupId: string) {
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const g = await tx.messageGroup.findUniqueOrThrow({
          where: { id: groupId },
          include: { conversation: { include: { store: { include: { replyPolicy: true } } } } },
        });
        const c = g.conversation;
        if (
          !g.autoEligible ||
          g.state !== 'waiting_answer' ||
          c.openedByHuman ||
          c.awaitingHuman ||
          !c.store.replyPolicy?.autoReplyEnabled
        )
          return;
        await tx.job.upsert({
          where: { dedupKey: `reply:${g.id}:${g.revision}:epoch:${c.store.replyConfigEpoch}` },
          create: {
            kind: 'reply',
            storeId: c.storeId,
            conversationId: c.id,
            dedupKey: `reply:${g.id}:${g.revision}:epoch:${c.store.replyConfigEpoch}`,
            priority: 10,
            payload: json({
              groupId: g.id,
              groupRevision: g.revision,
              conversationRevision: c.revision,
            }),
          },
          update: {},
        });
      }),
    );
  }
  async sendManual(input: {
    conversationId: string;
    text: string;
    attachmentId?: string;
    textAfter?: string;
    requestId: string;
  }) {
    assert(input.text.trim() || input.attachmentId, '请输入消息或选择图片');
    return this.prepareAndSend({
      ...input,
      origin: 'human',
      intentKey: `manual:${input.requestId}`,
    });
  }
  // The renderer waits only for the durable intent, never for the platform receipt.
  async enqueueManualText(input: { conversationId: string; text: string; requestId: string }) {
    assert(!this.stopped, '本地服务正在停止，请稍后重试');
    assert(input.text.trim(), '请输入消息');
    const outbound = await this.prepareOutbound({
      ...input,
      origin: 'human',
      intentKey: `manual:${input.requestId}`,
    });
    this.queueOutbound(outbound);
    return outbound;
  }
  async sendBusinessMessage(
    input: NonNullable<AppHost['sendBusinessMessage']> extends (input: infer I) => any ? I : never,
  ) {
    const richContent = richContentSchema.parse(input.richContent);
    const text =
      richContent.kind === 'video'
        ? `[视频] ${richContent.title}`
        : richContent.kind === 'review_card'
          ? `[邀请评价] 订单 ${richContent.orderSn}`
          : `[商品] ${richContent.title}`;
    const outbound = await this.prepareOutbound({
      conversationId: input.conversationId,
      text,
      richContent,
      origin: input.human ? 'human' : 'ai',
      intentKey: input.intentKey,
      aiRunId: input.runId,
      guard: input.guard,
    });
    this.queueOutbound(outbound);
    if (!input.human) await this.manualQueues.get(outbound.conversationId);
    return this.db.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } });
  }
  private queueOutbound(outbound: { id: string; conversationId: string; status: string }) {
    if (outbound.status === 'prepared' && !this.queuedManualIds.has(outbound.id)) {
      this.queuedManualIds.add(outbound.id);
      const preceding = this.manualQueues.get(outbound.conversationId) ?? Promise.resolve();
      const task = preceding
        .then(async () => {
          try {
            if (this.stopped) {
              await this.db.outboundMessage.updateMany({
                where: { id: outbound.id, status: 'prepared' },
                data: { status: 'cancelled', error: '应用已停止，消息尚未提交到平台' },
              });
            } else await this.dispatch(outbound.id);
          } catch (e) {
            // A pre-dispatch failure is definite; an in-flight exception is uncertain.
            // Never silently replay either, and never overwrite a late confirmation.
            await this.lock.run(() =>
              this.db.$transaction(async (tx) => {
                await tx.outboundMessage.updateMany({
                  where: { id: outbound.id, status: 'prepared' },
                  data: { status: 'rejected', error: errorText(e) },
                });
                await tx.outboundMessage.updateMany({
                  where: { id: outbound.id, status: 'dispatching' },
                  data: { status: 'unknown', error: errorText(e) },
                });
              }),
            );
          }
        })
        .catch((e) => {
          console.error('人工消息后台发送状态保存失败', errorText(e));
        })
        .finally(() => {
          this.queuedManualIds.delete(outbound.id);
          if (this.manualQueues.get(outbound.conversationId) === task)
            this.manualQueues.delete(outbound.conversationId);
          this.onChanged();
        });
      this.manualQueues.set(outbound.conversationId, task);
    }
    this.onChanged();
    return outbound;
  }
  private async prepareAndSend(
    input: Parameters<Engine['prepareOutbound']>[0] & { textAfter?: string },
  ) {
    assert(!input.textAfter?.trim() || input.attachmentId, '图片后文字需要同时选择图片');
    if (!input.attachmentId || (!input.text.trim() && !input.textAfter?.trim())) {
      const outbound = await this.prepareOutbound(input);
      if (outbound.status !== 'prepared') return outbound;
      return this.dispatch(outbound.id);
    }
    // Persist the whole ordered answer before sending. Each receipt still goes
    // through dispatch's scope/config checks and associates with the same question.
    // An uncertain/rejected part cancels the remaining parts, never replays them.
    const conversation = await this.db.conversation.findUniqueOrThrow({
      where: { id: input.conversationId },
    });
    const account = await this.db.account.findUniqueOrThrow({
      where: { id: conversation.accountId },
    });
    const caps = account.capabilities as unknown as Capabilities;
    assert(caps.sendText && caps.sendImage, '平台当前不支持图文消息发送');
    const attachment = await this.db.attachment.findUniqueOrThrow({
      where: { id: input.attachmentId },
    });
    assert(knowledgeAllowed(attachment.storeId, conversation.storeId), '图片范围不匹配');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await readFile(join(this.dir, attachment.relativePath));
    const sequenceHash = hash([input.text, input.attachmentId, input.textAfter ?? '']);
    const parts: Array<{ text: string; attachmentId?: string }> = [
      ...(input.text.trim() ? [{ text: input.text }] : []),
      { text: '', attachmentId: input.attachmentId },
      ...(input.textAfter?.trim() ? [{ text: input.textAfter }] : []),
    ];
    const outbounds: Awaited<ReturnType<Engine['prepareOutbound']>>[] = [];
    const cancelRemaining = async (reason: string) => {
      await this.db.outboundMessage.updateMany({
        where: { id: { in: outbounds.map((o) => o.id) }, status: 'prepared' },
        data: { status: 'cancelled', error: reason },
      });
      this.onChanged();
    };
    try {
      for (const [index, part] of parts.entries())
        outbounds.push(
          await this.prepareOutbound({
            ...input,
            ...part,
            attachmentId: part.attachmentId,
            sequenceHash,
            intentKey: index === 0 ? input.intentKey : `${input.intentKey}:part:${index}`,
          }),
        );
      let result = outbounds[0];
      for (const outbound of outbounds) {
        result = outbound.status === 'prepared' ? await this.dispatch(outbound.id) : outbound;
        if (result.status !== 'confirmed') {
          await cancelRemaining('图文回答前一条消息未确认，后续内容已停止，请人工核对');
          return result;
        }
      }
      return result;
    } catch (error) {
      await cancelRemaining(`图文回答已停止：${errorText(error)}`);
      throw error;
    }
  }
  private async prepareOutbound(input: {
    conversationId: string;
    text: string;
    attachmentId?: string;
    origin: string;
    intentKey: string;
    groupId?: string;
    aiRunId?: string;
    guard?: () => Promise<void>;
    richContent?: RichContent;
    sequenceHash?: string;
  }) {
    const outbound = await this.lock.run(async () => {
      if (input.guard) await input.guard();
      return this.db.$transaction(async (tx) => {
        const previous = await tx.outboundMessage.findUnique({
          where: { intentKey: input.intentKey },
        });
        if (previous) {
          const body = previous.body as {
            text: string;
            attachmentId?: string;
            richContent?: RichContent;
            sequenceHash?: string;
          };
          assert(
            previous.conversationId === input.conversationId &&
              previous.origin === input.origin &&
              body.text === input.text &&
              body.attachmentId === input.attachmentId &&
              body.sequenceHash === input.sequenceHash &&
              hash(body.richContent ?? null) === hash(input.richContent ?? null),
            '同一发送请求不能更换会话或消息内容',
          );
          return previous;
        }
        let c = await tx.conversation.findUniqueOrThrow({
          where: { id: input.conversationId },
          include: { store: true },
        });
        if (input.richContent) {
          const pending = await tx.outboundMessage.findMany({
            where:
              input.richContent.kind === 'review_card'
                ? {
                    storeId: c.storeId,
                    conversationId: {
                      in: (
                        await tx.conversation.findMany({
                          where: { storeId: c.storeId, buyerId: c.buyerId },
                          select: { id: true },
                        })
                      ).map((row) => row.id),
                    },
                    status: { in: ['prepared', 'dispatching', 'unknown', 'confirmed'] },
                    body: { path: '$.richContent.orderSn', equals: input.richContent.orderSn },
                  }
                : { conversationId: c.id, status: { in: ['prepared', 'dispatching', 'unknown'] } },
            ...(input.richContent.kind === 'review_card' ? {} : { take: 100 }),
          });
          const target = richMessageTarget(input.richContent);
          const previous = pending.find((o) => {
            const rich = (o.body as { richContent?: RichContent }).richContent;
            return rich?.kind === input.richContent!.kind && richMessageTarget(rich) === target;
          });
          if (previous) return previous;
        }
        if (input.origin === 'human') c = { ...c, ...(await this.resolveManualRoute(tx, c)) };
        if (input.attachmentId)
          assert(
            knowledgeAllowed(
              (await tx.attachment.findUnique({ where: { id: input.attachmentId } }))?.storeId,
              c.storeId,
            ),
            '图片范围不匹配',
          );
        const handoff =
          input.origin === 'human' && c.awaitingHuman
            ? await tx.auditEvent.findFirst({
                where: {
                  type: 'conversation.handoff',
                  scope: c.storeId,
                  details: { path: '$.conversationId', equals: c.id },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              })
            : null;
        return tx.outboundMessage.create({
          data: {
            intentKey: input.intentKey,
            createdAt: new Date(),
            conversationId: c.id,
            storeId: c.storeId,
            accountId: c.accountId,
            routeVersion: c.routeVersion,
            conversationRevision: c.revision,
            replyConfigEpoch: c.store.replyConfigEpoch,
            questionGroupId: input.groupId,
            origin: input.origin,
            body: json({
              text: input.text,
              attachmentId: input.attachmentId,
              ...(input.sequenceHash ? { sequenceHash: input.sequenceHash } : {}),
              ...(input.richContent ? { richContent: input.richContent } : {}),
              ...(handoff ? { handoffId: handoff.id } : {}),
            }),
            aiRunId: input.aiRunId,
          },
        });
      });
    });
    return outbound;
  }
  async dispatch(id: string) {
    const prepared = await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const o = await tx.outboundMessage.findUniqueOrThrow({ where: { id } });
        if (o.status !== 'prepared') return null;
        const c = await tx.conversation.findUniqueOrThrow({
          where: { id: o.conversationId },
          include: { store: { include: { replyPolicy: true } } },
        });
        const a = await tx.account.findUnique({ where: { id: o.accountId } });
        const routeError = !a
          ? '发送账号已移除，请重新连接店铺后发送'
          : a.storeId !== c.storeId || o.storeId !== c.storeId
            ? '发送账号与当前店铺不匹配，请重新连接店铺'
            : c.accountId !== o.accountId || c.routeVersion !== o.routeVersion
              ? '会话发送账号已变化，请核对后重新发送'
              : a.status !== 'online'
                ? '消息通道未连接，请打开平台连接成功后再发送'
                : null;
        if (routeError) {
          await tx.outboundMessage.update({
            where: { id },
            data: { status: 'cancelled', error: routeError },
          });
          return null;
        }
        assert(a, '发送账号已移除', 'ACCOUNT_REMOVED');
        const body = o.body as { text: string; attachmentId?: string; richContent?: RichContent };
        const auto = o.origin !== 'human';
        const handoffNotice = o.origin === 'handoff_notice';
        const valid =
          !auto ||
          (getAutoReplyReadiness([a]).ready &&
            c.revision === o.conversationRevision &&
            c.store.replyConfigEpoch === o.replyConfigEpoch &&
            !c.openedByHuman &&
            c.awaitingHuman === handoffNotice &&
            c.store.replyPolicy?.autoReplyEnabled);
        if (!valid) {
          await tx.outboundMessage.update({
            where: { id },
            data: { status: 'cancelled', error: '发送前资格或配置已变化' },
          });
          return null;
        }
        if (o.aiRunId) {
          const run = await tx.aiRun.findUniqueOrThrow({ where: { id: o.aiRunId } });
          const output = run.output as { evidenceIds?: string[] };
          for (const evidenceId of output.evidenceIds ?? []) {
            const revision = await tx.knowledgeRevision.findUnique({
              where: { id: evidenceId },
              include: { entry: true },
            });
            if (revision)
              assert(
                knowledgeAllowed(revision.entry.storeId, o.storeId) &&
                  revision.entry.status === 'enabled' &&
                  revision.entry.activeRevisionId === revision.id &&
                  (!revision.validUntil || revision.validUntil > new Date()),
                '引用知识已失效',
              );
          }
        }
        const caps = a.capabilities as unknown as Capabilities;
        assert(
          body.richContent
            ? richActionCapabilities[richMessageOperation(body.richContent.kind)].every(
                (key) => caps[key],
              ) &&
                (!caps.operations ||
                  caps.operations.includes(richMessageOperation(body.richContent.kind)))
            : body.attachmentId
              ? caps.sendImage
              : caps.sendText,
          '平台当前不支持该消息发送',
        );
        let imageData: string | undefined;
        let imageMime: string | undefined;
        if (body.attachmentId) {
          const attachment = await tx.attachment.findUniqueOrThrow({
            where: { id: body.attachmentId },
          });
          assert(knowledgeAllowed(attachment.storeId, o.storeId), '图片范围不匹配');
          const { readFile } = await import('node:fs/promises');
          const { join } = await import('node:path');
          imageData = (await readFile(join(this.dir, attachment.relativePath))).toString('base64');
          imageMime = attachment.mimeType;
        }
        const token = uid();
        await tx.outboundMessage.update({
          where: { id },
          data: { status: 'dispatching', dispatchToken: token },
        });
        return { o, c, body, token, imageData, imageMime };
      }),
    );
    this.onChanged();
    if (!prepared) return this.db.outboundMessage.findUniqueOrThrow({ where: { id } });
    let result: SendResult;
    try {
      result = await this.host.send({
        id,
        token: prepared.token,
        accountId: prepared.o.accountId,
        buyerId: prepared.c.buyerId,
        conversationKey: prepared.c.externalKey,
        platformContext: platformContextSchema.parse(prepared.c.platformContext),
        kind: prepared.body.richContent?.kind ?? (prepared.body.attachmentId ? 'image' : 'text'),
        richContent: prepared.body.richContent,
        text: prepared.body.text,
        imageData: prepared.imageData,
        imageMime: prepared.imageMime,
      });
    } catch (e) {
      result = { status: 'unknown', reason: errorText(e) };
    }
    await this.completeSend(id, result);
    return this.db.outboundMessage.findUniqueOrThrow({ where: { id } });
  }
  async completeSend(id: string, result: SendResult) {
    await this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const o = await tx.outboundMessage.findUniqueOrThrow({ where: { id } });
        if (o.status === 'confirmed' || (o.status === 'rejected' && result.status !== 'confirmed'))
          return;
        assert(['dispatching', 'unknown'].includes(o.status), '发送状态不允许确认');
        await tx.outboundMessage.update({
          where: { id },
          data: {
            status: result.status,
            externalId: result.status === 'confirmed' ? result.externalId : undefined,
            error: result.status === 'confirmed' ? null : result.reason,
          },
        });
        if (result.status === 'confirmed') {
          const body = o.body as { text: string; attachmentId?: string; richContent?: RichContent };
          let msg = await tx.message.findUnique({
            where: { storeId_externalId: { storeId: o.storeId, externalId: result.externalId } },
          });
          if (!msg)
            msg = await tx.message.create({
              data: {
                storeId: o.storeId,
                conversationId: o.conversationId,
                externalId: result.externalId,
                direction: 'out',
                origin: o.origin,
                kind: body.richContent?.kind ?? (body.attachmentId ? 'image' : 'text'),
                text: body.text,
                attachmentId: body.attachmentId,
                timestamp: new Date(),
                raw: json({
                  confirmedOutboundId: id,
                  ...(body.richContent ? { richContent: body.richContent } : {}),
                }),
              },
            });
          else
            await tx.message.update({
              where: { id: msg.id },
              data: {
                origin: o.origin,
                ...(body.richContent ? { kind: body.richContent.kind, text: body.text } : {}),
                raw: json({
                  ...(msg.raw && typeof msg.raw === 'object' && !Array.isArray(msg.raw)
                    ? msg.raw
                    : {}),
                  confirmedOutboundId: id,
                  ...(body.richContent ? { richContent: body.richContent } : {}),
                }),
              },
            });
          await tx.conversation.update({
            where: { id: o.conversationId },
            data: { preview: body.attachmentId ? '[图片]' : body.text, updatedAt: new Date() },
          });
          const runningBusinessReply =
            body.richContent &&
            o.aiRunId &&
            (await tx.aiRun.findUnique({ where: { id: o.aiRunId } }))?.status === 'running';
          if (!runningBusinessReply)
            await this.associate(
              tx,
              msg.id,
              o.conversationId,
              o.origin,
              o.id,
              o.questionGroupId ?? undefined,
            );
          // A receipt confirms delivery, not consent to give the conversation back to AI.
        }
      }),
    );
    this.onChanged();
  }
  private async learn(jobId: string, payload: Record<string, unknown>, signal: AbortSignal) {
    const turn = await this.db.answeredTurn.findUniqueOrThrow({
      where: { id: String(payload.turnId) },
      include: { questionGroup: true, answers: { include: { message: true } } },
    });
    if (turn.status !== 'answered' || turn.sourceRevision !== Number(payload.sourceRevision))
      return;
    assert(
      turn.answers.every(
        (a) =>
          a.message.storeId === turn.storeId && a.message.conversationId === turn.conversationId,
      ),
      '学习回答来源不属于当前店铺会话',
    );
    if (turn.answers.every((answer) => answer.origin === 'qa_direct')) return;
    const policy = await this.db.learningPolicy.findUniqueOrThrow({
      where: { storeId: turn.storeId },
    });
    const store = await this.db.store.findUniqueOrThrow({ where: { id: turn.storeId } });
    assert(policy.autoLearnEnabled, '学习已暂停');
    const fallback = await this.db.appSetting.findUnique({ where: { key: 'defaultModelId' } });
    const modelId =
      policy.builtinModelRef ?? (typeof fallback?.value === 'string' ? fallback.value : null);
    assert(modelId, '请在设置中配置内置学习模型');
    const model = await this.db.modelProfile.findUniqueOrThrow({ where: { id: modelId } });
    const evaluatorVersion = hash({
      builtin: BUILTIN_LEARNING_VERSION,
      model,
    });
    const completed = await this.db.learningEvaluation.findMany({
      where: {
        storeId: turn.storeId,
        turnId: turn.id,
        sourceRevision: turn.sourceRevision,
        status: 'completed',
      },
      select: { evaluatorVersion: true, aiRunId: true },
    });
    if (completed.some((e) => e.evaluatorVersion === evaluatorVersion)) return;
    // Legacy fingerprints included the daily limit. If a process stopped after
    // committing an evaluation but before finishing its job, do not evaluate it again.
    if (
      completed.length &&
      (await this.db.aiRun.findFirst({
        where: {
          id: { in: completed.flatMap((e) => (e.aiRunId ? [e.aiRunId] : [])) },
          jobId,
          storeId: turn.storeId,
          role: 'learning',
        },
        select: { id: true },
      }))
    )
      return;
    const questions = await this.db.message.findMany({
      where: {
        id: { in: turn.questionGroup.messageIds as string[] },
        storeId: turn.storeId,
        conversationId: turn.conversationId,
        withdrawn: false,
      },
      orderBy: [{ timestamp: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
    });
    const context = await this.db.message.findMany({
      where: {
        id: { in: turn.contextMessageIds as string[] },
        storeId: turn.storeId,
        conversationId: turn.conversationId,
        withdrawn: false,
      },
      orderBy: [{ timestamp: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
    });
    const outbounds = await this.db.outboundMessage.findMany({
      where: {
        storeId: turn.storeId,
        conversationId: turn.conversationId,
        id: { in: turn.answers.map((a) => a.outboundId).filter((x): x is string => !!x) },
      },
    });
    const runs = await this.db.aiRun.findMany({
      where: {
        storeId: turn.storeId,
        conversationId: turn.conversationId,
        id: { in: outbounds.map((o) => o.aiRunId).filter((x): x is string => !!x) },
      },
    });
    const knowledge = (await this.knowledge.list(turn.storeId, '', 'owned'))
      .filter((k) => k.status === 'enabled')
      .slice(0, 50);
    const sources = await buildLearningEvidence(this.db, {
      storeId: turn.storeId,
      conversationId: turn.conversationId,
      questions,
      context,
      answers: turn.answers
        .sort((a, b) => a.message.timestamp.getTime() - b.message.timestamp.getTime())
        .map((answer) => answer.message),
      runs,
      knowledge,
    });
    const input = {
      associationMode: turn.associationMode,
      storeId: turn.storeId, // Used by the image loader, not an evidence reference.
      ...sources.input,
      instructions:
        '只使用实际来源；问答回显与 AI 自评不算独立佐证。conversation_context 的 questions 只是本轮候选买家消息，不代表人工逐条回答了它们；结合 context 和实际 answers 自行判断对应关系。连续文字和图片可能共同组成一条回答。关系不确定或没有买家问题时不提取问答，返回 uncertain 与空建议。图片无法理解时返回不确定。所有建议等待人工审批并只写入当前店铺。通用问答仅供参考，不得修订或停用通用问答；如本店有不同规则，应提出本店 create_qa 建议。evidenceIds 只从 evidenceCatalog 选择 E1、E2 这样的 ref，不引用其他 ID；targetEntryId 只用于指定修改的知识条目。platformFacts 是查询当时的平台资料。商品资料形成建议须限定商品 productIds，不能把价格、库存、订单备注等一次性信息沉淀成永久通用答案。replyEvidence 只是回复时所用的依据列表，不是独立事实；unavailableEvidenceCount 大于零表示有原始依据未保存或无法核验，不得推断其内容。',
    };
    const run = await this.db.aiRun.create({
      data: {
        jobId,
        traceVersion: 1,
        storeId: turn.storeId,
        conversationId: turn.conversationId,
        role: 'learning',
        path: 'agent',
        input: json({
          turnId: turn.id,
          question: questions.map((q) => q.text || '[图片]').join('\n'),
          sourceRevision: turn.sourceRevision,
          evaluatorVersion,
          modelId,
          maxOutputTokens: model.maxTokens,
          associationMode: turn.associationMode,
          questionMessageIds: questions.map((q) => q.id),
          answerMessageIds: turn.answers.map((a) => a.messageId),
          contextMessageIds: sources.input.context.map((m) => m.id),
        }),
        output: {},
        evidence: json(sources.diagnostics),
        usage: {},
      },
    });
    const trace = new RunTrace(this.db, run.id, () => this.onChanged());
    try {
      const evaluated = await trace.span(
        {
          kind: 'agent',
          name: '内置问答学习',
          input: sources.input,
          metadata: { model: model.model },
        },
        () =>
          this.ai.evaluate(
            input,
            modelId,
            signal,
            async (usage) => {
              await this.db.aiRun.updateMany({
                where: { id: run.id, status: 'running' },
                data: { usage: json(usage) },
              });
            },
            trace,
          ),
      );
      const resolved = resolveLearningEvidence(evaluated.result, sources.diagnostics.catalog);
      // Preserve the model's actual parsed result and citations even when provenance,
      // source freshness or candidate validation rejects it. No second model request.
      await this.db.aiRun.update({
        where: { id: run.id },
        data: {
          output: json(evaluated.result),
          usage: json(evaluated.usage),
          evidence: json({
            ...sources.diagnostics,
            returnedEvidenceIds: evaluated.result.evidenceIds,
            invalidEvidenceIds: resolved.invalidIds,
          }),
        },
      });
      await this.lock.run(() =>
        this.db.$transaction(async (tx) => {
          const currentPolicy = await tx.learningPolicy.findUniqueOrThrow({
            where: { storeId: turn.storeId },
          });
          const currentStore = await tx.store.findUniqueOrThrow({ where: { id: turn.storeId } });
          const current = await tx.answeredTurn.findUniqueOrThrow({ where: { id: turn.id } });
          const currentModel = await tx.modelProfile.findUniqueOrThrow({ where: { id: modelId } });
          assert(hash(currentModel) === hash(model), 'STALE:学习模型已变化');
          assert(
            currentPolicy.autoLearnEnabled &&
              currentPolicy.enableEpoch === policy.enableEpoch &&
              currentStore.learningConfigEpoch === store.learningConfigEpoch &&
              current.sourceRevision === turn.sourceRevision &&
              current.status === 'answered',
            'STALE:学习开关、配置或来源已变化',
          );
          assert(
            !resolved.invalidIds.length,
            `学习引用了本轮证据清单以外的 ID：${resolved.invalidIds
              .slice(0, 5)
              .map((id) => id.slice(0, 100))
              .join('、')}。未生成候选，本次不自动重试；详情见 evidence.invalidEvidenceIds。`,
            'LEARNING_OUTPUT_INVALID',
          );
          const evaluation = await tx.learningEvaluation.upsert({
            where: {
              storeId_turnId_sourceRevision_evaluatorVersion: {
                storeId: turn.storeId,
                turnId: turn.id,
                sourceRevision: turn.sourceRevision,
                evaluatorVersion,
              },
            },
            create: {
              storeId: turn.storeId,
              turnId: turn.id,
              sourceRevision: turn.sourceRevision,
              evaluatorVersion,
              aiRunId: run.id,
              inputSnapshot: json(input),
              result: json(resolved.result),
              status: 'completed',
            },
            update: { result: json(resolved.result), status: 'completed' },
          });
          for (const [actionIndex, s] of resolved.result.suggestions.entries()) {
            const qa = qaSchema.parse(s.qa);
            let target = null;
            if (s.targetEntryId) {
              target = await tx.knowledgeEntry.findUnique({ where: { id: s.targetEntryId } });
              assert(
                target?.storeId === turn.storeId && target.status !== 'deleted',
                '学习目标跨店铺、已删除或不存在',
                'LEARNING_OUTPUT_INVALID',
              );
            }
            if (s.action !== 'create_qa')
              assert(target, '修订建议缺少目标知识', 'LEARNING_OUTPUT_INVALID');
            // An answer edit must not silently remove a shop's explicit business override.
            if (target?.activeRevisionId && !qa.scope.overridesEntryId) {
              const previous = await tx.knowledgeRevision.findUnique({
                where: { id: target.activeRevisionId },
              });
              const targetId = (previous?.scope as { overridesEntryId?: string } | null)
                ?.overridesEntryId;
              if (targetId) qa.scope.overridesEntryId = targetId;
            }
            await this.knowledge.validate(tx, turn.storeId, qa);
            if (
              s.action === 'create_qa' &&
              knowledge.some((k) =>
                k.revisions.some((r) => r.intent === qa.intent && sameKnowledgeAnswer(r, qa)),
              )
            )
              continue;
            await tx.knowledgeCandidate.upsert({
              where: { evaluationId_actionIndex: { evaluationId: evaluation.id, actionIndex } },
              create: {
                storeId: turn.storeId,
                evaluationId: evaluation.id,
                actionIndex,
                contentHash: hash(qa),
                content: json(qa),
                action: s.action,
                targetEntryId: target?.id,
                expectedActiveRevisionId: target?.activeRevisionId,
                sourceRevision: turn.sourceRevision,
              },
              update: {},
            });
          }
          await tx.aiRun.update({
            where: { id: run.id },
            data: {
              status: 'succeeded',
              output: json(resolved.result),
              usage: json(evaluated.usage),
              finishedAt: new Date(),
            },
          });
        }),
      );
    } catch (e) {
      await this.db.aiRun.update({
        where: { id: run.id },
        data: {
          status: errorText(e).startsWith('STALE:') ? 'superseded' : 'failed',
          error: errorText(e),
          finishedAt: new Date(),
        },
      });
      if (errorText(e).startsWith('STALE:')) {
        const p = await this.db.learningPolicy.findUniqueOrThrow({
          where: { storeId: turn.storeId },
        });
        if (p.autoLearnEnabled)
          await this.db.job.upsert({
            where: { dedupKey: `learn-replan:${turn.id}:${turn.sourceRevision}:${p.version}` },
            create: {
              kind: 'learn',
              storeId: turn.storeId,
              priority: 60,
              dedupKey: `learn-replan:${turn.id}:${turn.sourceRevision}:${p.version}`,
              payload: json(payload),
            },
            update: {},
          });
      }
      throw e;
    } finally {
      await trace.finishPending();
    }
  }
}
