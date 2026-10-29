import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup } from './helpers';
import { agentConfigSchema, apiInputs, skillInputSchema } from '../packages/contracts/src/index';
import {
  SkillService,
  exportSkill,
  importSkill,
  publishedSkills,
} from '../packages/agent-config/src/skills';
import type { PublishedConfig } from '../packages/agent-config/src/index';
import { MastraAi } from '../packages/ai/src/index';
import { Router } from '../packages/core/src/router';
import { AssetService } from '../packages/ai/src/assets';

let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let server: Server | undefined;
afterEach(async () => {
  await ai?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await f?.cleanup();
  f = undefined;
  ai = undefined;
  server = undefined;
});
const guide = skillInputSchema.parse({
  name: 'after-sales',
  description: '退款场景下的专用处理方法',
  instructions: 'SKILL_PRIVATE_BODY：核实状态后，读取 references/guide.md。',
  references: {
    'references/guide.md': 'REF_PRIVATE_CONTENT：确认退款方案。',
    'references/nested/example.md': '嵌套参考资料',
  },
});
const newConfig = (ids: string[]) =>
  agentConfigSchema.parse({
    name: '技能助手',
    prompt: '按照已挂载技能回答。',
    modelProfileId: f!.model.id,
    skillIds: ids,
  });

it('编辑或删除技能不改变已发布快照和绑定；草稿读最新内容，缺失时阻止发布', async () => {
  f = await setup();
  const skills = new SkillService(f.db);
  const skill = await skills.save({ config: guide });
  const agent = await f.engine.agents.save({ config: newConfig([skill.id]) });
  const revision = await f.engine.agents.publish(agent.id, agent.draftRevision);
  const config = revision.configSnapshot as unknown as PublishedConfig;
  await f.engine.agents.bind({
    scopeKey: `store:${f.account.storeId}`,
    revisionId: revision.id,
    expectedRevision: null,
  });
  const beforeStore = await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } });
  const changed = await skills.save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: { ...guide, instructions: 'NEW_INSTRUCTIONS' },
  });
  expect((await skills.list())[0].mountedBy).toEqual([{ id: agent.id, name: agent.name }]);
  expect((await f.engine.agents.prepareDraft(agent.id)).skills?.[0].instructions).toBe(
    'NEW_INSTRUCTIONS',
  );
  expect(
    publishedSkills((await f.engine.agents.resolve(f.account.storeId))!.config)[0].instructions,
  ).toBe(guide.instructions);
  await expect(
    skills.save({ id: skill.id, expectedRevision: skill.revision, config: guide }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(skills.remove(skill.id, skill.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
  await skills.remove(skill.id, changed.revision);
  expect(await skills.list()).toHaveLength(0);
  await f.engine.agents.validateTree(revision.id);
  expect((await f.engine.agents.resolve(f.account.storeId))!.config).toEqual(config);
  expect(
    (await f.db.store.findUniqueOrThrow({ where: { id: f.account.storeId } })).replyConfigEpoch,
  ).toBe(beforeStore.replyConfigEpoch);
  await expect(f.engine.agents.prepareDraft(agent.id)).rejects.toThrow('Skill 已删除或缺失');
  await expect(f.engine.agents.publish(agent.id, agent.draftRevision)).rejects.toThrow(
    'Skill 已删除或缺失',
  );
  const restored = await f.engine.agents.restoreRevision(revision.id, agent.draftRevision);
  expect(restored.draftConfig).not.toHaveProperty('skills');
  expect(restored.draftConfig).toHaveProperty('skillIds', [skill.id]);
  const without = await f.engine.agents.save({
    id: agent.id,
    expectedRevision: restored.draftRevision,
    config: newConfig([]),
  });
  expect(
    (await f.engine.agents.publish(without.id, without.draftRevision)).configSnapshot,
  ).toHaveProperty('skills', []);
});

it('旧草稿补齐默认字段但不重写已发布版本；重复挂载、同名技能和损坏的副本不能执行', async () => {
  f = await setup();
  const skills = new SkillService(f.db);
  const a = await skills.save({ config: guide });
  const b = await skills.save({ config: guide });
  for (const ids of [[a.id, a.id], [a.id, b.id], ['missing']]) {
    const draft = await f.engine.agents.save({ config: newConfig(ids) });
    await expect(f.engine.agents.publish(draft.id, draft.draftRevision)).rejects.toThrow();
  }
  const draft = await f.engine.agents.save({ config: newConfig([]) });
  const revision = await f.engine.agents.publish(draft.id, draft.draftRevision);
  const old = JSON.parse(JSON.stringify(revision.configSnapshot));
  delete old.skills;
  delete old.skillIds;
  const oldDraft = JSON.parse(JSON.stringify(draft.draftConfig));
  delete oldDraft.skillIds;
  await f.db.agentDefinition.update({ where: { id: draft.id }, data: { draftConfig: oldDraft } });
  await f.db.agentRevision.update({ where: { id: revision.id }, data: { configSnapshot: old } });
  expect(
    (await f.engine.agents.list()).agents.find((a) => a.id === draft.id)!.draftConfig.skillIds,
  ).toEqual([]);
  await f.engine.agents.validateTree(revision.id);
  expect(
    (await f.db.agentRevision.findUniqueOrThrow({ where: { id: revision.id } })).configSnapshot,
  ).toEqual(old);
  expect(() => publishedSkills({ skillIds: [a.id] })).toThrow('快照不完整');
  const valid = await f.engine.agents.save({ config: newConfig([a.id]) });
  const snapshot = await f.engine.agents.prepareDraft(valid.id);
  snapshot.skills![0].instructions = 'tampered';
  expect(() => publishedSkills(snapshot)).toThrow('快照校验失败');
});

it('Skill ZIP / SKILL.md 导入预览、嵌套资料和导出往返；拒绝越界、二进制、歧义与超限输入', async () => {
  f = await setup();
  const file = join(f.dir, 'skill.zip');
  await writeFile(file, exportSkill(guide));
  expect(await importSkill(file)).toEqual(guide);
  const original = new AdmZip(await readFile(file));
  const wrapped = new AdmZip();
  for (const e of original.getEntries()) wrapped.addFile(`after-sales/${e.entryName}`, e.getData());
  await writeFile(file, wrapped.toBuffer());
  expect(await importSkill(file)).toEqual(guide);
  const markdown = join(f.dir, 'SKILL.md');
  await writeFile(markdown, original.getEntry('SKILL.md')!.getData());
  expect(await importSkill(markdown)).toEqual({ ...guide, references: {} });
  const invalid = [
    ['other/SKILL.md', '---\nname: second\ndescription: second\n---\ncontent'],
    ['outside.md', 'outside skill'],
    ['references/binary.md', Buffer.from([0, 0xff, 2])],
    ['references/large.md', 'x'.repeat(200001)],
    ['references/oversize.md', 'x'.repeat(5 * 1024 * 1024)],
  ] as const;
  for (const [name, value] of invalid) {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', original.getEntry('SKILL.md')!.getData());
    zip.addFile(name, Buffer.from(value));
    await writeFile(file, zip.toBuffer());
    await expect(importSkill(file)).rejects.toThrow();
  }
  // A forged zero uncompressed size must not bypass the inflater's output bound.
  const forged = new AdmZip();
  forged.addFile('SKILL.md', original.getEntry('SKILL.md')!.getData());
  forged.addFile('references/forged.md', Buffer.from('x'.repeat(100000)));
  const forgedBytes = forged.toBuffer();
  const filename = Buffer.from('references/forged.md');
  for (let i = 0; i < forgedBytes.length - 46; i++) {
    if (
      forgedBytes.readUInt32LE(i) === 0x02014b50 &&
      forgedBytes.subarray(i + 46, i + 46 + filename.length).equals(filename)
    )
      forgedBytes.writeUInt32LE(0, i + 24);
  }
  await writeFile(file, forgedBytes);
  await expect(importSkill(file)).rejects.toThrow();
  const emptyRef = { ...guide, references: { 'references/empty.md': '' } };
  await writeFile(file, exportSkill(emptyRef));
  expect(await importSkill(file)).toEqual(emptyRef);
  const symlink = new AdmZip();
  symlink.addFile('SKILL.md', original.getEntry('SKILL.md')!.getData());
  symlink.addFile('references/link.md', Buffer.from('target'), '', (0xa1ff << 16) >>> 0);
  // AdmZip uses platform mode bits supplied through attr on an entry.
  symlink.getEntry('references/link.md')!.attr = (0xa1ff << 16) >>> 0;
  await writeFile(file, symlink.toBuffer());
  await expect(importSkill(file)).rejects.toThrow('符号链接');
  for (const path of [
    '../escape',
    'references/../../escape',
    '/references/file',
    'references\\file',
    'references//file',
    'references/./file',
    'references/__proto__/x',
  ])
    expect(skillInputSchema.safeParse({ ...guide, references: { [path]: 'unsafe' } }).success).toBe(
      false,
    );
  await writeFile(markdown, '---\nname: first\nname: second\ndescription: test\n---\nbody');
  await expect(importSkill(markdown)).rejects.toThrow('YAML');
});

it('技能 API 受开发者模式控制，导入先预览不自动入库；扩展安装入口校验类型', async () => {
  f = await setup();
  const router = new Router(f.engine, {} as MastraAi);
  for (const method of [
    'skills.list',
    'skills.import',
    'skills.save',
    'skills.delete',
    'skills.export',
  ] as const)
    await expect(
      router.call(
        method,
        method === 'skills.save'
          ? { config: guide }
          : method === 'skills.delete'
            ? { id: 'x', expectedRevision: 1 }
            : method === 'skills.export'
              ? { id: 'x' }
              : {},
      ),
    ).rejects.toThrow();
  await f.db.appSetting.update({ where: { key: 'developerModeEnabled' }, data: { value: true } });
  const file = join(f.dir, 'skill.zip');
  await writeFile(file, exportSkill(guide));
  f.host.pickFile = async () => file;
  expect(await router.call('skills.import', {})).toEqual(guide);
  expect(await f.db.skillDefinition.count()).toBe(0);
  const row = (await router.call('skills.save', { config: guide })) as { id: string };
  expect(row.id).toBeTruthy();
  expect(apiInputs['assets.install'].parse({ kind: 'toolkit' })).toEqual({ kind: 'toolkit' });
  const manifest = {
    apiVersion: 1,
    assetId: 'local/type-check',
    version: '1.0.0',
    kind: 'workflow',
    name: '类型测试',
    description: '类型测试',
    settingsFields: [],
    members: [
      {
        id: 'normalize',
        name: '整理',
        description: '整理',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ],
  };
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.mjs', Buffer.from('export default {}'));
  const extension = join(f.dir, 'extension.zip');
  await writeFile(extension, zip.toBuffer());
  const assets = new AssetService(f.db, f.dir);
  try {
    await expect(assets.install(extension, 'toolkit')).rejects.toThrow('类型不匹配');
    expect(await f.db.installedExtension.count({ where: { id: 'local/type-check@1.0.0' } })).toBe(
      0,
    );
  } finally {
    assets.close();
  }
});

it('真实 Mastra 按需加载技能正文和 references；未挂载技能不泄露、无需额外格式化调用', async () => {
  f = await setup();
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const call = requests.length;
    const tool =
      call === 1
        ? { name: 'skill', arguments: JSON.stringify({ name: guide.name }) }
        : call === 2
          ? {
              name: 'skill_read',
              arguments: JSON.stringify({
                skillName: guide.name,
                path: 'references/nested/example.md',
              }),
            }
          : null;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: `chat-${call}`,
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            finish_reason: tool ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: tool ? null : '技能已指导完成回复',
              ...(tool
                ? { tool_calls: [{ id: `tool-${call}`, type: 'function', function: tool }] }
                : {}),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server');
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
  });
  const skills = new SkillService(f.db);
  const mounted = await skills.save({ config: guide });
  await skills.save({
    config: {
      ...guide,
      name: 'unmounted-private-skill',
      instructions: 'NEVER_EXPOSE',
      description: 'PRIVATE_DESCRIPTION',
    },
  });
  const agent = await f.engine.agents.save({ config: newConfig([mounted.id]) });
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  const result = await ai.debug(await f.engine.agents.prepareDraft(agent.id), '咨询售后流程');
  expect(result.result.text).toBe('技能已指导完成回复');
  expect(requests).toHaveLength(3);
  const first = JSON.stringify(requests[0]);
  expect(first).toContain(guide.name);
  expect(first).toContain(guide.description);
  expect(first).not.toContain('SKILL_PRIVATE_BODY');
  expect(first).not.toContain('REF_PRIVATE_CONTENT');
  expect(JSON.stringify(requests[1])).toContain('SKILL_PRIVATE_BODY');
  expect(JSON.stringify(requests[1])).toContain('references/nested/example.md');
  expect(JSON.stringify(requests[2])).toContain('嵌套参考资料');
  expect(JSON.stringify(requests)).not.toContain('NEVER_EXPOSE');
  expect(JSON.stringify(requests)).not.toContain('unmounted-private-skill');
  const names = requests[0].tools.map((t: any) => t.function.name);
  expect(names).toEqual(expect.arrayContaining(['skill', 'skill_read', 'skill_search']));
  expect(names.some((n: string) => /sandbox|filesystem|execute_command/.test(n))).toBe(false);
  expect(f.sends).toHaveLength(0);
  requests.length = 3;
  const plain = await f.engine.agents.save({ config: newConfig([]) });
  await ai.debug(await f.engine.agents.prepareDraft(plain.id), '无需技能');
  expect(requests).toHaveLength(4);
  expect(requests[3].tools.map((t: any) => t.function.name)).not.toContain('skill');
}, 30000);

it('父子 Agent 只接收各自发布的技能；子技能删除后仍使用冻结内容', async () => {
  f = await setup();
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const call = requests.length;
    const tool =
      call === 1
        ? { name: 'delegate_helper', arguments: JSON.stringify({ input: '处理当前问题' }) }
        : call === 2
          ? { name: 'skill', arguments: JSON.stringify({ name: 'child-method' }) }
          : null;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: `child-${call}`,
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            finish_reason: tool ? 'tool_calls' : 'stop',
            message: {
              role: 'assistant',
              content: tool ? null : '已核实处理方式',
              ...(tool
                ? { tool_calls: [{ id: `child-tool-${call}`, type: 'function', function: tool }] }
                : {}),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server');
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
  });
  const service = new SkillService(f.db);
  const parentSkill = await service.save({
    config: { ...guide, name: 'parent-method', description: 'PARENT_ONLY_METADATA' },
  });
  const childSkill = await service.save({
    config: {
      ...guide,
      name: 'child-method',
      description: 'CHILD_ONLY_METADATA',
      instructions: 'CHILD_FROZEN_BODY',
    },
  });
  const child = await f.engine.agents.save({
    config: { ...newConfig([childSkill.id]), name: '专业助手' },
  });
  const childRevision = await f.engine.agents.publish(child.id, child.draftRevision);
  await service.remove(childSkill.id, childSkill.revision);
  const parent = await f.engine.agents.save({
    config: {
      ...newConfig([parentSkill.id]),
      subAgents: [{ alias: 'helper', revisionId: childRevision.id }],
    },
  });
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  expect(
    (await ai.debug(await f.engine.agents.prepareDraft(parent.id), '处理当前问题')).result.text,
  ).toBe('已核实处理方式');
  expect(requests).toHaveLength(4);
  expect(JSON.stringify(requests[0])).toContain('PARENT_ONLY_METADATA');
  expect(JSON.stringify(requests[0])).not.toContain('CHILD_ONLY_METADATA');
  expect(JSON.stringify(requests[1])).toContain('CHILD_ONLY_METADATA');
  expect(JSON.stringify(requests[1])).not.toContain('PARENT_ONLY_METADATA');
  expect(JSON.stringify(requests[2])).toContain('CHILD_FROZEN_BODY');
  expect(JSON.stringify(requests[3])).not.toContain('CHILD_FROZEN_BODY');
}, 30000);
