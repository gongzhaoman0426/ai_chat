import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

// Real Electron utility-process RPC, with only the temporary profile's PDD transport mocked.
export async function checkPddToolkit({ app, page, dbFile }) {
  const db = createClient({ url: pathToFileURL(dbFile).href });
  const account = (
    await db.execute("SELECT status,capabilities,verifiedAt FROM Account WHERE id='demo-account'")
  ).rows[0];
  const policy = (
    await db.execute("SELECT autoReplyEnabled FROM ReplyPolicy WHERE storeId='demo-store'")
  ).rows[0];
  const oldBinding = (
    await db.execute("SELECT * FROM AgentBinding WHERE scopeKey='store:demo-store'")
  ).rows[0];
  let calls = 0;
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      calls++;
      const findTool = (name) =>
        body.tools.find(
          (t) =>
            t.function.name.startsWith(`builtin_commerce_${name}_`) &&
            (name !== 'order_remark' || !t.function.name.includes('order_remark_state')),
        ).function.name;
      let name, input;
      if (calls === 1) {
        name = findTool('buyer_orders');
        input = {};
      }
      if (calls === 2) {
        const source = JSON.parse(body.messages.findLast((m) => m.role === 'tool').content);
        name = findTool('order_remark');
        input = { orderRef: source.data.orders[0].orderRef, note: '请加固包装' };
      }
      if (calls === 3) {
        assert.equal(
          JSON.parse(body.messages.findLast((m) => m.role === 'tool').content).status,
          'confirmed',
        );
      }
      assert.ok(calls <= 3, 'no extra review/repair model request');
      const delta = name
        ? {
            tool_calls: [
              {
                index: 0,
                id: `pdd-${calls}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          }
        : { content: '已经为您备注加固包装。' };
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'pdd-fixture',
            object: 'chat.completion',
            model: 'fixture',
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', ...delta },
                finish_reason: name ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'pdd-fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: 'pdd-fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1, choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    } catch (e) {
      failures.push(e);
      res.statusCode = 500;
      res.end('fixture failed');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await app.evaluate(() => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const original = EventEmitter.prototype.emit;
    const state = {
      original,
      worker: null,
      queries: 0,
      sends: [],
      guards: 0,
      pending: new Map(),
      writes: 0,
    };
    globalThis.__pddToolkitSmoke = state;
    EventEmitter.prototype.emit = function (event, ...args) {
      const data = args[0];
      if (
        event === 'message' &&
        data?.type === 'result' &&
        typeof this.postMessage === 'function'
      ) {
        state.worker = this;
        const pending = state.pending.get(data.id);
        if (pending) {
          state.pending.delete(data.id);
          if (data.ok) {
            state.guards++;
            state.writes++;
          }
          this.postMessage({
            type: 'hostResult',
            id: pending.hostId,
            ok: data.ok,
            ...(data.ok
              ? {
                  result: {
                    status: 'confirmed',
                    reasonCode: 'readback_confirmed',
                    message: '夹具已确认',
                  },
                }
              : { error: data.error }),
          });
          return true;
        }
      }
      if (event === 'message' && data?.type === 'host') {
        const reply = (result) =>
          this.postMessage({ type: 'hostResult', id: data.id, ok: true, result });
        if (data.method === 'query' && data.args[0] === 'demo-account') {
          state.queries++;
          if (data.args[1] !== 'buyer-orders' || data.args[2].buyerId !== 'pdd-toolkit-buyer')
            throw new Error('wrong scoped query');
          reply({
            operation: 'buyer-orders',
            subjectId: 'pdd-toolkit-buyer',
            queriedAt: new Date().toISOString(),
            partial: false,
            failedSections: [],
            data: {
              orders: [
                {
                  orderSn: '260908-12345',
                  status: '待发货',
                  goods: { goodsId: '12345', title: '短袖' },
                },
              ],
              pagination: { page: 1, pageSize: 10, reportedTotal: 1, hasMore: false },
            },
          });
          return true;
        }
        if (data.method === 'executeAction' && data.args[0].accountId === 'demo-account') {
          const command = data.args[0],
            id = `__pdd_guard_${command.id}`;
          state.pending.set(id, { hostId: data.id });
          // Invoke the real service-side callback, including durable preview/state checks.
          this.postMessage({
            type: 'platform_action_guard',
            id,
            actionId: command.id,
            preview: {
              before: { remark: '原备注', tag: 2, tagName: '黄色' },
              after: { remark: `原备注\n${command.note}`, tag: 2, tagName: '黄色' },
            },
          });
          return true;
        }
        if (data.method === 'send' && data.args[0].accountId === 'demo-account') {
          state.sends.push(data.args[0]);
          reply({ status: 'confirmed', externalId: `pdd-receipt-${data.args[0].id}` });
          return true;
        }
      }
      return original.call(this, event, ...args);
    };
  });
  try {
    const model = await page.evaluate(
      (baseUrl) =>
        window.judesk.call('models.save', {
          name: 'PDD 工具链路夹具',
          kind: 'chat',
          provider: 'openai',
          model: 'glm-5.3-flash',
          baseUrl,
          maxTokens: 1024,
        }),
      `http://127.0.0.1:${server.address().port}/v1`,
    );
    const draft = await page.evaluate(
      (modelId) =>
        window.judesk.call('agents.save', {
          config: {
            name: 'PDD 工具链路助手',
            prompt: '根据买家要求查询订单，添加备注并回答。',
            modelProfileId: modelId,
            toolkitIds: ['builtin/commerce@1.0.0'],
          },
        }),
      model.id,
    );
    const revision = await page.evaluate(
      (a) => window.judesk.call('agents.publish', { id: a.id, expectedRevision: a.draftRevision }),
      draft,
    );
    await page.evaluate(
      ({ revisionId, expectedRevision }) =>
        window.judesk.call('agents.bind', {
          scopeKey: 'store:demo-store',
          revisionId,
          expectedRevision,
        }),
      { revisionId: revision.id, expectedRevision: oldBinding?.revision ?? null },
    );
    await page.evaluate(() => window.judesk.call('conversations.open', { conversationId: null }));
    await db.batch(
      [
        {
          sql: "UPDATE Account SET status='online',capabilities=?,verifiedAt=? WHERE id='demo-account'",
          args: [
            JSON.stringify({
              receive: true,
              sendText: true,
              sendImage: false,
              goods: true,
              history: true,
              orders: true,
              orderRemark: true,
              verified: true,
            }),
            Date.now(),
          ],
        },
        { sql: "UPDATE ReplyPolicy SET autoReplyEnabled=1 WHERE storeId='demo-store'", args: [] },
      ],
      'write',
    );
    await app.evaluate(async () => {
      const worker = globalThis.__pddToolkitSmoke.worker;
      await new Promise((resolve, reject) => {
        const id = '__pdd_toolkit_incoming';
        const timer = setTimeout(() => {
          worker.removeListener('message', listener);
          reject(new Error('PDD incoming timed out'));
        }, 10000);
        const listener = (data) => {
          if (data.id !== id || data.type !== 'result') return;
          clearTimeout(timer);
          worker.removeListener('message', listener);
          data.ok ? resolve() : reject(new Error(data.error));
        };
        worker.on('message', listener);
        worker.postMessage({
          type: 'incoming',
          id,
          input: {
            accountId: 'demo-account',
            buyerId: 'pdd-toolkit-buyer',
            buyerName: '工具链路测试',
            conversationKey: 'pdd-toolkit-buyer',
            externalId: id,
            eventKey: id,
            direction: 'in',
            origin: 'buyer',
            kind: 'text',
            text: '请给我的短袖订单备注加固包装',
            timestamp: new Date().toISOString(),
            raw: {},
          },
        });
      });
    });
    const deadline = Date.now() + 25000;
    let outbound;
    while (Date.now() < deadline) {
      outbound = (
        await db.execute(
          "SELECT o.* FROM OutboundMessage o JOIN Conversation c ON c.id=o.conversationId WHERE c.externalKey='pdd-toolkit-buyer' LIMIT 1",
        )
      ).rows[0];
      if (outbound?.status === 'confirmed') break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.deepEqual(failures, []);
    assert.equal(outbound?.status, 'confirmed');
    assert.equal(JSON.parse(outbound.body).text, '已经为您备注加固包装。');
    assert.equal(calls, 3);
    const state = await app.evaluate(() => {
      const s = globalThis.__pddToolkitSmoke;
      return { queries: s.queries, writes: s.writes, guards: s.guards, sends: s.sends.length };
    });
    assert.deepEqual(state, { queries: 1, writes: 1, guards: 1, sends: 1 });
    const action = (
      await db.execute("SELECT * FROM PlatformAction WHERE operation='order-remark' LIMIT 1")
    ).rows[0];
    assert.equal(action.status, 'confirmed');
    assert.equal(JSON.parse(action.preview).before.remark, '原备注');
    assert.equal(
      (
        await db.execute({
          sql: 'SELECT COUNT(*) AS n FROM PlatformEvidence WHERE runId=?',
          args: [action.runId],
        })
      ).rows[0].n,
      2,
    );
    console.log(
      'Commerce Toolkit on PDD desktop passed: shared toolkit published binding, scoped buyer orders, real service authorization callback, durable preview/receipt, one simulated write, three model loop requests and one confirmed outbound.',
    );
  } finally {
    await db.batch(
      [
        {
          sql: "UPDATE Account SET status=?,capabilities=?,verifiedAt=? WHERE id='demo-account'",
          args: [account.status, account.capabilities, account.verifiedAt],
        },
        {
          sql: "UPDATE ReplyPolicy SET autoReplyEnabled=? WHERE storeId='demo-store'",
          args: [policy.autoReplyEnabled],
        },
      ],
      'write',
    );
    const binding = (
      await db.execute("SELECT * FROM AgentBinding WHERE scopeKey='store:demo-store'")
    ).rows[0];
    if (binding)
      await page.evaluate(
        ({ revisionId, expectedRevision }) =>
          window.judesk.call('agents.bind', {
            scopeKey: 'store:demo-store',
            revisionId,
            expectedRevision,
          }),
        { revisionId: oldBinding?.agentRevisionId ?? null, expectedRevision: binding.revision },
      );
    await app.evaluate(() => {
      process.getBuiltinModule('node:events').EventEmitter.prototype.emit =
        globalThis.__pddToolkitSmoke.original;
      delete globalThis.__pddToolkitSmoke;
    });
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}
