import { afterEach, expect, it, vi } from 'vitest';
import { setup, flush } from './helpers';
import { defaultConfig, type PublishedConfig } from '../packages/agent-config/src';
import { resolveRuntimeToolkits } from '../packages/agent-config/src/toolkit-resolution';
import { workingConfiguration } from '../packages/core/src/working-configuration';
import { apiInputs } from '../packages/contracts/src';
import { Router } from '../packages/core/src/router';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
async function init() {
  return (f = await setup());
}
async function pair(t: Awaited<ReturnType<typeof setup>>) {
  const child = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), name: '协作助手', prompt: '原有指令' },
  });
  const childPublished = await t.engine.agents.publish(child.id, child.draftRevision);
  const parent = await t.engine.agents.save({
    config: {
      ...defaultConfig(t.model.id),
      name: '接待助手',
      subAgents: [{ alias: 'helper', revisionId: childPublished.id }],
    },
  });
  const parentPublished = await t.engine.agents.publish(parent.id, parent.draftRevision);
  await t.engine.agents.bind({
    scopeKey: `store:${t.account.storeId}`,
    agentId: parent.id,
    expectedRevision: null,
  });
  return { child, childPublished, parent, parentPublished };
}

it('按 Agent 身份绑定当前发布配置，无需携带发布记录；未发布或已删除不能绑定', async () => {
  const t = await init();
  await t.db.appSetting.update({ where: { key: 'developerModeEnabled' }, data: { value: true } });
  const router = new Router(t.engine, {} as any);
  const agent = await t.engine.agents.save({ config: defaultConfig(t.model.id) });
  const input = {
    scopeKey: `store:${t.account.storeId}`,
    agentId: agent.id,
    expectedRevision: null,
  };
  expect(apiInputs['agents.bind'].safeParse(input).success).toBe(true);
  expect(apiInputs['agents.bind'].safeParse({ ...input, revisionId: 'another' }).success).toBe(
    false,
  );
  await expect(router.call('agents.bind', input)).rejects.toThrow('尚未发布');
  await t.engine.agents.publish(agent.id, agent.draftRevision);
  const saved = await t.engine.agents.save({
    id: agent.id,
    expectedRevision: agent.draftRevision,
    config: { ...defaultConfig(t.model.id), prompt: '更新后的配置' },
  });
  const current = await t.engine.agents.publish(agent.id, saved.draftRevision);
  await router.call('agents.bind', input);
  expect((await t.engine.agents.resolve(t.account.storeId))?.revision.id).toBe(current.id);
  await t.engine.agents.remove(agent.id);
  await expect(router.call('agents.bind', input)).rejects.toThrow('已删除');
});

it('重复发布相同配置不新增记录、不打断店铺接待', async () => {
  const t = await init();
  const { parent, parentPublished } = await pair(t);
  const before = await t.db.store.findUniqueOrThrow({ where: { id: t.account.storeId } });
  const bindings = await t.db.agentBinding.findMany();
  const again = await t.engine.agents.publish(parent.id, parent.draftRevision);
  expect(again.id).toBe(parentPublished.id);
  expect(await t.db.agentRevision.count({ where: { agentId: parent.id } })).toBe(1);
  expect(await t.db.agentBinding.findMany()).toEqual(bindings);
  expect((await t.db.store.findUniqueOrThrow({ where: { id: before.id } })).replyConfigEpoch).toBe(
    before.replyConfigEpoch,
  );
});

it('发布统一更新全部现有绑定；失败整体回滚，也不抢占其他助手的店铺', async () => {
  const t = await init();
  const bound = (await t.engine.agents.resolve(t.account.storeId))!;
  const a = await t.db.agentDefinition.findUniqueOrThrow({ where: { id: bound.revision.agentId } });
  const second = await t.engine.registerAccount({
    mallId: 'second',
    mallName: '第二店',
    externalId: 'second',
    partition: 'persist:second',
    name: '第二客服',
    capabilities: t.account.capabilities as any,
  });
  await t.engine.agents.bind({
    scopeKey: `store:${second.storeId}`,
    agentId: a.id,
    expectedRevision: null,
  });
  const initialBindings = await t.db.agentBinding.findMany();
  const count = await t.db.agentRevision.count();
  const invalid = await t.engine.agents.save({
    id: a.id,
    expectedRevision: a.draftRevision,
    config: { ...defaultConfig(), prompt: '还没配置模型' },
  });
  await expect(t.engine.agents.publish(a.id, invalid.draftRevision)).rejects.toThrow('对话模型');
  expect(await t.db.agentRevision.count()).toBe(count);
  expect(await t.db.agentBinding.findMany()).toEqual(initialBindings);
  const valid = await t.engine.agents.save({
    id: a.id,
    expectedRevision: invalid.draftRevision,
    config: { ...defaultConfig(t.model.id), prompt: '所有已使用店铺的新规则' },
  });
  const published = await t.engine.agents.publish(a.id, valid.draftRevision);
  expect((await t.engine.agents.resolve(t.account.storeId))?.revision.id).toBe(published.id);
  expect((await t.engine.agents.resolve(second.storeId))?.revision.id).toBe(published.id);
  expect(
    (await t.db.replyPolicy.findUniqueOrThrow({ where: { storeId: second.storeId } }))
      .autoReplyEnabled,
  ).toBe(false);
  const other = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), name: '另一助手' },
  });
  await t.engine.agents.publish(other.id, other.draftRevision);
  expect((await t.engine.agents.resolve(second.storeId))?.revision.id).toBe(published.id);
});

it('子 Agent 发布后父助手自动使用新配置，历史和本轮快照不变，仅影响使用它的店铺', async () => {
  const t = await init();
  const { child, childPublished, parentPublished } = await pair(t);
  const other = await t.engine.registerAccount({
    mallId: 'other-publish',
    mallName: '另一店',
    externalId: 'other-publish',
    partition: 'persist:other-publish',
    name: '另一客服',
    capabilities: t.account.capabilities as any,
  });
  const beforeOther = await t.db.store.findUniqueOrThrow({ where: { id: other.storeId } });
  const beforeStore = await t.db.store.findUniqueOrThrow({ where: { id: t.account.storeId } });
  const config = parentPublished.configSnapshot as unknown as PublishedConfig;
  const originalTree = await resolveRuntimeToolkits(t.db, config, parentPublished.id);
  const saved = await t.engine.agents.save({
    id: child.id,
    expectedRevision: child.draftRevision,
    config: { ...defaultConfig(t.model.id), name: child.name, prompt: '新的已发布指令' },
  });
  expect(
    (await resolveRuntimeToolkits(t.db, config, parentPublished.id))[childPublished.id].prompt,
  ).toBe('原有指令');
  const current = await t.engine.agents.publish(child.id, saved.draftRevision);
  const nextTree = await resolveRuntimeToolkits(t.db, config, parentPublished.id);
  expect(nextTree[parentPublished.id].subAgents).toEqual([
    { alias: 'helper', revisionId: current.id },
  ]);
  expect(nextTree[current.id].prompt).toBe('新的已发布指令');
  expect(originalTree[childPublished.id].prompt).toBe('原有指令');
  expect(await t.db.agentRevision.findUnique({ where: { id: parentPublished.id } })).toEqual(
    parentPublished,
  );
  expect((await t.engine.agents.resolve(t.account.storeId))?.revision.id).toBe(parentPublished.id);
  expect(
    (await t.db.store.findUniqueOrThrow({ where: { id: beforeStore.id } })).replyConfigEpoch,
  ).toBeGreaterThan(beforeStore.replyConfigEpoch);
  expect(
    (await t.db.store.findUniqueOrThrow({ where: { id: beforeOther.id } })).replyConfigEpoch,
  ).toBe(beforeOther.replyConfigEpoch);
  expect(
    (await workingConfiguration(t.engine, t.account.storeId)).resources.find(
      (r) => r.kind === 'agent',
    )?.id,
  ).toBe(current.id);
});

it('子 Agent 发布使正在生成的旧回复失效，实际执行记录保留当时的子助手配置', async () => {
  const t = await init();
  const { child, childPublished, parentPublished } = await pair(t);
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  const spy = vi.spyOn(t.ai, 'reply');
  t.ai.beforeReply = async () => {
    const saved = await t.engine.agents.save({
      id: child.id,
      expectedRevision: child.draftRevision,
      config: { ...defaultConfig(t.model.id), name: child.name, prompt: '新接待规则' },
    });
    await t.engine.agents.publish(child.id, saved.draftRevision);
  };
  await t.engine.ingest(t.inbound());
  await flush(t.engine, t.db);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0].agentTree?.[parentPublished.id].subAgents[0].revisionId).toBe(
    childPublished.id,
  );
  expect(t.sends).toHaveLength(0);
  const snapshot = await t.db.runConfigSnapshot.findFirstOrThrow({ where: { role: 'reply' } });
  expect((snapshot.config as any).agentTree[childPublished.id].prompt).toBe('原有指令');
  expect((await t.db.conversation.findFirstOrThrow()).awaitingHuman).toBe(true);
});

it('更新已挂载子 Agent 时发现间接循环会回滚发布及所有绑定', async () => {
  const t = await init();
  const { child, parentPublished } = await pair(t);
  const saved = await t.engine.agents.save({
    id: child.id,
    expectedRevision: child.draftRevision,
    config: {
      ...defaultConfig(t.model.id),
      subAgents: [{ alias: 'parent', revisionId: parentPublished.id }],
    },
  });
  const before = await t.db.agentBinding.findMany();
  await expect(t.engine.agents.publish(child.id, saved.draftRevision)).rejects.toThrow('环路');
  expect(await t.db.agentRevision.count({ where: { agentId: child.id } })).toBe(1);
  expect(await t.db.agentBinding.findMany()).toEqual(before);
});
