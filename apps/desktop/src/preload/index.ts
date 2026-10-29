import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, Method } from '../../../../packages/contracts/src/index';
const api: DesktopApi = {
  async call<T>(method: Method, input: unknown = {}) {
    const response = await ipcRenderer.invoke('judesk:call', { method, input });
    if (!response.ok) throw new Error(response.error);
    return response.result as T;
  },
  onChanged(callback) {
    const listener = () => callback();
    ipcRenderer.on('judesk:changed', listener);
    return () => ipcRenderer.removeListener('judesk:changed', listener);
  },
  onNotice(callback) {
    const listener = (_event: unknown, message: unknown) => {
      if (typeof message === 'string') callback(message);
    };
    ipcRenderer.on('judesk:notice', listener);
    return () => ipcRenderer.removeListener('judesk:notice', listener);
  },
};
contextBridge.exposeInMainWorld('judesk', api);
