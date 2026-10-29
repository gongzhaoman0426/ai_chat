import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

export async function checkManualAsync({ app, page, dbFile }) {
  const db = createClient({ url: pathToFileURL(dbFile).href });
  const account = (
    await db.execute("SELECT status,capabilities FROM Account WHERE id='demo-account'")
  ).rows[0];
  // Intercept only this isolated account's utility-process transport. No real PDD
  // send code runs; the UI, IPC, durable queue and confirmation all remain real.
  await app.evaluate(async () => {
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const original = EventEmitter.prototype.emit;
    const state = {
      original,
      received: [],
      pending: new Map(),
      acknowledgements: [],
      holdAck: true,
    };
    globalThis.__manualSendSmoke = state;
    EventEmitter.prototype.emit = function (event, ...args) {
      const data = args[0];
      if (
        event === 'message' &&
        data?.type === 'host' &&
        data.method === 'send' &&
        data.args[0]?.accountId === 'demo-account'
      ) {
        const command = data.args[0];
        state.received.push(command);
        state.pending.set(command.id, { service: this, hostId: data.id });
        return true;
      }
      if (
        event === 'message' &&
        state.holdAck &&
        data?.type === 'result' &&
        data.result?.conversationId === 'manual-async-c' &&
        data.result?.intentKey?.startsWith('manual:')
      ) {
        state.acknowledgements.push({ service: this, event, args });
        return true;
      }
      return original.call(this, event, ...args);
    };
  });
  const waitHost = async (length) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const received = await app.evaluate(() => globalThis.__manualSendSmoke.received);
      if (received.length >= length) return received;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`manual send ${length} not dispatched`);
  };
  const release = (id, result) =>
    app.evaluate(
      (_, { id, result }) => {
        const state = globalThis.__manualSendSmoke;
        const pending = state.pending.get(id);
        if (!pending) throw new Error('No pending platform send');
        state.pending.delete(id);
        pending.service.postMessage({ type: 'hostResult', id: pending.hostId, ok: true, result });
      },
      { id, result },
    );
  try {
    await db.batch(
      [
        {
          sql: "UPDATE Account SET status='online',capabilities=? WHERE id='demo-account'",
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
        {
          sql: 'INSERT INTO Conversation (id,storeId,externalKey,buyerId,buyerName,accountId,preview) VALUES (?,?,?,?,?,?,?)',
          args: [
            'manual-async-c',
            'demo-store',
            'manual-async',
            'manual-async-buyer',
            '异步发送测试',
            'demo-account',
            '人工文本发送测试',
          ],
        },
        {
          sql: 'INSERT INTO Message (id,conversationId,storeId,externalId,direction,origin,text,timestamp,raw) VALUES (?,?,?,?,?,?,?,?,?)',
          args: [
            'manual-async-question',
            'manual-async-c',
            'demo-store',
            'manual-async-question-ext',
            'in',
            'buyer',
            '请帮我核实一下',
            new Date().toISOString(),
            '{}',
          ],
        },
      ],
      'write',
    );
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.getByText('异步发送测试', { exact: true }).click();
    const composer = page.getByPlaceholder('输入回复内容，Enter 发送，Shift + Enter 换行…');
    const bubble = (text) =>
      page.locator('.message').filter({ has: page.locator('.bubble').filter({ hasText: text }) });
    const firstText = '异步文本 1：已帮您核实';
    await composer.fill(firstText);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await bubble(firstText).getByRole('status', { name: '发送中', exact: true }).waitFor();
    assert.equal(await composer.inputValue(), '');
    await composer.fill('这是下一条尚未发送的草稿');
    const first = (await waitHost(1))[0];
    assert.equal(first.text, firstText);
    assert.equal(
      (
        await db.execute(
          "SELECT COUNT(*) AS n FROM Message WHERE conversationId='manual-async-c' AND direction='out'",
        )
      ).rows[0].n,
      0,
    );
    // Release the local acceptance independently from the still-blocked platform send.
    await app.evaluate(() => {
      const state = globalThis.__manualSendSmoke;
      state.holdAck = false;
      for (const ack of state.acknowledgements.splice(0))
        state.original.call(ack.service, ack.event, ...ack.args);
    });
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.equal(await composer.inputValue(), '这是下一条尚未发送的草稿');
    const secondText = '异步文本 2：稍后补充物流';
    await composer.fill(secondText);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await bubble(secondText).getByRole('status', { name: '发送中', exact: true }).waitFor();
    assert.equal((await app.evaluate(() => globalThis.__manualSendSmoke.received)).length, 1);
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    assert.deepEqual(
      (await page.locator('.messages .bubble').allTextContents()).filter((text) =>
        text.startsWith('异步文本'),
      ),
      [firstText, secondText],
    );
    await page.screenshot({ path: '.artifacts/manual-async-pending.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Agent 执行', exact: true }).click();
    await page.getByRole('button', { name: '接待中心', exact: true }).click();
    await page.getByText('小林同学', { exact: true }).click();
    assert.equal(await page.locator('.bubble').filter({ hasText: firstText }).count(), 0);
    await page.getByText('异步发送测试', { exact: true }).click();
    await bubble(firstText).getByRole('status', { name: '发送中', exact: true }).waitFor();
    await bubble(secondText).getByRole('status', { name: '发送中', exact: true }).waitFor();
    await release(first.id, { status: 'confirmed', externalId: 'manual-smoke-confirmed-1' });
    await bubble(firstText).getByRole('status', { name: '已发送', exact: true }).waitFor();
    assert.equal(await bubble(firstText).count(), 1);
    const second = (await waitHost(2))[1];
    assert.equal(second.text, secondText);
    await release(second.id, { status: 'rejected', reason: '测试平台拒绝了这条消息' });
    await bubble(secondText).getByRole('status', { name: '发送失败', exact: true }).waitFor();
    await bubble(secondText).getByRole('button', { name: '重新编辑', exact: true }).click();
    assert.equal(await composer.inputValue(), secondText);
    assert.equal((await app.evaluate(() => globalThis.__manualSendSmoke.received)).length, 2);
    const thirdText = '异步文本 3：等待平台确认';
    await composer.fill(thirdText);
    await composer.press('Enter');
    const third = (await waitHost(3))[2];
    await release(third.id, { status: 'unknown', reason: '模拟平台回执超时' });
    await bubble(thirdText).getByRole('status', { name: '发送待确认', exact: true }).waitFor();
    assert.equal(
      await bubble(thirdText).getByRole('button', { name: '重新编辑', exact: true }).count(),
      0,
    );
    await page.screenshot({ path: '.artifacts/manual-async-result.png', animations: 'disabled' });
    await page.evaluate(
      ({ id }) =>
        window.judesk.call('outbound.resolve', {
          id,
          externalId: 'manual-smoke-confirmed-3',
          evidence: '临时测试资料库中的确定回执',
        }),
      { id: third.id },
    );
    await bubble(thirdText).getByRole('status', { name: '已发送', exact: true }).waitFor();
    assert.equal(await bubble(thirdText).count(), 1);
    assert.equal((await app.evaluate(() => globalThis.__manualSendSmoke.received)).length, 3);
    assert.equal(
      (
        await db.execute(
          "SELECT COUNT(*) AS n FROM Message WHERE conversationId='manual-async-c' AND direction='out'",
        )
      ).rows[0].n,
      2,
    );
    console.log(
      'Manual text async: immediate pending bubble before IPC acknowledgement, draft preservation, ordered background sends, page/conversation switches, rejection and late confirmation passed',
    );
  } finally {
    await app.evaluate(async () => {
      const { EventEmitter } = process.getBuiltinModule('node:events');
      const state = globalThis.__manualSendSmoke;
      EventEmitter.prototype.emit = state.original;
      for (const ack of state.acknowledgements.splice(0))
        state.original.call(ack.service, ack.event, ...ack.args);
      for (const pending of state.pending.values())
        pending.service.postMessage({
          type: 'hostResult',
          id: pending.hostId,
          ok: true,
          result: { status: 'unknown', reason: '测试结束' },
        });
      delete globalThis.__manualSendSmoke;
    });
    await db.execute({
      sql: "UPDATE Account SET status=?,capabilities=? WHERE id='demo-account'",
      args: [account.status, account.capabilities],
    });
    db.close();
  }
}
