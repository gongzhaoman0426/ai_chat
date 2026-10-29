import { it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

it('去除策略入口的升级保留 Agent 选择和历史快照，仅使受影响范围的旧回复失效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'judesk-binding-migration-'));
  const db = createClient({ url: pathToFileURL(join(dir, 'old.db')).href });
  const migration = '202609080001_agent_workflows_only';
  const folder = resolve('packages/database/prisma/migrations');
  try {
    for (const name of (await readdir(folder)).sort()) {
      if (name.startsWith('20') && name < migration)
        await db.executeMultiple(await readFile(join(folder, name, 'migration.sql'), 'utf8'));
    }
    const snapshot = JSON.stringify({
      entryWorkflowRef: 'local/old@1.0.0#reply',
      config: { workflowIds: ['builtin/reply-helpers@1.0.0'] },
    });
    await db.batch(
      [
        ...['inherited', 'own-agent', 'own-legacy'].map((id) => ({
          sql: 'INSERT INTO Store (id,externalId,name,replyConfigEpoch) VALUES (?,?,?,?)',
          args: [id, id, id, 8],
        })),
        {
          sql: 'INSERT INTO AgentBinding VALUES (?,?,?,?)',
          args: ['global', 'agent-v3', 'local/old@1.0.0#reply', 4],
        },
        {
          sql: 'INSERT INTO AgentBinding VALUES (?,?,?,?)',
          args: ['store:own-agent', 'agent-v7', null, 2],
        },
        {
          sql: 'INSERT INTO AgentBinding VALUES (?,?,?,?)',
          args: ['store:own-legacy', 'agent-v2', 'missing@1.0.0#reply', 6],
        },
        {
          sql: 'INSERT INTO RunConfigSnapshot (id,storeId,role,configEpoch,config,configHash) VALUES (?,?,?,?,?,?)',
          args: ['history', 'inherited', 'reply', 8, snapshot, 'original-hash'],
        },
      ],
      'write',
    );
    await db.executeMultiple(await readFile(join(folder, migration, 'migration.sql'), 'utf8'));
    const bindings = (await db.execute('SELECT * FROM AgentBinding ORDER BY scopeKey')).rows;
    expect(bindings).toEqual([
      { scopeKey: 'global', agentRevisionId: 'agent-v3', revision: 5 },
      { scopeKey: 'store:own-agent', agentRevisionId: 'agent-v7', revision: 2 },
      { scopeKey: 'store:own-legacy', agentRevisionId: 'agent-v2', revision: 7 },
    ]);
    expect((await db.execute('SELECT id,replyConfigEpoch FROM Store ORDER BY id')).rows).toEqual([
      { id: 'inherited', replyConfigEpoch: 9 },
      { id: 'own-agent', replyConfigEpoch: 8 },
      { id: 'own-legacy', replyConfigEpoch: 9 },
    ]);
    expect((await db.execute('SELECT config,configHash FROM RunConfigSnapshot')).rows).toEqual([
      { config: snapshot, configHash: 'original-hash' },
    ]);
    expect((await db.execute('PRAGMA integrity_check')).rows[0]?.integrity_check).toBe('ok');
    expect(
      (await db.execute('PRAGMA table_info(AgentBinding)')).rows.map((row) => row.name),
    ).not.toContain('entryWorkflowRef');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
