import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QianniuNativeClient, injectQianniu } from '../apps/desktop/src/main/qianniu-native';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

let directory: string;
const clients: QianniuNativeClient[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'judesk-qianniu-native-'));
  await mkdir(join(directory, 'client'));
  await mkdir(join(directory, 'hook'));
  await writeFile(join(directory, 'client', 'AliWorkbench.exe'), 'fixture');
  await writeFile(join(directory, 'hook', 'JuDeskQianniuHook.exe'), 'fixture');
  await writeFile(join(directory, 'hook', 'QnQtMsg64.dll'), 'fixture');
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

function setup(overrides: Partial<ConstructorParameters<typeof QianniuNativeClient>[0]> = {}) {
  const executable = join(directory, 'client', 'AliWorkbench.exe');
  const options = {
    platform: 'win32' as const,
    configPath: join(directory, 'settings', 'qianniu.json'),
    hookDirectory: join(directory, 'hook'),
    discoverExecutable: vi.fn(async () => executable as string | undefined),
    validateExecutable: vi.fn(async (file: string) => file === executable),
    openExternal: vi.fn(async (_url: string) => undefined),
    listProcesses: vi.fn(async () => [
      { pid: 123, executablePath: executable, startedAt: '2026-09-26' },
    ]),
    launchProcess: vi.fn(async (_file: string) => undefined),
    injectProcess: vi.fn(async (_helper: string, _pid: number, _file: string) => undefined),
    pollMs: 100_000,
    hookTimeoutMs: 1000,
    ...overrides,
  };
  const client = new QianniuNativeClient(options);
  clients.push(client);
  return { client, options, executable };
}

describe('Qianniu native integration', () => {
  it('rejects native actions outside Windows without invoking OS callbacks', async () => {
    const { client, options } = setup({ platform: 'darwin' });
    expect(client.status()).toMatchObject({ supported: false, phase: 'unavailable', accounts: [] });
    await expect(client.start()).rejects.toThrow('Windows');
    await client.onLogin({ loginId: 'seller' });
    expect(options.listProcesses).not.toHaveBeenCalled();
    expect(options.discoverExecutable).not.toHaveBeenCalled();
  });

  it('leaves download blank and persists a valid selected client for subsequent runs', async () => {
    const { client, options, executable } = setup();
    await expect(client.download()).rejects.toThrow('尚未配置');
    expect(options.openExternal).not.toHaveBeenCalled();
    await client.start();
    expect(JSON.parse(await readFile(options.configPath, 'utf8'))).toEqual({
      executablePath: executable,
    });
    const restored = setup().client;
    await restored.initialize();
    expect(restored.status()).toMatchObject({ phase: 'ready', executablePath: executable });
    expect(client.status().scriptUrl).toBe('http://127.0.0.1:3000/qianniu-inject');
  });

  it('rejects non-HTTPS download URLs; non-zip HTTPS still opens in the browser', async () => {
    const insecure = setup({ downloadUrl: 'http://example.test/client.zip' });
    await expect(insecure.client.download()).rejects.toThrow('HTTPS');
    const secure = setup({ downloadUrl: 'https://download.example.test/client.exe' });
    await secure.client.download();
    expect(secure.options.openExternal).toHaveBeenCalledWith(
      'https://download.example.test/client.exe',
    );
  });

  it('silently downloads a zip, extracts AliWorkbench.exe, validates, and persists the path', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    // CDN layout: shallow launcher + versioned install; prefer the versioned path.
    zip.addFile('qianniu/AliWorkbench.exe', Buffer.from('launcher'));
    zip.addFile('qianniu/9.52.00N/AliWorkbench.exe', Buffer.from('real'));
    zip.addFile('qianniu/9.52.00N/Resources/newWebui/webui.zip', Buffer.from('webui'));
    const payload = zip.toBuffer();
    const installDirectory = join(directory, 'installed');
    const { client, options } = setup({
      downloadUrl: 'https://updates.example.test/qianniu.zip',
      installDirectory,
      fetchImpl: vi.fn(
        async () => new Response(new Uint8Array(payload), { status: 200 }),
      ) as typeof fetch,
      validateExecutable: vi.fn(async (file: string) =>
        /9\.52\.00N[/\\]AliWorkbench\.exe$/i.test(file),
      ),
    });

    const status = await client.download();
    expect(options.openExternal).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalled();
    expect(status.downloading).toBe(false);
    expect(status.phase).toBe('ready');
    expect(status.executablePath).toMatch(/9\.52\.00N[/\\]AliWorkbench\.exe$/i);
    expect(JSON.parse(await readFile(options.configPath, 'utf8')).executablePath).toBe(
      status.executablePath,
    );
    await expect(stat(status.executablePath!)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it('reports missing installation without opening a file picker or launching another client', async () => {
    const { client, options } = setup();
    vi.mocked(options.discoverExecutable).mockResolvedValue(undefined);
    await expect(client.start()).rejects.toThrow('请先完成安装');
    expect(options.launchProcess).not.toHaveBeenCalled();
    expect(client.status()).toMatchObject({ phase: 'error', executablePath: null });
  });

  it('rediscovers automatically if a saved client has been replaced with a stock build', async () => {
    const { client, options } = setup();
    await client.start();
    vi.mocked(options.validateExecutable).mockResolvedValueOnce(false);
    await client.start();
    expect(options.discoverExecutable).toHaveBeenCalledTimes(2);
    expect(client.status().phase).toBe('waiting_login');
  });

  it('reuses an existing selected process, then connects automatically only after login', async () => {
    const { client, options, executable } = setup();
    await client.start();
    await client.start();
    expect(options.launchProcess).not.toHaveBeenCalled();
    expect(options.injectProcess).not.toHaveBeenCalled();
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledExactlyOnceWith(
      join(directory, 'hook', 'JuDeskQianniuHook.exe'),
      123,
      executable,
    );
    expect(client.status().phase).toBe('waiting_hook');
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(1);
    client.updateConnections([{ loginId: 'seller', websocket: true, tcp: true }]);
    expect(client.status().phase).toBe('connected');
    client.updateConnections([
      { loginId: 'stale', websocket: false, tcp: false },
      { loginId: 'seller', websocket: true, tcp: true },
    ]);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(1);
    expect(client.status().phase).toBe('connected');
    await client.start();
    expect(client.status().phase).toBe('connected');
  });

  it('opens another login while the first shop stays connected and hooks the new account', async () => {
    const { client, options, executable } = setup();
    await client.start();
    await client.onLogin({ loginId: 'shop-a:staff' });
    const first = { loginId: 'shop-a:staff', websocket: true, tcp: true };
    client.updateConnections([first]);

    await client.start({ openLogin: true });
    expect(options.launchProcess).toHaveBeenCalledExactlyOnceWith(executable);
    expect(client.status()).toMatchObject({ phase: 'connected', accounts: [first] });
    expect(options.injectProcess).toHaveBeenCalledTimes(1);

    vi.mocked(options.listProcesses).mockResolvedValue([
      { pid: 123, executablePath: executable, startedAt: '2026-09-26' },
      { pid: 456, executablePath: executable, startedAt: 'second-shop' },
    ]);
    const second = { loginId: 'shop-b:staff', websocket: true, tcp: false };
    client.updateConnections([first, second]);
    await client.onLogin({ loginId: second.loginId });
    expect(options.injectProcess).toHaveBeenLastCalledWith(
      join(directory, 'hook', 'JuDeskQianniuHook.exe'),
      456,
      executable,
    );
    expect(client.status()).toMatchObject({ phase: 'connected', accounts: [first, second] });
    client.updateConnections([first, { ...second, tcp: true }]);
    const count = vi.mocked(options.injectProcess).mock.calls.length;
    await client.onLogin({ loginId: second.loginId });
    expect(options.injectProcess).toHaveBeenCalledTimes(count);
    expect(client.status().accounts.every((account) => account.websocket && account.tcp)).toBe(
      true,
    );
  });

  it('preserves online accounts if opening an additional login fails', async () => {
    const { client, options } = setup();
    await client.start();
    const first = { loginId: 'shop-a', websocket: true, tcp: true };
    client.updateConnections([first]);
    vi.mocked(options.launchProcess).mockRejectedValueOnce(new Error('启动失败'));
    await expect(client.start({ openLogin: true })).rejects.toThrow('启动失败');
    expect(client.status().accounts).toEqual([first]);
  });

  it('does not silently ignore another login while a second account is connecting', async () => {
    const { client, options } = setup();
    await client.start();
    client.updateConnections([{ loginId: 'shop-a', websocket: true, tcp: true }]);
    await client.onLogin({ loginId: 'shop-a' });
    let finish!: () => void;
    vi.mocked(options.injectProcess).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const connecting = client.onLogin({ loginId: 'shop-b' });
    await vi.waitFor(() => expect(options.injectProcess).toHaveBeenCalledOnce());
    const adding = client.start({ openLogin: true });
    try {
      await vi.waitFor(() => expect(options.launchProcess).toHaveBeenCalledOnce());
    } finally {
      finish();
      await Promise.all([connecting, adding]);
    }
  });

  it('does not touch another installed Qianniu client', async () => {
    const { client, options, executable } = setup();
    await client.start();
    vi.mocked(options.listProcesses).mockResolvedValue([
      { pid: 456, executablePath: 'C:\\Other\\AliWorkbench.exe', startedAt: 'today' },
    ]);
    await client.start();
    expect(options.launchProcess).toHaveBeenCalledWith(executable);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).not.toHaveBeenCalled();
    expect(client.status()).toMatchObject({ phase: 'error' });
  });

  it.each([123, 456])(
    'keeps waiting for the other workbench process when candidate %i fails to load',
    async (failedPid) => {
      vi.useFakeTimers();
      const { client, options, executable } = setup();
      vi.mocked(options.listProcesses).mockResolvedValue([
        { pid: 123, executablePath: executable, startedAt: 'parent' },
        { pid: 456, executablePath: executable, startedAt: 'child' },
      ]);
      vi.mocked(options.injectProcess).mockImplementation(async (_helper, pid) => {
        if (pid === failedPid) throw new Error('千牛连接组件加载未完成，请重试连接。');
      });
      await client.start();
      await client.onLogin({ loginId: 'seller' });
      expect(vi.mocked(options.injectProcess).mock.calls.map((call) => call[1])).toEqual([
        123, 456,
      ]);
      expect(client.status().phase).toBe('waiting_hook');

      await client.onLogin({ loginId: 'seller' });
      expect(options.injectProcess).toHaveBeenCalledTimes(2);
      expect(client.status().phase).toBe('waiting_hook');
      vi.setSystemTime(Date.now() + 1100);
      await client.onLogin({ loginId: 'seller' });
      expect(vi.mocked(options.injectProcess).mock.calls.map((call) => call[1])).toEqual([
        123,
        456,
        failedPid === 123 ? 456 : 123,
      ]);
      expect(client.status().phase).toBe('waiting_hook');
    },
  );

  it('reports all candidate failures only after trying every matching process', async () => {
    vi.useFakeTimers();
    const { client, options, executable } = setup();
    vi.mocked(options.listProcesses).mockResolvedValue([
      { pid: 123, executablePath: executable, startedAt: 'parent' },
      { pid: 456, executablePath: executable, startedAt: 'child' },
    ]);
    vi.mocked(options.injectProcess)
      .mockRejectedValueOnce(new Error('千牛连接组件加载未完成，请重试连接。'))
      .mockRejectedValueOnce(new Error('无法连接千牛进程，请正常启动千牛。'));
    await client.start();
    await client.onLogin({ loginId: 'seller' });
    expect(vi.mocked(options.injectProcess).mock.calls.map((call) => call[1])).toEqual([123, 456]);
    expect(client.status()).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('千牛连接组件加载未完成'),
    });
    expect(client.status().message).toContain('无法连接千牛进程');

    vi.setSystemTime(Date.now() + 2000);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    expect(client.status().phase).toBe('error');
  });

  it('preserves a confirmed connection when another candidate subsequently fails to load', async () => {
    const { client, options, executable } = setup();
    vi.mocked(options.listProcesses).mockResolvedValue([
      { pid: 123, executablePath: executable, startedAt: 'parent' },
      { pid: 456, executablePath: executable, startedAt: 'child' },
    ]);
    vi.mocked(options.injectProcess)
      .mockImplementationOnce(async () => {
        client.updateConnections([{ loginId: 'seller', websocket: true, tcp: true }]);
      })
      .mockRejectedValueOnce(new Error('千牛连接组件加载未完成，请重试连接。'));
    await client.start();
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    expect(client.status()).toMatchObject({
      phase: 'connected',
      message: '千牛账号已连接，可在店铺设置中开启接待。',
    });
  });

  it('bounds automatic confirmation retries and retries a newly started process without a button', async () => {
    vi.useFakeTimers();
    const { client, options, executable } = setup({ maxAttempts: 2 });
    await client.start();
    await client.onLogin({ loginId: 'seller' });
    vi.setSystemTime(Date.now() + 1100);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 1100);
    await client.onLogin({ loginId: 'seller' });
    expect(client.status().phase).toBe('error');
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    vi.mocked(options.listProcesses).mockResolvedValue([
      { pid: 789, executablePath: executable, startedAt: 'new' },
    ]);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(3);
    expect(client.status().phase).toBe('waiting_hook');
  });

  it('never marks the account connected solely because injection succeeded', async () => {
    const { client } = setup();
    await client.start();
    await client.onLogin({ loginId: 'seller' });
    client.updateConnections([{ loginId: 'seller', websocket: true, tcp: false }]);
    expect(client.status().phase).toBe('waiting_hook');
    client.updateConnections([{ loginId: 'seller', websocket: false, tcp: true }]);
    expect(client.status().phase).not.toBe('connected');
  });

  it('retries loader exit 11 after the confirmation interval and can recover on the second attempt', async () => {
    vi.useFakeTimers();
    const { client, options } = setup();
    vi.mocked(options.injectProcess)
      .mockRejectedValueOnce(
        new Error('千牛连接组件加载未完成，请重试连接。', { cause: { code: 11 } }),
      )
      .mockResolvedValueOnce(undefined);
    await client.start();
    await client.onLogin({ loginId: 'seller' });
    expect(client.status()).toMatchObject({
      phase: 'waiting_hook',
      message: '千牛连接组件加载未完成，句达会自动重试连接。',
    });
    vi.setSystemTime(Date.now() + 999);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    expect(client.status()).toMatchObject({
      phase: 'waiting_hook',
      message: '正在等待千牛确认，句达会自动完成连接。',
    });
  });

  it('bounds loader exit 11 retries and gives the same PID a fresh budget after restarting', async () => {
    vi.useFakeTimers();
    const { client, options, executable } = setup({ maxAttempts: 2 });
    vi.mocked(options.injectProcess).mockRejectedValue(
      new Error('千牛连接组件加载未完成，请重试连接。', { cause: { code: 11 } }),
    );
    await client.start();
    await client.onLogin({ loginId: 'seller' });
    vi.setSystemTime(Date.now() + 1000);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    expect(client.status()).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('千牛连接组件加载未完成'),
    });
    vi.setSystemTime(Date.now() + 2000);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(2);

    vi.mocked(options.listProcesses).mockResolvedValue([
      { pid: 123, executablePath: executable, startedAt: 'restarted' },
    ]);
    vi.mocked(options.injectProcess).mockResolvedValue(undefined);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(3);
    expect(client.status().phase).toBe('waiting_hook');
  });

  it('does not repeatedly launch the helper after an explicit permission failure', async () => {
    vi.useFakeTimers();
    const { client, options } = setup();
    await client.start();
    vi.mocked(options.injectProcess).mockRejectedValue(
      new Error('请正常启动千牛，不要以管理员身份运行。', { cause: { code: 5 } }),
    );
    await client.onLogin({ loginId: 'seller' });
    expect(client.status()).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('不要以管理员'),
    });
    vi.setSystemTime(Date.now() + 2000);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(1);
    vi.mocked(options.injectProcess).mockResolvedValue(undefined);
    await client.start();
    expect(options.injectProcess).toHaveBeenCalledTimes(2);
    expect(client.status().phase).toBe('waiting_hook');
  });

  it('stops a pending scan when maintenance begins and reconnects on resume', async () => {
    const { client, options, executable } = setup();
    await client.start();
    let resolveProcesses!: (value: Awaited<ReturnType<typeof options.listProcesses>>) => void;
    vi.mocked(options.listProcesses).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProcesses = resolve;
        }),
    );
    const loggingIn = client.onLogin({ loginId: 'seller' });
    client.setMaintenance(true);
    resolveProcesses([{ pid: 123, executablePath: executable, startedAt: '2026-09-26' }]);
    await loggingIn;
    expect(options.injectProcess).not.toHaveBeenCalled();
    await expect(client.start()).rejects.toThrow('维护');
    client.setMaintenance(false);
    await client.onLogin({ loginId: 'seller' });
    expect(options.injectProcess).toHaveBeenCalledTimes(1);
    client.close();
    expect(client.status()).toMatchObject({ phase: 'ready', accounts: [] });
  });

  it('shares discovery across simultaneous account logins', async () => {
    const { client, options } = setup();
    await Promise.all([
      client.onLogin({ loginId: 'seller-a' }),
      client.onLogin({ loginId: 'seller-b' }),
    ]);
    expect(options.discoverExecutable).toHaveBeenCalledTimes(1);
    expect(options.injectProcess).toHaveBeenCalledTimes(1);
    expect(client.status().phase).toBe('waiting_hook');
  });

  it('does not launch or inject after close while automatic discovery is pending', async () => {
    const { client, options, executable } = setup();
    let finishDiscovery!: (file: string) => void;
    vi.mocked(options.discoverExecutable).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const starting = client.start();
    client.close();
    finishDiscovery(executable);
    await starting;
    expect(options.listProcesses).not.toHaveBeenCalled();
    expect(options.launchProcess).not.toHaveBeenCalled();
    expect(options.injectProcess).not.toHaveBeenCalled();
  });
});

describe('silent helper invocation and artifact', () => {
  it('uses direct hidden execution with the selected path, without a shell or elevation', async () => {
    await injectQianniu('C:\\JuDesk\\JuDeskQianniuHook.exe', 123, 'C:\\千牛\\AliWorkbench.exe');
    expect(execFileMock).toHaveBeenCalledWith(
      'C:\\JuDesk\\JuDeskQianniuHook.exe',
      ['123', 'C:\\千牛\\AliWorkbench.exe'],
      expect.objectContaining({ windowsHide: true, timeout: 25_000 }),
      expect.any(Function),
    );
    await expect(injectQianniu('helper.exe', -1, 'client.exe')).rejects.toThrow('进程');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('maps an OS access failure to an actionable message without requesting elevation', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(Object.assign(new Error('failed'), { code: 5 })),
    );
    await expect(injectQianniu('helper.exe', 123, 'client.exe')).rejects.toThrow('不要以管理员');
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('reports loader exit 11 without assuming the client version is incompatible', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(Object.assign(new Error('failed'), { code: 11 })),
    );
    await expect(injectQianniu('helper.exe', 123, 'client.exe')).rejects.toThrow(
      '千牛连接组件加载未完成，请重试连接。',
    );
  });

  it('packages an x64 GUI executable with an asInvoker manifest', async () => {
    const binary = await readFile(resolve('resources/qianniu-native/JuDeskQianniuHook.exe'));
    const pe = binary.readUInt32LE(0x3c);
    expect(binary.subarray(pe, pe + 4).toString()).toBe('PE\0\0');
    expect(binary.readUInt16LE(pe + 4)).toBe(0x8664);
    expect(binary.readUInt16LE(pe + 24 + 68)).toBe(2);
    expect(binary.includes(Buffer.from('level="asInvoker"'))).toBe(true);
    expect(binary.includes(Buffer.from('requireAdministrator'))).toBe(false);
  });
});
