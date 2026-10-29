import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

export async function checkAutomaticReply({ app, page, dbFile, agent, modelCalls }) {
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
  await app.evaluate(() => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const original = EventEmitter.prototype.emit;
    const state = { original, worker: null, sends: [] };
    globalThis.__autoReplySmoke = state;
    EventEmitter.prototype.emit = function (event, ...args) {
      const data = args[0];
      if (event === 'message' && data?.type === 'result' && typeof this.postMessage === 'function')
        state.worker = this;
      // Only the temporary demo account is intercepted. No PDD transport is called.
      if (
        event === 'message' &&
        data?.type === 'host' &&
        data.method === 'send' &&
        data.args[0]?.accountId === 'demo-account'
      ) {
        state.sends.push(data.args[0]);
        this.postMessage({
          type: 'hostResult',
          id: data.id,
          ok: true,
          result: { status: 'confirmed', externalId: `auto-smoke-${data.args[0].id}` },
        });
        return true;
      }
      return original.call(this, event, ...args);
    };
  });
  const incoming = async (suffix) => {
    await app.evaluate(async (_, suffix) => {
      const worker = globalThis.__autoReplySmoke.worker;
      if (!worker) throw new Error('Smoke worker not found');
      const id = `__auto_reply_smoke_${suffix}`;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.removeListener('message', listener);
          reject(new Error('Incoming acknowledgement timed out'));
        }, 10000);
        const listener = (data) => {
          if (data.type !== 'result' || data.id !== id) return;
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
            externalId: id,
            eventKey: id,
            buyerId: `auto-reply-${suffix}`,
            buyerName: '自动回复链路测试',
            conversationKey: `auto-reply-${suffix}`,
            direction: 'in',
            origin: 'buyer',
            kind: 'text',
            text: `__AUTO_REPLY_SMOKE__ ${suffix}`,
            timestamp: new Date().toISOString(),
            raw: {},
          },
        });
      });
    }, suffix);
    return (
      await db.execute({
        sql: 'SELECT * FROM Conversation WHERE externalKey=?',
        args: [`auto-reply-${suffix}`],
      })
    ).rows[0];
  };
  const settled = async (conversationId) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const job = (
        await db.execute({
          sql: "SELECT * FROM Job WHERE kind='reply' AND conversationId=? ORDER BY createdAt DESC LIMIT 1",
          args: [conversationId],
        })
      ).rows[0];
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Automatic reply job did not settle');
  };
  try {
    await page.getByRole('button', { name: 'Agent 执行', exact: true }).click();
    await page.evaluate(() => window.judesk.call('conversations.open', { conversationId: null }));
    const beforeCalls = modelCalls();
    await db.batch(
      [
        {
          sql: "UPDATE Account SET status='online',capabilities=?,verifiedAt=NULL WHERE id='demo-account'",
          args: [
            JSON.stringify({
              receive: true,
              sendText: true,
              sendImage: false,
              history: true,
              goods: false,
              orders: false,
              verified: false,
            }),
          ],
        },
        { sql: "UPDATE ReplyPolicy SET autoReplyEnabled=1 WHERE storeId='demo-store'", args: [] },
      ],
      'write',
    );
    const skipped = await incoming('unverified');
    const skippedReport = await page.evaluate(() =>
      window.judesk.call('reception.state', { storeId: 'demo-store' }),
    );
    assert.equal(skippedReport.stores[0].decisions[0].code, 'account_unverified');
    assert.equal(
      (
        await db.execute({
          sql: 'SELECT COUNT(*) AS count FROM Job WHERE conversationId=?',
          args: [skipped.id],
        })
      ).rows[0].count,
      0,
    );
    assert.equal(modelCalls(), beforeCalls);
    // Reuse the actual first-launch default revision with its unconfigured model.
    const missing = (
      await db.execute(
        "SELECT r.id FROM AgentRevision r JOIN AgentDefinition a ON a.id=r.agentId WHERE a.origin='builtin_default' AND json_extract(r.configSnapshot,'$.modelSnapshot') IS NULL ORDER BY r.publishedAt DESC LIMIT 1",
      )
    ).rows[0];
    assert.ok(missing, 'First-launch default revision must exist in the isolated fixture');
    await page.evaluate(
      async ({ revisionId, expectedRevision }) =>
        window.judesk.call('agents.bind', {
          scopeKey: 'store:demo-store',
          revisionId,
          expectedRevision,
        }),
      { revisionId: missing.id, expectedRevision: oldBinding?.revision ?? null },
    );
    await db.execute({
      sql: "UPDATE Account SET verifiedAt=? WHERE id='demo-account'",
      args: [new Date().toISOString()],
    });
    const failed = await incoming('missing-model');
    const failedJob = await settled(failed.id);
    assert.equal(failedJob.status, 'failed', failedJob.error);
    assert.match(failedJob.error, /尚未配置模型/);
    const failedRun = (
      await db.execute({ sql: 'SELECT * FROM AiRun WHERE conversationId=?', args: [failed.id] })
    ).rows[0];
    assert.equal(failedRun.path, 'preflight');
    assert.equal(JSON.parse(failedRun.usage).modelCalled, false);
    assert.equal(modelCalls(), beforeCalls);
    await page.locator(`[data-run-id="${failedRun.id}"]`).click();
    await page.getByText('启动检查未通过，未调用回复模型。', { exact: true }).waitFor();
    // Select the published reply Agent backed by the local HTTP fixture, then drive
    // the real ingestion -> debounce -> scheduler -> Mastra -> confirmed outbound.
    const published = await page.evaluate(
      (agent) =>
        window.judesk.call('agents.publish', {
          id: agent.id,
          expectedRevision: agent.draftRevision,
        }),
      agent,
    );
    const binding = (
      await db.execute("SELECT revision FROM AgentBinding WHERE scopeKey='store:demo-store'")
    ).rows[0];
    await page.evaluate((input) => window.judesk.call('agents.bind', input), {
      scopeKey: 'store:demo-store',
      revisionId: published.id,
      expectedRevision: binding.revision,
    });
    const replied = await incoming('success');
    const job = await settled(replied.id);
    assert.equal(job.status, 'succeeded', job.error);
    const run = (
      await db.execute({ sql: 'SELECT * FROM AiRun WHERE conversationId=?', args: [replied.id] })
    ).rows[0];
    const outbound = (
      await db.execute({ sql: 'SELECT * FROM OutboundMessage WHERE aiRunId=?', args: [run.id] })
    ).rows[0];
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(outbound.status, 'confirmed', outbound.error);
    assert.equal(JSON.parse(outbound.body).text, '单次模型回复成功');
    assert.equal(modelCalls(), beforeCalls + 1);
    const sends = await app.evaluate(() => globalThis.__autoReplySmoke.sends);
    assert.equal(sends.length, 1);
    const ready = await page.evaluate(() =>
      window.judesk.call('reception.state', { storeId: 'demo-store' }),
    );
    assert.equal(ready.scheduler.running, true);
    assert.equal(ready.stores[0].readiness.ready, true);
    assert.equal(ready.stores[0].agent.ready, true);
    assert.equal(ready.stores[0].decisions[0].code, 'queued');
    await page.locator(`[data-run-id="${run.id}"]`).click();
    const detail = page.getByTestId('agent-run-detail');
    await detail
      .locator('[data-step-kind="model"]')
      .getByRole('button', { name: /第 1 轮模型调用/ })
      .click();
    await detail
      .locator('[data-step-kind="model"] .trace-step-content')
      .getByText('单次模型回复成功', { exact: false })
      .waitFor();
    await detail.locator('.trace-delivery').getByText('发送成功', { exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/agent-single-step.png', animations: 'disabled' });
    console.log(
      'Automatic reply smoke passed: skipped-message diagnosis, missing-model preflight failure, one model request and one confirmed outbound through the real utility-process scheduler.',
    );
  } finally {
    await db.execute({
      sql: "UPDATE ReplyPolicy SET autoReplyEnabled=? WHERE storeId='demo-store'",
      args: [policy.autoReplyEnabled],
    });
    await db.execute({
      sql: "UPDATE Account SET status=?,capabilities=?,verifiedAt=? WHERE id='demo-account'",
      args: [account.status, account.capabilities, account.verifiedAt],
    });
    const binding = (
      await db.execute("SELECT revision FROM AgentBinding WHERE scopeKey='store:demo-store'")
    ).rows[0];
    if (binding)
      await page.evaluate((input) => window.judesk.call('agents.bind', input), {
        scopeKey: 'store:demo-store',
        revisionId: oldBinding?.agentRevisionId ?? null,
        expectedRevision: binding.revision,
      });
    await app.evaluate(() => {
      process.getBuiltinModule('node:events').EventEmitter.prototype.emit =
        globalThis.__autoReplySmoke.original;
      delete globalThis.__autoReplySmoke;
    });
    db.close();
  }
}
