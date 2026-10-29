import { afterEach, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const migrationRoot = resolve('packages/database/prisma/migrations');
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Keep every native SQLite handle out of the test runner as well. libsql close() can retain
// prepared statements until GC; a surviving handle is enough to block Prisma's exclusive lock.
const fixtureScript = `
import { createClient } from '@libsql/client';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { dataDir, mode } = JSON.parse(process.argv[1]);
const business = createClient({ url: pathToFileURL(join(dataDir, 'db', 'judesk.db')).href });
const memory = createClient({ url: pathToFileURL(join(dataDir, 'db', 'mastra.db')).href });
try {
  if (mode === 'seed') {
    await business.execute('PRAGMA journal_mode = WAL');
    await business.execute({ sql: 'INSERT INTO AppSetting (key, value) VALUES (?, ?)', args: ['upgrade-preserved', JSON.stringify({ text: '保留原有配置' })] });
    await memory.execute('PRAGMA journal_mode = WAL');
    await memory.execute('CREATE TABLE existing_memory (value TEXT NOT NULL)');
    await memory.execute({ sql: 'INSERT INTO existing_memory (value) VALUES (?)', args: ['保留问答数据'] });
  } else {
    console.log(JSON.stringify({
      setting: (await business.execute("SELECT value FROM AppSetting WHERE key = 'upgrade-preserved'")).rows[0].value,
      memory: (await memory.execute('SELECT value FROM existing_memory')).rows[0].value,
      migrations: (await business.execute('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows.map(row => row.migration_name),
      integrity: (await business.execute('PRAGMA integrity_check')).rows[0].integrity_check,
    }));
  }
} finally {
  business.close();
  memory.close();
}
process.exit(0);
`;

async function fixture(dataDir: string, mode: 'seed' | 'read') {
  return exec(
    process.execPath,
    ['--input-type=module', '--eval', fixtureScript, JSON.stringify({ dataDir, mode })],
    { cwd: resolve('.'), timeout: 10000 },
  );
}

async function deploy(dataDir: string, migrationsDir: string) {
  const config = join(dataDir, 'migration.config.ts');
  await writeFile(
    config,
    `export default ${JSON.stringify({
      schema: resolve('packages/database/prisma/schema.prisma'),
      migrations: { path: migrationsDir },
      datasource: { url: `file:${join(dataDir, 'db', 'judesk.db').replaceAll('\\', '/')}` },
    })};\n`,
  );
  return exec(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--config', config],
    { cwd: resolve('.'), timeout: 15000 },
  );
}

it('升级快照子进程退出后真实 Prisma 迁移不再被 WAL 连接阻塞，重复启动和再次升级保留数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'judesk-prepare-'));
  temporaryDirs.push(root);
  const dataDir = join(root, '旧版数据 with spaces');
  await mkdir(join(dataDir, 'db'), { recursive: true });
  await writeFile(join(dataDir, 'db', 'judesk.db'), '');
  const migrationNames = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const oldMigrations = join(root, 'old-migrations');
  await mkdir(oldMigrations);
  await cp(join(migrationRoot, 'migration_lock.toml'), join(oldMigrations, 'migration_lock.toml'));
  for (const name of migrationNames.slice(0, -1)) {
    await cp(join(migrationRoot, name), join(oldMigrations, name), { recursive: true });
  }
  await deploy(dataDir, oldMigrations);
  await fixture(dataDir, 'seed');

  const versions = ['0.1.9', '0.1.9', '0.1.10'];
  for (const [index, appVersion] of versions.entries()) {
    const prepareEntry = process.env.JUDESK_DATABASE_PREPARE_ENTRY;
    await exec(
      process.execPath,
      [
        ...(prepareEntry
          ? [resolve(prepareEntry)]
          : ['--import', 'tsx', resolve('apps/desktop/src/main/database-prepare.ts')]),
        JSON.stringify({ dataDir, appVersion, migrationsDir: migrationRoot }),
      ],
      { cwd: resolve('.'), timeout: 15000 },
    );
    const migration = await deploy(dataDir, migrationRoot);
    expect(migration.stdout).toMatch(/successfully applied|No pending migrations/);
    const statePath = join(dataDir, 'backups', 'upgrade-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.appVersion).toBe(appVersion);
    const archive = new AdmZip(join(dataDir, state.file.replaceAll('\\', '/')));
    expect(archive.getEntry('db/judesk.db')).not.toBeNull();
    expect(archive.getEntry('db/mastra.db')).not.toBeNull();
    expect(JSON.parse(archive.readAsText('backup.json'))).toMatchObject({
      kind: 'upgrade',
      appVersion,
    });
    expect((await readdir(join(dataDir, 'backups', 'upgrades'))).length).toBe(index === 2 ? 2 : 1);
    const result = JSON.parse((await fixture(dataDir, 'read')).stdout);
    expect(JSON.parse(result.setting)).toEqual({ text: '保留原有配置' });
    expect(result.memory).toBe('保留问答数据');
    expect(result.migrations).toEqual(migrationNames);
    expect(result.integrity).toBe('ok');

    if (index === 0) {
      // 0.1.7 wrote Windows separators but did not recognize that path on the next launch.
      // Keep the old format on other hosts too, to cover reuse by the fixed application.
      const legacyState = { ...state, file: state.file.replaceAll('/', '\\') };
      const legacyBytes = Buffer.from(JSON.stringify(legacyState, null, 2));
      await writeFile(statePath, legacyBytes);
      if (process.platform === 'win32') {
        const dbDir = join(dataDir, 'db');
        const artifacts = (await readdir(dbDir)).sort();
        const before = await Promise.all(artifacts.map((name) => readFile(join(dbDir, name))));
        const repair = await exec(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            resolve('scripts/repair-windows-upgrade-state.ps1'),
            '-DataDirectory',
            dataDir,
          ],
          {
            timeout: 15000,
            // Actions starts Node through PowerShell 7, but powershell.exe is Windows
            // PowerShell 5.1. Let it rebuild its own module path instead of inheriting
            // incompatible PS7 modules (which can hide commands such as Get-FileHash).
            env: Object.fromEntries(
              Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
            ),
          },
        );
        expect(repair.stdout).toContain('Repaired the upgrade-state path');
        const repairedBytes = await readFile(statePath);
        expect(repairedBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
        expect(JSON.parse(repairedBytes.toString('utf8'))).toEqual(state);
        const metadataBackups = (await readdir(join(dataDir, 'backups'))).filter((name) =>
          /^upgrade-state\.json\.before-path-repair-[0-9a-f]+\.bak$/.test(name),
        );
        expect(metadataBackups).toHaveLength(1);
        expect(await readFile(join(dataDir, 'backups', metadataBackups[0]))).toEqual(legacyBytes);
        expect((await readdir(dbDir)).sort()).toEqual(artifacts);
        const after = await Promise.all(artifacts.map((name) => readFile(join(dbDir, name))));
        expect(after).toEqual(before);
      }
    }
  }
}, 60000);
