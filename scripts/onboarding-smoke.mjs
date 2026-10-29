import assert from 'node:assert/strict';

// Run only against the smoke test's brand-new, isolated user directory. All PDD
// host operations are intercepted; the optional model test uses a local server.
export async function checkOnboarding({ app, page, modelBaseUrl }) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor();
  assert.equal(await page.locator('.sidebar').count(), 0);
  assert.equal(await page.getByRole('button', { name: '下一步：设置问答检索' }).isDisabled(), true);
  await page.screenshot({ path: '.artifacts/setup-connect.png', animations: 'disabled' });
  await app.evaluate(() => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const original = EventEmitter.prototype.emit;
    const state = { original, worker: null, connects: 0, verifies: 0, sends: 0, accountId: null };
    globalThis.__onboardingSmoke = state;
    EventEmitter.prototype.emit = function (event, ...args) {
      const data = args[0];
      if (event === 'message' && data?.type === 'result' && typeof this.postMessage === 'function')
        state.worker = this;
      if (event === 'message' && data?.type === 'host') {
        if (data.method === 'connect') {
          state.connects++;
          this.postMessage({ type: 'hostResult', id: data.id, ok: true, result: { opened: true } });
          return true;
        }
        if (data.method === 'verify' && data.args[0] === state.accountId) {
          state.verifies++;
          this.postMessage({ type: 'hostResult', id: data.id, ok: true, result: { ok: true } });
          return true;
        }
        if (data.method === 'send' && data.args[0]?.accountId === state.accountId) {
          state.sends++;
          this.postMessage({
            type: 'hostResult',
            id: data.id,
            ok: true,
            result: { status: 'confirmed', externalId: `setup-sent-${data.args[0].id}` },
          });
          return true;
        }
      }
      return original.call(this, event, ...args);
    };
  });
  const workerCall = (type, input) =>
    app.evaluate(
      async (_, { type, input }) => {
        const worker = globalThis.__onboardingSmoke.worker;
        if (!worker) throw new Error('Fixture worker not found');
        const id = `onboarding-${crypto.randomUUID()}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            worker.removeListener('message', listener);
            reject(new Error('Fixture IPC timed out'));
          }, 10000);
          const listener = (data) => {
            if (data.type !== 'result' || data.id !== id) return;
            clearTimeout(timer);
            worker.removeListener('message', listener);
            data.ok ? resolve(data.result) : reject(new Error(data.error));
          };
          worker.on('message', listener);
          worker.postMessage({ type, id, input });
        });
      },
      { type, input },
    );
  try {
    await page.evaluate(() => window.judesk.call('app.state'));
    // Skipping does not enable AI. The guide remains one click away.
    await page.getByRole('button', { name: '先人工接待，稍后配置' }).click();
    await page.getByRole('button', { name: /^上手引导/ }).waitFor();
    assert.equal(
      (await page.evaluate(() => window.judesk.call('onboarding.state'))).guideState,
      'dismissed',
    );
    await page.getByRole('button', { name: /^上手引导/ }).click();
    await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor();
    await page.getByRole('button', { name: '登录拼多多', exact: true }).click();
    assert.equal(await app.evaluate(() => globalThis.__onboardingSmoke.connects), 1);
    const account = await workerCall('account', {
      partition: 'persist:onboarding-smoke',
      mallId: 'onboarding-mall',
      mallName: '新手测试店',
      externalId: 'setup-cs',
      name: '小聚客服',
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: true,
        orders: false,
        verified: false,
      },
    });
    await app.evaluate((_, id) => {
      globalThis.__onboardingSmoke.accountId = id;
    }, account.id);
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.getByRole('button', { name: '下一步：设置问答检索' }).click();
    await page.getByRole('heading', { name: '先设置问答检索模型' }).waitFor();
    assert.equal(await page.getByLabel('类型', { exact: true }).count(), 0);
    await page.screenshot({ path: '.artifacts/setup-embedding.png', animations: 'disabled' });
    await page.getByLabel('API Base URL').fill(modelBaseUrl);
    await page.getByLabel('API Key').fill('local-fixture-key');
    await page.getByLabel('模型标识').fill('fixture-embed');
    await page.getByLabel('向量维度').fill('8');
    await page.getByRole('button', { name: '保存为全局检索模型' }).click();
    await page.getByText('已设为全局问答检索模型', { exact: false }).waitFor();
    const afterEmbedding = await page.evaluate(() => window.judesk.call('onboarding.state'));
    assert.equal(afterEmbedding.embedding.ready, true);
    assert.equal(afterEmbedding.embedding.model, 'fixture-embed');
    await page.getByRole('button', { name: '下一步：配置助手' }).click();
    await page.getByRole('heading', { name: '给客服助手接上 AI' }).waitFor();
    assert.equal(await page.getByLabel('输出 token 上限', { exact: true }).isVisible(), false);
    assert.equal(await page.getByLabel('类型', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '下一步：开始接待' }).isDisabled(), true);
    await page.getByLabel('API Base URL').fill(modelBaseUrl);
    await page.getByLabel('API Key').fill('local-fixture-key');
    await page.getByLabel('模型标识').fill('fixture');
    await page.screenshot({ path: '.artifacts/setup-model.png', animations: 'disabled' });
    const globalBefore = await page.evaluate(async () => {
      await window.judesk.call('app.settings', { developerModeEnabled: true });
      const list = await window.judesk.call('agents.list');
      await window.judesk.call('app.settings', { developerModeEnabled: false });
      return list.bindings;
    });
    await page.getByRole('button', { name: '保存并应用到本店助手' }).click();
    await page.getByRole('heading', { name: '新手测试店 · 客服助手' }).waitFor();
    const prepared = await page.evaluate(() => window.judesk.call('onboarding.state'));
    assert.equal(prepared.agent.ready, true);
    assert.equal(prepared.enabled, false);
    assert.equal(prepared.guideState, 'active');
    await page.getByRole('button', { name: '测试模型连接' }).click();
    await page.getByText('模型连接测试通过', { exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/setup-model-ready.png', animations: 'disabled' });
    await page.getByRole('button', { name: '重新配置模型', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '下一步：开始接待' }).isDisabled(), true);
    await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
    assert.equal(await page.getByLabel('API Key').inputValue(), '');
    await page.getByRole('button', { name: '取消修改', exact: true }).click();
    await page.getByRole('heading', { name: '新手测试店 · 客服助手' }).waitFor();
    // A renderer reload represents reopening the guide without in-memory step state.
    await page.reload();
    await page.getByRole('heading', { name: '检查好了，再交给 AI' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: '开启自动接待', exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: '.artifacts/setup-check.png', animations: 'disabled' });
    await page.getByRole('button', { name: '去接待中心做收发测试' }).click();
    await page.getByRole('button', { name: '继续配置', exact: true }).waitFor();
    // Receive and confirm a test manual reply through production IPC and queue logic.
    await workerCall('incoming', {
      accountId: account.id,
      externalId: 'setup-question',
      eventKey: 'setup-question',
      buyerId: 'setup-buyer',
      buyerName: '引导测试买家',
      conversationKey: 'setup-buyer',
      direction: 'in',
      origin: 'buyer',
      kind: 'text',
      text: '测试收发',
      timestamp: new Date().toISOString(),
      raw: {},
    });
    await page.getByText('引导测试买家', { exact: true }).click();
    await page
      .getByPlaceholder('输入回复内容，Enter 发送，Shift + Enter 换行…')
      .fill('这是一条本地测试回复');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('已发送', { exact: true }).waitFor();
    await page.getByRole('button', { name: '继续配置', exact: true }).click();
    await page.getByRole('button', { name: '确认「小聚客服」收发正常' }).click();
    const dialog = page.getByRole('dialog', { name: '确认账号可以正常接待' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '已在测试会话完成验证' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '开启自动接待', exact: true }).click();
    await page.getByRole('heading', { name: '可以开始接待了' }).waitFor();
    await page.screenshot({ path: '.artifacts/setup-complete.png', animations: 'disabled' });
    const complete = await page.evaluate(() => window.judesk.call('onboarding.state'));
    assert.equal(complete.enabled, true);
    assert.equal(complete.guideState, 'completed');
    assert.equal(complete.store.autoLearnEnabled, false);
    assert.equal(
      (await page.evaluate(() => window.judesk.call('app.state'))).settings.developerModeEnabled,
      false,
    );
    assert.equal(await app.evaluate(() => globalThis.__onboardingSmoke.verifies), 1);
    assert.equal(await app.evaluate(() => globalThis.__onboardingSmoke.sends), 1);
    await page.getByRole('button', { name: '进入接待中心', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '运行记录', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Agent 执行', exact: true }).count(), 0);
    await page.getByRole('button', { name: /^系统设置/ }).click();
    assert.equal(await page.getByLabel('问答直答阈值', { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('switch', { name: '显示开发者工具' }).count(), 0);
    await page.screenshot({ path: '.artifacts/settings-grouped.png', animations: 'disabled' });
    await page.getByRole('tab', { name: '模型服务', exact: false }).click();
    await page.getByRole('button', { name: '添加自有模型', exact: true }).waitFor();
    assert.equal(await page.getByLabel('意图向量模型', { exact: true }).isVisible(), false);
    await page.getByRole('tab', { name: '高级定制', exact: false }).click();
    await page.getByRole('switch', { name: '显示开发者工具' }).click();
    const bindingsAfter = (await page.evaluate(() => window.judesk.call('agents.list'))).bindings;
    assert.deepEqual(
      bindingsAfter.filter((b) => b.scopeKey === 'global'),
      globalBefore,
    );
    assert.equal(bindingsAfter.filter((b) => b.scopeKey === `store:${account.storeId}`).length, 1);
    await page.getByRole('button', { name: /^上手引导/ }).click();
    await page.getByRole('heading', { name: '检查好了，再交给 AI' }).waitFor();
    await page.getByRole('button', { name: '配置助手 准备对话模型', exact: false }).click();
    await page.getByRole('heading', { name: '新手测试店 · 客服助手' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存并应用到本店助手' }).count(), 0);
    await app.evaluate(({ BrowserWindow }) => {
      const win =
        BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('句达')) ||
        BrowserWindow.getAllWindows()[0];
      win.setSize(1120, 780);
    });
    await page.screenshot({ path: '.artifacts/setup-compact.png', animations: 'disabled' });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    // Day-to-day settings reuse the same apply flow, including existing global defaults.
    await page.getByRole('button', { name: '返回接待中心', exact: true }).click();
    await page.getByRole('button', { name: '店铺管理', exact: true }).click();
    await page
      .locator('.settings-progress')
      .getByRole('button', { name: /平台账号/ })
      .click();
    await page.screenshot({
      path: '.artifacts/settings-connect-compact.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '下一步：配置助手' }).click();
    await page.getByRole('button', { name: '重新配置模型', exact: true }).waitFor();
    await page.screenshot({
      path: '.artifacts/settings-assistant-compact.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '系统设置', exact: true }).click();
    await page.getByRole('tab', { name: /模型服务/ }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const modelDialog = page.getByRole('dialog', { name: '编辑模型服务' });
    assert.equal(await modelDialog.getByLabel('API Key').inputValue(), '');
    await modelDialog.getByLabel('模型标识').fill('updated-fixture');
    await modelDialog.getByRole('button', { name: '保存模型服务' }).click();
    await modelDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '前往店铺配置助手' }).click();
    await page.getByText(/模型服务的参数已有更新/).waitFor();
    await page.getByRole('button', { name: '重新配置模型', exact: true }).click();
    await page.getByRole('button', { name: '保存并应用到本店助手', exact: true }).click();
    await page.getByText('模型已应用到「新手测试店」的客服助手', { exact: true }).waitFor();
    const updated = await page.evaluate(
      (storeId) => window.judesk.call('onboarding.state', { storeId }),
      account.storeId,
    );
    assert.equal(updated.agent.model, 'updated-fixture');
    assert.equal(updated.agent.modelChanged, false);
    assert.equal(updated.enabled, true);
    await page.evaluate(
      (defaultModelId) => window.judesk.call('app.settings', { defaultModelId }),
      prepared.agent.modelId,
    );
    // Existing users can have a published built-in default whose prompt differs from today's template.
    const customizedDefault = await page.evaluate(async () => {
      await window.judesk.call('app.settings', { developerModeEnabled: true });
      const { agents } = await window.judesk.call('agents.list');
      const current = agents.find((agent) => agent.origin === 'builtin_default');
      const saved = await window.judesk.call('agents.save', {
        id: current.id,
        expectedRevision: current.draftRevision,
        config: { ...current.draftConfig, prompt: '保留店主已发布的接待规范。' },
      });
      const published = await window.judesk.call('agents.publish', {
        id: saved.id,
        expectedRevision: saved.draftRevision,
      });
      await window.judesk.call('app.settings', { developerModeEnabled: false });
      return published.configSnapshot;
    });
    const other = await workerCall('account', {
      partition: 'persist:onboarding-second',
      mallId: 'second-mall',
      mallName: '第二家测试店',
      externalId: 'second-cs',
      name: '第二店客服',
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: true,
        orders: false,
        verified: false,
      },
    });
    await page
      .getByRole('complementary', { name: '选择配置店铺' })
      .getByRole('button', { name: /第二家测试店/ })
      .click();
    await page
      .locator('.settings-progress')
      .getByRole('button', { name: /客服助手/ })
      .click();
    await page.getByRole('heading', { name: '默认自动回复', exact: true }).waitFor();
    await page.getByRole('button', { name: '重新配置模型', exact: true }).click();
    await page.getByRole('button', { name: '添加模型服务', exact: true }).click();
    await page.getByLabel('API Base URL').fill(modelBaseUrl);
    await page.getByLabel('模型标识').fill('second-fixture');
    await page.getByRole('button', { name: '保存并应用到本店助手' }).click();
    await page.getByText('模型已应用到「第二家测试店」的客服助手', { exact: true }).waitFor();
    const states = await page.evaluate(
      async ({ a, b }) =>
        Promise.all([
          window.judesk.call('onboarding.state', { storeId: a }),
          window.judesk.call('onboarding.state', { storeId: b }),
        ]),
      { a: account.storeId, b: other.storeId },
    );
    assert.equal(states[0].agent.model, 'updated-fixture');
    assert.equal(states[1].agent.model, 'second-fixture');
    assert.equal(states[1].agent.source, 'store');
    assert.equal(states[1].enabled, false);
    const appliedConfig = await page.evaluate(async (storeId) => {
      await window.judesk.call('app.settings', { developerModeEnabled: true });
      try {
        const { agents, bindings } = await window.judesk.call('agents.list');
        const revisionId = bindings.find((b) => b.scopeKey === `store:${storeId}`).agentRevisionId;
        return agents.flatMap((a) => a.revisions).find((r) => r.id === revisionId).configSnapshot;
      } finally {
        await window.judesk.call('app.settings', { developerModeEnabled: false });
      }
    }, other.storeId);
    assert.equal(appliedConfig.prompt, customizedDefault.prompt);
    assert.deepEqual(appliedConfig.assetLock, customizedDefault.assetLock);
    await page.screenshot({
      path: '.artifacts/settings-applied-compact.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '下一步：开启接待', exact: true }).click();
    await page.screenshot({
      path: '.artifacts/settings-reception-compact.png',
      animations: 'disabled',
    });
    assert.equal(
      await page.getByRole('switch', { name: 'AI 自动回复', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.getByRole('button', { name: '系统设置', exact: true }).click();
    await page.getByRole('tab', { name: /模型服务/ }).click();
    await page.screenshot({
      path: '.artifacts/settings-models-compact.png',
      animations: 'disabled',
    });
    assert.deepEqual(errors, []);
    console.log(
      'Onboarding passed: focused first launch, skip/resume, account detection, model save + store-scoped assistant, explicit model test, persisted progress, verification gate, manual receipt, explicit enable, custom binding preservation and grouped settings.',
    );
  } finally {
    await app.evaluate(() => {
      process.getBuiltinModule('node:events').EventEmitter.prototype.emit =
        globalThis.__onboardingSmoke.original;
      delete globalThis.__onboardingSmoke;
    });
  }
}
