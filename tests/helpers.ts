import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { openDatabase, json } from '../packages/database/src/index';
import { Engine } from '../packages/core/src/engine';
import { defaultConfig } from '../packages/agent-config/src';
import { AssetService } from '../packages/ai/src/assets';
import type { AiPort, AppHost, KnowledgeMatch, ReplyContext } from '../packages/core/src/types';
import type {
  IncomingMessage,
  LearningResult,
  ReplyResult,
  SendCommand,
  SendResult,
} from '../packages/contracts/src/index';
import { uid } from '../packages/core/src/util';
export class FakeAi implements AiPort {
  matches: KnowledgeMatch[] = [];
  replyCalls = 0;
  learnCalls = 0;
  learnInputs: any[] = [];
  beforeReply?: () => Promise<void>;
  beforeLearn?: () => Promise<void>;
  replyResult: ReplyResult = {
    action: 'reply',
    text: '根据已核实信息回复',
    evidenceIds: [],
    reasonCode: 'test',
  };
  result: LearningResult = {
    matchVerdict: 'not_applicable',
    replyVerdict: 'reasonable',
    reuseVerdict: 'not_reusable',
    reason: '测试评估',
    evidenceIds: [],
    suggestions: [],
  };
  async search() {
    return this.matches;
  }
  async index() {}
  async reply(ctx: ReplyContext) {
    this.replyCalls++;
    await this.beforeReply?.();
    return {
      result: this.replyResult,
      usage: { inputTokens: 10 },
      evidenceIds: [],
    };
  }
  async evaluate(input: unknown) {
    this.learnCalls++;
    this.learnInputs.push(input);
    await this.beforeLearn?.();
    return { result: this.result, usage: { inputTokens: 10 } };
  }
}
export async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'judesk-test-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'db'));
  const migrations = resolve('packages/database/prisma/migrations');
  const client = createClient({ url: pathToFileURL(join(dir, 'db', 'judesk.db')).href });
  for (const name of (await readdir(migrations)).sort()) {
    if (name.startsWith('20'))
      await client.executeMultiple(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
  }
  client.close();
  const db = await openDatabase(dir);
  const ai = new FakeAi();
  const sends: SendCommand[] = [];
  let response: SendResult | undefined;
  const host: AppHost = {
    send: async (c) => {
      sends.push(c);
      return response ?? { status: 'confirmed', externalId: `sent-${c.id}` };
    },
    query: async () => ({}),
    secretPut: async () => uid(),
    secretGet: async () => '',
    pickFile: async () => null,
    pickFiles: async () => [],
    saveFile: async () => null,
    validateImage: async () => ({ width: 1, height: 1, mime: 'image/png' }),
    connect: async () => ({}),
    disconnect: async () => {},
    forgetPartition: async () => {},
    verify: async () => ({}),
    maintenance: async () => {},
    stageRestore: async () => {},
  };
  await new AssetService(db, dir).initialize();
  const engine = new Engine(db, dir, host, ai);
  await engine.initialize();
  const account = await engine.registerAccount({
    partition: 'persist:test',
    mallId: 'mall-a',
    mallName: '测试店铺',
    externalId: 'cs-a',
    name: '客服 A',
    capabilities: {
      receive: true,
      sendText: true,
      sendImage: true,
      history: true,
      goods: true,
      orders: false,
      verified: true,
    },
  });
  await db.account.update({ where: { id: account.id }, data: { verifiedAt: new Date() } });
  const model = await db.modelProfile.create({
    data: { name: '测试模型', kind: 'chat', model: 'fixture', baseUrl: 'http://localhost:9999/v1' },
  });
  await db.appSetting.create({ data: { key: 'defaultModelId', value: model.id } });
  await engine.agents.setDefaultModel(model.id);
  const inbound = (
    text = '什么时候发货',
    extra: Partial<IncomingMessage> = {},
  ): IncomingMessage => ({
    accountId: account.id,
    externalId: uid(),
    eventKey: uid(),
    buyerId: 'buyer-a',
    buyerName: '小林',
    conversationKey: 'buyer:buyer-a',
    direction: 'in',
    origin: 'buyer',
    kind: 'text',
    text,
    timestamp: new Date().toISOString(),
    raw: {},
    ...extra,
  });
  return {
    dir,
    db,
    ai,
    host,
    sends,
    engine,
    account,
    model,
    inbound,
    setResponse: (r: SendResult) => {
      response = r;
    },
    cleanup: async () => {
      await engine.stop();
      await db.$disconnect();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
export async function waitFor(check: () => Promise<boolean>, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('condition timeout');
}
export async function flush(engine: Engine, db: Awaited<ReturnType<typeof openDatabase>>) {
  await db.job.updateMany({
    where: { status: { in: ['pending', 'retry_wait'] } },
    data: { runAfter: new Date(0) },
  });
  await engine.tick();
  await waitFor(async () => {
    await db.job.updateMany({ where: { status: 'pending' }, data: { runAfter: new Date(0) } });
    await engine.tick();
    return (await db.job.count({ where: { status: { in: ['pending', 'running'] } } })) === 0;
  });
}

// Seed an actual pre-retirement snapshot, bypassing today's import/save normalization.
export async function legacyAgent(
  f: Awaited<ReturnType<typeof setup>>,
  config: import('../packages/contracts/src').AgentConfig,
  target?: { id: string; expectedRevision: number },
) {
  const { legacyPddModules } = await import('../packages/ai/src/compatibility/pdd-toolkit');
  const { hash } = await import('../packages/core/src/util');
  for (const module of legacyPddModules) {
    const id = `${module.manifest.assetId}@${module.manifest.version}`;
    await f.db.installedExtension.upsert({
      where: { id },
      create: {
        id,
        assetId: module.manifest.assetId,
        version: module.manifest.version,
        artifactHash: hash(module.manifest),
        manifest: json(module.manifest),
        relativePath: 'builtin',
      },
      update: {},
    });
  }
  const definition = target
    ? await f.db.agentDefinition.update({
        where: { id: target.id },
        data: { name: config.name, draftConfig: json(config), draftRevision: { increment: 1 } },
      })
    : await f.db.agentDefinition.create({ data: { name: config.name, draftConfig: json(config) } });
  const previous = await f.db.agentRevision.findFirst({
    where: { agentId: definition.id },
    orderBy: { revision: 'desc' },
  });
  const assets = await f.db.installedExtension.findMany({
    where: { id: { in: config.toolkitIds } },
  });
  const snapshot = {
    ...config,
    skills: [],
    modelSnapshot: f.model,
    assetLock: assets.map((a) => ({ id: a.id, hash: a.artifactHash })),
  };
  const revision = await f.db.agentRevision.create({
    data: {
      agentId: definition.id,
      revision: (previous?.revision ?? 0) + 1,
      configSnapshot: json(snapshot),
      configHash: hash(snapshot),
    },
  });
  for (const child of config.subAgents)
    await f.db.agentRevisionSubAgent.create({
      data: {
        parentRevisionId: revision.id,
        alias: child.alias,
        childRevisionId: child.revisionId,
      },
    });
  return { definition, revision };
}
export function legacyDefaultConfig(modelId: string, version: string) {
  return {
    ...defaultConfig(modelId),
    toolkitIds: ['builtin/utilities@1.0.0', `builtin/pdd@${version}`],
  };
}
