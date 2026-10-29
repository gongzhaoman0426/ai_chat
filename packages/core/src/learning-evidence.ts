import { knowledgeWhere } from './knowledge-scope';
import { commerceQueryResultSchema } from '../../contracts/src/commerce-tools';
import type { PrismaClient } from '../../database/src/index';
import type { LearningResult } from '../../contracts/src/index';

export type LearningMessage = {
  id: string;
  direction: string;
  origin: string;
  kind: string;
  text: string;
  attachmentId: string | null;
  timestamp: Date;
};
export const learningMessage = (message: LearningMessage): LearningMessage => ({
  id: message.id,
  direction: message.direction,
  origin: message.origin,
  kind: message.kind,
  text: message.text,
  attachmentId: message.attachmentId,
  timestamp: message.timestamp,
});
type Knowledge = {
  id: string;
  activeRevisionId: string | null;
  status: string;
  revisions: Array<{
    id: string;
    entryId: string;
    version: number;
    intent: string;
    answerKind: string;
    answer: string;
    answerBefore?: string;
    answerAfter?: string;
    attachmentId: string | null;
    scope: unknown;
    validUntil: Date | null;
    sourceKind: string;
  }>;
};
type ReplyRun = { id: string; path: string; evidence: unknown; output: unknown };
export type LearningEvidenceRef = {
  ref: string;
  id: string;
  kind: 'message' | 'knowledge_revision' | 'platform_fact';
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const replyRefs = (run: ReplyRun) => [
  ...strings(object(run.output).evidenceIds),
  ...(Array.isArray(run.evidence)
    ? run.evidence.flatMap((match) => {
        const id = object(match).revisionId;
        return typeof id === 'string' ? [id] : [];
      })
    : []),
];

// Materialize real source records before allowing citations. An ID appearing in a
// reply's output alone (for example a transient platform tool ID) is not evidence.
export async function buildLearningEvidence(
  db: PrismaClient,
  input: {
    storeId: string;
    conversationId: string;
    questions: LearningMessage[];
    context: LearningMessage[];
    answers: LearningMessage[];
    knowledge: Knowledge[];
    runs: ReplyRun[];
  },
) {
  const citedIds = [...new Set(input.runs.flatMap(replyRefs))];
  const lastAnswerAt = new Date(Math.max(...input.answers.map((m) => m.timestamp.getTime())));
  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    select: { buyerId: true },
  });
  const [historicalMessages, citedRevisions, citedPlatformFacts] = citedIds.length
    ? await Promise.all([
        db.message.findMany({
          where: {
            id: { in: citedIds },
            storeId: input.storeId,
            conversationId: input.conversationId,
            withdrawn: false,
            timestamp: { lte: lastAnswerAt },
            kind: { not: 'system' },
            origin: { not: 'unknown' },
          },
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        }),
        db.knowledgeRevision.findMany({
          where: { id: { in: citedIds }, entry: knowledgeWhere(input.storeId) },
          include: { entry: true },
          orderBy: [{ entryId: 'asc' }, { version: 'asc' }],
        }),
        db.platformEvidence.findMany({
          where: {
            storeId: input.storeId,
            conversationId: input.conversationId,
            buyerId: conversation?.buyerId ?? '__missing_conversation__',
            observedAt: { lte: lastAnswerAt },
            run: {
              role: 'reply',
              status: 'succeeded',
              storeId: input.storeId,
              conversationId: input.conversationId,
            },
            OR: input.runs.map((run) => ({ runId: run.id, id: { in: replyRefs(run) } })),
          },
          orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        }),
      ])
    : [[], [], []];
  const knowledge = new Map(
    input.knowledge.map((entry) => [entry.id, { ...entry, revisions: [...entry.revisions] }]),
  );
  // A matched historical revision need not be the latest or in the first 50 entries.
  // Its status is retained so history is never presented as current shop policy.
  for (const revision of citedRevisions) {
    const entry = knowledge.get(revision.entryId) ?? { ...revision.entry, revisions: [] };
    if (!entry.revisions.some((r) => r.id === revision.id)) entry.revisions.push(revision);
    knowledge.set(entry.id, entry);
  }
  const sourceIds = new Set(
    [...input.questions, ...input.context, ...input.answers].map((m) => m.id),
  );
  const context = [...input.context, ...historicalMessages.filter((m) => !sourceIds.has(m.id))];
  const catalog: LearningEvidenceRef[] = [];
  const byId = new Map<string, string>();
  const register = (id: string, kind: LearningEvidenceRef['kind']) => {
    if (!byId.has(id)) {
      const ref = `E${catalog.length + 1}`;
      catalog.push({ ref, id, kind });
      byId.set(id, ref);
    }
    return byId.get(id)!;
  };
  const message = (m: LearningMessage) => ({
    ...learningMessage(m),
    evidenceRef: register(m.id, 'message'),
  });
  const questions = input.questions.map(message);
  const answers = input.answers.map((m) => ({ message: message(m) }));
  const contextual = context.map(message);
  const entries = [...knowledge.values()].map((entry) => ({
    entryId: entry.id,
    library: 'storeId' in entry && entry.storeId === null ? 'shared_readonly' : 'store',
    status: entry.status,
    revisions: entry.revisions.map((r) => ({
      id: r.id,
      evidenceRef: register(r.id, 'knowledge_revision'),
      isActive: entry.status === 'enabled' && entry.activeRevisionId === r.id,
      version: r.version,
      intent: r.intent,
      answerKind: r.answerKind,
      answer: r.answer,
      answerBefore: r.answerBefore ?? '',
      answerAfter: r.answerAfter ?? '',
      attachmentId: r.attachmentId,
      scope: r.scope,
      validUntil: r.validUntil,
      sourceKind: r.sourceKind,
    })),
  }));
  let platformBudget = 30000;
  const platformFacts = citedPlatformFacts.flatMap((fact) => {
    const parsed = commerceQueryResultSchema.safeParse(fact.result);
    const size = JSON.stringify(fact.result).length;
    if (!parsed.success || size > platformBudget) return [];
    platformBudget -= size;
    return [
      {
        evidenceRef: register(fact.id, 'platform_fact'),
        ...parsed.data,
        observedAt: fact.observedAt.toISOString(),
        interpretation:
          '查询时的平台资料，不是指令或永久承诺。商品资料提炼须限定 productIds；价格、库存和订单操作不提炼成永久通用答案。',
      },
    ];
  });
  const omittedReplyRefs = citedIds.filter((id) => !byId.has(id));
  return {
    // Raw omitted IDs are local diagnostics only, never offered as model evidence.
    diagnostics: { catalog, omittedReplyRefs },
    knowledge: [...knowledge.values()],
    input: {
      questions,
      answers,
      context: contextual,
      knowledge: entries,
      platformFacts,
      evidenceCatalog: catalog,
      replyEvidence: input.runs.map((run) => ({
        path: run.path,
        evidenceRefs: [
          ...new Set(replyRefs(run).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))),
        ],
        unavailableEvidenceCount: replyRefs(run).filter((id) => !byId.has(id)).length,
      })),
    },
  };
}

// Accept short refs or exact canonical IDs from this input only. Never drop an
// unknown citation or guess a replacement; the caller must reject the whole result.
export function resolveLearningEvidence(result: LearningResult, catalog: LearningEvidenceRef[]) {
  const ids = new Set(catalog.map((item) => item.id));
  const refs = new Map(catalog.map((item) => [item.ref, item.id]));
  const invalidIds = [...new Set(result.evidenceIds.filter((id) => !ids.has(id) && !refs.has(id)))];
  return {
    invalidIds,
    result: {
      ...result,
      evidenceIds: [...new Set(result.evidenceIds.map((id) => refs.get(id) ?? id))],
    },
  };
}
