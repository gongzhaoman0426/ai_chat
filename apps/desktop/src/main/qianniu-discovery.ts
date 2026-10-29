import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import AdmZip from 'adm-zip';

const SCRIPT_URL = 'http://127.0.0.1:3000/qianniu-inject';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** Versioned install folders such as 9.52.00N next to a shallow AliWorkbench.exe launcher. */
const VERSION_DIR = /^\d+(?:\.\d+){1,3}[a-z]?$/i;
const exec = promisify(execFile);
type DiscoveryOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  candidatePaths?: string[];
  listRegisteredCandidates?: () => Promise<string[]>;
};

// Read-only and bounded: no recursive registry/disk scan, shell association, or installer execution.
const discoveryScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$found = [System.Collections.Generic.List[string]]::new()
Get-CimInstance Win32_Process -Filter "Name = 'AliWorkbench.exe'" | ForEach-Object {
  if ($_.ExecutablePath) { $found.Add([string]$_.ExecutablePath) }
}
$appPaths = @(
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AliWorkbench.exe',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AliWorkbench.exe',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AliWorkbench.exe'
)
foreach ($key in $appPaths) {
  $item = Get-Item -LiteralPath $key
  if ($item) { $value = $item.GetValue(''); if ($value) { $found.Add([string]$value) } }
}
$uninstall = @(
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($key in $uninstall) {
  Get-ItemProperty -Path $key | Where-Object { $_.DisplayName -match '千牛|QianNiu|AliWorkbench' } | ForEach-Object {
    if ($_.InstallLocation) { $found.Add([string]$_.InstallLocation) }
    if ($_.DisplayIcon) { $found.Add([string]$_.DisplayIcon) }
  }
}
ConvertTo-Json -InputObject @($found | Select-Object -Unique) -Compress
`;
let registryCache: { at: number; task: Promise<string[]> } | undefined;
function registeredCandidates(): Promise<string[]> {
  if (registryCache && Date.now() - registryCache.at < 10_000) return registryCache.task;
  const task = exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', discoveryScript],
    {
      windowsHide: true,
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    },
  )
    .then(({ stdout }) => {
      const result: unknown = JSON.parse(stdout.trim() || '[]');
      return (Array.isArray(result) ? result : [result])
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 80);
    })
    .catch(() => []);
  registryCache = { at: Date.now(), task };
  return task;
}

function containsBootstrap(html: string): boolean {
  // The reference patcher replaces a URL literal inside recent.html. Do not accept a similarly
  // named URL on another host/port, or an occurrence in an unrelated archive entry.
  const escaped = SCRIPT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["'\x60]${escaped}["'\x60]`).test(html);
}

async function listVersionDirectories(base: string): Promise<string[]> {
  try {
    return (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .slice(0, 20)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Adjacent Resources first, then versioned installs (newest first). */
async function listResourceRoots(base: string): Promise<string[]> {
  const versions = await listVersionDirectories(base);
  return [
    join(base, 'Resources', 'newWebui'),
    ...versions.map((version) => join(base, version, 'Resources', 'newWebui')),
  ];
}

async function archivePatched(
  resources: string,
): Promise<'patched' | 'unpatched' | 'missing'> {
  const archive = join(resources, 'webui.zip');
  try {
    const metadata = await stat(archive);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ARCHIVE_BYTES)
      return 'unpatched';
    const zip = new AdmZip(await readFile(archive));
    const entries = zip.getEntries();
    if (entries.length > 5000) return 'unpatched';
    for (const entry of entries) {
      if (
        entry.isDirectory ||
        entry.entryName.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() !== 'recent.html'
      )
        continue;
      if (entry.header.size > MAX_HTML_BYTES) continue;
      const body = entry.getData();
      if (body.length <= MAX_HTML_BYTES && containsBootstrap(body.toString('utf8')))
        return 'patched';
    }
    return 'unpatched';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unpatched';
  }
}

async function looseResourcesPatched(resources: string): Promise<boolean> {
  for (const relative of [
    'recent.html',
    'webui/recent.html',
    'html/recent.html',
    'webui/html/recent.html',
  ]) {
    const html = join(resources, relative);
    try {
      const metadata = await stat(html);
      if (
        metadata.isFile() &&
        metadata.size <= MAX_HTML_BYTES &&
        containsBootstrap(await readFile(html, 'utf8'))
      )
        return true;
    } catch {}
  }
  return false;
}

/** Validate each launch again: the vendor updater may replace the preprocessed resources. */
export async function validatePatchedQianniuExecutable(file: string): Promise<boolean> {
  if (!file || win32.basename(file).toLowerCase() !== 'aliworkbench.exe') return false;
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  const base = dirname(file);
  const roots = await listResourceRoots(base);
  const looseCandidates: string[] = [];
  for (let index = 0; index < roots.length; index++) {
    const resources = roots[index]!;
    const archive = await archivePatched(resources);
    if (archive === 'patched') return true;
    if (archive === 'unpatched') {
      // A present archive beside the EXE wins: stock updates must fail closed.
      if (index === 0) return false;
      continue;
    }
    looseCandidates.push(resources);
  }

  // Unpacked clients are also supported without recursively walking their installation.
  for (const resources of looseCandidates) {
    if (await looseResourcesPatched(resources)) return true;
  }
  return false;
}

function normalizeCandidate(value: string, env: NodeJS.ProcessEnv): string {
  const expanded = value
    .replace(
      /%([^%]+)%/g,
      (_match, key: string) =>
        env[key] ??
        Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ??
        '',
    )
    .trim()
    .replace(/,\s*-?\d+$/, '')
    .trim();
  return expanded.replace(/^"([^"]+)"$/, '$1').trim();
}

export async function discoverQianniuExecutable(
  options: DiscoveryOptions = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') return;
  const env = options.env ?? process.env;
  const registered = await (options.listRegisteredCandidates ?? registeredCandidates)().catch(
    () => [],
  );
  const common: string[] = [];
  for (const parent of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    if (!parent) continue;
    common.push(join(parent, 'QianNiu'), join(parent, 'Alibaba', 'QianNiu'));
  }
  const roots = [...(options.candidatePaths ?? []), ...registered, ...common].slice(0, 100);
  const visited = new Set<string>();
  for (const value of roots) {
    const candidate = normalizeCandidate(value, env);
    if (!candidate || (!win32.isAbsolute(candidate) && !candidate.startsWith('/'))) continue;
    const key = win32.normalize(candidate).toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    if (win32.basename(candidate).toLowerCase() === 'aliworkbench.exe') {
      if (await validatePatchedQianniuExecutable(candidate)) return candidate;
    }
    const directory = /\.exe$/i.test(candidate) ? dirname(candidate) : candidate;
    if (await validatePatchedQianniuExecutable(join(directory, 'AliWorkbench.exe')))
      return join(directory, 'AliWorkbench.exe');
    try {
      const versions = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
        .slice(0, 20);
      for (const version of versions) {
        const file = join(directory, version.name, 'AliWorkbench.exe');
        if (await validatePatchedQianniuExecutable(file)) return file;
      }
    } catch {}
  }
}
