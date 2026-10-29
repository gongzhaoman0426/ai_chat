import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Exercise the actual setup component with a fake desktop API; never launch or inject a client.
await mkdir('.artifacts', { recursive: true });
const dir = await mkdtemp('.artifacts/qianniu-ui-');
let browser;
let server;
try {
  await writeFile(
    join(dir, 'index.html'),
    '<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./entry.tsx"></script></html>',
  );
  await writeFile(
    join(dir, 'entry.tsx'),
    `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { client } from '/apps/desktop/src/renderer/api';
import { QianniuSetup } from '/apps/desktop/src/renderer/components/qianniu-setup';
import '/apps/desktop/src/renderer/styles.css';
import '/apps/desktop/src/renderer/styles-product.css';
const runtimePlatform = new URLSearchParams(location.search).get('platform') || 'win32';
window.calls = [];
window.fixture = { supported: runtimePlatform === 'win32', downloadUrl: '', executablePath: null, phase: 'not_configured', message: '点击启动千牛。', scriptUrl: 'http://127.0.0.1:3000/qianniu-inject', tcpPort: 9996, accounts: [] };
window.judesk = {call: async (method) => {
  window.calls.push(method);
  if (method === 'app.state') return {runtimePlatform};
  if (method === 'qianniu.launch') Object.assign(window.fixture, {executablePath: 'C:/Qianniu/AliWorkbench.exe', phase: 'waiting_login', message: '等待千牛登录'});
  if (method === 'qianniu.addAccount') window.fixture.message = '请在千牛登录窗口登录其他店铺，并进入聊天工作台。';
  if (method === 'qianniu.retryHook') window.fixture.accounts = window.fixture.accounts.map(account => ({...account, tcp: true}));
  return {...window.fixture};
}};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><main style={{maxWidth: 720, margin: '36px auto'}}><QianniuSetup /></main></QueryClientProvider>);
`,
  );
  server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${port}/.artifacts/${basename(dir)}/index.html`;
  await page.goto(url);
  const download = page.getByRole('button', { name: '下载千牛客户端', exact: true });
  await download.waitFor();
  assert.equal(await download.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '选择客户端', exact: true }).count(), 0);
  await page.getByRole('button', { name: '启动千牛', exact: true }).click();
  await page.getByText('等待千牛登录', { exact: true }).waitFor();
  await page.evaluate(() =>
    Object.assign(window.fixture, {
      phase: 'connected',
      message: '千牛账号已连接，可在店铺设置中开启接待。',
      accounts: [{ loginId: '测试店铺:客服', websocket: true, tcp: true }],
    }),
  );
  await page.getByText('千牛已连接', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /注入|重新连接消息/ }).count(), 0);
  const addAccount = page.getByRole('button', { name: '登录其他店铺', exact: true });
  assert.equal(await addAccount.isEnabled(), true);
  await addAccount.click();
  await page
    .getByText('请在千牛登录窗口登录其他店铺，并进入聊天工作台。', { exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.fixture.accounts.push({ loginId: '另一店铺:客服', websocket: true, tcp: false }),
  );
  await page.getByText('另一店铺:客服', { exact: true }).waitFor();
  await page.getByText('消息连接待完成', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重新连接消息', exact: true }).click();
  await page.getByText('已连接 2 个账号', { exact: true }).waitFor();
  assert.equal(await page.getByText('测试店铺:客服', { exact: true }).count(), 1);
  assert.equal(await addAccount.isEnabled(), true);
  assert.deepEqual(
    await page.evaluate(() =>
      window.calls.filter((call) => !['app.state', 'qianniu.status'].includes(call)),
    ),
    ['qianniu.launch', 'qianniu.addAccount', 'qianniu.retryHook'],
  );
  await page.screenshot({ path: '.artifacts/qianniu-setup.png', fullPage: true });
  for (const platform of ['darwin', 'linux']) {
    await page.goto(url + '?platform=' + platform);
    await page.waitForFunction(() => window.calls?.includes('app.state'));
    assert.equal(await page.getByRole('region', { name: '千牛接入引导' }).count(), 0);
    assert.equal(await page.evaluate(() => window.calls.includes('qianniu.status')), false);
  }
  assert.deepEqual(errors, []);
  console.log(
    'Qianniu setup smoke passed: launch, additional shop login, per-account recovery, non-Windows hidden.',
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
