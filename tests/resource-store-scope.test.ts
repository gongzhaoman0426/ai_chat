import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup } from './helpers';
import { MastraAi } from '../packages/ai/src';
import { AssetService } from '../packages/ai/src/assets';
import { SkillService } from '../packages/agent-config/src/skills';
import { defaultConfig, type PublishedConfig } from '../packages/agent-config/src';
import {
  getResourceScope,
  saveResourceScope,
  resourceAllowed,
} from '../packages/agent-config/src/resource-scope';
import { Router } from '../packages/core/src/router';
import type { ResourceKind } from '../packages/contracts/src/resource-scope';
import type { ScopedAssetContext } from '../packages/extension-sdk/src';
import { uid } from '../packages/core/src/util';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let server: Server | undefined;
afterEach(async () => {
  await ai?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await f?.cleanup();
  f = undefined;
  ai = undefined;
  server = undefined;
});
async function fixture() {
  f = await setup();
  const other = await f.engine.registerAccount({
    platform: 'douyin',
    mallId: 'mall-a',
    mallName: '另一家抖店',
    externalId: 'other',
    name: '抖店客服',
    partition: 'persist:scope-other',
    capabilities: f.account.capabilities as any,
  });
  await f.db.appSetting.upsert({
    where: { key: 'developerModeEnabled' },
    create: { key: 'developerModeEnabled', value: true },
    update: { value: true },
  });
  const scope = async (kind: ResourceKind, id: string, storeIds: string[] | 'all') => {
    const old = await getResourceScope(f!.db, kind, id);
    return f!.db.$transaction((tx) =>
      saveResourceScope(tx, {
        kind,
        resourceId: id,
        expectedRevision: old.revision,
        mode: storeIds === 'all' ? 'all' : 'selected',
        storeIds: storeIds === 'all' ? [] : storeIds,
      }),
    );
  };
  return { ...f, other, scope };
}
it('四种资源的本地范围独立于内容版本，冲突/已移除店铺/空范围不会放大授权', async () => {
  const t = await fixture();
  const agent = await t.engine.agents.save({ config: defaultConfig(t.model.id) });
  const skill = await new SkillService(t.db).save({
    config: {
      name: 'only-shop-a',
      description: 'A 店规则',
      instructions: 'A_ONLY',
      references: {},
      scripts: {},
    },
  });
  const ids: [ResourceKind, string][] = [
    ['agent', agent.id],
    ['skill', skill.id],
    ['toolkit', 'builtin/commerce@1.0.0'],
    ['workflow', 'builtin/reply-helpers@1.0.0'],
  ];
  for (const [kind, id] of ids) {
    await t.scope(kind, id, [t.account.storeId]);
    expect(await resourceAllowed(t.db, kind, id, t.account.storeId)).toBe(true);
    expect(await resourceAllowed(t.db, kind, id, t.other.storeId)).toBe(false);
  }
  expect(await resourceAllowed(t.db, 'toolkit', 'builtin/commerce@9.0.0', t.other.storeId)).toBe(
    false,
  );
  expect(await resourceAllowed(t.db, 'toolkit', 'builtin/pdd@2.0.0', t.other.storeId)).toBe(false);
  const revision = await t.engine.agents.publish(agent.id, agent.draftRevision);
  await expect(
    t.engine.agents.bind({
      scopeKey: `store:${t.other.storeId}`,
      revisionId: revision.id,
      expectedRevision: null,
    }),
  ).rejects.toThrow('未授权');
  await expect(
    t.engine.agents.bind({
      scopeKey: 'global',
      revisionId: revision.id,
      expectedRevision: (
        await t.db.agentBinding.findUniqueOrThrow({ where: { scopeKey: 'global' } })
      ).revision,
    }),
  ).rejects.toThrow('全部店铺');
  await t.engine.agents.bind({
    scopeKey: `store:${t.account.storeId}`,
    revisionId: revision.id,
    expectedRevision: null,
  });
  await t.scope('agent', agent.id, []);
  await expect(t.engine.agents.resolve(t.account.storeId)).rejects.toThrow('未授权');
  const old = await getResourceScope(t.db, 'skill', skill.id);
  await t.scope('skill', skill.id, 'all');
  await expect(
    t.db.$transaction((tx) =>
      saveResourceScope(tx, {
        kind: 'skill',
        resourceId: skill.id,
        expectedRevision: old.revision,
        mode: 'selected',
        storeIds: [],
      }),
    ),
  ).rejects.toThrow('已变化');
  await t.engine.removeAccount(t.other.id);
  await expect(t.scope('skill', skill.id, [t.other.storeId])).rejects.toThrow('已移除');
  const changed = vi.fn();
  t.engine.onChanged = changed;
  const router = new Router(t.engine, {} as MastraAi);
  await router.call('resources.scopes');
  expect(changed).not.toHaveBeenCalled();
});
it('已装配的 Toolkit 和 Workflow 在解除授权后也会被拦截', async () => {
  const t = await fixture();
  const assets = new AssetService(t.db, t.dir);
  const ctx: ScopedAssetContext = {
    role: 'reply',
    storeId: t.account.storeId,
    accountId: t.account.id,
    conversationId: 'fixture',
    runId: 'fixture',
    signal: new AbortController().signal,
    settings: {},
    knowledge: { search: async () => [] },
    platform: { id: 'pinduoduo', query: async () => ({}) },
    agents: { runSub: async () => ({}) },
    logger: { info: () => {} },
  };
  const tools = await assets.tools('builtin/utilities@1.0.0', ctx, new Set(), async () => {});
  const calculator = tools[assets.alias('builtin/utilities/calculate')] as any;
  await t.scope('toolkit', 'builtin/utilities@1.0.0', [t.other.storeId]);
  const result = await calculator
    .execute({ operation: 'add', a: 1, b: 2 }, {})
    .catch((error: Error) => ({ error: error.message }));
  expect(JSON.stringify(result)).toContain('未授权');
  expect(await assets.tools('builtin/utilities@1.0.0', ctx, new Set(), async () => {})).toEqual({});
  await t.scope('workflow', 'builtin/reply-helpers@1.0.0', [t.other.storeId]);
  await expect(
    assets.runWorkflow(
      'builtin/reply-helpers@1.0.0',
      'normalize',
      { text: 'x' },
      ctx,
      new Set(),
      async () => {},
    ),
  ).rejects.toThrow('未授权');
  assets.close();
});
async function model(t: Awaited<ReturnType<typeof fixture>>, answer: (body: any) => Promise<any>) {
  const requests: any[] = [];
  const errors: unknown[] = [];
  server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
      const message = { role: 'assistant', ...(await answer(body)) };
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              model: 'fixture',
              choices: [{ index: 0, delta: message, finish_reason: null }],
            }) +
            '\n\n',
        );
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              model: 'fixture',
              choices: [{ index: 0, delta: {}, finish_reason: finish }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }) +
            '\n\n',
        );
        res.end('data: [DONE]\n\n');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion',
            model: 'fixture',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      }
    } catch (e) {
      errors.push(e);
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  await t.db.modelProfile.update({
    where: { id: t.model.id },
    data: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      provider: 'openai',
      model: 'fixture',
    },
  });
  ai = new MastraAi(t.db, t.dir, t.host);
  await ai.initialize();
  const call = async (
    account: typeof t.account,
    revision: { id: string; configSnapshot: unknown },
  ) => {
    const msg = await t.engine.ingest(
      t.inbound('你好', {
        accountId: account.id,
        conversationKey: `conv-${account.id}`,
        platformContext: account.id === t.other.id ? { userId: 'buyer-a' } : undefined,
      }),
    );
    const store = await t.db.store.findUniqueOrThrow({ where: { id: account.storeId } });
    return ai!.reply({
      storeId: account.storeId,
      accountId: account.id,
      conversationId: msg.conversationId,
      buyerId: 'buyer-a',
      runId: uid(),
      configEpoch: store.replyConfigEpoch,
      question: '你好',
      messages: [],
      matches: [],
      config: revision.configSnapshot as PublishedConfig,
      revisionId: revision.id,
      capabilities: account.capabilities as any,
      signal: new AbortController().signal,
      guard: async () => {},
    });
  };
  return { requests, errors, call };
}
it('真实 Mastra 共享 Agent 按店过滤 Skill 内容/脚本、Toolkit、Workflow、子 Agent，平台路由保留且每店只请求一次模型', async () => {
  const t = await fixture();
  const m = await model(t, async () => ({ content: '您好，请问有什么可以帮您？' }));
  const skill = await new SkillService(t.db).save({
    config: {
      name: 'secret-shop-a',
      description: 'ONLY_A_SKILL_DESCRIPTION',
      instructions: 'ONLY_A_INSTRUCTIONS',
      references: { 'references/a.md': 'ONLY_A_REFERENCE' },
      scripts: { 'scripts/a.ts': "console.log('ONLY_A_SCRIPT')" },
    },
  });
  const child = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), name: '仅 A 子助手' },
  });
  const childRev = await t.engine.agents.publish(child.id, child.draftRevision);
  await t.scope('skill', skill.id, [t.account.storeId]);
  await t.scope('toolkit', 'builtin/utilities@1.0.0', [t.account.storeId]);
  await t.scope('workflow', 'builtin/reply-helpers@1.0.0', [t.account.storeId]);
  await t.scope('agent', child.id, [t.account.storeId]);
  const parent = await t.engine.agents.save({
    config: {
      ...defaultConfig(t.model.id),
      skillIds: [skill.id],
      workflowIds: ['builtin/reply-helpers@1.0.0'],
      subAgents: [{ alias: 'only_a', revisionId: childRev.id }],
    },
  });
  const rev = await t.engine.agents.publish(parent.id, parent.draftRevision);
  await new SkillService(t.db).save({
    id: skill.id,
    expectedRevision: skill.revision,
    config: {
      name: skill.name,
      description: 'ONLY_A_UPDATED_SKILL_DESCRIPTION',
      instructions: 'ONLY_A_UPDATED_INSTRUCTIONS',
      references: { 'references/a.md': 'ONLY_A_UPDATED_REFERENCE' },
      scripts: { 'scripts/a.ts': "console.log('ONLY_A_UPDATED_SCRIPT')" },
    },
  });
  await m.call(t.account, rev);
  await m.call(t.other, rev);
  expect(m.errors).toEqual([]);
  expect(m.requests).toHaveLength(2);
  const names = (body: any) => body.tools.map((t: any) => t.function.name);
  for (const name of [
    'runSkillScript',
    'delegate_only_a',
    ai!.assets.alias('builtin/utilities/calculate'),
    ai!.assets.alias('builtin/reply-helpers@1.0.0/normalize'),
  ]) {
    expect(names(m.requests[0])).toContain(name);
    expect(names(m.requests[1])).not.toContain(name);
  }
  expect(JSON.stringify(m.requests[0])).toContain('ONLY_A_UPDATED_SKILL_DESCRIPTION');
  expect(JSON.stringify(m.requests[0])).not.toContain('ONLY_A_SKILL_DESCRIPTION');
  expect(JSON.stringify(m.requests[1])).not.toContain('ONLY_A_');
  for (const request of m.requests)
    expect(names(request)).toContain(ai!.assets.alias('builtin/commerce/goods'));
  expect(names(m.requests[1])).not.toContain(ai!.assets.alias('builtin/commerce/goods-skus'));
});
it('模型请求期间撤销 Skill 授权，已发布脚本也不能执行，不补发模型请求', async () => {
  const t = await fixture();
  const skill = await new SkillService(t.db).save({
    config: {
      name: 'revoked-skill',
      description: '可执行脚本',
      instructions: '运行脚本',
      scripts: { 'scripts/test.ts': "console.log('should not run')" },
      references: {},
    },
  });
  const m = await model(t, async () => {
    await t.scope('skill', skill.id, []);
    return {
      content: '',
      tool_calls: [
        {
          index: 0,
          id: 'call1',
          type: 'function',
          function: {
            name: 'runSkillScript',
            arguments: JSON.stringify({ skillName: skill.name, path: 'scripts/test.ts' }),
          },
        },
      ],
    };
  });
  const execute = vi.spyOn(ai!.scripts, 'run');
  const a = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), skillIds: [skill.id] },
  });
  const rev = await t.engine.agents.publish(a.id, a.draftRevision);
  await expect(m.call(t.account, rev)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  expect(m.requests).toHaveLength(1);
  expect(m.errors).toEqual([]);
});
