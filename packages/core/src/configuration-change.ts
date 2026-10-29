import type { Tx } from '../../database/src';
import { json } from '../../database/src';

// Publishing new business rules must not repeatedly regenerate an already-running reply.
// Leave those unanswered conversations visible for the human; pending jobs can read the new rules.
export async function cancelGeneratingReplies(tx: Tx, storeIds: string[] | null, reason: string) {
  const jobs = await tx.job.findMany({
    where: {
      kind: 'reply',
      status: 'running',
      ...(storeIds ? { storeId: { in: storeIds } } : {}),
    },
  });
  for (const job of jobs) {
    const groupId = (job.payload as { groupId?: string }).groupId;
    if (!job.conversationId || !groupId) continue;
    const outbound = await tx.outboundMessage.findFirst({
      where: {
        questionGroupId: groupId,
        origin: { in: ['ai', 'qa_direct', 'handoff_notice'] },
        status: { in: ['dispatching', 'unknown', 'confirmed'] },
      },
    });
    if (outbound) continue; // Platform-submitted messages keep their original receipt lifecycle.
    const changed = await tx.messageGroup.updateMany({
      where: { id: groupId, autoEligible: true, state: 'waiting_answer' },
      data: { autoEligible: false },
    });
    if (!changed.count) continue;
    await tx.job.update({ where: { id: job.id }, data: { status: 'cancelled', error: reason } });
    await tx.outboundMessage.updateMany({
      where: { questionGroupId: groupId, status: 'prepared', origin: { not: 'human' } },
      data: { status: 'cancelled', error: reason },
    });
    await tx.conversation.updateMany({
      where: { id: job.conversationId, openedByHuman: false, awaitingHuman: false },
      data: {
        awaitingHuman: true,
        handoffReason: reason,
        humanSentAfterHandoff: false,
        revision: { increment: 1 },
      },
    });
    await tx.auditEvent.create({
      data: {
        type: 'conversation.handoff',
        scope: job.storeId ?? 'global',
        actor: 'system',
        details: json({
          conversationId: job.conversationId,
          reason,
          source: 'configuration_change',
        }),
      },
    });
  }
}
