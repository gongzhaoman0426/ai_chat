import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Publish one electron-builder output directory to Cloudflare R2.
 *
 * RELEASE_PHASE is deliberately explicit:
 *   validate       check a build without credentials
 *   artifacts      upload immutable packages and blockmaps
 *   manifests      publish latest*.yml after every architecture's artifacts exist
 *   public-verify  read the manifest and package headers from the public URL
 *
 * The script has no R2 SDK dependency so the publish job can run from a clean
 * checkout. AWS CLI is only used with an explicit R2 endpoint.
 */

const args = new Set(process.argv.slice(2));
const phase = args.has('--validate-only') ? 'validate' : process.env.RELEASE_PHASE;
const platform = process.env.RELEASE_PLATFORM;
const arch = process.env.RELEASE_ARCH;
const dist = resolve(process.env.RELEASE_DIST || 'dist');
const manifestName = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
const versionFromPackage = async () => {
  try {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    return String(packageJson.version);
  } catch {
    return undefined;
  }
};
const releaseVersion = (process.env.RELEASE_VERSION || (await versionFromPackage()) || '').replace(
  /^v/,
);

if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error('RELEASE_PLATFORM 必须是 win32/darwin，RELEASE_ARCH 必须是 x64/arm64');
}
if (!['validate', 'artifacts', 'manifests', 'public-verify'].includes(phase)) {
  throw new Error('RELEASE_PHASE 必须是 validate、artifacts、manifests 或 public-verify');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  throw new Error(`RELEASE_VERSION 不是有效的 semver: ${releaseVersion || '<empty>'}`);
}

const allowedArtifact = (name) => {
  if (name === manifestName) return true;
  if (platform === 'win32') return /\.(exe|blockmap)$/i.test(name);
  return /\.(dmg|zip|blockmap)$/i.test(name);
};

function scalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

function parseManifest(text) {
  const versionMatch = text.match(/^version:\s*(.+)$/m);
  if (!versionMatch) throw new Error(`${manifestName} 缺少 version`);
  const version = scalar(versionMatch[1]);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`${manifestName} 的 version 不是有效 semver: ${version}`);
  const pathMatch = text.match(/^path:\s*(.+)$/m);
  const files = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+url:\s*(.+)$/);
    if (item) {
      current = { url: scalar(item[1]) };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s+sha512:\s*(.+)$/);
    if (sha) current.sha512 = scalar(sha[1]);
    const size = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (size) current.size = Number(size[1]);
  }
  if (!files.length) throw new Error(`${manifestName} 缺少 files`);
  for (const file of files) {
    if (!file.url || !file.sha512 || !Number.isSafeInteger(file.size))
      throw new Error(`${manifestName} 的 files 项缺少 url、sha512 或 size`);
  }
  return {
    version,
    path: pathMatch ? scalar(pathMatch[1]) : undefined,
    files,
  };
}

function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = value.split('-', 2);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    if (left.pre[i] === undefined) return -1;
    if (right.pre[i] === undefined) return 1;
    if (left.pre[i] === right.pre[i]) continue;
    const aNum = /^\d+$/.test(left.pre[i]);
    const bNum = /^\d+$/.test(right.pre[i]);
    if (aNum && bNum) return Number(left.pre[i]) - Number(right.pre[i]);
    if (aNum !== bNum) return aNum ? -1 : 1;
    return left.pre[i].localeCompare(right.pre[i]);
  }
  return 0;
}

async function digest(file) {
  const content = await readFile(file);
  return {
    size: content.length,
    sha512: createHash('sha512').update(content).digest('base64'),
  };
}

async function buildInventory() {
  const entries = [];
  for (const name of await readdir(dist)) {
    const full = join(dist, name);
    if (!(await stat(full)).isFile()) continue;
    if (!allowedArtifact(name)) {
      if (/^builder-(?:debug|effective-config)\.ya?ml$/i.test(name)) continue;
      if (/\.(exe|dmg|zip|blockmap|ya?ml)$/i.test(name))
        throw new Error(`dist 中有未允许的发布文件: ${name}`);
      continue;
    }
    entries.push({ name, full, manifest: name === manifestName });
  }
  const manifest = entries.find((entry) => entry.manifest);
  if (!manifest) throw new Error(`构建产物缺少 ${manifestName}`);
  for (const entry of entries.filter((item) => !item.manifest)) {
    if (!entry.name.includes(`-${releaseVersion}-`))
      throw new Error(`发布目录混入了其他版本的文件: ${entry.name}`);
  }
  return { entries, manifest, manifestText: await readFile(manifest.full, 'utf8') };
}

async function validateInventory() {
  const inventory = await buildInventory();
  const info = parseManifest(inventory.manifestText);
  if (info.version !== releaseVersion)
    throw new Error(`${manifestName} 的 version=${info.version}，预期 ${releaseVersion}`);
  const files = new Map(inventory.entries.map((entry) => [entry.name, entry]));
  const seen = new Set();
  for (const item of info.files) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(item.url) || item.url.includes('?') || item.url.includes('#'))
      throw new Error(`${manifestName} 的 url 必须是相对路径: ${item.url}`);
    const decoded = decodeURIComponent(item.url).replace(/^\.\//, '');
    if (
      !decoded ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded === '.' ||
      decoded === '..'
    )
      throw new Error(`${manifestName} 的 url 不能指向目录或上级路径: ${item.url}`);
    const entry = files.get(decoded);
    if (!entry || entry.manifest) throw new Error(`${manifestName} 引用了不存在的产物: ${decoded}`);
    if (seen.has(decoded)) throw new Error(`${manifestName} 重复引用产物: ${decoded}`);
    seen.add(decoded);
    const actual = await digest(entry.full);
    if (actual.sha512 !== item.sha512 || actual.size !== item.size)
      throw new Error(`${manifestName} 校验失败: ${decoded}`);
  }
  if (info.path) {
    const path = decodeURIComponent(info.path).replace(/^\.\//, '');
    if (!seen.has(path)) throw new Error(`${manifestName} 的 path 未出现在 files 中: ${path}`);
  }
  return { inventory, info };
}

function awsEnvironment() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: 'auto',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
}

function runAws(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, {
      env: awsEnvironment(),
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const bucket = process.env.R2_BUCKET;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const endpoint = process.env.R2_ENDPOINT || `https://${accountId || ''}.r2.cloudflarestorage.com`;
const prefix = `stable/${platform}/${arch}`;
const requireCredentials = () => {
  for (const [name, value] of Object.entries({
    R2_BUCKET: bucket,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  }))
    if (!value) throw new Error(`缺少发布环境变量 ${name}`);
};

async function headObject(key) {
  const result = await runAws(
    ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--endpoint-url', endpoint],
    true,
  );
  if (result.code !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`无法解析 R2 head-object 响应: ${key}`);
  }
}

function contentType(name) {
  if (name.endsWith('.yml')) return 'text/yaml; charset=utf-8';
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.zip') || name.endsWith('.blockmap')) return 'application/octet-stream';
  return 'application/octet-stream';
}

async function uploadImmutable(entry, version) {
  const key = `${prefix}/${basename(entry.name)}`;
  const actual = await digest(entry.full);
  const existing = await headObject(key);
  if (existing) {
    const remoteHash = existing.Metadata?.sha512;
    if (remoteHash === actual.sha512 && Number(existing.ContentLength) === actual.size) return;
    throw new Error(`拒绝覆盖不可变发布文件: s3://${bucket}/${key}`);
  }
  const result = await runAws(
    [
      's3',
      'cp',
      entry.full,
      `s3://${bucket}/${key}`,
      '--endpoint-url',
      endpoint,
      '--only-show-errors',
      '--content-type',
      contentType(entry.name),
      '--cache-control',
      'public, max-age=31536000, immutable',
      '--metadata',
      `sha512=${actual.sha512},version=${version}`,
    ],
    true,
  );
  if (result.code !== 0)
    throw new Error(`上传失败 ${entry.name}: ${result.stderr || result.stdout}`);
  const check = await headObject(key);
  if (
    !check ||
    Number(check.ContentLength) !== actual.size ||
    check.Metadata?.sha512 !== actual.sha512
  )
    throw new Error(`上传后校验失败: ${key}`);
}

async function fetchRemoteManifest(key) {
  const existing = await headObject(key);
  if (!existing) return undefined;
  const result = await runAws(
    ['s3', 'cp', `s3://${bucket}/${key}`, '-', '--endpoint-url', endpoint, '--only-show-errors'],
    true,
  );
  if (result.code !== 0)
    throw new Error(`读取已有清单失败 ${key}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function publishManifest(manifest, info) {
  const key = `${prefix}/${manifestName}`;
  for (const entry of info.files) {
    const remote = await headObject(
      `${prefix}/${decodeURIComponent(entry.url).replace(/^\.\//, '')}`,
    );
    if (!remote) throw new Error(`发布清单前发现产物尚未上传: ${entry.url}`);
  }
  const oldText = await fetchRemoteManifest(key);
  if (oldText != null) {
    const oldInfo = parseManifest(oldText);
    const order = compareVersions(oldInfo.version, releaseVersion);
    if (order > 0)
      throw new Error(`拒绝用旧版本 ${releaseVersion} 覆盖 R2 中的新清单 ${oldInfo.version}`);
    if (order === 0 && oldText.trim() !== manifest.text.trim())
      throw new Error(`R2 已存在 ${releaseVersion} 清单，但内容不同，拒绝覆盖`);
    if (order === 0) return;
  }
  const result = await runAws(
    [
      's3',
      'cp',
      manifest.full,
      `s3://${bucket}/${key}`,
      '--endpoint-url',
      endpoint,
      '--only-show-errors',
      '--content-type',
      'text/yaml; charset=utf-8',
      '--cache-control',
      'no-cache, no-store, must-revalidate',
      '--metadata',
      `version=${releaseVersion}`,
    ],
    true,
  );
  if (result.code !== 0) throw new Error(`上传清单失败: ${result.stderr || result.stdout}`);
}

async function verifyPublic() {
  const base = (process.env.RELEASE_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base))
    throw new Error('RELEASE_PUBLIC_BASE_URL 必须是 HTTPS 公共更新域名');
  const manifestUrl = `${base}/${platform}/${arch}/${manifestName}`;
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`公共清单不可访问 ${manifestUrl}: HTTP ${response.status}`);
  const text = await response.text();
  const info = parseManifest(text);
  if (info.version !== releaseVersion) throw new Error(`公共清单版本错误: ${info.version}`);
  for (const file of info.files) {
    const url = new URL(file.url, `${base}/${platform}/${arch}/`);
    if (url.protocol !== 'https:' || url.pathname.includes('..'))
      throw new Error(`公共清单 URL 不安全: ${file.url}`);
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) throw new Error(`公共产物不可访问 ${url}: HTTP ${head.status}`);
    const length = head.headers.get('content-length');
    if (length && Number(length) !== file.size) throw new Error(`公共产物大小错误: ${url}`);
  }
}

const main = async () => {
  if (phase === 'public-verify') {
    await verifyPublic();
    console.log(`公共更新源验证通过: ${platform}/${arch}`);
    return;
  }
  const { inventory, info } = await validateInventory();
  if (phase === 'validate') {
    console.log(
      `离线发布校验通过: ${inventory.entries.length} 个文件, ${platform}/${arch} ${releaseVersion}`,
    );
    return;
  }
  requireCredentials();
  if (phase === 'artifacts') {
    for (const entry of inventory.entries.filter((item) => !item.manifest))
      await uploadImmutable(entry, releaseVersion);
    console.log(`不可变产物上传完成: ${platform}/${arch}`);
  } else {
    await publishManifest({ ...inventory.manifest, text: inventory.manifestText }, info);
    console.log(`更新清单发布完成: ${platform}/${arch} ${releaseVersion}`);
  }
};

await main();
