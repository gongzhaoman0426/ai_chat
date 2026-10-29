import { afterEach, expect, it } from 'vitest';
import { setup, flush, waitFor } from './helpers';
import { Router } from '../packages/core/src/router';
import type { MastraAi } from '../packages/ai/src';
let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
const init = async () => (f = await setup());

it('只查看和切换会话不改变接待修订，不取消正在生成的回答', async () => {
  const t = await init();
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  const message = await t.engine.ingest(t.inbound());
  const before = await t.db.conversation.findUniqueOrThrow({
    where: { id: message.conversationId },
  });
  t.ai.beforeReply = async () => {
    await t.engine.setOpened(message.conversationId);
    const viewing = await t.db.conversation.findUniqueOrThrow({
      where: { id: message.conversationId },
    });
    expect(viewing).toMatchObject({ openedByHuman: false, unread: 0, revision: before.revision });
    await t.engine.setOpened(null);
  };
  await flush(t.engine, t.db);
  expect(t.sends).toHaveLength(1);
  expect(t.ai.replyCalls).toBe(1);
  expect(await t.db.outboundMessage.findFirstOrThrow()).toMatchObject({ status: 'confirmed' });
});
it.each([
  { source: '外部同步', kind: 'text' },
  { source: '外部同步', kind: 'image' },
  { source: '本地发送', kind: 'text' },
  { source: '本地发送', kind: 'image' },
] as const)(
  '$source 人工 $kind 回复不打断正在生成的 AI，后续问题仍自动接待',
  async ({ source, kind }) => {
    const t = await init();
    const attachment =
      kind === 'image'
        ? await t.engine.knowledge.attach(t.account.storeId, Buffer.from('test-png'), 'human.png')
        : undefined;
    await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
    const question = await t.engine.ingest(t.inbound());
    const before = await t.db.conversation.findUniqueOrThrow({
      where: { id: question.conversationId },
    });
    t.ai.beforeReply = async () => {
      t.ai.beforeReply = undefined;
      if (source === '外部同步') {
        await t.engine.ingest(
          t.inbound(kind === 'text' ? '人工补充说明' : '', {
            direction: 'out',
            origin: 'human',
            kind,
            attachmentId: attachment?.id,
          }),
        );
      } else {
        await t.engine.sendManual({
          conversationId: question.conversationId,
          text: kind === 'text' ? '人工补充说明' : '',
          attachmentId: attachment?.id,
          requestId: `concurrent-human-${kind}`,
        });
      }
      expect(
        await t.db.conversation.findUniqueOrThrow({ where: { id: question.conversationId } }),
      ).toMatchObject({ openedByHuman: false, awaitingHuman: false, revision: before.revision });
    };
    await flush(t.engine, t.db);
    expect(t.ai.replyCalls).toBe(1);
    expect(await t.db.outboundMessage.count({ where: { origin: 'ai', status: 'confirmed' } })).toBe(
      1,
    );
    const answers = await t.db.turnAnswer.findMany({
      include: { turn: { include: { questionGroup: true } } },
    });
    expect(answers.map((answer) => answer.origin).sort()).toEqual(['ai', 'human']);
    expect(new Set(answers.map((answer) => answer.turn.questionGroupId)).size).toBe(2);
    expect(
      answers.every((answer) =>
        (answer.turn.questionGroup.messageIds as string[]).includes(question.id),
      ),
    ).toBe(true);

    await t.engine.ingest(t.inbound('人工补充后的新问题'));
    await flush(t.engine, t.db);
    expect(t.ai.replyCalls).toBe(2);
    expect(await t.db.outboundMessage.count({ where: { origin: 'ai', status: 'confirmed' } })).toBe(
      2,
    );
    expect(
      await t.db.conversation.findUniqueOrThrow({ where: { id: question.conversationId } }),
    ).toMatchObject({ openedByHuman: false, awaitingHuman: false });
  },
);
it('显式接管取消旧回复，离开和重启不释放，交还只接待新消息', async () => {
  const t = await init();
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  const message = await t.engine.ingest(t.inbound());
  t.ai.beforeReply = () => t.engine.setReception(message.conversationId, 'human');
  await flush(t.engine, t.db);
  expect(t.sends).toHaveLength(0);
  await t.engine.setOpened(null);
  const other = await t.engine.ingest(
    t.inbound('另外一个买家', { conversationKey: 'other', buyerId: 'other' }),
  );
  await t.engine.setOpened(other.conversationId);
  await t.engine.setReception(other.conversationId, 'human');
  expect(await t.db.conversation.count({ where: { openedByHuman: true } })).toBe(2);
  await t.engine.initialize();
  expect(await t.db.conversation.count({ where: { openedByHuman: true } })).toBe(2);
  await t.db.account.update({
    where: { id: t.account.id },
    data: { status: 'online', capabilities: t.account.capabilities as any },
  });
  await t.engine.setReception(message.conversationId, 'ai');
  t.ai.beforeReply = undefined;
  await flush(t.engine, t.db);
  expect(t.sends).toHaveLength(0);
  await t.engine.ingest(t.inbound('交还之后的新问题'));
  await flush(t.engine, t.db);
  expect(t.sends).toHaveLength(1);
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: other.conversationId } }))
      .openedByHuman,
  ).toBe(true);
});
it('显式接管后人工发送未知时不能交还，回执不会自动释放', async () => {
  const t = await init();
  const message = await t.engine.ingest(t.inbound());
  await t.engine.setReception(message.conversationId, 'human');
  t.setResponse({ status: 'unknown', reason: '平台回执丢失' });
  const sent = await t.engine.enqueueManualText({
    conversationId: message.conversationId,
    text: '我来处理',
    requestId: 'human',
  });
  await waitFor(
    async () =>
      (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: sent.id } })).status ===
      'unknown',
  );
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: message.conversationId } }))
      .openedByHuman,
  ).toBe(true);
  await expect(t.engine.setReception(message.conversationId, 'ai')).rejects.toThrow('仍有消息');
  await t.engine.completeSend(sent.id, { status: 'confirmed', externalId: 'confirmed-human' });
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: message.conversationId } }))
      .openedByHuman,
  ).toBe(true);
  await t.engine.setReception(message.conversationId, 'ai');
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: message.conversationId } }))
      .openedByHuman,
  ).toBe(false);
});
it('交还操作携带看到的修订，不能覆盖期间新到的转人工请求', async () => {
  const t = await init();
  const message = await t.engine.ingest(t.inbound());
  await t.engine.setReception(message.conversationId, 'human');
  const before = await t.db.conversation.findUniqueOrThrow({
    where: { id: message.conversationId },
  });
  await t.engine.handoff(message.conversationId, '新的售后问题');
  const router = new Router(t.engine, {} as MastraAi);
  await expect(
    router.call('conversations.reception', {
      conversationId: message.conversationId,
      mode: 'ai',
      expectedRevision: before.revision,
    }),
  ).rejects.toThrow('状态变化');
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: message.conversationId } }),
  ).toMatchObject({ openedByHuman: true, awaitingHuman: true, handoffReason: '新的售后问题' });
});
