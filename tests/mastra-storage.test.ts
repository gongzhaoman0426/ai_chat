import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { mastraFileUrl } from '../packages/ai/src/libsql-url';

it.each([
  String.raw`C:\Users\Administrator\AppData\Roaming\judesk\judesk-data\db\mastra.db`,
  String.raw`D:\句达 数据 #100%\db\mastra.db`,
  String.raw`d:\用户\带%23的目录\sandbox\mastra.db`,
])('Windows 数据库地址保留盘符和编码：%s', (filePath) => {
  const url = mastraFileUrl(filePath, true);
  expect(url).toMatch(/^file:[a-z]:\//i);
  expect(fileURLToPath(url, { windows: true })).toBe(filePath);
  // This is the decoded path Mastra passes to realpath, not a WHATWG URL pathname.
  expect(win32.normalize(decodeURIComponent(url.slice(5)))).toBe(filePath);
});

it.each(['/tmp/句达 数据 #100%/db/mastra.db', '/tmp/带%23的目录/sandbox/mastra.db'])(
  'macOS/Linux 数据库地址保持标准文件 URL：%s',
  (filePath) => {
    const url = mastraFileUrl(filePath, false);
    expect(url).toBe(pathToFileURL(filePath, { windows: false }).href);
    expect(fileURLToPath(url, { windows: false })).toBe(filePath);
  },
);

it('真实 Mastra 在含中文、空格和 URL 特殊字符的目录创建、重启进程后检索并释放数据库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'judesk-mastra-'));
  const dir = join(root, '句达 数据 #100%');
  await mkdir(join(dir, 'db'), { recursive: true });
  let failure: unknown;
  try {
    for (const phase of ['write', 'read']) {
      // Wait for each process to exit before reopening or removing the database.
      // A close() in the Vitest process does not guarantee native statements were GC'd.
      await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./fixtures/mastra-storage.ts', import.meta.url)),
          dir,
          phase,
        ],
        { timeout: 20000 },
      );
    }
    // Windows still has to allow renaming and deleting the files after process exit.
    await rename(dir, join(root, 'closed'));
  } catch (error) {
    failure = error;
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Mastra storage test and cleanup both failed')
        : error;
    }
  }
  if (failure) throw failure;
}, 60000);
