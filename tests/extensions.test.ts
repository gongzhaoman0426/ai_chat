import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup, legacyAgent, legacyDefaultConfig } from './helpers';
import { AssetService } from '../packages/ai/src/assets';
import type { ScopedAssetContext } from '../packages/extension-sdk/src/index';
import { normalizePddMessage } from '../packages/platforms/src/index';
import { apiInputs, agentConfigSchema } from '../packages/contracts/src/index';
import { defaultConfig } from '../packages/agent-config/src/index';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let assets: AssetService | undefined;
afterEach(async () => {
  assets?.close();
  await f?.cleanup();
  assets = undefined;
  f = undefined;
});
const context: ScopedAssetContext = {
  role: 'debug',
  storeId: 'debug',
  accountId: 'debug',
  conversationId: 'debug',
  runId: 'debug-run',
  signal: new AbortController().signal,
  settings: {},
  knowledge: { search: async () => [] },
  platform: { query: async () => ({ fixture: true }) },
  agents: {
    runSub: async () => ({}),
  },
  logger: { info: () => {} },
};
describe('Toolkit 接口', () => {
  it('集合展开多个成员，原生工具校验输入和输出', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    const tools = await assets.tools('builtin/utilities@1.0.0', context, new Set(), async () => {});
    expect(Object.keys(tools)).toHaveLength(2);
    const calculator = tools[assets.alias('builtin/utilities/calculate')] as any;
    expect(await calculator.execute({ a: 12, b: 4, operation: 'divide' }, {})).toEqual({
      result: 3,
    });
    expect(await calculator.execute({ a: 'twelve', b: 4, operation: 'divide' }, {})).toMatchObject({
      error: true,
    });
  });
  it('Workflow 已移除：旧助手配置仍可读取和发布，已安装的流程不再列出', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    const legacy = { ...defaultConfig(f.model.id), workflowIds: ['builtin/reply-helpers@1.0.0'] };
    expect(agentConfigSchema.parse(legacy)).not.toHaveProperty('workflowIds');
    // Older builds registered a built-in Workflow package and published Agents that mount it.
    const manifest = {
      apiVersion: 1,
      assetId: 'builtin/reply-helpers',
      version: '1.0.0',
      kind: 'workflow',
      name: '客服处理流程',
      description: 'legacy',
      settingsFields: [],
      members: [],
    };
    await f.db.installedExtension.create({
      data: {
        id: 'builtin/reply-helpers@1.0.0',
        assetId: 'builtin/reply-helpers',
        version: '1.0.0',
        artifactHash: 'legacy',
        manifest,
        relativePath: 'builtin',
      },
    });
    const { definition, revision } = await legacyAgent(f, legacy as any);
    await expect(f.engine.agents.validateTree(revision.id)).resolves.toBeUndefined();
    expect((await assets.list()).assets.map((a) => a.manifest.kind)).not.toContain('workflow');
    const draft = await f.db.agentDefinition.findUniqueOrThrow({ where: { id: definition.id } });
    const republished = await f.engine.agents.publish(definition.id, draft.draftRevision);
    expect(republished.configSnapshot).not.toHaveProperty('workflowIds');
  });
  it('Workflow 扩展包和回复策略入口都不能安装', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    const install = async (name: string, manifest: Record<string, unknown>) => {
      const zip = new AdmZip();
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
      zip.addFile('index.mjs', Buffer.from('export default {};'));
      const file = join(f!.dir, `${name}.zip`);
      await writeFile(file, zip.toBuffer());
      return assets!.install(file);
    };
    const base = {
      apiVersion: 1,
      version: '1.0.0',
      name: 'x',
      description: 'x',
      settingsFields: [],
      members: [
        {
          id: 'reply',
          name: 'reply',
          description: 'reply',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        },
      ],
    };
    await expect(
      install('workflow', { ...base, assetId: 'local/flow', kind: 'workflow' }),
    ).rejects.toThrow('Workflow 已停用，只能安装 Toolkit 扩展包');
    await expect(
      install('entry', {
        ...base,
        assetId: 'local/legacy-entry',
        kind: 'toolkit',
        members: [{ ...base.members[0], contract: 'reply.v1' }],
      }),
    ).rejects.toThrow('回复策略入口已停用');
  });
  it('账号能力不足时平台工具不进入挂载列表', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    await legacyAgent(f, legacyDefaultConfig(f.model.id, '1.0.0'));
    expect(
      Object.keys(await assets.tools('builtin/pdd@1.0.0', context, new Set(), async () => {})),
    ).toHaveLength(0);
    expect(
      Object.keys(
        await assets.tools('builtin/pdd@1.0.0', context, new Set(['history']), async () => {}),
      ),
    ).toHaveLength(1);
  });
  it('本地扩展代码哈希被篡改后拒绝加载', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    const manifest = {
      apiVersion: 1,
      assetId: 'local/test',
      version: '1.0.0',
      kind: 'toolkit',
      name: 'test',
      description: 'test',
      settingsFields: [],
      members: [
        {
          id: 'hello',
          name: 'hello',
          description: 'hello',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          requiresCapabilities: [],
        },
      ],
    };
    const code = `export default {manifest:${JSON.stringify(manifest)},createTools:()=>({'local/test/hello':{id:'local/test/hello',execute:async()=>({ok:true})}})}`;
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    zip.addFile('index.mjs', Buffer.from(code));
    const file = join(f.dir, 'extension.zip');
    await writeFile(file, zip.toBuffer());
    const installed = await assets.install(file);
    const tools = await assets.tools(installed.id, context, new Set(), async () => {});
    expect(Object.keys(tools)).toHaveLength(1);
    await writeFile(join(f.dir, installed.relativePath, 'index.mjs'), code + '\n// mutation');
    await expect(assets.module(installed.id)).rejects.toThrow('哈希');
  });
  it('工作绑定只接受 Agent 版本，不接受学习角色或回复策略入口', () => {
    expect(
      apiInputs['agents.bind'].safeParse({
        scopeKey: 'global',
        revisionId: 'x',
        expectedRevision: null,
        role: 'learning',
      }).success,
    ).toBe(false);
    expect(
      apiInputs['agents.bind'].safeParse({
        scopeKey: 'global',
        revisionId: 'x',
        expectedRevision: null,
        entryWorkflowRef: 'old#reply',
      }).success,
    ).toBe(false);
    expect(agentConfigSchema.safeParse({ name: 'x', prompt: 'x', role: 'learning' }).success).toBe(
      false,
    );
  });
});
describe('拼多多消息规范化', () => {
  it('保留平台消息 ID 与买家方向', () => {
    const raw = {
      msg_id: '12345678901234567890',
      type: 0,
      content: '你好',
      ts: '1788771600',
      from: { uid: '100', role: 'user', name: '买家' },
      to: { uid: '200', role: 'mall_cs' },
    };
    const normalized = normalizePddMessage('account', raw);
    expect(normalized?.externalId).toBe(raw.msg_id);
    expect(normalized?.direction).toBe('in');
    expect(normalized?.origin).toBe('buyer');
  });
  it('原平台人工回答、图片与系统消息分别处理', () => {
    const raw = {
      msg_id: '1',
      type: 1,
      content: 'https://example.com/image.jpg',
      ts: 1788771600000,
      from: { uid: '200', role: 'mall_cs' },
      to: { uid: '100', role: 'user' },
    };
    expect(normalizePddMessage('a', raw)).toMatchObject({
      direction: 'out',
      origin: 'human',
      kind: 'image',
    });
    expect(normalizePddMessage('a', { ...raw, type: 31 })).toBeNull();
  });
  it('拒绝不安全整数 ID、缺失稳定 ID 和未知来源', () => {
    const raw = {
      msg_id: 9007199254740992,
      type: 0,
      content: 'a',
      ts: '1788771600',
      from: { uid: '100', role: 'user' },
      to: { uid: '200', role: 'mall_cs' },
    };
    expect(normalizePddMessage('a', raw)).toBeNull();
    expect(normalizePddMessage('a', {})).toBeNull();
  });
});
