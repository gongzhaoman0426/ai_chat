import { afterEach, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
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

// Answers one OpenAI-compatible completion, streamed or not, with either a tool call or text.
function respond(res: ServerResponse, stream: boolean, message: Record<string, unknown>) {
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  if (!stream) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
        usage,
      }),
    );
  }
  const chunk = (choice: Record<string, unknown>, extra = {}) =>
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = message.tool_calls
    ? {
        role: 'assistant',
        tool_calls: (message.tool_calls as any[]).map((t, index) => ({ index, ...t })),
      }
    : { role: 'assistant', content: message.content };
  res.write(chunk({ delta, finish_reason: null }));
  res.write(chunk({ delta: {}, finish_reason: finish }, { usage }));
  res.end('data: [DONE]\n\n');
}

async function start(delays: number[]) {
  f = await setup();
  let calls = 0;
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const round = calls++;
    await new Promise((r) => setTimeout(r, delays[round] ?? 0));
    if (res.destroyed) return;
    respond(
      res,
      !!body.stream,
      round === 0
        ? {
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: ai.assets.alias('builtin/commerce/goods'),
                  arguments: '{}',
                },
              },
            ],
          }
        : { content: '有现货的，付款后 48 小时内发货。' },
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      timeoutMs: 1000,
    },
  });
  await f.db.store.update({ where: { id: f.account.storeId }, data: { platform: 'douyin' } });
  f.host.query = async (_account, operation) => ({
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: { products: [{ goodsId: '123456', title: '保温杯' }] },
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
  const message = await engine.ingest(f.inbound('这款保温杯有货吗'));
  await flush(engine, f.db);
  return {
    calls: () => calls,
    run: await f.db.aiRun.findFirstOrThrow({
      where: { conversationId: message.conversationId, role: 'reply' },
    }),
  };
}

it('超时按单轮计算：每轮都在时限内时，多轮总耗时超过时限也能完成回复', async () => {
  const { run, calls } = await start([700, 700]);
  expect(calls()).toBe(2);
  expect(run, JSON.stringify(run)).toMatchObject({ status: 'succeeded' });
  expect(f.sends.map((s) => s.text)).toEqual(['有现货的，付款后 48 小时内发货。']);
});

it('单轮超过时限时停止自动发送，并说明是第几轮超时', async () => {
  const { run } = await start([1500]);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('第 1 轮模型调用超过 1 秒未返回');
  expect(f.sends).toEqual([]);
});
