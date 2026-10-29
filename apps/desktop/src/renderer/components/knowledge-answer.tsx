import { Attachment } from '../pages-inbox';

export function KnowledgeAnswer({
  qa,
}: {
  qa:
    | {
        answerKind?: string;
        answer?: string;
        answerBefore?: string;
        answerAfter?: string;
        attachmentId?: string | null;
      }
    | undefined;
}) {
  if (!qa) return null;
  return qa.answerKind === 'image' ? (
    <div className="knowledge-image-answer">
      {qa.answerBefore?.trim() && <p>{qa.answerBefore}</p>}
      {qa.attachmentId && <Attachment id={qa.attachmentId} />}
      {qa.answerAfter?.trim() && <p>{qa.answerAfter}</p>}
    </div>
  ) : (
    <p>{qa.answer}</p>
  );
}
