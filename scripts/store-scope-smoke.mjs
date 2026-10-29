import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

export async function checkStoreScopes({ app, page, dbFile, imagePath }) {
  const db = createClient({ url: pathToFileURL(dbFile).href });
  const other = 'scope-other-store';
  const call = (method, input = {}) =>
    page.evaluate(({ method, input }) => window.judesk.call(method, input), { method, input });
  let agentId, skillId;
  const qaIds = [];
  try {
    await db.batch(
      [
        {
          sql: 'INSERT INTO Store (id,platform,externalId,name) VALUES (?,?,?,?)',
          args: [other, 'douyin', 'scope-other', '范围测试另一店'],
        },
        {
          sql: 'INSERT INTO Account (id,storeId,externalId,name,sessionPartition,status,capabilities) VALUES (?,?,?,?,?,?,?)',
          args: [
            'scope-other-account',
            other,
            'scope-cs',
            '范围测试客服',
            'persist:scope-other',
            'offline',
            '{}',
          ],
        },
      ],
      'write',
    );
    await call('app.settings', { developerModeEnabled: true });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, imagePath);
    await page.getByRole('button', { name: '问答库', exact: true }).click();
    // Create a shared image through the actual scope selector, not only the IPC.
    await page.getByRole('button', { name: '新建问答', exact: true }).click();
    let modal = page.getByRole('dialog');
    await modal.getByRole('combobox', { name: '所属店铺' }).selectOption('');
    assert.ok(await modal.getByLabel(/^适用商品 ID/).isDisabled());
    await modal.getByPlaceholder('例如：这款商品多久可以发货？').fill('__SCOPE__通用图片');
    await modal.getByRole('button', { name: '图片回答', exact: true }).click();
    await modal.locator('.upload-zone').click();
    await modal.locator('.upload-zone img').waitFor();
    await modal.getByRole('button', { name: '保存并启用', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const shared = (await call('knowledge.list', { storeId: null })).find(
      (e) => e.revisions[0].intent === '__SCOPE__通用图片',
    );
    assert.ok(shared);
    qaIds.push(shared.id);
    assert.equal(shared.storeId, null);
    for (const [storeId, intent] of [
      [null, '__SCOPE__通用文字'],
      ['demo-store', '__SCOPE__本店文字'],
      [other, '__SCOPE__其他店文字'],
    ]) {
      const result = await call('knowledge.save', {
        storeId,
        qa: {
          intent,
          answerKind: 'text',
          answer: intent,
          scope: { productIds: [], conditions: '' },
        },
      });
      qaIds.push(result.entryId);
    }
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.getByText('小林同学', { exact: true }).click();
    await page.getByRole('button', { name: '话术', exact: true }).click();
    modal = page.getByRole('dialog');
    await modal.getByRole('textbox', { name: '搜索话术' }).fill('__SCOPE__');
    await modal.getByRole('button', { name: '发送话术：__SCOPE__通用图片', exact: true }).waitFor();
    assert.equal(await modal.locator('.quick-reply-card').count(), 3);
    assert.equal(
      await modal
        .getByRole('button', { name: '发送话术：__SCOPE__其他店文字', exact: true })
        .count(),
      0,
    );
    await modal
      .getByRole('button', { name: '发送话术：__SCOPE__通用图片', exact: true })
      .locator('img')
      .waitFor();
    await page.screenshot({
      path: '.artifacts/shared-store-quick-replies.png',
      animations: 'disabled',
    });
    await modal.getByRole('button', { name: '关闭弹窗', exact: true }).click();

    // Existing QA can be explicitly bound and unbound, with a new content revision.
    await page.getByRole('button', { name: '问答库', exact: true }).click();
    for (const target of ['demo-store', '']) {
      await page
        .getByRole('row')
        .filter({ hasText: '__SCOPE__通用文字' })
        .getByTitle('编辑问答')
        .click();
      const editor = page.getByRole('dialog');
      await editor.getByRole('combobox', { name: '所属店铺' }).selectOption(target);
      await editor.getByRole('button', { name: '保存并启用', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      const otherEntries = await call('knowledge.list', { storeId: other });
      assert.equal(
        otherEntries.some((entry) => entry.revisions[0].intent === '__SCOPE__通用文字'),
        target === '',
      );
    }

    // One identical scope editor is used for each of the four resource kinds.
    const restrict = async (kind, id) => {
      await page.getByRole('button', { name: /^可用店铺：/ }).click();
      const scopeModal = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { name: '配置可用店铺', exact: true }) });
      await scopeModal.getByRole('combobox', { name: '可用店铺范围' }).selectOption('selected');
      const label = scopeModal
        .locator('.scope-store-list label')
        .filter({ hasText: '山野生活旗舰店' });
      await label.getByRole('checkbox').check();
      await scopeModal.getByRole('button', { name: '保存可用店铺', exact: true }).click();
      await scopeModal.waitFor({ state: 'hidden' });
      const rows = await call('resources.scopes');
      const row = rows.find((r) => r.kind === kind && r.resourceId === id.split('@')[0]);
      assert.deepEqual(row.storeIds, ['demo-store']);
      assert.equal(row.mode, 'selected');
      return row;
    };
    await page.getByRole('button', { name: 'Agent Studio', exact: true }).click();
    await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
    modal = page.getByRole('dialog');
    await modal.getByRole('textbox', { name: 'Agent 名称' }).fill('__SCOPE__共享客服');
    await modal.getByRole('combobox', { name: '可用店铺范围' }).selectOption('all');
    await modal.getByRole('button', { name: '创建并编排', exact: true }).click();
    await page.getByRole('dialog', { name: '编排 Agent', exact: true }).waitFor();
    agentId = (await call('agents.list')).agents.find((a) => a.name === '__SCOPE__共享客服').id;
    await restrict('agent', agentId);
    await page.locator('.agent-scope-preview summary').click();
    await page.getByRole('combobox', { name: '预览店铺' }).selectOption(other);
    await page.getByText('此 Agent 未授权该店铺，不能在该店运行。', { exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/agent-store-scope.png', animations: 'disabled' });
    await page.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
    const skill = await call('skills.save', {
      config: {
        name: 'scope-smoke-skill',
        description: '范围测试',
        instructions: '测试规则',
        references: {},
        scripts: {},
      },
    });
    skillId = skill.id;
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.getByRole('button', { name: '编辑 Skill scope-smoke-skill', exact: true }).click();
    await restrict('skill', skillId);
    await page.getByRole('button', { name: '关闭技能编辑器', exact: true }).click();
    for (const [kind, label, id] of [
      ['toolkit', 'Toolkit', 'builtin/utilities@1.0.0'],
      ['workflow', 'Workflow', 'builtin/reply-helpers@1.0.0'],
    ]) {
      const asset = (await call('assets.list')).assets.find((a) => a.id === id);
      await page.getByRole('button', { name: label, exact: true }).click();
      await page
        .locator('.asset-card')
        .filter({ has: page.getByRole('heading', { name: asset.manifest.name, exact: true }) })
        .click();
      const row = await restrict(kind, id);
      // Restore the shared built-ins before the other desktop fixtures run.
      await call('resources.setScope', {
        kind,
        resourceId: id,
        expectedRevision: row.revision,
        mode: 'all',
        storeIds: [],
      });
      await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
    }
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.scroll <= layout.width + 1);
    console.log(
      'Resource/shop scope UI passed: all four editors, immediate permissions, Agent preview, shared image creation and general+own quick replies without other shops. Fixture only.',
    );
  } finally {
    for (const id of qaIds) {
      const result = await db.execute({
        sql: 'SELECT activeRevisionId FROM KnowledgeEntry WHERE id=?',
        args: [id],
      });
      if (result.rows.length)
        await call('knowledge.delete', {
          id,
          expectedRevisionId: result.rows[0].activeRevisionId,
        });
    }
    if (agentId) await call('agents.delete', { id: agentId });
    if (skillId) {
      const skill = (await call('skills.list')).find((s) => s.id === skillId);
      if (skill) await call('skills.delete', { id: skillId, expectedRevision: skill.revision });
    }
    await call('accounts.remove', { accountId: 'scope-other-account' }).catch(() => {});
    db.close();
  }
}
