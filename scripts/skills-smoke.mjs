import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';

export async function checkSkills({ app, page, modelId, modelCalls }) {
  for (const kind of ['Toolkit', 'Workflow']) {
    await page.getByRole('button', { name: kind, exact: true }).click();
    await page.getByRole('button', { name: `安装 ${kind}`, exact: true }).waitFor();
    const badges = await page.locator('.asset-card > .badge:first-of-type').allTextContents();
    assert.ok(badges.length > 0);
    assert.ok(badges.every((b) => b === kind));
    await page.screenshot({
      path: `.artifacts/${kind.toLowerCase()}-library.png`,
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: '新建 Skill', exact: true }).click();
  const editor = page.locator('.skill-editor-dialog');
  await editor.getByLabel('技能名称', { exact: true }).fill('after-sales-guide');
  await editor
    .getByLabel('技能适用场景', { exact: true })
    .fill('当买家咨询退换货或售后进度时，按步骤核实情况并解释下一步。');
  const instructions =
    '# 售后接待\n\n1. 先确认买家遇到的问题。\n2. 核实订单和售后状态，不做未经核实的承诺。\n3. 按需读取 references/policy.md 中的处理要点。\n4. 无法解决时交给人工客服。';
  await editor.getByLabel('编辑 SKILL.md', { exact: true }).fill(instructions);
  await editor.getByRole('button', { name: '添加参考资料', exact: true }).click();
  await editor.getByLabel('参考资料路径').fill('references/policy.md');
  await editor.getByRole('button', { name: '添加文件', exact: true }).click();
  const reference =
    '# 沟通要点\n\n- 先理解问题，再收集必要信息。\n- 退款结果以已核实的订单状态为准。\n- 需要人工判断的情形及时转接。';
  await editor.getByLabel('编辑 references/policy.md', { exact: true }).fill(reference);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760));
  await page.waitForFunction(() => window.innerWidth === 1120);
  const layout = await editor.evaluate((el) => ({
    fits: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight,
    textarea: el.querySelector('.skill-markdown').getBoundingClientRect().height,
    save: el.querySelector('.skill-editor-footer').getBoundingClientRect().bottom,
  }));
  assert.equal(layout.fits, true);
  assert.ok(layout.textarea >= 150);
  assert.ok(layout.save <= 760);
  await page.screenshot({ path: '.artifacts/skill-editor-compact.png', animations: 'disabled' });
  await editor.getByRole('button', { name: '添加脚本', exact: true }).click();
  await editor.getByLabel('脚本路径').fill('scripts/calculate.ts');
  await editor.getByRole('button', { name: '添加文件', exact: true }).click();
  const script = `import { readFileSync } from 'node:fs';
const value: number = Number(process.argv[2]) + 1;
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
console.log(JSON.stringify({ answer: value, stdin, reference: readFileSync('references/policy.md', 'utf8').includes('沟通要点'), node: process.versions.node }));`;
  await editor.getByLabel('编辑 scripts/calculate.ts', { exact: true }).fill(script);
  await editor.getByRole('button', { name: '试运行', exact: true }).click();
  await editor.getByLabel('脚本参数', { exact: true }).fill('["41"]');
  await editor.locator('.skill-stdin summary').click();
  await editor.getByLabel('脚本标准输入', { exact: true }).fill('试运行输入');
  const beforeScript = modelCalls();
  await editor.getByRole('button', { name: '运行脚本', exact: true }).click();
  const resultPanel = editor.getByLabel('脚本运行结果', { exact: true });
  await resultPanel.getByText('运行成功', { exact: true }).waitFor();
  const output = JSON.parse(await resultPanel.locator('pre').first().innerText());
  assert.equal(output.answer, 42);
  assert.equal(output.stdin, '试运行输入');
  assert.equal(output.reference, true);
  assert.ok(Number(output.node.split('.')[0]) >= 24);
  assert.equal(modelCalls(), beforeScript, 'direct script trial makes no model requests');
  const scriptLayout = await editor.evaluate((el) => ({
    fits: el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight,
    textarea: el.querySelector('.skill-markdown').getBoundingClientRect().height,
    footer: el.querySelector('.skill-editor-footer').getBoundingClientRect().bottom,
  }));
  assert.equal(scriptLayout.fits, true);
  assert.ok(scriptLayout.textarea >= 100);
  assert.ok(scriptLayout.footer <= 760);
  await page.screenshot({ path: '.artifacts/skill-script-compact.png', animations: 'disabled' });
  await editor
    .getByLabel('编辑 scripts/calculate.ts', { exact: true })
    .fill('setInterval(() => {}, 1000);');
  await editor.getByRole('button', { name: '运行脚本', exact: true }).click();
  await editor.getByText('脚本运行中…', { exact: true }).waitFor();
  assert.equal(
    await editor.getByRole('button', { name: '关闭技能编辑器', exact: true }).isDisabled(),
    true,
  );
  await editor.getByRole('button', { name: '停止运行', exact: true }).click();
  await resultPanel.getByText('已停止', { exact: true }).waitFor();
  await editor.getByLabel('编辑 scripts/calculate.ts', { exact: true }).fill(script);
  await editor.getByRole('button', { name: '试运行', exact: true }).click();
  await editor.getByRole('button', { name: 'SKILL.md', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await page.waitForFunction(() => window.innerWidth === 1440);
  await page.screenshot({ path: '.artifacts/skill-editor.png', animations: 'disabled' });
  await editor.getByRole('button', { name: '保存技能', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '编辑 Skill after-sales-guide', exact: true }).waitFor();
  const skill = await page.evaluate(async () =>
    (await window.judesk.call('skills.list')).find((s) => s.name === 'after-sales-guide'),
  );
  assert.equal(skill.instructions, instructions);
  assert.equal(skill.references['references/policy.md'], reference);
  assert.equal(skill.scripts['scripts/calculate.ts'], script);
  await page.screenshot({ path: '.artifacts/skills-library.png', animations: 'disabled' });
  const file = resolve('.artifacts/skill-roundtrip.zip');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);
  await page.getByRole('button', { name: '导出 Skill after-sales-guide', exact: true }).click();
  await page.getByText('技能 ZIP 已导出', { exact: true }).waitFor();
  const zip = new AdmZip(await readFile(file));
  assert.ok(zip.getEntry('SKILL.md').getData().toString().includes(instructions));
  assert.equal(zip.getEntry('references/policy.md').getData().toString(), reference);
  assert.equal(zip.getEntry('scripts/calculate.ts').getData().toString(), script);
  const agent = await page.evaluate(
    (modelProfileId) =>
      window.judesk.call('agents.save', {
        config: { name: '技能接待助手', prompt: '需要售后处理时使用适用的技能。', modelProfileId },
      }),
    modelId,
  );
  await page.getByRole('button', { name: 'Agent Studio', exact: true }).click();
  await page.locator('.agent-card').filter({ hasText: '技能接待助手' }).click();
  const studio = page.locator('.agent-studio-dialog');
  await studio.getByRole('button', { name: '添加 Skill', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '挂载 Skill', exact: true });
  await picker.getByLabel('搜索技能').fill('after-sales');
  await picker.getByRole('checkbox', { name: 'after-sales-guide', exact: true }).check();
  await picker.getByRole('button', { name: '应用挂载', exact: true }).click();
  await studio.getByRole('button', { name: '发布', exact: true }).click();
  await studio.locator('.studio-statusbar').getByText('已发布', { exact: true }).waitFor();
  const before = await page.evaluate(
    async (id) => (await window.judesk.call('agents.list')).agents.find((a) => a.id === id),
    agent.id,
  );
  assert.equal(before.revisions[0].configSnapshot.skills[0].instructions, instructions);
  assert.equal(
    before.revisions[0].configSnapshot.skills[0].scripts['scripts/calculate.ts'],
    script,
  );
  await studio.getByRole('button', { name: '编辑技能 after-sales-guide', exact: true }).click();
  await editor
    .getByLabel('编辑 SKILL.md', { exact: true })
    .fill(`${instructions}\n\n补充：确认问题是否已解决。`);
  await editor.getByRole('button', { name: '关闭技能编辑器', exact: true }).click();
  await editor.getByRole('button', { name: '继续编辑', exact: true }).click();
  await editor.getByRole('button', { name: '保存技能', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await studio.getByRole('button', { name: '新建并挂载技能', exact: true }).click();
  await editor.getByLabel('技能名称', { exact: true }).fill('friendly-tone');
  await editor.getByLabel('技能适用场景', { exact: true }).fill('需要解释步骤或安抚买家时使用。');
  await editor
    .getByLabel('编辑 SKILL.md', { exact: true })
    .fill('先理解买家的诉求，使用简短清楚的句子说明下一步。');
  await editor.getByRole('button', { name: '保存技能', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await studio.getByRole('button', { name: '编辑技能 friendly-tone', exact: true }).waitFor();
  await studio.getByRole('button', { name: '发布', exact: true }).click();
  await studio.locator('.studio-statusbar').getByText('已发布', { exact: true }).waitFor();
  const after = await page.evaluate(
    async (id) => (await window.judesk.call('agents.list')).agents.find((a) => a.id === id),
    agent.id,
  );
  assert.equal(after.revisions[0].configSnapshot.skills.length, 2);
  assert.equal(after.revisions[1].configSnapshot.skills[0].instructions, instructions);
  assert.ok(after.revisions[0].configSnapshot.skills[0].instructions.includes('补充'));
  const calls = modelCalls();
  await studio.getByLabel('试运行买家消息').fill('你好');
  await studio.getByRole('button', { name: '试运行', exact: true }).click();
  await studio
    .locator('.studio-agent-message')
    .getByText('单次模型回复成功', { exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(modelCalls(), calls + 1);
  const scriptRun = await page.evaluate(
    (id) =>
      window.judesk.call('agents.debug', { id, input: '__SKILL_SCRIPT_SMOKE__ 计算 41 加一' }),
    agent.id,
  );
  assert.equal(scriptRun.result.text, '脚本计算结果：42');
  assert.equal(scriptRun.usage.scriptExecutions.length, 1);
  assert.equal(scriptRun.usage.scriptExecutions[0].status, 'succeeded');
  assert.equal(JSON.parse(scriptRun.usage.scriptExecutions[0].stdout).answer, 42);
  assert.equal(
    modelCalls(),
    calls + 3,
    'script tool loop uses exactly a tool request and a final reply',
  );
  await page.screenshot({ path: '.artifacts/agent-skills.png', animations: 'disabled' });
  await studio.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, file);
  await page.getByRole('button', { name: '导入技能', exact: true }).click();
  await editor.waitFor();
  assert.equal(
    await editor.getByLabel('编辑 SKILL.md', { exact: true }).inputValue(),
    instructions,
  );
  assert.equal(
    (await page.evaluate(() => window.judesk.call('skills.list'))).length,
    2,
    'import only previews until saved',
  );
  await editor.getByRole('button', { name: 'scripts/calculate.ts', exact: true }).click();
  assert.equal(
    await editor.getByLabel('编辑 scripts/calculate.ts', { exact: true }).inputValue(),
    script,
  );
  await editor.getByLabel('技能名称', { exact: true }).fill('imported-guide');
  await editor.getByRole('button', { name: '保存技能', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '删除 Skill after-sales-guide', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '删除 after-sales-guide？', exact: true });
  await confirm.getByText(/技能接待助手/).waitFor();
  await confirm.getByRole('button', { name: '删除技能', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Agent Studio', exact: true }).click();
  await page.locator('.agent-card').filter({ hasText: '技能接待助手' }).click();
  await studio.getByText('技能已删除或缺失', { exact: true }).waitFor();
  await studio.getByRole('button', { name: '发布', exact: true }).click();
  await studio.getByText(/挂载的 Skill 已删除或缺失/).waitFor();
  await studio.getByRole('button', { name: `移除技能 ${skill.id}`, exact: true }).click();
  await studio.getByRole('button', { name: '发布', exact: true }).click();
  await studio.locator('.studio-statusbar').getByText('已发布', { exact: true }).waitFor();
  await studio.getByRole('button', { name: '关闭 Agent 编辑器', exact: true }).click();
  console.log(
    'Skills UI: file editing, TS execution in embedded Node, cancellation, script Agent tool loop, ZIP roundtrip, immutable revisions and compact layout passed',
  );
}
