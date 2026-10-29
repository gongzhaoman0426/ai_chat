import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture({ valid = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'judesk-release-'));
  const name = 'judesk-0.1.0-mac-arm64.zip';
  const content = Buffer.from('offline release fixture');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), content);
  const sha512 = createHash('sha512').update(content).digest('base64');
  await writeFile(
    join(directory, 'latest-mac.yml'),
    `version: 0.1.0\nfiles:\n  - url: ${name}\n    sha512: ${valid ? sha512 : 'not-the-file'}\n    size: ${content.length}\npath: ${name}\n`,
  );
  return directory;
}

function env(directory) {
  return {
    ...process.env,
    RELEASE_PHASE: 'validate',
    RELEASE_PLATFORM: 'darwin',
    RELEASE_ARCH: 'arm64',
    RELEASE_VERSION: '0.1.0',
    RELEASE_DIST: directory,
  };
}

test('release validation checks relative manifest URLs, sha512, and size offline', async () => {
  const directory = await fixture();
  const result = await exec('node', ['scripts/publish-release.mjs', '--validate-only'], {
    cwd: root,
    env: env(directory),
  });
  assert.match(result.stdout, /离线发布校验通过/);
});

test('release validation rejects a stale or tampered manifest without R2 access', async () => {
  const directory = await fixture({ valid: false });
  await assert.rejects(
    exec('node', ['scripts/publish-release.mjs', '--validate-only'], {
      cwd: root,
      env: env(directory),
    }),
    /校验失败/,
  );
});
