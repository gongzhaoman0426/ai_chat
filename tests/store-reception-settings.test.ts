import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { OnboardingState } from '../packages/core/src/onboarding';
import { StoreReceptionSettings } from '../apps/desktop/src/renderer/components/store-reception-settings';

function onboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    guideState: null,
    autoOpen: false,
    store: {
      id: 'store-reception-test',
      name: '测试店铺',
      configEpoch: 1,
      autoLearnEnabled: false,
    },
    models: [{ id: 'chat-test', name: '客服模型', model: 'test-chat', revision: 1 }],
    embeddingModels: [],
    embedding: {
      ready: false,
      profileId: undefined,
      name: undefined,
      model: undefined,
      dimensions: undefined,
    },
    agent: {
      ready: true,
      canConfigure: false,
      canChangeModel: true,
      name: '测试客服助手',
      modelId: 'chat-test',
      model: 'test-chat',
      reason: '模型已应用到本店助手。',
    },
    connected: true,
    readiness: { ready: true, action: null, reason: '账号已具备自动接待条件。' },
    enabled: false,
    ready: true,
    nextStep: 4,
    completedSteps: 2,
    ...overrides,
  };
}

function renderSettings(data: OnboardingState, initialStep?: number) {
  const store = {
    id: data.store!.id,
    name: data.store!.name,
    accounts: [
      {
        id: 'account-test',
        name: '测试客服账号',
        status: data.connected ? 'online' : 'offline',
        verifiedAt: '2026-09-17T00:00:00.000Z',
        capabilities: { receive: true, sendText: true },
      },
    ],
    replyPolicy: { version: 1, autoReplyEnabled: false, directMatchThreshold: 0.6 },
    learningPolicy: { version: 1, autoLearnEnabled: false, builtinModelRef: 'chat-test' },
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['onboarding.state', { storeId: store.id }], data);
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(StoreReceptionSettings, {
          store,
          models: data.models,
          developerMode: false,
          management: true,
          initialStep,
        }),
      ),
    );
  } finally {
    cache.clear();
  }
}

function expectStep(html: string, label: string, heading: string) {
  expect(html.match(/aria-pressed="(?:true|false)"/g)).toHaveLength(3);
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  const selected = html.match(/<button aria-pressed="true"[^>]*>(.*?)<\/button>/s)?.[1];
  expect(selected).toContain(`<strong>${label}</strong>`);
  expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain(`<h2>${heading}</h2>`);
}

describe('店铺管理的三步接待设置', () => {
  it('已配置助手的店铺即使引导 nextStep 为 4，也渲染自动接待步骤而不崩溃', () => {
    expectStep(renderSettings(onboarding()), '自动接待', '自动回复与学习');
  });

  it('已设置 Embedding 但没有助手时，引导 nextStep 为 3 仍进入客服助手步骤', () => {
    const data = onboarding({
      agent: { ready: false, canConfigure: true, reason: '请选择回复模型。' },
      embeddingModels: [
        {
          id: 'embedding-test',
          name: '检索模型',
          model: 'test-embedding',
          dimensions: 1024,
          revision: 1,
        },
      ],
      embedding: {
        ready: true,
        profileId: 'embedding-test',
        name: '检索模型',
        model: 'test-embedding',
        dimensions: 1024,
      },
      ready: false,
      nextStep: 3,
      completedSteps: 1,
    });
    expectStep(renderSettings(data), '客服助手', '客服助手与模型');
  });

  it('未设置 Embedding 且没有助手时，仍进入客服助手步骤', () => {
    const data = onboarding({
      agent: { ready: false, canConfigure: true, reason: '请选择回复模型。' },
      ready: false,
      nextStep: 2,
      completedSteps: 1,
    });
    expectStep(renderSettings(data), '客服助手', '客服助手与模型');
  });

  it('尚未连接的店铺进入平台账号步骤', () => {
    const data = onboarding({
      connected: false,
      readiness: { ready: false, action: 'connect', reason: '请先连接店铺客服账号。' },
      ready: false,
      nextStep: 1,
      completedSteps: 1,
    });
    expectStep(renderSettings(data), '平台账号', '平台客服账号');
  });

  it.each([
    [1, '平台账号', '平台客服账号'],
    [2, '客服助手', '客服助手与模型'],
    [3, '自动接待', '自动回复与学习'],
  ] as const)('保留显式 initialStep=%s 的导航目标', (step, label, heading) => {
    expectStep(renderSettings(onboarding(), step), label, heading);
  });

  it.each([4, 0, -1, 1.5, NaN])('非法 initialStep=%s 回退到店铺默认步骤', (step) => {
    expectStep(renderSettings(onboarding(), step), '自动接待', '自动回复与学习');
  });

  it('非法步骤按未配置助手的店铺状态回退，不直接截断为最后一步', () => {
    const data = onboarding({
      agent: { ready: false, canConfigure: true, reason: '请选择回复模型。' },
      ready: false,
      nextStep: 2,
      completedSteps: 1,
    });
    expectStep(renderSettings(data, 4), '客服助手', '客服助手与模型');
  });
});
