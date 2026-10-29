import type { PrismaClient, Tx } from '../../database/src';
import { assert } from '../../core/src/util';

type Db = PrismaClient | Tx;

// Legacy mounts store a revision ID. It now identifies the Agent; each new run resolves
// its current publication, while the resolved execution tree keeps the exact snapshot.
export async function currentAgentPublication(db: Db, reference: string) {
  const selected = await db.agentRevision.findUnique({
    where: { id: reference },
    select: { agentId: true },
  });
  assert(selected, '子 Agent 的发布记录不存在');
  const current = await db.agentRevision.findFirst({
    where: { agentId: selected.agentId },
    orderBy: { revision: 'desc' },
    include: { agent: true },
  });
  assert(current?.agent.status === 'active', 'Agent 已删除或尚未发布');
  return current;
}
