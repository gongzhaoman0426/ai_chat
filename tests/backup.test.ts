import { it, expect, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup } from './helpers';
import { Router } from '../packages/core/src/router';
import { MastraAi } from '../packages/ai/src/index';
import {
  validateBackup,
  applyPendingRestore,
  createUpgradeSnapshot,
} from '../packages/core/src/backup';
import { openDatabase } from '../packages/database/src/index';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
afterEach(async () => {
  await ai?.close();
  await f?.cleanup();
  ai = undefined;
  f = undefined;
});
it('备份包含一致数据库与附件，恢复后关闭自动回复并保留知识', async () => {
  f = await setup();
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.knowledge.save({
    storeId: f.account.storeId,
    qa: {
      intent: '退换货说明',
      answerKind: 'text',
      answer: '联系客服处理',
      scope: { productIds: [], conditions: '' },
    },
  });
  const file = join(f.dir, 'export.zip');
  f.host.saveFile = async () => file;
  const router = new Router(f.engine, ai);
  await router.call('backup.create');
  await f.engine.stop();
  const manifest = await validateBackup(file);
  expect(manifest.manifest.files.some((r: any) => r.name === 'db/judesk.db')).toBe(true);
  const before = await f.db.knowledgeEntry.count();
  await ai.close();
  ai = undefined;
  await f.db.$disconnect();
  const destination = join(f.dir, 'restored');
  await mkdir(destination);
  await writeFile(join(destination, 'restore.pending.zip'), await readFile(file));
  await applyPendingRestore(destination);
  const restored = await openDatabase(destination);
  try {
    expect(await restored.knowledgeEntry.count()).toBe(before);
    expect((await restored.replyPolicy.findFirst())?.autoReplyEnabled).toBe(false);
    expect(await restored.account.count({ where: { status: 'online' } })).toBe(0);
  } finally {
    await restored.$disconnect();
  }
});
it('备份校验拒绝文件篡改和越界清单', async () => {
  f = await setup();
  const zip = new AdmZip();
  zip.addFile('db/judesk.db', Buffer.from('tampered'));
  zip.addFile(
    'backup.json',
    Buffer.from(
      JSON.stringify({
        version: 1,
        appVersion: '0.1.0',
        files: [{ name: 'db/judesk.db', hash: 'wrong' }],
      }),
    ),
  );
  const file = join(f.dir, 'bad.zip');
  await writeFile(file, zip.toBuffer());
  await expect(validateBackup(file)).rejects.toThrow('完整性');
  zip.updateFile(
    'backup.json',
    Buffer.from(
      JSON.stringify({
        version: 1,
        appVersion: '0.1.0',
        files: [{ name: 'db/../../outside', hash: 'x' }],
      }),
    ),
  );
  await writeFile(file, zip.toBuffer());
  await expect(validateBackup(file)).rejects.toThrow('路径');
});

it('升级前快照按版本和迁移指纹生成且恢复只替换数据库', async () => {
  f = await setup();
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  await mkdir(join(f.dir, 'attachments'), { recursive: true });
  await writeFile(join(f.dir, 'attachments', 'keep.txt'), 'attachment');
  await mkdir(join(f.dir, 'settings'), { recursive: true });
  await writeFile(join(f.dir, 'settings', 'secret.txt'), 'keep-secret');
  // The real startup calls this API before starting the service. Close the test service first so
  // VACUUM INTO observes an idle database exactly as an upgrade does.
  await f.engine.stop();
  await f.db.$disconnect();
  await ai.close();
  ai = undefined;

  const first = await createUpgradeSnapshot({
    dataDir: f.dir,
    appVersion: '1.4.0',
    migrationFingerprint: 'migration-a',
  });
  expect(first.created).toBe(true);
  if (!first.created) throw new Error('快照未生成');
  const again = await createUpgradeSnapshot({
    dataDir: f.dir,
    appVersion: '1.4.0',
    migrationFingerprint: 'migration-a',
  });
  expect(again).toMatchObject({ created: false, reason: 'already-current' });
  // Accept the state written by older Windows versions without creating another snapshot.
  const stateFile = join(f.dir, 'backups', 'upgrade-state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.file = state.file.replaceAll('/', '\\');
  await writeFile(stateFile, JSON.stringify(state));
  expect(
    await createUpgradeSnapshot({
      dataDir: f.dir,
      appVersion: '1.4.0',
      migrationFingerprint: 'migration-a',
    }),
  ).toMatchObject({ created: false, reason: 'already-current' });
  const next = await createUpgradeSnapshot({
    dataDir: f.dir,
    appVersion: '1.5.0',
    migrationFingerprint: 'migration-b',
  });
  expect(next.created).toBe(true);
  if (!next.created) throw new Error('第二份快照未生成');
  expect(next.file).not.toBe(first.file);
  expect(await readFile(first.file)).toEqual(expect.any(Buffer));
  await expect(validateBackup(first.file, { maxAppVersion: '1.0.0' })).rejects.toThrow('更新版本');
  expect((await validateBackup(first.file)).manifest.appVersion).toBe('1.4.0');

  const destination = join(f.dir, 'restore-check');
  await mkdir(join(destination, 'db'), { recursive: true });
  await cp(join(f.dir, 'db', 'judesk.db'), join(destination, 'db', 'judesk.db'));
  await cp(join(f.dir, 'db', 'mastra.db'), join(destination, 'db', 'mastra.db'));
  await mkdir(join(destination, 'settings'), { recursive: true });
  await writeFile(join(destination, 'settings', 'local-secret.txt'), 'must-remain');
  await mkdir(join(destination, 'attachments'), { recursive: true });
  await writeFile(join(destination, 'attachments', 'current.txt'), 'must-remain');
  await writeFile(join(destination, 'restore.pending.zip'), await readFile(first.file));
  await applyPendingRestore(destination);
  expect(await readFile(join(destination, 'settings', 'local-secret.txt'), 'utf8')).toBe(
    'must-remain',
  );
  expect(await readdir(join(destination, 'backups'))).toEqual(
    expect.arrayContaining([expect.stringMatching(/^before-restore-/)]),
  );
  expect(await readFile(join(destination, 'attachments', 'current.txt'), 'utf8')).toBe(
    'must-remain',
  );
});
