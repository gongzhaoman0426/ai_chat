import assert from 'node:assert/strict';
async function until(read, accept, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Goofish fixture wait timed out: ' + JSON.stringify(last));
}
// Real desktop host/utility-process/DB; platform network replaced in a temporary profile.
export async function checkGoofish({ app, page }) {
  const html = `<!doctype html><meta charset="utf-8"><body>闲鱼隔离测试页面<script>
    const listeners = new Set(), events = new Set();
    const session = {sessionId:'9001',sessionType:1,ownerInfo:{userId:'100'},userInfo:{userId:'200'},itemInfo:{itemId:'300',sellerInfo:{userId:'100'}}};
    window.__fixture={signedIn:true,sends:[],reads:[],emit(text,id,sender='200') {
      const m={messageId:id,sessionId:'9001',senderInfo:{userId:sender},sendState:0,messageStatus:1,timeStamp:Date.now(),content:{contentType:1,text:{text}}};
      for(const l of listeners)l.onAdd(m);
    }};
    const sdk={getUserId:()=> '101',getStore:()=>({convMap:new Map([['9001',session]])}),getConnectionStatus:()=>4,
      getMessageServiceSync:()=>({sendMessage:async message=>{
        window.__fixture.sends.push(message);
        for(const l of events)l('paas.message.changed',{cid:'9001',recordStatus:1,extension:{extJson:message.extJson},messageModel:{messageId:'800'+window.__fixture.sends.length,cid:'9001',sender:{uid:'101@goofish'},createAt:Date.now(),content:{contentType:101,custom:{data:JSON.stringify(message.content)}}}});
      }, getMessageById:async id=>({data:{messageId:id,sessionId:'9001'}}),updateMessageToRead:async (...args)=>{window.__fixture.reads.push(args);}}),
      registerMessageChangeLisnter:async l=>{listeners.add(l);return()=>listeners.delete(l);}
    };
    const client={getEventService:()=>({register:l=>{events.add(l);return()=>events.delete(l);}}),getMsgService:()=>({listPrevMsgs:async()=>({userMessageModels:[],hasMore:false})}),getConvService:()=>({}),getAuthService:()=>({})};
    const eventService=client.getEventService();client.getEventService=()=>eventService;
    const require=id=>id==='sdk'?{newName:sdk}:{exportName:client};
    require.m={sdk:function(){return 'registerMessageChangeLisnter getMessageServiceSync';},client:function(){return 'PaaSMessageChange getAuthService getEventService';}};
    window.webpackChunk_idle_fixture={push:entry=>entry[2](require)};
    window.lib={mtop:{request:async request=>{
      if(!window.__fixture.signedIn){window.__fixture.identityPending=true;await new Promise(()=>{});}
      return {ret:['SUCCESS::调用成功'],data:request.api.includes('loginuser')?{userId:'101',mainUserId:'100',nick:'闲鱼验收店'}:request.api.includes('user.query')?{userInfo:{fishNick:'闲鱼买家'}}:{}};
    }}};
  </script></body>`;
  await app.evaluate(({ app }, html) => {
    const state = { contents: null, hook: null, signedIn: false };
    state.hook = (_event, contents) => {
      const load = contents.loadURL.bind(contents),
        getURL = contents.getURL.bind(contents);
      let fixture = false;
      contents.loadURL = async (url, ...args) => {
        if (url === 'https://www.goofish.com/im') {
          fixture = true;
          state.contents = contents;
          const signedIn = state.signedIn;
          await load(
            'data:text/html;charset=utf-8,' +
              encodeURIComponent(signedIn ? html : html.replace('signedIn:true', 'signedIn:false')),
          );
          // Simulate the initial login document's unresolved loadURL as well as its MTOP call.
          if (!signedIn) await new Promise(() => {});
          return;
        }
        return load(url, ...args);
      };
      contents.getURL = () => (fixture ? 'https://www.goofish.com/im' : getURL());
    };
    globalThis.__goofishSmoke = state;
    app.on('web-contents-created', state.hook);
  }, html);
  let account;
  try {
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.getByRole('button', { name: '连接店铺', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '登录闲鱼', exact: true }).click();
    await until(
      () =>
        app.evaluate(async () =>
          globalThis.__goofishSmoke.contents?.executeJavaScript(
            'window.__fixture?.identityPending === true',
          ),
        ),
      (value) => value === true,
    );
    await app.evaluate(async () => {
      globalThis.__goofishSmoke.signedIn = true;
      await globalThis.__goofishSmoke.contents.loadURL('https://www.goofish.com/im');
    });
    const store = await until(
      () =>
        page.evaluate(async () =>
          (await window.judesk.call('stores.list')).find((s) => s.platform === 'goofish'),
        ),
      (value) => value?.accounts.some((a) => a.status === 'online'),
    );
    account = store.accounts.find((a) => a.status === 'online');
    assert.equal(store.externalId, '100');
    assert.equal(account.externalId, '101');
    assert.ok(account.capabilities.sendText);
    assert.ok(account.capabilities.operations.includes('buyer-profile'));
    await app.evaluate(async () =>
      globalThis.__goofishSmoke.contents.executeJavaScript(
        "window.__fixture.emit('闲鱼买家咨询','7001')",
      ),
    );
    const conversation = await until(
      () =>
        page.evaluate(
          async (id) => (await window.judesk.call('conversations.list', { storeId: id }))[0],
          store.id,
        ),
      (value) => !!value,
    );
    assert.equal(conversation.externalKey, '9001');
    assert.equal(conversation.buyerId, '200');
    const sent = await page.evaluate(
      (conversationId) =>
        window.judesk.call('messages.send', {
          conversationId,
          text: '闲鱼接入测试回复',
          requestId: crypto.randomUUID(),
        }),
      conversation.id,
    );
    await until(
      () =>
        page.evaluate(
          (conversationId) => window.judesk.call('conversations.outbounds', { conversationId }),
          conversation.id,
        ),
      (value) => value.some((o) => o.id === sent.id && o.status === 'confirmed'),
    );
    const sends = await app.evaluate(async () =>
      globalThis.__goofishSmoke.contents.executeJavaScript('window.__fixture.sends'),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].sessionId, '9001');
    assert.equal(sends[0].content.text.text, '闲鱼接入测试回复');
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.getByLabel('接待店铺范围').selectOption({ label: store.name });
    await page.locator('.conversation-item').filter({ hasText: store.name }).first().click();
    await page
      .locator('.message')
      .filter({ has: page.locator('.bubble').filter({ hasText: '闲鱼接入测试回复' }) })
      .getByRole('status', { name: '已发送', exact: true })
      .waitFor();
    await page.evaluate(
      (conversationId) => window.judesk.call('conversations.open', { conversationId }),
      conversation.id,
    );
    const deadline = Date.now() + 5000;
    let reads = [];
    while (Date.now() < deadline) {
      reads = await app.evaluate(async () =>
        globalThis.__goofishSmoke.contents.executeJavaScript('window.__fixture.reads'),
      );
      if (reads.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(reads.length);
    assert.equal(reads[0][0], '9001');
    await page.screenshot({ path: '.artifacts/goofish-workbench.png', animations: 'disabled' });
    console.log(
      'Goofish desktop passed: unresolved login load/request followed by navigation, automatic account registration, chooser, actual host/resource bridge/IPC, main-user store mapping, scoped inbound, asynchronous manual send with server receipt and platform read marking. Platform network was fixture-only.',
    );
  } finally {
    if (account)
      await page
        .evaluate(
          (accountId) => window.judesk.call('accounts.disconnect', { accountId }),
          account.id,
        )
        .catch(() => {});
    await app.evaluate(({ app }) => {
      app.removeListener('web-contents-created', globalThis.__goofishSmoke.hook);
      delete globalThis.__goofishSmoke;
    });
  }
}
