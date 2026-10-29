import { json, type Tx } from '../../database/src/index';

export const HUMAN_LEARNING_SETTLE_MS = 2500;
const CONTEXT_LIMIT = 40;
const CONTEXT_AGE_MS = 24 * 60 * 60 * 1000;
const CONTINUATION_MS = 5 * 60 * 1000;

// These are candidate questions plus observed context, not a claim that every question
// was answered. The existing learning agent determines the actual semantic relationship.
export async function humanLearningContext(
  tx: Tx,
  message: {
    id: string;
    storeId: string;
    conversationId: string;
    timestamp: Date;
    receivedAt: Date;
  },
  outboundId?: string,
) {
  const outbound = outboundId
    ? await tx.outboundMessage.findUniqueOrThrow({ where: { id: outboundId } })
    : null;
  // Freeze local context at the sending intent. A late receipt must not adopt buyer
  // questions which arrived while the platform was confirming the earlier answer.
  const receivedBefore = outbound?.createdAt ?? message.receivedAt;
  const timestampBefore = outbound?.createdAt ?? message.timestamp;
  // A preceding locally queued reply may be confirmed after this intent was
  // created. It is now a real Message and may continue the same human answer,
  // but unconfirmed sends and later buyer questions must never enter the context.
  const precedingSends = outbound
    ? await tx.outboundMessage.findMany({
        where: {
          conversationId: message.conversationId,
          origin: 'human',
          status: 'confirmed',
          id: { not: outbound.id },
          externalId: { not: null },
          createdAt: {
            lte: receivedBefore,
            gte: new Date(timestampBefore.getTime() - CONTEXT_AGE_MS),
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CONTEXT_LIMIT,
      })
    : [];
  const intentTimes = new Map(precedingSends.map((o) => [o.externalId!, o.createdAt.getTime()]));
  const observed = (
    await tx.message.findMany({
      where: {
        conversationId: message.conversationId,
        id: { not: message.id },
        withdrawn: false,
        kind: { in: ['text', 'image'] },
        OR: [
          {
            receivedAt: { lte: receivedBefore },
            timestamp: {
              lte: timestampBefore,
              gte: new Date(timestampBefore.getTime() - CONTEXT_AGE_MS),
            },
          },
          ...(precedingSends.length
            ? [
                {
                  externalId: { in: precedingSends.map((o) => o.externalId!) },
                  direction: 'out',
                  origin: 'human',
                },
              ]
            : []),
        ],
      },
      orderBy: [{ timestamp: 'desc' }, { receivedAt: 'desc' }, { id: 'desc' }],
      take: CONTEXT_LIMIT,
    })
  ).sort(
    (a, b) =>
      (intentTimes.get(a.externalId) ?? a.timestamp.getTime()) -
        (intentTimes.get(b.externalId) ?? b.timestamp.getTime()) ||
      a.receivedAt.getTime() - b.receivedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const context = observed.filter((m) => !['unknown', 'handoff_notice'].includes(m.origin));
  const lastBuyerIndex = context.findLastIndex((m) => m.direction === 'in' && m.origin === 'buyer');
  const beforeBuyer = context.slice(0, lastBuyerIndex + 1);
  const precedingAnswer = beforeBuyer.findLastIndex((m) => m.direction === 'out');
  const questions = beforeBuyer
    .slice(precedingAnswer + 1)
    .filter((m) => m.direction === 'in' && m.origin === 'buyer');
  const previous = observed.at(-1);
  const priorAnswer =
    previous?.origin === 'human' && previous.direction === 'out'
      ? await tx.turnAnswer.findFirst({
          where: { messageId: previous.id },
          include: { turn: { include: { questionGroup: true } } },
        })
      : null;
  const prior = priorAnswer?.turn;
  const sameQuestions =
    prior &&
    (!questions.length ||
      JSON.stringify(prior.questionGroup.messageIds) ===
        JSON.stringify(questions.map((q) => q.id)));
  if (
    prior?.associationMode === 'conversation_context' &&
    prior.status === 'answered' &&
    sameQuestions &&
    previous &&
    message.timestamp >= previous.timestamp &&
    message.timestamp.getTime() - previous.timestamp.getTime() <= CONTINUATION_MS
  ) {
    const policy = await tx.learningPolicy.findUniqueOrThrow({
      where: { storeId: message.storeId },
    });
    const previousEvent = await tx.businessEvent.findFirst({
      where: { aggregateId: prior.id, sourceRevision: prior.sourceRevision },
      orderBy: { sequence: 'desc' },
    });
    // Do not turn replies from a disabled/previous capture period into new learning answers.
    if (
      previousEvent &&
      previousEvent.learningCaptureEpoch === (policy.autoLearnEnabled ? policy.enableEpoch : null)
    ) {
      return {
        group: prior.questionGroup,
        contextMessageIds: [
          ...new Set([
            ...(prior.questionGroup.messageIds as string[]),
            ...context.map((m) => m.id),
          ]),
        ],
      };
    }
  }

  if (!questions.length) return null;
  const group = await tx.messageGroup.create({
    data: {
      conversationId: message.conversationId,
      messageIds: json(questions.map((q) => q.id)),
      autoEligible: false,
      state: 'answered',
      sealedAt: message.timestamp,
    },
  });
  return { group, contextMessageIds: context.map((m) => m.id) };
}
