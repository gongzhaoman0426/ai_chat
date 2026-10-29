import {
  knowledgeAssistModelSchema,
  knowledgeAssistResultSchema,
  qaSchema,
  type KnowledgeAssistResult,
  type QaInput,
} from '../../contracts/src/index';
import { listStoreGoods } from './store-goods';
import { assert, uid } from './util';
import type { Engine } from './engine';

export type KnowledgeAssistEntry = {
  id: string;
  storeId: string | null;
  status: string;
  activeRevisionId: string | null;
  intent: string;
  answerKind: string;
  answer: string;
  answerBefore?: string;
  answerAfter?: string;
  attachmentId: string | null;
  productIds: string[];
  conditions: string;
};

const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '';

export function catalogEntries(
  rows: Array<{
    id: string;
    storeId: string | null;
    status: string;
    activeRevisionId: string | null;
    revisions: Array<{
      intent: string;
      answerKind: string;
      answer: string;
      answerBefore?: string;
      answerAfter?: string;
      attachmentId?: string | null;
      scope: unknown;
    }>;
  }>,
): KnowledgeAssistEntry[] {
  return rows.slice(0, 60).map((row) => {
    const rev = row.revisions[0];
    const scope =
      rev?.scope && typeof rev.scope === 'object' ? (rev.scope as Record<string, unknown>) : {};
    return {
      id: row.id,
      storeId: row.storeId,
      status: row.status,
      activeRevisionId: row.activeRevisionId,
      intent: text(rev?.intent, 200),
      answerKind: rev?.answerKind === 'image' ? 'image' : 'text',
      answer: text(rev?.answer, 240),
      answerBefore: typeof rev?.answerBefore === 'string' ? rev.answerBefore : '',
      answerAfter: typeof rev?.answerAfter === 'string' ? rev.answerAfter : '',
      attachmentId: typeof rev?.attachmentId === 'string' ? rev.attachmentId : null,
      productIds: Array.isArray(scope.productIds)
        ? scope.productIds.filter((id): id is string => typeof id === 'string').slice(0, 20)
        : [],
      conditions: text(scope.conditions, 200),
    };
  });
}

function qaDetail(qa: QaInput) {
  return (
    qa.answerKind === 'image'
      ? [qa.answerBefore, '[图片]', qa.answerAfter].filter(Boolean).join(' → ')
      : qa.answer
  ).slice(0, 180);
}

function scopeLabel(storeId: string | null) {
  return storeId === null ? '通用' : '本店';
}

export function resolveAssistTargetStore(
  requested: string | null | undefined,
  entryStoreId: string | null,
  chatStoreId: string | null,
) {
  if (requested === undefined || requested === entryStoreId) return entryStoreId;
  if (requested === null) return null;
  if (chatStoreId && requested === chatStoreId) return chatStoreId;
  return entryStoreId;
}

function sanitizeQa(
  qa: QaInput,
  storeId: string | null,
  allowedProducts: Set<string>,
  allowedAttachments: Set<string>,
): QaInput | null {
  const image =
    qa.answerKind === 'image' && !!qa.attachmentId && allowedAttachments.has(qa.attachmentId);
  const parsed = qaSchema.safeParse({
    ...qa,
    answerKind: image ? 'image' : 'text',
    attachmentId: image ? qa.attachmentId : undefined,
    scope: {
      ...qa.scope,
      productIds:
        storeId === null
          ? []
          : qa.scope.productIds.filter((id) => allowedProducts.has(id)).slice(0, 20),
    },
  });
  return parsed.success ? parsed.data : null;
}

export function resolveKnowledgeAssist(
  raw: unknown,
  catalog: KnowledgeAssistEntry[],
  storeId: string | null,
  allowedProducts: Set<string>,
  allowedAttachments: Set<string> = new Set(),
): KnowledgeAssistResult {
  const model = knowledgeAssistModelSchema.parse(raw);
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const proposals: KnowledgeAssistResult['proposals'] = [];
  for (const item of model.proposals) {
    if (item.action === 'create') {
      const qa = sanitizeQa(item.qa, storeId, allowedProducts, allowedAttachments);
      if (!qa) continue;
      proposals.push({
        key: uid(),
        action: 'create',
        storeId,
        title: qa.intent.slice(0, 80),
        detail: qaDetail(qa),
        qa,
      });
      continue;
    }
    const entry = byId.get(item.entryId);
    if (!entry?.activeRevisionId) continue;
    if (item.action === 'update') {
      const targetStoreId = resolveAssistTargetStore(item.storeId, entry.storeId, storeId);
      const allowed = new Set(allowedAttachments);
      if (entry.attachmentId && targetStoreId === entry.storeId) allowed.add(entry.attachmentId);
      const proposedQa =
        item.qa.answerKind === 'image' && entry.answerKind === 'image'
          ? {
              ...item.qa,
              answerBefore: item.qa.answerBefore ?? entry.answerBefore,
              answerAfter: item.qa.answerAfter ?? entry.answerAfter,
            }
          : item.qa;
      const qa = sanitizeQa(proposedQa, targetStoreId, allowedProducts, allowed);
      if (!qa) continue;
      const moved = targetStoreId !== entry.storeId;
      proposals.push({
        key: uid(),
        action: 'update',
        entryId: entry.id,
        expectedRevisionId: entry.activeRevisionId,
        expectedStoreId: entry.storeId,
        storeId: targetStoreId,
        title: qa.intent.slice(0, 80),
        detail: moved
          ? `范围：${scopeLabel(entry.storeId)} → ${scopeLabel(targetStoreId)}；${qaDetail(qa)}`
          : `原：${entry.intent} → ${qaDetail(qa)}`,
        qa,
      });
      continue;
    }
    const labels = { enable: '启用', disable: '停用', delete: '删除' } as const;
    proposals.push({
      key: uid(),
      action: item.action,
      entryId: entry.id,
      expectedRevisionId: entry.activeRevisionId,
      storeId: entry.storeId,
      title: entry.intent.slice(0, 80) || '未命名问答',
      detail: `${labels[item.action]}「${entry.intent.slice(0, 60)}」`,
    });
  }
  return knowledgeAssistResultSchema.parse({
    reply: model.reply,
    proposals: proposals.slice(0, 8),
  });
}

export async function resolveAssistModel(engine: Engine, storeId: string | null) {
  const ids: string[] = [];
  if (storeId) {
    const binding =
      (await engine.db.agentBinding.findUnique({ where: { scopeKey: `store:${storeId}` } })) ??
      (await engine.db.agentBinding.findUnique({ where: { scopeKey: 'global' } }));
    if (binding) {
      const revision = await engine.db.agentRevision.findUnique({
        where: { id: binding.agentRevisionId },
      });
      const modelId = (revision?.configSnapshot as { modelProfileId?: string } | undefined)
        ?.modelProfileId;
      if (modelId) ids.push(modelId);
    }
  }
  const fallback = await engine.db.appSetting.findUnique({ where: { key: 'defaultModelId' } });
  if (typeof fallback?.value === 'string') ids.push(fallback.value);
  for (const id of ids) {
    const model = await engine.db.modelProfile.findUnique({ where: { id } });
    if (model?.kind === 'chat') return model;
  }
  throw new Error('请先在系统设置中配置对话模型，才能用自然语言管理问答');
}

export function assistProposalEntryIds(raw: unknown) {
  const model = knowledgeAssistModelSchema.parse(raw);
  return [...new Set(model.proposals.flatMap((item) => ('entryId' in item ? [item.entryId] : [])))];
}

export async function loadAssistEntries(engine: Engine, storeId: string | null, ids: string[]) {
  const unique = [...new Set(ids)].filter(Boolean).slice(0, 8);
  if (!unique.length) return [];
  const rows = await engine.db.knowledgeEntry.findMany({
    where: { id: { in: unique }, status: { in: ['enabled', 'disabled'] } },
    include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  return catalogEntries(
    rows.filter((row) => storeId === null || row.storeId === null || row.storeId === storeId),
  );
}

export async function loadAssistAttachments(engine: Engine, storeId: string | null, ids: string[]) {
  const rows: Array<{ id: string; name: string }> = [];
  for (const id of [...new Set(ids)].slice(0, 8)) {
    const attachment = await engine.db.attachment.findUnique({ where: { id } });
    assert(attachment, '图片不存在或已删除');
    if (storeId === null) assert(attachment.storeId === null, '通用问答只能使用通用图片');
    else
      assert(
        attachment.storeId === storeId || attachment.storeId === null,
        '图片不属于当前店铺或通用图片',
      );
    rows.push({ id: attachment.id, name: attachment.name || '图片' });
  }
  return rows;
}

export async function loadKnowledgeAssistContext(
  engine: Engine,
  storeId: string | null,
  scope: 'available' | 'owned' | 'all' = storeId ? 'available' : 'owned',
  attachmentIds: string[] = [],
) {
  if (storeId) {
    const store = await engine.db.store.findFirst({
      where: { id: storeId, accounts: { some: {} } },
    });
    assert(store, '店铺不存在或已移除');
  }
  const rows = await engine.knowledge.list(storeId, '', scope);
  const catalog = catalogEntries(rows);
  const products = storeId
    ? (
        await listStoreGoods(engine, { storeId, page: 1, pageSize: 30 }).catch(() => ({
          products: [],
        }))
      ).products
    : [];
  return {
    storeId,
    catalog,
    products,
    attachments: await loadAssistAttachments(engine, storeId, attachmentIds),
    model: await resolveAssistModel(engine, storeId),
  };
}
