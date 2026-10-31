import { resourceAllowed, assertResourceAllowed } from '../../agent-config/src/resource-scope';
import { currentToolkit, assetSettingsRows } from '../../agent-config/src/toolkit-resolution';
import { latestToolkits, toolkitIdentity } from '../../contracts/src/toolkit-catalog';
import { legacyCommerceToolkit } from './compatibility/commerce-toolkit-v1';
import { legacyCommerceV11Modules } from './compatibility/commerce-toolkit-v1.1';
import { legacyCommerceV111 } from './compatibility/commerce-toolkit-v1.1.1';
import { legacyCommerceV120 } from './compatibility/commerce-toolkit-v1.2.0';
import { legacyCommerceV121 } from './compatibility/commerce-toolkit-v1.2.1';
import { legacyCommerceV130 } from './compatibility/commerce-toolkit-v1.3.0';
import { commerceToolkit } from './commerce-toolkit';
import { supportsAsset, supportsMember } from './platform-scope';
import { legacyPddModules } from './compatibility/pdd-toolkit';
import { isRetiredToolkit } from '../../contracts/src/toolkit-catalog';
import { realpathSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTool } from '@mastra/core/tools';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import Ajv from 'ajv/dist/2020.js';
import AdmZip from 'adm-zip';
import type { PrismaClient } from '../../database/src/index';
import { json } from '../../database/src/index';
import {
  manifestSchema,
  type ExtensionModule,
  type ScopedAssetContext,
  type ExtensionManifest,
} from '../../extension-sdk/src/index';
import { errorText, assert, hash } from '../../core/src/util';
const jsSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>;
const settingsFields: ExtensionManifest['settingsFields'] = [];
const member = (
  id: string,
  name: string,
  input: z.ZodType,
  output: z.ZodType,
  requiresCapabilities: string[] = [],
) => ({
  id,
  name,
  description: name,
  inputSchema: jsSchema(input),
  outputSchema: jsSchema(output),
  requiresCapabilities,
});
const timeIn = z.object({ timezone: z.string().default('Asia/Shanghai') }),
  timeOut = z.object({ iso: z.string(), local: z.string() });
const calcIn = z.object({
    a: z.number(),
    b: z.number(),
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
  }),
  calcOut = z.object({ result: z.number() });
const builtinModules: ExtensionModule[] = [
  legacyCommerceToolkit,
  legacyCommerceV11Modules[0],
  legacyCommerceV111,
  legacyCommerceV120,
  legacyCommerceV121,
  legacyCommerceV130,
  commerceToolkit,
  {
    manifest: {
      apiVersion: 1,
      assetId: 'builtin/utilities',
      version: '1.0.0',
      kind: 'toolkit',
      name: '基础工具',
      description: '当前时间与准确的四则计算',
      settingsFields,
      members: [
        member('current-time', '当前时间', timeIn, timeOut),
        member('calculate', '四则计算', calcIn, calcOut),
      ],
    },
    createTools: () => ({
      'builtin/utilities/current-time': createTool({
        id: 'builtin/utilities/current-time',
        description: '查询当前日期时间',
        inputSchema: timeIn,
        outputSchema: timeOut,
        execute: async ({ timezone }) => ({
          iso: new Date().toISOString(),
          local: new Intl.DateTimeFormat('zh-CN', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(new Date()),
        }),
      }),
      'builtin/utilities/calculate': createTool({
        id: 'builtin/utilities/calculate',
        description: '准确计算',
        inputSchema: calcIn,
        outputSchema: calcOut,
        execute: async ({ a, b, operation }) => {
          assert(operation !== 'divide' || b !== 0, '除数不能是零');
          return {
            result:
              operation === 'add'
                ? a + b
                : operation === 'subtract'
                  ? a - b
                  : operation === 'multiply'
                    ? a * b
                    : a / b,
          };
        },
      }),
    }),
  },
];
export class AssetService {
  private ajv = new Ajv({ strict: false, allErrors: true }).addFormat(
    'date-time',
    (value: string) => z.iso.datetime({ offset: true }).safeParse(value).success,
  );
  private hook?: ReturnType<typeof registerHooks>;
  constructor(
    private db: PrismaClient,
    private dataDir: string,
  ) {
    const root = pathToFileURL(resolve(realpathSync(dataDir), 'extensions') + '/').href;
    const require = createRequire(import.meta.url);
    this.hook = registerHooks({
      resolve(specifier, context, next) {
        if (
          context.parentURL?.startsWith(root) &&
          /^(?:@mastra\/core(?:\/|$)|zod$)/.test(specifier)
        ) {
          return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
        }
        return next(specifier, context);
      },
    });
  }
  close() {
    this.hook?.deregister();
  }
  async initialize() {
    for (const m of builtinModules) {
      const id = `${m.manifest.assetId}@${m.manifest.version}`;
      await this.db.installedExtension.upsert({
        where: { id },
        create: {
          id,
          assetId: m.manifest.assetId,
          version: m.manifest.version,
          artifactHash: hash(m.manifest),
          manifest: json(m.manifest),
          relativePath: 'builtin',
        },
        update: {},
      });
    }
  }
  async list() {
    const installed = await this.db.installedExtension.findMany({ orderBy: { assetId: 'asc' } });
    const current = latestToolkits(installed).filter((a) => a.assetId !== 'builtin/pdd');
    // Installed Workflow packages from older builds stay on disk but are no longer offered.
    const visible = current;
    const settings = await this.db.assetSetting.findMany({
      orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
    });
    const seenSettings = new Set<string>();
    return {
      compatibilityAssets: [],
      // Project the current callable members without rewriting installed manifests or hashes.
      assets: visible.map((asset) => {
        const manifest = asset.manifest as unknown as ExtensionManifest;
        const members = manifest.members.filter((m) => m.contract !== 'reply.v1');
        return {
          ...asset,
          status: members.length ? asset.status : 'disabled',
          manifest: {
            ...manifest,
            members,
            description: !members.length
              ? '此旧版集合已无可调用成员，请更新扩展。'
              : manifest.description,
          },
        };
      }),
      settings: settings.flatMap((setting) => {
        const toolkit = current.find((a) => a.assetId === toolkitIdentity(setting.assetId));
        const assetId = toolkit?.id ?? setting.assetId;
        const key = `${assetId}:${setting.scopeKey}`;
        if (seenSettings.has(key) || isRetiredToolkit(setting.assetId)) return [];
        seenSettings.add(key);
        return [{ ...setting, assetId }];
      }),
    };
  }
  async module(id: string): Promise<ExtensionModule> {
    if (!id.includes('@')) id = (await currentToolkit(this.db, id)).id;
    const row = await this.db.installedExtension.findUniqueOrThrow({ where: { id } });
    assert(row.status === 'enabled', '资源已禁用');
    if (row.relativePath === 'builtin') {
      const m = [...builtinModules, ...legacyCommerceV11Modules, ...legacyPddModules].find(
        (m) =>
          `${m.manifest.assetId}@${m.manifest.version}` === id &&
          hash(m.manifest) === row.artifactHash,
      );
      assert(
        m && hash(row.manifest) === row.artifactHash,
        `内置资源与当前程序不一致：${row.assetId}。请更新并重启句达，无需重新绑定助手。`,
      );
      return m;
    }
    const root = resolve(this.dataDir, row.relativePath);
    assert(root.startsWith(resolve(this.dataDir, 'extensions') + '/'), '扩展目录越界');
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
    );
    const code = await readFile(join(root, 'index.mjs'), 'utf8');
    assert(hash({ manifest, code }) === row.artifactHash, '扩展产物哈希校验失败');
    const loaded = await import(/* @vite-ignore */ pathToFileURL(join(root, 'index.mjs')).href);
    const m = loaded.default as ExtensionModule;
    assert(hash(m.manifest) === hash(manifest), '工厂声明与静态 manifest 不一致');
    return m;
  }
  async settings(id: string, storeId: string) {
    const rows = await assetSettingsRows(this.db, id, storeId);
    const global = rows.find((r) => r.scopeKey === 'global');
    const store = rows.find((r) => r.scopeKey !== 'global');
    return { ...(global?.values as object), ...(store?.values as object) };
  }
  async tools(
    id: string,
    context: ScopedAssetContext,
    allowed: Set<string>,
    guard: () => Promise<void>,
  ): Promise<ToolsInput> {
    const m = await this.module(id);
    assert(m.createTools && m.manifest.kind === 'toolkit', '不是 Toolkit');
    if (!supportsAsset(m.manifest, context.platform.id)) return {};
    if (
      context.role !== 'debug' &&
      !(await resourceAllowed(this.db, 'toolkit', id, context.storeId))
    )
      return {};
    const tools = await m.createTools(context);
    this.validateKeys(m.manifest, tools);
    const result: ToolsInput = {};
    for (const member of m.manifest.members) {
      if (member.contract === 'reply.v1' || !supportsMember(m.manifest, member, context)) continue;
      if (!member.requiresCapabilities.every((c) => allowed.has(c))) continue;
      const full = `${m.manifest.assetId}/${member.id}`;
      const tool = tools[full];
      const platformQueryDescription =
        m.manifest.assetId === 'builtin/commerce' &&
        (member.id === 'goods' ||
          member.id === 'buyer-orders' ||
          (member.id === 'history' && context.platform.id === 'qianniu'));
      const checkIn = this.ajv.compile(member.inputSchema),
        checkOut = this.ajv.compile(member.outputSchema);
      result[this.alias(full)] = createTool({
        id: full,
        // These query descriptions vary by platform. Other members retain the
        // manifest's full instructions, especially the constraints on write actions.
        description:
          platformQueryDescription &&
          tool &&
          'description' in tool &&
          typeof tool.description === 'string'
            ? tool.description
            : member.description,
        inputSchema: z.unknown(),
        outputSchema: z.unknown(),
        execute: async (input, options) => {
          await guard();
          if (context.role !== 'debug')
            await assertResourceAllowed(this.db, 'toolkit', id, context.storeId);
          assert(checkIn(input), `工具输入不符合 schema：${member.name}`);
          assert(
            tool && 'execute' in tool && typeof tool.execute === 'function',
            '工具没有 execute',
          );
          const output = await (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(
            input,
            options,
          );
          if (context.role !== 'debug')
            await assertResourceAllowed(this.db, 'toolkit', id, context.storeId);
          assert(checkOut(output), '工具输出不符合 schema');
          return output;
        },
      });
      // Native tool input schema is retained for model tool descriptions.
      Object.assign(result[this.alias(full)], {
        inputSchema: 'inputSchema' in tool ? tool.inputSchema : z.unknown(),
      });
    }
    return result;
  }
  private validateKeys(manifest: ExtensionManifest, map: Record<string, unknown>) {
    const expected = manifest.members.map((m) => `${manifest.assetId}/${m.id}`).sort();
    const actual = Object.keys(map).sort();
    assert(JSON.stringify(expected) === JSON.stringify(actual), '工厂必须返回全部且仅声明的成员');
    assert(new Set(expected).size === expected.length, '成员 ID 重复');
  }
  alias(full: string) {
    return full.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40) + '_' + hash(full).slice(0, 8);
  }
  async install(file: string) {
    assert((await stat(file)).size <= 20 * 1024 * 1024, '扩展包不得超过 20 MB');
    const zip = new AdmZip(await readFile(file));
    const manifestEntry = zip.getEntry('manifest.json'),
      codeEntry = zip.getEntry('index.mjs');
    assert(manifestEntry && codeEntry, '扩展包必须包含 manifest.json 和编译后的 index.mjs');
    assert(
      zip.getEntries().every((e) => ['manifest.json', 'index.mjs'].includes(e.entryName)),
      '首版扩展包仅接受清单和自包含 JS 产物',
    );
    assert(
      manifestEntry.header.size < 256000 && codeEntry.header.size < 20 * 1024 * 1024,
      '扩展解压后超限',
    );
    const raw = JSON.parse(manifestEntry.getData().toString());
    assert(raw?.kind !== 'workflow', 'Workflow 已停用，只能安装 Toolkit 扩展包');
    const manifest = manifestSchema.parse(raw);
    assert(
      manifest.members.every((m) => m.contract !== 'reply.v1'),
      '回复策略入口已停用，请移除 reply.v1 成员',
    );
    assert(manifest.assetId.startsWith('local/'), '不能覆盖内置资源');
    const previousKind = await this.db.installedExtension.findFirst({
      where: { assetId: manifest.assetId },
    });
    assert(
      !previousKind || (previousKind.manifest as { kind: string }).kind === manifest.kind,
      '该资源 ID 已被停用的 Workflow 占用，请更换 assetId',
    );
    const code = codeEntry.getData().toString('utf8');
    const artifactHash = hash({ manifest, code });
    const id = `${manifest.assetId}@${manifest.version}`;
    const existing = await this.db.installedExtension.findUnique({ where: { id } });
    if (existing) {
      assert(existing.artifactHash === artifactHash, '相同版本不能替换代码，请递增版本');
      return existing;
    }
    const relativePath = `extensions/${manifest.assetId}/${manifest.version}/${artifactHash}`;
    const dir = join(this.dataDir, relativePath);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(dir, 'index.mjs'), code);
    return this.db.installedExtension.create({
      data: {
        id,
        assetId: manifest.assetId,
        version: manifest.version,
        artifactHash,
        manifest: json(manifest),
        relativePath,
      },
    });
  }
}
