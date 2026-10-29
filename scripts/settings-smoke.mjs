import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkOnboarding } from './onboarding-smoke.mjs';
import { checkAgentStudio } from './agent-studio-smoke.mjs';
import assert from 'node:assert/strict';

// Fresh Electron profile, intercepted platform transport, and a local model endpoint.
const dir = await mkdtemp(join(tmpdir(), 'judesk-settings-'));
await mkdir('.artifacts', { recursive: true });
let modelCalls = 0;
const mock = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const reply = body.tools?.some((tool) => tool.function.name === 'submitReply');
  if (req.url?.includes('/embeddings')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: Array(8).fill(0.01) }],
      }),
    );
    return;
  }
  if (reply) modelCalls++;
  const message = { role: 'assistant', content: reply ? '单次模型回复成功' : '连接正常' };
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'settings-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'settings-test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      id: 'settings-test',
      object: 'chat.completion',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
let app;
try {
  const env = { ...process.env, JUDESK_DATA_DIR: dir, JUDESK_SMOKE_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.JUDESK_LICENSE_CONFIG;
  app = await electron.launch({ args: [resolve('out/main/bootstrap.js')], env, timeout: 60000 });
  const page = await app.firstWindow();
  await page
    .getByRole('button', { name: '稍后配置，先使用人工接待', exact: true })
    .waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: '稍后配置，先使用人工接待', exact: true }).click();
  await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor({ timeout: 90000 });
  await checkOnboarding({ app, page, modelBaseUrl: `http://127.0.0.1:${mock.address().port}/v1` });
  await page.evaluate(() => window.judesk.call('app.settings', { developerModeEnabled: true }));
  await page.getByRole('button', { name: 'Agent Studio', exact: true }).click();
  await page.locator('.agent-card').filter({ hasText: '默认自动回复' }).click();
  const studio = page.locator('.agent-studio-dialog');
  const mounted = studio.locator('.studio-mounted').filter({ hasText: '店铺客服工具' });
  const catalog = await page.evaluate(() => window.judesk.call('assets.list'));
  const commerce = catalog.assets.find((asset) => asset.assetId === 'builtin/commerce');
  assert.ok(commerce);
  await mounted.getByText(`自动跟随最新 · 当前 v${commerce.version} ·`).waitFor();
  await studio.getByRole('button', { name: '添加 Toolkit', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '挂载 Toolkit', exact: true });
  assert.equal(
    await picker.getByRole('checkbox', { name: '店铺客服工具', exact: true }).count(),
    1,
  );
  assert.equal(await picker.getByRole('checkbox', { name: /旧版/ }).count(), 0);
  await picker.getByText(/无需物流发货/).waitFor();
  await page.screenshot({ path: '.artifacts/toolkit-latest-picker.png', animations: 'disabled' });
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await studio.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
  await page.getByRole('button', { name: 'Toolkit', exact: true }).click();
  assert.equal(await page.locator('.asset-card').filter({ hasText: '店铺客服工具' }).count(), 1);
  await page.screenshot({ path: '.artifacts/toolkit-latest-library.png', animations: 'disabled' });
  console.log(
    'Toolkit UI passed: one package entry, latest-version mount and Goofish shipment member.',
  );
  const models = await page.evaluate(() => window.judesk.call('models.list'));
  await checkAgentStudio({
    app,
    page,
    modelId: models.find((m) => m.kind === 'chat').id,
    modelCalls: () => modelCalls,
  });
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: '.artifacts/settings-smoke-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await new Promise((resolve) => mock.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
