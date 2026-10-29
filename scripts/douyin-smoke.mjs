import assert from 'node:assert/strict';
import {
  douyinGoods,
  douyinDetail,
  douyinHistory,
  douyinEmptyOrders,
} from '../tests/fixtures-douyin-query.ts';

// Uses the actual Electron WorkbenchHost + resource bridge + utility service in the
// smoke test's temporary user directory. Only the platform web page is a fixture.
export async function checkDouyin({ app, page, imagePath }) {
  const html = `<!doctype html><html><body>抖店隔离测试页面<script>
    const listeners = new Set(), changes = new Set();
    const cid = 'AQ-smoke-buyer:onboarding-mall::2:1:pigeon';
    window.__fixture = { sends: [], receiptPrefix: 'dy-native-sent-', cid, emit(text, id, role = '1') {
      const message = { serverId: id, conversationId: cid, sender: role === '1' ? 'AQ-smoke-buyer' : 'dy-smoke-staff', content: text, type: 1000, flightStatus: 4, createTime: Date.now(), originExt: { type: 'text', sender_role: role, shop_id: 'onboarding-mall' } };
      for (const callback of listeners) callback(message);
    }};
    const queryFixtures = ${JSON.stringify({ goods: douyinGoods, detail: douyinDetail, history: douyinHistory, orders: douyinEmptyOrders })};
    window.__fixture.queries = [];
    const extra = {
      get: async (path, input) => {
        if (path === '/backstage/currentuser') return { st: 0, data: { ShopId: 'onboarding-mall', ShopName: '抖店集成测试店', CustomerServiceInfo: { id: 'dy-smoke-staff', screen_name: '飞鸽测试客服' } } };
        window.__fixture.queries.push({ method: 'get', path, input });
        if (path === '/backstage/productdetail') return structuredClone(queryFixtures.detail);
        if (path === '/chat/api/backstage/conversation/get_history_msg') return structuredClone(queryFixtures.history);
        if (['/backstage/workstation/get_product_list', '/pcbackstage/workstation/get_product_list'].includes(path)) return structuredClone(queryFixtures.goods);
        throw new Error('unexpected fixture GET: ' + path);
      },
      post: async (path, input) => {
        window.__fixture.queries.push({ method: 'post', path, input });
        if (path !== '/backstage/cmpoent/order/query') throw new Error('unexpected fixture POST: ' + path);
        return structuredClone(queryFixtures.orders);
      },
      im: {
        initialStatus: 'succeed',
        message$: { subscribe(callback) { listeners.add(callback); return { unsubscribe() { listeners.delete(callback); } }; } },
        onMessageChange(callback) { changes.add(callback); return { unsubscribe() { changes.delete(callback); } }; },
        getConversation: async id => ({ id, securityConversationId: id, originExt: {} }),
        sendText: async (id, text, ext) => {
          window.__fixture.sends.push({ id, text, ext });
          const message = { serverId: window.__fixture.receiptPrefix + window.__fixture.sends.length, conversationId: id, sender: 'dy-smoke-staff', content: text, type: 1000, flightStatus: 3, createTime: Date.now(), originExt: { ...ext, type: 'text', sender_role: '2' } };
          for (const callback of changes) callback(message);
          return message;
        }
      }
    };
    window.__workbench__ = { workbenchOptions: { extra } };
  </script></body></html>`;
  await app.evaluate(({ app, dialog }, html) => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const originalEmit = EventEmitter.prototype.emit;
    const state = {
      contents: null,
      hook: null,
      html,
      worker: null,
      originalEmit,
      originalPost: null,
      originalShowOpenDialog: dialog.showOpenDialog,
      pending: new Map(),
    };
    EventEmitter.prototype.emit = function (event, ...args) {
      if (
        event === 'message' &&
        args[0]?.type === 'result' &&
        typeof this.postMessage === 'function' &&
        !state.worker
      ) {
        state.worker = this;
        state.originalPost = this.postMessage;
        this.postMessage = function (data, ...rest) {
          if (data.type === 'hostResult' && state.pending.has(data.id)) {
            const pending = state.pending.get(data.id);
            state.pending.delete(data.id);
            data.ok ? pending.resolve(data.result) : pending.reject(new Error(data.error));
            return;
          }
          return state.originalPost.call(this, data, ...rest);
        };
      }
      return originalEmit.call(this, event, ...args);
    };
    state.hook = (_event, contents) => {
      const load = contents.loadURL.bind(contents),
        getURL = contents.getURL.bind(contents);
      let fixture = false;
      contents.loadURL = async (url, ...args) => {
        if (
          url === 'https://im.jinritemai.com/pc_seller_v2/' ||
          url === 'https://fxg.jinritemai.com/login'
        ) {
          fixture = true;
          state.contents = contents;
          return load('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        }
        return load(url, ...args);
      };
      contents.getURL = () => (fixture ? 'https://im.jinritemai.com/pc_seller_v2/' : getURL());
    };
    globalThis.__douyinSmoke = state;
    app.on('web-contents-created', state.hook);
  }, html);
  let account;
  try {
    await page.getByRole('button', { name: '店铺管理', exact: true }).click();
    // New users can explicitly select Douyin in the same connect flow.
    await page.getByRole('button', { name: '连接店铺', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '登录抖店', exact: true }).click();
    const deadline = Date.now() + 20000;
    let store, pddStore;
    while (Date.now() < deadline) {
      const stores = await page.evaluate(() => window.judesk.call('stores.list'));
      store = stores.find((s) => s.platform === 'douyin');
      account = store?.accounts.find((a) => a.status === 'online');
      if (account) {
        pddStore = stores.find(
          (s) => s.platform === 'pinduoduo' && s.externalId === store.externalId,
        );
        assert.ok(pddStore && pddStore.id !== store.id);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(account, 'Douyin account must register through the real host and IPC bridge');
    assert.equal(account.connection.diagnostics.sdkState, 'succeed');
    const results = await app.evaluate(async (_electron, accountId) => {
      const state = globalThis.__douyinSmoke;
      if (!state.worker) throw new Error('fixture service was not captured');
      const cid = 'AQ-smoke-buyer:onboarding-mall::2:1:pigeon';
      const results = {};
      for (const op of ['goods', 'goods-detail', 'buyer-footprint', 'buyer-orders', 'history']) {
        const id = '__dy_query_' + op;
        const promise = new Promise((resolve, reject) =>
          state.pending.set(id, { resolve, reject }),
        );
        // Dispatch through the actual main-process host handler and Electron bridge.
        state.worker.emit('message', {
          type: 'host',
          id,
          method: 'query',
          args: [
            accountId,
            op,
            {
              buyerId: 'AQ-smoke-buyer',
              conversationKey: cid,
              platformContext: { securityUserId: 'AQ-smoke-buyer', securityConversationId: cid },
              ...(op === 'goods-detail' ? { goodsId: '3737994268627829217' } : {}),
            },
          ],
        });
        results[op] = await promise;
      }
      return results;
    }, account.id);
    assert.equal(results.goods.data.products[0].goodsId, '3737994268627829217');
    assert.equal(results.goods.data.products[0].priceText, '¥100.00');
    assert.equal(results['goods-detail'].data.product.priceText, '¥100.00');
    assert.equal(results['buyer-footprint'].subjectId, 'AQ-smoke-buyer');
    assert.equal(results['buyer-footprint'].data.products[0].title, '测试休闲椅');
    assert.deepEqual(results['buyer-orders'].data.orders, []);
    assert.equal(results.history.data.nextCursor, '1788878584337124');
    assert.equal(results.history.data.messages[0].text, '商品有哪些颜色');
    const observedQueries = await app.evaluate(async () =>
      globalThis.__douyinSmoke.contents.executeJavaScript('window.__fixture.queries'),
    );
    assert.equal(observedQueries.length, 5);
    assert.equal(observedQueries[1].input.product_id, '3737994268627829217');
    assert.equal(observedQueries[3].input.security_user_id, 'AQ-smoke-buyer');
    assert.equal(
      observedQueries[4].input.securityBizConversationId,
      'AQ-smoke-buyer:onboarding-mall::2:1:pigeon',
    );

    await app.evaluate(async () => {
      await globalThis.__douyinSmoke.contents.executeJavaScript(
        "window.__fixture.emit('抖店测试买家问题', 'dy-native-question')",
      );
    });
    let conversation;
    while (Date.now() < deadline) {
      const conversations = await page.evaluate(
        (storeId) => window.judesk.call('conversations.list', { storeId }),
        store.id,
      );
      conversation = conversations[0];
      if (conversation) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(conversation);
    assert.equal(conversation.externalKey, 'AQ-smoke-buyer:onboarding-mall::2:1:pigeon');
    const outbound = await page.evaluate(
      async (conversationId) =>
        window.judesk.call('messages.send', {
          conversationId,
          text: '句达发给抖店买家的回复',
          requestId: crypto.randomUUID(),
        }),
      conversation.id,
    );
    assert.ok(outbound.id);
    await page.waitForFunction(
      async (id) => {
        const messages = await window.judesk.call('conversations.messages', { conversationId: id });
        return messages.some((m) => m.externalId === 'dy-native-sent-1');
      },
      conversation.id,
      { timeout: 10000 },
    );
    const sends = await app.evaluate(async () =>
      globalThis.__douyinSmoke.contents.executeJavaScript('window.__fixture.sends'),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].id, conversation.externalKey);
    assert.equal(sends[0].text, '句达发给抖店买家的回复');
    await app.evaluate(async () => {
      await globalThis.__douyinSmoke.contents.executeJavaScript(
        "window.__fixture.emit('原平台人工回答也应同步', 'dy-native-manual', '2')",
      );
    });
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.getByLabel('接待店铺范围').selectOption({ label: store.name });
    await page.locator('.conversation-item').filter({ hasText: store.name }).first().waitFor();
    await page.locator('.conversation-item').filter({ hasText: store.name }).first().click();
    await page
      .locator('.bubble')
      .filter({ hasText: /^抖店测试买家问题$/ })
      .waitFor();
    await page
      .locator('.bubble')
      .filter({ hasText: /^句达发给抖店买家的回复$/ })
      .waitFor();
    await page
      .locator('.bubble')
      .filter({ hasText: /^原平台人工回答也应同步$/ })
      .waitFor();
    await page.screenshot({ path: '.artifacts/douyin-workspace.png', animations: 'disabled' });
    await page.getByRole('button', { name: '问答库', exact: true }).click();
    await page
      .getByText('维护客服可直接使用的标准回答。通用问答适用所有店铺，专属问答只在所属店铺使用。', {
        exact: true,
      })
      .waitFor();
    await page.screenshot({ path: '.artifacts/douyin-knowledge.png', animations: 'disabled' });
    // The shop selector is explicit, and saving switches the library to the chosen shop.
    await page.getByRole('combobox', { name: '问答所属范围', exact: true }).selectOption(store.id);
    await page.getByRole('button', { name: '新建问答', exact: true }).click();
    let qaDialog = page.getByRole('dialog');
    assert.equal(await qaDialog.getByRole('combobox', { name: '所属店铺' }).inputValue(), store.id);
    await qaDialog.getByPlaceholder('例如：这款商品多久可以发货？').fill('选择目标店铺创建问答');
    await qaDialog.getByPlaceholder('填写经过确认的标准回答…').fill('只用于目标店铺的标准答案');
    await qaDialog.getByLabel(/^适用商品 ID/).fill('3737994268627829217');
    await qaDialog.getByRole('combobox', { name: '所属店铺' }).selectOption(pddStore.id);
    assert.equal(await qaDialog.getByLabel(/^适用商品 ID/).inputValue(), '');
    await page.screenshot({
      path: '.artifacts/knowledge-store-selector.png',
      animations: 'disabled',
    });
    await qaDialog.getByRole('button', { name: '保存并启用', exact: true }).click();
    await qaDialog.waitFor({ state: 'hidden' });
    await page
      .getByText('维护客服可直接使用的标准回答。通用问答适用所有店铺，专属问答只在所属店铺使用。', {
        exact: true,
      })
      .waitFor();
    const entries = await page.evaluate(
      async ({ targetId, otherId }) => ({
        target: await window.judesk.call('knowledge.list', { storeId: targetId }),
        other: await window.judesk.call('knowledge.list', { storeId: otherId }),
      }),
      { targetId: pddStore.id, otherId: store.id },
    );
    assert.ok(
      entries.target.some((entry) => entry.revisions[0]?.intent === '选择目标店铺创建问答'),
    );
    assert.ok(
      !entries.other.some((entry) => entry.revisions[0]?.intent === '选择目标店铺创建问答'),
    );
    await page
      .getByRole('row')
      .filter({ hasText: '选择目标店铺创建问答' })
      .getByTitle('编辑问答')
      .click();
    qaDialog = page.getByRole('dialog');
    assert.equal(
      await qaDialog.getByRole('combobox', { name: '所属店铺' }).inputValue(),
      pddStore.id,
    );
    assert.ok(await qaDialog.getByRole('combobox', { name: '所属店铺' }).isEnabled());
    await qaDialog.getByRole('button', { name: '取消', exact: true }).click();
    // Import an actual image into this new temporary profile through the service.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, imagePath);
    await page.getByRole('button', { name: '新建问答', exact: true }).click();
    qaDialog = page.getByRole('dialog');
    await qaDialog.getByRole('button', { name: '图片回答', exact: true }).click();
    await qaDialog.locator('.upload-zone').click();
    await qaDialog.locator('.upload-zone img').waitFor();
    await qaDialog.getByRole('combobox', { name: '所属店铺' }).selectOption(store.id);
    assert.equal(await qaDialog.locator('.upload-zone img').count(), 0);
    await qaDialog.getByText('点击选择本地图片', { exact: true }).waitFor();
    await qaDialog.getByRole('button', { name: '取消', exact: true }).click();

    // Removing the last account keeps historical QA, but must remove the shop
    // from every chooser, including an already-open modal targeting that shop.
    await page
      .getByRole('combobox', { name: '问答所属范围', exact: true })
      .selectOption(pddStore.id);
    await page.getByRole('button', { name: '新建问答', exact: true }).click();
    qaDialog = page.getByRole('dialog');
    await page.evaluate(
      (accountId) => window.judesk.call('accounts.disconnect', { accountId }),
      pddStore.accounts[0].id,
    );
    await qaDialog.getByRole('combobox', { name: '所属店铺' }).selectOption(pddStore.id);
    await qaDialog.getByPlaceholder('例如：这款商品多久可以发货？').fill('移除期间保留的问题草稿');
    await qaDialog.getByLabel(/^适用商品 ID/).fill('12345');
    await qaDialog.getByRole('button', { name: '图片回答', exact: true }).click();
    await qaDialog.locator('.upload-zone').click();
    await qaDialog.locator('.upload-zone img').waitFor();
    await page.evaluate(
      (accountId) => window.judesk.call('accounts.remove', { accountId }),
      pddStore.accounts[0].id,
    );
    await page.waitForFunction((removedId) => {
      const selector = document.querySelector('select[aria-label="所属店铺"]');
      return (
        selector &&
        selector.value === '__removed__' &&
        ![...selector.options].some((o) => o.value === removedId)
      );
    }, pddStore.id);
    assert.ok(await qaDialog.getByRole('button', { name: '保存并启用', exact: true }).isDisabled());
    assert.equal(await qaDialog.getByLabel(/^适用商品 ID/).inputValue(), '');
    assert.equal(await qaDialog.locator('.upload-zone img').count(), 0);
    assert.equal(
      await qaDialog.getByPlaceholder('例如：这款商品多久可以发货？').inputValue(),
      '移除期间保留的问题草稿',
    );
    assert.ok(
      (
        await page.evaluate(
          (storeId) => window.judesk.call('knowledge.list', { storeId }),
          pddStore.id,
        )
      ).length > 0,
    );
    await qaDialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '新建问答', exact: true }).click();
    qaDialog = page.getByRole('dialog');
    const availableStoreIds = await qaDialog
      .getByRole('combobox', { name: '所属店铺' })
      .locator('option')
      .evaluateAll((options) => options.map((o) => o.value));
    assert.ok(availableStoreIds.includes(''));
    assert.ok(availableStoreIds.includes(store.id));
    assert.ok(!availableStoreIds.includes(pddStore.id));
    await page.screenshot({
      path: '.artifacts/knowledge-removed-store.png',
      animations: 'disabled',
    });
    await qaDialog.getByRole('button', { name: '取消', exact: true }).click();

    // Recreate the reported failure: remove and reconnect the same shop, then
    // reply in its preserved conversation without emitting a new buyer message.
    const previousAccountId = account.id;
    await page.evaluate(
      (accountId) => window.judesk.call('accounts.remove', { accountId }),
      previousAccountId,
    );
    await page.evaluate(() => window.judesk.call('accounts.connect', { platform: 'douyin' }));
    const reconnectDeadline = Date.now() + 20000;
    let reconnected;
    while (Date.now() < reconnectDeadline) {
      reconnected = await page.evaluate(
        async ({ storeId, previousAccountId }) =>
          (await window.judesk.call('stores.list'))
            .find((s) => s.id === storeId)
            ?.accounts.find((a) => a.id !== previousAccountId && a.status === 'online'),
        { storeId: store.id, previousAccountId },
      );
      if (reconnected) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      reconnected,
      'The same shop must reconnect with a new account through the actual host',
    );
    account = reconnected;
    assert.notEqual(account.id, previousAccountId);
    const restored = await page.evaluate(
      async ({ storeId, conversationId }) =>
        (await window.judesk.call('conversations.list', { storeId })).find(
          (c) => c.id === conversationId,
        ),
      { storeId: store.id, conversationId: conversation.id },
    );
    assert.equal(restored.accountId, account.id);
    assert.equal(restored.externalKey, conversation.externalKey);
    assert.ok(restored.routeVersion > conversation.routeVersion);
    assert.equal(
      await app.evaluate(async () => {
        const contents = globalThis.__douyinSmoke.contents;
        return contents.executeJavaScript(
          "window.__fixture.receiptPrefix = 'dy-reconnected-sent-'; window.__fixture.sends.length",
        );
      }),
      0,
    );
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.locator('.conversation-item').filter({ hasText: store.name }).first().click();
    const composer = page.getByPlaceholder('输入回复内容，Enter 发送，Shift + Enter 换行…');
    const replyText = '重新连接账号后继续回复原来的买家';
    await composer.fill(replyText);
    await composer.waitFor({ state: 'visible' });
    await page.waitForTimeout(100);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page
      .locator('.message')
      .filter({ has: page.locator('.bubble').filter({ hasText: replyText }) })
      .locator('.message-delivery.confirmed')
      .waitFor();
    const recoveredSends = await app.evaluate(async () =>
      globalThis.__douyinSmoke.contents.executeJavaScript('window.__fixture.sends'),
    );
    assert.equal(recoveredSends.length, 1);
    assert.equal(recoveredSends[0].id, conversation.externalKey);
    assert.equal(recoveredSends[0].text, replyText);
    const outbounds = await page.evaluate(
      (conversationId) => window.judesk.call('conversations.outbounds', { conversationId }),
      conversation.id,
    );
    assert.equal(outbounds.length, 2);
    assert.equal(outbounds.find((o) => o.id === outbound.id).accountId, previousAccountId);
    assert.ok(
      outbounds.some(
        (o) =>
          o.accountId === account.id &&
          o.status === 'confirmed' &&
          o.externalId === 'dy-reconnected-sent-1',
      ),
    );
    await page.screenshot({
      path: '.artifacts/manual-reconnected-account.png',
      animations: 'disabled',
    });

    console.log(
      'Douyin native desktop passed: platform chooser, actual host + injected bridge, isolated partition, same-ID stores, real IPC ingestion, exact text receipt, native manual reply sync, store switching and scoped knowledge UI, explicit QA store selection + explicit scope changes + image reset + removed-store exclusion and stale selection invalidation, all five actual host/bridge read operations with observed response shapes, account removal + re-addition + original-conversation manual reply with an exact new receipt and no replay. Platform network was fixture-only.',
    );
  } finally {
    if (account)
      await page
        .evaluate(
          (accountId) => window.judesk.call('accounts.disconnect', { accountId }),
          account.id,
        )
        .catch(() => {});
    await app.evaluate(({ app, dialog }) => {
      const state = globalThis.__douyinSmoke;
      app.removeListener('web-contents-created', state.hook);
      process.getBuiltinModule('node:events').EventEmitter.prototype.emit = state.originalEmit;
      if (state.worker) state.worker.postMessage = state.originalPost;
      dialog.showOpenDialog = state.originalShowOpenDialog;
      delete globalThis.__douyinSmoke;
    });
  }
}
