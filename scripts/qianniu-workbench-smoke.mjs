import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Actual shared sidebar and contracts; isolated desktop API with normalized Qianniu data.
// Scope/authorizer/evidence integration is exercised separately by qianniu-workbench.test.ts.
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp('.artifacts/qianniu-workbench-');
let browser, server;
try {
  await writeFile(
    join(directory, 'index.html'),
    '<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./entry.tsx"></script></html>',
  );
  await writeFile(
    join(directory, 'entry.tsx'),
    `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClientProvider} from '@tanstack/react-query';
import {client} from '/apps/desktop/src/renderer/api';
import {WorkbenchPanel} from '/apps/desktop/src/renderer/components/inbox/workbench-panel';
import {availableOperations} from '/packages/contracts/src/platform-operations';
import '/apps/desktop/src/renderer/styles.css';
import '/apps/desktop/src/renderer/styles-product.css';
import '/apps/desktop/src/renderer/styles-workbench.css';
const capabilities = {receive:true,sendText:true,sendImage:true,goods:true,orders:true,history:true,buyerProfile:true,staffGroups:true,staffTransfer:true,sendProductCard:true,quickActions:true};
const context = (id) => ({sessionId:'session-'+id,conversationId:id,storeId:'store-'+id,storeName:id === 'main'?'青禾千牛店':'木棉千牛店',accountId:'account-'+id,accountName:id === 'main'?'青禾:主客服':'木棉:主客服',buyerId:'buyer-'+id,buyerName:id === 'main'?'顾客小张':'顾客小李',platform:'qianniu',online:true,expiresAt:new Date(Date.now()+3600000).toISOString(),operations:[...availableOperations('qianniu', capabilities),'staff-list','transfer-conversation']});
window.fixture={calls:[],actions:[],staffAvailable:true};
window.judesk={call:async(method,input={})=>{
  const state=window.fixture;
  state.calls.push({method,input:structuredClone(input)});
  if(method==='workbench.context')return context(input.conversationId);
  if(method==='workbench.records')return [];
  if(method==='accounts.connect')return {};
  const id=input.sessionId?.replace('session-','');
  if(!['main','other'].includes(id))throw Error('Unknown scope');
  const ctx=context(id);
  const ref='11111111-1111-4111-8111-111111111111';
  const product={goodsId:id==='main'?'300':'301',title:id==='main'?'千牛纯棉衬衫':'另一店铺亚麻外套',imageUrl:'https://img.alicdn.com/fixture.jpg',priceText:'¥89.00',stock:15,productRef:'product:'+ref+':0'};
  const order={orderSn:id==='main'?'123456789':'987654321',productTitle:product.title,statusText:'买家已付款',amountText:'¥89.00',orderRef:'order:'+ref+':0',details:[{label:'商品数量',value:'1'}]};
  if(method==='workbench.action'){
    if(input.operation!=='transfer-conversation'||!state.staffAvailable||input.input.staffRef!=='staff:'+ref+':0')throw Error('Invalid transfer target');
    state.actions.push({...input,accountId:ctx.accountId,buyerId:ctx.buyerId});
    return {status:'confirmed',reasonCode:'fixture',message:'千牛已确认转接给售后客服小林',actionId:'action-1'};
  }
  if(method!=='workbench.query')throw Error('Unexpected '+method);
  const operation=input.operation;
  const bodies={goods:{products:[product],hasMore:false},'buyer-footprint':{products:[product],hasMore:false},'goods-detail':{product,properties:[{name:'库存',value:'15'}]},'buyer-orders':{orders:[order],hasMore:false},'order-detail':{order},'order-logistics':{orderSn:order.orderSn,records:[{label:'最新物流',value:'顺丰已揽收'}]},'buyer-profile':{name:ctx.buyerName,introduction:'平台返回的千牛买家资料'},history:{source:'local',messages:[{messageId:'history-1',direction:'in',text:'本机保存的咨询记录',timestamp:new Date().toISOString()}],hasMore:false,nextCursor:null},'staff-list':{staff:state.staffAvailable?[{id:'2220231913125',name:'售后客服小林',statusText:'在线',staffRef:'staff:'+ref+':0'}]:[]},'staff-groups':{groups:[{id:'group-1',name:'售后组',groupRef:'group:'+ref+':0'}]},'staff-statistics':{staff:[{id:'2220231913125',name:'售后客服小林',statusText:'在线'}]}};
  if(!bodies[operation])throw Error('Unsupported '+operation);
  return {operation,queriedAt:new Date().toISOString(),partial:operation==='history',failedSections:operation==='history'?[{section:'history',reason:'仅本机已同步消息'}]:[],data:bodies[operation],evidenceRef:ref};
}};
function Demo(){const [id,setId]=useState('main');return <main style={{display:'flex',gap:32,maxWidth:1040,margin:'32px auto'}}><section style={{flex:1}}><h2>千牛接待工作台</h2><p>使用平台账号范围内的商品、订单和客服资料。</p><button onClick={()=>setId(id==='main'?'other':'main')}>切换另一千牛店铺</button></section><WorkbenchPanel key={id} conversationId={id} onClose={()=>{}}/></main>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Demo/></QueryClientProvider>);
`,
  );
  server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 920 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://img.alicdn.com/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#dce8db"/><path d="M55 35 30 55 45 73 54 65v65h52V65l9 8 15-18-25-20-15 10H70z" fill="#719271"/></svg>',
    }),
  );
  const url =
    'http://127.0.0.1:' +
    server.httpServer.address().port +
    '/.artifacts/' +
    basename(directory) +
    '/index.html';
  await page.goto(url);
  await page.locator('.desk-product').filter({ hasText: '千牛纯棉衬衫' }).waitFor();
  await page.getByLabel('商品来源').selectOption('goods');
  await page.getByRole('textbox', { name: '搜索店铺商品' }).fill('衬衫');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() =>
    window.fixture.calls.some(
      (c) =>
        c.method === 'workbench.query' &&
        c.input.operation === 'goods' &&
        c.input.input.keyword === '衬衫',
    ),
  );
  await page.locator('.desk-product').first().click();
  const product = page.getByRole('dialog', { name: '商品详情', exact: true });
  await product.getByRole('button', { name: '发送商品卡片', exact: true }).waitFor();
  await product.getByRole('button', { name: '邀请下单', exact: true }).waitFor();
  assert.equal(await product.getByRole('button', { name: '规格与库存', exact: true }).count(), 0);
  await product.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const tabs = page.getByRole('navigation', { name: '会话业务资料' });
  await tabs.getByRole('button', { name: '订单', exact: true }).click();
  await page.locator('.desk-order').filter({ hasText: '123456789' }).click();
  const order = page.getByRole('dialog', { name: '订单详情', exact: true });
  await order.getByText('¥89.00', { exact: true }).waitFor();
  await order.getByRole('button', { name: '物流与交付记录', exact: true }).click();
  await order.getByText('顺丰已揽收', { exact: true }).waitFor();
  assert.equal(
    await order.getByRole('button', { name: /追加订单备注|无需物流发货|邀请评价/ }).count(),
    0,
  );
  await page.screenshot({ path: '.artifacts/qianniu-workbench-orders.png', fullPage: true });
  await order.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await tabs.getByRole('button', { name: '客户', exact: true }).click();
  await page.getByText('查看本机已同步消息', { exact: true }).click();
  await page.getByText('本机保存的咨询记录', { exact: true }).waitFor();
  await page
    .getByText('仅本机已同步消息，无法补全千牛登录前或离线期间的记录。', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '转接客服', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: '转接平台客服', exact: true });
  const confirm = transfer.getByRole('button', { name: '确认转接', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await transfer.getByLabel('目标客服').selectOption({ label: '售后客服小林 · 在线' });
  assert.equal(await confirm.isEnabled(), true);
  await page.evaluate(() => {
    window.fixture.staffAvailable = false;
  });
  await transfer.getByRole('button', { name: '刷新客服列表', exact: true }).click();
  await transfer.getByRole('status').filter({ hasText: '暂无其他可转接客服' }).waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await page.evaluate(() => {
    window.fixture.staffAvailable = true;
  });
  await transfer.getByRole('button', { name: '刷新客服列表', exact: true }).click();
  await transfer.getByLabel('目标客服').selectOption({ label: '售后客服小林 · 在线' });
  await transfer.getByLabel('交接说明').fill('请协助售后');
  assert.equal(await page.evaluate(() => window.fixture.actions.length), 0);
  await confirm.click();
  await transfer.getByRole('status').filter({ hasText: '千牛已确认转接' }).waitFor();
  await page.screenshot({ path: '.artifacts/qianniu-workbench-transfer.png', fullPage: true });
  await transfer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '切换另一千牛店铺', exact: true }).click();
  await page.locator('.desk-product').filter({ hasText: '另一店铺亚麻外套' }).waitFor();
  assert.equal(
    await page.locator('.workbench-panel').getByText('千牛纯棉衬衫', { exact: true }).count(),
    0,
  );
  const state = await page.evaluate(() => window.fixture);
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].accountId, 'account-main');
  assert.equal(state.actions[0].buyerId, 'buyer-main');
  assert.equal(state.actions[0].input.note, '请协助售后');
  assert.ok(
    state.calls.some(
      (c) => c.method === 'workbench.query' && c.input.sessionId === 'session-other',
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'Qianniu sidebar smoke passed: goods search/detail, scoped orders/logistics, local history, guarded individual transfer, revoked staff, and separate store/account contexts.',
  );
} catch (error) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: '.artifacts/qianniu-workbench-failure.png', fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
