import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup, flush } from './helpers';
import { MastraAi } from '../packages/ai/src';
import { Engine } from '../packages/core/src/engine';
import { defaultConfig } from '../packages/agent-config/src';
let f: Awaited<ReturnType<typeof setup>>, ai: MastraAi, engine: Engine, server: Server;
afterEach(async () => {
  await engine?.stop();
  await ai?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await f?.cleanup();
});
it.each(['product_card', 'video', 'review_card'] as const)(
  '实际 Mastra 查询后发送 %s，发送终止本轮，无额外模型请求、重复文本或 STALE',
  async (kind) => {
    f = await setup();
    let calls = 0;
    const errors: unknown[] = [];
    server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const c of req) raw += c;
        const body = JSON.parse(raw);
        calls++;
        expect(calls).toBeLessThanOrEqual(2);
        expect(body.tools.map((t: any) => t.function.name)).not.toContain(
          ai.assets.alias('builtin/commerce/platform-replies'),
        );
        const op =
          calls === 1
            ? kind === 'review_card'
              ? 'buyer-orders'
              : kind === 'video'
                ? 'video-materials'
                : 'goods'
            : kind === 'review_card'
              ? 'invite-review'
              : kind === 'video'
                ? 'send-video'
                : 'send-product-card';
        const previous =
          calls === 2
            ? JSON.parse(body.messages.findLast((m: any) => m.role === 'tool').content)
            : null;
        const args =
          calls === 1
            ? {}
            : kind === 'review_card'
              ? { orderRef: previous.data.orders[0].orderRef }
              : kind === 'video'
                ? { materialRef: previous.data.materials[0].materialRef }
                : { productRef: previous.data.products[0].productRef };
        const tool = {
          id: `call-${calls}`,
          type: 'function',
          function: {
            name: ai.assets.alias(`builtin/commerce/${op}`),
            arguments: JSON.stringify(args),
          },
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
                  {
                    index: 0,
                    delta: { role: 'assistant', tool_calls: [{ index: 0, ...tool }] },
                    finish_reason: null,
                  },
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
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
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
                  message: { role: 'assistant', tool_calls: [tool] },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
          );
        }
      } catch (e) {
        errors.push(e);
        res.statusCode = 500;
        res.end('fixture failure');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    await f.db.modelProfile.update({
      where: { id: f.model.id },
      data: {
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: 'glm-5.3-flash',
        provider: 'openai',
      },
    });
    await f.db.store.update({ where: { id: f.account.storeId }, data: { platform: 'douyin' } });
    await f.db.account.update({
      where: { id: f.account.id },
      data: {
        capabilities: {
          receive: true,
          sendText: true,
          sendImage: true,
          goods: true,
          orders: true,
          history: true,
          verified: true,
          sendProductCard: true,
          sendVideo: true,
          videoMaterials: true,
          quickActions: true,
        },
      },
    });
    f.host.query = async (_account, operation, input) => ({
      operation,
      queriedAt: new Date().toISOString(),
      partial: false,
      failedSections: [],
      ...(operation === 'buyer-orders' ? { subjectId: String(input.buyerId) } : {}),
      data:
        operation === 'buyer-orders'
          ? { orders: [{ orderSn: '123456789', statusText: '已完成' }] }
          : operation === 'goods'
            ? { products: [{ goodsId: '123456', title: '安装椅' }] }
            : {
                materials: [
                  {
                    kind: 'video',
                    materialId: '1',
                    title: '教程',
                    videoId: 'v1',
                    width: 1280,
                    height: 720,
                    coverUrl: 'https://p.byteimg.com/c.jpg',
                    duration: 3,
                    sendable: true,
                  },
                ],
              },
    });
    ai = new MastraAi(f.db, f.dir, f.host);
    await ai.initialize();
    engine = new Engine(f.db, f.dir, f.host, ai);
    const draft = await engine.agents.save({ config: defaultConfig(f.model.id) });
    const revision = await engine.agents.publish(draft.id, draft.draftRevision);
    await engine.agents.bind({
      scopeKey: `store:${f.account.storeId}`,
      revisionId: revision.id,
      expectedRevision: null,
    });
    await engine.setPolicy({ storeId: f.account.storeId, autoReplyEnabled: true });
    const message = await engine.ingest(
      f.inbound(
        kind === 'review_card' ? '订单已收到，在哪里评价？' : '给我发一下商品卡片或安装视频',
      ),
    );
    await flush(engine, f.db);
    const run = await f.db.aiRun.findFirstOrThrow({
      where: { conversationId: message.conversationId, role: 'reply' },
    });
    expect(errors).toEqual([]);
    expect(run, JSON.stringify(run)).toMatchObject({
      status: 'succeeded',
      output: { action: 'ignore', reasonCode: 'platform_message_sent' },
    });
    expect(calls).toBe(2);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].kind).toBe(kind);
    expect(
      await f.db.messageGroup.findFirst({ where: { conversationId: message.conversationId } }),
    ).toMatchObject({ state: 'answered' });
    expect(await f.db.turnAnswer.count()).toBe(1);
  },
);
