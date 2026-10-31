import { afterEach, expect, it, vi } from 'vitest';
import { Router } from '../packages/core/src/router';
import { onboardingState } from '../packages/core/src/onboarding';
import type { MastraAi } from '../packages/ai/src/index';
import { setup } from './helpers';
import { defaultConfig } from '../packages/agent-config/src/index';
import { SkillService } from '../packages/agent-config/src/skills';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
const init = async () => {
  const f = (fixture = await setup());
  const originalDefault = await f.db.agentRevision.findFirstOrThrow({
    where: { revision: 1, agent: { origin: 'builtin_default' } },
  });
  await f.db.agentBinding.update({
    where: { scopeKey: 'global' },
    data: { agentRevisionId: originalDefault.id },
  });
  await f.db.agentRevision.deleteMany({
    where: { agentId: originalDefault.agentId, revision: { gt: 1 } },
  });
  await f.db.agentDefinition.update({
    where: { id: originalDefault.agentId },
    data: { draftConfig: defaultConfig(null) as any },
  });
  const router = new Router(f.engine, {} as MastraAi);
  return { ...f, router };
};
const configEpoch = async () =>
  (await fixture!.db.store.findUniqueOrThrow({ where: { id: fixture!.account.storeId } }))
    .replyConfigEpoch;

it('新用户首次进入配置页；已有店铺不会自动跳转；跳过/继续配置会保存', async () => {
  const f = await init();
  expect((await onboardingState(f.engine)).autoOpen).toBe(false);
  await f.db.account.deleteMany();
  const first = await onboardingState(f.engine);
  expect(first).toMatchObject({ autoOpen: true, nextStep: 1, connected: false, ready: false });
  await f.router.call('app.settings', { setupGuideState: 'dismissed' });
  expect((await onboardingState(f.engine)).autoOpen).toBe(false);
  await f.router.call('app.settings', { setupGuideState: 'active' });
  expect((await onboardingState(f.engine)).autoOpen).toBe(true);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it('新手保存模型后原子创建店铺基础助手并发布绑定，不用开发者模式且不影响其他店铺', async () => {
  const f = await init();
  const globalBefore = await f.db.agentBinding.findUniqueOrThrow({ where: { scopeKey: 'global' } });
  const other = await f.db.store.create({
    data: { name: '其他店铺', externalId: 'other-onboarding' },
  });
  const learningBefore = await f.db.learningPolicy.findUniqueOrThrow({
    where: { storeId: f.account.storeId },
  });
  const epoch = await configEpoch();
  expect(
    await f.router.call('onboarding.configure', {
      storeId: f.account.storeId,
      modelId: f.model.id,
      expectedConfigEpoch: epoch,
    }),
  ).toEqual({ ok: true });
  const state = await onboardingState(f.engine, f.account.storeId);
  expect(state).toMatchObject({
    agent: { ready: true, canConfigure: false, modelId: f.model.id },
    nextStep: 4,
    enabled: false,
  });
  expect((await f.engine.agents.resolve(f.account.storeId))!.binding.scopeKey).toBe(
    `store:${f.account.storeId}`,
  );
  expect(await f.db.agentBinding.findUnique({ where: { scopeKey: 'global' } })).toEqual(
    globalBefore,
  );
  expect(await f.db.store.findUnique({ where: { id: other.id } })).toEqual(other);
  expect(await f.db.learningPolicy.findUnique({ where: { storeId: f.account.storeId } })).toEqual(
    learningBefore,
  );
  expect(
    await f.db.appSetting.findUnique({ where: { key: 'developerModeEnabled' } }),
  ).toMatchObject({ value: false });
  expect(
    await f.db.replyPolicy.findUnique({ where: { storeId: f.account.storeId } }),
  ).toMatchObject({ autoReplyEnabled: false });
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
  const count = await f.db.agentDefinition.count();
  await expect(
    f.router.call('onboarding.configure', {
      storeId: f.account.storeId,
      modelId: f.model.id,
      expectedConfigEpoch: epoch,
    }),
  ).rejects.toThrow('配置已变化');
  expect(await f.db.agentDefinition.count()).toBe(count);
});

it.each(['customized-default', 'custom', 'missing-resource'] as const)(
  '引导不会覆盖已有 %s 工作配置',
  async (mode) => {
    const f = await init();
    await f.engine.agents.setDefaultModel(f.model.id);
    let revision = await f.db.agentRevision.findFirstOrThrow({
      where: { agent: { origin: 'builtin_default' }, revision: 2 },
    });
    if (mode === 'custom') {
      const a = await f.engine.agents.save({
        config: { ...defaultConfig(f.model.id), name: '自定义客服', prompt: '保留此定制' },
      });
      revision = await f.engine.agents.publish(a.id, a.draftRevision);
    }
    if (mode === 'customized-default') {
      const agent = await f.db.agentDefinition.findUniqueOrThrow({
        where: { id: revision.agentId },
      });
      await f.engine.agents.save({
        id: agent.id,
        expectedRevision: agent.draftRevision,
        config: { ...(agent.draftConfig as any), prompt: '保留默认助手中的定制草稿' },
      });
    }
    await f.db.agentBinding.update({
      where: { scopeKey: 'global' },
      data: { agentRevisionId: revision.id },
    });
    if (mode === 'missing-resource')
      await f.db.installedExtension.update({
        where: { id: 'builtin/utilities@1.0.0' },
        data: { status: 'disabled' },
      });
    const before = await f.db.agentBinding.findMany();
    const agents = await f.db.agentDefinition.findMany();
    expect((await onboardingState(f.engine, f.account.storeId)).agent.canConfigure).toBe(false);
    await expect(
      f.router.call('onboarding.configure', {
        storeId: f.account.storeId,
        modelId: f.model.id,
        expectedConfigEpoch: await configEpoch(),
      }),
    ).rejects.toThrow(mode === 'missing-resource' ? '资源版本不可用' : '引导不会替换');
    expect(await f.db.agentBinding.findMany()).toEqual(before);
    expect(await f.db.agentDefinition.findMany()).toEqual(agents);
  },
);

it('已配置的默认助手可从引导换模型，只为本店应用并保留共享默认助手和其他店铺', async () => {
  const f = await init();
  await f.engine.agents.setDefaultModel(f.model.id);
  const before = (await f.engine.agents.resolve(f.account.storeId))!;
  const defaultAgent = await f.db.agentDefinition.findUniqueOrThrow({
    where: { id: before.revision.agentId },
  });
  const other = await f.db.store.create({
    data: { name: '其他店', externalId: 'default-model-other' },
  });
  const model = await f.db.modelProfile.create({
    data: {
      name: '本店回复模型',
      kind: 'chat',
      model: 'store-model',
      baseUrl: 'http://localhost/v1',
    },
  });
  expect((await onboardingState(f.engine, f.account.storeId)).agent).toMatchObject({
    ready: true,
    canChangeModel: true,
    source: 'default',
    modelChanged: false,
  });
  await f.router.call('onboarding.configure', {
    storeId: f.account.storeId,
    modelId: model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  const after = (await f.engine.agents.resolve(f.account.storeId))!;
  expect(after.config.modelProfileId).toBe(model.id);
  expect(after.revision.agentId).not.toBe(before.revision.agentId);
  expect((await f.engine.agents.resolve(other.id))!.revision).toEqual(before.revision);
  expect(await f.db.agentDefinition.findUnique({ where: { id: defaultAgent.id } })).toEqual(
    defaultAgent,
  );
  expect((await onboardingState(f.engine, f.account.storeId)).agent).toMatchObject({
    canChangeModel: true,
    source: 'store',
    modelId: model.id,
  });
  await f.router.call('models.save', {
    id: model.id,
    name: model.name,
    kind: 'chat',
    model: 'updated-model',
    baseUrl: model.baseUrl,
  });
  expect((await onboardingState(f.engine, f.account.storeId)).agent).toMatchObject({
    modelChanged: true,
    model: 'store-model',
  });
  await f.router.call('onboarding.configure', {
    storeId: f.account.storeId,
    modelId: model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  expect((await onboardingState(f.engine, f.account.storeId)).agent).toMatchObject({
    modelChanged: false,
    model: 'updated-model',
  });
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it('基础助手允许重新选模型，保留旧发布快照和其他店铺，仅更新当前店铺绑定', async () => {
  const f = await init();
  await f.engine.agents.configureStarter({
    storeId: f.account.storeId,
    modelId: f.model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  const original = (await f.engine.agents.resolve(f.account.storeId))!;
  const global = await f.db.agentBinding.findUnique({ where: { scopeKey: 'global' } });
  const count = await f.db.agentDefinition.count();
  const model = await f.db.modelProfile.create({
    data: {
      name: '修改后的服务',
      kind: 'chat',
      model: 'correct-model',
      baseUrl: 'http://localhost/v1',
    },
  });
  expect((await onboardingState(f.engine, f.account.storeId)).agent.canChangeModel).toBe(true);
  await f.router.call('onboarding.configure', {
    storeId: f.account.storeId,
    modelId: model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  const updated = (await f.engine.agents.resolve(f.account.storeId))!;
  expect(updated.revision.agentId).toBe(original.revision.agentId);
  expect(updated.revision.revision).toBe(original.revision.revision + 1);
  expect(updated.config.modelSnapshot).toMatchObject({ id: model.id, model: 'correct-model' });
  expect(await f.db.agentRevision.findUnique({ where: { id: original.revision.id } })).toEqual(
    original.revision,
  );
  expect(await f.db.agentDefinition.count()).toBe(count);
  expect(await f.db.agentBinding.findUnique({ where: { scopeKey: 'global' } })).toEqual(global);
  expect((await onboardingState(f.engine, f.account.storeId)).agent.canChangeModel).toBe(true);
  expect(f.sends).toHaveLength(0);
  expect(f.ai.replyCalls).toBe(0);
});

it('默认助手已发布的定制在首次复制和后续换模型时完整保留，不应用技能的新内容', async () => {
  const f = await init();
  const skillConfig = {
    name: 'shop-guide',
    description: '店铺接待规范',
    instructions: '沿用已核实的店铺规范',
    references: { 'references/guide.md': '已经发布的资料' },
    scripts: { 'scripts/check.js': 'export default () => "published";' },
  };
  const skills = new SkillService(f.db);
  const skill = await skills.save({ config: skillConfig });
  const child = await f.engine.agents.save({
    config: { ...defaultConfig(f.model.id), name: '售后助手' },
  });
  const childRevision = await f.engine.agents.publish(child.id, child.draftRevision);
  const original = await f.db.agentDefinition.findFirstOrThrow({
    where: { origin: 'builtin_default' },
  });
  const saved = await f.engine.agents.save({
    id: original.id,
    expectedRevision: original.draftRevision,
    config: {
      ...defaultConfig(f.model.id),
      prompt: '这是用户已经调整过的默认提示词，不要重置成当前模板',
      toolkitIds: ['builtin/utilities@1.0.0', 'builtin/commerce@1.0.0'],
      skillIds: [skill.id],
      subAgents: [{ alias: 'afterSales', revisionId: childRevision.id }],
      memory: { lastMessages: 12, workingMemory: true },
    },
  });
  await f.engine.agents.publish(saved.id, saved.draftRevision);
  const before = (await f.engine.agents.resolve(f.account.storeId))!;
  const defaultAgent = await f.db.agentDefinition.findUniqueOrThrow({ where: { id: original.id } });
  const other = await f.db.store.create({
    data: { name: '仍用默认助手的店', externalId: 'custom-default-other' },
  });
  // Updating the skill library must not change the assistant's immutable published content.
  await skills.save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: { ...skillConfig, instructions: '还未应用到助手的新内容' },
  });
  const model = await f.db.modelProfile.create({
    data: { name: '新模型', kind: 'chat', model: 'new', baseUrl: 'http://localhost/v1' },
  });
  let starterId: string | undefined;
  for (const modelId of [model.id, f.model.id]) {
    expect((await onboardingState(f.engine, f.account.storeId)).agent.canChangeModel).toBe(true);
    await f.router.call('onboarding.configure', {
      storeId: f.account.storeId,
      modelId,
      expectedConfigEpoch: await configEpoch(),
    });
    const applied = (await f.engine.agents.resolve(f.account.storeId))!;
    expect(applied.config).toEqual({
      ...before.config,
      name: '测试店铺 · 客服助手',
      modelProfileId: modelId,
      modelSnapshot: expect.objectContaining({ id: modelId }),
    });
    if (starterId) expect(applied.revision.agentId).toBe(starterId);
    starterId = applied.revision.agentId;
    expect(starterId).not.toBe(original.id);
    expect(
      await f.db.agentRevisionSubAgent.findMany({
        where: { parentRevisionId: applied.revision.id },
        select: { alias: true, childRevisionId: true },
      }),
    ).toEqual([{ alias: 'afterSales', childRevisionId: childRevision.id }]);
  }
  expect(await f.db.agentDefinition.findUnique({ where: { id: original.id } })).toEqual(
    defaultAgent,
  );
  expect((await f.engine.agents.resolve(other.id))!.revision).toEqual(before.revision);
  expect(await f.db.agentRevision.findUnique({ where: { id: before.revision.id } })).toEqual(
    before.revision,
  );
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it.each(['draft', 'old-revision', 'shared'] as const)(
  '已经 %s 的基础助手不能被引导覆盖',
  async (mode) => {
    const f = await init();
    await f.engine.agents.configureStarter({
      storeId: f.account.storeId,
      modelId: f.model.id,
      expectedConfigEpoch: await configEpoch(),
    });
    const current = (await f.engine.agents.resolve(f.account.storeId))!;
    if (mode === 'shared') {
      await f.db.agentBinding.create({
        data: { scopeKey: 'store:another-store', agentRevisionId: current.revision.id },
      });
    } else {
      const a = await f.db.agentDefinition.findUniqueOrThrow({
        where: { id: current.revision.agentId },
      });
      const saved = await f.engine.agents.save({
        id: a.id,
        expectedRevision: a.draftRevision,
        config: { ...(a.draftConfig as any), prompt: '保留高级用户的定制提示词' },
      });
      if (mode === 'old-revision') {
        await f.engine.agents.publish(saved.id, saved.draftRevision);
        await f.db.agentBinding.update({
          where: { scopeKey: `store:${f.account.storeId}` },
          data: { agentRevisionId: current.revision.id },
        });
      }
    }
    const before = await f.db.agentDefinition.findMany();
    const bindings = await f.db.agentBinding.findMany();
    expect((await onboardingState(f.engine, f.account.storeId)).agent.canChangeModel).toBe(false);
    await expect(
      f.router.call('onboarding.configure', {
        storeId: f.account.storeId,
        modelId: f.model.id,
        expectedConfigEpoch: await configEpoch(),
      }),
    ).rejects.toThrow('引导不会替换');
    expect(await f.db.agentDefinition.findMany()).toEqual(before);
    expect(await f.db.agentBinding.findMany()).toEqual(bindings);
  },
);

it('未配置模型时不能完成引导，缺少或类型错误的模型不会留下空助手', async () => {
  const f = await init();
  const count = await f.db.agentDefinition.count();
  const embedding = await f.db.modelProfile.create({
    data: {
      name: '向量',
      kind: 'embedding',
      model: 'embed',
      baseUrl: 'http://localhost/v1',
      dimensions: 3,
    },
  });
  for (const id of ['missing-model', embedding.id])
    await expect(
      f.router.call('onboarding.configure', {
        storeId: f.account.storeId,
        modelId: id,
        expectedConfigEpoch: await configEpoch(),
      }),
    ).rejects.toThrow('对话模型');
  expect(await f.db.agentDefinition.count()).toBe(count);
  await expect(
    f.router.call('onboarding.enable', {
      storeId: f.account.storeId,
      expectedConfigEpoch: await configEpoch(),
    }),
  ).rejects.toThrow('尚未配置模型');
  expect(await f.db.appSetting.findUnique({ where: { key: 'setupGuideState' } })).toBeNull();
});

it('收发未确认不能跳过；确认完成后显式开启，不自动发送消息或开启学习', async () => {
  const f = await init();
  await f.router.call('onboarding.configure', {
    storeId: f.account.storeId,
    modelId: f.model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
  const input = { storeId: f.account.storeId, expectedConfigEpoch: await configEpoch() };
  expect(await onboardingState(f.engine, f.account.storeId)).toMatchObject({
    ready: false,
    readiness: { action: 'verify' },
  });
  await expect(f.router.call('onboarding.enable', input)).rejects.toThrow('验收确认');
  expect(
    await f.db.replyPolicy.findUnique({ where: { storeId: f.account.storeId } }),
  ).toMatchObject({ autoReplyEnabled: false });
  await f.engine.verifyAccount(f.account.id);
  await f.router.call('onboarding.enable', input);
  expect(await onboardingState(f.engine, f.account.storeId)).toMatchObject({
    ready: true,
    enabled: true,
    completedSteps: 3,
    autoOpen: false,
    guideState: 'completed',
  });
  expect(
    await f.db.learningPolicy.findUnique({ where: { storeId: f.account.storeId } }),
  ).toMatchObject({ autoLearnEnabled: false });
  const before = await f.db.store.findUnique({ where: { id: f.account.storeId } });
  await f.router.call('onboarding.enable', { ...input, expectedConfigEpoch: await configEpoch() });
  expect(await f.db.store.findUnique({ where: { id: f.account.storeId } })).toEqual(before);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it('引导创建的助手可在之后直接开启学习，沿用它的模型但保留已有学习选择', async () => {
  const f = await init();
  await f.db.appSetting.deleteMany({ where: { key: 'defaultModelId' } });
  await f.db.learningPolicy.update({
    where: { storeId: f.account.storeId },
    data: { builtinModelRef: null },
  });
  await f.engine.agents.configureStarter({
    storeId: f.account.storeId,
    modelId: f.model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  expect(
    await f.db.learningPolicy.findUnique({ where: { storeId: f.account.storeId } }),
  ).toMatchObject({ autoLearnEnabled: false, builtinModelRef: null });
  await f.router.call('stores.policy', { storeId: f.account.storeId, autoLearnEnabled: true });
  expect(
    await f.db.learningPolicy.findUnique({ where: { storeId: f.account.storeId } }),
  ).toMatchObject({ autoLearnEnabled: true, builtinModelRef: f.model.id });
  const separate = await f.db.modelProfile.create({
    data: { name: '学习专用', kind: 'chat', model: 'learning', baseUrl: 'http://localhost/v1' },
  });
  await f.router.call('stores.policy', {
    storeId: f.account.storeId,
    autoLearnEnabled: false,
    builtinModelRef: separate.id,
  });
  await f.router.call('stores.policy', { storeId: f.account.storeId, autoLearnEnabled: true });
  expect(
    await f.db.learningPolicy.findUnique({ where: { storeId: f.account.storeId } }),
  ).toMatchObject({ builtinModelRef: separate.id });
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it('完成按钮重新检查配置版本、账号和资源，不信任前端显示的完成状态', async () => {
  const f = await init();
  await f.router.call('onboarding.configure', {
    storeId: f.account.storeId,
    modelId: f.model.id,
    expectedConfigEpoch: await configEpoch(),
  });
  const epoch = await configEpoch();
  await f.engine.setPolicy({ storeId: f.account.storeId, directMatchThreshold: 0.91 });
  await expect(
    f.router.call('onboarding.enable', { storeId: f.account.storeId, expectedConfigEpoch: epoch }),
  ).rejects.toThrow('配置已变化');
  await f.db.account.update({ where: { id: f.account.id }, data: { status: 'offline' } });
  await expect(
    f.router.call('onboarding.enable', {
      storeId: f.account.storeId,
      expectedConfigEpoch: await configEpoch(),
    }),
  ).rejects.toThrow('通道未连接');
  await f.db.account.update({ where: { id: f.account.id }, data: { status: 'online' } });
  await f.db.installedExtension.update({
    where: { id: 'builtin/utilities@1.0.0' },
    data: { status: 'disabled' },
  });
  await expect(
    f.router.call('onboarding.enable', {
      storeId: f.account.storeId,
      expectedConfigEpoch: await configEpoch(),
    }),
  ).rejects.toThrow('资源版本不可用');
  expect(await f.db.appSetting.findUnique({ where: { key: 'setupGuideState' } })).toBeNull();
});

it('引导进度只读，不泄露模型密钥或写入假完成标记', async () => {
  const f = await init();
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: { secretRef: 'SECRET_ONBOARDING' },
  });
  const changed = vi.fn();
  f.engine.onChanged = changed;
  const state = await f.router.call('onboarding.state', { storeId: f.account.storeId });
  expect(JSON.stringify(state)).not.toContain('SECRET_ONBOARDING');
  expect(JSON.stringify(state)).not.toContain('secretRef');
  expect(changed).not.toHaveBeenCalled();
  expect((await onboardingState(f.engine, 'deleted-store')).store).toBeNull();
  await f.db.account.deleteMany();
  await expect(
    f.router.call('onboarding.configure', {
      storeId: f.account.storeId,
      modelId: f.model.id,
      expectedConfigEpoch: await configEpoch(),
    }),
  ).rejects.toThrow('请先连接');
});

it('连接店铺后下一步是全局向量模型，配好助手后进入接待检查', async () => {
  const f = await init();
  expect(await onboardingState(f.engine, f.account.storeId)).toMatchObject({
    embedding: { ready: false },
    nextStep: 2,
  });
  const embedding = (await f.router.call('models.save', {
    name: '问答向量',
    kind: 'embedding',
    model: 'embed-fixture',
    baseUrl: 'http://localhost:9999/v1',
    dimensions: 8,
  })) as { id: string };
  await f.router.call('app.settings', { embeddingProfileId: embedding.id });
  expect(await onboardingState(f.engine, f.account.storeId)).toMatchObject({
    embedding: { ready: true, profileId: embedding.id, model: 'embed-fixture' },
    nextStep: 3,
  });
});
