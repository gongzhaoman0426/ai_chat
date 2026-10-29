import { afterEach, expect, it } from 'vitest';
import { DEFAULT_REPLY_PROMPT } from '../packages/contracts/src/reply-guidance';
import { setup, legacyAgent, legacyDefaultConfig } from './helpers';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});

it('没有启用的 Toolkit 时保留旧配置供用户修复，不阻止应用启动', async () => {
  f = await setup();
  const builtin = await f.db.agentDefinition.findFirstOrThrow({
    where: { origin: 'builtin_default' },
  });
  const { revision } = await legacyAgent(f, legacyDefaultConfig(f.model.id, '1.0.0'), {
    id: builtin.id,
    expectedRevision: builtin.draftRevision,
  });
  await f.db.installedExtension.updateMany({
    where: { assetId: 'builtin/commerce' },
    data: { status: 'disabled' },
  });
  await expect(f.engine.agents.upgradeBuiltinDefaults()).resolves.toBeUndefined();
  expect(await f.db.agentRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
});

it.each(['1.0.0', '2.0.0'])(
  '未改动的内置助手只升级通用工具（旧工具 %s），保留模型快照、旧版本和历史绑定，重复启动不重复升级',
  async (toolkitVersion) => {
    f = await setup();
    const definition = await f.db.agentDefinition.findFirstOrThrow({
      where: { origin: 'builtin_default' },
    });
    const seeded = await legacyAgent(f, legacyDefaultConfig(f.model.id, toolkitVersion), {
      id: definition.id,
      expectedRevision: definition.draftRevision,
    });
    const pinned = seeded.revision;
    const { definition: saved, revision: latest } = await legacyAgent(
      f,
      legacyDefaultConfig(f.model.id, toolkitVersion),
      {
        id: definition.id,
        expectedRevision: seeded.definition.draftRevision,
      },
    );
    await f.db.agentBinding.update({
      where: { scopeKey: 'global' },
      data: { agentRevisionId: latest.id },
    });
    await f.db.agentBinding.create({
      data: { scopeKey: `store:${f.account.storeId}`, agentRevisionId: pinned.id },
    });
    await f.db.modelProfile.update({
      where: { id: f.model.id },
      data: { model: 'unpublished-model-edit', revision: { increment: 1 }, maxTokens: 8192 },
    });
    const binding = await f.db.agentBinding.findUniqueOrThrow({ where: { scopeKey: 'global' } });
    const store = await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } });
    const inherited = await f.db.store.create({
      data: { externalId: 'inherited-global', name: '继承全局助手的店铺' },
    });
    await f.engine.agents.upgradeBuiltinDefaults();
    const current = await f.db.agentBinding.findUniqueOrThrow({ where: { scopeKey: 'global' } });
    expect(current.revision).toBe(binding.revision + 1);
    const revision = await f.db.agentRevision.findUniqueOrThrow({
      where: { id: current.agentRevisionId },
    });
    const before = latest.configSnapshot as any;
    expect(revision.revision).toBe(latest.revision + 1);
    expect(revision.configSnapshot).toMatchObject({
      prompt: DEFAULT_REPLY_PROMPT,
      modelSnapshot: before.modelSnapshot,
      toolkitIds: ['builtin/utilities', 'builtin/commerce'],
    });
    expect(await f.db.agentRevision.findUnique({ where: { id: latest.id } })).toEqual(latest);
    expect(await f.db.agentRevision.findUnique({ where: { id: pinned.id } })).toEqual(pinned);
    expect(
      await f.db.agentBinding.findUnique({ where: { scopeKey: `store:${f.account.storeId}` } }),
    ).toMatchObject({ agentRevisionId: pinned.id, revision: 1 });
    expect(await f.db.store.findUnique({ where: { id: store.id } })).toMatchObject({
      replyConfigEpoch: store.replyConfigEpoch,
    });
    expect(await f.db.store.findUnique({ where: { id: inherited.id } })).toMatchObject({
      replyConfigEpoch: inherited.replyConfigEpoch + 1,
    });
    expect(await f.db.agentDefinition.findUnique({ where: { id: definition.id } })).toMatchObject({
      draftRevision: saved.draftRevision + 1,
      draftConfig: { prompt: DEFAULT_REPLY_PROMPT },
    });
    const audit = await f.db.auditEvent.findFirstOrThrow({
      where: { type: 'agent.commerce_tools_upgraded', scope: definition.id },
    });
    expect(audit.details).toMatchObject({
      previousRevisionId: latest.id,
      revisionId: revision.id,
      changedTools: true,
    });
    const count = await f.db.agentRevision.count();
    await f.engine.agents.upgradeBuiltinDefaults();
    expect(await f.db.agentRevision.count()).toBe(count);
    expect(await f.db.auditEvent.count({ where: { type: 'agent.commerce_tools_upgraded' } })).toBe(
      1,
    );
    expect(f.sends).toHaveLength(0);
    expect(f.ai.replyCalls).toBe(0);
  },
);

it('自定义提示词、未发布草稿和自定义 Agent 不自动覆盖', async () => {
  f = await setup();
  const old = legacyDefaultConfig(f.model.id, '2.0.0');
  for (const kind of ['custom-prompt', 'pending-draft', 'custom-agent']) {
    let definition = await f.engine.agents.save({
      config: {
        ...old,
        name: kind,
        ...(kind === 'custom-prompt' ? { prompt: '本店自己的接待规范，请优先查询售后进度。' } : {}),
      },
    });
    if (kind !== 'custom-agent')
      await f.db.agentDefinition.update({
        where: { id: definition.id },
        data: { origin: 'builtin_setup' },
      });
    const revision = await f.engine.agents.publish(definition.id, definition.draftRevision);
    if (kind === 'pending-draft')
      definition = await f.engine.agents.save({
        id: definition.id,
        expectedRevision: definition.draftRevision,
        config: { ...old, name: kind, prompt: '尚未发布的编辑内容' },
      });
    await f.engine.agents.upgradeBuiltinDefaults();
    const current = await f.db.agentDefinition.findUniqueOrThrow({ where: { id: definition.id } });
    expect(current.draftConfig).toEqual(definition.draftConfig);
    expect(current.draftRevision).toBe(definition.draftRevision);
    expect(await f.db.agentRevision.count({ where: { agentId: definition.id } })).toBe(1);
    expect(await f.db.agentRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
  }
});
