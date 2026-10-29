import { WorkbenchHost } from './workbench-host';
import {
  KUAISHOU_URL,
  KUAISHOU_LOGIN_URL,
  normalizeKuaishouMessage,
} from '../../../../packages/platforms/src/kuaishou';
import { normalizeKuaishouQuery } from '../../../../packages/platforms/src/kuaishou/queries';
export class KuaishouHost extends WorkbenchHost {
  constructor(
    bridgeFile: string,
    request: (data: Record<string, unknown>) => Promise<any>,
    notify: (data: unknown) => void,
    reloadBridge = false,
  ) {
    super(bridgeFile, request, notify, reloadBridge, {
      platform: 'kuaishou',
      name: '快手',
      url: KUAISHOU_URL,
      startUrl: KUAISHOU_LOGIN_URL,
      loginRedirect: (url) =>
        url.origin === 'https://im.kwaixiaodian.com' && url.pathname === '/workbench/not-login'
          ? KUAISHOU_LOGIN_URL
          : undefined,
      isLoginPage: (url) =>
        url.hostname === 'login.kwaixiaodian.com' ||
        /\/(login|passport|not-login)(\/|$)/.test(url.pathname),
      shouldOpenChat: (url) => url.hostname === 's.kwaixiaodian.com',
      allowedHost: (host) =>
        ['kwaixiaodian.com', 'kuaishou.com'].some((d) => host === d || host.endsWith('.' + d)),
      pageAllowed: (url) => url.origin === 'https://im.kwaixiaodian.com',
      chatPage: (url) =>
        url.origin === 'https://im.kwaixiaodian.com' &&
        (['/', '/pc', '/pc/'].includes(url.pathname) || /^\/workbench(?:\/|$)/.test(url.pathname)),
      imageHost: (host) =>
        [
          'kwaicdn.com',
          'kwai.net',
          'eckwai.com',
          'yximgs.com',
          'gifshow.com',
          'kwaixiaodian.com',
        ].some((d) => host === d || host.endsWith('.' + d)),
      normalizeMessage: normalizeKuaishouMessage,
      normalizeQuery: normalizeKuaishouQuery,
    });
  }
}
