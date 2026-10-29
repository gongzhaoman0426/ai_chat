import { afterEach, expect, it } from 'vitest';
import { setup } from './helpers';
import { SkillService } from '../packages/agent-config/src/skills';
import { agentConfigSchema, skillInputSchema } from '../packages/contracts/src';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});

const config = skillInputSchema.parse({
  name: 'care-guide',
  description: '商品清洗与日常保养说明',
  instructions: '根据 references/washing.md 和 references/drying.md 回答保养问题。',
  references: {
    'references/washing.md': '使用冷水轻柔手洗。',
    'references/drying.md': '通风处自然晾干。',
  },
  scripts: { 'scripts/check.mjs': 'process.stdout.write("ok");' },
});
const earlier = new Date('2025-01-02T03:04:05Z');

it('重复保存相同内容或仅调整 references 键顺序，不改变记录、更新时间和审计', async () => {
  f = await setup();
  const skills = new SkillService(f.db);
  const created = await skills.save({ config });
  // An old timestamp makes an accidental database update observable without sleeping.
  const before = await f.db.skillDefinition.update({
    where: { id: created.id },
    data: { updatedAt: earlier },
  });
  const auditBefore = await f.db.auditEvent.findMany({
    where: { type: 'skill.save', scope: created.id },
    orderBy: { id: 'asc' },
  });
  expect(auditBefore).toHaveLength(1);

  for (const next of [
    config,
    {
      ...config,
      references: Object.fromEntries(Object.entries(config.references).reverse()),
    },
  ]) {
    const saved = await skills.save({
      id: created.id,
      expectedRevision: created.revision,
      config: next,
    });
    expect(saved.revision).toBe(created.revision);
    expect(saved.updatedAt).toEqual(earlier);
    expect(await f.db.skillDefinition.findUniqueOrThrow({ where: { id: created.id } })).toEqual(
      before,
    );
    expect(
      await f.db.auditEvent.findMany({
        where: { type: 'skill.save', scope: created.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(auditBefore);
  }
});

it('实质修改更新内部修订和审计，旧 expectedRevision 不能覆盖内容或绕过冲突检查', async () => {
  f = await setup();
  const skills = new SkillService(f.db);
  const created = await skills.save({ config });
  await f.db.skillDefinition.update({ where: { id: created.id }, data: { updatedAt: earlier } });
  const changedConfig = {
    ...config,
    references: { ...config.references, 'references/washing.md': '使用冷水手洗，禁止使用漂白剂。' },
  };
  const changed = await skills.save({
    id: created.id,
    expectedRevision: created.revision,
    config: changedConfig,
  });
  expect(changed.revision).toBe(created.revision + 1);
  expect(changed.updatedAt.getTime()).toBeGreaterThan(earlier.getTime());
  expect(changed.references).toEqual(changedConfig.references);
  expect(changed.scripts).toEqual(config.scripts);

  for (const staleConfig of [config, changedConfig]) {
    await expect(
      skills.save({
        id: created.id,
        expectedRevision: created.revision,
        config: staleConfig,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  }
  const unchanged = await skills.save({
    id: created.id,
    expectedRevision: changed.revision,
    config: changedConfig,
  });
  expect(unchanged).toEqual(changed);
  expect(await f.db.skillDefinition.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject(
    {
      revision: changed.revision,
      updatedAt: changed.updatedAt,
      references: changedConfig.references,
    },
  );
  const audit = await f.db.auditEvent.findMany({
    where: { type: 'skill.save', scope: created.id },
  });
  expect(audit).toHaveLength(2);
  expect(audit.map((event) => event.details)).toEqual(
    expect.arrayContaining([{ revision: created.revision }, { revision: changed.revision }]),
  );
});

it('已挂载 Skill 的同内容保存不创建 AgentRevision，也不修改 Agent 草稿和店铺绑定', async () => {
  f = await setup();
  const skills = new SkillService(f.db);
  const skill = await skills.save({ config });
  const agent = await f.engine.agents.save({
    config: agentConfigSchema.parse({
      name: '保养助手',
      prompt: '使用已挂载的保养说明回答。',
      modelProfileId: f.model.id,
      skillIds: [skill.id],
    }),
  });
  const revision = await f.engine.agents.publish(agent.id, agent.draftRevision);
  await f.engine.agents.bind({
    scopeKey: `store:${f.account.storeId}`,
    revisionId: revision.id,
    expectedRevision: null,
  });
  const revisionsBefore = await f.db.agentRevision.findMany({ orderBy: { id: 'asc' } });
  const bindingsBefore = await f.db.agentBinding.findMany({ orderBy: { scopeKey: 'asc' } });
  const agentBefore = await f.db.agentDefinition.findUniqueOrThrow({ where: { id: agent.id } });
  const storeBefore = await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } });
  const auditBefore = await f.db.auditEvent.count();

  const saved = await skills.save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: structuredClone(config),
  });
  expect(saved.mountedBy).toEqual([{ id: agent.id, name: agent.name }]);
  expect(await f.db.agentRevision.findMany({ orderBy: { id: 'asc' } })).toEqual(revisionsBefore);
  expect(await f.db.agentBinding.findMany({ orderBy: { scopeKey: 'asc' } })).toEqual(
    bindingsBefore,
  );
  expect(await f.db.agentDefinition.findUniqueOrThrow({ where: { id: agent.id } })).toEqual(
    agentBefore,
  );
  expect(await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } })).toEqual(
    storeBefore,
  );
  expect(await f.db.auditEvent.count()).toBe(auditBefore);
});
