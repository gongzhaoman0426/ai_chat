import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup, flush, waitFor } from './helpers';
import { MastraAi } from '../packages/ai/src/index';
import { Engine } from '../packages/core/src/engine';
import { defaultConfig } from '../packages/agent-config/src/index';
import { normalizePddQuery } from '../packages/platforms/src/pdd/queries';
import { executeOrderRemark } from '../packages/platforms/src/pdd/order-remark';
import { buildLearningEvidence } from '../packages/core/src/learning-evidence';
import type { OrderRemarkState } from '../packages/contracts/src/pdd-tools';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let runtime: Engine | undefined;
let server: Server | undefined;
afterEach(async () => {
  await runtime?.stop();
  await ai?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await f?.cleanup();
  f = undefined;
  ai = undefined;
  runtime = undefined;
  server = undefined;
});

it.each(['confirmed', 'unknown', 'rejected'])(
  '实际 Mastra → v2 订单工具（%s）：仅 confirmed 发送确认正文，其余本机转人工且无额外模型请求',
  async (outcome) => {
    f = await setup();
    const requests: any[] = [];
    const errors: unknown[] = [];
    let calls = 0,
      writes = 0;
    let state: OrderRemarkState = { remark: '旧备注', tag: 1, tagName: '红色' };
    server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests.push(body);
        calls++;
        const tools = body.tools.map((t: any) => t.function.name);
        expect(tools).toContain(ai!.assets.alias('builtin/commerce/buyer-orders'));
        expect(tools).toContain(ai!.assets.alias('builtin/commerce/order-remark'));
        expect(tools).not.toContain('moveconv');
        let tool: string | undefined, args: unknown;
        if (calls === 1) {
          tool = ai!.assets.alias('builtin/commerce/buyer-orders');
          args = {};
        }
        if (calls === 2) {
          const message = body.messages.findLast((m: any) => m.role === 'tool');
          const result = JSON.parse(message.content);
          expect(result.data.orders[0].orderRef).toMatch(/^order:/);
          tool = ai!.assets.alias('builtin/commerce/order-remark');
          args = { orderRef: result.data.orders[0].orderRef, note: '请加固包装' };
        }
        if (calls === 3) {
          const message = body.messages.findLast((m: any) => m.role === 'tool');
          expect(JSON.parse(message.content)).toMatchObject({ status: 'confirmed' });
        }
        const delta = tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${calls}`,
                  type: 'function',
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { content: '已经为您的订单备注加固包装。' };
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'fixture',
                choices: [
                  { index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null },
                ],
              }) +
              '\n\n',
          );
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'fixture',
                choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              }) +
              '\n\n',
          );
          res.end('data: [DONE]\n\n');
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion',
              model: 'fixture',
              created: 1,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', ...delta },
                  finish_reason: tool ? 'tool_calls' : 'stop',
                },
              ],
            }),
          );
        }
      } catch (error) {
        errors.push(error);
        res.statusCode = 500;
        res.end('fixture assertion failed');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    await f.db.modelProfile.update({
      where: { id: f.model.id },
      data: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'glm-5.3-flash', provider: 'openai' },
    });
    await f.db.account.update({
      where: { id: f.account.id },
      data: {
        capabilities: {
          receive: true,
          sendText: true,
          sendImage: true,
          goods: true,
          history: true,
          orders: true,
          orderRemark: true,
          verified: true,
        },
      },
    });
    f.host.query = async (_account, operation, input) => {
      expect(operation).toBe('buyer-orders');
      expect(input.buyerId).toBe('buyer-a');
      return normalizePddQuery(
        'buyer-orders',
        {
          success: true,
          result: {
            orders: [
              {
                orderSn: '260908-12345',
                orderStatusStr: '待发货',
                orderGoodsList: { goodsId: '12345', goodsName: '纯棉短袖' },
              },
            ],
            total: 1,
          },
        },
        { page: input.page, pageSize: input.pageSize },
        'buyer-a',
      );
    };
    f.host.executeAction = (command, authorize) =>
      executeOrderRemark(command, {
        ownsOrder: async () => true,
        read: async () => ({ ...state }),
        authorize,
        write: async (next) => {
          writes++;
          if (outcome === 'rejected') return { success: false };
          if (outcome === 'unknown') throw new Error('platform timeout');
          state = { ...next };
          return { success: true };
        },
      });
    ai = new MastraAi(f.db, f.dir, f.host);
    await ai.initialize();
    runtime = new Engine(f.db, f.dir, f.host, ai);
    const draft = await runtime.agents.save({ config: defaultConfig(f.model.id) });
    const revision = await runtime.agents.publish(draft.id, draft.draftRevision);
    await runtime.agents.bind({
      scopeKey: `store:${f.account.storeId}`,
      revisionId: revision.id,
      expectedRevision: null,
    });
    await runtime.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const question = await runtime.ingest(f.inbound('我的那件短袖，请给订单备注加固包装'));
    await flush(runtime, f.db);
    const run = await f.db.aiRun.findFirstOrThrow({
      where: { conversationId: question.conversationId, role: 'reply' },
    });
    expect(errors).toEqual([]);
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'succeeded' });
    await waitFor(
      async () =>
        (await f!.db.outboundMessage.findFirst({ where: { aiRunId: run.id } }))?.status ===
        'confirmed',
    );
    expect(calls).toBe(outcome === 'confirmed' ? 3 : 2);
    expect(writes).toBe(1);
    expect(state).toEqual({
      remark: outcome === 'confirmed' ? '旧备注\n请加固包装' : '旧备注',
      tag: 1,
      tagName: '红色',
    });
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].text).toBe(
      outcome === 'confirmed' ? '已经为您的订单备注加固包装。' : '已为您转人工，请稍候。',
    );
    const facts = await f.db.platformEvidence.findMany({ where: { runId: run.id } });
    expect(facts.map((fact) => fact.operation).sort()).toEqual(['buyer-orders', 'order-remark']);
    expect((run.output as any).evidenceIds).toEqual(
      expect.arrayContaining(facts.map((fact) => fact.id)),
    );
    if (outcome !== 'confirmed') {
      expect((run.output as any).action).toBe('handoff');
      expect(
        await f.db.conversation.findUnique({ where: { id: question.conversationId } }),
      ).toMatchObject({ awaitingHuman: true });
      return;
    }
    const answer = await f.db.message.findFirstOrThrow({
      where: { conversationId: question.conversationId, direction: 'out' },
    });
    const learning = await buildLearningEvidence(f.db, {
      storeId: f.account.storeId,
      conversationId: question.conversationId,
      questions: [question],
      answers: [answer],
      context: [],
      knowledge: [],
      runs: [run],
    });
    expect(learning.input.platformFacts).toHaveLength(2);
    expect(learning.diagnostics.omittedReplyRefs).toEqual([]);
  },
);
