import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { AccountPage } from '../apps/desktop/src/renderer/pages-account';

function renderAccount(setup?: (cache: QueryClient) => void) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  try {
    setup?.(cache);
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: cache }, createElement(AccountPage)),
    );
  } finally {
    cache.clear();
  }
}

describe('云端 AI 页面', () => {
  it('首次进入且账号尚未返回时，展示加载提示与刷新入口', () => {
    const html = renderAccount();
    expect(html).toContain('正在读取云端账号…');
    expect(html).toContain('刷新');
  });

  it('账号读取失败且没有缓存时，展示错误与刷新入口', () => {
    const html = renderAccount((cache) => {
      cache
        .getQueryCache()
        .build(cache, { queryKey: ['license.state', {}] })
        .setState({
          status: 'error',
          error: new Error('云端账号读取失败，请重试'),
        });
    });
    expect(html).toContain('云端账号读取失败，请重试');
    expect(html).toContain('刷新');
  });

  it('未配置云端服务时，展示自有模型入口', () => {
    const html = renderAccount((cache) => {
      cache.setQueryData(['license.state', {}], { configured: false, loggedIn: false });
    });
    expect(html).toContain('云端 AI 服务尚未配置');
    expect(html).toContain('设置自己的 API Key');
  });

  it('已配置但未登录时，展示登录页并允许模型目录继续加载', () => {
    const html = renderAccount((cache) => {
      cache.setQueryData(['license.state', {}], { configured: true, loggedIn: false });
    });
    expect(html).toContain('按需使用云端 AI');
    expect(html).toContain('正在读取模型价格…');
  });

  it('已登录但钱包和模型数据尚未返回时，仍展示账号页面', () => {
    const html = renderAccount((cache) => {
      cache.setQueryData(['license.state', {}], {
        configured: true,
        loggedIn: true,
        user: { id: 'cloud-user', name: '测试云端账号', email: 'cloud@example.test' },
      });
    });
    expect(html).toContain('测试云端账号');
    expect(html).toContain('可用余额');
    expect(html).toContain('正在读取模型价格…');
    expect(html).toContain('余额流水');
    expect(html).not.toContain('<summary>历史订单</summary>');
  });

  it.each([
    { paymentEnabled: true, expectedDisabled: false },
    { paymentEnabled: false, expectedDisabled: true },
  ])('充值入口遵循新的支付开关：$paymentEnabled', (catalog) => {
    const html = renderAccount((cache) => {
      cache.setQueryData(['license.state', {}], {
        configured: true,
        loggedIn: true,
        user: { id: 'cloud-user', name: '测试云端账号' },
      });
      cache.setQueryData(['license.cloudCatalog', {}], {
        ...catalog,
        paymentProvider: 'hupijiao',
        models: [],
      });
    });
    const button = html.match(/<button([^>]*)>(?:(?!<\/button>)[\s\S])*?充值余额<\/button>/);
    expect(button).not.toBeNull();
    expect(button![1].includes('disabled')).toBe(catalog.expectedDisabled);
    expect(html.includes('在线充值尚未开放')).toBe(catalog.expectedDisabled);
  });
});
