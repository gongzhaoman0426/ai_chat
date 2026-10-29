import AdmZip from 'adm-zip';
import { createClient } from '@libsql/client';
import { stat, readFile, writeFile, mkdir, rename, rm, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { hash } from './util';

const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 3 * 1024 * 1024 * 1024;
const DATABASES = ['judesk.db', 'mastra.db'] as const;
const SNAPSHOT_STATE = 'backups/upgrade-state.json';

export type BackupFileRecord = { name: string; hash: string };
export type BackupManifest = {
  /** Archive format, independent from the desktop app version. */
  version: 1;
  formatVersion?: 1;
  kind?: 'manual' | 'upgrade';
  appVersion: string;
  createdAt: string;
  files: BackupFileRecord[];
  source?: { dataDir?: string; appVersion?: string; migrationFingerprint?: string };
  target?: { path?: string; archiveHash?: string };
};
export type BackupValidationOptions = { maxAppVersion?: string };
export type UpgradeSnapshotOptions = {
  dataDir: string;
  appVersion: string;
  migrationFingerprint?: string;
  migrationsDir?: string;
};
export type UpgradeSnapshotResult =
  | { created: false; reason: 'no-database' | 'already-current'; file?: string }
  | { created: true; file: string; manifest: BackupManifest };

function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function assertManifestAppVersion(manifest: BackupManifest, options: BackupValidationOptions) {
  if (typeof manifest.appVersion !== 'string' || !manifest.appVersion.trim())
    throw new Error('备份缺少应用版本');
  if (options.maxAppVersion) {
    const comparison = compareVersions(manifest.appVersion, options.maxAppVersion);
    // Development builds may use a non-semver version. In that case archive format and SQLite
    // integrity checks still protect the restore; only comparable versions get an upper bound.
    if (comparison != null && comparison > 0) throw new Error('备份来自更新版本，当前版本不兼容');
  }
}

/**
 * Validate a backup archive. appVersion is intentionally not hard-coded: the archive format and
 * SQLite integrity are the compatibility boundary. Callers may pass maxAppVersion to prevent a
 * downgrade restore from a newer semver release.
 */
export async function validateBackup(file: string, options: BackupValidationOptions = {}) {
  const info = await stat(file);
  if (info.size > MAX_BACKUP_BYTES) throw new Error('备份文件超限');
  const zip = new AdmZip(await readFile(file));
  const meta = zip.getEntry('backup.json');
  if (!meta || meta.header.size > MAX_MANIFEST_BYTES) throw new Error('无效备份清单');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(meta.getData().toString()) as BackupManifest;
  } catch {
    throw new Error('无效备份清单');
  }
  if (
    manifest.version !== 1 ||
    (manifest.formatVersion != null && manifest.formatVersion !== 1) ||
    !Array.isArray(manifest.files)
  )
    throw new Error('备份版本不兼容');
  assertManifestAppVersion(manifest, options);
  let total = 0;
  const names = new Set<string>();
  for (const record of manifest.files) {
    const name = String(record?.name ?? '');
    if (
      !/^(db|attachments|extensions)\//.test(name) ||
      name.split(/[\\/]/).includes('..') ||
      name.includes('\\') ||
      names.has(name) ||
      typeof record?.hash !== 'string'
    )
      throw new Error('备份路径无效');
    names.add(name);
    const entry = zip.getEntry(name);
    if (!entry || entry.isDirectory) throw new Error('备份文件缺失');
    total += entry.header.size;
    if (total > MAX_UNPACKED_BYTES) throw new Error('备份解压后超限');
    if (hash(entry.getData().toString('base64')) !== record.hash)
      throw new Error('备份完整性校验失败');
  }
  if (!names.has('db/judesk.db') || !names.has('db/mastra.db')) throw new Error('备份缺少数据库');
  return { zip, manifest };
}

export async function computeMigrationFingerprint(migrationsDir: string) {
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const files = [];
  for (const name of names)
    files.push({ name, sql: await readFile(join(migrationsDir, name, 'migration.sql'), 'utf8') });
  return hash(files);
}

async function inspectDatabase(file: string): Promise<'missing' | 'empty' | 'invalid' | 'valid'> {
  const info = await stat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return 'missing';
  if (!info.isFile() || info.size === 0) return 'empty';
  if (info.size < 16) return 'invalid';
  const handle = await open(file, 'r').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return 'missing';
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    return header.toString('ascii').startsWith('SQLite format 3') ? 'valid' : 'invalid';
  } finally {
    await handle.close();
  }
}

async function writeAtomic(file: string, bytes: string | Uint8Array) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function addFolder(zip: AdmZip, records: BackupFileRecord[], root: string, folder: string) {
  const walk = async (dir: string, prefix: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const item of entries) {
      const name = `${prefix}/${item.name}`;
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full, name);
      else {
        const bytes = await readFile(full);
        zip.addFile(name, bytes);
        records.push({ name, hash: hash(bytes.toString('base64')) });
      }
    }
  };
  await walk(join(root, folder), folder);
}

/**
 * Create an immutable pre-migration snapshot. Call before creating a new SQLite database or
 * starting the business service. A fresh installation has no database and is deliberately skipped.
 * Every archive uses a unique path, so a failed retry cannot overwrite an earlier snapshot.
 */
export async function createUpgradeSnapshot(
  options: UpgradeSnapshotOptions,
): Promise<UpgradeSnapshotResult> {
  const { dataDir, appVersion } = options;
  const dbDir = join(dataDir, 'db');
  const databaseFiles = await Promise.all(
    DATABASES.map(async (name) => ({
      name,
      file: join(dbDir, name),
      status: await inspectDatabase(join(dbDir, name)),
    })),
  );
  if (databaseFiles[0].status === 'missing' || databaseFiles[0].status === 'empty')
    return { created: false, reason: 'no-database' };
  if (databaseFiles[0].status !== 'valid') throw new Error('升级前快照数据库无效，已阻止迁移');
  if (databaseFiles[1].status === 'missing' || databaseFiles[1].status === 'empty') {
    throw new Error('升级前快照缺少 mastra.db，已阻止迁移');
  }
  if (databaseFiles[1].status !== 'valid') throw new Error('升级前快照数据库无效，已阻止迁移');
  const fingerprint =
    options.migrationFingerprint ??
    (options.migrationsDir ? await computeMigrationFingerprint(options.migrationsDir) : hash([]));
  const stateFile = join(dataDir, SNAPSHOT_STATE);
  const existingState = await readFile(stateFile, 'utf8')
    .then(
      (text) =>
        JSON.parse(text) as { appVersion?: string; migrationFingerprint?: string; file?: string },
    )
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('升级快照状态损坏，已阻止迁移');
    });
  // Older Windows builds stored backslashes but compared against a POSIX prefix,
  // so they recreated the same upgrade snapshot on every launch.
  const savedFile = existingState?.file?.replaceAll('\\', '/');
  if (
    existingState?.appVersion === appVersion &&
    existingState.migrationFingerprint === fingerprint &&
    savedFile &&
    /^backups\/upgrades\/[^/]+\.zip$/.test(savedFile) &&
    (await stat(join(dataDir, savedFile)).catch(() => null))?.isFile()
  )
    return { created: false, reason: 'already-current', file: join(dataDir, savedFile) };

  const backupRoot = join(dataDir, 'backups', 'upgrades');
  await mkdir(backupRoot, { recursive: true });
  const token = `${Date.now()}-${randomUUID()}`;
  const destination = join(backupRoot, `upgrade-${token}.zip`);
  const temporaryDir = join(dataDir, 'tmp', `upgrade-${token}`);
  await mkdir(temporaryDir, { recursive: true });
  try {
    const zip = new AdmZip();
    const records: BackupFileRecord[] = [];
    for (const { name, file } of databaseFiles) {
      const connection = createClient({ url: pathToFileURL(file).href });
      const output = join(temporaryDir, name);
      try {
        // VACUUM INTO produces a consistent copy while the caller has not started the service.
        await connection.execute(`VACUUM INTO '${output.replaceAll("'", "''")}'`);
      } finally {
        connection.close();
      }
      const bytes = await readFile(output);
      zip.addFile(`db/${name}`, bytes);
      records.push({ name: `db/${name}`, hash: hash(bytes.toString('base64')) });
    }
    await addFolder(zip, records, dataDir, 'attachments');
    await addFolder(zip, records, dataDir, 'extensions');
    const manifest: BackupManifest = {
      version: 1,
      formatVersion: 1,
      kind: 'upgrade',
      appVersion,
      createdAt: new Date().toISOString(),
      source: { dataDir, appVersion, migrationFingerprint: fingerprint },
      target: { path: destination },
      files: records,
    };
    zip.addFile('backup.json', Buffer.from(JSON.stringify(manifest)));
    await writeAtomic(destination, zip.toBuffer());
    const archiveHash = createHash('sha256')
      .update(await readFile(destination))
      .digest('hex');
    manifest.target = { path: destination, archiveHash };
    await writeAtomic(
      stateFile,
      JSON.stringify(
        {
          version: 1,
          appVersion,
          migrationFingerprint: fingerprint,
          file: destination.slice(dataDir.length + 1).replaceAll('\\', '/'),
          archiveHash,
          source: { dataDir, appVersion, migrationFingerprint: fingerprint },
          target: { path: destination, archiveHash },
          createdAt: manifest.createdAt,
        },
        null,
        2,
      ),
    );
    return { created: true, file: destination, manifest };
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function applyPendingRestore(dataDir: string) {
  const pendingFile = join(dataDir, 'restore.pending.zip');
  if (!(await stat(pendingFile).catch(() => null))) return;
  const { zip, manifest } = await validateBackup(pendingFile);
  const staging = join(dataDir, 'tmp', `restore-${randomUUID()}`);
  await mkdir(join(staging, 'db'), { recursive: true });
  try {
    // Attachments/extensions are validated for integrity but deliberately not restored. They may
    // contain user settings or secret-adjacent files owned by the current installation.
    for (const record of manifest.files.filter((record) => record.name.startsWith('db/'))) {
      await writeFile(join(staging, record.name), zip.getEntry(record.name)!.getData());
    }
    for (const name of DATABASES) {
      const conn = createClient({ url: pathToFileURL(join(staging, 'db', name)).href });
      try {
        const integrity = await conn.execute('PRAGMA integrity_check');
        if (integrity.rows[0]?.integrity_check !== 'ok')
          throw new Error('备份数据库完整性校验失败');
      } finally {
        conn.close();
      }
    }
    const conn = createClient({ url: pathToFileURL(join(staging, 'db', 'judesk.db')).href });
    try {
      await conn.batch(
        [
          `UPDATE ReplyPolicy SET autoReplyEnabled=0, version=version+1`,
          `UPDATE Conversation SET openedByHuman=0, revision=revision+1`,
          `UPDATE Account SET status='offline'`,
          `UPDATE OutboundMessage SET status='unknown', error='从备份恢复，需要重新对账' WHERE status IN ('prepared','dispatching')`,
          `UPDATE Job SET status='cancelled' WHERE kind='reply' AND status != 'succeeded'`,
          `UPDATE MessageGroup SET autoEligible=0 WHERE state='waiting_answer'`,
        ],
        'write',
      );
      // The restored database is moved as a single file below. Checkpoint any WAL pages first so
      // the safety updates (offline accounts and cancelled in-flight work) are included in it.
      await conn.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      conn.close();
    }
    const previous = join(dataDir, 'backups', `before-restore-${Date.now()}-${randomUUID()}`);
    await mkdir(join(previous, 'db'), { recursive: true });
    const moved: string[] = [];
    try {
      await mkdir(join(dataDir, 'db'), { recursive: true });
      const databaseArtifacts = DATABASES.flatMap((name) => [name, `${name}-wal`, `${name}-shm`]);
      for (const artifact of databaseArtifacts) {
        const current = join(dataDir, 'db', artifact);
        if (await stat(current).catch(() => null)) {
          await rename(current, join(previous, 'db', artifact));
          moved.push(artifact);
        }
      }
      for (const name of DATABASES)
        await rename(join(staging, 'db', name), join(dataDir, 'db', name));
      await rm(pendingFile, { force: true });
    } catch (error) {
      for (const name of DATABASES) await rm(join(dataDir, 'db', name), { force: true });
      for (const artifact of moved)
        await rename(join(previous, 'db', artifact), join(dataDir, 'db', artifact)).catch(
          () => undefined,
        );
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
