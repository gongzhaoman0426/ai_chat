import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MastraAi } from '../packages/ai/src/index';
import { Router } from '../packages/core/src/router';
import { receptionState } from '../packages/core/src/reception';
import { json } from '../packages/database/src/index';
import { hash } from '../packages/core/src/util';
import { setup, flush, waitFor } from './helpers';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await fixture?.cleanup();
  fixture = undefined;
});
const init = async () => (fixture = await setup());

it.each(['binding', 'model', 'resource'] as const)(
  '工作 Agent %s 启动失败也会留下记录，后台任务不会被误记为成功或重试',
  async (failure) => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const resolved = (await f.engine.agents.resolve(f.account.storeId))!;
    if (failure === 'binding') await f.db.agentBinding.deleteMany();
    if (failure === 'model') {
      const config = { ...resolved.config, modelSnapshot: null };
      await f.db.agentRevision.update({
        where: { id: resolved.revision.id },
        data: { configSnapshot: json(config), configHash: hash(config) },
      });
    }
    if (failure === 'resource')
      await f.db.installedExtension.update({
        where: { id: resolved.config.assetLock[0].id },
        data: { status: 'disabled' },
      });
    const message = await f.engine.ingest(f.inbound());
    await flush(f.engine, f.db);
    const run = await f.db.aiRun.findFirstOrThrow();
    expect(run).toMatchObject({
      role: 'reply',
      path: 'preflight',
      status: 'failed',
      snapshotId: null,
    });
    expect(run.usage).toEqual({ modelCalled: false, stage: 'agent_config' });
    expect(run.input).toEqual({ question: message.text, messageIds: [message.id] });
    expect(run.error).toContain(
      failure === 'binding'
        ? '未配置工作回复 Agent'
        : failure === 'model'
          ? '尚未配置模型'
          : '资源版本不可用',
    );
    expect(await f.db.job.findFirstOrThrow({ where: { kind: 'reply' } })).toMatchObject({
      status: 'failed',
      error: run.error,
      attempts: 1,
      leaseToken: null,
    });
    expect(
      await f.db.conversation.findUniqueOrThrow({ where: { id: message.conversationId } }),
    ).toMatchObject({ awaitingHuman: true });
    expect(f.ai.replyCalls).toBe(0);
    expect(f.sends).toHaveLength(0);
    await flush(f.engine, f.db);
    expect(await f.db.aiRun.count()).toBe(1);
    const report = await receptionState(f.engine, f.account.storeId);
    expect(report.stores[0].agent.ready).toBe(false);
  },
);

it.each([
  'auto_reply_disabled',
  'opened_by_human',
  'awaiting_human',
  'account_unverified',
  'account_disconnected',
])('新消息未触发时记录 %s，平台重放不会重复记录，也不会调用 AI', async (code) => {
  const f = await init();
  const first = await f.engine.ingest(f.inbound());
  await f.db.auditEvent.deleteMany({ where: { type: 'reply.eligibility' } });
  if (code !== 'auto_reply_disabled')
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  if (code === 'opened_by_human') await f.engine.setReception(first.conversationId, 'human');
  if (code === 'awaiting_human') await f.engine.handoff(first.conversationId, '测试转人工');
  if (code === 'account_unverified')
    await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
  if (code === 'account_disconnected')
    await f.db.account.update({ where: { id: f.account.id }, data: { status: 'offline' } });
  const input = f.inbound('这条消息为什么没回复');
  const message = await f.engine.ingest(input);
  await f.engine.ingest(input);
  await flush(f.engine, f.db);
  const events = await f.db.auditEvent.findMany({ where: { type: 'reply.eligibility' } });
  expect(events).toHaveLength(1);
  expect(events[0].details).toMatchObject({
    eligible: false,
    code,
    messageId: message.id,
    conversationId: first.conversationId,
  });
  expect(await f.db.job.count({ where: { kind: 'reply' } })).toBe(0);
  expect(await f.db.aiRun.count()).toBe(0);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it('人工消息正在发送时，新买家消息仍进入自动回复队列', async () => {
  const f = await init();
  const first = await f.engine.ingest(f.inbound());
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.setOpened(first.conversationId);
  f.host.send = () =>
    new Promise((resolve) =>
      releases.push(() => resolve({ status: 'unknown', reason: '测试清理' })),
    );
  await f.engine.enqueueManualText({
    conversationId: first.conversationId,
    text: '正在处理',
    requestId: 'pending-reception',
  });
  await waitFor(async () => releases.length > 0);
  await f.engine.setOpened(null);
  await f.engine.ingest(f.inbound());
  const events = await f.db.auditEvent.findMany({
    where: { type: 'reply.eligibility' },
    orderBy: { createdAt: 'desc' },
  });
  expect(events[0].details).toMatchObject({ eligible: true, code: 'queued' });
  expect(await f.db.job.count({ where: { kind: 'reply' } })).toBe(1);
  expect(f.ai.replyCalls).toBe(0);
});

it('排队后连接丢失，记录账号启动检查失败，不调用模型、不错误转人工', async () => {
  const f = await init();
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  const message = await f.engine.ingest(f.inbound());
  await f.db.account.update({ where: { id: f.account.id }, data: { status: 'offline' } });
  await flush(f.engine, f.db);
  expect(await f.db.aiRun.findFirstOrThrow()).toMatchObject({
    path: 'preflight',
    status: 'failed',
    usage: { stage: 'account', modelCalled: false },
  });
  expect(await f.db.job.findFirstOrThrow({ where: { kind: 'reply' } })).toMatchObject({
    status: 'failed',
    attempts: 1,
  });
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: message.conversationId } }),
  ).toMatchObject({ awaitingHuman: false });
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});

it('执行前已过期的消息组标记为取消，不能显示任务成功', async () => {
  const f = await init();
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.ingest(f.inbound());
  await f.db.messageGroup.updateMany({ data: { autoEligible: false } });
  await flush(f.engine, f.db);
  const job = await f.db.job.findFirstOrThrow({ where: { kind: 'reply' } });
  expect(job.status).toBe('cancelled');
  expect(job.error).toContain('STALE:');
  expect(await f.db.aiRun.count()).toBe(0);
  expect(f.ai.replyCalls).toBe(0);
});

it('明确交还 AI 后，新消息正常入队、只调用一次模型并获得发送回执', async () => {
  const f = await init();
  const first = await f.engine.ingest(f.inbound());
  await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
  await f.engine.setReception(first.conversationId, 'human');
  const paused = await f.engine.ingest(f.inbound('人工正在接待'));
  await f.engine.setReception(first.conversationId, 'ai');
  await f.engine.ingest(f.inbound('离开后的新消息'));
  await flush(f.engine, f.db);
  expect(f.ai.replyCalls).toBe(1);
  expect(f.sends).toHaveLength(1);
  expect(await f.db.outboundMessage.findFirstOrThrow()).toMatchObject({
    status: 'confirmed',
    origin: 'ai',
  });
  const run = await f.db.aiRun.findFirstOrThrow();
  expect(run).toMatchObject({ path: 'agent', status: 'succeeded' });
  expect(run.input).not.toMatchObject({ messageIds: [paused.id] });
  expect(await f.db.job.findFirstOrThrow({ where: { kind: 'reply' } })).toMatchObject({
    status: 'succeeded',
  });
});

it('超过旧每日调用上限仍能连续回复，不因调用次数转人工', async () => {
  const f = await init();
  await f.engine.setPolicy({
    storeId: f.account.storeId,
    autoReplyEnabled: true,
  });
  await f.db.aiRun.createMany({
    data: Array.from({ length: 501 }, () => ({
      storeId: f.account.storeId,
      role: 'reply',
      path: 'agent',
      status: 'succeeded',
      input: {},
      output: {},
      evidence: [],
      usage: { inputTokens: 10 },
    })),
  });
  await f.db.aiRun.create({
    data: {
      storeId: f.account.storeId,
      role: 'reply',
      path: 'preflight',
      status: 'failed',
      input: {},
      output: {},
      evidence: [],
      usage: { modelCalled: false },
    },
  });
  await f.engine.ingest(f.inbound());
  await flush(f.engine, f.db);
  expect(f.ai.replyCalls).toBe(1);
  expect(f.sends).toHaveLength(1);
  const second = await f.engine.ingest(
    f.inbound('再问一次', { conversationKey: 'buyer:unlimited' }),
  );
  await flush(f.engine, f.db);
  expect(f.ai.replyCalls).toBe(2);
  expect(f.sends).toHaveLength(2);
  expect(
    await f.db.conversation.findUniqueOrThrow({ where: { id: second.conversationId } }),
  ).toMatchObject({ awaitingHuman: false });
  expect(await f.db.job.findMany({ where: { kind: 'reply' } })).toEqual([
    expect.objectContaining({ status: 'succeeded' }),
    expect.objectContaining({ status: 'succeeded' }),
  ]);
});

it('接待检查是只读调用；诊断包含运行环境与触发原因，不导出消息、模型快照或密钥', async () => {
  const f = await init();
  await f.engine.ingest(f.inbound('PRIVATE_BUYER_TEXT', { raw: { cookie: 'PRIVATE_COOKIE' } }));
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: { secretRef: 'PRIVATE_KEY_REF' },
  });
  const router = new Router(f.engine, {} as MastraAi);
  const changed = vi.fn();
  f.engine.onChanged = changed;
  const report = (await router.call('reception.state', { storeId: f.account.storeId })) as Awaited<
    ReturnType<typeof receptionState>
  >;
  expect(changed).not.toHaveBeenCalled();
  expect(report.runtime).toMatchObject({ platform: process.platform, arch: process.arch });
  expect(report.stores[0].decisions[0]).toMatchObject({ code: 'auto_reply_disabled' });
  expect(report.stores[0].agent.ready).toBe(true);
  const target = join(f.dir, 'diagnostics.json');
  f.host.saveFile = async () => target;
  expect(await router.call('diagnostics.export')).toEqual({ ok: true });
  const text = await readFile(target, 'utf8');
  expect(text).toContain('auto_reply_disabled');
  for (const privateValue of [
    'PRIVATE_BUYER_TEXT',
    'PRIVATE_COOKIE',
    'PRIVATE_KEY_REF',
    'secretRef',
    'configSnapshot',
    'apiKey',
  ])
    expect(text).not.toContain(privateValue);
  expect(f.ai.replyCalls).toBe(0);
  expect(f.sends).toHaveLength(0);
});
