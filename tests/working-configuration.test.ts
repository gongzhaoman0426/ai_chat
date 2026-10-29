import { afterEach, expect, it } from 'vitest';
import { setup } from './helpers';
import { Router } from '../packages/core/src/router';
import type { MastraAi } from '../packages/ai/src';
import { workingConfiguration } from '../packages/core/src/working-configuration';
import { defaultConfig } from '../packages/agent-config/src';
import { getResourceScope, saveResourceScope } from '../packages/agent-config/src/resource-scope';
import { SkillService } from '../packages/agent-config/src/skills';
import { json } from '../packages/database/src';
let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
const init = async () => (f = await setup());

it('普通用户可看实际发布版本和模型，草稿/模型修改均提示未应用，不返回密钥', async () => {
  const t = await init();
  await t.db.modelProfile.update({
    where: { id: t.model.id },
    data: { secretRef: 'DO_NOT_EXPOSE' },
  });
  const bound = (await t.engine.agents.resolve(t.account.storeId))!;
  let current = await workingConfiguration(t.engine, t.account.storeId);
  expect(current.agent).toMatchObject({
    revisionId: bound.revision.id,
    source: 'global',
    draftChanged: false,
    modelChanged: false,
  });
  const definition = await t.db.agentDefinition.findUniqueOrThrow({
    where: { id: bound.revision.agentId },
  });
  await t.engine.agents.save({
    id: definition.id,
    expectedRevision: definition.draftRevision,
    config: { ...(definition.draftConfig as any), name: '尚未发布的修改', prompt: 'new draft' },
  });
  await t.db.modelProfile.update({
    where: { id: t.model.id },
    data: { model: 'new-model', revision: { increment: 1 } },
  });
  const router = new Router(t.engine, {} as MastraAi);
  current = (await router.call('stores.configuration', {
    storeId: t.account.storeId,
  })) as typeof current;
  expect(current.agent).toMatchObject({
    revisionId: bound.revision.id,
    draftChanged: true,
    modelChanged: true,
    model: { model: 'fixture' },
  });
  expect(JSON.stringify(current)).not.toContain('DO_NOT_EXPOSE');
  expect(JSON.stringify(current)).not.toContain('secretRef');
  expect(JSON.stringify(current)).not.toContain('new draft');
  expect(current.notices.map((n) => n.message).join(' ')).toContain('草稿');
  expect(t.ai.replyCalls).toBe(0);
});
it('模型/工作绑定缺失及已移除店铺返回明确状态，不显示错误的就绪', async () => {
  const t = await init();
  const bound = (await t.engine.agents.resolve(t.account.storeId))!;
  await t.db.agentRevision.update({
    where: { id: bound.revision.id },
    data: { configSnapshot: json({ ...bound.config, modelSnapshot: null }) },
  });
  expect(
    (await workingConfiguration(t.engine, t.account.storeId)).blockers.some((b) =>
      b.message.includes('未配置回复模型'),
    ),
  ).toBe(true);
  await t.db.agentBinding.deleteMany();
  const noAgent = await workingConfiguration(t.engine, t.account.storeId);
  expect(noAgent.agent).toBeNull();
  expect(noAgent.notices[0].message).toContain('仅可使用');
  await t.db.account.deleteMany();
  await expect(workingConfiguration(t.engine, t.account.storeId)).rejects.toThrow('已移除');
});
it('总览按平台、每个账号能力、店铺权限裁剪，Skill 跟随最新保存的内容', async () => {
  const t = await init();
  const dy = await t.engine.registerAccount({
    platform: 'douyin',
    mallId: 'dy',
    mallName: '抖店',
    externalId: 'dy',
    partition: 'persist:dy',
    name: '抖店客服',
    capabilities: { ...(t.account.capabilities as any), orders: true },
  });
  await t.db.account.update({ where: { id: dy.id }, data: { verifiedAt: new Date() } });
  const skill = await new SkillService(t.db).save({
    config: {
      name: 'shop-rule',
      description: '规则',
      instructions: 'v1',
      references: {},
      scripts: {},
    },
  });
  const agent = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), skillIds: [skill.id] },
  });
  const rev = await t.engine.agents.publish(agent.id, agent.draftRevision);
  await t.engine.agents.bind({
    scopeKey: `store:${dy.storeId}`,
    revisionId: rev.id,
    expectedRevision: null,
  });
  const current = await workingConfiguration(t.engine, dy.storeId);
  expect(current.agent).toMatchObject({ source: 'store', revisionId: rev.id });
  const commerce = current.resources.find((r) => r.id.startsWith('builtin/commerce'))!;
  expect(commerce.status).toBe('partial');
  expect(commerce.members.some((m) => m.availableAccounts.includes('抖店客服'))).toBe(true);
  expect(commerce.members.some((m) => !m.availableAccounts.length)).toBe(true);
  await new SkillService(t.db).save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: {
      name: 'updated-shop-rule',
      description: '更新',
      instructions: 'v2',
      references: {},
      scripts: {},
    },
  });
  expect(
    (await workingConfiguration(t.engine, dy.storeId)).resources.find((r) => r.id === skill.id),
  ).toMatchObject({
    name: 'updated-shop-rule',
    version: '',
    reason: '使用技能库中最新保存的内容，无需重新发布 Agent',
  });
  const old = await getResourceScope(t.db, 'skill', skill.id);
  await t.db.$transaction((tx) =>
    saveResourceScope(tx, {
      kind: 'skill',
      resourceId: skill.id,
      expectedRevision: old.revision,
      mode: 'selected',
      storeIds: [t.account.storeId],
    }),
  );
  expect(
    (await workingConfiguration(t.engine, dy.storeId)).resources.find((r) => r.id === skill.id),
  ).toMatchObject({ status: 'unavailable', reason: '未授权此店铺使用' });
});
