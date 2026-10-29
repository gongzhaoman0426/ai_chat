import { getAutoReplyReadiness, type PddConnectionState } from '../../contracts/src/index';
import type { Engine } from './engine';
import { errorText } from './util';

// A read-only view of the same local prerequisites used by ingest/reply. Never calls a model.
export async function receptionState(engine: Engine, storeId?: string) {
  const { db } = engine;
  const stores = await db.store.findMany({
    where: { id: storeId },
    include: { accounts: true, replyPolicy: true },
    orderBy: { createdAt: 'asc' },
  });
  const connections = new Map(
    (await db.appSetting.findMany({ where: { key: { startsWith: 'platform.connection:' } } })).map(
      (row) => [row.key.slice('platform.connection:'.length), row.value],
    ),
  );
  return {
    checkedAt: new Date(),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    },
    scheduler: engine.schedulerState,
    stores: await Promise.all(
      stores.map(async (store) => {
        let agent: {
          ready: boolean;
          reason: string;
          name?: string;
          revisionId?: string;
          revision?: number;
          bindingScope?: string;
          model?: string;
        } = { ready: false, reason: '没有绑定工作回复 Agent；未命中问答时无法启动 AI。' };
        try {
          const resolved = await engine.agents.resolve(store.id);
          if (resolved) {
            agent = {
              ready: !!resolved.config.modelSnapshot,
              reason: resolved.config.modelSnapshot
                ? '工作 Agent 的已发布配置和本地资源检查通过。'
                : '工作 Agent 尚未配置模型，请配置模型后发布并绑定。',
              name: resolved.config.name,
              revisionId: resolved.revision.id,
              revision: resolved.revision.revision,
              bindingScope: resolved.binding.scopeKey,
              model:
                typeof resolved.config.modelSnapshot?.model === 'string'
                  ? resolved.config.modelSnapshot.model
                  : undefined,
            };
          }
        } catch (error) {
          agent = { ready: false, reason: `工作 Agent 配置不可用：${errorText(error)}` };
        }
        const [latestBuyerMessage, opened, awaiting, pendingSends, pendingJobs, events] =
          await Promise.all([
            db.message.findFirst({
              where: {
                storeId: store.id,
                direction: 'in',
                kind: { not: 'system' },
                withdrawn: false,
              },
              orderBy: { receivedAt: 'desc' },
              select: { id: true, conversationId: true, timestamp: true, receivedAt: true },
            }),
            db.conversation.count({ where: { storeId: store.id, openedByHuman: true } }),
            db.conversation.count({ where: { storeId: store.id, awaitingHuman: true } }),
            db.outboundMessage.count({
              where: {
                storeId: store.id,
                origin: 'human',
                status: { in: ['prepared', 'dispatching'] },
              },
            }),
            db.job.count({
              where: {
                storeId: store.id,
                kind: 'reply',
                status: { in: ['pending', 'running', 'retry_wait'] },
              },
            }),
            db.auditEvent.findMany({
              where: { scope: store.id, type: 'reply.eligibility' },
              orderBy: { createdAt: 'desc' },
              take: 100,
            }),
          ]);
        return {
          id: store.id,
          name: store.name,
          platform: store.platform,
          autoReplyEnabled: !!store.replyPolicy?.autoReplyEnabled,
          readiness: getAutoReplyReadiness(store.accounts),
          agent,
          accounts: store.accounts.map((account) => {
            const state = connections.get(account.id) as unknown as
              | (PddConnectionState & { updatedAt?: string })
              | undefined;
            return {
              id: account.id,
              name: account.name,
              status: account.status,
              capabilities: account.capabilities,
              verifiedAt: account.verifiedAt,
              lastSeenAt: account.lastSeenAt,
              readiness: getAutoReplyReadiness([account]),
              connection: state
                ? {
                    phase: state.phase,
                    reason: state.reason,
                    updatedAt: state.updatedAt,
                    // Only transport counters/booleans; never copy a URL, cookie or token.
                    diagnostics: Object.fromEntries(
                      Object.entries(state.diagnostics ?? {}).filter(
                        ([, value]) => typeof value === 'boolean' || typeof value === 'number',
                      ),
                    ),
                  }
                : null,
            };
          }),
          latestBuyerMessage,
          conversations: {
            openedByHuman: opened,
            awaitingHuman: awaiting,
            pendingHumanSends: pendingSends,
          },
          pendingReplies: pendingJobs,
          decisions: events.map((event) => ({
            id: event.id,
            createdAt: event.createdAt,
            ...(event.details as {
              eligible: boolean;
              code: string;
              reason: string;
              accountId: string;
              conversationId: string;
              messageId: string;
              groupId: string;
              groupRevision: number;
            }),
          })),
        };
      }),
    ),
  };
}
export type ReceptionState = Awaited<ReturnType<typeof receptionState>>;
