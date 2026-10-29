import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AssetService } from '../packages/ai/src/assets';
import { commerceToolkit } from '../packages/ai/src/commerce-toolkit';
import { availableOperations } from '../packages/contracts/src/platform-operations';
import type { PlatformId } from '../packages/contracts/src/platform';
import type { ScopedAssetContext } from '../packages/extension-sdk/src';
import { WorkbenchService } from '../packages/core/src/workbench';
import { setup } from './helpers';

const caps = {
  receive: true,
  sendText: true,
  sendImage: true,
  history: true,
  goods: true,
  orders: true,
  orderRemark: true,
  verified: true,
};
let f: Awaited<ReturnType<typeof setup>> | undefined;
let assets: AssetService | undefined;
afterEach(async () => {
  assets?.close();
  assets = undefined;
  await f?.cleanup();
  f = undefined;
});

function context(platform: PlatformId | undefined): ScopedAssetContext {
  return {
    role: 'debug',
    storeId: 'store',
    accountId: 'account',
    conversationId: 'conversation',
    runId: 'run',
    signal: new AbortController().signal,
    settings: {},
    knowledge: { search: async () => [] },
    platform: {
      id: platform,
      operations: platform ? availableOperations(platform, caps) : undefined,
      query: vi.fn(async (operation) => ({
        operation,
        queriedAt: new Date().toISOString(),
        partial: false,
        failedSections: [],
        data: {},
        evidenceRef: 'fixture',
      })),
    },
    agents: { runSub: async () => ({}) },
    logger: { info() {} },
  };
}

it.each([
  ['pinduoduo', false, false],
  ['goofish', false, false],
  ['kuaishou', false, true],
  ['douyin', true, true],
  ['qianniu', true, false],
  [undefined, false, false],
] as const)('%s 的商品与订单工具只暴露当前平台支持的搜索参数', async (platform, goods, orders) => {
  const tools = await commerceToolkit.createTools!(context(platform));
  for (const [operation, supportsKeyword] of [
    ['goods', goods],
    ['buyer-orders', orders],
  ] as const) {
    const tool = tools[`builtin/commerce/${operation}`] as any;
    const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
    expect(Object.hasOwn(schema.properties ?? {}, 'keyword')).toBe(supportsKeyword);
    expect(schema.additionalProperties).toBe(false);
    expect(tool.inputSchema.parse({ page: 2 })).toEqual({ page: 2, pageSize: 10 });
    expect(tool.inputSchema.safeParse({ keyword: '椅子' }).success).toBe(supportsKeyword);
    if (supportsKeyword) expect(tool.description).toContain('可用 keyword');
    else expect(tool.description).toContain('不支持关键词搜索');
  }
});

it('已发布的各版 commerce Toolkit 保留平台运行时 schema 与描述，安装记录保持不变', async () => {
  f = await setup();
  assets = new AssetService(f.db, f.dir);
  const versions = ['1.0.0', '1.1.0', '1.1.1', '1.2.0', '1.2.1', '1.3.0', '1.4.0'];
  const installed = await f.db.installedExtension.findMany({
    where: { assetId: 'builtin/commerce' },
    orderBy: { version: 'asc' },
  });
  for (const version of versions) {
    const tools = await assets.tools(
      `builtin/commerce@${version}`,
      context('pinduoduo'),
      new Set(['goods', 'orders', 'orderRemark']),
      async () => {},
    );
    for (const operation of ['goods', 'buyer-orders']) {
      const tool = tools[assets.alias(`builtin/commerce/${operation}`)] as any;
      const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' });
      expect(schema.properties).not.toHaveProperty('keyword');
      expect(tool.inputSchema.safeParse({ keyword: '椅子' }).success).toBe(false);
      if (version !== '1.0.0') expect(tool.description).toContain('不支持关键词搜索');
    }
    const remark = tools[assets.alias('builtin/commerce/order-remark')] as any;
    const manifest = (await assets.module(`builtin/commerce@${version}`)).manifest;
    expect(remark.description).toBe(
      manifest.members.find((member) => member.id === 'order-remark')!.description,
    );
    expect(remark.description).toContain('明确要求');
    expect(remark.description).toContain('unknown');
  }
  expect(
    await f.db.installedExtension.findMany({
      where: { assetId: 'builtin/commerce' },
      orderBy: { version: 'asc' },
    }),
  ).toEqual(installed);
});

it('宿主拒绝未支持的关键词查询且不发送请求，支持的平台保留搜索与分页', async () => {
  f = await setup();
  await f.db.account.update({ where: { id: f.account.id }, data: { capabilities: caps } });
  const message = await f.engine.ingest(f.inbound('查询商品'));
  const workbench = new WorkbenchService(f.engine);
  const ctx = await workbench.context(message.conversationId);
  f.host.query = vi.fn(async (_account, operation) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    subjectId: operation === 'buyer-orders' ? 'buyer-a' : undefined,
    data: operation === 'buyer-orders' ? { orders: [] } : { products: [] },
  }));
  for (const [platform, operation, supportsKeyword] of [
    ['pinduoduo', 'goods', false],
    ['pinduoduo', 'buyer-orders', false],
    ['goofish', 'goods', false],
    ['goofish', 'buyer-orders', false],
    ['kuaishou', 'goods', false],
    ['kuaishou', 'buyer-orders', true],
    ['douyin', 'goods', true],
    ['douyin', 'buyer-orders', true],
    ['qianniu', 'goods', true],
    ['qianniu', 'buyer-orders', false],
  ] as const) {
    await f.db.store.update({ where: { id: f.account.storeId }, data: { platform } });
    vi.mocked(f.host.query).mockClear();
    const query = workbench.query(ctx.sessionId, operation, { keyword: '椅子', page: 2 });
    if (supportsKeyword) {
      await query;
      expect(f.host.query).toHaveBeenCalledWith(
        f.account.id,
        operation,
        expect.objectContaining({ keyword: '椅子', page: 2, pageSize: 10 }),
      );
    } else {
      await expect(query).rejects.toThrow('当前平台不支持关键词搜索');
      expect(f.host.query).not.toHaveBeenCalled();
      await workbench.query(ctx.sessionId, operation, { page: 2 });
      expect(f.host.query).toHaveBeenCalledWith(
        f.account.id,
        operation,
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
      expect(vi.mocked(f.host.query).mock.calls[0][2]).not.toHaveProperty('keyword');
    }
  }
});
