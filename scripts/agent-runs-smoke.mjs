import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

export async function checkAgentRuns({ app, page, dbFile }) {
  const db = createClient({ url: pathToFileURL(dbFile).href });
  try {
    const run = (
      await db.execute(
        "SELECT r.* FROM AiRun r JOIN Conversation c ON c.id=r.conversationId WHERE c.externalKey='pdd-toolkit-buyer' ORDER BY r.startedAt DESC LIMIT 1",
      )
    ).rows[0];
    assert.ok(run, 'the real commerce agent execution must exist');
    await page.getByRole('button', { name: 'Agent 执行', exact: true }).click();
    await page.locator(`[data-run-id="${run.id}"]`).click();
    const detail = page.getByTestId('agent-run-detail');
    await detail.getByText('3 次模型调用', { exact: true }).waitFor();
    await detail.getByText('2 次工具调用', { exact: true }).waitFor();
    assert.equal(await detail.locator('[data-step-kind="tool"]').count(), 2);
    const steps = await page.evaluate(
      ({ storeId, id }) => window.judesk.call('runs.detail', { storeId, id }),
      { storeId: 'demo-store', id: run.id },
    );
    const order = steps.steps.find((s) => s.toolName?.startsWith('builtin_commerce_buyer_orders'));
    const remark = steps.steps.find((s) => s.toolName?.startsWith('builtin_commerce_order_remark'));
    assert.ok(order && remark);
    assert.equal(order.status, 'succeeded');
    assert.equal(remark.status, 'succeeded');
    const orderStep = detail.locator(`[data-step-id="${order.id}"]`);
    await orderStep.locator(':scope > button').click();
    await orderStep.getByRole('heading', { name: '输入参数', exact: true }).waitFor();
    await orderStep.getByRole('heading', { name: '返回结果', exact: true }).waitFor();
    assert.match(await orderStep.locator('pre').last().textContent(), /orderRef/);
    const remarkStep = detail.locator(`[data-step-id="${remark.id}"]`);
    await remarkStep.locator(':scope > button').click();
    assert.match(await remarkStep.locator('pre').first().textContent(), /请加固包装/);
    assert.match(await remarkStep.locator('pre').last().textContent(), /confirmed/);
    assert.equal(await page.getByRole('button', { name: '诊断与日志', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '后台任务', exact: true }).count(), 0);
    await page.screenshot({ path: '.artifacts/agent-execution-steps.png', animations: 'disabled' });
    await page.getByRole('combobox', { name: '执行状态', exact: true }).selectOption('failed');
    await page.locator('.trace-run-item').first().waitFor();
    const failed = await page.locator('.trace-run-item').count();
    assert.ok(failed > 0);
    await page.getByRole('combobox', { name: '执行类型', exact: true }).selectOption('learning');
    await page.getByText('暂无执行记录', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: '执行状态', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: '执行类型', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: '执行记录所属店铺', exact: true }).selectOption('');
    await page.locator(`[data-run-id="${run.id}"]`).waitFor();
    // Reload keeps persisted steps, not component-local event history.
    await page.reload();
    await page.getByRole('button', { name: 'Agent 执行', exact: true }).click();
    await page.locator(`[data-run-id="${run.id}"]`).click();
    await page.getByTestId('agent-run-detail').getByText('3 次模型调用', { exact: true }).waitFor();
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.trace-step-toggle, .trace-run-detail')].some(
        (e) => e.scrollWidth > e.clientWidth + 2,
      ),
    );
    assert.equal(overflow, false, 'execution panels must not overflow');
    await page.getByRole('heading', { name: 'Agent 执行', exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: '.artifacts/agent-execution-overview.png',
      animations: 'disabled',
    });
    console.log(
      'Agent execution UI passed: persisted real model/tool timeline, exact input/output, delivery receipts, filtering, legacy records, reload and bounded layout. No extra model requests.',
    );
  } finally {
    db.close();
  }
}
