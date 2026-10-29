import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup, legacyAgent, legacyDefaultConfig } from './helpers';
import { AssetService } from '../packages/ai/src/assets';
import type { ScopedAssetContext } from '../packages/extension-sdk/src/index';
import { normalizePddMessage } from '../packages/platforms/src/index';
import { apiInputs, agentConfigSchema } from '../packages/contracts/src/index';
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
describe('Toolkit / Workflow 接口', () => {
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
  it('普通 Workflow 成员正常运行，旧入口不再可执行或显示', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    expect(
      await assets.runWorkflow(
        'builtin/reply-helpers@1.0.0',
        'normalize',
        { text: '  hello  ' },
        context,
        new Set(),
        async () => {},
      ),
    ).toEqual({ text: 'hello' });
    await expect(
      assets.runWorkflow(
        'builtin/reply-helpers@1.0.0',
        'reply',
        { text: 'hello' },
        context,
        new Set(),
        async () => {},
      ),
    ).rejects.toThrow('旧版回复策略入口已停用');
    const list = await assets.list();
    expect(
      list.assets
        .find((a) => a.id === 'builtin/reply-helpers@1.0.0')
        ?.manifest.members.map((m) => m.id),
    ).toEqual(['normalize']);
  });
  it('升级不改写旧版普通 Workflow 的发布哈希和 Agent 挂载', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    const definition = await f.engine.agents.save({
      config: agentConfigSchema.parse({
        name: '有 Workflow 的 Agent',
        prompt: '使用文本整理流程',
        modelProfileId: f.model.id,
        workflowIds: ['builtin/reply-helpers@1.0.0'],
      }),
    });
    const revision = await f.engine.agents.publish(definition.id, definition.draftRevision);
    const original = await f.db.installedExtension.findUniqueOrThrow({
      where: { id: 'builtin/reply-helpers@1.0.0' },
    });
    await assets.initialize();
    await expect(f.engine.agents.validateTree(revision.id)).resolves.toBeUndefined();
    const saved = await f.db.installedExtension.findUniqueOrThrow({ where: { id: original.id } });
    expect(saved.artifactHash).toBe(original.artifactHash);
    expect(saved.manifest).toEqual(original.manifest);
    expect((await assets.module(original.id)).manifest).toEqual(original.manifest);
  });
  it('新安装的扩展不能继续注册独立回复策略入口', async () => {
    f = await setup();
    assets = new AssetService(f.db, f.dir);
    const legacy = await assets.module('builtin/reply-helpers@1.0.0');
    const manifest = { ...legacy.manifest, assetId: 'local/legacy-entry' };
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    zip.addFile('index.mjs', Buffer.from('export default {};'));
    const file = join(f.dir, 'legacy-entry.zip');
    await writeFile(file, zip.toBuffer());
    await expect(assets.install(file)).rejects.toThrow('回复策略入口已停用');
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
