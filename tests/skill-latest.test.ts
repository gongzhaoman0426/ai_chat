import { afterEach, expect, it, vi } from 'vitest';
import { setup, flush } from './helpers';
import { agentConfigSchema, skillInputSchema } from '../packages/contracts/src';
import type { PublishedConfig } from '../packages/agent-config/src';
import { currentSkills, publishedSkills, SkillService } from '../packages/agent-config/src/skills';
import { resolveRuntimeToolkits } from '../packages/agent-config/src/toolkit-resolution';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
const guide = skillInputSchema.parse({
  name: 'saved-method',
  description: '处理方法',
  instructions: 'ORIGINAL_INSTRUCTIONS',
  references: { 'references/guide.md': 'ORIGINAL_REFERENCE' },
  scripts: { 'scripts/check.ts': "console.log('ORIGINAL_SCRIPT')" },
});
const config = (skillIds: string[]) =>
  agentConfigSchema.parse({
    name: '技能助手',
    prompt: '按照已挂载技能回答。',
    modelProfileId: f!.model.id,
    skillIds,
  });

it('Skill 保存后父子助手都使用最新正文、资料和脚本；同一轮固定内容，下轮跟进', async () => {
  f = await setup();
  const service = new SkillService(f.db);
  const skill = await service.save({ config: guide });
  const child = await f.engine.agents.save({ config: config([skill.id]) });
  const childRevision = await f.engine.agents.publish(child.id, child.draftRevision);
  const parent = await f.engine.agents.save({
    config: {
      ...config([skill.id]),
      subAgents: [{ alias: 'child', revisionId: childRevision.id }],
    },
  });
  const revision = await f.engine.agents.publish(parent.id, parent.draftRevision);
  const published = revision.configSnapshot as unknown as PublishedConfig;
  const updated = {
    ...guide,
    name: 'updated-method',
    description: '最新处理方法',
    instructions: 'UPDATED_INSTRUCTIONS',
    references: { 'references/guide.md': 'UPDATED_REFERENCE' },
    scripts: { 'scripts/check.ts': "console.log('UPDATED_SCRIPT')" },
  };
  const saved = await service.save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: updated,
  });
  const tree = await resolveRuntimeToolkits(f.db, published, revision.id);
  const used = publishedSkills(tree[revision.id])[0];
  expect(used).toMatchObject({ ...updated, id: skill.id, revision: saved.revision });
  expect(publishedSkills(tree[childRevision.id])[0]).toBe(used);
  await service.save({
    id: skill.id,
    expectedRevision: saved.revision,
    config: { ...updated, instructions: 'NEXT_RUN', scripts: {} },
  });
  expect(publishedSkills(tree[childRevision.id])[0]).toEqual(used);
  const next = await resolveRuntimeToolkits(f.db, published, revision.id);
  expect(publishedSkills(next[revision.id])[0]).toMatchObject({
    instructions: 'NEXT_RUN',
    scripts: {},
  });
  expect(publishedSkills(next[childRevision.id])[0]).toBe(publishedSkills(next[revision.id])[0]);
  expect(await f.db.agentRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
  expect(await f.db.agentRevision.findUnique({ where: { id: childRevision.id } })).toEqual(
    childRevision,
  );
  expect(await f.db.agentDefinition.findUnique({ where: { id: parent.id } })).toEqual(parent);
});

it('已绑定助手直接使用保存后的 Skill，运行记录保存实际内容且不生成助手发布记录', async () => {
  f = await setup();
  const service = new SkillService(f.db);
  const skill = await service.save({ config: guide });
  const agent = await f.engine.agents.save({ config: config([skill.id]) });
  const revision = await f.engine.agents.publish(agent.id, agent.draftRevision);
  await f.engine.agents.bind({
    scopeKey: `store:${f.account.storeId}`,
    revisionId: revision.id,
    expectedRevision: null,
  });
  const before = await f.db.agentRevision.count({ where: { agentId: agent.id } });
  await service.save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: { ...guide, instructions: 'SAVED_AND_EFFECTIVE' },
  });
  const reply = vi.spyOn(f.ai, 'reply');
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.ingest(f.inbound('请按照方法处理这个问题'));
  await flush(f.engine, f.db);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(publishedSkills(reply.mock.calls[0][0].config)[0].instructions).toBe(
    'SAVED_AND_EFFECTIVE',
  );
  const run = await f.db.runConfigSnapshot.findFirstOrThrow({
    where: { storeId: f.account.storeId, role: 'reply' },
  });
  const tree = (run.config as { agentTree: Record<string, PublishedConfig> }).agentTree;
  expect(publishedSkills(tree[revision.id])[0].instructions).toBe('SAVED_AND_EFFECTIVE');
  expect(await f.db.agentRevision.count({ where: { agentId: agent.id } })).toBe(before);
  expect(await f.db.agentRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
});

it('删除或缺失的 Skill 保留各助手原有副本，共享挂载不会串用历史内容', async () => {
  f = await setup();
  const service = new SkillService(f.db);
  const skill = await service.save({ config: guide });
  const child = await f.engine.agents.save({ config: config([skill.id]) });
  const childRevision = await f.engine.agents.publish(child.id, child.draftRevision);
  const saved = await service.save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: { ...guide, instructions: 'PARENT_COPY' },
  });
  const parent = await f.engine.agents.save({
    config: {
      ...config([skill.id]),
      subAgents: [{ alias: 'child', revisionId: childRevision.id }],
    },
  });
  const revision = await f.engine.agents.publish(parent.id, parent.draftRevision);
  await service.remove(skill.id, saved.revision);
  for (const removeRow of [false, true]) {
    if (removeRow) await f.db.skillDefinition.delete({ where: { id: skill.id } });
    const tree = await resolveRuntimeToolkits(
      f.db,
      revision.configSnapshot as unknown as PublishedConfig,
      revision.id,
    );
    expect(publishedSkills(tree[revision.id])[0].instructions).toBe('PARENT_COPY');
    expect(publishedSkills(tree[childRevision.id])[0].instructions).toBe(guide.instructions);
  }
});

it('保存拒绝使助手技能重名，旧数据和快照损坏也不能绕过运行校验', async () => {
  f = await setup();
  const service = new SkillService(f.db);
  const first = await service.save({ config: guide });
  const second = await service.save({ config: { ...guide, name: 'other-method' } });
  const agent = await f.engine.agents.save({ config: config([first.id, second.id]) });
  const revision = await f.engine.agents.publish(agent.id, agent.draftRevision);
  const published = revision.configSnapshot as unknown as PublishedConfig;
  await expect(
    service.save({ id: second.id, expectedRevision: second.revision, config: guide }),
  ).rejects.toThrow('同名 Skill');
  const { mountedBy: _, ...unchanged } = second;
  expect(await f.db.skillDefinition.findUnique({ where: { id: second.id } })).toEqual(unchanged);
  // Historical/corrupt local data still gets a defensive runtime check.
  await f.db.skillDefinition.update({ where: { id: second.id }, data: { name: first.name } });
  await expect(currentSkills(f.db, published)).rejects.toThrow('同名 Skill');
  const tampered = structuredClone(published);
  tampered.skills![0].instructions = 'TAMPERED';
  await expect(currentSkills(f.db, tampered)).rejects.toThrow('快照校验失败');
  await expect(currentSkills(f.db, { skillIds: [first.id] })).rejects.toThrow('快照不完整');
  expect(await currentSkills(f.db, {})).toEqual([]);
});
