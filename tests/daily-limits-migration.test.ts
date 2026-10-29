import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

it('移除旧每日限额，保留店铺策略、任务状态和历史运行记录', async () => {
  const db = createClient({ url: ':memory:' });
  try {
    const root = 'packages/database/prisma/migrations';
    const migration = '202609100003_remove_daily_call_limits';
    const names = (await readdir(root)).filter((n) => n.startsWith('20')).sort();
    for (const name of names.filter((n) => n < migration))
      await db.executeMultiple(await readFile(join(root, name, 'migration.sql'), 'utf8'));
    await db.execute(
      "INSERT INTO Store(id,platform,externalId,name) VALUES ('store','goofish','100','测试店铺')",
    );
    await db.execute(
      "INSERT INTO ReplyPolicy(storeId,autoReplyEnabled,directMatchThreshold,maxCallsPerDay,version) VALUES ('store',1,0.95,1,4)",
    );
    await db.execute(
      "INSERT INTO LearningPolicy(storeId,autoLearnEnabled,builtinModelRef,maxCallsPerDay,version,enableEpoch) VALUES ('store',1,'model',2,7,3)",
    );
    await db.execute(
      "INSERT INTO AiRun(id,storeId,role,path,status,input,output,evidence,usage,error) VALUES ('old-run','store','reply','preflight','failed','{}','{}','[]','{}','今日调用预算已用完')",
    );
    await db.execute(
      "INSERT INTO Job(id,kind,storeId,dedupKey,status,payload,updatedAt) VALUES ('old-job','reply','store','old-job','failed','{}',CURRENT_TIMESTAMP)",
    );
    const { maxCallsPerDay: replyLimit, ...reply } = (await db.execute('SELECT * FROM ReplyPolicy'))
      .rows[0];
    const { maxCallsPerDay: learningLimit, ...learning } = (
      await db.execute('SELECT * FROM LearningPolicy')
    ).rows[0];
    expect([replyLimit, learningLimit]).toEqual([1, 2]);
    const runs = (await db.execute('SELECT * FROM AiRun')).rows;
    const jobs = (await db.execute('SELECT * FROM Job')).rows;
    for (const name of names.filter((n) => n >= migration))
      await db.executeMultiple(await readFile(join(root, name, 'migration.sql'), 'utf8'));
    expect((await db.execute('SELECT * FROM ReplyPolicy')).rows).toEqual([reply]);
    expect((await db.execute('SELECT * FROM LearningPolicy')).rows).toEqual([learning]);
    expect((await db.execute('SELECT * FROM AiRun')).rows).toEqual(runs);
    expect((await db.execute('SELECT * FROM Job')).rows).toEqual(jobs);
    expect((await db.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    expect((await db.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe('ok');
  } finally {
    db.close();
  }
});
