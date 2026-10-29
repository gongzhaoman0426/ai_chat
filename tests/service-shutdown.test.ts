import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopServiceProcess } from '../apps/desktop/src/main/service-shutdown';

class ServiceProcess extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

afterEach(() => vi.useRealTimers());

describe('service shutdown', () => {
  it('waits for the process to exit after requesting a graceful shutdown', async () => {
    vi.useFakeTimers();
    const service = new ServiceProcess();
    let finished = false;
    const stopped = stopServiceProcess(service, 8000, true).then(() => {
      finished = true;
    });
    expect(service.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    await Promise.resolve();
    expect(finished).toBe(false);
    service.emit('exit');
    await stopped;
    await vi.advanceTimersByTimeAsync(8000);
    expect(service.kill).not.toHaveBeenCalled();
    expect(service.listenerCount('exit')).toBe(0);
  });

  it('does not report a forced shutdown complete until the process exits', async () => {
    vi.useFakeTimers();
    const service = new ServiceProcess();
    let finished = false;
    const stopped = stopServiceProcess(service, 8000, true).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(service.kill).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    expect(service.listenerCount('exit')).toBe(1);
    service.emit('exit');
    await stopped;
    expect(finished).toBe(true);
  });

  it('cancels installation without killing the service when graceful shutdown times out', async () => {
    vi.useFakeTimers();
    const service = new ServiceProcess();
    const stopped = stopServiceProcess(service, 30000, false);
    const assertion = expect(stopped).rejects.toThrow('已取消更新');
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(service.kill).not.toHaveBeenCalled();
    expect(service.listenerCount('exit')).toBe(0);
  });

  it('reports termination failure and removes its exit listener', async () => {
    vi.useFakeTimers();
    const service = new ServiceProcess();
    service.kill.mockReturnValue(false);
    const stopped = stopServiceProcess(service, 8000, true);
    const assertion = expect(stopped).rejects.toThrow('本地服务未能退出');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(service.listenerCount('exit')).toBe(0);
  });

  it('cleans up the shutdown timeout if the request cannot be delivered', async () => {
    vi.useFakeTimers();
    const service = new ServiceProcess();
    service.postMessage.mockImplementation(() => {
      throw new Error('Channel closed');
    });
    await expect(stopServiceProcess(service, 8000, true)).rejects.toThrow('Channel closed');
    await vi.advanceTimersByTimeAsync(8000);
    expect(service.kill).not.toHaveBeenCalled();
    expect(service.listenerCount('exit')).toBe(0);
  });
});
