import { currentToolkit, assetSettingsRows } from '../../agent-config/src/toolkit-resolution';
import { toolkitIdentity } from '../../contracts/src/toolkit-catalog';
import { workingConfiguration } from './working-configuration';
import { WorkbenchService } from './workbench';
import { saveResourceScope } from '../../agent-config/src/resource-scope';
import { runHistory, runDetail } from './runs';
import { pddFixtureQuery, pddFixtureAction } from '../../ai/src/platform-tools';
import { SkillService, importSkill } from '../../agent-config/src/skills';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, cp, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import AdmZip from 'adm-zip';
import { apiInputs, developerMethods, modelSchema, type Method } from '../../contracts/src/index';
import { platformsForRuntime } from '../../contracts/src/platform';
import { json } from '../../database/src/index';
import { Engine } from './engine';
import { receptionState } from './reception';
import { listStoreGoods } from './store-goods';
import { onboardingState } from './onboarding';
import { KnowledgeBootstrapService } from './knowledge-bootstrap';
import { isRetiredCloudModel } from './util';
import { MastraAi } from '../../ai/src/index';
import { assert, hash, uid } from './util';
import { manifestSchema, type ScopedAssetContext } from '../../extension-sdk/src/index';
export class Router {
  private maintenance = false;
  private workbench: WorkbenchService;
  private knowledgeBootstrap: KnowledgeBootstrapService;
  constructor(
    private engine: Engine,
    private ai: MastraAi,
    private appVersion = '0.1.0',
  ) {
    this.workbench = new WorkbenchService(engine);
    this.knowledgeBootstrap = new KnowledgeBootstrapService(engine, (model, sources, signal) =>
      this.ai.generateKnowledgeDrafts(model, sources, signal),
    );
  }
  async call(method: Method, raw: unknown = {}) {
    assert(!this.maintenance, '正在备份或恢复，请稍候');
    assert(method in apiInputs, '未知业务方法');
    const input = apiInputs[method].parse(raw) as Record<string, any>;
    const { db, host } = this.engine;
    if (developerMethods.has(method))
      assert(
        (await db.appSetting.findUnique({ where: { key: 'developerModeEnabled' } }))?.value ===
          true,
        '请先开启开发者模式',
      );
    let result: unknown;
    switch (method) {
      case 'workbench.overview':
        return this.workbench.overview();
      case 'workbench.review':
        return this.workbench.review(input.actionId, input.note);
      case 'workbench.context':
        return this.workbench.context(input.conversationId);
      case 'workbench.query':
        return this.workbench.query(input.sessionId, input.operation, input.input);
      case 'workbench.action':
        return this.workbench.action(input as any);
      case 'workbench.records':
        return this.workbench.records(input.conversationId);
      case 'workbench.export': {
        const rows = await this.workbench.records(input.conversationId, true);
        const file = await host.saveFile('judesk-会话操作记录.csv');
        if (file) {
          const cell = (v: unknown) => {
            const text = String(v ?? '');
            return `"${(/^(?:[\t\r\n]|\s*[=+@-])/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
          };
          await writeFile(
            file,
            '\uFEFF' +
              [
                [
                  '时间',
                  '操作',
                  '来源',
                  '目标',
                  '状态',
                  '备注',
                  '结果',
                  '人工核对时间',
                  '核对说明',
                ],
                ...rows.map((r) => [
                  r.createdAt,
                  r.name,
                  r.origin,
                  r.targetId,
                  r.status,
                  r.note,
                  r.message,
                  r.reviewedAt,
                  r.reviewNote,
                ]),
              ]
                .map((row) => row.map(cell).join(','))
                .join('\r\n'),
          );
        }
        return { exported: !!file };
      }
      case 'app.state': {
        const settings = Object.fromEntries(
          (await db.appSetting.findMany()).map((r) => [r.key, r.value]),
        );
        const builtin = await db.agentDefinition.findFirst({
          where: { origin: 'builtin_default', status: 'active' },
        });
        result = {
          settings,
          hasDefaultAgent: !!builtin,
          version: this.appVersion,
          platforms: platformsForRuntime(process.platform),
          runtimePlatform: process.platform,
          dataDir: this.engine.dir,
        };
        break;
      }
      case 'app.settings': {
        for (const [key, value] of Object.entries(input)) {
          if ((key === 'embeddingProfileId' || key === 'defaultModelId') && value) {
            const m = await db.modelProfile.findUniqueOrThrow({ where: { id: String(value) } });
            assert(
              m.kind === (key === 'embeddingProfileId' ? 'embedding' : 'chat'),
              '模型类型不匹配',
            );
          }
          await db.appSetting.upsert({
            where: { key },
            create: { key, value: json(value) },
            update: { value: value === null ? (null as any) : json(value) },
          });
        }
        if (input.defaultModelId) await this.engine.agents.setDefaultModel(input.defaultModelId);
        if ('defaultModelId' in input || 'embeddingProfileId' in input)
          await db.store.updateMany({
            data: { replyConfigEpoch: { increment: 1 }, learningConfigEpoch: { increment: 1 } },
          });
        if ('embeddingProfileId' in input && input.embeddingProfileId) {
          await db.knowledgeIndexRecord.updateMany({ data: { status: 'pending' } });
          const entries = await db.knowledgeEntry.findMany({ where: { status: 'enabled' } });
          for (const e of entries)
            if (e.activeRevisionId)
              await db.job.upsert({
                where: { dedupKey: `index:${e.activeRevisionId}:${input.embeddingProfileId}` },
                create: {
                  kind: 'index',
                  storeId: e.storeId,
                  dedupKey: `index:${e.activeRevisionId}:${input.embeddingProfileId}`,
                  priority: 80,
                  payload: { revisionId: e.activeRevisionId },
                },
                update: { status: 'pending', attempts: 0, runAfter: new Date() },
              });
        }
        result = { ok: true };
        break;
      }
      case 'onboarding.state':
        result = await onboardingState(this.engine, input.storeId);
        break;
      case 'onboarding.configure':
        result = await this.engine.lock.run(() =>
          this.engine.agents.configureStarter(input as any),
        );
        break;
      case 'onboarding.enable':
        await this.engine.setPolicy({
          storeId: input.storeId,
          autoReplyEnabled: true,
          guidedConfigEpoch: input.expectedConfigEpoch,
        });
        result = { ok: true };
        break;
      case 'stores.goods':
        result = await listStoreGoods(this.engine, {
          storeId: input.storeId,
          page: input.page,
          pageSize: input.pageSize,
          keyword: input.keyword,
        });
        break;
      case 'stores.list': {
        const [stores, states] = await Promise.all([
          db.store.findMany({
            // Retained history is not a selectable shop. Offline accounts still qualify.
            where: { accounts: { some: {} } },
            include: { accounts: true, replyPolicy: true, learningPolicy: true },
            orderBy: { createdAt: 'asc' },
          }),
          db.appSetting.findMany({ where: { key: { startsWith: 'platform.connection:' } } }),
        ]);
        const connections = new Map(
          states.map((s) => [s.key.slice('platform.connection:'.length), s.value]),
        );
        result = stores.map((store) => ({
          ...store,
          accounts: store.accounts.map((account) => ({
            ...account,
            connection: connections.get(account.id) ?? null,
          })),
        }));
        break;
      }
      case 'stores.configuration':
        result = await this.engine.lock.run(() => workingConfiguration(this.engine, input.storeId));
        break;
      case 'stores.policy':
        await this.engine.setPolicy(input as any);
        result = { ok: true };
        break;
      case 'accounts.connect':
        result = await host.connect(input.accountId, input.platform);
        break;
      case 'accounts.verify':
        result = await this.engine.verifyAccount(input.accountId);
        break;
      case 'accounts.disconnect':
        await db.appSetting.upsert({
          where: { key: `platform.autoconnect:${input.accountId}` },
          create: { key: `platform.autoconnect:${input.accountId}`, value: false },
          update: { value: false },
        });
        await host.disconnect(input.accountId);
        await this.engine.markOffline(input.accountId);
        result = { ok: true };
        break;
      case 'accounts.remove':
        await this.engine.removeAccount(input.accountId);
        result = { ok: true };
        break;
      case 'conversations.get':
        return db.conversation.findFirst({
          where: { id: input.conversationId, store: { accounts: { some: {} } } },
          include: { store: { select: { id: true, name: true, platform: true } } },
        });
      case 'conversations.list': {
        const cursor = input.before;
        result = await db.conversation.findMany({
          where: {
            store: { accounts: { some: {} } },
            ...(input.storeId ? { storeId: input.storeId } : {}),
            AND: [
              ...(input.search
                ? [
                    {
                      OR: [
                        { buyerName: { contains: input.search } },
                        { preview: { contains: input.search } },
                      ],
                    },
                  ]
                : []),
              ...(input.filter === 'unread'
                ? [{ unread: { gt: 0 } }]
                : input.filter === 'handoff'
                  ? [{ OR: [{ awaitingHuman: true }, { openedByHuman: true }] }]
                  : input.filter === 'waiting'
                    ? [{ awaitingHuman: true, openedByHuman: false }]
                    : input.filter === 'human'
                      ? [{ openedByHuman: true }]
                      : []),
              ...(cursor
                ? [
                    {
                      OR: [
                        { updatedAt: { lt: new Date(cursor.updatedAt) } },
                        { updatedAt: new Date(cursor.updatedAt), id: { lt: cursor.id } },
                      ],
                    },
                  ]
                : []),
            ],
          },
          include: { store: { select: { id: true, name: true, platform: true } } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 200,
        });
        break;
      }
      case 'conversations.groups': {
        const groups = await db.messageGroup.findMany({
          where: { conversationId: input.conversationId },
          orderBy: { createdAt: 'desc' },
          take: 30,
        });
        result = await Promise.all(
          groups.map(async (g) => ({
            ...g,
            questions: await db.message.findMany({
              where: { id: { in: g.messageIds as string[] }, withdrawn: false },
              orderBy: { timestamp: 'asc' },
            }),
          })),
        );
        break;
      }
      case 'conversations.associate':
        await this.engine.associateManual(input.messageId, input.groupId);
        result = { ok: true };
        break;
      case 'conversations.messages': {
        const cursor = input.before
          ? await db.message.findUniqueOrThrow({ where: { id: input.before } })
          : null;
        if (cursor)
          assert(cursor.conversationId === input.conversationId, '分页游标不属于当前会话');
        result = (
          await db.message.findMany({
            where: {
              conversationId: input.conversationId,
              ...(cursor
                ? {
                    OR: [
                      { timestamp: { lt: cursor.timestamp } },
                      { timestamp: cursor.timestamp, id: { lt: cursor.id } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
            take: 100,
          })
        ).reverse();
        break;
      }
      case 'conversations.open':
        await this.engine.setOpened(input.conversationId);
        result = { ok: true };
        break;
      case 'conversations.reception':
        await this.engine.setReception(input.conversationId, input.mode, input.expectedRevision);
        result = { ok: true };
        break;
      case 'conversations.handoff':
        await this.engine.handoff(input.conversationId, input.reason);
        result = { ok: true };
        break;
      case 'messages.send':
        result = input.attachmentId
          ? await this.engine.sendManual(input as any)
          : await this.engine.enqueueManualText(input as any);
        break;
      case 'conversations.outbounds':
        result = await db.outboundMessage.findMany({
          where: { conversationId: input.conversationId, origin: 'human' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        });
        break;
      case 'outbound.list':
        result = await db.outboundMessage.findMany({
          where: { storeId: input.storeId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        break;
      case 'outbound.reconcile': {
        const o = await db.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
        assert(o.status === 'unknown', '仅未知发送需要对账');
        const c = await db.conversation.findUniqueOrThrow({ where: { id: o.conversationId } });
        result = {
          status: 'unknown',
          history: await host.query(o.accountId, 'history', { buyerId: c.buyerId }),
          message: '请使用平台的确定消息 ID 核实结果，未查到不代表失败',
        };
        break;
      }
      case 'outbound.resolve': {
        await this.engine.completeSend(input.id, {
          status: 'confirmed',
          externalId: input.externalId,
        });
        await db.auditEvent.create({
          data: {
            type: 'outbound.manual_confirmation',
            scope: input.id,
            actor: 'local-user',
            details: json({ evidence: input.evidence, externalId: input.externalId }),
          },
        });
        result = { ok: true };
        break;
      }
      case 'outbound.acknowledge': {
        const row = await db.outboundMessage.findUniqueOrThrow({ where: { id: input.id } });
        assert(row.status === 'unknown', '仅「发送待确认」的消息可人工核对');
        if (input.outcome === 'delivered') {
          await this.engine.completeSend(input.id, {
            status: 'confirmed',
            externalId: row.externalId || `acked:${input.id}`,
          });
        } else {
          await this.engine.completeSend(input.id, {
            status: 'rejected',
            reason: input.note,
          });
        }
        await db.auditEvent.create({
          data: {
            type: 'outbound.manual_acknowledgement',
            scope: input.id,
            actor: 'local-user',
            details: json({ outcome: input.outcome, note: input.note }),
          },
        });
        result = { ok: true };
        break;
      }
      case 'knowledge.bootstrapState':
        return this.knowledgeBootstrap.state(input.storeId);
      case 'knowledge.bootstrapStart':
        return this.knowledgeBootstrap.start(input.storeId);
      case 'knowledge.bootstrapApply':
        result = await this.knowledgeBootstrap.apply(input.storeId, input.runId, input.rows);
        break;
      case 'knowledge.list':
        result = await this.engine.knowledge.list(input.storeId, input.search, input.scope);
        break;
      case 'knowledge.save':
        result = await this.engine.knowledge.save(input as any);
        break;
      case 'knowledge.status':
        result = await this.engine.knowledge.setStatus(
          input.id,
          input.status,
          input.expectedRevisionId,
        );
        break;
      case 'knowledge.history':
        result = await db.knowledgeRevision.findMany({
          where: { entryId: input.id },
          orderBy: { version: 'desc' },
        });
        break;
      case 'knowledge.delete':
        result = await this.engine.knowledge.remove(input.id, input.expectedRevisionId);
        break;
      case 'attachments.get': {
        const a = await db.attachment.findUniqueOrThrow({ where: { id: input.id } });
        result = { id: a.id, name: a.name, url: `judesk://attachment/${basename(a.relativePath)}` };
        break;
      }
      case 'attachments.pick':
        result = await this.engine.knowledge.pickImage(input.storeId);
        break;
      case 'attachments.pickMany':
        result = await this.engine.knowledge.pickImages(input.storeId);
        break;
      case 'knowledge.importPreview':
        result = await this.engine.knowledge.previewImport(input.storeId);
        break;
      case 'knowledge.importApply':
        result = await this.engine.knowledge.applyImport(input.token, input.rows);
        break;
      case 'knowledge.export':
        result = await this.engine.knowledge.export(input.storeId, input.scope);
        break;
      case 'knowledge.assist':
        result = await this.ai.assistKnowledge(this.engine, {
          storeId: input.storeId,
          scope: input.scope,
          text: input.text,
          attachmentIds: input.attachmentIds,
          history: input.history,
        });
        break;
      case 'learning.list':
        result = await db.knowledgeCandidate.findMany({
          where: {
            storeId: input.storeId,
            ...(input.status === 'all' ? {} : { status: input.status }),
          },
          include: { evaluation: true, reviews: true },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
        break;
      case 'learning.evaluations':
        result = await db.learningEvaluation.findMany({
          where: { storeId: input.storeId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        break;
      case 'learning.review':
        result = await this.engine.knowledge.review(input as any);
        break;
      case 'agents.list':
        result = await this.engine.agents.list();
        break;
      case 'agents.save':
        result = await this.engine.agents.save(input as any);
        break;
      case 'agents.publish':
        result = await this.engine.lock.run(() =>
          this.engine.agents.publish(input.id, input.expectedRevision),
        );
        break;
      case 'agents.delete':
        result = await this.engine.agents.remove(input.id);
        break;
      case 'agents.restoreDefault':
        result = await this.engine.agents.restoreDefault();
        break;
      case 'agents.restoreRevision':
        result = await this.engine.agents.restoreRevision(input.revisionId, input.expectedRevision);
        break;
      case 'agents.bind':
        result = await this.engine.lock.run(() => this.engine.agents.bind(input as any));
        break;
      case 'agents.debug': {
        result = await this.ai.debug(
          await this.engine.agents.prepareDraft(input.id),
          input.input,
          input.platform,
        );
        break;
      }
      case 'agents.export': {
        const a = await db.agentDefinition.findUniqueOrThrow({ where: { id: input.id } });
        const file = await host.saveFile('judesk-agent.json');
        if (file) {
          await writeFile(
            file,
            JSON.stringify({ formatVersion: 1, config: a.draftConfig }, null, 2),
          );
          result = { ok: true };
        } else result = null;
        break;
      }
      case 'skills.list':
        result = await new SkillService(db).list();
        break;
      case 'skills.save':
        result = await new SkillService(db).save(input as any);
        break;
      case 'skills.delete':
        result = await new SkillService(db).remove(input.id, input.expectedRevision);
        break;
      case 'skills.test':
        result = await this.ai.testSkillScript(input.runId, input.config, input.call);
        break;
      case 'skills.cancelTest':
        result = this.ai.scripts.cancel(`skill-test:${input.runId}`);
        break;
      case 'skills.import': {
        const file = await host.pickFile('skill');
        result = file ? await importSkill(file) : null;
        break;
      }
      case 'skills.export': {
        const skill = await new SkillService(db).export(input.id);
        const file = await host.saveFile(`${skill.name}.zip`);
        if (file) await writeFile(file, skill.bytes);
        result = file ? { ok: true } : null;
        break;
      }
      case 'resources.scopes':
        // Scope rows of the removed Workflow kind are kept on disk but no longer apply.
        result = await db.resourceScope.findMany({ where: { kind: { not: 'workflow' } } });
        break;
      case 'resources.setScope':
        result = await this.engine.lock.run(() =>
          db.$transaction((tx) => saveResourceScope(tx, input as any)),
        );
        break;
      case 'assets.list':
        result = await this.ai.assets.list();
        break;
      case 'assets.install': {
        const knownAssets = await db.installedExtension.findMany({ select: { assetId: true } });
        const file = await host.pickFile('extension');
        result = file ? await this.ai.assets.install(file) : null;
        if (result && input.storeScope) {
          const asset = result as {
            id: string;
            manifest: { kind: 'toolkit'; assetId: string };
          };
          if (
            !knownAssets.some((a) => a.assetId === asset.manifest.assetId) &&
            !(await db.resourceScope.findUnique({
              where: {
                kind_resourceId: { kind: asset.manifest.kind, resourceId: asset.manifest.assetId },
              },
            }))
          )
            await this.engine.lock.run(() =>
              db.$transaction((tx) =>
                saveResourceScope(
                  tx,
                  {
                    kind: asset.manifest.kind,
                    resourceId: asset.id,
                    expectedRevision: 0,
                    ...input.storeScope,
                  },
                  { invalidateRuns: false },
                ),
              ),
            );
        }
        break;
      }
      case 'assets.settings': {
        result = await this.engine.lock.run(() =>
          db.$transaction(async (tx) => {
            const asset = await tx.installedExtension.findUniqueOrThrow({
              where: { id: input.assetId },
            });
            let manifest = manifestSchema.parse(asset.manifest);
            const toolkit = manifest.kind === 'toolkit';
            const settingsId = toolkit ? toolkitIdentity(asset.id) : asset.id;
            if (toolkit)
              manifest = manifestSchema.parse((await currentToolkit(tx, settingsId)).manifest);
            const old = (
              await assetSettingsRows(tx, asset.id, input.scopeKey.replace(/^store:/, ''))
            ).find((r) => r.scopeKey === input.scopeKey);
            assert((old?.revision ?? 0) === input.expectedRevision, '配置已变化，请刷新');
            const values: Record<string, unknown> = {};
            for (const field of manifest.settingsFields) {
              const value = input.values[field.key];
              assert(
                !field.required || (value !== undefined && value !== null && value !== ''),
                `请填写 ${field.label}`,
              );
              if (value !== undefined)
                values[field.key] =
                  field.secret && value
                    ? { secretRef: await host.secretPut(String(value)) }
                    : value;
            }
            const setting = await tx.assetSetting.create({
              data: {
                assetId: settingsId,
                scopeKey: input.scopeKey,
                revision: (old?.revision ?? 0) + 1,
                values: json(values),
              },
            });
            await tx.store.updateMany({
              where:
                input.scopeKey === 'global' ? {} : { id: input.scopeKey.replace(/^store:/, '') },
              data: { replyConfigEpoch: { increment: 1 } },
            });
            return setting;
          }),
        );
        break;
      }
      case 'assets.test': {
        const ctx: ScopedAssetContext = {
          role: 'debug',
          storeId: 'debug',
          accountId: 'debug',
          conversationId: 'debug',
          runId: uid(),
          signal: AbortSignal.timeout(30000),
          settings: await this.ai.assets.settings(input.assetId, 'debug'),
          knowledge: { search: async () => [] },
          platform: {
            query: async (operation) => pddFixtureQuery(operation),
            action: async (_operation, input) => pddFixtureAction(input),
          },
          agents: {
            runSub: async () => ({ fixture: true }),
          },
          logger: { info: () => {} },
        };
        const module = await this.ai.assets.module(input.assetId);
        const tools = await this.ai.assets.tools(
          input.assetId,
          ctx,
          new Set(['history', 'goods', 'orders', 'orderRemark']),
          async () => {},
        );
        const key = this.ai.assets.alias(`${module.manifest.assetId}/${input.memberId}`);
        const tool = tools[key];
        assert(tool && 'execute' in tool && typeof tool.execute === 'function', '工具不存在');
        result = await (tool.execute as any)(input.input, {});
        break;
      }
      case 'models.list':
        result = (await db.modelProfile.findMany())
          .filter((m) => !isRetiredCloudModel(m))
          .map(({ secretRef, ...m }) => ({ ...m, hasKey: !!secretRef }));
        break;
      case 'models.save': {
        const parsed = modelSchema.parse(input);
        const { id, apiKey, ...fields } = parsed;
        assert(!isRetiredCloudModel({ id }), '云端模型已停用，请新增 OpenAI 兼容模型');
        const old = id ? await db.modelProfile.findUniqueOrThrow({ where: { id } }) : null;
        const secretRef = apiKey
          ? await host.secretPut(apiKey, old?.secretRef ?? undefined)
          : old?.secretRef;
        result = await db.modelProfile.upsert({
          where: { id: id ?? uid() },
          create: { ...fields, secretRef },
          update: { ...fields, secretRef, revision: { increment: 1 } },
        });
        if (old) {
          await db.store.updateMany({
            data: { replyConfigEpoch: { increment: 1 }, learningConfigEpoch: { increment: 1 } },
          });
          const defaults = await db.appSetting.findUnique({ where: { key: 'defaultModelId' } });
          if (defaults?.value === old.id) await this.engine.agents.setDefaultModel(old.id);
          if (old.kind === 'embedding') {
            const entries = await db.knowledgeEntry.findMany({ where: { status: 'enabled' } });
            for (const e of entries)
              if (e.activeRevisionId)
                await db.job.upsert({
                  where: { dedupKey: `index:${e.activeRevisionId}:${old.id}:${old.revision + 1}` },
                  create: {
                    kind: 'index',
                    storeId: e.storeId,
                    priority: 80,
                    dedupKey: `index:${e.activeRevisionId}:${old.id}:${old.revision + 1}`,
                    payload: { revisionId: e.activeRevisionId },
                  },
                  update: {},
                });
          }
        }
        const { secretRef: _, ...safe } = result as any;
        result = { ...safe, hasKey: !!secretRef };
        break;
      }
      case 'models.test':
        result = await this.ai.testModel(input.id);
        break;
      case 'models.discover':
        result = await this.ai.discoverModels(input as any);
        break;
      case 'reception.state':
        result = await receptionState(this.engine, input.storeId);
        break;
      case 'runs.history':
        result = await runHistory(db, input as any);
        break;
      case 'runs.detail':
        result = await runDetail(db, input.storeId, input.id);
        break;
      case 'runs.list': {
        const runs = await db.aiRun.findMany({
          where: { storeId: input.storeId },
          orderBy: { startedAt: 'desc' },
          include: { platformEvidence: true, platformActions: true },
          take: 100,
        });
        const linkedOutbounds = await db.outboundMessage.findMany({
          where: { storeId: input.storeId, aiRunId: { in: runs.map((run) => run.id) } },
          orderBy: { createdAt: 'asc' },
        });
        result = {
          runs: runs.map((run) => ({
            ...run,
            outbounds: linkedOutbounds.filter((outbound) => outbound.aiRunId === run.id),
          })),
          jobs: await db.job.findMany({
            where: { storeId: input.storeId },
            orderBy: { updatedAt: 'desc' },
            take: 100,
          }),
          outbounds: await db.outboundMessage.findMany({
            where: { storeId: input.storeId, status: { in: ['unknown', 'rejected', 'cancelled'] } },
            orderBy: { createdAt: 'desc' },
            take: 100,
          }),
        };
        break;
      }
      case 'jobs.retry': {
        const job = await db.job.findUniqueOrThrow({ where: { id: input.id } });
        assert(job.status === 'failed' || job.status === 'retry_wait', '该任务不可重试');
        assert(job.kind !== 'reply', '旧回复不能直接重放');
        result = await db.job.update({
          where: { id: job.id },
          data: { status: 'pending', attempts: 0, runAfter: new Date(), error: null },
        });
        break;
      }
      case 'backup.create':
        result = await this.backup();
        break;
      case 'backup.restore': {
        const file = await host.pickFile('backup');
        if (!file) {
          result = null;
          break;
        }
        this.maintenance = true;
        await host.maintenance(true);
        await this.engine.stop();
        try {
          await host.stageRestore(file);
          result = { ok: true, restartRequired: true };
        } catch (e) {
          this.maintenance = false;
          await host.maintenance(false);
          this.engine.start();
          throw e;
        }
        break;
      }
      case 'diagnostics.export': {
        const file = await host.saveFile('judesk-diagnostics.json');
        if (!file) {
          result = null;
          break;
        }
        const [reception, jobs, runs] = await Promise.all([
          receptionState(this.engine),
          db.job.findMany({
            orderBy: { updatedAt: 'desc' },
            take: 100,
            select: {
              id: true,
              kind: true,
              storeId: true,
              conversationId: true,
              status: true,
              error: true,
              attempts: true,
              runAfter: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          db.aiRun.findMany({
            orderBy: { startedAt: 'desc' },
            take: 100,
            select: {
              id: true,
              jobId: true,
              storeId: true,
              conversationId: true,
              role: true,
              path: true,
              status: true,
              error: true,
              startedAt: true,
              finishedAt: true,
            },
          }),
        ]);
        await writeFile(
          file,
          JSON.stringify(
            {
              version: this.appVersion,
              generatedAt: new Date().toISOString(),
              reception,
              jobs,
              runs,
            },
            null,
            2,
          ),
        );
        result = { ok: true };
        break;
      }
    }
    if (
      !method.endsWith('.list') &&
      !method.endsWith('.state') &&
      !method.endsWith('.messages') &&
      !method.endsWith('.outbounds') &&
      method !== 'resources.scopes' &&
      method !== 'stores.configuration' &&
      method !== 'stores.goods' &&
      method !== 'knowledge.assist' &&
      method !== 'runs.history' &&
      method !== 'runs.detail'
    )
      this.engine.onChanged();
    return result;
  }
  private async backup() {
    const file = await this.engine.host.saveFile(
      `judesk-backup-${new Date().toISOString().slice(0, 10)}.zip`,
    );
    if (!file) return null;
    this.maintenance = true;
    await this.engine.host.maintenance(true);
    await this.engine.stop();
    try {
      return await this.engine.lock.run(async () => {
        const temp = join(this.engine.dir, 'tmp', `backup-${uid()}`);
        await mkdir(temp, { recursive: true });
        const zip = new AdmZip();
        const records: Array<{ name: string; hash: string }> = [];
        const add = async (name: string, full: string) => {
          const bytes = await readFile(full);
          zip.addFile(name, bytes);
          records.push({ name, hash: hash(bytes.toString('base64')) });
        };
        for (const name of ['judesk.db', 'mastra.db']) {
          const connection = createClient({
            url: pathToFileURL(join(this.engine.dir, 'db', name)).href,
          });
          const destination = join(temp, name);
          try {
            await connection.execute(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
          } finally {
            connection.close();
          }
          await add(`db/${name}`, destination);
        }
        const walk = async (dir: string, prefix: string) => {
          for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const name = prefix + '/' + item.name;
            const full = join(dir, item.name);
            if (item.isDirectory()) await walk(full, name);
            else await add(name, full);
          }
        };
        for (const folder of ['attachments', 'extensions'])
          await walk(join(this.engine.dir, folder), folder);
        zip.addFile(
          'backup.json',
          Buffer.from(
            JSON.stringify({
              version: 1,
              appVersion: this.appVersion,
              createdAt: new Date().toISOString(),
              files: records,
            }),
          ),
        );
        await writeFile(file, zip.toBuffer());
        const { rm } = await import('node:fs/promises');
        await rm(temp, { recursive: true, force: true });
        return { ok: true };
      });
    } finally {
      this.maintenance = false;
      await this.engine.host.maintenance(false);
      this.engine.start();
    }
  }
}
