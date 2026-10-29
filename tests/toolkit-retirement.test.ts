import { afterEach, expect, it } from 'vitest';
import { AssetService } from '../packages/ai/src/assets';
import { defaultConfig } from '../packages/agent-config/src';
import {
  COMMERCE_TOOLKIT_ID,
  RETIRED_PDD_TOOLKIT_IDS,
} from '../packages/contracts/src/toolkit-catalog';
import { json } from '../packages/database/src';
import { setup, legacyAgent, legacyDefaultConfig } from './helpers';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let assets: AssetService | undefined;
afterEach(async () => {
  assets?.close();
  await f?.cleanup();
  f = undefined;
  assets = undefined;
});

it('新安装只有通用和基础 Toolkit；旧数据目录也不展示 PDD 集合，旧挂载导入合并为通用工具', async () => {
  f = await setup();
  assets = new AssetService(f.db, f.dir);
  expect(await f.db.installedExtension.count({ where: { assetId: 'builtin/pdd' } })).toBe(0);
  expect(
    (await assets.list()).assets
      .filter((a) => (a.manifest as any).kind === 'toolkit')
      .map((a) => a.id)
      .sort(),
  ).toEqual([COMMERCE_TOOLKIT_ID, 'builtin/utilities@1.0.0']);
  const { revision } = await legacyAgent(f, legacyDefaultConfig(f.model.id, '1.0.0'));
  await assets.initialize();
  expect((await assets.list()).assets.some((a) => a.assetId === 'builtin/pdd')).toBe(false);
  await expect(f.engine.agents.validateTree(revision.id)).resolves.toBeUndefined();
  const saved = await f.engine.agents.save({
    config: {
      ...defaultConfig(f.model.id),
      toolkitIds: [...RETIRED_PDD_TOOLKIT_IDS, COMMERCE_TOOLKIT_ID, 'builtin/utilities@1.0.0'],
    },
  });
  expect((saved.draftConfig as any).toolkitIds).toEqual(['builtin/commerce', 'builtin/utilities']);
  const current = await f.engine.agents.publish(saved.id, saved.draftRevision);
  expect((current.configSnapshot as any).assetLock.map((a: any) => a.id).sort()).toEqual([
    COMMERCE_TOOLKIT_ID,
    'builtin/utilities@1.0.0',
  ]);
});

it('20 步的旧助手也迁移，保留模型快照和未发布草稿；更新子 Agent 链、绑定和关系索引，历史版本不变', async () => {
  f = await setup();
  const originalDefault = await f.db.agentDefinition.findFirstOrThrow({
    where: { origin: 'builtin_default' },
  });
  const child = await legacyAgent(f, {
    ...legacyDefaultConfig(f.model.id, '1.0.0'),
    name: '子助手',
    maxSteps: 20,
    prompt: '仅修改工具，不覆盖我的提示词。',
  });
  const previous = await legacyAgent(
    f,
    { ...legacyDefaultConfig(f.model.id, '2.0.0'), maxSteps: 20 },
    { id: originalDefault.id, expectedRevision: originalDefault.draftRevision },
  );
  const main = await legacyAgent(
    f,
    {
      ...legacyDefaultConfig(f.model.id, '1.0.0'),
      maxSteps: 20,
      prompt: '已发布的人设',
      subAgents: [{ alias: 'child', revisionId: child.revision.id }],
    },
    { id: originalDefault.id, expectedRevision: previous.definition.draftRevision },
  );
  const pendingDraft = {
    ...(main.definition.draftConfig as any),
    prompt: '尚未发布的新提示词',
    memory: { lastMessages: 3, workingMemory: false },
    toolkitIds: ['builtin/utilities@1.0.0', ...RETIRED_PDD_TOOLKIT_IDS, COMMERCE_TOOLKIT_ID],
  };
  await f.db.agentDefinition.update({
    where: { id: main.definition.id },
    data: { draftConfig: json(pendingDraft) },
  });
  await f.db.agentBinding.update({
    where: { scopeKey: 'global' },
    data: { agentRevisionId: main.revision.id },
  });
  await f.db.agentBinding.create({
    data: { scopeKey: `store:${f.account.storeId}`, agentRevisionId: previous.revision.id },
  });
  const inherited = await f.db.store.create({
    data: { platform: 'douyin', externalId: 'other-store', name: '继承全局的抖店' },
  });
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: { model: 'unpublished-model-change', maxTokens: 8192, revision: { increment: 1 } },
  });
  expect(await f.engine.agents.retirePddToolkits()).toEqual({ migratedRevisions: 2 });
  const working = await f.engine.agents.resolve(inherited.id);
  expect(working?.config).toMatchObject({
    toolkitIds: ['builtin/utilities@1.0.0', COMMERCE_TOOLKIT_ID],
    maxSteps: 20,
    prompt: '已发布的人设',
    memory: { lastMessages: 20 },
    modelSnapshot: f.model,
  });
  expect(working?.config.subAgents[0].revisionId).not.toBe(child.revision.id);
  const relation = await f.db.agentRevisionSubAgent.findFirstOrThrow({
    where: { parentRevisionId: working!.revision.id },
  });
  expect(relation.childRevisionId).toBe(working!.config.subAgents[0].revisionId);
  expect(
    (await f.db.agentRevision.findUniqueOrThrow({ where: { id: relation.childRevisionId } }))
      .configSnapshot,
  ).toMatchObject({
    toolkitIds: ['builtin/utilities@1.0.0', COMMERCE_TOOLKIT_ID],
    prompt: '仅修改工具，不覆盖我的提示词。',
    maxSteps: 20,
  });
  const updatedDraft = await f.db.agentDefinition.findUniqueOrThrow({
    where: { id: main.definition.id },
  });
  expect(updatedDraft.draftConfig).toMatchObject({
    prompt: pendingDraft.prompt,
    memory: pendingDraft.memory,
    maxSteps: 20,
    toolkitIds: ['builtin/utilities@1.0.0', COMMERCE_TOOLKIT_ID],
    subAgents: working!.config.subAgents,
  });
  expect(updatedDraft.draftRevision).toBe(main.definition.draftRevision + 1);
  for (const old of [child.revision, previous.revision, main.revision])
    expect(await f.db.agentRevision.findUnique({ where: { id: old.id } })).toEqual(old);
  expect((await f.engine.agents.resolve(f.account.storeId))?.revision.id).toBe(
    previous.revision.id,
  );
  expect(
    (await f.db.store.findUniqueOrThrow({ where: { id: inherited.id } })).replyConfigEpoch,
  ).toBe(inherited.replyConfigEpoch + 1);
  const count = await f.db.agentRevision.count();
  expect(await f.engine.agents.retirePddToolkits()).toEqual({ migratedRevisions: 0 });
  expect(await f.db.agentRevision.count()).toBe(count);
  expect(await f.db.auditEvent.count({ where: { type: 'agent.pdd_toolkits_retired' } })).toBe(2);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});
