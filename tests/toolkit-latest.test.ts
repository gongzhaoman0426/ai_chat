import { afterEach, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, flush, legacyAgent } from './helpers';
import { defaultConfig, type PublishedConfig } from '../packages/agent-config/src';
import {
  currentToolkit,
  resolveRuntimeToolkits,
} from '../packages/agent-config/src/toolkit-resolution';
import { AssetService } from '../packages/ai/src/assets';
import { workingConfiguration } from '../packages/core/src/working-configuration';
import { Router } from '../packages/core/src/router';
import { saveResourceScope } from '../packages/agent-config/src/resource-scope';
import { COMMERCE_TOOLKIT_ID } from '../packages/contracts/src/toolkit-catalog';
import type { ScopedAssetContext } from '../packages/extension-sdk/src';

let f: Awaited<ReturnType<typeof setup>> | undefined;
let assets: AssetService | undefined;
afterEach(async () => {
  assets?.close();
  await f?.cleanup();
  assets = undefined;
  f = undefined;
});
async function init() {
  f = await setup();
  assets = new AssetService(f.db, f.dir);
  return f;
}
const context = (storeId = 'debug'): ScopedAssetContext => ({
  role: storeId === 'debug' ? 'debug' : 'reply',
  storeId,
  accountId: 'test',
  conversationId: 'test',
  runId: 'test',
  signal: new AbortController().signal,
  settings: {},
  knowledge: { search: async () => [] },
  platform: { query: async () => ({}) },
  agents: { runSub: async () => ({}) },
  logger: { info: () => {} },
});
async function install(version: string, kind: 'toolkit' | 'workflow' = 'toolkit') {
  const manifest = {
    apiVersion: 1,
    assetId: 'local/versioned',
    version,
    kind,
    name: '版本验证工具',
    description: 'fixture',
    settingsFields: [{ key: 'endpoint', label: '接口地址', required: true, secret: false }],
    members: [
      {
        id: 'version',
        name: '当前版本',
        description: 'fixture',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        requiresCapabilities: [],
      },
    ],
  };
  const code = `export default {
    manifest: ${JSON.stringify(manifest)},
    createTools: () => ({
      'local/versioned/version': { id: 'local/versioned/version', execute: async () => ({ version: ${JSON.stringify(version)} }) }
    })
  }`;
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.mjs', Buffer.from(code));
  const file = join(f!.dir, `extension-${version}-${kind}.zip`);
  await writeFile(file, zip.toBuffer());
  return assets!.install(file);
}

it('旧自定义助手直接使用最新版；闲鱼发货可见，实际运行与历史快照分别记录', async () => {
  const t = await init();
  const caps = {
    receive: true,
    sendText: true,
    sendImage: false,
    history: true,
    goods: true,
    buyerProfile: true,
    orders: true,
    shipment: true,
    verified: true,
  };
  const account = await t.engine.registerAccount({
    platform: 'goofish',
    partition: 'persist:latest',
    mallId: '100',
    mallName: '闲鱼卖家',
    externalId: '100',
    name: '闲鱼客服',
    capabilities: caps,
  });
  await t.db.account.update({ where: { id: account.id }, data: { verifiedAt: new Date() } });
  const { definition, revision } = await legacyAgent(t, {
    ...defaultConfig(t.model.id),
    name: '已有定制助手',
    prompt: '保留店主的原始提示词',
    toolkitIds: ['builtin/commerce@1.0.0'],
  });
  await t.engine.agents.bind({
    scopeKey: `store:${account.storeId}`,
    revisionId: revision.id,
    expectedRevision: null,
  });
  await t.db.installedExtension.update({
    where: { id: 'builtin/commerce@1.0.0' },
    data: { status: 'disabled' },
  });
  const preview = await workingConfiguration(t.engine, account.storeId);
  expect(preview.resources.find((r) => r.kind === 'toolkit')).toMatchObject({
    id: COMMERCE_TOOLKIT_ID,
    version: COMMERCE_TOOLKIT_ID.split('@')[1],
    members: expect.arrayContaining([
      { name: '无需物流发货', availableAccounts: ['闲鱼客服'], reason: '' },
    ]),
  });
  const spy = vi.spyOn(t.ai, 'reply');
  await t.engine.setPolicy({ storeId: account.storeId, autoReplyEnabled: true });
  await t.engine.ingest(
    t.inbound('商品是什么材质', {
      accountId: account.id,
      conversationKey: '9001',
      buyerId: '200',
      platformContext: { sellerId: '100', itemId: '300', userId: '200', sessionType: 1 },
    }),
  );
  await flush(t.engine, t.db);
  expect(spy).toHaveBeenCalledTimes(1);
  const ctx = spy.mock.calls[0][0];
  expect(ctx.config.toolkitIds).toEqual([COMMERCE_TOOLKIT_ID]);
  expect(ctx.config.prompt).toBe('保留店主的原始提示词');
  const snap = await t.db.runConfigSnapshot.findFirstOrThrow({
    where: { storeId: account.storeId, role: 'reply' },
  });
  expect((snap.config as any).agentTree[revision.id].toolkitIds).toEqual([COMMERCE_TOOLKIT_ID]);
  expect(await t.db.agentRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
  expect(await t.db.agentDefinition.findUnique({ where: { id: definition.id } })).toEqual(
    definition,
  );
  const tools = await assets!.tools(
    ctx.config.toolkitIds[0],
    {
      ...context(account.storeId),
      platform: { id: 'goofish', query: async () => ({}) },
    },
    new Set(['orders', 'shipment']),
    async () => {},
  );
  expect(Object.keys(tools)).toContain(assets!.alias('builtin/commerce/ship-order'));
  expect(
    Object.keys(
      await assets!.tools(
        ctx.config.toolkitIds[0],
        {
          ...context(account.storeId),
          platform: { id: 'pinduoduo', operations: ['buyer-orders'], query: async () => ({}) },
        },
        new Set(['orders', 'shipment']),
        async () => {},
      ),
    ),
  ).not.toContain(assets!.alias('builtin/commerce/ship-order'));
  await t.db.$transaction((tx) =>
    saveResourceScope(tx, {
      kind: 'toolkit',
      resourceId: 'builtin/commerce@1.0.0',
      expectedRevision: 0,
      mode: 'selected',
      storeIds: [],
    }),
  );
  expect(
    await assets!.tools(
      ctx.config.toolkitIds[0],
      context(account.storeId),
      new Set(['orders', 'shipment']),
      async () => {},
    ),
  ).toEqual({});
});

it('按语义版本选择最新启用包，同一轮及子助手版本固定，下轮才跟进更新', async () => {
  const t = await init();
  const v9 = await install('1.9.0');
  const child = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), toolkitIds: [v9.id] },
  });
  const childRevision = await t.engine.agents.publish(child.id, child.draftRevision);
  const root = await t.engine.agents.save({
    config: {
      ...defaultConfig(t.model.id),
      toolkitIds: [v9.id],
      subAgents: [{ alias: 'child', revisionId: childRevision.id }],
    },
  });
  expect((root.draftConfig as any).toolkitIds).toEqual(['local/versioned']);
  const rev = await t.engine.agents.publish(root.id, root.draftRevision);
  const v10 = await install('1.10.0');
  const tree = await resolveRuntimeToolkits(
    t.db,
    rev.configSnapshot as unknown as PublishedConfig,
    rev.id,
  );
  expect(tree[rev.id].toolkitIds).toEqual([v10.id]);
  expect(tree[childRevision.id].toolkitIds).toEqual([v10.id]);
  const v11 = await install('1.11.0');
  const tools = await assets!.tools(
    tree[childRevision.id].toolkitIds[0],
    context(),
    new Set(),
    async () => {},
  );
  expect(await (Object.values(tools)[0] as any).execute({}, {})).toEqual({ version: '1.10.0' });
  const next = await resolveRuntimeToolkits(
    t.db,
    rev.configSnapshot as unknown as PublishedConfig,
    rev.id,
  );
  expect(next[rev.id].toolkitIds).toEqual([v11.id]);
  expect(
    (await assets!.list()).assets.filter((a) => a.assetId === 'local/versioned').map((a) => a.id),
  ).toEqual([v11.id]);
  await t.db.installedExtension.update({ where: { id: v11.id }, data: { status: 'disabled' } });
  expect((await currentToolkit(t.db, v9.id)).id).toBe(v10.id);
  await expect(install('2.0.0', 'workflow')).rejects.toThrow('不能在 Toolkit 与 Workflow 之间切换');
  await t.db.installedExtension.updateMany({
    where: { assetId: 'local/versioned' },
    data: { status: 'disabled' },
  });
  await expect(currentToolkit(t.db, v9.id)).rejects.toThrow('没有已启用');
});

it('旧版本工具设置与店铺覆盖随包继承，页面保存后使用统一设置且拒绝过期保存', async () => {
  const t = await init();
  const old = await install('1.0.0');
  await t.db.assetSetting.create({
    data: {
      assetId: old.id,
      scopeKey: 'global',
      revision: 3,
      values: { endpoint: 'global-endpoint', apiKey: { secretRef: 'kept-reference' } },
    },
  });
  await t.db.assetSetting.create({
    data: {
      assetId: old.id,
      scopeKey: `store:${t.account.storeId}`,
      revision: 1,
      values: { endpoint: 'store-endpoint' },
    },
  });
  const newer = await install('2.0.0');
  expect(await assets!.settings(newer.id, t.account.storeId)).toEqual({
    endpoint: 'store-endpoint',
    apiKey: { secretRef: 'kept-reference' },
  });
  expect(
    (await assets!.list()).settings.find((s) => s.assetId === newer.id && s.scopeKey === 'global')
      ?.revision,
  ).toBe(3);
  await t.db.appSetting.update({ where: { key: 'developerModeEnabled' }, data: { value: true } });
  const router = new Router(t.engine, {} as any);
  const input = {
    assetId: newer.id,
    scopeKey: 'global',
    expectedRevision: 3,
    values: { endpoint: 'updated' },
  };
  const setting = await router.call('assets.settings', input);
  expect(setting).toMatchObject({ assetId: 'local/versioned', revision: 4 });
  expect(await assets!.settings(newer.id, 'another-store')).toEqual({ endpoint: 'updated' });
  expect(await assets!.settings(newer.id, t.account.storeId)).toEqual({
    endpoint: 'store-endpoint',
  });
  await expect(router.call('assets.settings', input)).rejects.toThrow('配置已变化');
});
