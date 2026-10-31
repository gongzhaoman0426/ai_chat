import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Called by the desktop smoke with an isolated profile and a local model endpoint.
export async function checkAgentStudio({ app, page, modelId, modelCalls }) {
  const bindingsBefore = await page.evaluate(
    async () => (await window.judesk.call('agents.list')).bindings,
  );
  await page.evaluate(async (modelProfileId) => {
    const child = await window.judesk.call('agents.save', {
      config: {
        name: '售后协作助手',
        description: '协助核实售后问题，必要时交由人工处理。',
        prompt: '根据已知信息处理售后问题。',
        modelProfileId,
      },
    });
    await window.judesk.call('agents.publish', {
      id: child.id,
      expectedRevision: child.draftRevision,
    });
  }, modelId);
  await page.getByRole('button', { name: '助手', exact: true }).click();
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建 Agent', exact: true });
  assert.equal(await create.getByRole('button', { name: '创建并编排' }).isDisabled(), true);
  assert.equal(await create.getByLabel('系统提示词').count(), 0);
  await create.getByLabel('Agent 名称', { exact: true }).fill('山野生活 · 售前助手');
  await create
    .getByLabel('说明（选填）', { exact: true })
    .fill('解答商品规格、使用方式和发货问题，让每一位买家得到及时、可靠的回应。');
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: '.artifacts/agent-create.png', animations: 'disabled' });
  await create.getByRole('button', { name: '创建并编排' }).click();
  const studio = page.locator('.agent-studio-dialog');
  await studio.waitFor();
  assert.equal(await studio.getByRole('button', { name: '发布并应用', exact: true }).count(), 0);
  assert.equal(await studio.getByRole('button', { name: '发布版本', exact: true }).count(), 0);
  assert.equal(await studio.getByRole('button', { name: '发布', exact: true }).count(), 1);
  assert.equal(await studio.getByLabel('对话模型', { exact: true }).inputValue(), modelId);
  const prompt =
    '# 角色\n你是山野生活旗舰店的售前客服，耐心、简洁地解答买家的问题。\n\n# 回复原则\n1. 优先参考店铺问答库与工具查询结果。\n2. 商品规格、库存和发货时间需要有明确依据。\n3. 无法确定时转人工，不做未经确认的承诺。\n\n# 表达方式\n语气自然友好，一次回应一个核心问题。';
  await studio.getByLabel('系统提示词', { exact: true }).fill(prompt);

  // Cancel keeps the current mount set intact; confirm applies the chosen resources.
  await studio.getByRole('button', { name: '添加 Toolkit', exact: true }).click();
  let picker = page.getByRole('dialog', { name: '挂载 Toolkit', exact: true });
  await picker.getByLabel('搜索资源').fill('不存在的集合');
  await picker.getByText('没有匹配的资源，试试其他关键词。').waitFor();
  await picker.getByLabel('搜索资源').fill('');
  assert.equal(await picker.getByRole('checkbox', { name: '拼多多查询', exact: true }).count(), 0);
  assert.equal(
    await picker.getByRole('checkbox', { name: '拼多多客服工具箱', exact: true }).count(),
    0,
  );
  await picker.getByRole('checkbox', { name: '店铺客服工具', exact: true }).uncheck();
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(
    await studio.locator('.studio-mounted').filter({ hasText: '店铺客服工具' }).count(),
    1,
  );
  await studio.getByRole('button', { name: '添加 Toolkit', exact: true }).click();
  picker = page.getByRole('dialog', { name: '挂载 Toolkit', exact: true });
  await picker.getByRole('checkbox', { name: '店铺客服工具', exact: true }).uncheck();
  await picker.getByRole('checkbox', { name: '店铺客服工具', exact: true }).check();
  await page.screenshot({ path: '.artifacts/agent-mount-picker.png', animations: 'disabled' });
  await picker.getByRole('button', { name: '确认挂载', exact: true }).click();
  assert.equal(await studio.getByRole('button', { name: '添加 Workflow' }).count(), 0);
  await studio.getByRole('button', { name: '添加子 Agent', exact: true }).click();
  picker = page.getByRole('dialog', { name: '挂载子 Agent', exact: true });
  assert.equal(await picker.getByLabel('发布版本', { exact: true }).count(), 0);
  await picker.getByRole('button', { name: /售后协作助手/ }).click();
  await picker.getByLabel('调用别名', { exact: true }).fill('after_sales');
  await picker.getByRole('button', { name: '确认挂载', exact: true }).click();
  await studio.getByRole('button', { name: '编辑子 Agent after_sales', exact: true }).click();
  picker = page.getByRole('dialog', { name: '编辑子 Agent', exact: true });
  await picker.getByLabel('调用别名', { exact: true }).fill('support');
  await picker.getByRole('button', { name: '保存挂载', exact: true }).click();
  await studio.getByRole('button', { name: '记忆与执行', exact: true }).click();
  await studio.getByLabel('近期消息数', { exact: true }).fill('12');
  await studio.getByLabel('最大执行步骤', { exact: true }).fill('6');
  await studio.getByLabel('子 Agent 最大深度', { exact: true }).fill('3');
  await studio.getByRole('switch', { name: '启用会话工作记忆', exact: true }).click();
  await studio.getByText('已保存到本机', { exact: true }).waitFor();
  const saved = await page.evaluate(async () =>
    (await window.judesk.call('agents.list')).agents.find((a) => a.name === '山野生活 · 售前助手'),
  );
  assert.equal(saved.draftConfig.prompt, prompt);
  assert.equal(saved.draftConfig.maxSteps, 6);
  assert.equal(saved.draftConfig.maxDepth, 3);
  assert.deepEqual(saved.draftConfig.memory, { lastMessages: 12, workingMemory: true });
  assert.equal(saved.draftConfig.toolkitIds.length, 2);
  assert.ok(saved.draftConfig.toolkitIds.includes('builtin/commerce'));
  assert.ok(!saved.draftConfig.toolkitIds.some((id) => id.startsWith('builtin/pdd@')));
  assert.ok(!saved.draftConfig.toolkitIds.includes('builtin/pdd@1.0.0'));
  assert.equal(saved.draftConfig.workflowIds, undefined);
  assert.equal(saved.draftConfig.subAgents[0].alias, 'support');
  await studio.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
  await page.locator('.agent-card').filter({ hasText: '山野生活 · 售前助手' }).click();
  await studio.getByRole('button', { name: '记忆与执行', exact: true }).click();
  assert.equal(await studio.getByLabel('近期消息数', { exact: true }).inputValue(), '12');
  assert.equal(
    await studio.getByRole('switch', { name: '启用会话工作记忆' }).getAttribute('aria-checked'),
    'true',
  );
  await studio.getByRole('button', { name: '人设与回复逻辑', exact: true }).click();
  assert.equal(await studio.getByLabel('系统提示词', { exact: true }).inputValue(), prompt);
  assert.equal(await studio.locator('.studio-mounted').count(), 4);

  // Invalid drafts remain visible and cannot disappear through Escape/close.
  await studio.getByLabel('系统提示词', { exact: true }).fill('');
  await studio.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
  const leaving = page.getByRole('dialog', { name: '还有未保存的修改', exact: true });
  await leaving.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await studio.getByLabel('系统提示词', { exact: true }).inputValue(), '');
  await studio.getByLabel('系统提示词', { exact: true }).fill(prompt);
  await studio.getByRole('button', { name: '发布', exact: true }).click();
  await studio.locator('.studio-statusbar').getByText('已发布', { exact: true }).waitFor();
  assert.doesNotMatch(await studio.locator('.studio-statusbar').innerText(), /\bv\d+|草稿 r\d+/);
  const callsBefore = modelCalls();
  await studio.getByLabel('试运行买家消息').fill('你好，这款保温杯什么时候可以发货？');
  await studio.getByRole('button', { name: '试运行', exact: true }).click();
  await studio
    .locator('.studio-agent-message')
    .getByText('单次模型回复成功', { exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    modelCalls(),
    callsBefore + 1,
    'one click makes only the original reply model request',
  );
  await studio.getByRole('heading', { name: '能力配置', exact: true }).click();
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: '.artifacts/agent-studio.png', animations: 'disabled' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await page.waitForFunction(() => window.innerWidth === 1120);
  const boxes = await studio.evaluate((element) => ({
    fits: element.scrollWidth <= element.clientWidth,
    panels: [...element.querySelectorAll('.studio-panel')].map((panel) => {
      const rect = panel.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    }),
  }));
  assert.equal(boxes.fits, true);
  assert.ok(boxes.panels.every((panel) => panel.width > 230 && panel.right <= 1120));
  await studio.getByRole('button', { name: '试运行', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/agent-studio-compact.png', animations: 'disabled' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.waitForFunction(() => window.innerWidth === 1440);

  await studio.getByLabel('系统提示词', { exact: true }).fill('需要被历史版本替换的草稿');
  await studio.getByText('已保存到本机', { exact: true }).waitFor();
  await studio.locator('.studio-statusbar').getByText('有修改待发布', { exact: true }).waitFor();
  await studio.getByRole('button', { name: '更多 Agent 操作', exact: true }).click();
  await studio.getByRole('button', { name: '发布记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '发布记录', exact: true });
  await history.getByRole('button', { name: '恢复为草稿', exact: true }).click();
  await page
    .getByRole('dialog', { name: '恢复发布记录为草稿', exact: true })
    .getByRole('button', { name: '确认恢复', exact: true })
    .click();
  await page.locator('.studio-history-list').waitFor({ state: 'detached' });
  assert.equal(await studio.getByLabel('系统提示词', { exact: true }).inputValue(), prompt);

  // A concurrent save must not be silently overwritten by this editor's autosave.
  await page.evaluate(async (id) => {
    const current = (await window.judesk.call('agents.list')).agents.find((a) => a.id === id);
    await window.judesk.call('agents.save', {
      id,
      expectedRevision: current.draftRevision,
      config: { ...current.draftConfig, prompt: '另一处已经保存的草稿' },
    });
  }, saved.id);
  await studio.getByLabel('系统提示词', { exact: true }).fill('本窗口尚未保存的修改');
  await studio
    .locator('.studio-notice')
    .getByText(/草稿已被修改/)
    .waitFor();
  assert.equal(
    await studio.getByLabel('系统提示词', { exact: true }).inputValue(),
    '本窗口尚未保存的修改',
  );
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await window.judesk.call('agents.list')).agents.find((a) => a.id === id).draftConfig
          .prompt,
      saved.id,
    ),
    '另一处已经保存的草稿',
  );
  await studio.getByRole('button', { name: '重新加载草稿', exact: true }).click();
  await page
    .getByRole('dialog', { name: '重新加载已保存的草稿', exact: true })
    .getByRole('button', { name: '重新加载', exact: true })
    .click();
  await studio.getByText('已保存到本机', { exact: true }).waitFor();
  assert.equal(
    await studio.getByLabel('系统提示词', { exact: true }).inputValue(),
    '另一处已经保存的草稿',
  );

  const exportPath = resolve('.artifacts/agent-export.json');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await studio.getByRole('button', { name: '更多 Agent 操作', exact: true }).click();
  await studio.getByRole('button', { name: '导出配置', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="更多 Agent 操作"]').disabled,
  );
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.config.prompt, '另一处已经保存的草稿');
  assert.equal(exported.config.subAgents[0].alias, 'support');
  await studio.getByRole('button', { name: '更多 Agent 操作', exact: true }).click();
  await studio.getByRole('button', { name: '复制为新 Agent', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('#studio-agent-name')?.value.endsWith(' 副本'),
  );
  assert.equal(await studio.locator('.studio-mounted').count(), 4);
  await studio.getByText('未发布', { exact: true }).waitFor();
  await studio.getByRole('button', { name: '更多 Agent 操作', exact: true }).click();
  await studio.getByRole('button', { name: '删除 Agent', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除「山野生活 · 售前助手 副本」？', exact: true })
    .getByRole('button', { name: '删除 Agent', exact: true })
    .click();
  await studio.waitFor({ state: 'hidden' });
  const after = await page.evaluate(() => window.judesk.call('agents.list'));
  assert.equal(after.agents.filter((a) => a.name.endsWith(' 副本')).length, 0);
  assert.deepEqual(
    after.bindings,
    bindingsBefore,
    'publishing/restoring/editing do not activate a different working agent',
  );
  await page.getByRole('button', { name: '助手', exact: true }).click();
  assert.equal(await page.getByLabel('回复策略入口', { exact: true }).count(), 0);
  const globalBinding = page.locator('.binding-card').filter({ hasText: '全局默认助手' });
  assert.equal(await globalBinding.locator('select').count(), 1);
  assert.doesNotMatch(await globalBinding.locator('select').innerText(), /· v\d+/);
  const options = await globalBinding
    .locator('select option')
    .evaluateAll((rows) => rows.map((r) => r.value).filter(Boolean));
  assert.equal(new Set(options).size, options.length);
  await globalBinding
    .getByText('选择后应用即可。之后发布此 Agent，店铺会自动更新。', {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: '.artifacts/agent-binding.png', animations: 'disabled' });
  console.log(
    'Agent Studio UI: create, mount, autosave, reopen, debug, publish/restore, conflicts, export, copy/delete, compact layout passed',
  );
}
