import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';

// Used only by workbench-smoke with its fresh profile and intercepted platform transport.
export async function checkProductNavigation({ app, page, accounts, dir }) {
  const call = (method, input = {}) =>
    page.evaluate(({ method, input }) => window.judesk.call(method, input), { method, input });
  const nav = page.getByRole('complementary', { name: '主导航' });
  const close = () =>
    page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  await nav.getByRole('button', { name: '问答库', exact: true }).click();
  const qa = (intent, answer = '这是已确认的标准回答。') => ({
    intent,
    answer,
    answerKind: 'text',
    scope: { productIds: [], conditions: '' },
  });
  for (const [storeId, intent, answer] of [
    [null, '客服在线问候', '在的，请问有什么可以帮您？'],
    [accounts[0].storeId, '服饰店发货说明', '订单付款后按商品详情约定的时间发货。'],
    [accounts[1].storeId, '数码服务交付方式', '授权内容会通过闲鱼会话交付，请留意消息。'],
  ])
    await call('knowledge.save', { storeId, qa: qa(intent, answer) });
  const imagePath = join(dir, 'qa-fixture.png');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 280;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e9f3ef';
    ctx.fillRect(0, 0, 480, 280);
    ctx.fillStyle = '#34735e';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('操作指引', 35, 65);
    ctx.font = '22px sans-serif';
    ctx.fillText('1. 进入订单页面', 35, 120);
    ctx.fillText('2. 核对商品与收货信息', 35, 170);
    ctx.fillText('3. 有问题随时联系客服', 35, 220);
    return canvas.toDataURL().split(',')[1];
  });
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, imagePath);
  await page.getByRole('button', { name: '新建问答', exact: true }).click();
  let editor = page.getByRole('dialog');
  assert.equal(await editor.getByLabel('所属店铺', { exact: true }).inputValue(), '');
  await editor.getByPlaceholder('例如：这款商品多久可以发货？').fill('通用操作指引图片');
  await editor.getByRole('button', { name: '图片回答', exact: true }).click();
  await editor.locator('.upload-zone').click();
  await editor.locator('.upload-zone img').waitFor();
  await editor.getByRole('button', { name: '保存并启用', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const imageQa = (await call('knowledge.list', { scope: 'all' })).find(
    (entry) => entry.revisions[0]?.intent === '通用操作指引图片',
  );
  for (const [storeId, input] of [
    [null, qa('待删除的文字问答')],
    [
      accounts[0].storeId,
      {
        ...qa('待删除的图片问答'),
        answerKind: 'image',
        attachmentId: imageQa.revisions[0].attachmentId,
      },
    ],
  ]) {
    const revision = await call('knowledge.save', { storeId, qa: input });
    if (input.answerKind === 'image')
      await call('knowledge.status', {
        id: revision.entryId,
        status: 'disabled',
        expectedRevisionId: revision.id,
      });
  }
  await page.getByLabel('问答所属范围').selectOption('all');
  assert.equal(await page.getByRole('button', { name: '归档', exact: true }).count(), 0);
  assert.equal(
    await page.getByLabel('问答所属范围').locator('option[value="archived"]').count(),
    0,
  );
  for (const intent of ['待删除的文字问答', '待删除的图片问答']) {
    const row = page.locator('.knowledge-table tbody tr').filter({ hasText: intent });
    await row.getByRole('button', { name: `删除问答 ${intent}`, exact: true }).click();
    const deleting = page.getByRole('dialog', { name: '删除这条问答？', exact: true });
    await deleting.getByText(intent, { exact: true }).waitFor();
    if (intent.includes('图片')) {
      await deleting.locator('img').waitFor();
      await page.screenshot({ path: '.artifacts/knowledge-delete.png', animations: 'disabled' });
    }
    await deleting.getByRole('button', { name: '取消', exact: true }).click();
    await row.waitFor();
    await row.getByRole('button', { name: `删除问答 ${intent}`, exact: true }).click();
    await deleting.getByRole('button', { name: '确认删除', exact: true }).click();
    await deleting.waitFor({ state: 'hidden' });
    await row.waitFor({ state: 'hidden' });
  }
  assert.equal((await call('knowledge.list', { scope: 'all' })).length, 4);
  console.log(
    'Direct text/image deletion, preview, cancellation and list refresh verified; archive controls removed',
  );
  await page.getByLabel('问答所属范围').selectOption(accounts[0].storeId);
  await page.waitForFunction(
    () => document.querySelectorAll('.knowledge-table tbody tr').length === 1,
  );
  await page.getByLabel('同时查看通用问答').check();
  await page.waitForFunction(
    () => document.querySelectorAll('.knowledge-table tbody tr').length === 3,
  );
  assert.equal(await page.locator('.knowledge-table').getByText('数码服务交付方式').count(), 0);
  await page.locator('.knowledge-table img').waitFor();
  await page.getByRole('button', { name: '新建问答', exact: true }).click();
  assert.equal(
    await page.getByRole('dialog').getByLabel('所属店铺', { exact: true }).inputValue(),
    accounts[0].storeId,
  );
  await close();
  await page.getByRole('button', { name: '导入问答', exact: true }).click();
  assert.equal(
    await page.getByRole('dialog').getByLabel('导入到', { exact: true }).inputValue(),
    accounts[0].storeId,
  );
  await close();
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: '.artifacts/product-knowledge.png', animations: 'disabled' });

  // Seed one evaluated answer in the isolated database; approvals still use real IPC.
  const db = createClient({ url: pathToFileURL(join(dir, 'db', 'judesk.db')).href });
  try {
    const conversation = (await call('conversations.list', { storeId: accounts[0].storeId }))[0];
    const group = randomUUID(),
      turn = randomUUID(),
      evaluation = randomUUID(),
      candidate = randomUUID();
    const content = qa('衣服洗护说明', '建议冷水轻柔洗涤，深浅色分开，避免长时间浸泡。');
    await db.batch(
      [
        {
          sql: 'INSERT INTO MessageGroup (id,conversationId,messageIds,autoEligible,sealedAt) VALUES (?,?,?,?,?)',
          args: [group, conversation.id, '[]', 0, Date.now()],
        },
        {
          sql: 'INSERT INTO AnsweredTurn (id,storeId,conversationId,questionGroupId) VALUES (?,?,?,?)',
          args: [turn, accounts[0].storeId, conversation.id, group],
        },
        {
          sql: 'INSERT INTO LearningEvaluation (id,storeId,turnId,sourceRevision,evaluatorVersion,inputSnapshot,result,status) VALUES (?,?,?,?,?,?,?,?)',
          args: [
            evaluation,
            accounts[0].storeId,
            turn,
            1,
            'fixture',
            JSON.stringify({
              questions: [{ id: 'q', text: '收到后怎么洗比较好？' }],
              answers: [{ id: 'a', origin: 'human', message: { text: content.answer } }],
            }),
            JSON.stringify({
              reason: '人工回答包含可重复使用的洗护说明，建议加入本店问答库。',
              replyVerdict: 'reasonable',
            }),
            'succeeded',
          ],
        },
        {
          sql: 'INSERT INTO KnowledgeCandidate (id,storeId,evaluationId,actionIndex,contentHash,content,action,sourceRevision) VALUES (?,?,?,?,?,?,?,?)',
          args: [
            candidate,
            accounts[0].storeId,
            evaluation,
            0,
            'fixture-hash',
            JSON.stringify(content),
            'create_qa',
            1,
          ],
        },
      ],
      'write',
    );
    await nav.getByRole('button', { name: '学习审核', exact: true }).click();
    await page.getByLabel('学习店铺').selectOption(accounts[0].storeId);
    await page.locator('.candidate-row').filter({ hasText: content.intent }).waitFor();
    assert.equal(await page.locator('.evaluations').getAttribute('open'), null);
    const scopeBox = await page.getByLabel('学习店铺').boundingBox();
    const toggleBox = await page
      .getByRole('switch', { name: '自动学习', exact: true })
      .boundingBox();
    assert.ok(
      scopeBox.x >= 0 && toggleBox.x + toggleBox.width <= (await page.evaluate(() => innerWidth)),
    );
    await page.screenshot({ path: '.artifacts/product-learning.png', animations: 'disabled' });
    await page.locator('.candidate-row').click();
    await page.getByRole('dialog').getByText('收到后怎么洗比较好？').waitFor();
    await page.screenshot({ path: '.artifacts/product-review.png', animations: 'disabled' });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '批准当前版本', exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '已批准', exact: true }).click();
    await page.locator('.candidate-row').filter({ hasText: content.intent }).waitFor();
    assert.equal(
      (await call('learning.list', { storeId: accounts[0].storeId, status: 'approved' })).length,
      1,
    );
    await page.getByLabel('学习店铺').selectOption(accounts[1].storeId);
    await page.waitForFunction(() => !document.querySelector('.candidate-row'));
    await page.getByRole('button', { name: '学习设置', exact: true }).click();
    await page.getByRole('heading', { name: '自动回复与学习', exact: true }).waitFor();
    assert.equal(await page.locator('.management-shop-heading h2').textContent(), '小聚数码服务');
    await page.getByRole('button', { name: '平台账号', exact: false }).click();
    await page.screenshot({ path: '.artifacts/product-stores.png', animations: 'disabled' });
  } finally {
    db.close();
  }

  await nav.getByRole('button', { name: '系统设置', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: /店铺接待/ }).count(), 0);
  await page.getByRole('tab', { name: '高级定制', exact: false }).click();
  await page.getByRole('switch', { name: '显示开发者工具', exact: true }).click();
  for (const [label, heading] of [
    ['Agent Studio', 'Agent Studio'],
    ['Skills', 'Skills 技能库'],
    ['Toolkit', 'Toolkit 工具库'],
    ['Workflow', 'Workflow 流程库'],
    ['工作绑定', '工作绑定'],
    ['Agent 执行', 'Agent 执行'],
  ]) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await nav.getByRole('button', { name: 'Agent Studio', exact: true }).click();
  await page.screenshot({ path: '.artifacts/product-studio.png', animations: 'disabled' });

  // At the smallest supported size, shop selection and the conversation remain usable.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720));
  await nav.getByRole('button', { name: '接待中心', exact: true }).click();
  await page.getByLabel('接待店铺范围').selectOption(accounts[0].storeId);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.locator('.conversation-item').filter({ hasText: '青禾服饰旗舰店的买家' }).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), '这一位客户的草稿');
  assert.equal(await page.getByRole('button', { name: /聚合接待|人工工作台/ }).count(), 0);
  await page.getByRole('button', { name: '客户与订单', exact: true }).click();
  await page.locator('.workbench-panel').waitFor();
  await page.getByRole('button', { name: '收起客户与订单', exact: true }).click();
  await page.locator('.workbench-panel').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.composer').isVisible(), true);
  assert.equal(await page.locator('.chat-header h3').textContent(), '青禾服饰旗舰店的买家');
  assert.equal(await page.locator('.composer textarea').inputValue(), '这一位客户的草稿');
  await page.getByRole('button', { name: '话术', exact: true }).click();
  await page.getByRole('dialog').locator('.quick-reply-card').first().waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '发送话术：数码服务交付方式', exact: true })
      .count(),
    0,
  );
  await page.getByRole('dialog').locator('img').waitFor();
  await close();
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: '.artifacts/product-small.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const inputBox = await page.locator('.composer textarea').boundingBox();
  assert.ok(inputBox.width >= 280);
  console.log(
    'Product navigation passed: independent shop scopes, image QA, import target, approval and store isolation, settings links, developer pages, drafts and 960px layout.',
  );
}
