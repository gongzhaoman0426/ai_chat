import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export { PrismaClient };
export type { Prisma };
export type Tx = Prisma.TransactionClient;
export const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v ?? {}));
export async function openDatabase(dataDir: string) {
  await mkdir(join(dataDir, 'db'), { recursive: true });
  const url = pathToFileURL(join(dataDir, 'db', 'judesk.db')).href;
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await db.$executeRawUnsafe('PRAGMA foreign_keys = ON');
  await db.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
  await db.$executeRawUnsafe('PRAGMA synchronous = FULL');
  return db;
}
