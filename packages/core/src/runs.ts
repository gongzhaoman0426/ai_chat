import type { PrismaClient, Prisma } from '../../database/src';
import { assert } from './util';
import { traceValue } from './run-trace';

function summary(run: any, conversation: any, outbounds: any[], storeName?: string | null) {
  const modelSteps = run.steps.filter((s: any) => s.kind === 'model');
  const usage = modelSteps.length
    ? modelSteps.reduce(
        (total: any, step: any) => {
          const usage = step.metadata?.usage ?? {};
          for (const key of ['inputTokens', 'outputTokens', 'totalTokens'])
            total[key] += Number(usage[key]) || 0;
          return total;
        },
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      )
    : run.usage;
  const { steps, ...base } = run;
  return {
    ...base,
    input: traceValue(run.input),
    output: traceValue(run.output),
    usage: traceValue(usage),
    agentName:
      steps.find((s: any) => s.kind === 'agent')?.name ??
      (run.role === 'learning'
        ? '内置问答学习'
        : run.path === 'direct_match'
          ? '问答直答'
          : 'Agent 回复'),
    question:
      typeof run.input?.question === 'string'
        ? run.input.question
        : run.role === 'learning'
          ? '从已完成的对话学习'
          : '查看本次执行',
    buyerName: conversation?.buyerName ?? null,
    storeName: storeName ?? null,
    modelCalls: run.traceVersion === 0 ? null : modelSteps.length,
    toolCalls:
      run.traceVersion === 0
        ? null
        : steps.filter((s: any) => ['tool', 'skill', 'workflow'].includes(s.kind)).length,
    stepCount: steps.length,
    outbounds: outbounds
      .filter((o) => o.aiRunId === run.id)
      .map((o) => ({ ...o, body: traceValue(o.body) })),
  };
}
export async function runHistory(
  db: PrismaClient,
  input: {
    storeId?: string;
    role?: 'reply' | 'learning';
    status?: 'running' | 'succeeded' | 'failed';
    cursor?: string;
    limit?: number;
  },
) {
  const where: Prisma.AiRunWhereInput = {
    ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.status
      ? {
          status:
            input.status === 'failed'
              ? { in: ['failed', 'superseded', 'cancelled'] }
              : input.status,
        }
      : {}),
  };
  if (input.cursor)
    assert(
      await db.aiRun.findFirst({ where: { ...where, id: input.cursor }, select: { id: true } }),
      '运行列表已变化，请刷新后重试',
    );
  const limit = input.limit ?? 30;
  const found = await db.aiRun.findMany({
    where,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      storeId: true,
      conversationId: true,
      role: true,
      path: true,
      status: true,
      traceVersion: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      input: true,
      output: true,
      usage: true,
      steps: { select: { kind: true, name: true, metadata: true }, orderBy: { sequence: 'asc' } },
    },
  });
  const rows = found.slice(0, limit);
  const storeIds = [...new Set(rows.map((r) => r.storeId))];
  const conversationIds = rows.flatMap((r) => (r.conversationId ? [r.conversationId] : []));
  const [conversations, outbounds, storeRows] = await Promise.all([
    conversationIds.length
      ? db.conversation.findMany({
          where: {
            ...(input.storeId ? { storeId: input.storeId } : { storeId: { in: storeIds } }),
            id: { in: conversationIds },
          },
          select: { id: true, buyerName: true },
        })
      : Promise.resolve([]),
    db.outboundMessage.findMany({
      where: {
        ...(input.storeId ? { storeId: input.storeId } : { storeId: { in: storeIds } }),
        aiRunId: { in: rows.map((r) => r.id) },
      },
      orderBy: { createdAt: 'asc' },
    }),
    storeIds.length
      ? db.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  return {
    runs: rows.map((r) =>
      summary(
        r,
        conversations.find((c) => c.id === r.conversationId),
        outbounds,
        storeRows.find((s) => s.id === r.storeId)?.name,
      ),
    ),
    nextCursor: found.length > limit ? rows.at(-1)!.id : null,
  };
}
export async function runDetail(db: PrismaClient, storeId: string, id: string) {
  const run = await db.aiRun.findFirst({
    where: { id, storeId },
    include: { steps: { orderBy: { sequence: 'asc' } } },
  });
  assert(run, '本店没有这条 Agent 执行记录', 'RUN_NOT_FOUND');
  const [conversation, outbounds, store] = await Promise.all([
    db.conversation.findFirst({
      where: { storeId, id: run.conversationId ?? '' },
      select: { id: true, buyerName: true },
    }),
    db.outboundMessage.findMany({
      where: { storeId, aiRunId: run.id },
      orderBy: { createdAt: 'asc' },
    }),
    db.store.findFirst({ where: { id: run.storeId }, select: { name: true } }),
  ]);
  return {
    ...summary(run, conversation, outbounds, store?.name),
    evidence: traceValue(run.evidence),
    steps: run.steps.map((s) => ({
      ...s,
      input: traceValue(s.input),
      output: traceValue(s.output),
      metadata: traceValue(s.metadata),
    })),
  };
}
