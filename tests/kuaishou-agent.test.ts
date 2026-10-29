import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup, flush, waitFor } from './helpers';
import { MastraAi } from '../packages/ai/src';
import { Engine } from '../packages/core/src/engine';
import { normalizeKuaishouQuery } from '../packages/platforms/src/kuaishou/queries';
import { kuaishouOrders } from './fixtures-kuaishou';
let f: Awaited<ReturnType<typeof setup>>, ai: MastraAi, engine: Engine, server: Server;
afterEach(async () => {
  await engine?.stop();
  await ai?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await f?.cleanup();
});
it('实际 Mastra 快手订单工具调用、证据入库、自动发送，不增加平台选择或格式化模型请求', async () => {
  f = await setup();
  const errors: unknown[] = [],
    requests: any[] = [],
    queries: any[] = [];
  server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      expect(
        body.messages
          .filter((m: any) => m.role === 'system')
          .map((m: any) => m.content)
          .join('\n'),
      ).toContain('当前平台：快手');
      const tools = body.tools.map((t: any) => t.function.name),
        toolName = ai.assets.alias('builtin/commerce/buyer-orders');
      expect(tools).toContain(toolName);
      for (const op of ['goods', 'ship-order', 'order-remark', 'send-video', 'staff-groups'])
        expect(tools).not.toContain(ai.assets.alias(`builtin/commerce/${op}`));
      const evidence = body.messages.findLast((m: any) => m.role === 'tool');
      if (evidence)
        expect(JSON.parse(evidence.content).data.orders[0]).toMatchObject({
          productTitle: '快手测试水杯',
          orderRef: expect.stringMatching(/^order:/),
        });
      const delta = evidence
        ? { content: '查到您在本店的水杯订单，实付25元。' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'ks-order',
                type: 'function',
                function: { name: toolName, arguments: '{}' },
              },
            ],
          };
      const finish = evidence ? 'stop' : 'tool_calls';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const part of [
          { delta: { role: 'assistant', ...delta }, finish_reason: null },
          { delta: {}, finish_reason: finish },
        ])
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fixture',
                object: 'chat.completion.chunk',
                model: 'fixture',
                created: 1,
                choices: [{ index: 0, ...part }],
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
              { index: 0, message: { role: 'assistant', ...delta }, finish_reason: finish },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
      }
    } catch (e) {
      errors.push(e);
      res.statusCode = 500;
      res.end('fixture failed');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: {
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      revision: { increment: 1 },
    },
  });
  await f.engine.agents.setDefaultModel(f.model.id);
  const caps = {
    receive: true,
    sendText: true,
    sendImage: true,
    history: true,
    goods: false,
    orders: true,
    buyerProfile: true,
    staffGroups: true,
    verified: true,
  };
  const a = await f.engine.registerAccount({
    platform: 'kuaishou',
    mallId: '100',
    mallName: '快手店',
    externalId: '101',
    name: '快手客服',
    partition: 'persist:ks-agent',
    capabilities: caps,
  });
  await f.db.account.update({ where: { id: a.id }, data: { verifiedAt: new Date() } });
  f.host.query = async (accountId, operation, input) => {
    queries.push({ accountId, operation, input });
    expect(accountId).toBe(a.id);
    expect(input.buyerId).toBe('200');
    expect(input.conversationKey).toBe('0_200');
    return normalizeKuaishouQuery('buyer-orders', kuaishouOrders, {}, '200');
  };
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  ai.search = async () => [];
  engine = new Engine(f.db, f.dir, f.host, ai);
  await engine.initialize();
  await engine.updateConnection({
    accountId: a.id,
    phase: 'online',
    reason: 'fixture',
    capabilities: caps,
  });
  await engine.setPolicy({ storeId: a.storeId, autoReplyEnabled: true });
  await engine.ingest(
    f.inbound('查一下水杯订单', {
      accountId: a.id,
      buyerId: '200',
      conversationKey: '0_200',
      platformContext: { userId: '200', sessionType: 0, sellerId: '100' },
    }),
  );
  await flush(engine, f.db);
  expect(errors).toEqual([]);
  const runs = await f.db.aiRun.findMany({ where: { role: 'reply', storeId: a.storeId } });
  expect(runs.map((r) => ({ status: r.status, error: r.error }))).toEqual([
    { status: 'succeeded', error: null },
  ]);
  await waitFor(async () => f.sends.length === 1);
  expect(f.sends[0]).toMatchObject({
    accountId: a.id,
    buyerId: '200',
    conversationKey: '0_200',
    text: '查到您在本店的水杯订单，实付25元。',
  });
  expect(requests).toHaveLength(2);
  expect(queries).toHaveLength(1);
  expect(await f.db.platformEvidence.findFirst()).toMatchObject({
    accountId: a.id,
    storeId: a.storeId,
  });
}, 20000);
