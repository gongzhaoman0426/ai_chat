import { describe, it, expect, afterEach, vi } from 'vitest';
import { setup, flush, waitFor } from './helpers';
import { Router } from '../packages/core/src/router';
import { defaultConfig } from '../packages/agent-config/src/index';
import { hash } from '../packages/core/src/util';
import { json } from '../packages/database/src/index';
import { getAutoReplyReadiness } from '../packages/contracts/src/index';
let fixture: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
const init = async () => (fixture = await setup());
const qa = {
  intent: '多久发货',
  answerKind: 'text' as const,
  answer: '现货商品在 48 小时内发出。',
  scope: { productIds: [], conditions: '' },
};
describe('接待、发送和恢复', () => {
  it('平台消息 ID 去重，买家重复文本仍保留独立消息', async () => {
    const f = await init();
    const m = f.inbound();
    await f.engine.ingest(m);
    await f.engine.ingest(m);
    await f.engine.ingest(f.inbound(m.text));
    expect(await f.db.message.count()).toBe(2);
    expect(await f.db.messageReceipt.count()).toBe(2);
  });
  it('同一店铺不同客服账号的消息回显归并，记录各账号 receipt', async () => {
    const f = await init();
    const b = await f.engine.registerAccount({
      partition: 'persist:test2',
      mallId: 'mall-a',
      mallName: '测试店铺',
      externalId: 'cs-b',
      name: 'B',
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: false,
        orders: false,
        verified: false,
      },
    });
    const m = f.inbound();
    await f.engine.ingest(m);
    await f.engine.ingest({ ...m, accountId: b.id });
    expect(await f.db.message.count()).toBe(1);
    expect(await f.db.messageReceipt.count()).toBe(2);
  });
  it('关闭自动回复仍记录问题，人工实际回答触发持久化学习事件', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
    const m = await f.engine.ingest(f.inbound());
    await f.engine.setOpened(m.conversationId);
    await f.engine.sendManual({
      conversationId: m.conversationId,
      text: '今天发出',
      requestId: 'manual-a',
    });
    expect(await f.db.answeredTurn.count()).toBe(1);
    expect(await f.db.businessEvent.count()).toBe(1);
    expect(f.ai.replyCalls).toBe(0);
  });
  it('查看和离开不解除转人工，人工答复后需明确交还 AI', async () => {
    const f = await init();
    const m = await f.engine.ingest(f.inbound());
    await f.engine.handoff(m.conversationId, '需要人工');
    await f.engine.setOpened(m.conversationId);
    await f.engine.setOpened(null);
    expect(
      (await f.db.conversation.findUniqueOrThrow({ where: { id: m.conversationId } }))
        .awaitingHuman,
    ).toBe(true);
    await f.engine.setOpened(m.conversationId);
    await f.engine.sendManual({
      conversationId: m.conversationId,
      text: '人工处理完毕',
      requestId: 'a',
    });
    await f.engine.setOpened(null);
    await f.engine.setReception(m.conversationId, 'ai');
    expect(
      (await f.db.conversation.findUniqueOrThrow({ where: { id: m.conversationId } }))
        .awaitingHuman,
    ).toBe(false);
  });
  it('转人工等待跨重启保留，退出不清除未完成的人工作业', async () => {
    const f = await init();
    const m = await f.engine.ingest(f.inbound());
    await f.engine.handoff(m.conversationId, '待核实');
    await f.engine.setOpened(m.conversationId);
    await f.engine.initialize();
    expect(
      (await f.db.conversation.findUniqueOrThrow({ where: { id: m.conversationId } }))
        .awaitingHuman,
    ).toBe(true);
  });
  it('手动选用图片问答按图片发送，确认后归档为人工回答', async () => {
    const f = await init();
    const bytes = Buffer.from('isolated-qa-image');
    const image = await f.engine.knowledge.attach(f.account.storeId, bytes, '尺寸图.png');
    const entry = await f.engine.knowledge.save({
      storeId: f.account.storeId,
      qa: {
        intent: '查看尺寸图',
        answerKind: 'image',
        answer: '',
        attachmentId: image.id,
        scope: { productIds: [], conditions: '' },
      },
    });
    const m = await f.engine.ingest(f.inbound('尺寸多少'));
    await f.engine.setOpened(m.conversationId);
    const saved = (await f.engine.knowledge.list(f.account.storeId)).find(
      (q) => q.id === entry.entryId,
    )!;
    const sent = await f.engine.sendManual({
      conversationId: m.conversationId,
      text: '',
      attachmentId: saved.revisions[0].attachmentId!,
      requestId: 'manual-image-qa',
    });
    expect(sent.status).toBe('confirmed');
    expect(f.sends).toMatchObject([
      { kind: 'image', text: '', imageMime: 'image/png', imageData: bytes.toString('base64') },
    ]);
    expect(await f.db.message.findFirst({ where: { direction: 'out' } })).toMatchObject({
      kind: 'image',
      origin: 'human',
      attachmentId: image.id,
    });
    expect(await f.db.answeredTurn.count()).toBe(1);
    expect(f.ai.replyCalls).toBe(0);
  });
  it('手工发送操作 ID 去重，unknown 不重发、不提前形成回答', async () => {
    const f = await init();
    f.setResponse({ status: 'unknown', reason: 'timeout' });
    const m = await f.engine.ingest(f.inbound());
    const command = { conversationId: m.conversationId, text: '您好', requestId: 'unique' };
    const sent = await f.engine.sendManual(command);
    await f.engine.sendManual(command);
    expect(f.sends).toHaveLength(1);
    expect(await f.db.answeredTurn.count()).toBe(0);
    await f.engine.completeSend(sent.id, { status: 'confirmed', externalId: 'platform-1' });
    await f.engine.completeSend(sent.id, { status: 'confirmed', externalId: 'platform-1' });
    expect(await f.db.answeredTurn.count()).toBe(1);
    expect(await f.db.businessEvent.count()).toBe(1);
  });
  it('平台拒绝事件先于发送调用返回：幂等保留拒绝，不生成回答或学习来源', async () => {
    const f = await init();
    const refusal = { status: 'rejected' as const, reason: '拼多多拒绝发送：会话已关闭' };
    f.host.send = async (command) => {
      f.sends.push(command);
      await f.engine.completeSend(command.id, refusal);
      return { status: 'unknown', reason: '等待调用结束' };
    };
    const m = await f.engine.ingest(f.inbound());
    const command = { conversationId: m.conversationId, text: '您好', requestId: 'rejection-race' };
    const sent = await f.engine.sendManual(command);
    expect(sent).toMatchObject({ status: 'rejected', error: refusal.reason, externalId: null });
    await f.engine.completeSend(sent.id, refusal);
    await f.engine.sendManual(command);
    expect(f.sends).toHaveLength(1);
    expect(await f.db.message.count({ where: { direction: 'out' } })).toBe(0);
    expect(await f.db.answeredTurn.count()).toBe(0);
    expect(await f.db.businessEvent.count()).toBe(0);
  });
  it('运行日志关联发送记录：生成成功与发送未知、迟到拒绝分别展示', async () => {
    const f = await init();
    f.setResponse({ status: 'unknown', reason: '拼多多请求尚未返回明确回执' });
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.engine.ingest(f.inbound());
    await flush(f.engine, f.db);
    const router = new Router(f.engine, f.ai as any);
    const activity = (await router.call('runs.list', { storeId: f.account.storeId })) as any;
    expect(activity.runs).toHaveLength(1);
    const run = activity.runs[0];
    expect(run).toMatchObject({
      status: 'succeeded',
      output: { action: 'reply' },
      outbounds: [
        {
          aiRunId: run.id,
          status: 'unknown',
          externalId: null,
          error: '拼多多请求尚未返回明确回执',
        },
      ],
    });
    expect(activity.outbounds[0].id).toBe(run.outbounds[0].id);
    expect(f.ai.replyCalls).toBe(1);
    expect(await f.db.answeredTurn.count()).toBe(0);
    const outbound = run.outbounds[0];
    await f.engine.completeSend(outbound.id, {
      status: 'rejected',
      reason: '拼多多拒绝发送：会话已关闭',
    });
    const updated = (await router.call('runs.list', { storeId: f.account.storeId })) as any;
    expect(updated.runs[0]).toMatchObject({
      status: 'succeeded',
      outbounds: [{ id: outbound.id, status: 'rejected', error: '拼多多拒绝发送：会话已关闭' }],
    });
    expect(await f.db.message.count({ where: { direction: 'out' } })).toBe(0);
    expect(await f.db.answeredTurn.count()).toBe(0);
    expect(f.sends).toHaveLength(1);
    expect(f.ai.replyCalls).toBe(1);
  });
  it('转人工提示回显与迟到回执只归档一次，不算人工作答或学习样本', async () => {
    const f = await init();
    f.ai.replyResult = { action: 'handoff', text: '', reasonCode: '买家要求人工', evidenceIds: [] };
    await f.engine.setPolicy({
      storeId: f.account.storeId,
      autoReplyEnabled: true,
      autoLearnEnabled: true,
    });
    const send = f.host.send;
    f.host.send = async (command) => {
      f.sends.push(command);
      const echo = await f.engine.ingest(
        f.inbound(command.text, {
          direction: 'out',
          origin: 'human',
          externalId: 'handoff-echo-first',
        }),
      );
      expect(echo.origin).toBe('unknown');
      return { status: 'unknown', reason: '回执延迟' };
    };
    const question = await f.engine.ingest(f.inbound('转人工'));
    await flush(f.engine, f.db);
    await waitFor(async () => (await f.db.outboundMessage.findFirst())?.status === 'unknown');
    const notice = await f.db.outboundMessage.findFirstOrThrow();
    expect(notice).toMatchObject({ status: 'unknown', origin: 'handoff_notice' });
    expect(await f.db.aiRun.findFirst()).toMatchObject({
      status: 'succeeded',
      output: { action: 'handoff', reasonCode: '买家要求人工' },
    });
    expect(await f.db.job.findFirst({ where: { kind: 'reply' } })).toMatchObject({
      status: 'succeeded',
      leaseToken: null,
    });
    await f.engine.dispatch(notice.id);
    const receipt = { status: 'confirmed' as const, externalId: 'handoff-echo-first' };
    await f.engine.completeSend(notice.id, receipt);
    await f.engine.completeSend(notice.id, receipt);
    await f.engine.ingest(
      f.inbound('已为您转人工，请稍候。', {
        direction: 'out',
        origin: 'human',
        externalId: receipt.externalId,
      }),
    );
    expect(f.sends).toHaveLength(1);
    expect(await f.db.message.count({ where: { direction: 'out' } })).toBe(1);
    expect(await f.db.message.findFirst({ where: { direction: 'out' } })).toMatchObject({
      origin: 'handoff_notice',
      associationStatus: 'none',
    });
    expect(await f.db.messageGroup.findFirst()).toMatchObject({
      state: 'waiting_answer',
      autoEligible: false,
    });
    expect(await f.db.answeredTurn.count()).toBe(0);
    expect(await f.db.businessEvent.count()).toBe(0);
    expect(f.ai.learnCalls).toBe(0);
    await f.engine.setOpened(question.conversationId);
    await f.engine.setOpened(null);
    expect(
      await f.db.conversation.findUnique({ where: { id: question.conversationId } }),
    ).toMatchObject({
      awaitingHuman: true,
      humanSentAfterHandoff: false,
    });
    // Only an actual answer creates a learning turn; ending reception requires an explicit release.
    f.host.send = send;
    await f.engine.setOpened(question.conversationId);
    await f.engine.sendManual({
      conversationId: question.conversationId,
      text: '您好，我来为您处理。',
      requestId: 'human-after-notice',
    });
    await f.engine.setOpened(null);
    await f.engine.setReception(question.conversationId, 'ai');
    expect(
      await f.db.conversation.findUnique({ where: { id: question.conversationId } }),
    ).toMatchObject({
      awaitingHuman: false,
    });
    expect(await f.db.answeredTurn.count()).toBe(1);
    expect(await f.db.turnAnswer.findFirst()).toMatchObject({ origin: 'human' });
    expect(await f.db.businessEvent.count()).toBe(1);
  });
  it('转人工提示被平台拒绝时保持等待人工，不改坏已完成的任务或重试模型', async () => {
    const f = await init();
    f.ai.replyResult = { action: 'handoff', text: '', reasonCode: '买家要求人工', evidenceIds: [] };
    f.setResponse({ status: 'rejected', reason: '平台拒绝发送' });
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const question = await f.engine.ingest(f.inbound('转人工'));
    await flush(f.engine, f.db);
    await waitFor(async () => (await f.db.outboundMessage.findFirst())?.status === 'rejected');
    await flush(f.engine, f.db);
    expect(await f.db.aiRun.findFirst()).toMatchObject({ status: 'succeeded', error: null });
    expect(await f.db.job.findFirst({ where: { kind: 'reply' } })).toMatchObject({
      status: 'succeeded',
    });
    expect(
      await f.db.conversation.findUnique({ where: { id: question.conversationId } }),
    ).toMatchObject({ awaitingHuman: true });
    expect(await f.db.outboundMessage.findFirst()).toMatchObject({ error: '平台拒绝发送' });
    expect(f.ai.replyCalls).toBe(1);
    expect(f.sends).toHaveLength(1);
    expect(await f.db.message.count({ where: { direction: 'out' } })).toBe(0);
    expect(await f.db.answeredTurn.count()).toBe(0);
  });
  it.each(['人工接管', '新消息', '关闭自动回复'] as const)(
    '转人工已提交但提示发送前发生%s，取消提示且不破坏转人工结果',
    async (change) => {
      const f = await init();
      f.ai.replyResult = {
        action: 'handoff',
        text: '',
        reasonCode: '需要人工核实',
        evidenceIds: [],
      };
      await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
      const question = await f.engine.ingest(f.inbound('转人工'));
      const dispatch = f.engine.dispatch.bind(f.engine);
      f.engine.dispatch = async (id) => {
        if (change === '人工接管') await f.engine.setReception(question.conversationId, 'human');
        if (change === '新消息') await f.engine.ingest(f.inbound('我有新问题'));
        if (change === '关闭自动回复')
          await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: false });
        return dispatch(id);
      };
      await flush(f.engine, f.db);
      await waitFor(async () => (await f.db.outboundMessage.findFirst())?.status === 'cancelled');
      expect(await f.db.aiRun.findFirst()).toMatchObject({ status: 'succeeded', error: null });
      expect(await f.db.job.findFirst({ where: { kind: 'reply' } })).toMatchObject({
        status: 'succeeded',
      });
      expect(await f.db.outboundMessage.findFirst()).toMatchObject({
        status: 'cancelled',
        origin: 'handoff_notice',
      });
      expect(
        await f.db.conversation.findUnique({ where: { id: question.conversationId } }),
      ).toMatchObject({ awaitingHuman: true });
      expect(f.sends).toHaveLength(0);
      expect(await f.db.answeredTurn.count()).toBe(0);
    },
  );
  it.each(['人工接管', '关闭自动回复'] as const)(
    '模型生成转人工意图期间%s，旧意图仍必须通过资格检查',
    async (change) => {
      const f = await init();
      f.ai.replyResult = {
        action: 'handoff',
        text: '',
        reasonCode: '需要人工核实',
        evidenceIds: [],
      };
      await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
      const question = await f.engine.ingest(f.inbound('转人工'));
      f.ai.beforeReply = async () => {
        if (change === '人工接管') await f.engine.setReception(question.conversationId, 'human');
        else await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: false });
      };
      await flush(f.engine, f.db);
      await waitFor(async () => (await f.db.aiRun.findFirst())?.status === 'failed');
      expect(await f.db.aiRun.findFirst()).toMatchObject({
        error: expect.stringContaining('STALE:'),
      });
      expect(
        await f.db.conversation.findUnique({ where: { id: question.conversationId } }),
      ).toMatchObject({ awaitingHuman: false });
      expect(await f.db.outboundMessage.count()).toBe(0);
      expect(f.sends).toHaveLength(0);
    },
  );
  it('高于阈值原文直答，不调用回复模型', async () => {
    const f = await init();
    const r = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
    f.ai.matches = [{ entryId: r.entryId, revisionId: r.id, intent: qa.intent, qa, score: 0.96 }];
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.engine.ingest(f.inbound());
    await flush(f.engine, f.db);
    expect(f.sends[0]?.text).toBe(qa.answer);
    expect(f.ai.replyCalls).toBe(0);
    expect((await f.db.aiRun.findFirst())?.path).toBe('direct_match');
  });
  it('问答直答不再进入学习；人工纠正后才评估', async () => {
    const f = await init();
    const r = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
    f.ai.matches = [{ entryId: r.entryId, revisionId: r.id, intent: qa.intent, qa, score: 0.96 }];
    await f.engine.setPolicy({
      storeId: f.account.storeId,
      autoReplyEnabled: true,
      autoLearnEnabled: true,
    });
    const m = await f.engine.ingest(f.inbound());
    await flush(f.engine, f.db);
    expect(f.sends[0]?.text).toBe(qa.answer);
    expect(f.ai.learnCalls).toBe(0);
    expect(await f.db.job.count({ where: { kind: 'learn' } })).toBe(0);
    expect(await f.db.answeredTurn.count()).toBe(1);
    await f.engine.sendManual({
      conversationId: m.conversationId,
      text: '改成当天发',
      requestId: 'correct-after-qa',
    });
    await flush(f.engine, f.db);
    await flush(f.engine, f.db);
    expect(f.ai.learnCalls).toBe(1);
  });
  it('等于阈值不直答，进入所绑定回复 Agent', async () => {
    const f = await init();
    const r = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
    f.ai.matches = [{ entryId: r.entryId, revisionId: r.id, intent: qa.intent, qa, score: 0.9 }];
    await f.engine.setPolicy({
      storeId: f.account.storeId,
      autoReplyEnabled: true,
      directMatchThreshold: 0.9,
    });
    await f.engine.ingest(f.inbound());
    await flush(f.engine, f.db);
    expect(f.ai.replyCalls).toBe(1);
    expect(f.sends).toHaveLength(1);
  });
  it.each(['completed', 'failed'] as const)(
    '预检索为 %s 时把原问题和检索状态交给 Agent，区分空结果与失败',
    async (status) => {
      const f = await init();
      const search = vi.spyOn(f.ai, 'search');
      if (status === 'failed') search.mockRejectedValueOnce(new Error('Embedding 不可用'));
      const reply = vi.spyOn(f.ai, 'reply');
      await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
      await f.engine.ingest(f.inbound('这款如何保养'));
      await flush(f.engine, f.db);
      expect(search).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0][0]).toMatchObject({
        question: '这款如何保养',
        knowledgeSearch: { query: '这款如何保养', status },
        matches: [],
      });
      expect(f.sends).toHaveLength(1);
    },
  );
  it('生成期间人工接管会话，旧结果不得发送', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const m = await f.engine.ingest(f.inbound());
    f.ai.beforeReply = () => f.engine.setReception(m.conversationId, 'human');
    await flush(f.engine, f.db);
    expect(f.ai.replyCalls).toBe(1);
    expect(f.sends).toHaveLength(0);
  });
  it('取消的旧问题不会因交还 AI 重新发送', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const m = await f.engine.ingest(f.inbound());
    await f.engine.setReception(m.conversationId, 'human');
    await f.engine.setReception(m.conversationId, 'ai');
    await flush(f.engine, f.db);
    expect(f.sends).toHaveLength(0);
  });
  it('发送期间中断恢复为 unknown，不能重放 dispatching', async () => {
    const f = await init();
    const m = await f.engine.ingest(f.inbound());
    const o = await f.db.outboundMessage.create({
      data: {
        intentKey: 'restore',
        conversationId: m.conversationId,
        storeId: f.account.storeId,
        accountId: f.account.id,
        routeVersion: 1,
        conversationRevision: 1,
        replyConfigEpoch: 1,
        origin: 'human',
        body: { text: 'test' },
        status: 'dispatching',
      },
    });
    await f.engine.initialize();
    expect((await f.db.outboundMessage.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(
      'unknown',
    );
    expect(f.sends).toHaveLength(0);
  });
});
describe('知识与人工审批', () => {
  it('人工编辑生成新修订，旧答案保留', async () => {
    const f = await init();
    const r = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
    const r2 = await f.engine.knowledge.save({
      storeId: f.account.storeId,
      entryId: r.entryId,
      expectedRevisionId: r.id,
      qa: { ...qa, answer: '72 小时内' },
    });
    expect(r2.version).toBe(2);
    expect((await f.db.knowledgeRevision.findUniqueOrThrow({ where: { id: r.id } })).answer).toBe(
      qa.answer,
    );
    await expect(
      f.engine.knowledge.save({
        storeId: f.account.storeId,
        entryId: r.entryId,
        expectedRevisionId: r.id,
        qa,
      }),
    ).rejects.toThrow('版本已变化');
  });
  it('人工确认回答进入内置学习，不产生自动批准', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
    f.ai.result = {
      ...f.ai.result,
      reuseVerdict: 'reusable',
      suggestions: [{ action: 'create_qa', qa, reason: '可复用人工回答' }],
    };
    const m = await f.engine.ingest(f.inbound());
    await f.engine.sendManual({
      conversationId: m.conversationId,
      text: qa.answer,
      requestId: 'human',
    });
    await flush(f.engine, f.db);
    await flush(f.engine, f.db);
    expect(f.ai.learnCalls).toBe(1);
    const c = await f.db.knowledgeCandidate.findFirstOrThrow();
    expect(c.status).toBe('pending_review');
    expect(await f.db.knowledgeRevision.count()).toBe(0);
    expect(await f.db.knowledgeReview.count()).toBe(0);
  });
  it('批准后才发布，重复批准和发布只生效一次', async () => {
    const f = await init();
    await makeCandidate(f);
    const c = await f.db.knowledgeCandidate.findFirstOrThrow();
    const input = {
      candidateId: c.id,
      candidateVersion: c.candidateVersion,
      contentHash: c.contentHash,
      decision: 'approved' as const,
      requestId: 'approve-1',
    };
    await f.engine.knowledge.review(input);
    await f.engine.knowledge.review(input);
    expect(await f.db.knowledgeRevision.count()).toBe(0);
    const change = await f.db.knowledgeChange.findFirstOrThrow();
    await f.engine.knowledge.apply(change.id);
    await f.engine.knowledge.apply(change.id);
    expect(await f.db.knowledgeRevision.count()).toBe(1);
    expect(await f.db.knowledgeReview.count()).toBe(1);
  });
  it('关闭学习仍能审批旧候选', async () => {
    const f = await init();
    await makeCandidate(f);
    await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: false });
    const c = await f.db.knowledgeCandidate.findFirstOrThrow();
    await f.engine.knowledge.review({
      candidateId: c.id,
      candidateVersion: c.candidateVersion,
      contentHash: c.contentHash,
      decision: 'approved',
      requestId: 'approve',
    });
    await f.engine.knowledge.apply((await f.db.knowledgeChange.findFirstOrThrow()).id);
    expect(await f.db.knowledgeRevision.count()).toBe(1);
  });
  it('拒绝不创建发布任务或正式知识', async () => {
    const f = await init();
    await makeCandidate(f);
    const c = await f.db.knowledgeCandidate.findFirstOrThrow();
    await f.engine.knowledge.review({
      candidateId: c.id,
      candidateVersion: c.candidateVersion,
      contentHash: c.contentHash,
      decision: 'rejected',
      requestId: 'reject',
    });
    expect(await f.db.knowledgeChange.count()).toBe(0);
    expect(await f.db.knowledgeRevision.count()).toBe(0);
  });
  it('批准后来源变化，旧批准不能发布', async () => {
    const f = await init();
    await makeCandidate(f);
    const c = await f.db.knowledgeCandidate.findFirstOrThrow();
    await f.engine.knowledge.review({
      candidateId: c.id,
      candidateVersion: c.candidateVersion,
      contentHash: c.contentHash,
      decision: 'approved',
      requestId: 'approve',
    });
    await f.db.answeredTurn.updateMany({ data: { sourceRevision: { increment: 1 } } });
    const change = await f.db.knowledgeChange.findFirstOrThrow();
    await f.engine.knowledge.apply(change.id);
    expect(await f.db.knowledgeRevision.count()).toBe(0);
    expect(
      (await f.db.knowledgeChange.findUniqueOrThrow({ where: { id: change.id } })).status,
    ).toBe('conflicted');
  });
  it('学习请求中关闭开关，不提交候选', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
    f.ai.result = { ...f.ai.result, suggestions: [{ action: 'create_qa', qa, reason: 'test' }] };
    f.ai.beforeLearn = () =>
      f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: false });
    const m = await f.engine.ingest(f.inbound());
    await f.engine.sendManual({
      conversationId: m.conversationId,
      text: '真实回答',
      requestId: 'a',
    });
    await flush(f.engine, f.db);
    await flush(f.engine, f.db);
    expect(f.ai.learnCalls).toBe(1);
    expect(await f.db.knowledgeCandidate.count()).toBe(0);
  });
});
describe('Agent 发布与工作选择', () => {
  it('草稿修改不切换接待；发布后已绑定该 Agent 的入口自动跟到最新版', async () => {
    const f = await init();
    const before = await f.engine.agents.resolve(f.account.storeId);
    const a = before!.revision.agentId;
    const draft = await f.db.agentDefinition.findUniqueOrThrow({ where: { id: a } });
    const saved = await f.engine.agents.save({
      id: a,
      expectedRevision: draft.draftRevision,
      config: { ...defaultConfig(f.model.id), prompt: '新指令' },
    });
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).toBe(
      before!.revision.id,
    );
    const published = await f.engine.agents.publish(a, saved.draftRevision);
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).toBe(published.id);
    const other = await f.engine.agents.save({
      config: { ...defaultConfig(f.model.id), name: '另一助手' },
    });
    await f.engine.agents.publish(other.id, other.draftRevision);
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).toBe(published.id);
  });
  it('草稿乐观锁拒绝过期写入', async () => {
    const f = await init();
    const a = (await f.engine.agents.list()).agents[0];
    await f.engine.agents.save({
      id: a.id,
      expectedRevision: a.draftRevision,
      config: defaultConfig(f.model.id),
    });
    await expect(
      f.engine.agents.save({
        id: a.id,
        expectedRevision: a.draftRevision,
        config: defaultConfig(f.model.id),
      }),
    ).rejects.toThrow('草稿已被修改');
  });
  it('删除默认 Agent 不因初始化重建，一键恢复新 ID 且不重复', async () => {
    const f = await init();
    const a = (await f.engine.agents.list()).agents[0];
    await f.engine.agents.remove(a.id);
    await f.engine.agents.initialize();
    expect((await f.engine.agents.list()).agents).toHaveLength(0);
    expect(await f.engine.agents.resolve(f.account.storeId)).toBeNull();
    await f.engine.agents.restoreDefault();
    await f.engine.agents.restoreDefault();
    const restored = (await f.engine.agents.list()).agents;
    expect(restored).toHaveLength(1);
    expect(restored[0].id).not.toBe(a.id);
  });
  it('店铺专用优先于全局，移除覆盖后继承', async () => {
    const f = await init();
    const a = await f.engine.agents.save({
      config: { ...defaultConfig(f.model.id), name: '专用' },
    });
    const rev = await f.engine.agents.publish(a.id, a.draftRevision);
    await f.engine.agents.bind({
      scopeKey: `store:${f.account.storeId}`,
      revisionId: rev.id,
      expectedRevision: null,
    });
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).toBe(rev.id);
    const saved = await f.engine.agents.save({
      id: a.id,
      expectedRevision: (await f.db.agentDefinition.findUniqueOrThrow({ where: { id: a.id } }))
        .draftRevision,
      config: { ...defaultConfig(f.model.id), name: '专用', prompt: '第二版' },
    });
    const next = await f.engine.agents.publish(a.id, saved.draftRevision);
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).toBe(next.id);
    expect(
      (await f.db.agentBinding.findUnique({ where: { scopeKey: 'global' } }))?.agentRevisionId,
    ).not.toBe(next.id);
    await f.engine.agents.bind({
      scopeKey: `store:${f.account.storeId}`,
      revisionId: null,
      expectedRevision: 2,
    });
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).not.toBe(rev.id);
  });
  it('工作绑定只能选择 Agent 的最新发布版本', async () => {
    const f = await init();
    const a = await f.engine.agents.save({
      config: { ...defaultConfig(f.model.id), name: '多版本' },
    });
    const v1 = await f.engine.agents.publish(a.id, a.draftRevision);
    const saved = await f.engine.agents.save({
      id: a.id,
      expectedRevision: (await f.db.agentDefinition.findUniqueOrThrow({ where: { id: a.id } }))
        .draftRevision,
      config: { ...defaultConfig(f.model.id), name: '多版本', prompt: '第二版' },
    });
    const v2 = await f.engine.agents.publish(a.id, saved.draftRevision);
    await expect(
      f.engine.agents.bind({
        scopeKey: 'global',
        revisionId: v1.id,
        expectedRevision:
          (await f.db.agentBinding.findUnique({ where: { scopeKey: 'global' } }))?.revision ?? null,
      }),
    ).rejects.toThrow('Agent 已重新发布，请刷新后选择');
    await f.engine.agents.bind({
      scopeKey: `store:${f.account.storeId}`,
      revisionId: v2.id,
      expectedRevision: null,
    });
    expect((await f.engine.agents.resolve(f.account.storeId))!.revision.id).toBe(v2.id);
  });
  it('子 Agent 的循环引用被拒绝发布', async () => {
    const f = await init();
    const a = (await f.engine.agents.list()).agents[0];
    const child = await f.engine.agents.save({
      config: {
        ...defaultConfig(f.model.id),
        name: 'child',
        subAgents: [{ alias: 'parent', revisionId: a.revisions[0].id }],
      },
    });
    const rev = await f.engine.agents.publish(child.id, child.draftRevision);
    const saved = await f.engine.agents.save({
      id: a.id,
      expectedRevision: a.draftRevision,
      config: { ...defaultConfig(f.model.id), subAgents: [{ alias: 'child', revisionId: rev.id }] },
    });
    await expect(f.engine.agents.publish(a.id, saved.draftRevision)).rejects.toThrow('环路');
  });
});
async function makeCandidate(f: Awaited<ReturnType<typeof setup>>) {
  await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  f.ai.result = {
    ...f.ai.result,
    reuseVerdict: 'reusable',
    suggestions: [{ action: 'create_qa', qa, reason: 'test' }],
  };
  const m = await f.engine.ingest(f.inbound());
  await f.engine.sendManual({
    conversationId: m.conversationId,
    text: qa.answer,
    requestId: 'human',
  });
  await flush(f.engine, f.db);
  await flush(f.engine, f.db);
}

describe('恢复和来源的补充边界', () => {
  it('重启取消尚未发送的自动回复，保留学习待办', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const m = await f.engine.ingest(f.inbound());
    await f.db.job.create({
      data: {
        kind: 'learn',
        storeId: f.account.storeId,
        dedupKey: 'durable-learning',
        payload: { turnId: 'later' },
        priority: 60,
      },
    });
    await f.engine.initialize();
    expect(await f.db.job.count({ where: { kind: 'reply', status: 'cancelled' } })).toBe(1);
    expect(
      (await f.db.messageGroup.findFirst({ where: { conversationId: m.conversationId } }))
        ?.autoEligible,
    ).toBe(false);
    expect((await f.db.job.findUnique({ where: { dedupKey: 'durable-learning' } }))?.status).toBe(
      'pending',
    );
  });
  it('多组未回答问题不再阻塞人工回复学习，交由 Agent 判断对应关系', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
    const firstMessage = await f.engine.ingest(f.inbound('价格是多少'));
    const first = await f.db.messageGroup.findFirstOrThrow();
    await f.db.messageGroup.update({ where: { id: first.id }, data: { createdAt: new Date(0) } });
    const secondMessage = await f.engine.ingest(f.inbound('什么时候发货'));
    const a = await f.engine.ingest(f.inbound('明天发货', { direction: 'out', origin: 'human' }));
    expect(await f.db.answeredTurn.count()).toBe(1);
    expect((await f.db.message.findUnique({ where: { id: a.id } }))?.associationStatus).toBe(
      'associated',
    );
    const turn = await f.db.answeredTurn.findFirstOrThrow({ include: { questionGroup: true } });
    expect(turn.associationMode).toBe('conversation_context');
    expect(turn.questionGroup.messageIds).toEqual([firstMessage.id, secondMessage.id]);
    expect(await f.db.businessEvent.count()).toBe(1);
    await flush(f.engine, f.db);
    expect(f.ai.learnCalls).toBe(1);
    expect(f.ai.learnInputs[0]).toMatchObject({
      associationMode: 'conversation_context',
      questions: [{ id: firstMessage.id }, { id: secondMessage.id }],
      answers: [{ message: { id: a.id } }],
    });
  });
  it('问题撤回使已有回合失效，不能保留旧学习来源', async () => {
    const f = await init();
    const original = f.inbound();
    const m = await f.engine.ingest(original);
    await f.engine.sendManual({
      conversationId: m.conversationId,
      text: '现货今天发',
      requestId: 'a',
    });
    await f.engine.ingest({ ...original, withdrawn: true, eventKey: 'withdrawn' });
    expect((await f.db.answeredTurn.findFirst())?.status).toBe('invalidated');
    expect((await f.db.answeredTurn.findFirst())?.sourceRevision).toBe(2);
  });
  it('切换配置时旧生成作废，使用新配置重排且只发送一次', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.engine.ingest(f.inbound());
    f.ai.beforeReply = async () => {
      f.ai.beforeReply = undefined;
      await f.engine.setPolicy({ storeId: f.account.storeId, directMatchThreshold: 0.95 });
    };
    await flush(f.engine, f.db);
    expect(f.ai.replyCalls).toBe(2);
    expect(f.sends).toHaveLength(1);
  });
  it('原生回显先到达时不误标人工，精确确认后仅形成一个回合', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.engine.ingest(f.inbound());
    f.host.send = async (c) => {
      f.sends.push(c);
      const message = await f.engine.ingest(
        f.inbound(c.text, { direction: 'out', origin: 'human', externalId: 'echo-first' }),
      );
      expect(message.origin).toBe('unknown');
      return { status: 'confirmed', externalId: 'echo-first' };
    };
    await flush(f.engine, f.db);
    expect(await f.db.answeredTurn.count()).toBe(1);
    expect((await f.db.turnAnswer.findFirst())?.origin).toBe('ai');
    expect(await f.db.message.count({ where: { externalId: 'echo-first' } })).toBe(1);
  });
});

it('暂停的大量学习任务不会阻塞知识发布与索引任务', async () => {
  const f = await init();
  await f.db.job.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({
      kind: 'learn',
      storeId: f.account.storeId,
      priority: 60,
      dedupKey: `paused-${i}`,
      payload: { turnId: 'missing' },
    })),
  });
  const r = await f.engine.knowledge.save({ storeId: f.account.storeId, qa });
  await f.engine.tick();
  await waitFor(async () => {
    await f.engine.tick();
    return !!(await f.db.job.findFirst({ where: { kind: 'index', status: 'succeeded' } }));
  });
  expect(await f.db.job.count({ where: { kind: 'learn', status: 'pending' } })).toBe(25);
});

it('消息通道重连更新持久状态和实时能力，但不会自动通过人工验收', async () => {
  const f = await init();
  await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
  const caps = {
    receive: true,
    sendText: true,
    sendImage: false,
    history: true,
    goods: true,
    orders: false,
    verified: true,
  };
  await f.engine.updateConnection({
    accountId: f.account.id,
    phase: 'waiting_sdk',
    reason: '等待监听',
    capabilities: { ...caps, receive: false, sendText: false },
  });
  expect((await f.db.account.findUniqueOrThrow({ where: { id: f.account.id } })).status).toBe(
    'offline',
  );
  await f.engine.updateConnection({
    accountId: f.account.id,
    phase: 'online',
    reason: '通道已连接',
    capabilities: caps,
  });
  const connected = await f.db.account.findUniqueOrThrow({ where: { id: f.account.id } });
  expect(connected.status).toBe('online');
  expect(connected.verifiedAt).toBeNull();
  expect(connected.capabilities).toMatchObject({ receive: true, sendText: true, verified: false });
  expect(
    (
      await f.db.appSetting.findUniqueOrThrow({
        where: { key: `platform.connection:${f.account.id}` },
      })
    ).value,
  ).toMatchObject({ phase: 'online', reason: '通道已连接' });
  await f.engine.markOffline(f.account.id);
  expect(
    (await f.db.account.findUniqueOrThrow({ where: { id: f.account.id } })).capabilities,
  ).toMatchObject({ receive: false, sendText: false });
  await expect(
    f.engine.updateConnection({
      accountId: f.account.id,
      phase: 'online',
      reason: 'bad',
      capabilities: { ...caps, receive: false },
    }),
  ).rejects.toThrow('尚未就绪');
});

describe('自动回复接入前置条件', () => {
  it('账号未验收时拒绝打开开关，策略和版本均不变；离线时给出独立的连接原因', async () => {
    const f = await init();
    await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
    const before = await f.db.replyPolicy.findUniqueOrThrow({
      where: { storeId: f.account.storeId },
    });
    await expect(
      f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true }),
    ).rejects.toThrow('系统设置 → 店铺接待 → 开启接待');
    expect(
      await f.db.replyPolicy.findUniqueOrThrow({ where: { storeId: f.account.storeId } }),
    ).toEqual(before);
    await f.engine.markOffline(f.account.id);
    await expect(
      f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true }),
    ).rejects.toThrow('消息通道未连接');
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: false });
    expect(f.ai.replyCalls).toBe(0);
    expect(f.sends).toHaveLength(0);
  });

  it('兼容历史已开开关：未验收消息不调用 AI，确认后即时更新能力且只回复新问题', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
    await f.engine.updateConnection({
      accountId: f.account.id,
      phase: 'online',
      reason: '测试通道',
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: true,
        orders: false,
        verified: false,
      },
    });
    const old = await f.engine.ingest(f.inbound('验收前问题'));
    await flush(f.engine, f.db);
    expect(await f.db.job.count({ where: { kind: 'reply' } })).toBe(0);
    expect(f.ai.replyCalls).toBe(0);
    const oldGroup = await f.db.messageGroup.findFirstOrThrow({
      where: { conversationId: old.conversationId },
    });
    expect(oldGroup.autoEligible).toBe(false);
    await f.engine.verifyAccount(f.account.id);
    const verified = await f.db.account.findUniqueOrThrow({ where: { id: f.account.id } });
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.capabilities).toMatchObject({ verified: true });
    expect(getAutoReplyReadiness([verified]).ready).toBe(true);
    expect(
      (
        await f.db.appSetting.findUniqueOrThrow({
          where: { key: `platform.connection:${f.account.id}` },
        })
      ).value,
    ).toMatchObject({ capabilities: { verified: true } });
    await flush(f.engine, f.db);
    expect(f.sends).toHaveLength(0);
    await f.engine.ingest(f.inbound('验收后新问题'));
    await flush(f.engine, f.db);
    expect(f.ai.replyCalls).toBe(1);
    expect(f.sends).toHaveLength(1);
    const outbound = await f.db.outboundMessage.findFirstOrThrow();
    expect(outbound.questionGroupId).not.toBe(oldGroup.id);
    expect(outbound.status).toBe('confirmed');
  });

  it('任务排队后账号不再具备验收条件，只失败一次，不反复调度或调用模型', async () => {
    const f = await init();
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.engine.ingest(f.inbound());
    await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
    await flush(f.engine, f.db);
    const job = await f.db.job.findFirstOrThrow({ where: { kind: 'reply' } });
    expect(job).toMatchObject({
      status: 'failed',
      attempts: 1,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(job.error).toContain('验收确认');
    await flush(f.engine, f.db);
    expect((await f.db.job.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(1);
    expect(f.ai.replyCalls).toBe(0);
    expect(f.sends).toHaveLength(0);
  });

  it('同店铺已验收账号不能替未验收账号取得自动接待资格', async () => {
    const f = await init();
    const second = await f.engine.registerAccount({
      partition: 'persist:unverified',
      mallId: 'mall-a',
      mallName: '测试店铺',
      externalId: 'cs-unverified',
      name: '未验收客服',
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        history: true,
        goods: false,
        orders: false,
        verified: false,
      },
    });
    await f.engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    await f.engine.ingest(f.inbound('未验收账号接到的消息', { accountId: second.id }));
    await flush(f.engine, f.db);
    expect(await f.db.job.count({ where: { kind: 'reply' } })).toBe(0);
    expect(f.sends).toHaveLength(0);
    expect(getAutoReplyReadiness(await f.db.account.findMany()).reason).toContain('1 / 2');
  });

  it('验收核验失败不会写入验证记录', async () => {
    const f = await init();
    await f.db.account.update({ where: { id: f.account.id }, data: { verifiedAt: null } });
    f.host.verify = async () => {
      throw new Error('登录身份已改变');
    };
    await expect(f.engine.verifyAccount(f.account.id)).rejects.toThrow('登录身份已改变');
    expect(
      (await f.db.account.findUniqueOrThrow({ where: { id: f.account.id } })).verifiedAt,
    ).toBeNull();
    expect(await f.db.auditEvent.count({ where: { type: 'account.verified' } })).toBe(0);
  });
});
