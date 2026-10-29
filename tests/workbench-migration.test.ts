import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
it('升级保留旧 AI 操作和证据，人工记录可以没有 runId，两类记录各自关联', async () => {
  const db = createClient({ url: ':memory:' });
  try {
    const root = 'packages/database/prisma/migrations';
    const names = (await readdir(root)).filter((n) => n.startsWith('20')).sort();
    for (const name of names.filter((n) => n < '202609100001'))
      await db.executeMultiple(await readFile(join(root, name, 'migration.sql'), 'utf8'));
    await db.execute(
      "INSERT INTO AiRun(id,storeId,role,path,input,output,evidence,usage) VALUES ('run','store','reply','agent','{}','{}','[]','{}')",
    );
    await db.execute(
      "INSERT INTO PlatformEvidence(id,runId,storeId,accountId,conversationId,buyerId,operation,queryKey,input,result) VALUES ('evidence','run','store','account','conversation','buyer','buyer-orders','query','{}','{}')",
    );
    await db.execute(
      "INSERT INTO PlatformAction(id,runId,storeId,accountId,conversationId,buyerId,operation,targetId,sourceEvidenceId,dedupKey,status,input,preview,result,updatedAt) VALUES ('action','run','store','account','conversation','buyer','order-remark','order','evidence','dedup','confirmed','{}','{}','{}',CURRENT_TIMESTAMP)",
    );
    const before = (await db.execute('SELECT * FROM PlatformAction')).rows[0];
    const evidence = (await db.execute('SELECT * FROM PlatformEvidence')).rows[0];
    for (const name of names.filter((n) => n >= '202609100001'))
      await db.executeMultiple(await readFile(join(root, name, 'migration.sql'), 'utf8'));
    expect((await db.execute('SELECT * FROM PlatformAction')).rows[0]).toMatchObject(before);
    expect((await db.execute('SELECT * FROM PlatformEvidence')).rows[0]).toMatchObject(evidence);
    await db.execute(
      "INSERT INTO WorkbenchSession(id,storeId,accountId,conversationId,buyerId,routeVersion,expiresAt) VALUES ('session','store','account','conversation','buyer',1,CURRENT_TIMESTAMP)",
    );
    await db.execute(
      "INSERT INTO PlatformEvidence(id,sessionId,storeId,accountId,conversationId,buyerId,operation,queryKey,input,result) VALUES ('manual-evidence','session','store','account','conversation','buyer','buyer-orders','query','{}','{}')",
    );
    expect(
      (await db.execute("SELECT runId FROM PlatformEvidence WHERE id='manual-evidence'")).rows[0]
        .runId,
    ).toBeNull();
    expect((await db.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    expect((await db.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe('ok');
  } finally {
    db.close();
  }
});
