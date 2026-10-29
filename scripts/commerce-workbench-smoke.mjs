import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const dir = await mkdtemp(join(tmpdir(), 'judesk-commerce-ui-'));
let app;
try {
  const css = (await readdir('out/renderer/assets')).find((f) => f.endsWith('.css'));
  assert(css, '请先 pnpm build');
  await writeFile(join(dir, 'style.css'), await readFile(join('out/renderer/assets', css)));
  await build({
    stdin: {
      contents: `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClientProvider} from '@tanstack/react-query';
import {client} from './apps/desktop/src/renderer/api';
import {WorkbenchPanel} from './apps/desktop/src/renderer/components/inbox/workbench-panel';
const ref='11111111-1111-4111-8111-111111111111';
window.calls=[];
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#d7e9dc"/><text x="62" y="65" fill="#286149">商品预览</text></svg>');
const ctx={sessionId:ref,expiresAt:new Date(Date.now()+1800000).toISOString(),conversationId:'chat',storeId:'shop',storeName:'演示店铺',accountId:'account',accountName:'演示客服',buyerId:'buyer',buyerName:'测试客户',platform:'douyin',online:true,operations:['goods','goods-detail','buyer-footprint','buyer-orders','order-remark-state','order-remark','video-materials','send-video','send-product-card','staff-groups','staff-statistics','transfer-group','invite-order','invite-review','close-conversation']};
const product={goodsId:'123456',title:'折叠休闲椅',imageUrl:image,priceText:'¥125',productRef:'product:'+ref+':0'};
window.judesk={onChanged:()=>()=>{},call:async(method,input)=>{window.calls.push({method,input});if(method==='workbench.context')return ctx;if(method==='workbench.records')return [];if(method==='workbench.action')return {status:input.operation.startsWith('send-')?'queued':'confirmed',message:'演示操作已接收',outboundId:'outbound'};if(method==='workbench.query'){
let data={};switch(input.operation){case 'goods':case 'buyer-footprint':data={products:[product]};break;case 'goods-detail':data={product,description:'轻便折叠，适合日常使用',properties:[]};break;case 'buyer-orders':data={orders:[{orderSn:'123456789',orderRef:'order:'+ref+':0',productTitle:'折叠休闲椅',statusText:'已完成',amountText:'¥125'}]};break;case 'order-remark-state':data={remark:'请加固包装',tag:4,tagName:'4'};break;case 'video-materials':data=input.input.folderId ? {materials:[{kind:'video',materialId:'v1',title:'安装教程',videoId:'vid',width:1280,height:720,duration:12,coverUrl:'https://fixture.byteimg.com/cover.png',materialRef:'material:'+ref+':0',sendable:true}]} : {folders:[{id:'5001',name:'安装视频文件夹'}],materials:[]};break;case 'staff-groups':data={groups:[{id:'g1',name:'售后客服组',groupRef:'group:'+ref+':0'}]};break;case 'staff-statistics':data={staff:[{id:'s1',name:'小林',statusText:'在线',activeCount:2}]};break;}
return {operation:input.operation,queriedAt:new Date().toISOString(),partial:false,failedSections:[],evidenceRef:ref,data:{...data,hasMore:false}};}return {};}};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><div style={{width:370,height:'100vh',margin:'auto',display:'flex'}}><WorkbenchPanel conversationId="chat" onClose={()=>{}} /></div></QueryClientProvider>);
`,
      resolveDir: resolve('.'),
      loader: 'tsx',
    },
    outfile: join(dir, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
  });
  await writeFile(
    join(dir, 'index.html'),
    '<meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(dir, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:850,height:920,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(join(dir, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [join(dir, 'main.cjs')], env });
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://fixture.byteimg.com/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#d7e9dc"/><text x="110" y="95">安装演示视频</text></svg>',
    }),
  );
  await page.getByLabel('商品来源').selectOption('goods');
  // Even cached capabilities from an older host must not restore the retired close action.
  assert.equal(await page.getByRole('button', { name: '结束会话', exact: true }).count(), 0);
  await page.getByLabel('搜索店铺商品').fill('折叠椅');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: /折叠休闲椅/ }).click();
  await page.getByRole('button', { name: '发送商品卡片', exact: true }).click();
  await page.getByRole('button', { name: '发送中', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '视频', exact: true }).click();
  await page.getByRole('button', { name: '安装视频文件夹', exact: true }).click();
  await page.getByText('安装教程', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部视频', exact: true }).click();
  await page.getByRole('button', { name: '安装视频文件夹', exact: true }).click();
  await page.getByText('安装教程', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送给客户', exact: true }).click();
  await page.getByRole('button', { name: '发送中', exact: true }).waitFor();
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/commerce-video-workbench.png' });
  await page.getByRole('button', { name: '订单', exact: true }).click();
  await page.getByLabel('搜索当前客户订单').fill('123456');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: /折叠休闲椅/ }).click();
  await page.getByText('请加固包装', { exact: true }).waitFor();
  await page.getByRole('button', { name: '邀请评价', exact: true }).click();
  await page.getByRole('button', { name: '确认邀请评价', exact: true }).click();
  await page.getByText('演示操作已接收', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '平台话术', exact: true }).count(), 0);
  await page.getByRole('button', { name: '转接客服组', exact: true }).click();
  await page.getByText('接待分组', { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.calls);
  assert(
    calls.some(
      (c) =>
        c.method === 'workbench.query' &&
        c.input.operation === 'goods' &&
        c.input.input.keyword === '折叠椅',
    ),
  );
  assert(
    calls.some(
      (c) =>
        c.method === 'workbench.query' &&
        c.input.operation === 'video-materials' &&
        c.input.input.folderId === '5001' &&
        c.input.input.page === 1,
    ),
  );
  assert.equal(await page.getByLabel('素材文件夹编号').count(), 0);
  assert.deepEqual(
    calls.filter((c) => c.method === 'workbench.action').map((c) => c.input.operation),
    ['send-product-card', 'send-video', 'invite-review'],
  );
  assert(
    !calls.some(
      (c) => c.method === 'workbench.import-reply' || c.input?.operation === 'platform-replies',
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    '工作台 UI 通过：搜索、商品卡片、视频发送状态、订单备注、评价邀请、移除平台话术、分组入口。使用隔离数据，未连接真实店铺。',
  );
} finally {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
}
