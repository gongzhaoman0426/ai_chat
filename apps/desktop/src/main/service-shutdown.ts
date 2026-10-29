type ServiceProcess = {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
  postMessage(message: { type: 'shutdown' }): void;
  kill(): boolean;
};

export function stopServiceProcess(
  service: ServiceProcess,
  timeoutMs: number | null,
  killOnTimeout: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      service.removeListener('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onExit = () => finish();
    service.once('exit', onExit);
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (!killOnTimeout) {
          finish(new Error('本地服务未能安全退出，已取消更新。'));
          return;
        }
        try {
          // kill() requests termination. Database handles are released only when
          // the process has actually exited, so keep waiting for the exit event.
          if (!service.kill()) finish(new Error('本地服务未能退出。'));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }, timeoutMs);
    }
    try {
      service.postMessage({ type: 'shutdown' });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
