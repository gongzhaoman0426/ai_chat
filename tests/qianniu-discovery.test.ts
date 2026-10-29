import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import {
  discoverQianniuExecutable,
  validatePatchedQianniuExecutable,
} from '../apps/desktop/src/main/qianniu-discovery';

const roots: string[] = [];
const url = 'http://127.0.0.1:3000/qianniu-inject';
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'judesk-qianniu-discovery-'));
  roots.push(directory);
  return directory;
}
async function install(directory: string, scriptUrl = url, entry = 'nested/webui/recent.html') {
  const resources = join(directory, 'Resources', 'newWebui');
  await mkdir(resources, { recursive: true });
  const executable = join(directory, 'AliWorkbench.exe');
  await writeFile(executable, 'test executable');
  const archive = new AdmZip();
  archive.addFile(entry, Buffer.from(`<html><script src="${scriptUrl}"></script></html>`));
  await writeFile(join(resources, 'webui.zip'), archive.toBuffer());
  return executable;
}

describe('automatic preprocessed Qianniu discovery', () => {
  it('finds a registered or running preprocessed executable without a picker', async () => {
    const directory = await root();
    const executable = await install(directory);
    const list = vi.fn(async () => [executable]);
    await expect(
      discoverQianniuExecutable({ platform: 'win32', env: {}, listRegisteredCandidates: list }),
    ).resolves.toBe(executable);
    expect(list).toHaveBeenCalledOnce();
  });

  it('rejects stock resources, another URL, and a URL mentioned outside recent.html', async () => {
    const directory = await root();
    const stock = await install(join(directory, 'stock'), 'https://iseiya.taobao.com/imsupport');
    const wrong = await install(join(directory, 'wrong'), 'http://localhost:3000/qianniu-inject');
    const unrelated = await install(join(directory, 'unrelated'), url, 'readme.html');
    for (const executable of [stock, wrong, unrelated])
      await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(false);
    await expect(
      discoverQianniuExecutable({
        platform: 'win32',
        env: {},
        listRegisteredCandidates: async () => [stock, wrong, unrelated],
      }),
    ).resolves.toBeUndefined();
  });

  it('supports registered install locations with bounded version folders and updater icon paths', async () => {
    const directory = await root();
    await install(join(directory, '9.51.00N'), 'https://iseiya.taobao.com/imsupport');
    const executable = await install(join(directory, '9.52.00N'));
    await expect(
      discoverQianniuExecutable({
        platform: 'win32',
        env: {},
        listRegisteredCandidates: async () => [`"${join(directory, 'AliUpdater.exe')}",0`],
      }),
    ).resolves.toBe(executable);
    await expect(
      discoverQianniuExecutable({
        platform: 'win32',
        env: {},
        listRegisteredCandidates: async () => [directory],
      }),
    ).resolves.toBe(executable);
  });

  it('falls back to known install folders when registry lookup fails', async () => {
    const directory = await root();
    const executable = await install(join(directory, 'Alibaba', 'QianNiu'));
    await expect(
      discoverQianniuExecutable({
        platform: 'win32',
        env: { LOCALAPPDATA: directory },
        listRegisteredCandidates: async () => {
          throw new Error('registry unavailable');
        },
      }),
    ).resolves.toBe(executable);
  });

  it('accepts a shallow launcher whose patched webui.zip lives under a version folder', async () => {
    const directory = await root();
    const executable = join(directory, 'AliWorkbench.exe');
    await writeFile(executable, 'launcher');
    const resources = join(directory, '9.52.00N', 'Resources', 'newWebui');
    await mkdir(resources, { recursive: true });
    const archive = new AdmZip();
    archive.addFile(
      'web_chat-packer/recent.html',
      Buffer.from(`<html><script src="${url}"></script></html>`),
    );
    await writeFile(join(resources, 'webui.zip'), archive.toBuffer());
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(true);
    await expect(
      discoverQianniuExecutable({
        platform: 'win32',
        env: {},
        listRegisteredCandidates: async () => [directory],
      }),
    ).resolves.toBe(executable);
  });

  it('does not let a version-folder patch override a stock archive beside the EXE', async () => {
    const directory = await root();
    const executable = await install(directory, 'https://iseiya.taobao.com/imsupport');
    const resources = join(directory, '9.52.00N', 'Resources', 'newWebui');
    await mkdir(resources, { recursive: true });
    const archive = new AdmZip();
    archive.addFile('recent.html', Buffer.from(`<html><script src="${url}"></script></html>`));
    await writeFile(join(resources, 'webui.zip'), archive.toBuffer());
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(false);
  });

  it('supports unpacked resources but never overrides a stock archive with a loose patched file', async () => {
    const directory = await root();
    const executable = await install(directory, 'https://iseiya.taobao.com/imsupport');
    const resources = join(directory, 'Resources', 'newWebui');
    await writeFile(join(resources, 'recent.html'), `var source = '${url}';`);
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(false);
    await rm(join(resources, 'webui.zip'));
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(true);
  });

  it('revalidates saved executables after a vendor update replaces the patch', async () => {
    const directory = await root();
    const executable = await install(directory);
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(true);
    await install(directory, 'https://iseiya.taobao.com/imsupport');
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(false);
    await expect(validatePatchedQianniuExecutable(join(directory, 'missing.exe'))).resolves.toBe(
      false,
    );
  });

  it('does not search disks recursively or touch Windows discovery on other systems', async () => {
    const directory = await root();
    await install(join(directory, 'arbitrary', 'deep', 'client'));
    const list = vi.fn(async () => [directory]);
    await expect(
      discoverQianniuExecutable({ platform: 'darwin', env: {}, listRegisteredCandidates: list }),
    ).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    await expect(
      discoverQianniuExecutable({ platform: 'win32', env: {}, listRegisteredCandidates: list }),
    ).resolves.toBeUndefined();
  });

  it('expands registry environment variables and rejects corrupt archives', async () => {
    const directory = await root();
    const executable = await install(join(directory, 'QianNiu'));
    await expect(
      discoverQianniuExecutable({
        platform: 'win32',
        env: { TEST_QIANNIU_HOME: directory },
        listRegisteredCandidates: async () => ['%TEST_QIANNIU_HOME%/QianNiu'],
      }),
    ).resolves.toBe(executable);
    await writeFile(
      join(directory, 'QianNiu', 'Resources', 'newWebui', 'webui.zip'),
      'invalid archive',
    );
    await expect(validatePatchedQianniuExecutable(executable)).resolves.toBe(false);
  });
});
