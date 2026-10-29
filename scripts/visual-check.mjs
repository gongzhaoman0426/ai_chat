// 临时视觉验证：启动应用截图（验证品牌化改造渲染效果）
import { _electron as electron } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'judesk-visual-'));
let app;
try {
  const env = { ...process.env, JUDESK_DATA_DIR: dir, JUDESK_SMOKE_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [resolve(ROOT, 'out/main/bootstrap.js')],
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: resolve(ROOT, '.artifacts/visual-check.png') });
  const title = await page.title();
  const bodyText = (await page.locator('body').innerText()).slice(0, 300);
  console.log('TITLE:', title);
  console.log('BODY:', bodyText.replace(/\n+/g, ' | '));
} finally {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
