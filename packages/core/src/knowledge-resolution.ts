import type { Tx } from '../../database/src';
import { qaSchema } from '../../contracts/src';
import {
  conditionalKnowledge,
  knowledgeIntentKey,
  sameKnowledgeAnswer,
  sameKnowledgeIntent,
} from '../../contracts/src/knowledge-rules';
import { knowledgeWhere } from './knowledge-scope';
import type { KnowledgeMatch } from './types';

export function knowledgeSupersedes(local: KnowledgeMatch, other: KnowledgeMatch, storeId: string) {
  return (
    local.storeId === storeId &&
    other.storeId === null &&
    (local.qa.scope.overridesEntryId === other.entryId ||
      sameKnowledgeIntent(local.intent, other.intent))
  );
}

// Expand related rules from SQLite, even if the vector top-K missed a shop override.
// No extra embedding, model call or indexing round trip is required.
export async function resolveKnowledgeMatches(db: Tx, storeId: string, hits: KnowledgeMatch[]) {
  if (!hits.length) return [];
  const entries = await db.knowledgeEntry.findMany({
    where: { ...knowledgeWhere(storeId), status: 'enabled' },
    include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const live: KnowledgeMatch[] = [];
  for (const entry of entries) {
    const r = entry.revisions[0];
    if (!r || r.id !== entry.activeRevisionId || (r.validUntil && r.validUntil <= new Date()))
      continue;
    if (r.sourceKind === 'learning') {
      if (
        !r.approvalId ||
        (await db.knowledgeReview.findUnique({ where: { id: r.approvalId } }))?.decision !==
          'approved'
      )
        continue;
      const sources = await db.knowledgeSource.findMany({
        where: { revisionId: r.id, turnId: { not: null } },
      });
      let valid = true;
      for (const source of sources) {
        const turn = await db.answeredTurn.findUnique({ where: { id: source.turnId! } });
        if (!turn || turn.status === 'invalidated') valid = false;
      }
      if (!valid) continue;
    }
    const parsed = qaSchema.safeParse({
      intent: r.intent,
      answerKind: r.answerKind,
      answer: r.answer,
      answerBefore: r.answerBefore,
      answerAfter: r.answerAfter,
      attachmentId: r.attachmentId ?? undefined,
      scope: r.scope,
      validUntil: r.validUntil?.toISOString() ?? null,
    });
    if (!parsed.success) continue;
    live.push({
      storeId: entry.storeId,
      entryId: entry.id,
      revisionId: r.id,
      intent: r.intent,
      qa: parsed.data,
      score: 0,
    });
  }
  const seeds = hits.flatMap((hit) => {
    const current = live.find((m) => m.revisionId === hit.revisionId);
    return current ? [{ ...current, score: hit.score }] : [];
  });
  // Join exact intents and explicit override links in linear passes, rather than
  // comparing every entry pair. Related product rules may be outside vector top-K.
  const parents = new Map(live.map((m) => [m.entryId, m.entryId]));
  const root = (id: string): string => {
    const parent = parents.get(id)!;
    if (parent === id) return id;
    const resolved = root(parent);
    parents.set(id, resolved);
    return resolved;
  };
  const join = (a: string, b: string) => {
    parents.set(root(a), root(b));
  };
  const intents = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const m of live) {
    const intent = knowledgeIntentKey(m.intent);
    if (intent) {
      const previous = intents.get(intent);
      if (previous) join(m.entryId, previous);
      else intents.set(intent, m.entryId);
    }
    const target = m.storeId === storeId ? m.qa.scope.overridesEntryId : undefined;
    if (target) {
      if (parents.has(target)) join(m.entryId, target);
      const sibling = overrides.get(target);
      if (sibling) join(m.entryId, sibling);
      else overrides.set(target, m.entryId);
    }
  }
  const scores = new Map<string, number>();
  for (const seed of seeds)
    scores.set(
      root(seed.entryId),
      Math.max(scores.get(root(seed.entryId)) ?? -Infinity, seed.score),
    );
  const matches = live
    .filter((m) => scores.has(root(m.entryId)))
    .map((m) => ({ ...m, score: scores.get(root(m.entryId))! }));
  return matches
    .filter(
      (m) =>
        !matches.some(
          (local) => knowledgeSupersedes(local, m, storeId) && !conditionalKnowledge(local.qa),
        ),
    )
    .sort(
      (a, b) => b.score - a.score || Number(b.storeId === storeId) - Number(a.storeId === storeId),
    );
}

export function decideKnowledgeReply(matches: KnowledgeMatch[], threshold: number) {
  const first = matches[0];
  if (!first || first.score <= threshold) return { reason: '未达到直接回复条件' };
  // Close retrieval results are not a business override. A single existing reply Agent resolves them.
  const relevant = matches.filter((m) => m.score >= first.score - 0.04);
  if (relevant.some((m) => conditionalKnowledge(m.qa)))
    return { reason: '存在商品或条件规则，需要 Agent 核对适用性' };
  if (relevant.some((m) => !sameKnowledgeAnswer(m.qa, first.qa)))
    return { reason: '多条相近问答答案不同，需要 Agent 核对，暂停直接回复' };
  return { direct: first, reason: first.storeId === null ? '采用通用问答' : '采用本店优先问答' };
}
