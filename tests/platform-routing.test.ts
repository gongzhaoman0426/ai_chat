import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformHosts, type PlatformDriver } from '../apps/desktop/src/main/platform-hosts';
import { AssetService } from '../packages/ai/src/assets';
import { availableOperations, resolveReplyScope } from '../packages/ai/src/platform-scope';
import { ReplyPlatformTools } from '../packages/ai/src/platform-tools';
import { normalizeDouyinQuery } from '../packages/platforms/src/douyin/queries';
import { defaultConfig } from '../packages/agent-config/src';
import { setup, legacyAgent, legacyDefaultConfig } from './helpers';
import type { ScopedAssetContext } from '../packages/extension-sdk/src';
import type { ReplyContext } from '../packages/core/src/types';
import type { PlatformId } from '../packages/contracts/src';
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
function driver(): PlatformDriver {
  return {
    connect: vi.fn(async () => ({})),
    restore: vi.fn(async () => {}),
    send: vi.fn(async () => ({ status: 'confirmed' as const, externalId: 'fixture' })),
    query: vi.fn(async () => ({})),
    verify: vi.fn(async () => ({})),
    disconnect: vi.fn(),
    forgetPartition: vi.fn(async () => {}),
    setMaintenance: vi.fn(),
    close: vi.fn(),
  };
}
it('按账号路由并发收发；不存在的账号不会默认落到 PDD，不能通过平台参数覆盖已保存账号', async () => {
  const pdd = driver(),
    dy = driver(),
    hosts = new PlatformHosts({
      pinduoduo: pdd,
      douyin: dy,
      goofish: driver(),
      kuaishou: driver(),
      qianniu: driver(),
    });
  const accounts = (['pinduoduo', 'douyin'] as const).map((platform) => ({
    id: `account-${platform}`,
    storeId: `store-${platform}`,
    externalId: 'same-staff-id',
    sessionPartition: `persist:${platform}`,
    platform,
  }));
  await hosts.restore(accounts);
  expect(pdd.restore).toHaveBeenCalledWith([accounts[0]]);
  expect(dy.restore).toHaveBeenCalledWith([accounts[1]]);
  await Promise.all(accounts.map((account) => hosts.query(account.id, 'goods', {})));
  expect(pdd.query).toHaveBeenCalledWith(accounts[0].id, 'goods', {});
  expect(dy.query).toHaveBeenCalledWith(accounts[1].id, 'goods', {});
  await hosts.connect(accounts[1], 'pinduoduo');
  expect(dy.connect).toHaveBeenCalledWith(accounts[1]);
  expect(() => hosts.query('nonexistent', 'goods', {})).toThrow('尚未连接');
  expect(() => hosts.remember({ ...accounts[0], platform: 'douyin' })).toThrow('已改变');
  expect(() => hosts.executeAction({ accountId: accounts[1].id } as any)).toThrow('未提供');
});
const context = (platform: PlatformId): ScopedAssetContext => ({
  role: 'debug',
  storeId: `store-${platform}`,
  accountId: `account-${platform}`,
  conversationId: 'conversation',
  runId: `run-${platform}`,
  signal: new AbortController().signal,
  settings: {},
  knowledge: { search: async () => [] },
  platform: {
    id: platform,
    operations: availableOperations(platform, caps),
    query: vi.fn(async (operation) => ({
      operation,
      queriedAt: new Date().toISOString(),
      partial: false,
      failedSections: [],
      data: { account: platform },
      evidenceRef: platform,
    })),
  },
  agents: { runSub: async () => ({}) },
  logger: { info() {} },
});
it('同一店铺客服 Toolkit 在不同平台暴露不同成员，PDD 专属工具不会在抖店装配', async () => {
  f = await setup();
  assets = new AssetService(f.db, f.dir);
  await legacyAgent(f, legacyDefaultConfig(f.model.id, '2.0.0'));
  const pdd = context('pinduoduo'),
    dy = context('douyin');
  const [pddTools, dyTools, wrongTools] = await Promise.all([
    assets.tools(
      'builtin/commerce@1.0.0',
      pdd,
      new Set(['goods', 'history', 'orders', 'orderRemark']),
      async () => {},
    ),
    assets.tools(
      'builtin/commerce@1.0.0',
      dy,
      new Set(['goods', 'history', 'orders', 'orderRemark']),
      async () => {},
    ),
    assets.tools(
      'builtin/pdd@2.0.0',
      dy,
      new Set(['goods', 'history', 'orders', 'orderRemark']),
      async () => {},
    ),
  ]);
  expect(Object.keys(pddTools)).toHaveLength(7);
  expect(Object.keys(dyTools)).toHaveLength(6);
  expect(wrongTools).toEqual({});
  expect(dyTools[assets.alias('builtin/commerce/order-remark')]).toBeDefined();
  expect(dyTools[assets.alias('builtin/commerce/goods-skus')]).toBeUndefined();
  const key = assets.alias('builtin/commerce/goods');
  const [a, b] = await Promise.all([
    (pddTools[key] as any).execute({}, {}),
    (dyTools[key] as any).execute({}, {}),
  ]);
  expect(a.data.account).toBe('pinduoduo');
  expect(b.data.account).toBe('douyin');
  const restricted = await assets.tools(
    'builtin/commerce@1.0.0',
    { ...dy, platform: { ...dy.platform, operations: ['goods-detail'] } },
    new Set(['goods']),
    async () => {},
  );
  expect(Object.keys(restricted)).toEqual([assets.alias('builtin/commerce/goods-detail')]);
});
it('宿主从数据库解析店铺/买家；注入 scope 字段、跨店账号和缺少已核验订单的写操作都在查询前被拒绝', async () => {
  f = await setup();
  const dy = await f.engine.registerAccount({
    platform: 'douyin',
    partition: 'persist:dy',
    mallId: 'mall-a',
    mallName: '抖店',
    externalId: 'cs-a',
    name: '抖店客服',
    capabilities: caps,
  });
  const message = await f.engine.ingest(
    f.inbound('问题', {
      accountId: dy.id,
      conversationKey: 'opaque-dy-id',
      platformContext: {
        userId: 'buyer-a',
        securityUserId: 'security-a',
        securityConversationId: 'secure-opaque',
      },
    }),
  );
  const revision = await f.engine.agents.prepareDraft(
    (await f.db.agentDefinition.findFirstOrThrow()).id,
  );
  const run = await f.db.aiRun.create({
    data: {
      storeId: dy.storeId,
      conversationId: message.conversationId,
      role: 'reply',
      path: 'agent',
      status: 'running',
      input: {},
      output: {},
      evidence: [],
      usage: {},
    },
  });
  const ctx: ReplyContext = {
    storeId: dy.storeId,
    accountId: dy.id,
    buyerId: 'buyer-a',
    conversationId: message.conversationId,
    runId: run.id,
    configEpoch: 1,
    question: '问题',
    messages: [],
    matches: [],
    config: revision,
    revisionId: 'revision',
    capabilities: caps,
    signal: new AbortController().signal,
    guard: async () => {},
  };
  expect(await resolveReplyScope(f.db, ctx)).toMatchObject({
    platform: 'douyin',
    conversationKey: 'opaque-dy-id',
  });
  await expect(resolveReplyScope(f.db, { ...ctx, accountId: f.account.id })).rejects.toThrow(
    '范围不匹配',
  );
  const query = vi.fn(async (_accountId: string, operation: string) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: { products: [] },
  }));
  f.host.query = query;
  const runtime = new ReplyPlatformTools(f.db, f.host, ctx, new Set());
  await expect(
    runtime.query('goods', { accountId: f.account.id }, new Set(['goods']), ctx.signal),
  ).rejects.toThrow();
  await expect(
    runtime.action('order-remark', {}, new Set(['orders', 'orderRemark']), ctx.signal),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  await runtime.query('goods', {}, new Set(['goods']), ctx.signal);
  expect(query).toHaveBeenCalledWith(
    dy.id,
    'goods',
    expect.objectContaining({
      buyerId: 'buyer-a',
      conversationKey: 'opaque-dy-id',
      platformContext: {
        userId: 'buyer-a',
        securityUserId: 'security-a',
        securityConversationId: 'secure-opaque',
      },
    }),
  );
  expect(await f.db.platformEvidence.findFirst()).toMatchObject({
    storeId: dy.storeId,
    accountId: dy.id,
    conversationId: message.conversationId,
  });
});
describe('抖店结果归一化', () => {
  it('保留长 ID 字符串，拒绝业务失败/未知列表；未明确单位的价格不猜成分', () => {
    const raw = {
      code: 0,
      data: {
        product_list: [
          {
            product_id: '3737994268627829216',
            product_name: '水杯',
            price: 1299,
            cookie: 'private',
          },
        ],
      },
    };
    const result = normalizeDouyinQuery('goods', raw, {}, 'buyer');
    expect(result.data.products).toEqual([{ goodsId: '3737994268627829216', title: '水杯' }]);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(() =>
      normalizeDouyinQuery('goods', { code: 401, data: { list: [] } }, {}, 'buyer'),
    ).toThrow('拒绝');
    expect(() => normalizeDouyinQuery('goods', { data: { unexpected: [] } }, {}, 'buyer')).toThrow(
      '结构尚未识别',
    );
    expect(() =>
      normalizeDouyinQuery(
        'goods',
        { data: { list: [{ product_id: Number('3737994268627829216') }] } },
        {},
        'buyer',
      ),
    ).toThrow('精度');
  });
});
it('仅未修改的内置助手升级成通用工具的新版本；旧修订哈希和自定义助手保持不变', async () => {
  f = await setup();
  const builtin = await f.db.agentDefinition.findFirstOrThrow({
    where: { origin: 'builtin_default' },
  });
  const { revision: old } = await legacyAgent(f, legacyDefaultConfig(f.model.id, '2.0.0'), {
    id: builtin.id,
    expectedRevision: builtin.draftRevision,
  });
  await f.db.agentBinding.update({
    where: { scopeKey: 'global' },
    data: { agentRevisionId: old.id },
  });
  const { definition: custom, revision: customRevision } = await legacyAgent(f, {
    ...legacyDefaultConfig(f.model.id, '2.0.0'),
    prompt: '自定义提示词',
    name: '自定义助手',
  });
  await f.engine.agents.upgradeBuiltinDefaults();
  const binding = await f.db.agentBinding.findUniqueOrThrow({ where: { scopeKey: 'global' } });
  expect(binding.agentRevisionId).not.toBe(old.id);
  const current = await f.db.agentRevision.findUniqueOrThrow({
    where: { id: binding.agentRevisionId },
  });
  expect((current.configSnapshot as any).toolkitIds).toContain('builtin/commerce');
  expect(await f.db.agentRevision.findUnique({ where: { id: old.id } })).toMatchObject({
    configHash: old.configHash,
    configSnapshot: old.configSnapshot,
  });
  expect(await f.db.agentRevision.count({ where: { agentId: custom.id } })).toBe(1);
  expect(await f.db.agentRevision.findUnique({ where: { id: customRevision.id } })).toMatchObject({
    configHash: customRevision.configHash,
  });
  await f.engine.agents.upgradeBuiltinDefaults();
  expect(
    (await f.db.agentBinding.findUniqueOrThrow({ where: { scopeKey: 'global' } })).agentRevisionId,
  ).toBe(current.id);
});
