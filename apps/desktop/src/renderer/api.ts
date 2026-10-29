import { QueryClient, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import type { DesktopApi, Method } from '../../../../packages/contracts/src/index';
import { platformsForRuntime } from '../../../../packages/contracts/src/platform';
declare global {
  interface Window {
    judesk: DesktopApi;
  }
}
export const client = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, retryDelay: 1200, refetchOnWindowFocus: false, staleTime: 2000 },
  },
});
export const api = <T = any>(method: Method, input: unknown = {}) =>
  window.judesk.call<T>(method, input);
export function useData<T = any>(
  method: Method,
  input: unknown = {},
  enabled = true,
  scope?: string,
) {
  return useQuery<T>({
    queryKey: scope ? [method, input, scope] : [method, input],
    queryFn: () => api<T>(method, input),
    enabled,
  });
}
export function useAvailablePlatforms(enabled = true) {
  const { data } = useData<{ runtimePlatform: string }>('app.state', {}, enabled);
  return platformsForRuntime(data?.runtimePlatform);
}
// Live message updates refresh local state, not remote platform queries.
export const invalidateLocalData = () =>
  client.invalidateQueries({
    predicate: (q) => {
      const method = String(q.queryKey[0]);
      return method !== 'workbench.query';
    },
  });
type Page =
  | 'setup'
  | 'inbox'
  | 'stores'
  | 'knowledge'
  | 'learning'
  | 'agents'
  | 'skills'
  | 'toolkits'
  | 'workflows'
  | 'bindings'
  | 'runs'
  | 'settings';
export const useUi = create<{
  inboxStoreId: string | null;
  setInboxStore: (id: string | null) => void;
  inboxFilter: 'all' | 'unread' | 'waiting' | 'human';
  setInboxFilter: (filter: 'all' | 'unread' | 'waiting' | 'human') => void;
  page: Page;
  settingsSection: 'accounts' | 'models' | 'advanced' | 'data';
  setSettingsSection: (section: 'accounts' | 'models' | 'advanced' | 'data') => void;
  storeSettingsStep: number | undefined;
  openStoreSettings: (storeId?: string, step?: number) => void;
  storeId: string;
  conversationId: string | null;
  toast: string;
  setPage: (page: Page) => void;
  setStore: (id: string) => void;
  setConversation: (id: string | null) => void;
  notify: (message: string) => void;
}>((set) => ({
  inboxStoreId: null,
  setInboxStore: (inboxStoreId) => set({ inboxStoreId, conversationId: null }),
  inboxFilter: 'all',
  setInboxFilter: (inboxFilter) => set({ inboxFilter }),
  page: 'inbox',
  settingsSection: 'models',
  setSettingsSection: (settingsSection) =>
    set({ settingsSection, page: settingsSection === 'accounts' ? 'stores' : 'settings' }),
  storeSettingsStep: undefined,
  openStoreSettings: (storeId, storeSettingsStep) =>
    set({ page: 'stores', storeSettingsStep, ...(storeId ? { storeId } : {}) }),
  storeId: '',
  conversationId: null,
  toast: '',
  setPage: (page) =>
    set({
      page,
      ...(page === 'stores' ? { storeSettingsStep: undefined } : {}),
      ...(page === 'settings' ? { settingsSection: 'models' as const } : {}),
    }),
  setStore: (storeId) => set({ storeId, storeSettingsStep: undefined }),
  setConversation: (conversationId) => set({ conversationId }),
  notify: (toast) => {
    set({ toast });
    setTimeout(() => set((s) => (s.toast === toast ? { toast: '' } : {})), 5000);
  },
}));
export async function perform<T = any>(
  method: Method,
  input: unknown = {},
  success?: string,
): Promise<T | undefined> {
  try {
    const result = await api<T>(method, input);
    await invalidateLocalData();
    if (success && result != null) useUi.getState().notify(success);
    return result;
  } catch (e) {
    useUi.getState().notify(e instanceof Error ? e.message : '操作失败');
    return undefined;
  }
}
export const date = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
export const time = (value: string | Date) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const statusText: Record<string, string> = {
  online: '已连接',
  offline: '未连接',
  pending_review: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  stale: '已过期',
  pending: '等待执行',
  retry_wait: '等待重试',
  running: '运行中',
  failed: '执行失败',
  cancelled: '已取消',
  succeeded: '已完成',
  unknown: '结果待确认',
  confirmed: '发送成功',
  dispatching: '发送中',
  prepared: '准备发送',
  superseded: '已被新版本替代',
  human: '人工回复',
  ai: 'AI 回复',
  handoff_notice: '转人工提示',
  qa_direct: '问答直答',
  buyer: '买家',
  enabled: '已启用',
  disabled: '已停用',
  deleted: '已删除',
};
