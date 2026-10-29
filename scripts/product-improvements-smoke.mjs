import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

export async function checkProductImprovements({ page, dbFile }) {
  const call = (method, input = {}) =>
    page.evaluate(({ method, input }) => window.judesk.call(method, input), { method, input });
  const db = createClient({ url: pathToFileURL(dbFile).href });
  try {
    // Isolated fixture conversation: opening must not mutate reception ownership or revision.
    await db.execute(
      "UPDATE OutboundMessage SET status='cancelled' WHERE conversationId='demo-c0' AND status IN ('prepared','dispatching','unknown')",
    );
    let conversation = (await call('conversations.list', { storeId: 'demo-store' })).find(
      (c) => c.id === 'demo-c0',
    );
    await call('conversations.reception', {
      conversationId: conversation.id,
      mode: 'ai',
      expectedRevision: conversation.revision,
    });
    conversation = (await call('conversations.list', { storeId: 'demo-store' })).find(
      (c) => c.id === 'demo-c0',
    );
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.locator('.conversation-list').getByText('小林同学', { exact: true }).click();
    await page.getByRole('button', { name: '接管会话', exact: true }).waitFor();
    const viewing = (await call('conversations.list', { storeId: 'demo-store' })).find(
      (c) => c.id === 'demo-c0',
    );
    assert.equal(viewing.openedByHuman, false);
    assert.equal(viewing.revision, conversation.revision);
    await page.getByRole('button', { name: '接管会话', exact: true }).click();
    await page.getByRole('button', { name: '交还 AI', exact: true }).waitFor();
    await page.getByRole('button', { name: '问答库', exact: true }).click();
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.locator('.conversation-list').getByText('小林同学', { exact: true }).click();
    await page.getByRole('button', { name: '交还 AI', exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/explicit-reception.png', animations: 'disabled' });
    await page.getByRole('button', { name: '交还 AI', exact: true }).click();
    await page.getByRole('button', { name: '接管会话', exact: true }).waitFor();
    assert.equal(
      (await call('conversations.list', { storeId: 'demo-store' })).find((c) => c.id === 'demo-c0')
        .openedByHuman,
      false,
    );

    const common = await call('knowledge.save', {
      storeId: null,
      qa: {
        intent: '发货时间（规则测试）',
        answerKind: 'text',
        answer: '48 小时内发货',
        scope: { productIds: [], conditions: '' },
      },
    });
    await page.getByRole('button', { name: '问答库', exact: true }).click();
    await page.getByRole('button', { name: '新建问答', exact: true }).click();
    let modal = page.getByRole('dialog');
    await modal.getByRole('combobox', { name: '所属店铺', exact: true }).selectOption('demo-store');
    await modal.getByPlaceholder('例如：这款商品多久可以发货？').fill('本店发货规则测试');
    await modal.getByPlaceholder('填写经过确认的标准回答…').fill('72 小时内发货');
    await modal
      .getByRole('combobox', { name: '覆盖通用问答', exact: true })
      .selectOption(common.entryId);
    await modal.getByText('相关规则与生效顺序', { exact: true }).waitFor();
    await modal.getByText('48 小时内发货', { exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/knowledge-override.png', animations: 'disabled' });
    await modal.getByRole('button', { name: '保存并启用', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const saved = (await call('knowledge.list', { storeId: 'demo-store' })).find(
      (e) => e.revisions[0]?.intent === '本店发货规则测试',
    );
    assert.equal(saved.revisions[0].scope.overridesEntryId, common.entryId);

    await call('app.settings', { developerModeEnabled: true });
    const model = (await call('models.list')).find((m) => m.kind === 'chat');
    const agent = await call('agents.save', {
      config: {
        name: '接待配置验收助手',
        prompt: '按本店规则回答。',
        modelProfileId: model.id,
        toolkitIds: ['builtin/commerce@1.0.0'],
      },
    });
    await page.getByRole('button', { name: 'Agent Studio', exact: true }).click();
    await page.locator('.agent-card').filter({ hasText: '接待配置验收助手' }).click();
    const studio = page.locator('.agent-studio-dialog');
    await studio.getByRole('button', { name: '发布', exact: true }).click();
    await studio.locator('.studio-statusbar').getByText('已发布', { exact: true }).waitFor();
    await studio.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
    await page.getByRole('button', { name: '工作绑定', exact: true }).click();
    const binding = page.locator('.binding-card').filter({ hasText: '山野生活旗舰店' });
    await binding.getByLabel('工作回复 Agent', { exact: true }).selectOption(agent.id);
    await binding.getByRole('button', { name: '应用配置', exact: true }).click();
    await page.locator('.toast').getByText('工作绑定已切换').waitFor();
    const overview = await call('stores.configuration', { storeId: 'demo-store' });
    assert.equal(overview.agent.id, agent.id);
    assert.equal(overview.agent.source, 'store');
    assert.equal(overview.agent.draftChanged, false);
    await page.getByRole('button', { name: '店铺管理', exact: true }).click();
    await page.getByText('查看当前生效配置与工具', { exact: true }).click();
    const card = page.getByRole('region', { name: '当前接待配置', exact: true }).first();
    await card.getByText('接待配置验收助手', { exact: true }).first().waitFor();
    await card.locator('.working-config-resources > summary').click();
    await card.getByText('店铺客服工具', { exact: true }).waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.artifacts/working-configuration.png', animations: 'disabled' });
    const previous = page.viewportSize();
    await page.setViewportSize({ width: 1024, height: 760 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
    await page.screenshot({
      path: '.artifacts/working-configuration-compact.png',
      animations: 'disabled',
    });
    if (previous) await page.setViewportSize(previous);
    console.log(
      'Product improvements: view/takeover/release, knowledge override, atomic publish/apply and effective configuration UI passed',
    );
  } finally {
    db.close();
  }
}
