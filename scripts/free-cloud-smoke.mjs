import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

// Real Electron renderer/preload/service/database/OS-key-store paths, with an
// isolated profile and a loopback HTTP fixture for auth, model and billing APIs.
// No store connection, production account, paid provider, or real payment.
const directory = await mkdtemp(join(tmpdir(), 'judesk-free-cloud-'));
const artifacts = resolve('.artifacts/free-cloud');
await mkdir(artifacts, { recursive: true });
const user = {
  id: 'fixture-user',
  name: '云端体验账号',
  email: 'cloud-ui@example.test',
  emailVerified: true,
};
const token = 'fixture-cloud-session';
const cloudModel = {
  id: 'fixture-chat',
  model: 'fixture-upstream',
  displayName: '轻量客服模型',
  kind: 'chat',
  inputPriceCnyPerMillion: 2,
  outputPriceCnyPerMillion: 6,
  maxInputTokens: 8192,
  maxOutputTokens: 2048,
};
const requests = [];
const charges = [];
const paymentOrders = new Map();
const fixtureQrUrl = 'https://fixture-pay.example.test/payment-image.svg';
const fixtureQr = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect x="1" y="1" width="238" height="238" rx="12" fill="#f0f6ff" stroke="#0660ff"/><text x="120" y="116" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#0660ff">支付图片测试</text><text x="120" y="146" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#68758d">本地模拟 · 不可付款</text></svg>',
);
let payment;
let balance = 20;
const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  const path = new URL(request.url, 'http://localhost').pathname;
  requests.push({ path, body, auth: request.headers.authorization });
  function reply(data, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  }
  if (path === '/api/ai/catalog')
    return reply({
      models: [cloudModel],
      paymentEnabled: true,
      paymentProvider: 'hupijiao',
    });
  if (path === '/api/auth/email-code')
    return reply({ verificationId: '00000000-0000-4000-8000-000000000001', retryAfter: 60 });
  if (['/api/auth/login', '/api/auth/register', '/api/auth/login-code'].includes(path)) {
    if (path === '/api/auth/register' && body.code !== '123456')
      return reply({ error: { message: '验证码错误' } }, 400);
    return reply({ token, user });
  }
  if (path === '/v1/chat/completions' || path === '/api/ai/v1/chat/completions') {
    const cloud = path.startsWith('/api/ai/');
    if (request.headers.authorization !== `Bearer ${cloud ? token : 'fixture-own-key'}`)
      return reply({ error: { message: 'wrong model credentials' } }, 401);
    charges.push({ cloud, model: body.model });
    return reply({
      id: 'fixture-response',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
    });
  }
  if (request.headers.authorization !== `Bearer ${token}`)
    return reply({ error: { code: 'UNAUTHORIZED', message: '请登录云端账号' } }, 401);
  if (path === '/api/auth/logout') return reply({ ok: true });
  if (path === '/api/catalog')
    return reply({
      softwareFree: true,
      byokRequiresPro: true,
      paymentEnabled: true,
      paymentProvider: 'hupijiao',
      plans: [
        {
          id: 'plan_pro',
          code: 'pro',
          name: '句达 Pro',
          description: '解锁自有 API Key',
          days: 30,
          priceCents: 9900,
          enabled: true,
        },
      ],
    });
  if (path === '/api/me')
    return reply({
      user,
      subscription: {
        plan: 'pro',
        proExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        features: { byok: true },
      },
    });
  if (path === '/api/software/orders') {
    if (request.method === 'GET') return reply({ items: [] });
    return reply({
      id: 'fixture-pro-order',
      outTradeNo: 'PROfixture',
      planId: body.planId,
      planCode: 'pro',
      planName: '句达 Pro',
      days: 30,
      amountCents: 9900,
      status: 'pending',
      provider: 'hupijiao',
      qrCodeUrl: fixtureQrUrl,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
  }
  if (path.startsWith('/api/software/orders/'))
    return reply({
      id: 'fixture-pro-order',
      status: 'paid',
      amountCents: 9900,
      planCode: 'pro',
      days: 30,
    });
  if (path === '/api/ai/wallet')
    return reply({
      balanceMicros: String(balance * 1000000),
      reservedMicros: '0',
      balanceCny: balance,
      reservedCny: 0,
      availableCny: balance,
    });
  if (path === '/api/ai/usage')
    return reply({
      items: [
        {
          id: 'fixture-usage',
          providerModel: 'fixture-upstream',
          promptTokens: 1200,
          completionTokens: 300,
          chargeCny: 0.0042,
          status: 'succeeded',
          createdAt: new Date().toISOString(),
        },
      ],
      transactions: [
        {
          id: 'fixture-transaction',
          kind: 'consume',
          amountCny: -0.0042,
          balanceAfterCny: 20,
          createdAt: new Date().toISOString(),
          note: '客服模型请求',
        },
      ],
    });
  if (path === '/api/ai/recharge-orders') {
    if (request.method === 'GET') return reply([...paymentOrders.values()].reverse());
    payment = paymentOrders.get(body.requestId) || {
      id: `fixture-payment-${paymentOrders.size + 1}`,
      outTradeNo: `FIXTURE20260916-${paymentOrders.size + 1}`,
      requestId: body.requestId,
      amountCents: body.amountCents,
      status: 'pending',
      provider: 'hupijiao',
      qrCodeUrl: fixtureQrUrl,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    paymentOrders.set(body.requestId, payment);
    return reply(payment);
  }
  if (path.startsWith('/api/ai/recharge-orders/')) {
    const found = [...paymentOrders.values()].find((order) => path.endsWith(`/${order.id}`));
    if (found) return reply(found);
  }
  return reply({ error: { message: `Unknown fixture route ${path}` } }, 404);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const config = join(directory, 'license.json');
const openConfig = join(directory, 'license-open.json');
await writeFile(config, JSON.stringify({ serverUrl: origin }));
await writeFile(openConfig, JSON.stringify({}));
let app;
let page;
const errors = [];
async function stop() {
  if (!app) return;
  const child = app.process();
  await app
    .evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0);
    })
    .catch(() => {});
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await app.close().catch(() => {});
  app = undefined;
}
async function launch(profile, licenseConfig = config) {
  await stop();
  const env = {
    ...process.env,
    JUDESK_DATA_DIR: join(directory, profile),
    JUDESK_LICENSE_CONFIG: licenseConfig,
    JUDESK_SMOKE_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve('out/main/bootstrap.js')], env, timeout: 60000 });
  app.process().stderr.on('data', (data) => process.stderr.write(data));
  page = await app.firstWindow();
  await page.route(fixtureQrUrl, (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: fixtureQr }),
  );
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.judesk, null, { timeout: 60000 });
  await call('app.state');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 780));
}
async function call(method, input = {}) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      return await page.evaluate(({ method, input }) => window.judesk.call(method, input), {
        method,
        input,
      });
    } catch (error) {
      // Main-process IPC exists before the isolated service finishes starting.
      // This response guarantees the operation has not been dispatched yet.
      if (!String(error).includes('本地服务正在启动') || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
async function snapshot(name) {
  await page.screenshot({ path: join(artifacts, `${name}.png`), animations: 'disabled' });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    `${name} does not overflow horizontally`,
  );
}
async function leaveStoreGuide() {
  await page.getByRole('button', { name: '先人工接待，稍后配置', exact: true }).click();
  await page.getByRole('button', { name: '系统设置', exact: true }).waitFor();
}
try {
  await launch('own', openConfig);
  await page
    .getByRole('heading', { name: '选一种方式，让 AI 开始工作' })
    .waitFor({ timeout: 60000 });
  await snapshot('01-welcome');
  await page.getByRole('button', { name: /使用自己的 API Key/ }).click();
  await page.getByLabel('API Base URL').fill(`${origin}/v1`);
  await page.getByLabel('API Key').fill('fixture-own-key');
  await page.getByLabel('模型标识').fill('fixture-own');
  await snapshot('02-own-key');
  await page.getByRole('button', { name: '保存并进入工作空间' }).click();
  await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor();
  const ownModels = await call('models.list');
  assert.equal(ownModels.length, 1);
  assert.equal(ownModels[0].source, 'own');
  assert.equal(JSON.stringify(ownModels).includes('fixture-own-key'), false);
  assert.equal((await call('app.state')).settings.aiSetupMode, 'own');
  assert.equal((await call('license.state')).loggedIn, false);
  await call('models.test', { id: ownModels[0].id });
  await leaveStoreGuide();
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await snapshot('03-own-settings');
  await launch('own', openConfig);
  await page.getByRole('button', { name: '系统设置', exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole('heading', { name: '选一种方式，让 AI 开始工作' }).count(), 0);
  assert.equal((await call('models.list'))[0].id, ownModels[0].id);
  assert.equal((await call('license.state')).loggedIn, false);
  console.log('BYOK save, model request, no-account use, and restart verified.');

  // Upgrade regression: existing local data must not suppress the AI-source
  // choice. Autoconnect remains unset, so this fixture never opens a shop site.
  await stop();
  const databaseUrl = pathToFileURL(join(directory, 'own', 'db', 'judesk.db')).href;
  // Keep fixture SQLite handles in a short-lived process so Prisma migrations
  // can acquire an exclusive database lock during the next Electron launch.
  const databaseBatch = async (statements, mode = 'read') => {
    const result = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import { createClient } from '@libsql/client';
      const db = createClient({ url: process.argv[1] });
      try {
        const results = await db.batch(JSON.parse(process.argv[2]), process.argv[3]);
        process.stdout.write(JSON.stringify(results.map(result => result.rows)));
      } finally { db.close(); }
    `,
      databaseUrl,
      JSON.stringify(statements),
      mode,
    ]);
    return JSON.parse(result.stdout);
  };
  const preservedState = () =>
    databaseBatch([
      ...[
        'ModelProfile',
        'Store',
        'Account',
        'AgentBinding',
        'AgentRevision',
        'ReplyPolicy',
        'LearningPolicy',
      ].map((table) => `SELECT * FROM ${table} ORDER BY rowid`),
      "SELECT * FROM AppSetting WHERE key IN ('defaultModelId', 'embeddingProfileId') ORDER BY key",
    ]);
  try {
    await databaseBatch(
      [
        "DELETE FROM AppSetting WHERE key = 'aiSetupMode'",
        {
          sql: 'INSERT OR REPLACE INTO AppSetting (key, value) VALUES (?, ?)',
          args: ['setupGuideState', JSON.stringify('active')],
        },
        {
          sql: 'INSERT INTO Store (id, externalId, name) VALUES (?, ?, ?)',
          args: ['upgrade-store', 'upgrade-mall', '已有店铺 · 升级测试'],
        },
        {
          sql: 'INSERT INTO Account (id, storeId, externalId, name, sessionPartition, status, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [
            'upgrade-account',
            'upgrade-store',
            'upgrade-staff',
            '已有客服',
            'persist:upgrade-no-autoconnect',
            'offline',
            JSON.stringify({
              receive: false,
              sendText: false,
              sendImage: false,
              history: false,
              goods: false,
              orders: false,
              verified: false,
            }),
          ],
        },
        { sql: 'INSERT INTO ReplyPolicy (storeId) VALUES (?)', args: ['upgrade-store'] },
        { sql: 'INSERT INTO LearningPolicy (storeId) VALUES (?)', args: ['upgrade-store'] },
      ],
      'write',
    );
    const beforeUpgrade = await preservedState();
    await launch('own', openConfig);
    await page.getByRole('heading', { name: '选一种方式，让 AI 开始工作' }).waitFor();
    await page.getByRole('button', { name: /使用自己的 API Key/ }).waitFor();
    await page.getByRole('button', { name: /注册账号，使用云端 AI/ }).waitFor();
    assert.equal((await call('stores.list')).length, 1);
    assert.equal((await call('models.list')).length, 1);
    await snapshot('11-upgrade-choice');
    await page.getByRole('button', { name: '保留现有配置，继续使用', exact: true }).click();
    await page.getByRole('button', { name: '选择 AI 服务', exact: true }).waitFor();
    assert.equal((await call('app.state')).settings.aiSetupMode, 'later');
    assert.deepEqual(
      await preservedState(),
      beforeUpgrade,
      'Keep existing config never rewrites models, bindings or policies',
    );
    await snapshot('12-upgrade-guide');
    await page.getByRole('button', { name: '选择 AI 服务', exact: true }).click();
    await page.getByRole('heading', { name: '选一种方式，让 AI 开始工作' }).waitFor();
    await page.getByRole('button', { name: '保留现有配置，继续使用', exact: true }).click();
    await page.getByRole('button', { name: '选择 AI 服务', exact: true }).waitFor();
    assert.deepEqual(await preservedState(), beforeUpgrade);
    await launch('own', openConfig);
    await page.getByRole('button', { name: '选择 AI 服务', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: '选一种方式，让 AI 开始工作' }).count(),
      0,
    );
    assert.deepEqual(
      await preservedState(),
      beforeUpgrade,
      'Restart preserves the existing workspace after the one-time choice',
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
      'No platform account window was opened',
    );
    console.log('Existing-workspace upgrade choice, preserve, reopen and restart verified.');
  } finally {
    await stop();
  }

  await launch('skip');
  await page.getByRole('button', { name: '稍后配置，先使用人工接待' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '稍后配置，先使用人工接待' }).click();
  await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor();
  await leaveStoreGuide();
  assert.equal((await call('app.state')).settings.aiSetupMode, 'later');
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByRole('tab', { name: /高级定制/ }).click();
  await page.getByRole('switch', { name: '显示开发者工具' }).click();
  await page.getByRole('button', { name: 'Agent 执行', exact: true }).waitFor();
  assert.equal((await call('app.state')).settings.developerModeEnabled, true);
  await snapshot('04-free-developer');
  console.log('Skip and free developer access verified.');

  await launch('cloud');
  await page.getByRole('button', { name: /注册账号，使用云端 AI/ }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /注册账号，使用云端 AI/ }).click();
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(user.email);
  await page.getByLabel('昵称', { exact: true }).fill(user.name);
  await page.getByLabel('密码', { exact: true }).fill('Fixture-Password-2026');
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await page.getByRole('button', { name: /秒后重发/ }).waitFor();
  await page.locator('input[name="code"]').fill('123456');
  await snapshot('05-cloud-register');
  await page.getByRole('button', { name: '验证邮箱并创建账号', exact: true }).click();
  await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor();
  await leaveStoreGuide();
  await page.getByRole('button', { name: '云端 AI', exact: true }).click();
  await page.getByRole('heading', { name: user.name, exact: true }).waitFor();
  await snapshot('06-cloud-wallet');
  await page.getByRole('button', { name: '充值余额', exact: true }).click();
  await page.getByRole('button', { name: '生成微信支付二维码', exact: true }).click();
  const paymentQr = page.getByAltText('微信充值支付二维码');
  await paymentQr.waitFor();
  assert.equal(await paymentQr.getAttribute('src'), fixtureQrUrl);
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="微信充值支付二维码"]');
    return image?.complete && image.naturalWidth > 0;
  });
  await snapshot('07-cloud-recharge');

  // The image expires locally even if the order is still pending on the server.
  payment.expiresAt = new Date(Date.now() + 1500).toISOString();
  await page.getByRole('button', { name: '刷新支付状态', exact: true }).click();
  await page.getByText('支付二维码已过期，请刷新支付状态。', { exact: true }).waitFor();
  assert.equal(await paymentQr.count(), 0);
  assert.equal(payment.status, 'pending');
  assert.equal((await call('license.cloudWallet')).balanceCny, 20);
  const expiredPayment = payment;
  const creationCount = () =>
    requests.filter((item) => item.path === '/api/ai/recharge-orders' && item.body).length;
  const beforeRestart = creationCount();
  await page.getByRole('button', { name: '返回金额选择', exact: true }).click();
  await page.getByRole('button', { name: '生成微信支付二维码', exact: true }).waitFor();
  await page
    .getByText(
      '原订单付款结果仍待核实。如果已经付款，请勿重复支付；确认未付款后，再创建新的充值订单。原订单可在充值记录中继续查询。',
      { exact: true },
    )
    .last()
    .waitFor();
  assert.equal(
    creationCount(),
    beforeRestart,
    'Returning to amount selection never creates an order',
  );
  assert.equal(
    (await call('license.cloudRechargeStatus', { id: expiredPayment.id })).status,
    'pending',
  );
  await page.getByRole('button', { name: '生成微信支付二维码', exact: true }).click();
  await paymentQr.waitFor();
  assert.equal(creationCount(), beforeRestart + 1);
  assert.notEqual(payment.id, expiredPayment.id);
  assert.notEqual(payment.requestId, expiredPayment.requestId);
  assert.equal(
    expiredPayment.status,
    'pending',
    'Restart never cancels or marks the original payment unpaid',
  );
  assert.deepEqual(
    (await call('license.cloudRechargeOrders')).map((order) => order.id).sort(),
    [payment.id, expiredPayment.id].sort(),
  );

  payment.status = 'paid';
  balance += payment.amountCents / 100;
  await page.getByText('充值成功，余额已更新。', { exact: true }).waitFor();
  assert.equal(await paymentQr.count(), 0);
  assert.equal((await call('license.cloudWallet')).balanceCny, 70);
  assert.equal(
    requests.some((item) => item.path === '/api/orders'),
    false,
  );
  assert.equal(await page.locator('.cloud-history').count(), 0);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '设为默认', exact: true }).first().click();
  const models = await call('models.list');
  assert.equal(models[0].source, 'cloud');
  assert.equal(models[0].id, `cloud:${cloudModel.id}`);
  assert.equal(JSON.stringify(models).includes(token), false);
  assert.equal((await call('app.state')).settings.aiSetupMode, 'cloud');
  await call('models.test', { id: models[0].id });
  await page.getByRole('button', { name: '云端 AI', exact: true }).click();
  await page.getByRole('tab', { name: '消费明细', exact: true }).click();
  await snapshot('08-cloud-usage');
  await page.getByRole('tab', { name: '余额流水', exact: true }).click();
  await page.getByRole('heading', { name: '充值订单', exact: true }).waitFor();
  await page.getByText(expiredPayment.outTradeNo, { exact: false }).waitFor();
  await page.getByText(payment.outTradeNo, { exact: false }).waitFor();
  await snapshot('09-cloud-transactions');
  await launch('cloud');
  await page.getByRole('button', { name: '云端 AI', exact: true }).waitFor({ timeout: 60000 });
  assert.equal((await call('license.state')).loggedIn, true);
  await page.getByRole('button', { name: '云端 AI', exact: true }).click();
  await page.getByRole('button', { name: '退出账号', exact: true }).click();
  await page.getByRole('button', { name: '登录云端账号', exact: true }).waitFor();
  assert.equal((await call('license.state')).loggedIn, false);
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByRole('button', { name: '添加自有模型', exact: true }).waitFor();
  await snapshot('10-after-logout');
  assert.equal(charges.filter((item) => item.cloud).length, 1);
  assert.equal(charges.filter((item) => !item.cloud).length, 1);
  assert.equal(
    requests.filter((item) => /activate|license\/refresh|bind-store/.test(item.path)).length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        ok: true,
        screenshots: artifacts,
        scenarios: [
          'BYOK without account',
          'existing-workspace upgrade choice and unchanged configuration',
          'reopen AI-source choice from store guide',
          'skip',
          'free developer access',
          'cloud registration',
          'wallet and transparent model rates',
          'Hupijiao payment image, expiry, explicit new checkout, and payment polling',
          'cloud model request',
          'OS-key-store session restart',
          'logout without software paywall',
        ],
        modelRequests: charges.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await snapshot('failure').catch(() => {});
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 6000),
    );
  }
  throw error;
} finally {
  await stop();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
