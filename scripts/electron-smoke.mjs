import { checkProductImprovements } from './product-improvements-smoke.mjs';
import { checkStoreScopes } from './store-scope-smoke.mjs';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createClient } from '@libsql/client';
import assert from 'node:assert/strict';
import { checkSkills } from './skills-smoke.mjs';
import { checkManualAsync } from './manual-send-smoke.mjs';
import { checkAutomaticReply } from './auto-reply-smoke.mjs';
import { checkAgentStudio } from './agent-studio-smoke.mjs';
import { checkOnboarding } from './onboarding-smoke.mjs';
import { checkGoofish } from './goofish-smoke.mjs';
import { checkDouyin } from './douyin-smoke.mjs';
import { checkAgentRuns } from './agent-runs-smoke.mjs';
import { checkPddToolkit } from './pdd-toolkit-smoke.mjs';
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'judesk-electron-'));
await mkdir(join(dir, 'db'));
await writeFile(join(dir, 'db', 'judesk.db'), '');
const dbFile = join(dir, 'db', 'judesk.db');
const url = pathToFileURL(dbFile).href;
await promisify(execFile)(
  process.execPath,
  [
    require.resolve('prisma/build/index.js'),
    'migrate',
    'deploy',
    '--config',
    resolve('prisma.config.ts'),
  ],
  { env: { ...process.env, DATABASE_URL: `file:${dbFile.replaceAll('\\', '/')}` } },
);
const seed = createClient({ url });
await seed.batch(
  [
    {
      sql: 'INSERT INTO Store (id, externalId, name) VALUES (?, ?, ?)',
      args: ['demo-store', 'e2e-mall', '山野生活旗舰店 · 测试'],
    },
    { sql: 'INSERT INTO ReplyPolicy (storeId) VALUES (?)', args: ['demo-store'] },
    { sql: 'INSERT INTO LearningPolicy (storeId) VALUES (?)', args: ['demo-store'] },
    {
      sql: 'INSERT INTO Account (id,storeId,externalId,name,sessionPartition,status,capabilities) VALUES (?,?,?,?,?,?,?)',
      args: [
        'demo-account',
        'demo-store',
        'e2e-cs',
        '小聚',
        'persist:e2e',
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
    {
      sql: 'INSERT INTO AiRun (id,storeId,conversationId,role,path,status,input,output,evidence,usage) VALUES (?,?,?,?,?,?,?,?,?,?)',
      args: [
        'reply-send-pending',
        'demo-store',
        'demo-c0',
        'reply',
        'agent',
        'succeeded',
        JSON.stringify({ question: '在吗' }),
        JSON.stringify({
          action: 'reply',
          text: '您好，我在的',
          evidenceIds: [],
          reasonCode: 'agent_text',
        }),
        '[]',
        '{}',
      ],
    },
    {
      sql: 'INSERT INTO OutboundMessage (id,intentKey,conversationId,storeId,accountId,routeVersion,conversationRevision,replyConfigEpoch,origin,body,aiRunId,status,error,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      args: [
        'send-pending',
        'reply:send-pending',
        'demo-c0',
        'demo-store',
        'demo-account',
        1,
        1,
        1,
        'ai',
        JSON.stringify({ text: '您好，我在的' }),
        'reply-send-pending',
        'unknown',
        '拼多多请求尚未返回明确回执，请核对平台记录',
        Date.now(),
      ],
    },
    ...['小林同学', '橘子汽水', '陈女士', '一颗小行星', '山间清风'].map((name, i) => ({
      sql: 'INSERT INTO Conversation (id,storeId,externalKey,buyerId,buyerName,accountId,preview,unread) VALUES (?,?,?,?,?,?,?,?)',
      args: [
        `demo-c${i}`,
        'demo-store',
        `buyer:demo-${i}`,
        `demo-${i}`,
        name,
        'demo-account',
        [
          '你好，这款保温杯有浅绿色吗？',
          '想问一下多久能发货呀',
          '杯盖可以单独配一个吗？',
          '收到啦，颜色很喜欢！',
          '请问支持七天无理由吗？',
        ][i],
        i < 2 ? 1 : 0,
      ],
    })),
    {
      sql: 'INSERT INTO Message (id,conversationId,storeId,externalId,direction,origin,text,timestamp,raw) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [
        'msg-demo',
        'demo-c0',
        'demo-store',
        'ext-demo',
        'in',
        'buyer',
        '你好，这款保温杯有浅绿色吗？',
        Date.now(),
        '{}',
      ],
    },
  ],
  'write',
);
seed.close();
let app;
let mock;
const packagedExecutable =
  process.env.JUDESK_PACKAGED_EXECUTABLE ||
  (process.platform === 'win32'
    ? 'dist/win-unpacked/judesk.exe'
    : process.platform === 'darwin'
      ? `dist/mac${process.arch === 'arm64' ? '-arm64' : ''}/句达.app/Contents/MacOS/judesk`
      : 'dist/linux-unpacked/judesk');
const launchOptions = () =>
  process.env.JUDESK_PACKAGED || process.env.JUDESK_PACKAGED_EXECUTABLE
    ? { executablePath: resolve(packagedExecutable), args: [] }
    : { args: [resolve('out/main/bootstrap.js')] };
const errors = [];
try {
  const env = { ...process.env, JUDESK_DATA_DIR: dir, JUDESK_SMOKE_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    ...launchOptions(),
    env,
    timeout: 60000,
  });
  app.process().stderr.on('data', (d) => process.stderr.write(d));
  app.process().stdout.on('data', (d) => process.stdout.write(d));
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await waitForService(page);
  await page
    .getByText('山野生活旗舰店 · 测试', { exact: true })
    .first()
    .waitFor({ timeout: 20000 });
  await page.getByText('AI 接待未开启', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '店铺管理', exact: true }).click();
  await page.getByRole('button', { name: '自动接待', exact: true }).click();
  assert.equal(
    await page.getByRole('switch', { name: 'AI 自动回复', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '接待中心', exact: true }).click();
  // Reproduce the saved-on/unverified account using only this temporary fixture database.
  const readinessFixture = createClient({ url });
  await readinessFixture.batch(
    [
      {
        sql: 'UPDATE ReplyPolicy SET autoReplyEnabled = 1 WHERE storeId = ?',
        args: ['demo-store'],
      },
      {
        sql: 'UPDATE Account SET status = ?, capabilities = ? WHERE id = ?',
        args: [
          'online',
          JSON.stringify({
            receive: true,
            sendText: true,
            sendImage: false,
            history: true,
            goods: false,
            orders: false,
            verified: false,
          }),
          'demo-account',
        ],
      },
    ],
    'write',
  );
  await page.reload();
  await waitForService(page);
  await page.getByRole('button', { name: '店铺管理', exact: true }).click();
  await page.getByRole('button', { name: '自动接待', exact: true }).click();
  await page.getByText('尚未配置模型', { exact: true }).first().waitFor();
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/auto-reply-paused.png', animations: 'disabled' });
  assert.equal(
    await page
      .getByRole('switch', { name: 'AI 自动回复', exact: true })
      .getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    await page.getByRole('switch', { name: 'AI 自动回复', exact: true }).isDisabled(),
    false,
  );
  await page.getByRole('button', { name: '确认「小聚」收发正常', exact: true }).click();
  await page.getByRole('dialog').getByText('确认账号可以正常接待', { exact: true }).waitFor();
  await page.getByRole('button', { name: '稍后验证' }).click();
  await readinessFixture.batch(
    [
      {
        sql: 'UPDATE ReplyPolicy SET autoReplyEnabled = 0 WHERE storeId = ?',
        args: ['demo-store'],
      },
      {
        sql: 'UPDATE Account SET status = ?, capabilities = ? WHERE id = ?',
        args: [
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
          'demo-account',
        ],
      },
    ],
    'write',
  );
  readinessFixture.close();
  await page.reload();
  await waitForService(page);
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/workspace.png' });
  await page.getByText('小林同学', { exact: true }).click();
  await page.getByPlaceholder('输入回复内容，Enter 发送，Shift + Enter 换行…').waitFor();
  const chat = await page.evaluate(() =>
    window.judesk.call('conversations.list', { storeId: 'demo-store' }),
  );
  assert.equal(chat.find((c) => c.id === 'demo-c0').openedByHuman, false);
  const composerLayout = await page.evaluate(() => ({
    chatWidth: document.querySelector('.chat-pane').getBoundingClientRect().width,
    composerWidth: document.querySelector('.composer').getBoundingClientRect().width,
  }));
  assert.ok(
    Math.abs(composerLayout.chatWidth - composerLayout.composerWidth) < 2,
    '话术样式不应改变会话发送框的宽度',
  );
  await page.screenshot({ path: '.artifacts/conversation.png' });
  await page.getByRole('button', { name: '话术', exact: true }).click();
  await page.getByRole('dialog').getByText('暂无本店或通用问答', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '问答库', exact: true }).click();
  await page.getByRole('button', { name: '新建问答', exact: true }).click();
  await page.getByPlaceholder('例如：这款商品多久可以发货？').fill('现货多久发货？');
  await page.getByPlaceholder('填写经过确认的标准回答…').fill('现货商品付款后 48 小时内发出。');
  await page.getByRole('button', { name: '保存并启用', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('td').getByText('现货多久发货？', { exact: true }).waitFor();
  const knowledge = await page.evaluate(() =>
    window.judesk.call('knowledge.list', { storeId: 'demo-store' }),
  );
  assert.equal(knowledge.length, 1);
  await page.screenshot({ path: '.artifacts/knowledge.png' });
  // Browse all approved QA in the composer and submit the chosen answer via the real IPC.
  // This fixture account is offline: dispatch is cancelled before any platform send.
  const qaImageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 560;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#eef5ef';
    ctx.fillRect(0, 0, 560, 320);
    ctx.fillStyle = '#4c7761';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('保温杯 · 尺寸参考', 34, 52);
    ctx.font = '20px sans-serif';
    ctx.fillText('容量 500 ml   /   高度 22 cm', 34, 99);
    ctx.fillStyle = '#b2cbb9';
    ctx.fillRect(344, 90, 104, 176);
    ctx.fillStyle = '#4c7761';
    ctx.fillRect(337, 82, 118, 24);
    ctx.font = '17px sans-serif';
    ctx.fillText('杯口直径约 7 cm', 34, 184);
    ctx.fillText('图片话术预览测试', 34, 232);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const qaImagePath = join(dir, '尺寸参考.png');
  await writeFile(qaImagePath, Buffer.from(qaImageData, 'base64'));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, qaImagePath);
  const qaImage = await page.evaluate(() =>
    window.judesk.call('attachments.pick', { storeId: 'demo-store' }),
  );
  await page.evaluate(async (attachmentId) => {
    const samples = [
      ['清洗说明', '首次使用前，请用温水清洗杯身。'],
      ['浅绿色还有库存吗', '浅绿色有现货，您可以直接下单。'],
      ['杯盖可以单独购买吗', '可以单独购买，请提供保温杯的款式。'],
      ['能放进洗碗机吗', '建议手洗，请勿放入洗碗机。'],
      ['已经收到货了', '感谢您的反馈，祝您使用愉快。'],
    ];
    for (const [intent, answer] of samples) {
      await window.judesk.call('knowledge.save', {
        storeId: 'demo-store',
        qa: { intent, answer, answerKind: 'text' },
      });
    }
    await window.judesk.call('knowledge.save', {
      storeId: 'demo-store',
      qa: {
        intent: '查看保温杯尺寸',
        answerKind: 'image',
        answer: '保温杯尺寸参考图',
        attachmentId,
      },
    });
  }, qaImage.id);
  await page.getByRole('button', { name: '接待中心', exact: true }).click();
  await page.getByText('小林同学', { exact: true }).click();
  const composer = page.getByPlaceholder('输入回复内容，Enter 发送，Shift + Enter 换行…');
  await composer.fill('这是一条尚未发出的人工草稿');
  await page.getByRole('button', { name: '选择图片', exact: true }).click();
  await page.getByText('已选图片：尺寸参考.png', { exact: true }).waitFor();
  await page.getByRole('button', { name: '话术', exact: true }).click();
  const phrases = page.getByRole('dialog');
  await phrases.getByRole('button', { name: '发送话术：查看保温杯尺寸', exact: true }).waitFor();
  assert.equal(await phrases.locator('.quick-reply-card').count(), 7);
  assert.equal(await phrases.getByText('7 / 7 条问答', { exact: true }).count(), 1);
  const phraseImage = phrases.getByRole('img', { name: '尺寸参考.png', exact: true });
  await phraseImage.waitFor();
  await phraseImage.evaluate((img) =>
    img.complete && img.naturalWidth
      ? undefined
      : new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('话术图片加载失败'));
        }),
  );
  assert.equal(await phraseImage.evaluate((img) => img.naturalWidth), 560);
  await page.screenshot({ path: '.artifacts/quick-replies.png', animations: 'disabled' });
  await phrases.getByLabel('搜索话术', { exact: true }).fill('温水');
  assert.equal(await phrases.locator('.quick-reply-card').count(), 1);
  await phrases.getByLabel('搜索话术', { exact: true }).fill('不存在的话术关键词');
  await phrases.getByText('没有找到匹配的话术', { exact: true }).waitFor();
  await phrases.getByLabel('搜索话术', { exact: true }).fill('');
  await phrases.getByRole('button', { name: '文字', exact: true }).click();
  assert.equal(await phrases.locator('.quick-reply-card').count(), 6);
  const beforeQuickSends = await page.evaluate(() =>
    window.judesk.call('outbound.list', { storeId: 'demo-store' }),
  );
  // Two synchronous click events exercise the in-flight guard before React can rerender.
  await phrases
    .getByRole('button', { name: '发送话术：现货多久发货？', exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await phrases.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    async (beforeIds) => {
      const rows = await window.judesk.call('outbound.list', { storeId: 'demo-store' });
      return rows.some((row) => !beforeIds.includes(row.id) && row.status === 'cancelled');
    },
    beforeQuickSends.map((send) => send.id),
  );
  let quickSends = await page.evaluate(() =>
    window.judesk.call('outbound.list', { storeId: 'demo-store' }),
  );
  quickSends = quickSends.filter(
    (send) => !beforeQuickSends.some((before) => before.id === send.id),
  );
  assert.equal(quickSends.length, 1);
  assert.deepEqual(quickSends[0].body, { text: '现货商品付款后 48 小时内发出。' });
  assert.equal(quickSends[0].origin, 'human');
  assert.equal(quickSends[0].conversationId, 'demo-c0');
  assert.equal(quickSends[0].status, 'cancelled');
  assert.equal(await composer.inputValue(), '这是一条尚未发出的人工草稿');
  await page.getByText('已选图片：尺寸参考.png', { exact: true }).waitFor();
  await page.getByRole('button', { name: '话术', exact: true }).click();
  await phrases.getByRole('button', { name: '图片', exact: true }).click();
  assert.equal(await phrases.locator('.quick-reply-card').count(), 1);
  await phrases.getByRole('button', { name: '发送话术：查看保温杯尺寸', exact: true }).click();
  await phrases.waitFor({ state: 'hidden' });
  const imageQuickSend = (
    await page.evaluate(() => window.judesk.call('outbound.list', { storeId: 'demo-store' }))
  ).find((send) => send.body.attachmentId === qaImage.id);
  assert.deepEqual(imageQuickSend.body, { text: '', attachmentId: qaImage.id });
  assert.equal(imageQuickSend.origin, 'human');
  assert.equal(imageQuickSend.status, 'cancelled');
  assert.equal(await composer.inputValue(), '这是一条尚未发出的人工草稿');
  await page.getByText('已选图片：尺寸参考.png', { exact: true }).waitFor();
  // Reopening starts from the full list; the sidebar uses the same preview without navigation.
  await page.getByRole('button', { name: '话术', exact: true }).click();
  assert.equal(await phrases.locator('.quick-reply-card').count(), 7);
  await phrases.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const hidden = await page.getByRole('button', { name: 'Agent Studio', exact: true }).count();
  assert.equal(hidden, 0);
  assert.equal(await page.getByRole('button', { name: '运行记录', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Agent 执行', exact: true }).count(), 0);
  await page.getByRole('button', { name: '系统设置' }).click();
  await page.getByText('模型服务', { exact: true }).first().waitFor();
  await page.screenshot({ path: '.artifacts/settings.png' });
  await page.getByRole('tab', { name: '高级定制', exact: false }).click();
  await page.getByRole('switch', { name: '显示开发者工具' }).click();
  await page.getByRole('button', { name: 'Agent Studio', exact: true }).click();
  await page.getByText('默认自动回复', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/agents.png' });
  await page.getByRole('button', { name: 'Toolkit', exact: true }).click();
  await page.getByText('基础工具', { exact: true }).click();
  await page.getByLabel('试跑成员').selectOption('calculate');
  await page.getByLabel('输入 JSON').fill(JSON.stringify({ a: 12, b: 3, operation: 'divide' }));
  await page.getByRole('button', { name: '在隔离环境试跑' }).click();
  await page.getByText('"result": 4', { exact: false }).waitFor();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '学习审核', exact: true }).click();
  await page.screenshot({ path: '.artifacts/learning.png' });
  // A historical run exposes only its saved outcome, not invented tool steps.
  await page.getByRole('button', { name: 'Agent 执行', exact: true }).click();
  await page.locator('[data-run-id="reply-send-pending"]').click();
  const runDetail = page.getByTestId('agent-run-detail');
  await runDetail.getByText('AI 已生成', { exact: true }).waitFor();
  const pendingSend = runDetail.locator('[data-outbound-id="send-pending"]');
  await pendingSend.getByText('发送待确认', { exact: true }).waitFor();
  await pendingSend
    .getByText('拼多多请求尚未返回明确回执，请核对平台记录', { exact: true })
    .waitFor();
  assert.equal(await runDetail.getByText('发送成功', { exact: true }).count(), 0);
  await runDetail
    .getByText('这条历史记录未采集逐步调用。更新后的新运行会自动显示完整执行过程。', {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByRole('button', { name: '后台任务', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '发送异常', exact: true }).count(), 0);
  await page.screenshot({ path: '.artifacts/reply-delivery.png', animations: 'disabled' });
  // Turning developer tools off while diagnostics is open returns to the workbench.
  // The diagnostic data stays intact and can be viewed after re-enabling the tools.
  await page.evaluate(() => window.judesk.call('app.settings', { developerModeEnabled: false }));
  await page.locator('.page-inbox').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Agent 执行', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '后台任务', exact: true }).count(), 0);
  await page.screenshot({
    path: '.artifacts/workspace-simple-navigation.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '系统设置' }).click();
  await page.getByRole('tab', { name: '高级定制', exact: false }).click();
  await page.getByRole('switch', { name: '显示开发者工具' }).click();
  await page.getByRole('button', { name: 'Agent 执行', exact: true }).click();
  await page.getByRole('heading', { name: 'Agent 执行', exact: false }).waitFor();
  await page
    .locator('[data-run-id="reply-send-pending"]')
    .getByText('AI 已生成', { exact: true })
    .waitFor();
  await page.screenshot({ path: '.artifacts/developer-diagnostics.png', animations: 'disabled' });
  // Installed code lives under a temporary user profile, outside repository module resolution.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('extensions-dist/shop-helpers-1.0.0.zip'));
  const installed = await page.evaluate(() =>
    window.judesk.call('assets.install', { kind: 'toolkit' }),
  );
  await page.evaluate(
    (id) =>
      window.judesk.call('assets.settings', {
        assetId: id,
        scopeKey: 'global',
        expectedRevision: 0,
        values: { shopName: '测试店' },
      }),
    installed.id,
  );
  const trial = await page.evaluate(
    (id) =>
      window.judesk.call('assets.test', {
        assetId: id,
        memberId: 'greeting',
        input: { text: '请问需要什么帮助？' },
      }),
    installed.id,
  );
  assert.equal(trial.text, '您好，欢迎来到测试店。请问需要什么帮助？');
  // New Workflow examples are normal Agent capabilities, not alternate reply entries.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, resolve('extensions-dist/reply-polish-1.1.0.zip'));
  const installedWorkflow = await page.evaluate(() =>
    window.judesk.call('assets.install', { kind: 'workflow' }),
  );
  const workflowTrial = await page.evaluate(
    (assetId) =>
      window.judesk.call('assets.test', {
        assetId,
        memberId: 'paragraphs',
        input: { text: '  商品规格\r\n\r\n发货说明  ' },
      }),
    installedWorkflow.id,
  );
  assert.deepEqual(workflowTrial, { paragraphs: ['商品规格', '发货说明'] });
  // A local fixture exercises the actual packaged Mastra provider, without paid model traffic.
  let replyModelCalls = 0;
  const learningRequests = [];
  let useTerminalOutput = false;
  let useHandoffOutput = false;
  mock = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const hasReplyTool = body.tools?.find((t) => t.function.name === 'submitReply');
    const learning = body.model === 'glm-5.3-flash' && !hasReplyTool;
    if (learning) learningRequests.push(body);
    const learningUser = learning ? body.messages.find((m) => m.role === 'user') : null;
    const learningInput = learningUser
      ? JSON.parse(
          typeof learningUser.content === 'string'
            ? learningUser.content
            : learningUser.content.find((part) => part.type === 'text').text,
        )
      : null;
    const scriptTrial =
      hasReplyTool && JSON.stringify(body.messages).includes('__SKILL_SCRIPT_SMOKE__');
    const scriptResult =
      scriptTrial &&
      body.messages.some(
        (m) => m.role === 'tool' && JSON.stringify(m).includes('after-sales-guide'),
      );
    const scriptTool =
      scriptTrial && !scriptResult
        ? body.tools?.find((t) => t.function.name === 'runSkillScript')
        : null;
    const text = scriptResult
      ? '脚本计算结果：42'
      : learning
        ? JSON.stringify({
            matchVerdict: 'not_applicable',
            replyVerdict: 'reasonable',
            reuseVerdict: 'not_reusable',
            reason: '无新增通用知识',
            evidenceIds: [
              learningInput.questions.at(-1).evidenceRef,
              learningInput.answers[0].message.evidenceRef,
            ],
            suggestions: [],
          })
        : hasReplyTool
          ? '单次模型回复成功'
          : '连接成功';
    const terminal =
      scriptTool ||
      (useHandoffOutput
        ? body.tools?.find((t) => t.function.name === 'handoffToHuman')
        : useTerminalOutput
          ? hasReplyTool
          : null);
    if (hasReplyTool) replyModelCalls++;
    const toolCalls = terminal
      ? [
          {
            index: 0,
            id: 'smoke-submit',
            type: 'function',
            function: {
              name: terminal.function.name,
              arguments: JSON.stringify(
                scriptTool
                  ? {
                      skillName: 'after-sales-guide',
                      path: 'scripts/calculate.ts',
                      args: ['41'],
                      stdin: '',
                      timeoutMs: 10000,
                    }
                  : useHandoffOutput
                    ? { reason: '需人工核实订单' }
                    : {
                        action: 'reply',
                        text: '单次模型回复成功',
                        evidenceIds: [],
                        reasonCode: 'smoke',
                      },
              ),
            },
          },
        ]
      : undefined;
    const assistantMessage = {
      role: 'assistant',
      ...(terminal ? { tool_calls: toolCalls } : { content: text }),
    };
    const finishReason = terminal ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: assistantMessage, finish_reason: null }],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const model = await page.evaluate(
    (baseUrl) =>
      window.judesk.call('models.save', {
        name: '本地测试模型',
        kind: 'chat',
        provider: 'fixture',
        model: 'fixture',
        baseUrl,
      }),
    `http://127.0.0.1:${mock.address().port}/v1`,
  );
  assert.equal(
    (await page.evaluate((id) => window.judesk.call('models.test', { id }), model.id)).text,
    '连接成功',
  );
  const replyAgent = await page.evaluate(
    (id) =>
      window.judesk.call('agents.save', {
        config: {
          name: '单次模型回复夹具',
          prompt: '仅按测试输入提交最终回复。',
          modelProfileId: id,
        },
      }),
    model.id,
  );
  const trialReply = await page.evaluate(
    (id) => window.judesk.call('agents.debug', { id, input: '测试一次请求提交最终回复' }),
    replyAgent.id,
  );
  assert.equal(trialReply.result.text, '单次模型回复成功');
  assert.equal(replyModelCalls, 1);
  useTerminalOutput = true;
  const trialTerminal = await page.evaluate(
    (id) => window.judesk.call('agents.debug', { id, input: '测试一次请求提交工具参数' }),
    replyAgent.id,
  );
  assert.equal(trialTerminal.result.text, '单次模型回复成功');
  assert.equal(replyModelCalls, 2);
  useHandoffOutput = true;
  const trialHandoff = await page.evaluate(
    (id) => window.judesk.call('agents.debug', { id, input: '转人工' }),
    replyAgent.id,
  );
  assert.equal(trialHandoff.result.action, 'handoff');
  assert.equal(trialHandoff.result.reasonCode, '需人工核实订单');
  assert.equal(trialHandoff.usage.outputMode, 'handoff_tool');
  assert.equal(replyModelCalls, 3);
  useHandoffOutput = false;
  useTerminalOutput = false;
  await checkAgentStudio({ app, page, modelId: model.id, modelCalls: () => replyModelCalls });
  await checkSkills({ app, page, modelId: model.id, modelCalls: () => replyModelCalls });
  await checkStoreScopes({ app, page, dbFile, imagePath: qaImagePath });
  await checkManualAsync({ app, page, dbFile });
  await checkAutomaticReply({
    app,
    page,
    dbFile,
    agent: replyAgent,
    modelCalls: () => replyModelCalls,
  });
  await checkPddToolkit({ app, page, dbFile });
  await checkAgentRuns({ app, page, dbFile });
  // Exercise learning in the real desktop utility process using only this temporary DB
  // and local model. No platform/customer messages or paid model calls are generated.
  const learningModel = await page.evaluate(
    (baseUrl) =>
      window.judesk.call('models.save', {
        name: '本地学习夹具',
        kind: 'chat',
        provider: 'openai',
        model: 'glm-5.3-flash',
        baseUrl,
        maxTokens: 2048,
      }),
    `http://127.0.0.1:${mock.address().port}/v1`,
  );
  await page.evaluate(
    (id) =>
      window.judesk.call('stores.policy', {
        storeId: 'demo-store',
        autoLearnEnabled: true,
        builtinModelRef: id,
      }),
    learningModel.id,
  );
  const learningDb = createClient({ url });
  try {
    await learningDb.batch(
      [
        {
          sql: 'UPDATE Message SET timestamp = ?, receivedAt = ? WHERE id = ?',
          args: [
            new Date(Date.now() - 10000).toISOString(),
            new Date(Date.now() - 10000).toISOString(),
            'msg-demo',
          ],
        },
        {
          sql: 'INSERT INTO Message (id,conversationId,storeId,externalId,direction,origin,text,timestamp,raw) VALUES (?,?,?,?,?,?,?,?,?)',
          args: [
            'e2e-learn-question',
            'demo-c0',
            'demo-store',
            'e2e-learn-question-ext',
            'in',
            'buyer',
            '浅绿色现在有现货吗？',
            new Date(Date.now() - 1000).toISOString(),
            '{}',
          ],
        },
        {
          sql: 'INSERT INTO MessageGroup (id,conversationId,messageIds,autoEligible,state,sealedAt) VALUES (?,?,?,?,?,?)',
          args: ['e2e-old-waiting', 'demo-c0', '["msg-demo"]', 0, 'waiting_answer', Date.now()],
        },
        {
          sql: 'INSERT INTO MessageGroup (id,conversationId,messageIds,autoEligible,state,sealedAt) VALUES (?,?,?,?,?,?)',
          args: [
            'e2e-new-waiting',
            'demo-c0',
            '["e2e-learn-question"]',
            0,
            'waiting_answer',
            Date.now(),
          ],
        },
        {
          sql: 'INSERT INTO OutboundMessage (id,intentKey,conversationId,storeId,accountId,routeVersion,conversationRevision,replyConfigEpoch,origin,body,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          args: [
            'e2e-learn-outbound',
            'human-learning-fixture',
            'demo-c0',
            'demo-store',
            'demo-account',
            1,
            1,
            1,
            'human',
            JSON.stringify({ text: '有浅绿色。' }),
            'unknown',
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        },
      ],
      'write',
    );
    // Confirm an isolated fixture receipt through production completeSend. The real
    // service creates the Message, context turn and durable event automatically.
    await page.evaluate(() =>
      window.judesk.call('outbound.resolve', {
        id: 'e2e-learn-outbound',
        externalId: 'e2e-learn-answer-ext',
        evidence: '仅隔离资料库中的模拟平台确认，不是实际客户消息',
      }),
    );
    let learningRun;
    const learningDeadline = Date.now() + 30000;
    while (Date.now() < learningDeadline) {
      learningRun = (
        await learningDb.execute(
          "SELECT status,input,output,evidence,usage,error FROM AiRun WHERE role='learning' ORDER BY startedAt DESC LIMIT 1",
        )
      ).rows[0];
      if (learningRun && learningRun.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(learningRun?.status, 'succeeded', learningRun?.error ?? '学习任务超时');
    assert.equal(JSON.parse(learningRun.usage).outputMode, 'learning_json');
    assert.equal(JSON.parse(learningRun.input).associationMode, 'conversation_context');
    assert.deepEqual(JSON.parse(learningRun.output).evidenceIds, [
      'e2e-learn-question',
      JSON.parse(learningRun.input).answerMessageIds[0],
    ]);
    assert.deepEqual(JSON.parse(learningRun.evidence).invalidEvidenceIds, []);
    assert.ok(
      JSON.parse(learningRun.evidence).returnedEvidenceIds.every((id) => /^E\d+$/.test(id)),
    );
    assert.deepEqual(JSON.parse(learningRun.input).questionMessageIds, [
      'msg-demo',
      'e2e-learn-question',
    ]);
    const learnedMessage = (
      await learningDb.execute(
        "SELECT associationStatus FROM Message WHERE externalId='e2e-learn-answer-ext'",
      )
    ).rows[0];
    assert.equal(learnedMessage.associationStatus, 'associated');
    assert.equal(learningRequests.length, 1);
    assert.equal(learningRequests[0].reasoning_effort, 'low');
    assert.equal(learningRequests[0].max_tokens, 2048);
    assert.equal(
      (await learningDb.execute('SELECT COUNT(*) AS count FROM KnowledgeCandidate')).rows[0].count,
      0,
    );
  } finally {
    learningDb.close();
  }
  await page.getByRole('button', { name: '接待中心', exact: true }).click();
  await page.getByText('小林同学', { exact: true }).click();
  await page.getByText('有浅绿色。', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '关联买家问题后参与学习', exact: true }).count(),
    0,
  );
  await page.screenshot({ path: '.artifacts/human-auto-learning.png', animations: 'disabled' });
  await checkProductImprovements({ page, dbFile });
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  const fresh = join(dir, 'first-launch');
  const freshEnv = { ...process.env, JUDESK_DATA_DIR: fresh, JUDESK_SMOKE_TEST: '1' };
  delete freshEnv.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...launchOptions(), env: freshEnv, timeout: 60000 });
  app.process().stderr.on('data', (d) => process.stderr.write(d));
  const blank = await app.firstWindow();
  await waitForService(blank);
  assert.deepEqual(await blank.evaluate(() => window.judesk.call('stores.list')), []);
  assert.equal((await blank.evaluate(() => window.judesk.call('app.state'))).hasDefaultAgent, true);
  await blank.getByRole('heading', { name: '连接你的模型服务' }).waitFor();
  await blank.screenshot({ path: '.artifacts/first-launch.png' });
  await blank.getByRole('button', { name: '稍后配置，先使用人工接待', exact: true }).click();
  assert.equal(
    (await blank.evaluate(() => window.judesk.call('app.state'))).settings.aiSetupMode,
    'later',
  );
  await blank.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor();
  await checkOnboarding({
    app,
    page: blank,
    modelBaseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  });
  await checkDouyin({ app, page: blank, imagePath: qaImagePath });
  await checkGoofish({ app, page: blank });
  console.log(
    'Electron smoke passed: service startup, conversation takeover, QA create, full text/image quick-reply preview and direct submission with draft preservation, developer navigation, native and installed Toolkit, Mastra native text, terminal-tool replies and handoff with one request each, automatic human-reply context capture and single-request durable learning in the utility process, first-launch migration.',
  );
} catch (error) {
  if (app?.windows()[0])
    await app
      .windows()[0]
      .screenshot({ path: '.artifacts/electron-smoke-failure.png' })
      .catch(() => {});
  if (errors.length) console.error('Renderer errors:', errors);
  throw error;
} finally {
  if (app) await app.close();
  if (mock) await new Promise((r) => mock.close(r));
  await rm(dir, { recursive: true, force: true });
}

async function waitForService(page) {
  const deadline = Date.now() + 90000;
  let last;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => window.judesk.call('app.state'));
      if (state?.version) return state;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw last ?? new Error('本地服务启动超时');
}
