import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopApi,
  DesktopUpdateState,
  Method,
} from '../../../../packages/contracts/src/index';
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
  getUpdateState() {
    return ipcRenderer.invoke('judesk:update', { action: 'state' }) as Promise<DesktopUpdateState>;
  },
  checkForUpdates() {
    return ipcRenderer.invoke('judesk:update', { action: 'check' }) as Promise<DesktopUpdateState>;
  },
  downloadUpdate() {
    return ipcRenderer.invoke('judesk:update', {
      action: 'download',
    }) as Promise<DesktopUpdateState>;
  },
  installUpdate() {
    return ipcRenderer.invoke('judesk:update', { action: 'install' }) as Promise<void>;
  },
  onUpdate(callback) {
    const listener = (_event: unknown, state: DesktopUpdateState) => callback(state);
    ipcRenderer.on('judesk:update-state', listener);
    return () => ipcRenderer.removeListener('judesk:update-state', listener);
  },
};
contextBridge.exposeInMainWorld('judesk', api);
