import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup, flush, waitFor } from './helpers';
import { normalizeDouyinQuery } from '../packages/platforms/src/douyin/queries';
import { douyinGoods } from './fixtures-douyin-query';
import { MastraAi } from '../packages/ai/src';
import { Engine } from '../packages/core/src/engine';
let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let engine: Engine | undefined;
let server: Server | undefined;
afterEach(async () => {
  await engine?.stop();
  await ai?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await f?.cleanup();
  f = undefined;
  ai = undefined;
  engine = undefined;
  server = undefined;
});
it.each([false, true])(
  '实际 Mastra 同一助手按店铺路由、问答隔离及商品错误诊断（失败=%s）',
  async (failDouyin) => {
    f = await setup();
    const errors: unknown[] = [],
      requests: any[] = [];
    server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests.push(body);
        const system = body.messages
          .filter((m: any) => m.role === 'system')
          .map((m: any) => m.content)
          .join('\n');
        const dy = system.includes('当前平台：抖店');
        expect(system).toContain(dy ? '当前平台：抖店' : '当前平台：拼多多');
        const tools = body.tools.map((tool: any) => tool.function.name);
        const goods = ai!.assets.alias('builtin/commerce/goods');
        expect(tools).toContain(goods);
        const goodsTool = body.tools.find((tool: any) => tool.function.name === goods).function;
        expect(Object.hasOwn(goodsTool.parameters.properties, 'keyword')).toBe(dy);
        expect(goodsTool.parameters.additionalProperties).toBe(false);
        expect(goodsTool.description).toContain(dy ? '可用 keyword 搜索' : '不要传 keyword');
        const ordersTool = body.tools.find(
          (tool: any) => tool.function.name === ai!.assets.alias('builtin/commerce/buyer-orders'),
        ).function;
        expect(Object.hasOwn(ordersTool.parameters.properties, 'keyword')).toBe(dy);
        expect(tools.some((name: string) => name.startsWith('builtin_pdd_'))).toBe(false);
        expect(tools.includes(ai!.assets.alias('builtin/commerce/goods-skus'))).toBe(!dy);
        expect(JSON.stringify(body.messages)).not.toContain(
          dy ? '问题_PDD_ONLY' : '问题_DOUYIN_ONLY',
        );
        const result = body.messages.findLast((m: any) => m.role === 'tool');
        if (result)
          expect(JSON.parse(result.content).data.products[0].title).toBe(
            dy ? '抖店独有商品' : '拼多多独有商品',
          );
        const delta = result
          ? { content: dy ? '本店商品：抖店独有商品' : '本店商品：拼多多独有商品' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${dy ? 'dy' : 'pdd'}`,
                  type: 'function',
                  function: {
                    name: goods,
                    arguments: JSON.stringify(
                      Object.hasOwn(goodsTool.parameters.properties, 'keyword')
                        ? { keyword: '独有商品' }
                        : {},
                    ),
                  },
                },
              ],
            };
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
                choices: [{ index: 0, delta: {}, finish_reason: result ? 'stop' : 'tool_calls' }],
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
              created: 1,
              model: 'fixture',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', ...delta },
                  finish_reason: result ? 'stop' : 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
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
      data: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'fixture',
        timeoutMs: 10000,
        revision: { increment: 1 },
      },
    });
    await f.engine.agents.setDefaultModel(f.model.id);
    const dy = await f.engine.registerAccount({
      platform: 'douyin',
      mallId: 'mall-a',
      mallName: '抖店测试店',
      partition: 'persist:dy-agent',
      externalId: 'cs-a',
      name: '抖店客服',
      capabilities: {
        receive: true,
        sendText: true,
        sendImage: false,
        goods: true,
        history: true,
        orders: true,
        verified: false,
      },
    });
    await f.db.account.update({ where: { id: dy.id }, data: { verifiedAt: new Date() } });
    const queries: Array<{ accountId: string; input: Record<string, unknown> }> = [];
    f.host.query = async (accountId, operation, input) => {
      queries.push({ accountId, input });
      const isDy = accountId === dy.id;
      expect(input.buyerId).toBe('buyer-a');
      expect(input.keyword).toBe(isDy ? '独有商品' : undefined);
      if (isDy) {
        expect(input.conversationKey).toBe('opaque-dy-conversation');
        const raw = structuredClone(douyinGoods);
        raw.data[0].product_item.product_base_info.title = '抖店独有商品';
        if (failDouyin) raw.data[0].product_item.product_id = '';
        return normalizeDouyinQuery('goods', raw, {}, 'buyer-a');
      }
      return {
        operation,
        queriedAt: new Date().toISOString(),
        partial: false,
        failedSections: [],
        data: {
          products: [
            { goodsId: isDy ? '2' : '1', title: isDy ? '抖店独有商品' : '拼多多独有商品' },
          ],
        },
      };
    };
    ai = new MastraAi(f.db, f.dir, f.host);
    await ai.initialize();
    ai.search = async () => [];
    engine = new Engine(f.db, f.dir, f.host, ai);
    await engine.initialize();
    for (const account of [f.account, dy]) {
      await engine.updateConnection({
        accountId: account.id,
        phase: 'online',
        reason: '测试已连接',
        capabilities: {
          receive: true,
          sendText: true,
          sendImage: false,
          goods: true,
          history: true,
          orders: true,
          orderRemark: account.id !== dy.id,
          verified: true,
        },
      });
      await engine.setPolicy({ storeId: account.storeId, autoReplyEnabled: true });
    }
    const bindings = await Promise.all([
      engine.agents.resolve(f.account.storeId),
      engine.agents.resolve(dy.storeId),
    ]);
    expect(bindings[0]!.revision.id).toBe(bindings[1]!.revision.id);
    await engine.ingest(f.inbound('查商品问题_PDD_ONLY'));
    await engine.ingest(
      f.inbound('查商品问题_DOUYIN_ONLY', {
        accountId: dy.id,
        conversationKey: 'opaque-dy-conversation',
        platformContext: { userId: 'buyer-a', securityUserId: 'secured-buyer' },
      }),
    );
    await flush(engine, f.db);
    const runs = await f.db.aiRun.findMany({ where: { role: 'reply' } });
    expect(errors).toEqual([]);
    expect(
      runs.map((r) => r.status),
      JSON.stringify(runs.map((r) => ({ error: r.error, usage: r.usage }))),
    ).toEqual(['succeeded', failDouyin ? 'failed' : 'succeeded']);
    await waitFor(async () => f!.sends.length === (failDouyin ? 1 : 2));
    if (failDouyin) {
      const run = runs.find((r) => r.storeId === dy.storeId)!;
      expect(run.error).toContain('平台工具 goods 执行失败：抖店商品数据缺少有效的商品 ID');
      expect(run.usage).toMatchObject({
        platformErrors: [{ operation: 'goods', message: expect.stringContaining('缺少有效') }],
      });
      expect(f.sends.find((s) => s.accountId === dy.id)).toBeUndefined();
    } else {
      expect(f.sends.find((s) => s.accountId === dy.id)).toMatchObject({
        text: '本店商品：抖店独有商品',
        conversationKey: 'opaque-dy-conversation',
      });
    }
    expect(f.sends.find((s) => s.accountId === f!.account.id)).toMatchObject({
      text: '本店商品：拼多多独有商品',
    });
    expect(queries).toHaveLength(2);
    expect(requests).toHaveLength(failDouyin ? 3 : 4); // tool decision + final answer per shop, no router/formatter LLM
    const evidence = await f.db.platformEvidence.findMany();
    expect(evidence).toHaveLength(failDouyin ? 1 : 2);
    for (const record of evidence)
      expect(record.storeId).toBe(record.accountId === dy.id ? dy.storeId : f.account.storeId);
  },
  20000,
);
