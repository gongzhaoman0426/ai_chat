const { cp, mkdir, rm, writeFile, access } = require('node:fs/promises');
const { dirname, join, relative, resolve } = require('node:path');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function extractTarball(url, dest) {
  const tmp = resolve('.packaging/download.tmp.tgz');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${url}: ${res.status}`);
  await mkdir(dirname(tmp), { recursive: true });
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  // On Windows, the tar shipped with the runner treats the colon in an
  // absolute drive path (for example `D:\\a\\...`) as the separator in a
  // remote archive spec (`host:path`). Pass paths relative to the current
  // working directory so extraction works with both GNU tar and bsdtar.
  const cwd = process.cwd();
  const tarPath = (file) => (relative(cwd, file) || '.').replaceAll('\\', '/');
  const archiveArg = tarPath(tmp);
  const destinationArg = tarPath(dest);
  await execFileAsync('tar', ['-xzf', archiveArg, '-C', destinationArg, '--strip-components=1'], {
    cwd,
  });
  await rm(tmp, { force: true });
}

async function stageWindowsNatives(context) {
  for (const name of ['JuDeskQianniuHook.exe', 'QnQtMsg64.dll']) {
    if (!(await exists(resolve('resources/qianniu-native', name))))
      throw new Error(`Windows 安装包缺少千牛连接组件 ${name}，请先准备 resources/qianniu-native`);
  }
  const prismaRequire = createRequire(require.resolve('prisma/package.json'));
  const { download, BinaryType } = prismaRequire('@prisma/fetch-engine');
  const { enginesVersion } = prismaRequire('@prisma/engines-version');
  const enginesDir = dirname(
    prismaRequire.resolve('@prisma/engines/package.json', {
      paths: [dirname(require.resolve('prisma/package.json'))],
    }),
  );
  await download({
    binaries: { [BinaryType.SchemaEngineBinary]: enginesDir },
    binaryTargets: ['windows'],
    version: enginesVersion,
    showProgress: true,
  });

  const libsql = resolve('.packaging/libsql-win32');
  if (!(await exists(join(libsql, 'package.json')))) {
    await extractTarball(
      'https://registry.npmjs.org/@libsql/win32-x64-msvc/-/win32-x64-msvc-0.5.29.tgz',
      libsql,
    );
  }
  const files = context.packager.config.files;
  if (Array.isArray(files)) {
    files.push({ from: libsql, to: 'node_modules/@libsql/win32-x64-msvc' });
  }
}

module.exports = async (context) => {
  const client = dirname(
    require.resolve('.prisma/client/package.json', {
      paths: [dirname(require.resolve('@prisma/client/package.json'))],
    }),
  );
  const target = resolve('.packaging/prisma-client');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(client, target, { recursive: true });
  const core = createRequire(require.resolve('@mastra/core/package.json'));
  for (const name of ['provider-v6', 'provider-v7']) {
    const folder = resolve('.packaging', name);
    await rm(folder, { recursive: true, force: true });
    await cp(dirname(core.resolve(`@ai-sdk/${name}/package.json`)), folder, { recursive: true });
  }
  if (context?.electronPlatformName === 'win32') await stageWindowsNatives(context);
};
