// null is an explicitly shared library/attachment; undefined must never grant access.
export const knowledgeWhere = (storeId: string | null) =>
  storeId === null ? { storeId: null } : { OR: [{ storeId }, { storeId: null }] };
export const knowledgeAllowed = (owner: string | null | undefined, storeId: string) =>
  owner === null || owner === storeId;
export const SHARED_KNOWLEDGE_VECTOR_SCOPE = '__shared_knowledge__';
