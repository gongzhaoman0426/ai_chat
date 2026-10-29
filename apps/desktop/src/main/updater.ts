import { app, BrowserWindow, shell } from 'electron';
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from 'electron-updater';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  DesktopUpdateState,
  DesktopUpdateStatus,
} from '../../../../packages/contracts/src/index';

const { autoUpdater } = electronUpdater;

type StateListener = (state: DesktopUpdateState) => void;
type UpdateMode = DesktopUpdateState['mode'];

const DEFAULT_UPDATE_BASE_URL = 'https://updates.quantaflow.one/stable';

function configuredMode(): UpdateMode {
  if (process.env.JUDESK_UPDATE_MODE === 'automatic') return 'automatic';
  if (process.env.JUDESK_UPDATE_MODE === 'manual') return 'manual';
  try {
    const path = app.isPackaged
      ? join(process.resourcesPath, 'resources', 'update.json')
      : resolve('resources/update.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as { mode?: UpdateMode };
    return value.mode === 'automatic' ? 'automatic' : 'manual';
  } catch {
    return 'manual';
  }
}

function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    return match
      ? ([Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0), match[4] ?? ''] as [
          number,
          number,
          number,
          string,
        ])
      : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  if (!a[3] && !b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

function updateFeed() {
  const base = (process.env.JUDESK_UPDATE_BASE_URL || DEFAULT_UPDATE_BASE_URL).replace(/\/+$/, '');
  const platform = process.platform === 'darwin' ? 'darwin' : 'win32';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const manifest = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  return { base: `${base}/${platform}/${arch}`, manifest };
}

function safeDownloadUrl(feedUrl: string, value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('更新清单缺少下载文件');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//'))
    throw new Error('更新下载地址必须是相对路径');
  const url = new URL(value, feedUrl);
  const feed = new URL(feedUrl);
  if (url.protocol !== 'https:' || url.origin !== feed.origin || url.pathname.includes('..'))
    throw new Error('更新下载地址不安全');
  return url.toString();
}

function manualFile(manifest: any) {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const candidates = files
    .map((file: any) => file)
    .filter((file: any) => typeof file?.url === 'string');
  const wanted = process.platform === 'darwin' ? /\.dmg$/i : /\.exe$/i;
  return candidates.find((file: any) => wanted.test(file.url)) ?? candidates[0];
}

function notes(info: UpdateInfo) {
  if (typeof info.releaseNotes === 'string') return info.releaseNotes;
  if (Array.isArray(info.releaseNotes))
    return info.releaseNotes
      .map((item) => (typeof item === 'string' ? item : item.note))
      .filter(Boolean)
      .join('\n');
  return undefined;
}

function fileSize(info: UpdateInfo) {
  return info.files?.reduce((total, file) => total + (file.size ?? 0), 0) || undefined;
}

export class UpdateManager {
  private readonly listeners = new Set<StateListener>();
  private updater: AppUpdater | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly mode: UpdateMode;
  private state: DesktopUpdateState;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly prepareForInstall: () => Promise<void>,
  ) {
    this.mode = configuredMode();
    this.state = {
      status: 'idle',
      currentVersion: app.getVersion(),
      mode: this.mode,
    };
  }

  initialize() {
    if (!app.isPackaged && !process.env.JUDESK_UPDATE_DEV) {
      this.setStatus('disabled');
      return;
    }
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      this.setStatus('disabled');
      return;
    }

    if (this.mode === 'automatic') {
      this.updater = autoUpdater;
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.on('checking-for-update', () => this.setStatus('checking'));
      this.updater.on('update-available', (info) => this.setAvailable(info));
      this.updater.on('update-not-available', () => this.setStatus('not-available'));
      this.updater.on('download-progress', (progress) => this.setProgress(progress));
      this.updater.on('update-downloaded', (info) => this.setDownloaded(info));
      this.updater.on('error', (error) => this.setError(error));

      // Local smoke tests can provide a generic feed without needing a packaged app-update.yml.
      if (process.env.JUDESK_UPDATE_URL) this.updater.setFeedURL(process.env.JUDESK_UPDATE_URL);
    }

    this.checkTimer = setTimeout(() => void this.check(), 30_000);
    this.interval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
  }

  dispose() {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.interval) clearInterval(this.interval);
    this.checkTimer = undefined;
    this.interval = undefined;
  }

  subscribe(listener: StateListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  async check() {
    if (this.mode === 'manual') return this.checkManual();
    if (!this.updater) return this.state;
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    this.setStatus('checking');
    try {
      const result = await this.updater.checkForUpdates();
      if (result?.updateInfo && result.updateInfo.version !== this.state.currentVersion)
        this.setAvailable(result.updateInfo);
      else if (this.state.status === 'checking') this.setStatus('not-available');
    } catch (error) {
      this.setError(error);
    }
    return this.state;
  }

  async download() {
    if (this.mode === 'manual') {
      if (this.state.status !== 'available') await this.checkManual();
      if (this.state.status === 'available' && this.state.downloadUrl)
        await shell.openExternal(this.state.downloadUrl);
      return this.state;
    }
    if (!this.updater) return this.state;
    if (this.state.status === 'downloaded') return this.state;
    if (this.state.status !== 'available') await this.check();
    if (this.state.status !== 'available') return this.state;
    this.setStatus('downloading');
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setError(error);
    }
    return this.state;
  }

  async install() {
    if (this.mode === 'manual') {
      await this.download();
      return;
    }
    if (!this.updater || this.state.status !== 'downloaded')
      throw new Error('更新文件尚未下载完成');
    this.setStatus('installing');
    try {
      await this.prepareForInstall();
      this.updater.quitAndInstall(true, true);
    } catch (error) {
      this.setError(error);
      throw error;
    }
  }

  private async checkManual() {
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    this.setStatus('checking');
    try {
      const { base, manifest } = updateFeed();
      const manifestUrl = `${base}/${manifest}`;
      const response = await fetch(manifestUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`更新清单请求失败（HTTP ${response.status}）`);
      const info = parseYaml(await response.text()) as any;
      const version = typeof info?.version === 'string' ? info.version : '';
      const comparison = compareVersions(version, this.state.currentVersion);
      if (!version || comparison == null) throw new Error('更新清单版本无效');
      if (comparison <= 0) {
        this.setStatus('not-available');
        return this.state;
      }
      const file = manualFile(info);
      const downloadUrl = safeDownloadUrl(manifestUrl, file?.url ?? info.path);
      this.state = {
        ...this.state,
        status: 'available',
        version,
        releaseNotes:
          typeof info.releaseNotes === 'string'
            ? info.releaseNotes
            : typeof info.releaseName === 'string'
              ? info.releaseName
              : undefined,
        releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
        size: typeof file?.size === 'number' ? file.size : undefined,
        downloadUrl,
        error: undefined,
        progress: undefined,
      };
      this.publish();
    } catch (error) {
      this.setError(error);
    }
    return this.state;
  }

  private setAvailable(info: UpdateInfo) {
    this.state = {
      ...this.state,
      status: 'available',
      version: info.version,
      releaseNotes: notes(info),
      releaseDate: info.releaseDate,
      size: fileSize(info),
      error: undefined,
      progress: undefined,
      downloadUrl: undefined,
    };
    this.publish();
  }

  private setDownloaded(info: UpdateInfo) {
    this.state = {
      ...this.state,
      status: 'downloaded',
      version: info.version,
      releaseNotes: notes(info),
      releaseDate: info.releaseDate,
      size: fileSize(info),
      error: undefined,
      progress: 100,
      downloadUrl: undefined,
    };
    this.publish();
  }

  private setProgress(progress: ProgressInfo) {
    this.state = { ...this.state, status: 'downloading', progress: progress.percent };
    this.publish();
  }

  private setError(error: unknown) {
    this.state = {
      ...this.state,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    this.publish();
  }

  private setStatus(status: DesktopUpdateStatus) {
    this.state = { ...this.state, status, error: undefined };
    this.publish();
  }

  private publish() {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
    const current = this.getWindow();
    if (current && !current.isDestroyed()) current.webContents.send('judesk:update-state', state);
  }
}
