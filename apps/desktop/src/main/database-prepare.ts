import { applyPendingRestore, createUpgradeSnapshot } from '../../../../packages/core/src/backup';

// Run in a short-lived Node process, never in the Electron main process.
// libsql.close() can leave native statements alive until GC; those statements
// retain a SQLite connection and prevent Prisma from obtaining its migration lock.
// The parent must wait for this process to exit before starting Prisma.
try {
  const { dataDir, appVersion, migrationsDir } = JSON.parse(process.argv[2] ?? '{}');
  if (![dataDir, appVersion, migrationsDir].every((value) => typeof value === 'string' && value))
    throw new Error('数据库准备参数不完整');
  await applyPendingRestore(dataDir);
  await createUpgradeSnapshot({ dataDir, appVersion, migrationsDir });
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
