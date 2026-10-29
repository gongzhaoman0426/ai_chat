import { afterEach, expect, it } from 'vitest';
import type { Capabilities } from '../packages/contracts/src';
import type { PlatformId } from '../packages/contracts/src/platform';
import { Engine } from '../packages/core/src/engine';
import { setup, waitFor } from './helpers';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
const register = (extra: Partial<Parameters<Engine['registerAccount']>[0]> = {}) =>
  f!.engine.registerAccount({
    platform: 'pinduoduo',
    partition: `persist:${crypto.randomUUID()}`,
    mallId: 'mall-a',
    mallName: '测试店铺',
    externalId: 'cs-a',
    name: '重新连接的客服',
    capabilities: f!.account.capabilities as unknown as Capabilities,
    ...extra,
  });

it.each<PlatformId>(['pinduoduo', 'douyin'])(
  '%s 移除后重新添加账号，无新买家消息也能在原会话发送文字和图片',
  async (platform) => {
    const t = (f = await setup());
    const account = platform === 'pinduoduo' ? t.account : await register({ platform });
    const question = await t.engine.ingest(
      t.inbound('查看尺寸图', {
        accountId: account.id,
        conversationKey: 'opaque:buyer:shop::2:1',
        platformContext: {
          securityUserId: 'encrypted-buyer',
          securityConversationId: 'opaque-cid',
        },
      }),
    );
    await t.engine.setOpened(question.conversationId);
    const before = await t.db.conversation.findUniqueOrThrow({
      where: { id: question.conversationId },
    });
    const image = await t.engine.knowledge.attach(
      account.storeId,
      Buffer.from('test-image'),
      '尺寸图.png',
    );
    await t.engine.removeAccount(account.id);
    const reconnected = await register({ platform });
    expect(reconnected.id).not.toBe(account.id);
    expect(reconnected.storeId).toBe(account.storeId);
    const restored = await t.db.conversation.findUniqueOrThrow({ where: { id: before.id } });
    expect(restored).toMatchObject({
      accountId: reconnected.id,
      storeId: before.storeId,
      externalKey: before.externalKey,
      platformContext: before.platformContext,
      openedByHuman: false,
      routeVersion: before.routeVersion + 2,
    });
    expect(restored.revision).toBeGreaterThan(before.revision);
    const sent = await t.engine.enqueueManualText({
      conversationId: before.id,
      text: '您好',
      requestId: 'reconnected-text',
    });
    await waitFor(
      async () =>
        (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: sent.id } })).status ===
        'confirmed',
    );
    const picture = await t.engine.sendManual({
      conversationId: before.id,
      text: '',
      attachmentId: image.id,
      requestId: 'reconnected-image',
    });
    expect(picture.status).toBe('confirmed');
    expect(t.sends).toMatchObject([
      {
        accountId: reconnected.id,
        conversationKey: before.externalKey,
        buyerId: before.buyerId,
        platformContext: before.platformContext,
        kind: 'text',
      },
      { accountId: reconnected.id, conversationKey: before.externalKey, kind: 'image' },
    ]);
    expect(await t.db.message.count({ where: { direction: 'in' } })).toBe(1);
    expect(t.ai.replyCalls).toBe(0);
    expect(
      await t.db.auditEvent.findFirst({ where: { type: 'conversation.route_recovered' } }),
    ).toMatchObject({
      details: expect.objectContaining({
        previousAccountId: account.id,
        accountId: reconnected.id,
      }),
    });
  },
);

it.each(['manual-text', 'manual-image', 'connection', 'register'])(
  '兼容已存在的悬空会话，%s 恢复唯一同店账号且重复恢复不增加版本',
  async (trigger) => {
    const t = (f = await setup());
    const question = await t.engine.ingest(t.inbound());
    const orphan = await t.db.conversation.update({
      where: { id: question.conversationId },
      data: { accountId: 'previously-deleted-account' },
    });
    if (trigger === 'manual-text') {
      const sent = await t.engine.enqueueManualText({
        conversationId: orphan.id,
        text: '继续接待',
        requestId: 'legacy-text',
      });
      await waitFor(
        async () =>
          (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: sent.id } })).status ===
          'confirmed',
      );
    } else if (trigger === 'manual-image') {
      const image = await t.engine.knowledge.attach(
        t.account.storeId,
        Buffer.from('image'),
        '图.png',
      );
      expect(
        await t.engine.sendManual({
          conversationId: orphan.id,
          text: '',
          attachmentId: image.id,
          requestId: 'legacy-image',
        }),
      ).toMatchObject({ status: 'confirmed', accountId: t.account.id });
    } else if (trigger === 'connection') {
      await t.engine.updateConnection({
        accountId: t.account.id,
        phase: 'online',
        reason: '连接恢复',
        capabilities: t.account.capabilities as unknown as Capabilities,
      });
    } else {
      await register({ partition: t.account.sessionPartition });
    }
    expect(await t.db.conversation.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
      accountId: t.account.id,
      routeVersion: orphan.routeVersion + 1,
    });
    await register({ partition: t.account.sessionPartition });
    expect(await t.db.conversation.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
      accountId: t.account.id,
      routeVersion: orphan.routeVersion + 1,
    });
  },
);

it('没有原店账号时给出明确提示，其他平台的同号店铺和其他店铺不能接替发送', async () => {
  const t = (f = await setup());
  const question = await t.engine.ingest(t.inbound());
  await register({ platform: 'douyin' });
  await register({ mallId: 'another-shop' });
  await t.engine.removeAccount(t.account.id);
  await expect(
    t.engine.enqueueManualText({
      conversationId: question.conversationId,
      text: '不能跨店发送',
      requestId: 'wrong-store',
    }),
  ).rejects.toMatchObject({
    code: 'ACCOUNT_REMOVED',
    message: expect.stringContaining('重新添加该店铺账号'),
  });
  expect(t.sends).toHaveLength(0);
  expect(await t.db.outboundMessage.count()).toBe(0);
});

it.each(['in', 'out'] as const)(
  '同店多账号不猜测归属（含离线账号）；新的 %s 消息才能恢复悬空绑定',
  async (direction) => {
    const t = (f = await setup());
    const original = t.inbound();
    const question = await t.engine.ingest(original);
    const b = await register({ externalId: 'cs-b' });
    const c = await register({ externalId: 'cs-c' });
    await t.engine.removeAccount(t.account.id);
    await t.engine.markOffline(b.id);
    await register({ externalId: 'cs-c', partition: c.sessionPartition });
    const request = {
      conversationId: question.conversationId,
      text: '由正确账号发送',
      requestId: 'multiple-accounts',
    };
    await expect(t.engine.enqueueManualText(request)).rejects.toMatchObject({
      code: 'ACCOUNT_ROUTE_AMBIGUOUS',
    });
    await t.engine.ingest({ ...original, accountId: c.id, eventKey: 'duplicate' });
    await t.engine.ingest(t.inbound('历史同步', { accountId: c.id, historical: true }));
    expect(
      await t.db.conversation.findUniqueOrThrow({ where: { id: question.conversationId } }),
    ).toMatchObject({ accountId: t.account.id });
    await t.engine.ingest(
      t.inbound('当前账号的实际消息', {
        accountId: c.id,
        direction,
        origin: direction === 'in' ? 'buyer' : 'human',
      }),
    );
    const sent = await t.engine.enqueueManualText(request);
    await waitFor(
      async () =>
        (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: sent.id } })).status ===
        'confirmed',
    );
    expect(t.sends).toMatchObject([{ accountId: c.id }]);
    expect(
      await t.db.conversation.findUniqueOrThrow({ where: { id: question.conversationId } }),
    ).toMatchObject({ accountId: c.id });
  },
);

it('已有的离线账号不会被另一个在线客服或其消息抢走会话', async () => {
  const t = (f = await setup());
  const question = await t.engine.ingest(t.inbound());
  await t.engine.markOffline(t.account.id);
  const b = await register({ externalId: 'cs-b' });
  await t.engine.ingest(t.inbound('另一个客服观测的消息', { accountId: b.id }));
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: question.conversationId } }),
  ).toMatchObject({ accountId: t.account.id, routeVersion: 1 });
  const sent = await t.engine.enqueueManualText({
    conversationId: question.conversationId,
    text: '等待原账号上线',
    requestId: 'offline-route',
  });
  await waitFor(
    async () =>
      (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: sent.id } })).status ===
      'cancelled',
  );
  expect(t.sends).toHaveLength(0);
});

it.each(['missing', 'another-store'])(
  '发送前账号 %s 时持久化取消原因，不抛 Prisma 异常也不改用其他账号',
  async (kind) => {
    const t = (f = await setup());
    const question = await t.engine.ingest(t.inbound());
    const accountId =
      kind === 'missing' ? 'deleted-account' : (await register({ platform: 'douyin' })).id;
    const conversation = await t.db.conversation.update({
      where: { id: question.conversationId },
      data: { accountId },
    });
    const outbound = await t.db.outboundMessage.create({
      data: {
        intentKey: 'manual:old-prepared',
        conversationId: conversation.id,
        storeId: conversation.storeId,
        accountId,
        routeVersion: conversation.routeVersion,
        conversationRevision: conversation.revision,
        replyConfigEpoch: 1,
        origin: 'human',
        body: { text: '历史待发送意图' },
      },
    });
    const result = await t.engine.dispatch(outbound.id);
    expect(result).toMatchObject({
      status: 'cancelled',
      accountId,
      error: expect.stringMatching(kind === 'missing' ? /账号已移除/ : /店铺不匹配/),
    });
    expect(result.error).not.toContain('prisma');
    expect(t.sends).toHaveLength(0);
  },
);

it('重连取消旧自动接待任务，不因恢复路由补发历史问题', async () => {
  const t = (f = await setup());
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  const question = await t.engine.ingest(t.inbound());
  expect(await t.db.job.count({ where: { kind: 'reply', status: 'pending' } })).toBe(1);
  // Simulate the old version deleting an account without invalidating its tasks.
  await t.db.account.delete({ where: { id: t.account.id } });
  await register();
  expect(
    await t.db.messageGroup.findFirst({ where: { conversationId: question.conversationId } }),
  ).toMatchObject({ autoEligible: false });
  expect(await t.db.job.findFirst({ where: { kind: 'reply' } })).toMatchObject({
    status: 'cancelled',
  });
  await t.engine.tick();
  expect(t.ai.replyCalls).toBe(0);
  expect(t.sends).toHaveLength(0);
});
