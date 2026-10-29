import { checkProductNavigation } from './product-navigation-smoke.mjs';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Fresh profile, real renderer/service IPC, entirely intercepted platform transport.
// No customer, model, payment or shipping endpoint is contacted.
const dir = await mkdtemp(join(tmpdir(), 'judesk-workbench-'));
await mkdir('.artifacts', { recursive: true });
let app;
try {
  const env = { ...process.env, JUDESK_DATA_DIR: dir, JUDESK_SMOKE_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve('out/main/bootstrap.js')], env, timeout: 60000 });
  app.process().stderr.on('data', (chunk) => process.stderr.write(chunk));
  app.process().stdout.on('data', (chunk) => process.stdout.write(chunk));
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://**/*', (route) =>
    route.request().url().endsWith('/missing.png')
      ? route.abort('failed')
      : route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#e6ecdc"/><path d="M65 50l-25 25 15 20 15-10v75h60V85l15 10 15-20-25-25-20 12H85z" fill="#879c70"/></svg>',
        }),
  );
  await page
    .getByRole('button', { name: '稍后配置，先使用人工接待', exact: true })
    .waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: '稍后配置，先使用人工接待', exact: true }).click();
  await page.getByRole('heading', { name: '先把你的店铺连进来' }).waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: '先人工接待，稍后配置' }).click();
  await app.evaluate(() => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const original = EventEmitter.prototype.emit;
    const state = {
      worker: null,
      platforms: {},
      queries: [],
      actions: [],
      sends: 0,
      delayed: false,
      staff: [{ id: 'staff-2', name: '售后客服小林' }],
      staffError: false,
      refreshedProductImage: false,
    };
    globalThis.__deskSmoke = state;
    state.call = (data) =>
      new Promise((resolve, reject) => {
        const worker = state.worker,
          id = crypto.randomUUID();
        const timer = setTimeout(() => {
          worker.removeListener('message', listener);
          reject(new Error('Fixture IPC timeout'));
        }, 15000);
        const listener = (r) => {
          if (r.type !== 'result' || r.id !== id) return;
          clearTimeout(timer);
          worker.removeListener('message', listener);
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        };
        worker.on('message', listener);
        worker.postMessage({ ...data, id });
      });
    EventEmitter.prototype.emit = function (event, ...args) {
      const data = args[0];
      if (event === 'message' && data?.type === 'result' && typeof this.postMessage === 'function')
        state.worker = this;
      if (event === 'message' && data?.type === 'host') {
        const worker = this;
        const complete = (result) =>
          worker.postMessage({ type: 'hostResult', id: data.id, ok: true, result });
        const fail = (e) =>
          worker.postMessage({ type: 'hostResult', id: data.id, ok: false, error: e.message });
        if (data.method === 'query') {
          const [account, operation, input] = data.args;
          state.queries.push({ account, operation, input });
          const platform = state.platforms[account];
          const product = {
            goodsId: '300',
            title: platform === 'goofish' ? '闲鱼咨询 · 软件使用授权' : '拼多多商品 · 纯棉基础短袖',
            imageUrl:
              platform === 'goofish'
                ? `https://img.alicdn.com/${state.refreshedProductImage ? 'refreshed' : 'missing'}.png`
                : 'https://img.pddpic.com/fixture.png',
            priceText: '¥39.90',
            description: '柔软透气，多色可选。',
          };
          const order = {
            orderSn: '123456789',
            productTitle: product.title,
            statusText: '待发货',
            amountText: '¥39.90',
            canShipWithoutLogistics: platform === 'goofish',
          };
          const bodies = {
            goods: { products: [product], hasMore: false },
            'buyer-footprint': { products: [product], hasMore: false },
            'conversation-item': { product },
            'goods-detail': {
              product:
                platform === 'goofish'
                  ? { ...product, imageUrl: 'https://img.alicdn.com/detail.png' }
                  : product,
              properties: [{ name: '材质', values: ['棉', '氨纶'] }],
            },
            'goods-skus': {
              items: [
                {
                  skuId: '400',
                  specs: [{ name: '颜色', value: '米白' }],
                  groupPriceCents: 3990,
                  quantity: 12,
                },
              ],
              nextOffset: null,
            },
            'buyer-orders': { orders: [order], hasMore: false },
            'order-detail': { order },
            'order-logistics': {
              orderSn: order.orderSn,
              records: [{ label: '状态', value: '等待卖家交付' }],
            },
            'buyer-profile': { name: '闲鱼买家', introduction: '平台返回的客户简介' },
            history: { messages: [], nextCursor: null, hasMore: false },
          };
          const result = {
            operation,
            queriedAt: new Date().toISOString(),
            partial: false,
            failedSections: [],
            subjectId:
              operation === 'goods'
                ? undefined
                : operation.startsWith('goods-')
                  ? input.goodsId
                  : input.buyerId,
            data: bodies[operation],
          };
          if (state.delayed) {
            state.delayed = false;
            setTimeout(() => complete(result), 800);
          } else complete(result);
          return true;
        }
        if (data.method === 'staff') {
          if (state.staffError) fail(new Error('抖店拒绝查询，请检查平台登录和接口权限'));
          else complete(state.staff);
          return true;
        }
        if (['executeAction', 'executeShipment', 'executeTransfer'].includes(data.method)) {
          const c = data.args[0];
          state.actions.push({ method: data.method, command: c });
          const preview =
            data.method === 'executeTransfer'
              ? {
                  targetStaffId: c.targetStaffId,
                  targetName: '售后客服小林',
                  buyerId: c.buyerId,
                  conversationKey: c.conversationKey,
                }
              : data.method === 'executeShipment'
                ? {
                    orderSn: c.orderSn,
                    buyerId: c.buyerId,
                    sellerId: '500',
                    note: c.note,
                    deliveryMode: c.deliveryMode,
                  }
                : {
                    before: { remark: '原始备注', tag: 1, tagName: '重点' },
                    after: { remark: '原始备注\n' + c.note, tag: 1, tagName: '重点' },
                  };
          state
            .call({
              type:
                data.method === 'executeTransfer'
                  ? 'platform_transfer_guard'
                  : data.method === 'executeShipment'
                    ? 'platform_shipment_guard'
                    : 'platform_action_guard',
              actionId: c.id,
              preview,
            })
            .then(() =>
              complete({
                status: 'confirmed',
                reasonCode: 'fixture',
                message:
                  data.method === 'executeTransfer'
                    ? '平台已确认转接'
                    : data.method === 'executeShipment'
                      ? '无需物流发货已确认'
                      : '订单备注已追加，并已从平台读回核实',
              }),
            )
            .catch(fail);
          return true;
        }
        if (data.method === 'send') {
          state.sends++;
          complete({ status: 'confirmed', externalId: `smoke-${data.args[0].id}` });
          return true;
        }
        if (data.method === 'connect' || data.method === 'verify') {
          complete({ ok: true });
          return true;
        }
        if (data.method === 'markRead' || data.method === 'saveFile') {
          complete(null);
          return true;
        }
      }
      return original.call(this, event, ...args);
    };
  });
  await page.evaluate(() => window.judesk.call('app.state'));
  const callWorker = (data) => app.evaluate((_, d) => globalThis.__deskSmoke.call(d), data);
  const accounts = [];
  for (const [platform, mallId, mallName] of [
    ['pinduoduo', '100', '青禾服饰旗舰店'],
    ['goofish', '500', '小聚数码服务'],
    ['douyin', '600', '青禾抖店'],
  ]) {
    const account = await callWorker({
      type: 'account',
      input: {
        platform,
        partition: `persist:desk-${platform}`,
        mallId,
        mallName,
        externalId: `${mallId}1`,
        name: '主接待账号',
        capabilities: {
          receive: true,
          sendText: true,
          sendImage: false,
          goods: true,
          orders: true,
          history: true,
          buyerProfile: true,
          orderRemark: true,
          shipment: true,
          staffTransfer: platform !== 'goofish',
          verified: true,
        },
      },
    });
    accounts.push(account);
    await app.evaluate(
      (_, { id, platform }) => {
        globalThis.__deskSmoke.platforms[id] = platform;
      },
      { id: account.id, platform },
    );
    await callWorker({
      type: 'incoming',
      input: {
        accountId: account.id,
        externalId: `msg-${platform}`,
        eventKey: `msg-${platform}`,
        buyerId: '200',
        buyerName: `${mallName}的买家`,
        conversationKey: `${platform}:200`,
        direction: 'in',
        origin: 'buyer',
        kind: 'text',
        text: platform === 'goofish' ? '已经收到了，帮我确认交付吧' : '这款米白色还有库存吗？',
        timestamp: new Date().toISOString(),
        raw: {},
      },
    });
  }
  await callWorker({
    type: 'incoming',
    input: {
      accountId: accounts[0].id,
      externalId: 'second-buyer',
      eventKey: 'second-buyer',
      buyerId: '201',
      buyerName: '另一位买家',
      conversationKey: 'pinduoduo:201',
      direction: 'in',
      origin: 'buyer',
      kind: 'text',
      text: '请问什么时候发货',
      timestamp: new Date().toISOString(),
      raw: {},
    },
  });
  // An old saved view preference must not hide the unified reception composer.
  await page.evaluate(() => localStorage.setItem('judesk.inboxMode', 'aggregate'));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 4);
  await page.locator('.toast').waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('接待店铺范围').locator('option').count(), 4);
  assert.equal(await page.locator('.conversation-item').count(), 4);
  await page.screenshot({ path: '.artifacts/reception-center.png', animations: 'disabled' });
  assert.equal(await page.getByRole('button', { name: /聚合接待|人工工作台/ }).count(), 0);
  console.log('Unified reception verified');
  const policies = await page.evaluate(() => window.judesk.call('stores.list'));
  assert.equal(await page.locator('.reception-overview').count(), 0);
  assert.equal(await page.locator('.composer').count(), 0);
  // Reading a customer does not silently switch the shop scope. Clearing unread keeps the chat open.
  await page.getByRole('button', { name: '未读', exact: true }).click();
  await page.locator('.conversation-item').filter({ hasText: '青禾服饰旗舰店的买家' }).click();
  await page.locator('.chat-header h3').filter({ hasText: '青禾服饰旗舰店的买家' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 3);
  assert.equal(await page.getByLabel('接待店铺范围').inputValue(), '');
  await page.locator('.composer textarea').waitFor();
  const viewed = (await page.evaluate(() => window.judesk.call('conversations.list', {}))).find(
    (c) => c.buyerName === '青禾服饰旗舰店的买家',
  );
  assert.equal(viewed.openedByHuman, false);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.getByLabel('接待店铺范围').selectOption({ label: '青禾服饰旗舰店' });
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 2);
  await page.locator('.conversation-item').filter({ hasText: '青禾服饰旗舰店的买家' }).click();
  await page.locator('.chat-header h3').filter({ hasText: '青禾服饰旗舰店的买家' }).waitFor();
  await page.locator('.composer textarea').fill('这一位客户的草稿');
  await page.locator('.conversation-item').filter({ hasText: '另一位买家' }).click();
  await page.locator('.chat-header h3').filter({ hasText: '另一位买家' }).waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), '');
  await page.locator('.composer textarea').fill('第二位客户草稿');
  await page.locator('.conversation-item').filter({ hasText: '青禾服饰旗舰店的买家' }).click();
  await page.locator('.chat-header h3').filter({ hasText: '青禾服饰旗舰店的买家' }).waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), '这一位客户的草稿');
  if (await page.getByRole('button', { name: '客户与订单', exact: true }).isVisible())
    await page.getByRole('button', { name: '客户与订单', exact: true }).click();
  await page.locator('.desk-product').first().waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.desk-product img');
    return img?.complete && img.naturalWidth > 0;
  });
  await page.locator('.desk-product').first().click();
  const detail = page.getByRole('dialog', { name: '商品详情', exact: true });
  await detail.getByText('棉、氨纶', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '规格与库存', exact: true }).click();
  await detail.getByText('库存 12', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const reads = await app.evaluate(() => globalThis.__deskSmoke.queries.length);
  await callWorker({
    type: 'incoming',
    input: {
      accountId: accounts[0].id,
      externalId: 'refresh-event',
      eventKey: 'refresh-event',
      buyerId: '200',
      buyerName: '青禾服饰旗舰店的买家',
      conversationKey: 'pinduoduo:200',
      direction: 'in',
      origin: 'buyer',
      kind: 'text',
      text: '我看中米白色',
      timestamp: new Date().toISOString(),
      raw: {},
    },
  });
  await page.getByText('我看中米白色', { exact: true }).last().waitFor();
  assert.equal(await app.evaluate(() => globalThis.__deskSmoke.queries.length), reads);
  await page
    .getByRole('navigation', { name: '会话业务资料' })
    .getByRole('button', { name: '订单', exact: true })
    .click();
  await page.locator('.desk-order').click();
  await page.getByRole('button', { name: '追加订单备注', exact: true }).click();
  const remark = page.getByRole('dialog', { name: '追加订单备注', exact: true });
  await remark.getByLabel('操作说明').fill('买家希望晚一天发货');
  await remark.getByRole('button', { name: '确认追加订单备注', exact: true }).click();
  await remark.getByRole('status').filter({ hasText: '已追加' }).waitFor();
  await remark.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page
    .getByRole('dialog', { name: '订单详情', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '会话业务资料' })
    .getByRole('button', { name: '记录', exact: true })
    .click();
  await page.getByText('买家希望晚一天发货', { exact: true }).waitFor();
  await page.getByRole('button', { name: '接管会话', exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.judesk.call('conversations.list', {}))).find(
      (c) => c.id === viewed.id,
    ).openedByHuman,
    false,
  );
  await page.screenshot({ path: '.artifacts/workbench-records.png', animations: 'disabled' });
  console.log('Product, draft and remark verified');
  await page.getByRole('button', { name: '转接客服', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: '转接平台客服', exact: true });
  await transfer.getByLabel('目标客服').selectOption({ label: '售后客服小林' });
  await transfer.getByLabel('交接说明').fill('请协助售后');
  await transfer.getByRole('button', { name: '确认转接', exact: true }).click();
  await transfer.getByRole('status').filter({ hasText: '已确认' }).waitFor();
  await transfer.getByRole('button', { name: '关闭', exact: true }).last().click();
  // Native transfer blocks returning to AI until explicit platform review.
  await page.getByRole('button', { name: '交还 AI', exact: true }).click();
  await page.getByText(/仍有业务操作或平台转接需要核对/).waitFor();
  await page.getByRole('button', { name: '已在原平台核对', exact: true }).click();
  await page
    .getByRole('textbox', { name: '核对结果', exact: true })
    .fill('已在原平台重新分配给本账号');
  await page.getByRole('button', { name: '保存核对记录', exact: true }).click();
  await page.getByRole('button', { name: '交还 AI', exact: true }).click();
  await page.getByRole('button', { name: '接管会话', exact: true }).waitFor();
  console.log('Transfer and review verified');
  const closeSide = page.getByRole('button', { name: '收起客户与订单', exact: true });
  if (await closeSide.isVisible()) await closeSide.click();
  await page.getByLabel('接待店铺范围').selectOption({ label: '青禾抖店' });
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 1);
  await page.locator('.conversation-item').click();
  if (await page.getByRole('button', { name: '客户与订单', exact: true }).isVisible())
    await page.getByRole('button', { name: '客户与订单', exact: true }).click();
  await app.evaluate(() => {
    globalThis.__deskSmoke.staff = [];
  });
  await page.getByRole('button', { name: '转接客服', exact: true }).click();
  const emptyStaff = transfer.getByRole('status').filter({ hasText: '暂无其他可转接客服' });
  const confirmTransfer = transfer.getByRole('button', { name: '确认转接', exact: true });
  const refreshStaff = transfer.getByRole('button', { name: '刷新客服列表', exact: true });
  await emptyStaff.waitFor();
  await transfer.getByText(/当前接待账号：主接待账号/).waitFor();
  await transfer.getByText(/规则设置/).waitFor();
  assert.equal(await confirmTransfer.isDisabled(), true);
  assert.equal(
    await transfer.getByRole('button', { name: '打开原平台', exact: true }).isVisible(),
    true,
  );
  await page.screenshot({ path: '.artifacts/douyin-transfer-empty.png', animations: 'disabled' });
  const restoreStaff = () =>
    app.evaluate(() => {
      globalThis.__deskSmoke.staff = [{ id: 'staff-2', name: '售后客服小林' }];
      globalThis.__deskSmoke.staffError = false;
    });
  await restoreStaff();
  await refreshStaff.click();
  await transfer.getByLabel('目标客服').selectOption({ label: '售后客服小林' });
  assert.equal(await confirmTransfer.isEnabled(), true);
  // A refreshed list can revoke a previously selected target.
  await app.evaluate(() => {
    globalThis.__deskSmoke.staff = [];
  });
  await refreshStaff.click();
  await emptyStaff.waitFor();
  assert.equal(await confirmTransfer.isDisabled(), true);
  await transfer.getByRole('button', { name: '取消', exact: true }).click();
  await restoreStaff();
  // Reopening immediately must query again, even after a recent empty response.
  await page.getByRole('button', { name: '转接客服', exact: true }).click();
  await transfer.getByLabel('目标客服').selectOption({ label: '售后客服小林' });
  await app.evaluate(() => {
    globalThis.__deskSmoke.staffError = true;
  });
  await refreshStaff.click();
  await transfer.getByRole('alert').filter({ hasText: '抖店拒绝查询' }).waitFor();
  assert.equal(await emptyStaff.count(), 0);
  assert.equal(await confirmTransfer.isDisabled(), true);
  await restoreStaff();
  await transfer.getByRole('button', { name: '重试查询', exact: true }).click();
  await transfer.getByLabel('目标客服').selectOption({ label: '售后客服小林' });
  assert.equal(await confirmTransfer.isEnabled(), true);
  await transfer.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.__deskSmoke.actions.length), 2);
  console.log('Douyin transfer empty state, refresh and query failure verified');
  if (await closeSide.isVisible()) await closeSide.click();
  await page.getByLabel('接待店铺范围').selectOption({ label: '小聚数码服务' });
  await page.waitForFunction(() => document.querySelectorAll('.conversation-item').length === 1);
  await page.locator('.conversation-item').click();
  if (await page.getByRole('button', { name: '客户与订单', exact: true }).isVisible())
    await page.getByRole('button', { name: '客户与订单', exact: true }).click();
  await page.locator('.desk-product').filter({ hasText: '闲鱼咨询' }).waitFor();
  await page.locator('.desk-product .desk-photo svg').waitFor();
  // Let the list thumbnail fail inside the dialog before the detail query supplies its image.
  await app.evaluate(() => {
    globalThis.__deskSmoke.delayed = true;
  });
  await page.locator('.desk-product').click();
  await detail.locator('.desk-photo svg').waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.desk-product-hero img');
    return img?.src.endsWith('/detail.png') && img.complete && img.naturalWidth > 0;
  });
  await detail.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await app.evaluate(() => {
    globalThis.__deskSmoke.refreshedProductImage = true;
  });
  await page.getByRole('button', { name: '刷新平台资料', exact: true }).click();
  await page.waitForFunction(() => {
    const img = document.querySelector('.desk-product img');
    return img?.src.endsWith('/refreshed.png') && img.complete && img.naturalWidth > 0;
  });
  console.log('Product detail image and thumbnail recovery verified');
  assert.equal(
    await page.locator('.workbench-panel').getByText('拼多多商品', { exact: false }).count(),
    0,
  );
  await page
    .getByRole('navigation', { name: '会话业务资料' })
    .getByRole('button', { name: '订单', exact: true })
    .click();
  await page.getByRole('heading', { name: '当前会话关联订单', exact: true }).waitFor();
  await page.locator('.desk-order').click();
  await page.getByRole('button', { name: '无需物流发货', exact: true }).click();
  const ship = page.getByRole('dialog', { name: '无需物流发货', exact: true });
  await ship.getByLabel('操作说明').fill('已通过平台完成交付');
  assert.equal(
    await ship.getByRole('button', { name: '确认无需物流发货', exact: true }).isDisabled(),
    true,
  );
  await ship.getByRole('checkbox').check();
  await ship.getByRole('button', { name: '确认无需物流发货', exact: true }).click();
  await ship.getByRole('status').filter({ hasText: '已确认' }).waitFor();
  await ship.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page
    .getByRole('dialog', { name: '订单详情', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '会话业务资料' })
    .getByRole('button', { name: '商品', exact: true })
    .click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await page.screenshot({ path: '.artifacts/workbench-wide.png', animations: 'disabled' });
  console.log('Shipment verified');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 800));
  await page.waitForFunction(() => innerWidth <= 1200);
  if (await closeSide.isVisible()) await closeSide.click();
  if (await page.getByRole('button', { name: '客户与订单', exact: true }).isVisible())
    await page.getByRole('button', { name: '客户与订单', exact: true }).click();
  await page.screenshot({ path: '.artifacts/workbench-compact.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await checkProductNavigation({ app, page, accounts, dir });
  const after = await page.evaluate(() => window.judesk.call('stores.list'));
  assert.deepEqual(
    after.map((s) => [s.id, s.replyPolicy.autoReplyEnabled]),
    policies.map((s) => [s.id, s.replyPolicy.autoReplyEnabled]),
  );
  const state = await app.evaluate(() => ({
    sends: globalThis.__deskSmoke.sends,
    actions: globalThis.__deskSmoke.actions.length,
  }));
  assert.equal(state.sends, 0);
  assert.equal(state.actions, 3);
  assert.deepEqual(errors, []);
  console.log(
    'Workbench Electron smoke passed: unified reception, store/account context, drafts, images/SKU, manual remark, native transfer/review, no-logistics shipment, records and responsive sidebar. No customer/model API called.',
  );
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: '.artifacts/workbench-smoke-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await rm(dir, { recursive: true, force: true });
}
