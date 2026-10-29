import { app, dialog } from 'electron';
try {
  await import('./index');
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('JuDesk startup failed:', detail);
  if (process.env.JUDESK_SMOKE_TEST) app.exit(1);
  else {
    await app.whenReady();
    await dialog.showMessageBox({
      type: 'error',
      title: '句达启动失败',
      message: '本地程序未能启动',
      detail,
    });
    app.exit(1);
  }
}
