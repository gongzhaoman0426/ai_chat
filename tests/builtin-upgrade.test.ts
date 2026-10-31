import { afterEach, expect, it, vi } from 'vitest';
import { setup, flush, legacyAgent } from './helpers';
import { AssetService } from '../packages/ai/src/assets';
import { legacyCommerceV11Modules } from '../packages/ai/src/compatibility/commerce-toolkit-v1.1';
import { defaultConfig } from '../packages/agent-config/src';
import { currentToolkit } from '../packages/agent-config/src/toolkit-resolution';
import { COMMERCE_TOOLKIT_ID } from '../packages/contracts/src/toolkit-catalog';
import { hash } from '../packages/core/src/util';
import { json } from '../packages/database/src';

let f: Awaited<ReturnType<typeof setup>> | undefined;
let assets: AssetService | undefined;
afterEach(async () => {
  assets?.close();
  await f?.cleanup();
  assets = undefined;
  f = undefined;
});

// Release compatibility contract: changing an existing manifest (including prose
// or generated schemas) must fail here, even if every fresh-database test passes.
it('已交付的内置资源清单哈希固定，不能在同一标识下修改说明或 schema', async () => {
  f = await setup();
  const rows = await f.db.installedExtension.findMany({ where: { relativePath: 'builtin' } });
  expect(Object.fromEntries(rows.map((row) => [row.id, row.artifactHash]))).toEqual({
    'builtin/commerce@1.0.0': 'd1a6a7a7d593a35d8c656747487aecf744bd2238e225204b60c0f33e6e6b820e',
    'builtin/commerce@1.1.0': '0a92b7aa2cdabf07088f45e21b3564041ada3f9ee12481eb40d0acb95b362d8a',
    'builtin/commerce@1.1.1': 'fe1a7838883bf2d8e3ec35170483e6c7b06e2bef72495e8f7775407c4a2f70b4',
    'builtin/commerce@1.2.0': '8da92d9b7b6934ab71ee1291a2f3e6ce2eab8888683c09d2bc6a5c9a2e495a39',
    'builtin/commerce@1.2.1': 'd484374d44504ccbb53267f377fed2e2604cb223055234ecb79d9b3cdc1d80cd',
    'builtin/commerce@1.3.0': '9aac36f3e4c747d0bf136e2d24933a5d1a2a15346854024f26089b5953cb30ad',
    'builtin/commerce@1.4.0': '45e6c1a47bfe150fc02b07e80bcd6e9a0be7a365a6679c78cd429dc5babc137c',
    'builtin/utilities@1.0.0': 'cfa72c960621c1528cdf823fa708ae2b90cd3ac9bdd77c46cfb65cc397598f8f',
  });
  expect(legacyCommerceV11Modules.map((m) => hash(m.manifest))).toEqual([
    '0a92b7aa2cdabf07088f45e21b3564041ada3f9ee12481eb40d0acb95b362d8a',
    '4a476f677143dc8f320a51d26312caea166cca5bd8490301cf2c181be83bad96',
  ]);
});

it.each([0, 1])(
  '旧库清单变体 %s 升级后拼多多直接恢复工具装载，不改助手、绑定和历史',
  async (variant) => {
    const t = (f = await setup());
    assets = new AssetService(t.db, t.dir);
    const manifest = legacyCommerceV11Modules[variant].manifest;
    await t.db.installedExtension.delete({ where: { id: COMMERCE_TOOLKIT_ID } });
    const old = await t.db.installedExtension.update({
      where: { id: 'builtin/commerce@1.1.0' },
      data: { manifest: json(manifest), artifactHash: hash(manifest) },
    });
    const { definition, revision } = await legacyAgent(t, {
      ...defaultConfig(t.model.id),
      prompt: '保留店主自己的提示词',
      toolkitIds: ['builtin/utilities@1.0.0', old.id],
    });
    await t.engine.agents.bind({
      scopeKey: `store:${t.account.storeId}`,
      revisionId: revision.id,
      expectedRevision: null,
    });
    const bindings = await t.db.agentBinding.findMany();
    const setting = await t.db.assetSetting.create({
      data: {
        assetId: old.id,
        scopeKey: `store:${t.account.storeId}`,
        revision: 1,
        values: { preserved: true },
      },
    });
    const scope = await t.db.resourceScope.create({
      data: {
        kind: 'toolkit',
        resourceId: 'builtin/commerce',
        mode: 'selected',
        storeIds: [t.account.storeId],
      },
    });
    const previousRun = await t.db.runConfigSnapshot.create({
      data: {
        storeId: t.account.storeId,
        role: 'reply',
        configEpoch: 1,
        config: json(revision.configSnapshot),
        configHash: revision.configHash,
      },
    });
    await assets.initialize();
    await assets.initialize(); // Startup is idempotent.
    expect((await currentToolkit(t.db, old.id)).id).toBe(COMMERCE_TOOLKIT_ID);
    expect((await assets.module(old.id)).manifest).toEqual(manifest);
    expect(await assets.settings(COMMERCE_TOOLKIT_ID, t.account.storeId)).toEqual({
      preserved: true,
    });
    expect(await t.db.installedExtension.findUnique({ where: { id: old.id } })).toEqual(old);
    expect(await t.db.agentDefinition.findUnique({ where: { id: definition.id } })).toEqual(
      definition,
    );
    expect(await t.db.agentRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
    expect(await t.db.agentBinding.findMany()).toEqual(bindings);
    expect(await t.db.assetSetting.findUnique({ where: { id: setting.id } })).toEqual(setting);
    expect(
      await t.db.resourceScope.findUnique({
        where: { kind_resourceId: { kind: scope.kind, resourceId: scope.resourceId } },
      }),
    ).toEqual(scope);
    expect(await t.db.runConfigSnapshot.findUnique({ where: { id: previousRun.id } })).toEqual(
      previousRun,
    );

    const reply = t.ai.reply.bind(t.ai);
    const spy = vi.spyOn(t.ai, 'reply').mockImplementation(async (ctx) => {
      expect(ctx.config.toolkitIds).toContain(COMMERCE_TOOLKIT_ID);
      for (const id of ctx.config.toolkitIds) await assets!.module(id);
      return reply(ctx); // Model and platform transports remain isolated fixtures.
    });
    await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
    const message = await t.engine.ingest(t.inbound('商品是什么材质'));
    await flush(t.engine, t.db);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(t.sends).toHaveLength(1);
    expect(
      await t.db.aiRun.findFirst({ where: { conversationId: message.conversationId } }),
    ).toMatchObject({ status: 'succeeded', error: null });
    expect(
      await t.db.conversation.findUnique({ where: { id: message.conversationId } }),
    ).toMatchObject({ awaitingHuman: false });
  },
);

it('未知修改、伪造哈希和禁用状态仍不能装载，不能靠跳过校验修复', async () => {
  f = await setup();
  assets = new AssetService(f.db, f.dir);
  const old = await f.db.installedExtension.findUniqueOrThrow({
    where: { id: 'builtin/commerce@1.1.0' },
  });
  const manifest = { ...legacyCommerceV11Modules[0].manifest, description: 'unrecognized change' };
  await f.db.installedExtension.update({
    where: { id: old.id },
    data: { manifest: json(manifest) },
  });
  await expect(assets.module(old.id)).rejects.toThrow('内置资源与当前程序不一致');
  await f.db.installedExtension.update({
    where: { id: old.id },
    data: { artifactHash: hash(manifest) },
  });
  await expect(assets.module(old.id)).rejects.toThrow('内置资源与当前程序不一致');
  await f.db.installedExtension.update({
    where: { id: COMMERCE_TOOLKIT_ID },
    data: { status: 'disabled' },
  });
  await assets.initialize();
  await expect(assets.module(COMMERCE_TOOLKIT_ID)).rejects.toThrow('资源已禁用');
});
