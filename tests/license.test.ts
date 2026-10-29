import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopLicense } from '../packages/core/src/license';
import { defaultConfig } from '../packages/agent-config/src';
import { Router } from '../packages/core/src/router';
import { MastraAi } from '../packages/ai/src';
import { setup, waitFor, flush } from './helpers';
let fixture: Awaited<ReturnType<typeof setup>> | undefined;
let license: DesktopLicense | undefined;
afterEach(async () => {
  await license?.close();
  await fixture?.cleanup();
  vi.restoreAllMocks();
  fixture = undefined;
  license = undefined;
});
async function init(serverUrl: string | undefined = 'http://127.0.0.1:4318') {
  fixture = await setup();
  const t = fixture;
  const secrets = new Map<string, string>();
  t.host.secretGet = async (ref) => secrets.get(ref) || '';
  t.host.secretPut = async (value, ref = randomUUID()) => {
    secrets.set(ref, value);
    return ref;
  };
  const requests: Array<{ url: string; body: any; headers: any }> = [];
  let mode = 'ok';
  let cloudOutputLimit = 8000;
  let proExpiresAt: string | null = null;
  const user = { id: 'cloud-user', email: 'test@example.com', emailVerified: true, name: 'test' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    requests.push({
      url: path,
      body: JSON.parse(String(options?.body || '{}')),
      headers: options?.headers,
    });
    if (mode === 'offline') throw new TypeError('network unavailable');
    if (mode === 'expired')
      return new Response(
        JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: '请重新登录' } }),
        { status: 401 },
      );
    const data = /\/auth\/(login|login-code|register)$/.test(path)
      ? { token: 'cloud-session-secret', user }
      : path.endsWith('/auth/email-code')
        ? { verificationId: '00000000-0000-4000-8000-000000000001', retryAfter: 60 }
        : path.endsWith('/me')
          ? {
              user,
              subscription: {
                plan: proExpiresAt ? 'pro' : 'free',
                proExpiresAt,
                features: { byok: !!proExpiresAt },
              },
            }
          : path.endsWith('/catalog') && !path.includes('/ai/')
            ? {
                softwareFree: true,
                byokRequiresPro: true,
                paymentEnabled: true,
                paymentProvider: 'hupijiao',
                plans: [
                  {
                    id: 'plan_pro',
                    code: 'pro',
                    name: '句达 Pro',
                    description: '解锁自有 API Key',
                    days: 30,
                    priceCents: 9900,
                    enabled: true,
                  },
                ],
              }
            : path.endsWith('/ai/catalog')
              ? {
                  paymentEnabled: true,
                  paymentProvider: 'hupijiao',
                  models: [
                    {
                      id: 'cloud-chat',
                      model: 'upstream-model',
                      displayName: '云端模型',
                      kind: 'chat',
                      inputPriceCnyPerMillion: 2,
                      outputPriceCnyPerMillion: 8,
                      maxInputTokens: 32000,
                      maxOutputTokens: cloudOutputLimit,
                    },
                    {
                      id: 'cloud-embed',
                      model: 'upstream-embed',
                      displayName: '云端向量',
                      kind: 'embedding',
                      inputPriceCnyPerMillion: 0.7,
                      outputPriceCnyPerMillion: 0,
                      maxInputTokens: 8000,
                      maxOutputTokens: 0,
                      dimensions: 8,
                    },
                  ],
                }
              : path.includes('/software/orders')
                ? {
                    id: 'pro-order',
                    outTradeNo: 'PROtest',
                    planId: 'plan_pro',
                    planCode: 'pro',
                    planName: '句达 Pro',
                    days: 30,
                    amountCents: 9900,
                    status: 'pending',
                    qrCodeUrl: 'https://pay.example/qr.png',
                    expiresAt: new Date(Date.now() + 300_000).toISOString(),
                  }
                : { ok: true };
    return new Response(JSON.stringify(data));
  });
  license = new DesktopLicense(t.db, t.dir, t.host, { serverUrl });
  await license.initialize();
  t.engine.license = license;
  return {
    ...t,
    license,
    secrets,
    requests,
    setMode: (value: string) => {
      mode = value;
    },
    setCloudOutputLimit: (value: number) => {
      cloudOutputLimit = value;
    },
    setProExpiresAt: (value: string) => {
      proExpiresAt = value;
    },
    login: () => license!.handle('license.login', { email: user.email, password: 'test-password' }),
  };
}
it.each(['http://127.0.0.1:4318', ''])(
  '未登录时全部平台可登记店铺、启用接待和学习，人工发送可用（云端地址：%s）',
  async (serverUrl) => {
    const t = await init(serverUrl);
    expect(await t.license.state()).toMatchObject({
      configured: !!serverUrl,
      loggedIn: false,
    });
    for (const platform of ['pinduoduo', 'douyin', 'goofish', 'kuaishou'] as const) {
      const account = await t.engine.registerAccount({
        platform,
        partition: `persist:free-${platform}`,
        mallId: 'unbound-shop',
        mallName: '免费店铺',
        externalId: 'free-account',
        name: '免费客服',
        capabilities: t.account.capabilities as any,
      });
      await t.db.account.update({ where: { id: account.id }, data: { verifiedAt: new Date() } });
      await t.engine.setPolicy({
        storeId: account.storeId,
        autoReplyEnabled: true,
        autoLearnEnabled: true,
      });
      expect(
        await t.db.replyPolicy.findUnique({ where: { storeId: account.storeId } }),
      ).toMatchObject({
        autoReplyEnabled: true,
      });
      expect(
        await t.db.learningPolicy.findUnique({ where: { storeId: account.storeId } }),
      ).toMatchObject({
        autoLearnEnabled: true,
      });
    }
    const router = new Router(t.engine, {} as any);
    await expect(
      router.call('app.settings', { developerModeEnabled: true, aiSetupMode: 'own' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true }),
    ).resolves.toBeUndefined();
    const connect = vi.spyOn(t.host, 'connect');
    await router.call('accounts.connect', { platform: 'douyin' });
    expect(connect).toHaveBeenCalled();
    const inbound = await t.engine.ingest(t.inbound());
    const outbound = await t.engine.enqueueManualText({
      conversationId: inbound.conversationId,
      text: '免费人工发送',
      requestId: randomUUID(),
    });
    await waitFor(
      async () =>
        (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } })).status ===
        'confirmed',
    );
    expect(t.requests).toHaveLength(0);
  },
);
it('无云端配置也能发布并执行自定义 Agent，不替换成内置助手', async () => {
  const t = await init('');
  const router = new Router(t.engine, {} as any);
  await router.call('app.settings', { developerModeEnabled: true, aiSetupMode: 'own' });
  const agent = (await router.call('agents.save', {
    config: { ...defaultConfig(t.model.id), name: '自定义助手', prompt: '按店铺自定义规则回复' },
  })) as any;
  const revision = (await router.call('agents.publish', {
    id: agent.id,
    expectedRevision: agent.draftRevision,
  })) as any;
  await router.call('agents.bind', {
    scopeKey: `store:${t.account.storeId}`,
    agentId: agent.id,
    expectedRevision: null,
  });
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  const reply = vi.spyOn(t.ai, 'reply');
  await t.engine.ingest(t.inbound());
  await flush(t.engine, t.db);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply.mock.calls[0][0]).toMatchObject({
    revisionId: revision.id,
    config: { prompt: '按店铺自定义规则回复' },
  });
  expect(t.sends).toHaveLength(1);
  expect(t.requests).toHaveLength(0);
});
it('云端登录不激活设备，凭据仅进入密钥存储并可重启恢复', async () => {
  const t = await init();
  await t.login();
  expect(t.requests.map((r) => r.url)).toEqual([
    'http://127.0.0.1:4318/api/auth/login',
    'http://127.0.0.1:4318/api/me',
    'http://127.0.0.1:4318/api/catalog',
    'http://127.0.0.1:4318/api/ai/catalog',
  ]);
  expect(await t.db.modelProfile.findUnique({ where: { id: 'cloud:cloud-chat' } })).toMatchObject({
    kind: 'chat',
    model: 'cloud-chat',
    maxTokens: 8000,
  });
  expect(await t.db.modelProfile.findUnique({ where: { id: 'cloud:cloud-embed' } })).toMatchObject({
    kind: 'embedding',
    dimensions: 8,
  });
  expect(await t.db.appSetting.findUnique({ where: { key: 'embeddingProfileId' } })).toMatchObject({
    value: 'cloud:cloud-embed',
  });
  expect(t.secrets.get('license-session')).toBe('cloud-session-secret');
  expect(JSON.stringify(await t.license.state())).not.toContain('cloud-session-secret');
  const cached = await readFile(join(t.dir, 'license', 'state.json'), 'utf8');
  expect(cached).not.toContain('cloud-session-secret');
  const restored = new DesktopLicense(t.db, t.dir, t.host, {
    serverUrl: 'http://127.0.0.1:4318',
  });
  await restored.initialize();
  expect(restored.cloudConnection().apiKey).toBe('cloud-session-secret');
  // Soft refresh may hit /me and /catalog; session itself is restored from secret storage.
  expect(t.requests.some((r) => /\/auth\/login$/.test(r.url))).toBe(true);
  expect(t.requests.filter((r) => /\/auth\/login$/.test(r.url))).toHaveLength(1);
  await restored.close();
});
it('云端输出预算跟随目录，刷新可更新旧的 2048 限制，已发布助手需要重新发布才采用新值', async () => {
  const t = await init();
  await t.login();
  const id = 'cloud:cloud-chat';
  const legacy = await t.db.modelProfile.update({
    where: { id },
    data: { maxTokens: 2048, revision: { increment: 1 } },
  });
  const definition = await t.engine.agents.save({ config: defaultConfig(id) });
  const previous = await t.engine.agents.publish(definition.id, definition.draftRevision);
  expect(previous.configSnapshot).toMatchObject({ modelSnapshot: { maxTokens: 2048 } });

  await t.license.handle('license.cloudCatalog', {});
  expect(await t.db.modelProfile.findUniqueOrThrow({ where: { id } })).toMatchObject({
    maxTokens: 8000,
    revision: legacy.revision + 1,
  });
  await t.license.handle('license.cloudCatalog', {});
  expect(await t.db.modelProfile.findUniqueOrThrow({ where: { id } })).toMatchObject({
    maxTokens: 8000,
    revision: legacy.revision + 1,
  });
  expect(await t.db.agentRevision.findUnique({ where: { id: previous.id } })).toEqual(previous);
  const published = await t.engine.agents.publish(definition.id, definition.draftRevision);
  expect(published.configSnapshot).toMatchObject({ modelSnapshot: { maxTokens: 8000 } });

  t.setCloudOutputLimit(1024);
  await t.license.handle('license.cloudCatalog', {});
  expect(await t.db.modelProfile.findUniqueOrThrow({ where: { id } })).toMatchObject({
    maxTokens: 1024,
    revision: legacy.revision + 2,
  });
  t.setCloudOutputLimit(0);
  await t.license.handle('license.cloudCatalog', {});
  expect(await t.db.modelProfile.findUniqueOrThrow({ where: { id } })).toMatchObject({
    maxTokens: 2048,
  });
});
it('断网和云端会话过期不会停用本地功能，云端调用要求重新登录', async () => {
  const t = await init();
  await t.login();
  t.setMode('offline');
  await expect(t.license.handle('license.refresh', {})).rejects.toThrow();
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  t.setMode('expired');
  await expect(t.license.handle('license.cloudWallet', {})).rejects.toThrow('请重新登录');
  expect((await t.license.state()).loggedIn).toBe(false);
  expect(() => t.license.cloudConnection()).toThrow('请登录云端 AI');
  const inbound = await t.engine.ingest(t.inbound());
  const outbound = await t.engine.enqueueManualText({
    conversationId: inbound.conversationId,
    text: '云端掉线后仍可接待',
    requestId: randomUUID(),
  });
  await waitFor(
    async () =>
      (await t.db.outboundMessage.findUniqueOrThrow({ where: { id: outbound.id } })).status ===
      'confirmed',
  );
  expect(t.secrets.get('license-session')).toBe('');
});
it('云端模型无密钥快照，运行时从当前会话和固定网关解析，登出只影响云端', async () => {
  const t = await init();
  await expect(
    t.license.handle('license.cloudUseModel', { modelId: 'cloud-chat' }),
  ).rejects.toThrow('请登录');
  await t.login();
  const model = (await t.license.handle('license.cloudUseModel', { modelId: 'cloud-chat' })) as any;
  expect(model).toMatchObject({
    id: 'cloud:cloud-chat',
    model: 'cloud-chat',
    source: 'cloud',
    hasKey: false,
  });
  expect(model.secretRef).toBeUndefined();
  const stored = await t.db.modelProfile.findUniqueOrThrow({ where: { id: model.id } });
  expect(stored.secretRef).toBeNull();
  const runtime = Object.create(MastraAi.prototype) as any;
  runtime.host = t.host;
  runtime.license = t.license;
  // Stale/mutated snapshots must never send the cloud session to an arbitrary URL.
  expect(
    await runtime.runtimeModel({ ...stored, baseUrl: 'https://evil.example/v1' }),
  ).toMatchObject({ url: 'http://127.0.0.1:4318/api/ai/v1', apiKey: 'cloud-session-secret' });
  const router = new Router(t.engine, {} as any);
  await expect(
    router.call('models.save', {
      id: model.id,
      name: '改写',
      kind: 'chat',
      model: 'x',
      baseUrl: 'https://evil.example/v1',
    }),
  ).rejects.toThrow('云端模型由服务端管理');
  await t.license.handle('license.logout', {});
  await expect(runtime.runtimeModel(stored)).rejects.toThrow('请登录');
  t.secrets.set('own-secret', 'my-key');
  await expect(
    runtime.runtimeModel({
      id: 'own',
      provider: 'openai',
      model: 'x',
      secretRef: 'own-secret',
      baseUrl: 'https://own.example/v1',
    }),
  ).rejects.toThrow(/Pro/);
});
it('未配置云端服务时允许自有 API Key；配置后需 Pro', async () => {
  const open = await init('');
  expect((await open.license.state()).canUseByok).toBe(true);
  const router = new Router(open.engine, {} as any);
  await expect(
    router.call('models.save', {
      name: '自有',
      kind: 'chat',
      model: 'gpt',
      baseUrl: 'https://own.example/v1',
      apiKey: 'k',
    }),
  ).resolves.toMatchObject({ hasKey: true });

  const gated = await init('http://127.0.0.1:4318');
  expect((await gated.license.state()).canUseByok).toBe(false);
  const gatedRouter = new Router(gated.engine, {} as any);
  await expect(
    gatedRouter.call('models.save', {
      name: '自有',
      kind: 'chat',
      model: 'gpt',
      baseUrl: 'https://own.example/v1',
      apiKey: 'k',
    }),
  ).rejects.toThrow(/Pro/);

  await gated.login();
  expect((await gated.license.state()).canUseByok).toBe(false);
  // An admin grant updates the server; refreshing must fetch it without login.
  const proExpiresAt = new Date(Date.now() + 86400000).toISOString();
  gated.setProExpiresAt(proExpiresAt);
  expect((await gated.license.state()).canUseByok).toBe(false);
  expect(await gated.license.handle('license.refresh', {})).toMatchObject({
    loggedIn: true,
    canUseByok: true,
    subscription: { plan: 'pro', proExpiresAt, features: { byok: true } },
  });
  await expect(
    gatedRouter.call('models.save', {
      name: '自有 Pro',
      kind: 'chat',
      model: 'gpt',
      baseUrl: 'https://own.example/v1',
      apiKey: 'k',
    }),
  ).resolves.toMatchObject({ hasKey: true });
});
it('验证码登录无需激活，且不会把验证码保存到缓存', async () => {
  const t = await init();
  const sent = (await t.license.handle('license.sendEmailCode', {
    email: 'test@example.com',
    purpose: 'login',
  })) as any;
  await t.license.handle('license.loginCode', {
    email: 'test@example.com',
    verificationId: sent.verificationId,
    code: '482195',
  });
  expect((await t.license.state()).loggedIn).toBe(true);
  expect(t.requests.some((request) => /auth\/login-code$/.test(request.url))).toBe(true);
  expect(t.requests.at(-1)?.url).toMatch(/ai\/catalog$/);
  const cached = await readFile(join(t.dir, 'license', 'state.json'), 'utf8');
  expect(cached).not.toContain('482195');
  expect(cached).not.toContain(sent.verificationId);
});
it('云端充值参数有金额和幂等键校验', async () => {
  const t = await init();
  const router = new Router(t.engine, {} as any);
  await expect(
    router.call('license.cloudRecharge', { amountCents: -1, requestId: randomUUID() }),
  ).rejects.toThrow();
  await expect(
    router.call('license.cloudRecharge', { amountCents: 100, requestId: 'bad' }),
  ).rejects.toThrow();
  expect(t.requests).toHaveLength(0);
});
it('桌面充值只向 license 后端下单和查询，重复提交保持相同请求号', async () => {
  const t = await init();
  await t.login();
  const request = { amountCents: 5000, requestId: randomUUID() };
  await t.license.handle('license.cloudRecharge', request);
  await t.license.handle('license.cloudRecharge', request);
  await t.license.handle('license.cloudRechargeStatus', { id: 'hupijiao-order' });
  const payments = t.requests.filter((item) => item.url.includes('/ai/recharge-orders'));
  expect(payments.map((item) => ({ url: item.url, body: item.body }))).toEqual([
    { url: 'http://127.0.0.1:4318/api/ai/recharge-orders', body: request },
    { url: 'http://127.0.0.1:4318/api/ai/recharge-orders', body: request },
    { url: 'http://127.0.0.1:4318/api/ai/recharge-orders/hupijiao-order', body: {} },
  ]);
});
