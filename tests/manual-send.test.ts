import { afterEach, expect, it, vi } from 'vitest';
import type { ManualOutbound, SendCommand, SendResult } from '../packages/contracts/src/index';
import { Engine } from '../packages/core/src/engine';
import { Router } from '../packages/core/src/router';
import { json } from '../packages/database/src/index';
import { setup, waitFor, flush } from './helpers';
import { mergeManualTimeline } from '../apps/desktop/src/renderer/components/inbox/manual-outbox';
import type { MastraAi } from '../packages/ai/src/index';

let f: Awaited<ReturnType<typeof setup>> | undefined;
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await f?.cleanup();
  f = undefined;
});
const init = async () => {
  f = await setup();
  const router = new Router(f.engine, {} as MastraAi);
  const question = await f.engine.ingest(f.inbound());
  await f.engine.setOpened(question.conversationId);
  return {
    ...f,
    router,
    question,
    send: (text: string, requestId: string = crypto.randomUUID()) =>
      router.call('messages.send', {
        conversationId: question.conversationId,
        text,
        requestId,
      }) as Promise<ManualOutbound>,
  };
};
const deferredSend = () => {
  const received: SendCommand[] = [];
  const pending = new Map<string, (result: SendResult) => void>();
  f!.host.send = async (command) => {
    received.push(command);
    return new Promise<SendResult>((resolve) => {
      pending.set(command.id, resolve);
      releases.push(() => resolve({ status: 'unknown', reason: '测试清理' }));
    });
  };
  return {
    received,
    resolve: (
      id: string,
      result: SendResult = { status: 'confirmed', externalId: `sent-${id}` },
    ) => {
      const resolve = pending.get(id);
      if (!resolve) throw new Error('send has not started');
      pending.delete(id);
      resolve(result);
    },
  };
};
const status = (id: string) => f!.db.outboundMessage.findUniqueOrThrow({ where: { id } });
const settled = (id: string, value: string) =>
  waitFor(async () => (await status(id)).status === value);

it('文本 API 在平台回执前返回持久化记录，确认前不创建 Message 或学习来源', async () => {
  const t = await init();
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  const gate = deferredSend();
  let returned = false;
  const accepting = t.send('明天发出').then((row) => {
    returned = true;
    return row;
  });
  await waitFor(async () => gate.received.length === 1);
  expect(returned).toBe(true);
  const outbound = await accepting;
  expect(outbound.status).toBe('prepared');
  expect((await status(outbound.id)).status).toBe('dispatching');
  expect(await t.db.message.count({ where: { direction: 'out' } })).toBe(0);
  expect(await t.db.answeredTurn.count()).toBe(0);
  expect(await t.db.businessEvent.count()).toBe(0);
  const changed = vi.fn();
  t.engine.onChanged = changed;
  expect(
    await t.router.call('conversations.outbounds', { conversationId: t.question.conversationId }),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: outbound.id, status: 'dispatching' })]),
  );
  expect(changed).not.toHaveBeenCalled(); // Read queries must not cause invalidation loops.
  gate.resolve(outbound.id);
  await settled(outbound.id, 'confirmed');
  expect(await t.db.message.count({ where: { direction: 'out' } })).toBe(1);
  expect(await t.db.answeredTurn.count()).toBe(1);
  expect(await t.db.businessEvent.count()).toBe(1);
  expect(changed).toHaveBeenCalled();
});

it('同会话连续文本按提交顺序执行，其他会话不被占用，重复请求只发一次', async () => {
  const t = await init();
  const gate = deferredSend();
  const first = await t.send('第一条', 'request-first');
  await waitFor(async () => gate.received.length === 1);
  const second = await t.send('第二条', 'request-second');
  const duplicate = await t.send('第一条', 'request-first');
  expect(duplicate.id).toBe(first.id);
  expect((await status(second.id)).status).toBe('prepared');
  expect(gate.received.map((s) => s.text)).toEqual(['第一条']);
  const another = await t.engine.ingest(
    t.inbound('另一个买家', { buyerId: 'buyer-b', conversationKey: 'buyer:b' }),
  );
  await t.engine.setOpened(another.conversationId);
  const third = (await t.router.call('messages.send', {
    conversationId: another.conversationId,
    text: '另一个会话',
    requestId: 'request-third',
  })) as ManualOutbound;
  await waitFor(async () => gate.received.length === 2);
  expect(gate.received.map((s) => s.text)).toEqual(['第一条', '另一个会话']);
  gate.resolve(third.id);
  gate.resolve(first.id);
  await waitFor(async () => gate.received.length === 3);
  expect(gate.received[2].text).toBe('第二条');
  gate.resolve(second.id);
  await settled(second.id, 'confirmed');
  expect((await t.send('第一条', 'request-first')).status).toBe('confirmed');
  expect(gate.received).toHaveLength(3);
  expect(await t.db.message.count({ where: { direction: 'out' } })).toBe(3);
  await expect(t.send('不能篡改已提交内容', 'request-first')).rejects.toThrow('同一发送请求');
  await expect(
    t.router.call('messages.send', {
      conversationId: another.conversationId,
      text: '第一条',
      requestId: 'request-first',
    }),
  ).rejects.toThrow('同一发送请求');
});

it('平台拒绝、超时未知和本地能力失效都留有可见状态，失败不阻塞后续消息、不自动重发', async () => {
  const t = await init();
  const gate = deferredSend();
  const first = await t.send('会被拒绝');
  await waitFor(async () => gate.received.length === 1);
  const second = await t.send('回执丢失');
  gate.resolve(first.id, { status: 'rejected', reason: '平台拒绝' });
  await waitFor(async () => gate.received.length === 2);
  expect(await status(first.id)).toMatchObject({ status: 'rejected', error: '平台拒绝' });
  gate.resolve(second.id, { status: 'unknown', reason: '平台回执超时' });
  await settled(second.id, 'unknown');
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  expect(await t.db.answeredTurn.count()).toBe(0);
  expect(gate.received).toHaveLength(2);
  await t.db.account.update({
    where: { id: t.account.id },
    data: { capabilities: json({ sendText: false }) },
  });
  const third = await t.send('发送能力已失效');
  await settled(third.id, 'rejected');
  expect((await status(third.id)).error).toContain('不支持');
  expect(gate.received).toHaveLength(2);
  await t.engine.markOffline(t.account.id);
  const fourth = await t.send('账号掉线');
  await settled(fourth.id, 'cancelled');
  expect(gate.received).toHaveLength(2);
  expect(await t.db.message.count({ where: { direction: 'out' } })).toBe(0);
  const rows = (await t.router.call('conversations.outbounds', {
    conversationId: t.question.conversationId,
  })) as ManualOutbound[];
  expect(rows.map((r) => r.status)).toEqual(
    expect.arrayContaining(['rejected', 'unknown', 'cancelled']),
  );
});

it('平台先回显、确认迟到仍只保存一个人工答案，学习上下文冻结在提交时', async () => {
  const t = await init();
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  const gate = deferredSend();
  const out = await t.send('明天发货');
  await waitFor(async () => gate.received.length === 1);
  const future = await t.engine.ingest(t.inbound('后来的新问题'));
  await t.db.message.update({
    where: { id: future.id },
    data: { receivedAt: new Date(Date.parse(out.createdAt as string) + 1000) },
  });
  const echo = t.inbound('明天发货', {
    direction: 'out',
    origin: 'human',
    externalId: 'echo-manual',
  });
  await t.engine.ingest(echo);
  expect(await t.db.answeredTurn.count()).toBe(0);
  gate.resolve(out.id, { status: 'unknown', reason: '回执仍在等待' });
  await settled(out.id, 'unknown');
  await t.engine.completeSend(out.id, { status: 'confirmed', externalId: 'echo-manual' });
  await t.engine.completeSend(out.id, { status: 'confirmed', externalId: 'echo-manual' });
  await t.engine.ingest(echo);
  expect(await t.db.message.count({ where: { direction: 'out' } })).toBe(1);
  expect(await t.db.turnAnswer.count()).toBe(1);
  const turn = await t.db.answeredTurn.findFirstOrThrow({ include: { questionGroup: true } });
  expect(turn.questionGroup.messageIds).toEqual([t.question.id]);
  expect(turn.contextMessageIds).not.toContain(future.id);
});

it('停止时取消尚未提交的后续消息，重启不会重发未知或失败的消息', async () => {
  const t = await init();
  const gate = deferredSend();
  const first = await t.send('已提交平台');
  await waitFor(async () => gate.received.length === 1);
  const second = await t.send('等待队列');
  const stopping = t.engine.stop();
  gate.resolve(first.id, { status: 'unknown', reason: '正在退出' });
  await stopping;
  expect(await status(first.id)).toMatchObject({ status: 'unknown' });
  expect(await status(second.id)).toMatchObject({ status: 'cancelled' });
  expect(gate.received).toHaveLength(1);
  await expect(t.send('停止后不能新发送')).rejects.toThrow('正在停止');
  const restarted = new Engine(t.db, t.dir, t.host, t.ai);
  await restarted.initialize();
  await restarted.tick();
  await restarted.stop();
  expect(gate.received).toHaveLength(1);
  expect((await status(first.id)).status).toBe('unknown');
  expect((await status(second.id)).status).toBe('cancelled');
});

const outbound = (data: Partial<ManualOutbound> = {}): ManualOutbound => ({
  id: 'outbound-id',
  intentKey: 'manual:request-1',
  conversationId: 'conversation-a',
  storeId: 'store-a',
  body: { text: '相同文本' },
  status: 'prepared',
  externalId: null,
  error: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  ...data,
});
it('时间线使用请求身份替换乐观消息和平台回显，同文不同消息不误去重', () => {
  const first = outbound();
  expect(mergeManualTimeline([], [], [first])).toMatchObject([
    { id: 'manual:request-1', delivery: { status: 'prepared' } },
  ]);
  const local = { ...first, id: 'local:request-1' };
  const ack = { ...first, status: 'confirmed' as const, externalId: 'platform-1' };
  const actual = {
    id: 'message-1',
    externalId: 'platform-1',
    conversationId: 'conversation-a',
    direction: 'out',
    origin: 'human',
    kind: 'text',
    text: first.body.text,
    timestamp: '2026-09-08T00:00:10.000Z',
  };
  const another = { ...actual, id: 'message-2', externalId: 'platform-2' };
  const items = mergeManualTimeline([actual, another, actual], [ack], [local]);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    id: first.intentKey,
    timestamp: first.createdAt,
    delivery: { status: 'confirmed' },
  });
  expect(items[1].id).toBe('message-2');
  expect(mergeManualTimeline([], [ack], [local])).toHaveLength(1);
  expect(
    mergeManualTimeline([], [outbound({ status: 'unknown', error: '平台回执超时' })], [local])[0]
      .delivery,
  ).toMatchObject({ status: 'unknown', error: '平台回执超时' });
});

it('先提交的多条人工回复在确认后继续同一学习来源，排队时的新问题不会被采入', async () => {
  const t = await init();
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  const gate = deferredSend();
  const first = await t.send('明天发出');
  await waitFor(async () => gate.received.length === 1);
  const second = await t.send('发出后更新快递单号');
  const later = await t.engine.ingest(t.inbound('另外的后续问题'));
  await t.db.message.update({
    where: { id: later.id },
    data: { receivedAt: new Date(Date.parse(second.createdAt as string) + 1000) },
  });
  gate.resolve(first.id);
  await waitFor(async () => gate.received.length === 2);
  gate.resolve(second.id);
  await settled(second.id, 'confirmed');
  const turns = await t.db.answeredTurn.findMany({
    include: { answers: true, questionGroup: true },
  });
  expect(turns).toHaveLength(1);
  expect(turns[0].answers).toHaveLength(2);
  expect(turns[0].sourceRevision).toBe(2);
  expect(turns[0].questionGroup.messageIds).toEqual([t.question.id]);
  expect(turns[0].contextMessageIds).not.toContain(later.id);
});

it.each([false, true])(
  '发送中离开和发送确认均不自动释放转人工（新转人工=%s）',
  async (newHandoff) => {
    const t = await init();
    const gate = deferredSend();
    await t.engine.handoff(t.question.conversationId, '请人工核实');
    const first = await t.send('人工处理好了');
    await waitFor(async () => gate.received.length === 1);
    await t.engine.setOpened(null);
    expect(
      (await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }))
        .awaitingHuman,
    ).toBe(true);
    if (newHandoff) await t.engine.handoff(t.question.conversationId, '新的人工处理请求');
    gate.resolve(first.id);
    await settled(first.id, 'confirmed');
    expect(
      (await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }))
        .awaitingHuman,
    ).toBe(true);
    await t.engine.setReception(t.question.conversationId, 'ai');
    expect(
      (await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }))
        .awaitingHuman,
    ).toBe(false);
  },
);

it.each([false, true])(
  '人工文本等待回执时，新问题是否自动回复只取决于显式接管（接管=%s）',
  async (takeover) => {
    const t = await init();
    const gate = deferredSend();
    await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
    if (takeover) await t.engine.setReception(t.question.conversationId, 'human');
    const first = await t.send('稍等，我正在核实');
    await waitFor(async () => gate.received.length === 1);
    await t.engine.setOpened(null);
    await t.engine.ingest(t.inbound('再补充一个问题'));
    expect(
      (await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }))
        .openedByHuman,
    ).toBe(takeover);
    expect(
      await t.db.job.count({
        where: { kind: 'reply', status: { in: ['pending', 'running', 'retry_wait'] } },
      }),
    ).toBe(takeover ? 0 : 1);
    if (!takeover) {
      const replying = flush(t.engine, t.db);
      await waitFor(async () => gate.received.length === 2);
      expect(t.ai.replyCalls).toBe(1);
      expect((await status(first.id)).status).toBe('dispatching');
      expect(await status(gate.received[1].id)).toMatchObject({ origin: 'ai' });
      gate.resolve(gate.received[1].id);
      await replying;
    } else {
      await flush(t.engine, t.db);
      expect(t.ai.replyCalls).toBe(0);
      expect(gate.received).toHaveLength(1);
    }
    gate.resolve(first.id);
    await settled(first.id, 'confirmed');
  },
);

it('消息记录先于发件记录刷新时，用确定的发送 ID 去重并更新已发送', () => {
  const sending = outbound({ status: 'dispatching' });
  const actual = {
    id: 'message-1',
    externalId: 'platform-1',
    conversationId: 'conversation-a',
    direction: 'out',
    origin: 'human',
    kind: 'text',
    text: sending.body.text,
    timestamp: '2026-09-08T00:00:10.000Z',
    raw: { confirmedOutboundId: sending.id },
  };
  const items = mergeManualTimeline([actual], [sending], []);
  expect(items).toHaveLength(1);
  expect(items[0].delivery).toMatchObject({ status: 'confirmed', externalId: 'platform-1' });
});

it('Electron 传回 Date 对象时保留毫秒顺序，不按随机消息 ID 交换气泡', () => {
  const first = outbound({
    id: 'z',
    intentKey: 'manual:z',
    createdAt: new Date('2026-09-08T00:00:00.100Z') as any,
    status: 'dispatching',
  });
  const second = outbound({
    id: 'a',
    intentKey: 'manual:a',
    createdAt: new Date('2026-09-08T00:00:00.200Z') as any,
    status: 'prepared',
  });
  expect(mergeManualTimeline([], [second, first], []).map((m) => m.id)).toEqual([
    'manual:z',
    'manual:a',
  ]);
});

it('旧人工回复的迟到确认不会完成重新打开后的新转人工接待', async () => {
  const t = await init();
  const gate = deferredSend();
  await t.engine.handoff(t.question.conversationId, '第一轮人工');
  const old = await t.send('第一轮的回复');
  await waitFor(async () => gate.received.length === 1);
  await t.engine.setOpened(null);
  await t.engine.handoff(t.question.conversationId, '第二轮人工');
  await t.engine.setOpened(t.question.conversationId);
  gate.resolve(old.id);
  await settled(old.id, 'confirmed');
  await t.engine.setOpened(null);
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }),
  ).toMatchObject({
    awaitingHuman: true,
    humanSentAfterHandoff: false,
    handoffReason: '第二轮人工',
  });
});

it('移除并重新接入会取消排队消息；已提交、未知及失败记录不换账号重发', async () => {
  const t = await init();
  const gate = deferredSend();
  const first = await t.send('原账号已提交', 'before-removal-first');
  await waitFor(async () => gate.received.length === 1);
  const queued = await t.send('原账号尚未提交', 'before-removal-queued');
  await t.engine.removeAccount(t.account.id);
  expect(await status(queued.id)).toMatchObject({
    status: 'cancelled',
    accountId: t.account.id,
    error: expect.stringContaining('账号已移除'),
  });
  expect(await status(first.id)).toMatchObject({ status: 'dispatching', accountId: t.account.id });
  const reconnected = await t.engine.registerAccount({
    partition: 'persist:reconnected-queue',
    mallId: 'mall-a',
    mallName: '测试店铺',
    externalId: 'cs-a',
    name: '重连客服',
    capabilities: t.account
      .capabilities as unknown as import('../packages/contracts/src').Capabilities,
  });
  gate.resolve(first.id, { status: 'unknown', reason: '移除前的提交仍待确认' });
  await settled(first.id, 'unknown');
  expect(await t.send('原账号已提交', 'before-removal-first')).toMatchObject({
    id: first.id,
    status: 'unknown',
  });
  expect(await t.send('原账号尚未提交', 'before-removal-queued')).toMatchObject({
    id: queued.id,
    status: 'cancelled',
  });
  expect(gate.received).toHaveLength(1);
  const fresh = await t.send('用户主动发送的新消息');
  await waitFor(async () => gate.received.length === 2);
  expect(gate.received[1]).toMatchObject({ id: fresh.id, accountId: reconnected.id });
  gate.resolve(fresh.id);
  await settled(fresh.id, 'confirmed');
  await t.engine.completeSend(first.id, {
    status: 'confirmed',
    externalId: 'late-old-account-receipt',
  });
  expect(await status(first.id)).toMatchObject({ status: 'confirmed', accountId: t.account.id });
  expect(
    await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }),
  ).toMatchObject({ accountId: reconnected.id });
  expect(gate.received).toHaveLength(2);
});

it('历史发送待确认可人工核对后交还 AI', async () => {
  const t = await init();
  const gate = deferredSend();
  const out = await t.send('卡在待确认');
  await waitFor(async () => gate.received.length === 1);
  gate.resolve(out.id, { status: 'unknown', reason: '未收到快手消息确认' });
  await waitFor(
    async () =>
      (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).status ===
      'unknown',
  );
  await t.engine.setReception(t.question.conversationId, 'human');
  await expect(t.engine.setReception(t.question.conversationId, 'ai')).rejects.toThrow(/待确认/);
  await t.router.call('outbound.acknowledge', {
    id: out.id,
    outcome: 'delivered',
    note: '已在原平台确认该消息送达',
  });
  expect(await t.db.outboundMessage.findUniqueOrThrow({ where: { id: out.id } })).toMatchObject({
    status: 'confirmed',
  });
  await t.engine.setReception(t.question.conversationId, 'ai');
  expect(
    (await t.db.conversation.findUniqueOrThrow({ where: { id: t.question.conversationId } }))
      .openedByHuman,
  ).toBe(false);
});
