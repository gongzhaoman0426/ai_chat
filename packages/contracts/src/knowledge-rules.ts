import type { QaInput } from './index';

// Labels are deliberately conservative: different meanings must not be merged by fuzzy text.
export const knowledgeIntentKey = (intent: string) =>
  intent
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s/gu, '')
    .replace(/[?？!！。]+$/u, '');
export const sameKnowledgeIntent = (a: string, b: string) =>
  !!knowledgeIntentKey(a) && knowledgeIntentKey(a) === knowledgeIntentKey(b);
export const conditionalKnowledge = (qa: QaInput) =>
  qa.scope.productIds.length > 0 || !!qa.scope.conditions.trim();
type KnowledgeAnswer = {
  answerKind: string;
  answer: string;
  attachmentId?: string | null;
  answerBefore?: string;
  answerAfter?: string;
};
export const sameKnowledgeAnswer = (a: KnowledgeAnswer, b: KnowledgeAnswer) =>
  a.answerKind === b.answerKind &&
  (a.answerKind === 'image'
    ? a.attachmentId === b.attachmentId &&
      (a.answerBefore ?? '').trim() === (b.answerBefore ?? '').trim() &&
      (a.answerAfter ?? '').trim() === (b.answerAfter ?? '').trim()
    : a.answer.trim() === b.answer.trim());
