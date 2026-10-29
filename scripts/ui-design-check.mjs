// Isolated visual regression fixture. Never connects a platform or sends customer messages.
// Usage: node scripts/ui-design-check.mjs [artifact-label] [light|dark]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { _electron as electron } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const label = (process.argv[2] || 'current').replace(/[^a-z0-9_-]/gi, '-');
const colorScheme = process.argv[3] === 'dark' ? 'dark' : 'light';
const artifacts = resolve(ROOT, '.artifacts', `ui-design-${label}`);
const dir = await mkdtemp(join(tmpdir(), 'judesk-ui-design-'));
const dbFile = join(dir, 'db', 'judesk.db');
const require = createRequire(import.meta.url);
let app;
const errors = [];
const checks = [];
try {
  await mkdir(artifacts, { recursive: true });
  await rm(join(artifacts, 'failure.png'), { force: true });
  await mkdir(join(dir, 'db'));
  await writeFile(dbFile, '');
  await promisify(execFile)(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      resolve(ROOT, 'prisma.config.ts'),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: pathToFileURL(dbFile).href },
    },
  );
  // The pre-migration snapshot requires both workspace databases to exist.
  const mastra = createClient({ url: pathToFileURL(join(dir, 'db', 'mastra.db')).href });
  await mastra.executeMultiple('CREATE TABLE ui_init (x); DROP TABLE ui_init;');
  mastra.close();
  const db = createClient({ url: pathToFileURL(dbFile).href });
  const stores = [
    ['visual-home', 'pinduoduo', '山野生活旗舰店', '小聚'],
    ['visual-fashion', 'douyin', '拾光服饰专营店', '小禾'],
    ['visual-digital', 'goofish', '清风数码工作室', '小林'],
  ];
  const customers = [
    ['小林同学', '你好，这款保温杯有浅绿色吗？', 0, 2],
    ['橘子汽水', '想问一下多久能发货呀', 1, 3],
    ['陈女士', '杯盖可以单独配一个吗？', 0, 1],
    ['一颗小行星', '收到啦，颜色很喜欢！', 2, 0],
    ['山间清风', '请问支持七天无理由吗？', 0, 1],
    ['晚风与星辰', '身高 168，选哪个尺码合适？', 1, 0],
    ['鹿鸣', '可以帮忙确认一下订单吗？', 2, 0],
    ['夏日来信', '好的，谢谢客服', 1, 0],
  ];
  const now = Date.now();
  const iso = (minutes) => new Date(now - minutes * 60000).toISOString();
  const sql = [];
  for (const [id, platform, name, accountName] of stores) {
    sql.push(
      {
        sql: 'INSERT INTO Store (id, platform, externalId, name) VALUES (?,?,?,?)',
        args: [id, platform, id, name],
      },
      { sql: 'INSERT INTO ReplyPolicy (storeId) VALUES (?)', args: [id] },
      { sql: 'INSERT INTO LearningPolicy (storeId) VALUES (?)', args: [id] },
      {
        sql: 'INSERT INTO Account (id,storeId,externalId,name,sessionPartition,status,capabilities) VALUES (?,?,?,?,?,?,?)',
        args: [
          `${id}-account`,
          id,
          `${id}-account`,
          accountName,
          `persist:${id}`,
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
    );
  }
  customers.forEach(([name, preview, storeIndex, unread], index) => {
    const storeId = stores[storeIndex][0];
    sql.push({
      sql: 'INSERT INTO Conversation (id,storeId,externalKey,buyerId,buyerName,accountId,preview,unread,updatedAt,openedByHuman,awaitingHuman) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: [
        `visual-c${index}`,
        storeId,
        `buyer:visual-${index}`,
        `visual-${index}`,
        name,
        `${storeId}-account`,
        preview,
        unread,
        iso(index * 4),
        index === 0 ? 1 : 0,
        index === 2 ? 1 : 0,
      ],
    });
    if (index > 0)
      sql.push({
        sql: 'INSERT INTO Message (id,conversationId,storeId,externalId,direction,origin,text,timestamp,raw) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [
          `visual-msg-${index}`,
          `visual-c${index}`,
          storeId,
          `visual-msg-${index}`,
          'in',
          'buyer',
          preview,
          iso(index * 4),
          '{}',
        ],
      });
  });
  [
    ['in', 'buyer', '你好，这款保温杯有浅绿色吗？'],
    ['out', 'ai', '您好，有的。浅绿色目前有现货，500 ml 容量适合日常通勤使用。'],
    ['in', 'buyer', '杯身是什么材质的？保温效果怎么样？'],
    ['out', 'human', '内胆采用 316 不锈钢，日常使用保温约 6–12 小时。首次使用前用温水清洗即可。'],
    ['in', 'buyer', '好的，那现在下单多久可以发货？'],
    ['out', 'human', '现货商品付款后 48 小时内发出。发货后，您可以在订单页查看物流进度。'],
    ['in', 'buyer', '明白了，谢谢！可以再看一下尺寸吗？'],
  ].forEach(([direction, origin, text], index) =>
    sql.push({
      sql: 'INSERT INTO Message (id,conversationId,storeId,externalId,direction,origin,text,timestamp,raw) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [
        `visual-chat-${index}`,
        'visual-c0',
        'visual-home',
        `visual-chat-${index}`,
        direction,
        origin,
        text,
        iso(8 - index),
        '{}',
      ],
    }),
  );
  for (const [key, value] of [
    ['aiSetupMode', 'later'],
    ['setupGuideState', 'dismissed'],
  ])
    sql.push({
      sql: 'INSERT INTO AppSetting (key,value) VALUES (?,?)',
      args: [key, JSON.stringify(value)],
    });
  await db.batch(sql, 'write');
  db.close();

  const env = {
    ...process.env,
    JUDESK_DATA_DIR: dir,
    JUDESK_SMOKE_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [resolve(ROOT, 'out/main/bootstrap.js')],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ colorScheme });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(
    async () => {
      try {
        return !!(await window.judesk.call('app.state'))?.version;
      } catch {
        return false;
      }
    },
    null,
    { timeout: 60000 },
  );
  const nav = page.getByRole('complementary', { name: '主导航' });
  await nav.waitFor();
  await page.evaluate(async () => {
    for (const [intent, answer, storeId] of [
      [
        '现货多久发货？',
        '现货商品付款后 48 小时内发出，发货后可在订单页查看物流进度。',
        'visual-home',
      ],
      ['保温杯怎么清洗？', '首次使用前请用温水清洗杯身，建议手洗，请勿放入洗碗机。', 'visual-home'],
      ['浅绿色还有库存吗？', '浅绿色目前有现货，您可以直接下单。', 'visual-home'],
      [
        '杯盖可以单独购买吗？',
        '可以单独购买，请提供保温杯的款式，我们帮您核对配件。',
        'visual-home',
      ],
      [
        '尺码如何选择？',
        '请提供身高、体重和穿着偏好，我们会结合尺码表为您推荐。',
        'visual-fashion',
      ],
      ['客服在线问候', '您好，很高兴为您服务，请问有什么可以帮您？', null],
    ])
      await window.judesk.call('knowledge.save', {
        storeId,
        qa: { intent, answer, answerKind: 'text', scope: { productIds: [], conditions: '' } },
      });
    await window.judesk.call('models.save', {
      name: '客服对话模型',
      kind: 'chat',
      provider: 'openai',
      model: 'customer-support-model',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    await window.judesk.call('models.save', {
      name: '问答语义检索',
      kind: 'embedding',
      provider: 'openai',
      model: 'knowledge-embedding',
      baseUrl: 'http://127.0.0.1:9/v1',
      dimensions: 1024,
    });
  });
  async function resize(width, height) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
      { width, height },
    );
    // macOS constrains native window height to the display's work area; emulate exact CSS dimensions.
    await page.setViewportSize({ width, height });
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height },
    );
  }
  async function capture(name) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      const messages = document.querySelector('.messages');
      if (messages) messages.scrollTop = messages.scrollHeight;
    });
    await page.waitForTimeout(180);
    const layout = await page.evaluate(() => {
      const selectors = [
        'html',
        'body',
        '.app-shell',
        '.main',
        '.page',
        '.reception-layout',
        '.conversation-pane',
        '.chat-pane',
        '.composer',
        '.workbench-panel',
        '.settings-body',
        '.management-shop-detail',
      ];
      return {
        viewport: { width: innerWidth, height: innerHeight },
        roots: selectors.flatMap((selector) =>
          [...document.querySelectorAll(selector)].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              selector,
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
              clientWidth: el.clientWidth,
              scrollWidth: el.scrollWidth,
              overflowX: getComputedStyle(el).overflowX,
            };
          }),
        ),
      };
    });
    checks.push({ name, ...layout });
    assert.ok(
      layout.roots.find((row) => row.selector === 'html').scrollWidth <= layout.viewport.width + 1,
      `${name}: document overflows horizontally`,
    );
    await page.screenshot({
      path: join(artifacts, `${name}.png`),
      animations: 'disabled',
      scale: 'css',
    });
    console.log(`Captured ${name} (${layout.viewport.width}×${layout.viewport.height})`);
  }
  await resize(1440, 960);
  await page.getByText('小林同学', { exact: true }).click();
  const composer = page.getByPlaceholder(/^输入回复内容/);
  await composer.waitFor();
  await page.getByText('明白了，谢谢！可以再看一下尺寸吗？', { exact: true }).waitFor();
  await capture('inbox-1440');
  const detailTrigger = page.getByRole('button', { name: '客户与订单', exact: true });
  const detailClose = page.getByRole('button', { name: '收起客户与订单', exact: true });
  if (
    (await detailTrigger.isVisible()) &&
    !(await page.getByRole('complementary', { name: '客户与订单' }).isVisible())
  )
    await detailTrigger.click();
  await page.getByRole('complementary', { name: '客户与订单' }).waitFor();
  await capture('inbox-detail-1440');
  if (await detailClose.isVisible()) await detailClose.click();
  await composer.fill('这是一条尚未发出的回复草稿。');
  await page.getByRole('button', { name: '话术', exact: true }).click();
  await page.getByRole('listbox', { name: '话术', exact: true }).waitFor();
  await capture('quick-replies-1440');
  await page.getByRole('button', { name: '关闭话术面板', exact: true }).click();
  assert.equal(await composer.inputValue(), '这是一条尚未发出的回复草稿。');
  await composer.fill('');
  await page.getByLabel('搜索会话', { exact: true }).fill('橘子汽水');
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 1);
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 8);
  for (const [width, height] of [
    [1280, 800],
    [1100, 800],
  ]) {
    await resize(width, height);
    await capture(`inbox-${width}`);
  }
  await detailTrigger.click();
  await page.getByRole('complementary', { name: '客户与订单' }).waitFor();
  await capture('inbox-detail-1100');
  await detailClose.click();
  await resize(1440, 960);
  for (const [name, button] of [
    ['knowledge', '问答库'],
    ['stores', '店铺管理'],
    ['settings', '系统设置'],
  ]) {
    await nav.getByRole('button', { name: button, exact: true }).click();
    await page.locator(`.page-${name === 'settings' ? 'settings' : name}`).waitFor();
    if (name === 'knowledge')
      await page.locator('.knowledge-table').getByText('现货多久发货？', { exact: true }).waitFor();
    if (name === 'settings')
      await page.locator('.model-list').getByText('客服对话模型', { exact: true }).waitFor();
    await capture(`${name}-1440`);
    await resize(1100, 800);
    await capture(`${name}-1100`);
    await resize(1440, 960);
    if (name === 'settings') {
      for (const [tab, slug] of [
        ['高级定制', 'advanced'],
        ['数据与备份', 'data'],
      ]) {
        await page.getByRole('tab', { name: tab, exact: false }).click();
        await capture(`settings-${slug}-1440`);
      }
    }
  }
  // Read-only business-panel fixtures are scoped to this temporary Electron process.
  // The real renderer, navigation, conversation DB and all other IPC handlers stay in use.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('judesk:call');
    if (typeof original !== 'function') throw new Error('Fixture could not find the IPC handler');
    const reference = '11111111-1111-4111-8111-111111111111';
    const image =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="16" fill="#f1f6f5"/><rect x="57" y="39" width="48" height="94" rx="12" fill="#a4bcb1"/><rect x="60" y="27" width="42" height="21" rx="7" fill="#718d80"/><path d="M66 58v51" stroke="#dce9e2" stroke-width="4" stroke-linecap="round"/></svg>',
      );
    const products = [
      {
        goodsId: 'sample-cup',
        title: '轻简不锈钢保温杯 500 ml',
        imageUrl: image,
        priceText: '¥129.00',
        productRef: `product:${reference}:0`,
      },
      {
        goodsId: 'sample-lid',
        title: '便携杯盖 · 浅绿色',
        imageUrl: image,
        priceText: '¥29.00',
        productRef: `product:${reference}:1`,
      },
    ];
    const orders = [
      {
        orderSn: '260917-8420156801',
        orderRef: `order:${reference}:0`,
        productTitle: '轻简不锈钢保温杯 500 ml',
        statusText: '待发货',
        amountText: '¥129.00',
        goods: { title: '轻简不锈钢保温杯 500 ml', spec: '浅绿色 / 500 ml', imageUrl: image },
        details: [{ name: '下单时间', value: '2026-09-17 09:42' }],
      },
      {
        orderSn: '260901-3260481952',
        orderRef: `order:${reference}:1`,
        productTitle: '便携杯盖 · 浅绿色',
        statusText: '已完成',
        amountText: '¥29.00',
      },
    ];
    ipcMain.removeHandler('judesk:call');
    ipcMain.handle('judesk:call', (event, data) => {
      if (data.method === 'workbench.action') return { ok: false, error: '视觉测试仅提供只读资料' };
      if (data.method === 'workbench.context')
        return {
          ok: true,
          result: {
            sessionId: reference,
            expiresAt: new Date(Date.now() + 1800000).toISOString(),
            conversationId: 'visual-c0',
            storeId: 'visual-home',
            storeName: '山野生活旗舰店 · 视觉测试',
            accountId: 'visual-home-account',
            accountName: '小聚（测试资料）',
            buyerId: 'customer-1028',
            buyerName: '小林同学',
            platform: 'pinduoduo',
            online: true,
            operations: ['buyer-profile', 'goods', 'buyer-orders', 'order-detail'],
          },
        };
      if (data.method === 'workbench.query') {
        const operation = data.input.operation;
        const payload =
          operation === 'goods'
            ? { products, hasMore: false }
            : operation === 'buyer-orders'
              ? { orders, hasMore: false }
              : operation === 'order-detail'
                ? { order: orders[0] }
                : { name: '小林同学', introduction: '回购客户 · 本月第 2 次咨询' };
        return {
          ok: true,
          result: {
            operation,
            queriedAt: new Date().toISOString(),
            partial: false,
            failedSections: [],
            evidenceRef: reference,
            data: payload,
          },
        };
      }
      return original(event, data);
    });
  });
  await nav.getByRole('button', { name: '接待中心', exact: true }).click();
  await page.getByText('小林同学', { exact: true }).click();
  await page.getByRole('button', { name: '刷新侧栏', exact: true }).click();
  await page.getByText('山野生活旗舰店 · 视觉测试', { exact: true }).waitFor();
  await page.getByRole('button', { name: '商品', exact: true }).click();
  await page.getByText('轻简不锈钢保温杯 500 ml', { exact: true }).waitFor();
  await capture('inbox-products-1440');
  await page.getByRole('button', { name: '客户', exact: true }).click();
  await page.getByText('回购客户 · 本月第 2 次咨询', { exact: true }).waitFor();
  await capture('inbox-customer-1440');
  await page.getByRole('button', { name: '订单', exact: true }).click();
  await page.getByText('260917-8420156801', { exact: true }).waitFor();
  await capture('inbox-orders-1440');
  await resize(1280, 800);
  await capture('inbox-orders-1280');
  await resize(1440, 960);
  await nav.getByRole('button', { name: '上手引导', exact: true }).click();
  await page.locator('.setup-shell').waitFor();
  await capture('onboarding-1440');
  assert.deepEqual(errors, []);
  console.log(`Visual checks passed. Screenshots and layout report: ${artifacts}`);
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: join(artifacts, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ errors, checks }, null, 2));
  await app?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
