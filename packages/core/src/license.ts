import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { LicenseApiClient, LicenseError } from '@judesk/license-client';
import { json, type PrismaClient } from '../../database/src/index';
import type { AppHost } from './types';

// Retain the old config/file names so installed clients keep their cloud account.
export type DesktopLicenseConfig = { serverUrl?: string };
type User = { id: string; email: string; emailVerified: boolean; name: string; role?: string };
export type SoftwarePlan = {
  id: string;
  code: string;
  name: string;
  description: string;
  days: number;
  priceCents: number;
  enabled: boolean;
};
export type SubscriptionState = {
  plan: 'free' | 'pro';
  proExpiresAt: string | null;
  features: { byok: boolean };
};
export type SoftwareCatalog = {
  softwareFree: boolean;
  byokRequiresPro: boolean;
  paymentEnabled: boolean;
  paymentProvider: 'hupijiao' | null;
  plans: SoftwarePlan[];
};
export type CloudCatalog = {
  paymentEnabled: boolean;
  paymentProvider: 'hupijiao' | null;
  models: Array<{
    id: string;
    model: string;
    displayName: string;
    kind: 'chat' | 'embedding';
    inputPriceCnyPerMillion: number;
    outputPriceCnyPerMillion: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    dimensions?: number | null;
  }>;
};

const freeSubscription = (): SubscriptionState => ({
  plan: 'free',
  proExpiresAt: null,
  features: { byok: false },
});

export const isCloudModel = (model: { id?: unknown }) =>
  typeof model.id === 'string' && model.id.startsWith('cloud:');

export class DesktopLicense {
  private user?: User;
  private client?: LicenseApiClient;
  private queue: Promise<unknown> = Promise.resolve();
  private lastError = '';
  private subscription: SubscriptionState = freeSubscription();
  private softwareCatalog: SoftwareCatalog = {
    softwareFree: true,
    byokRequiresPro: true,
    paymentEnabled: false,
    paymentProvider: null,
    plans: [],
  };
  onChanged = () => {};
  constructor(
    readonly db: PrismaClient,
    readonly dir: string,
    readonly host: AppHost,
    readonly config: DesktopLicenseConfig,
  ) {
    if (config.serverUrl) {
      try {
        this.client = new LicenseApiClient(config.serverUrl);
      } catch {
        this.lastError = '云端 AI 服务地址无效，请联系软件提供方';
      }
    }
  }
  private get file() {
    return join(this.dir, 'license', 'state.json');
  }
  private async persist() {
    await mkdir(join(this.dir, 'license'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ user: this.user, subscription: this.subscription }), {
      mode: 0o600,
    });
    await rename(tmp, this.file);
  }
  private serial<T>(action: () => Promise<T>) {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      this.user = saved.user;
      if (saved.subscription?.features) this.subscription = saved.subscription;
    } catch {
      /* New install. */
    }
    if (this.client) {
      try {
        this.client.token = (await this.host.secretGet('license-session')) || undefined;
      } catch {
        /* No saved cloud session. */
      }
    }
    // Never trust a cached Pro flag without a live session.
    if (this.client?.token && this.user) {
      void this.refreshSubscription().catch(() => {});
    } else {
      this.user = undefined;
      if (this.client) this.client.token = undefined;
      this.applySubscription(null);
      await this.persist().catch(() => {});
    }
  }
  async close() {
    await this.queue;
  }
  private api() {
    if (!this.client)
      throw new LicenseError('CLOUD_NOT_CONFIGURED', '此安装包尚未配置云端服务，请联系软件提供方');
    return this.client;
  }
  private async clearSession() {
    if (this.client) this.client.token = undefined;
    this.user = undefined;
    this.subscription = freeSubscription();
    await this.host.secretPut('', 'license-session');
    await this.persist();
    this.onChanged();
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    try {
      return await this.api().request<T>(path, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : '云端服务暂时不可用';
      const changed = this.lastError !== message;
      this.lastError = message;
      if (error instanceof LicenseError && error.status === 401 && this.client?.token)
        await this.clearSession();
      else if (changed) this.onChanged();
      throw error;
    }
  }
  /**
   * BYOK (custom API key) policy:
   * - No cloud server configured → allow (self-host / local tests).
   * - Cloud configured → require active Pro (or admin) from /me.
   */
  canUseByok() {
    if (!this.client) return true;
    return this.subscription.features.byok === true;
  }
  assertByokAllowed() {
    if (this.canUseByok()) return;
    if (!this.client?.token || !this.user)
      throw new LicenseError('PRO_REQUIRED', '使用自己的 API Key 需要登录并开通句达 Pro', 402);
    throw new LicenseError(
      'PRO_REQUIRED',
      '使用自己的 API Key 需要句达 Pro。请在云端账号中购买或续费。',
      402,
    );
  }
  cloudConnection() {
    const api = this.api();
    if (!api.token || !this.user)
      throw new LicenseError('CLOUD_LOGIN_REQUIRED', '请登录云端 AI 账号');
    return { baseUrl: `${api.baseUrl.replace(/\/$/, '')}/api/ai/v1`, apiKey: api.token };
  }
  async state() {
    return {
      configured: !!this.client,
      loggedIn: !!this.client?.token && !!this.user,
      user: this.user || null,
      lastError: this.lastError,
      byokRequiresPro: !!this.client,
      canUseByok: this.canUseByok(),
      subscription: this.subscription,
      software: {
        paymentEnabled: this.softwareCatalog.paymentEnabled,
        paymentProvider: this.softwareCatalog.paymentProvider,
        plans: this.softwareCatalog.plans,
      },
    };
  }
  private applySubscription(raw?: Partial<SubscriptionState> | null) {
    if (!raw?.features) {
      this.subscription = freeSubscription();
      return;
    }
    this.subscription = {
      plan: raw.plan === 'pro' ? 'pro' : 'free',
      proExpiresAt: raw.proExpiresAt ?? null,
      features: { byok: !!raw.features.byok },
    };
  }
  private async refreshSoftwareCatalog() {
    if (!this.client) return this.softwareCatalog;
    try {
      const catalog = await this.request<SoftwareCatalog>('/catalog');
      this.softwareCatalog = {
        softwareFree: catalog.softwareFree !== false,
        byokRequiresPro: catalog.byokRequiresPro !== false,
        paymentEnabled: !!catalog.paymentEnabled,
        paymentProvider: catalog.paymentProvider ?? null,
        plans: Array.isArray(catalog.plans) ? catalog.plans : [],
      };
      this.lastError = '';
    } catch {
      /* Keep last known catalog. */
    }
    return this.softwareCatalog;
  }
  private async refreshSubscription() {
    if (!this.client?.token) {
      this.applySubscription(null);
      await this.refreshSoftwareCatalog();
      return;
    }
    const overview = await this.request<{
      user: User;
      subscription?: SubscriptionState;
    }>('/me');
    this.user = overview.user;
    this.applySubscription(overview.subscription);
    await this.refreshSoftwareCatalog();
    await this.persist();
  }
  private cloudModelFields(model: CloudCatalog['models'][number], dimensions?: number) {
    const resolved = model.kind === 'embedding' ? dimensions || model.dimensions : null;
    return {
      name: `句达云端 · ${model.displayName}`,
      kind: model.kind,
      provider: 'openai',
      model: model.id,
      baseUrl: this.cloudConnection().baseUrl,
      secretRef: null,
      dimensions: resolved ?? null,
      // Cloud profiles are managed by the catalog, not editable locally. Respect
      // the administrator's output budget instead of silently capping it at 2048.
      maxTokens:
        Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0
          ? model.maxOutputTokens
          : 2048,
      timeoutMs: 180000,
    };
  }
  private async persistCloudModel(model: CloudCatalog['models'][number], dimensions?: number) {
    const fields = this.cloudModelFields(model, dimensions);
    if (model.kind === 'embedding' && !fields.dimensions) return null;
    const id = `cloud:${model.id}`;
    const existing = await this.db.modelProfile.findUnique({ where: { id } });
    if (!existing) return this.db.modelProfile.create({ data: { id, ...fields } });
    const unchanged =
      existing.name === fields.name &&
      existing.kind === fields.kind &&
      existing.model === fields.model &&
      existing.baseUrl === fields.baseUrl &&
      existing.dimensions === fields.dimensions &&
      existing.maxTokens === fields.maxTokens;
    if (unchanged) return existing;
    return this.db.modelProfile.update({
      where: { id },
      data: { ...fields, revision: { increment: 1 } },
    });
  }
  private async applyCloudDefaults(models: Array<{ id: string; kind: string }>) {
    const chat = models.find((model) => model.kind === 'chat');
    const embedding = models.find((model) => model.kind === 'embedding');
    const currentChat = await this.db.appSetting.findUnique({ where: { key: 'defaultModelId' } });
    const currentEmbedding = await this.db.appSetting.findUnique({
      where: { key: 'embeddingProfileId' },
    });
    const currentMode = await this.db.appSetting.findUnique({ where: { key: 'aiSetupMode' } });
    if (!currentMode?.value || currentMode.value === 'later')
      await this.db.appSetting.upsert({
        where: { key: 'aiSetupMode' },
        create: { key: 'aiSetupMode', value: json('cloud') },
        update: { value: json('cloud') },
      });
    if (chat && typeof currentChat?.value !== 'string')
      await this.db.appSetting.upsert({
        where: { key: 'defaultModelId' },
        create: { key: 'defaultModelId', value: json(chat.id) },
        update: { value: json(chat.id) },
      });
    if (embedding && typeof currentEmbedding?.value !== 'string') {
      await this.db.appSetting.upsert({
        where: { key: 'embeddingProfileId' },
        create: { key: 'embeddingProfileId', value: json(embedding.id) },
        update: { value: json(embedding.id) },
      });
      await this.db.knowledgeIndexRecord.updateMany({ data: { status: 'pending' } });
      const entries = await this.db.knowledgeEntry.findMany({ where: { status: 'enabled' } });
      for (const entry of entries)
        if (entry.activeRevisionId)
          await this.db.job.upsert({
            where: { dedupKey: `index:${entry.activeRevisionId}:${embedding.id}` },
            create: {
              kind: 'index',
              storeId: entry.storeId,
              dedupKey: `index:${entry.activeRevisionId}:${embedding.id}`,
              priority: 80,
              payload: { revisionId: entry.activeRevisionId },
            },
            update: { status: 'pending', attempts: 0, runAfter: new Date() },
          });
    }
  }
  private async syncCloudCatalog(catalog?: CloudCatalog) {
    this.cloudConnection();
    const next = catalog ?? (await this.request<CloudCatalog>('/ai/catalog'));
    const saved = [];
    for (const model of next.models) {
      const profile = await this.persistCloudModel(model);
      if (profile) saved.push(profile);
    }
    await this.applyCloudDefaults(saved);
    return next;
  }
  private async useCloudModel(input: Record<string, any>) {
    this.cloudConnection();
    const catalog = await this.request<CloudCatalog>('/ai/catalog');
    const model = catalog.models.find((item) => item.id === input.modelId);
    if (!model) throw new Error('云端模型已停用或不存在，请刷新模型列表');
    const saved = await this.persistCloudModel(model, input.dimensions);
    if (!saved) throw new Error('Embedding 模型需要向量维度');
    await this.applyCloudDefaults([saved]);
    const { secretRef: _, ...safe } = saved;
    return { ...safe, source: 'cloud', hasKey: false };
  }
  private async afterAuth(token: string, user: User) {
    this.api().token = token;
    this.user = user;
    this.lastError = '';
    await this.host.secretPut(token, 'license-session');
    try {
      await this.refreshSubscription();
    } catch {
      this.applySubscription(null);
      await this.persist();
    }
    try {
      await this.syncCloudCatalog();
    } catch {
      /* 登录已成功；目录稍后再同步。 */
    }
    this.onChanged();
    return this.state();
  }
  async handle(method: string, input: Record<string, any>) {
    if (method === 'license.state') return this.state();
    return this.serial(async () => {
      if (method === 'license.logout') {
        try {
          if (this.client?.token) await this.client.request('/auth/logout', {});
        } catch {
          /* Always log out locally. */
        }
        await this.clearSession();
        this.lastError = '';
        return this.state();
      }
      if (['license.login', 'license.register', 'license.loginCode'].includes(method)) {
        const path =
          method === 'license.login'
            ? '/auth/login'
            : method === 'license.loginCode'
              ? '/auth/login-code'
              : '/auth/register';
        const result = await this.request<{ token: string; user: User }>(path, input);
        return this.afterAuth(result.token, result.user);
      }
      if (method === 'license.sendEmailCode') return this.request('/auth/email-code', input);
      if (method === 'license.resetPassword') return this.request('/auth/reset-password', input);
      if (method === 'license.refresh') {
        await this.refreshSubscription();
        try {
          await this.syncCloudCatalog();
        } catch {
          /* 刷新账号成功即可。 */
        }
        this.lastError = '';
        this.onChanged();
        return this.state();
      }
      if (method === 'license.cloudCatalog') return this.syncCloudCatalog();
      if (method === 'license.cloudUseModel') return this.useCloudModel(input);
      if (method === 'license.cloudWallet') return this.request('/ai/wallet');
      if (method === 'license.cloudUsage') return this.request('/ai/usage');
      if (method === 'license.cloudRecharge') return this.request('/ai/recharge-orders', input);
      if (method === 'license.cloudRechargeOrders') return this.request('/ai/recharge-orders');
      if (method === 'license.cloudRechargeStatus')
        return this.request(`/ai/recharge-orders/${encodeURIComponent(input.id)}`);
      if (method === 'license.softwareCatalog') {
        await this.refreshSoftwareCatalog();
        return this.state();
      }
      if (method === 'license.softwareOrders') return this.request('/software/orders');
      if (method === 'license.softwareOrder')
        return this.request(`/software/orders/${encodeURIComponent(input.id)}`);
      if (method === 'license.softwarePurchase') {
        const order = await this.request('/software/orders', input);
        return order;
      }
      if (method === 'license.inviteCode') return this.request('/invite-code', input);
      if (method === 'license.overview') {
        const overview = await this.request<{
          user: User;
          subscription?: SubscriptionState;
          inviteCode?: unknown;
        }>('/me');
        this.user = overview.user;
        this.applySubscription(overview.subscription);
        await this.persist();
        return { ...overview, subscription: this.subscription };
      }
      throw new Error('未知云端账号操作');
    });
  }
}
