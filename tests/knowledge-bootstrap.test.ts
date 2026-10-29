import { afterEach, expect, it, vi } from 'vitest';
import { setup, waitFor } from './helpers';
import { KnowledgeBootstrapService } from '../packages/core/src/knowledge-bootstrap';
import { Router } from '../packages/core/src/router';
import type { MastraAi } from '../packages/ai/src';
import type {
  KnowledgeBootstrapSource,
  KnowledgeBootstrapState,
} from '../packages/contracts/src/knowledge-bootstrap';
import { qaSchema } from '../packages/contracts/src';
import { json } from '../packages/database/src';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});

const qa = (intent: string, answer = '商品采用纯棉材质，可按说明清洗。') =>
  qaSchema.parse({ intent, answerKind: 'text', answer, scope: { productIds: [], conditions: '' } });
const result = (
  operation: string,
  data: Record<string, unknown>,
  subjectId?: string,
  failedSections: Array<{ section: string; reason: string }> = [],
) => ({
  operation,
  queriedAt: new Date().toISOString(),
  partial: failedSections.length > 0,
  failedSections,
  data,
  ...(subjectId ? { subjectId } : {}),
});
const generate = vi.fn(async (_model: unknown, sources: KnowledgeBootstrapSource[]) => ({
  drafts: sources.map((source) => ({
    sourceIds: [source.id],
    qa: qa(`如何使用 ${source.id}`),
  })),
}));

async function completed(service: KnowledgeBootstrapService, storeId: string) {
  let state: KnowledgeBootstrapState | null = null;
  await waitFor(async () => {
    state = await service.state(storeId);
    return !!state && state.status !== 'running';
  });
  return state! as KnowledgeBootstrapState;
}

async function conversation(buyerId: string) {
  return f!.db.conversation.create({
    data: {
      storeId: f!.account.storeId,
      accountId: f!.account.id,
      buyerId,
      buyerName: `买家 ${buyerId}`,
      externalKey: `buyer:${buyerId}`,
    },
  });
}

async function message(
  conversationId: string,
  externalId: string,
  direction: 'in' | 'out',
  text: string,
  extra: { withdrawn?: boolean; origin?: string } = {},
) {
  return f!.db.message.create({
    data: {
      storeId: f!.account.storeId,
      conversationId,
      externalId,
      direction,
      origin: extra.origin ?? (direction === 'in' ? 'buyer' : 'human'),
      text,
      timestamp: new Date('2026-09-01T01:00:00Z'),
      raw: {},
      ...extra,
    },
  });
}

function singleProductHost() {
  return vi.fn(async (_accountId: string, operation: string, input: Record<string, unknown>) => {
    if (operation === 'conversations') return [];
    if (operation === 'goods')
      return result('goods', { products: [{ goodsId: '101', title: '纯棉上衣' }], hasMore: false });
    if (operation === 'goods-detail')
      return result(
        operation,
        { goodsId: input.goodsId, description: '纯棉，可水洗' },
        String(input.goodsId),
      );
    throw new Error(`unexpected query ${operation}`);
  });
}

it('遍历商品分页及详情，保留来源和部分读取提示，只生成草稿而不自动发布', async () => {
  f = await setup();
  const batches: KnowledgeBootstrapSource[][] = [];
  const generator = vi.fn(async (_model: unknown, sources: KnowledgeBootstrapSource[]) => {
    batches.push(sources);
    return {
      drafts: sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.label) })),
    };
  });
  const query = vi.fn(
    async (accountId: string, operation: string, input: Record<string, unknown>) => {
      expect(accountId).toBe(f!.account.id);
      if (operation === 'conversations') return [];
      if (operation === 'goods') {
        const page = Number(input.page);
        expect(input.pageSize).toBe(30);
        return result(operation, {
          groups: [{ items: [{ goodsId: String(100 + page), title: `商品 ${page}` }] }],
          pagination: { hasMore: page < 3 },
        });
      }
      if (operation === 'goods-detail')
        return result(
          operation,
          { detail: { description: `材质说明 ${input.goodsId}` } },
          String(input.goodsId),
          input.goodsId === '102' ? [{ section: 'properties', reason: '属性暂未返回' }] : [],
        );
      throw new Error(`unexpected query ${operation}`);
    },
  );
  f.host.query = query;
  const service = new KnowledgeBootstrapService(f.engine, generator);
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);

  expect(state.status).toBe('completed');
  expect(state.products).toBe(3);
  expect(state.drafts).toHaveLength(3);
  expect(state.drafts.map((draft) => draft.qa.scope.productIds)).toEqual([
    ['101'],
    ['102'],
    ['103'],
  ]);
  expect(state.warnings.join('\n')).toContain('属性暂未返回');
  expect(batches.flat().map((source) => source.content)).toEqual(
    [1, 2, 3].map((n) => ({
      product: { goodsId: String(100 + n), title: `商品 ${n}` },
      detail: { detail: { description: `材质说明 ${100 + n}` } },
    })),
  );
  expect(query.mock.calls.filter(([, operation]) => operation === 'goods')).toHaveLength(3);
  expect(query.mock.calls.filter(([, operation]) => operation === 'goods-detail')).toHaveLength(3);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  expect(f.sends).toEqual([]);
});

it('读取每个已同步会话的历史游标，合并去重并在平台失败时保留本机对话', async () => {
  f = await setup();
  const first = await conversation('201');
  const second = await conversation('202');
  await message(first.id, 'first-question', 'in', '这件衣服怎么洗');
  await message(first.id, 'withdrawn', 'out', '撤回的错误说明', { withdrawn: true });
  await message(second.id, 'second-question', 'in', '如何晾晒');
  await message(second.id, 'second-answer', 'out', '通风处自然晾干');
  const batches: KnowledgeBootstrapSource[][] = [];
  const generator = async (_model: unknown, sources: KnowledgeBootstrapSource[]) => {
    batches.push(sources);
    return { drafts: sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })) };
  };
  const query = vi.fn(
    async (_accountId: string, operation: string, input: Record<string, unknown>) => {
      if (operation === 'conversations') return [];
      if (operation === 'goods') return result(operation, { products: [], hasMore: false });
      expect(operation).toBe('history');
      if (input.buyerId === '202') throw new Error('平台历史暂不可用');
      expect(input.conversationKey).toBe(first.externalKey);
      if (input.cursor === '')
        return result(
          operation,
          {
            messages: [
              {
                messageId: 'first-question',
                direction: 'in',
                text: '这件衣服怎么洗',
                timestamp: '2026-09-01T01:00:00Z',
              },
              {
                messageId: 'first-answer',
                direction: 'out',
                text: '请用冷水轻柔手洗',
                timestamp: '2026-09-01T01:01:00Z',
              },
            ],
            hasMore: true,
            nextCursor: 'older-page',
          },
          '201',
        );
      expect(input.cursor).toBe('older-page');
      return result(
        operation,
        {
          messages: [
            {
              messageId: 'older-question',
              direction: 'in',
              text: '可以水洗吗',
              timestamp: '2026-08-31T01:00:00Z',
            },
          ],
          hasMore: false,
        },
        '201',
      );
    },
  );
  f.host.query = query;
  const service = new KnowledgeBootstrapService(f.engine, generator);
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('completed');
  expect(state.conversations).toBe(2);
  expect(state.messages).toBe(5);
  expect(
    state.drafts.every(
      (draft) =>
        draft.qa.scope.conditions ===
        '仅限原聊天所指的商品或场景；适用对象不明确时，先向买家确认，不作为全店通用承诺。',
    ),
  ).toBe(true);
  const sources = batches.flat();
  expect(sources).toHaveLength(2);
  expect(JSON.stringify(sources)).toContain('请用冷水轻柔手洗');
  expect(JSON.stringify(sources)).toContain('通风处自然晾干');
  expect(JSON.stringify(sources)).not.toContain('撤回的错误说明');
  expect(state.warnings.join('\n')).toContain('平台历史暂不可用');
  expect(query.mock.calls.filter(([, operation]) => operation === 'history')).toHaveLength(3);
  expect(await f.db.message.count()).toBe(4);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
});

it('千牛从本机同步消息生成并明确历史范围，不重复请求不可用的远程历史', async () => {
  f = await setup();
  await f.db.store.update({ where: { id: f.account.storeId }, data: { platform: 'qianniu' } });
  await f.db.account.update({ where: { id: f.account.id }, data: { status: 'offline' } });
  const chat = await conversation('301');
  await message(chat.id, 'q', 'in', '如何保养');
  await message(chat.id, 'a', 'out', '避免长时间暴晒');
  const query = vi.fn(async () => {
    throw new Error('不应发起平台请求');
  });
  f.host.query = query;
  const service = new KnowledgeBootstrapService(f.engine, generate);
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('completed');
  expect(state.messages).toBe(2);
  expect(state.drafts).toHaveLength(1);
  expect(state.warnings.join('\n')).toContain('千牛');
  expect(state.warnings.join('\n')).toContain('本机');
  expect(query).not.toHaveBeenCalled();
});

it('保存只接受本店批次草稿，重复提交不增生，重新生成同时去重已保存条目和未保存草稿', async () => {
  f = await setup();
  f.host.query = singleProductHost();
  const service = new KnowledgeBootstrapService(f.engine, generate);
  await service.start(f.account.storeId);
  const first = await completed(service, f.account.storeId);
  expect(first.drafts).toHaveLength(1);
  await service.start(f.account.storeId);
  const second = await completed(service, f.account.storeId);
  expect(second.drafts).toHaveLength(1);
  expect(second.drafts[0].id).toBe(first.drafts[0].id);
  await expect(service.apply(f.account.storeId, first.runId, first.drafts)).rejects.toThrow('批次');
  await expect(
    service.apply(f.account.storeId, second.runId, [second.drafts[0], second.drafts[0]]),
  ).rejects.toThrow('重复');

  const otherAccount = await f.engine.registerAccount({
    partition: 'persist:other-bootstrap',
    mallId: 'other-bootstrap-store',
    mallName: '其他店铺',
    externalId: 'other-account',
    name: '其他客服',
    capabilities: {
      receive: true,
      sendText: true,
      sendImage: true,
      goods: true,
      history: false,
      orders: false,
      verified: false,
    },
  });
  await service.start(otherAccount.storeId);
  const other = await completed(service, otherAccount.storeId);
  expect(other.drafts).toHaveLength(1);
  const crossStore = await service.apply(otherAccount.storeId, other.runId, second.drafts);
  expect(crossStore.saved).toBe(0);
  expect(crossStore.drafts).toHaveLength(1);
  expect(await f.db.knowledgeEntry.count()).toBe(0);

  const saved = await service.apply(f.account.storeId, second.runId, second.drafts);
  expect(saved.saved).toBe(1);
  expect(saved.drafts).toEqual([]);
  await service.apply(f.account.storeId, second.runId, second.drafts);
  expect(await f.db.knowledgeEntry.count()).toBe(1);
  expect(await f.db.knowledgeRevision.findFirst()).toMatchObject({ sourceKind: 'bootstrap' });
  expect(await f.db.knowledgeEntry.findFirst()).toMatchObject({ storeId: f.account.storeId });
  expect(await f.db.auditEvent.count({ where: { type: 'knowledge.bootstrap.save' } })).toBe(1);
  await service.start(f.account.storeId);
  const third = await completed(service, f.account.storeId);
  expect(third.saved).toBe(1);
  expect(third.drafts).toEqual([]);
});

it('重复商品页和历史游标会停止读取并保留警告与已经读取的资料', async () => {
  f = await setup();
  const chat = await conversation('401');
  await message(chat.id, 'q', 'in', '怎么保存');
  const query = vi.fn(
    async (_accountId: string, operation: string, input: Record<string, unknown>) => {
      if (operation === 'conversations') return [];
      if (operation === 'goods')
        return result(operation, { products: [{ goodsId: '101', title: '棉衣' }], hasMore: true });
      if (operation === 'goods-detail')
        return result(operation, { description: '干燥处存放' }, String(input.goodsId));
      return result(
        'history',
        {
          messages: [
            {
              messageId: 'a',
              direction: 'out',
              text: '请在干燥处存放',
              timestamp: '2026-09-01T01:01:00Z',
            },
          ],
          hasMore: true,
          nextCursor: 'same-cursor',
        },
        String(input.buyerId),
        [{ section: 'history', reason: '部分平台消息类型尚未识别' }],
      );
    },
  );
  f.host.query = query;
  const service = new KnowledgeBootstrapService(f.engine, generate);
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('completed');
  expect(state.products).toBe(1);
  expect(state.messages).toBe(2);
  expect(state.drafts).toHaveLength(2);
  expect(state.warnings.join('\n')).toContain('商品分页重复');
  expect(state.warnings.join('\n')).toContain('游标');
  expect(state.warnings.join('\n')).toContain('部分平台消息类型尚未识别');
  expect(query.mock.calls.filter(([, operation]) => operation === 'goods')).toHaveLength(2);
  expect(query.mock.calls.filter(([, operation]) => operation === 'history')).toHaveLength(2);
});

it('模型后续批次失败时保留已经持久化的草稿，并允许保存这些草稿', async () => {
  f = await setup();
  f.host.query = async (_accountId, operation, input) => {
    if (operation === 'conversations') return [];
    if (operation === 'goods')
      return result(operation, {
        products: Array.from({ length: 9 }, (_, i) => ({
          goodsId: String(101 + i),
          title: `商品 ${i}`,
        })),
        hasMore: false,
      });
    return result(operation, { description: '纯棉材质' }, String(input.goodsId));
  };
  let calls = 0;
  const generator = async (_model: unknown, sources: KnowledgeBootstrapSource[]) => {
    if (++calls === 2) throw new Error('模型请求中断');
    return { drafts: sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })) };
  };
  const service = new KnowledgeBootstrapService(f.engine, generator);
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('failed');
  expect(state.error).toContain('模型请求中断');
  expect(state.drafts.length).toBeGreaterThan(0);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  const saved = await service.apply(f.account.storeId, state.runId, state.drafts);
  expect(saved.saved).toBe(state.drafts.length);
  expect(await f.db.knowledgeEntry.count()).toBe(state.drafts.length);
});

it('应用重启将未完成批次标记为中断，同时保留可核对的草稿', async () => {
  f = await setup();
  const state: KnowledgeBootstrapState = {
    runId: 'previous-run',
    storeId: f.account.storeId,
    status: 'running',
    phase: '读取商品',
    products: 1,
    conversations: 0,
    messages: 0,
    warnings: [],
    saved: 0,
    drafts: [{ id: 'saved-draft', qa: qa('如何洗涤'), source: '商品资料' }],
    updatedAt: new Date().toISOString(),
  };
  await f.db.appSetting.create({
    data: { key: `knowledge.bootstrap:${f.account.storeId}`, value: json(state) },
  });
  const service = new KnowledgeBootstrapService(f.engine, generate);
  const recovered = await service.state(f.account.storeId);
  expect(recovered?.status).toBe('failed');
  expect(recovered?.error).toContain('中断');
  expect(recovered?.drafts).toEqual(state.drafts);
  expect((await service.state(f.account.storeId))?.drafts).toEqual(state.drafts);
});

it('模型不能捏造资料来源或外店商品，也不能把商品资料自动写成全店通用政策', async () => {
  f = await setup();
  f.host.query = singleProductHost();
  const service = new KnowledgeBootstrapService(f.engine, async (_model, sources) => ({
    drafts: [
      { sourceIds: ['missing-source'], qa: qa('捏造来源') },
      {
        sourceIds: [sources[0].id],
        qa: { ...qa('外店商品'), scope: { productIds: ['999'], conditions: '' } },
      },
      { sourceIds: [sources[0].id], qa: qa('材质是什么') },
    ],
  }));
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('completed');
  expect(state.drafts).toHaveLength(1);
  expect(state.drafts[0].qa).toMatchObject({
    intent: '材质是什么',
    scope: { productIds: ['101'] },
  });
  expect(state.warnings.join('\n')).toContain('来源');
  expect(state.warnings.join('\n')).toContain('商品范围');
});

it('商品规格按 nextOffset 继续分页，每批规格都保留原商品绑定', async () => {
  f = await setup();
  const base = singleProductHost();
  const query = vi.fn(
    async (accountId: string, operation: string, input: Record<string, unknown>) => {
      if (operation !== 'goods-skus') return base(accountId, operation, input);
      expect(input.limit).toBe(50);
      return result(
        operation,
        {
          goodsId: '101',
          items: [
            {
              skuId: input.offset === 0 ? '501' : '502',
              specs: [{ name: '颜色', value: input.offset === 0 ? '白色' : '黑色' }],
            },
          ],
          nextOffset: input.offset === 0 ? 50 : null,
        },
        '101',
      );
    },
  );
  const sources: KnowledgeBootstrapSource[] = [];
  f.host.query = query;
  const service = new KnowledgeBootstrapService(f.engine, async (_model, batch) => {
    sources.push(...batch);
    return { drafts: batch.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })) };
  });
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('completed');
  expect(state.products).toBe(1);
  expect(state.drafts).toHaveLength(3);
  expect(state.drafts.every((draft) => draft.qa.scope.productIds.join() === '101')).toBe(true);
  expect(
    query.mock.calls
      .filter(([, operation]) => operation === 'goods-skus')
      .map(([, , input]) => input.offset),
  ).toEqual([0, 50]);
  expect(JSON.stringify(sources)).toContain('白色');
  expect(JSON.stringify(sources)).toContain('黑色');
});

it('只有 senderId 的历史核验买家和客服身份，排除未知发言人及本机已知 AI 和撤回消息', async () => {
  f = await setup();
  await f.db.store.update({ where: { id: f.account.storeId }, data: { platform: 'douyin' } });
  const chat = await conversation('601');
  await message(chat.id, 'local-question', 'in', '如何清洗');
  await message(chat.id, 'local-ai', 'out', '旧 AI 生成答案', { origin: 'ai' });
  await message(chat.id, 'local-withdrawn', 'out', '旧撤回答案', { withdrawn: true });
  const sources: KnowledgeBootstrapSource[] = [];
  f.host.query = async (_accountId, operation) => {
    if (operation === 'goods') return result(operation, { products: [], hasMore: false });
    if (operation !== 'history') throw new Error(`unexpected ${operation}`);
    return result(
      operation,
      {
        messages: [
          {
            messageId: 'local-question',
            senderId: '601',
            text: '如何清洗',
            timestamp: '1788224400',
          },
          {
            messageId: 'verified-answer',
            senderId: f!.account.externalId,
            text: '建议冷水手洗',
            timestamp: '1788224460000',
          },
          {
            messageId: 'unknown-answer',
            senderId: 'other-person',
            text: '身份未知答案',
            timestamp: '1788224520',
          },
          {
            messageId: 'local-ai',
            direction: 'out',
            text: '历史重复 AI 答案',
            timestamp: '1788224580',
          },
          {
            messageId: 'local-withdrawn',
            direction: 'out',
            text: '历史重复撤回答案',
            timestamp: '1788224640',
          },
        ],
        hasMore: false,
      },
      '601',
    );
  };
  const service = new KnowledgeBootstrapService(f.engine, async (_model, batch) => {
    sources.push(...batch);
    return { drafts: batch.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })) };
  });
  await service.start(f.account.storeId);
  const state = await completed(service, f.account.storeId);
  expect(state.status).toBe('completed');
  expect(state.messages).toBe(2);
  expect(state.drafts).toHaveLength(1);
  const transcript = sources[0].content as Array<{
    direction: string;
    text: string;
    timestamp: string;
  }>;
  expect(transcript.map((item) => item.direction)).toEqual(['in', 'out']);
  expect(transcript.map((item) => item.text)).toEqual(['如何清洗', '建议冷水手洗']);
  expect(transcript.every((item) => /^\d{4}-\d{2}-\d{2}T/.test(item.timestamp))).toBe(true);
  expect(state.warnings.join('\n')).toContain('发言人');
});

it('并发启动共享同一批次，生成结束前不能保存草稿', async () => {
  f = await setup();
  f.host.query = singleProductHost();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generator = vi.fn(async (_model: unknown, sources: KnowledgeBootstrapSource[]) => {
    await blocked;
    return { drafts: sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })) };
  });
  const service = new KnowledgeBootstrapService(f.engine, generator);
  try {
    const [first, second] = await Promise.all([
      service.start(f.account.storeId),
      service.start(f.account.storeId),
    ]);
    expect(first.runId).toBe(second.runId);
    await waitFor(async () => generator.mock.calls.length === 1);
    const third = await service.start(f.account.storeId);
    expect(third.runId).toBe(first.runId);
    await expect(
      service.apply(f.account.storeId, first.runId, [{ id: 'invented', qa: qa('不可提前发布') }]),
    ).rejects.toThrow('生成完成');
    expect(await f.db.knowledgeEntry.count()).toBe(0);
  } finally {
    release();
    await completed(service, f.account.storeId);
  }
  expect(generator).toHaveBeenCalledTimes(1);
});

it('Router 校验初始化参数并复用同一服务跟踪异步生成、状态与保存', async () => {
  f = await setup();
  f.host.query = singleProductHost();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generateKnowledgeDrafts = vi.fn(
    async (_model: unknown, sources: KnowledgeBootstrapSource[]) => {
      await blocked;
      return { drafts: sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })) };
    },
  );
  const router = new Router(f.engine, { generateKnowledgeDrafts } as unknown as MastraAi);
  const input = { storeId: f.account.storeId };
  await expect(router.call('knowledge.bootstrapStart', {})).rejects.toThrow();
  await expect(
    router.call('knowledge.bootstrapState', { ...input, extra: true }),
  ).rejects.toThrow();
  await expect(
    router.call('knowledge.bootstrapApply', { ...input, runId: 'batch', rows: [] }),
  ).rejects.toThrow();
  expect(await router.call('knowledge.bootstrapState', input)).toBeNull();

  let state!: KnowledgeBootstrapState;
  try {
    const started = (await router.call(
      'knowledge.bootstrapStart',
      input,
    )) as KnowledgeBootstrapState;
    await waitFor(async () => generateKnowledgeDrafts.mock.calls.length === 1);
    expect(await router.call('knowledge.bootstrapState', input)).toMatchObject({
      runId: started.runId,
      status: 'running',
      products: 1,
    });
    expect(await router.call('knowledge.bootstrapStart', input)).toMatchObject({
      runId: started.runId,
    });
    expect(generateKnowledgeDrafts.mock.calls[0][0]).toMatchObject({ id: f.model.id });
  } finally {
    release();
    await waitFor(async () => {
      state = (await router.call('knowledge.bootstrapState', input)) as KnowledgeBootstrapState;
      return state.status !== 'running';
    });
  }
  expect(state.status).toBe('completed');
  expect(state.drafts).toHaveLength(1);
  expect(generateKnowledgeDrafts).toHaveBeenCalledTimes(1);
  const saved = await router.call('knowledge.bootstrapApply', {
    ...input,
    runId: state.runId,
    rows: state.drafts.map(({ id, qa }) => ({ id, qa })),
  });
  expect(saved).toMatchObject({ saved: 1, drafts: [] });
  expect(await f.db.knowledgeEntry.count({ where: { storeId: input.storeId } })).toBe(1);
});

async function stopPromptly() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      f!.engine.stop(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('关闭不应等待挂起的平台或模型请求')), 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

it('关闭时中止挂起的模型批次，保留已生成草稿，模型迟到结果不再写入数据库', async () => {
  f = await setup();
  await f.db.account.update({
    where: { id: f.account.id },
    data: {
      capabilities: json({
        ...(f.account.capabilities as object),
        operations: ['goods', 'goods-detail'],
      }),
    },
  });
  f.host.query = async (_accountId, operation, input) => {
    if (operation === 'goods')
      return result(operation, {
        products: Array.from({ length: 9 }, (_, i) => ({
          goodsId: String(101 + i),
          title: `商品 ${i}`,
        })),
        hasMore: false,
      });
    return result(operation, { description: '纯棉材质' }, String(input.goodsId));
  };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lateResult: Promise<unknown> | undefined;
  let activeSignal: AbortSignal | undefined;
  let calls = 0;
  const service = new KnowledgeBootstrapService(f.engine, async (_model, sources, signal) => {
    const drafts = sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) }));
    if (++calls === 1) return { drafts };
    activeSignal = signal;
    lateResult = blocked.then(() => ({ drafts }));
    return lateResult;
  });
  const writes = vi.spyOn(f.db.appSetting, 'upsert');
  const updates = vi.spyOn(f.db.appSetting, 'update');
  const publish = vi.spyOn(f.engine.knowledge, 'publish');
  try {
    await service.start(f.account.storeId);
    await waitFor(async () => calls === 2);
    const before = await service.state(f.account.storeId);
    expect(before?.drafts).toHaveLength(8);
    await stopPromptly();
    expect(activeSignal?.aborted).toBe(true);
    const stopped = await service.state(f.account.storeId);
    expect(stopped?.status).toBe('failed');
    expect(stopped?.error).toBeTruthy();
    expect(stopped?.drafts).toEqual(before?.drafts);
    const writeCount = writes.mock.calls.length;
    const updateCount = updates.mock.calls.length;
    release();
    await lateResult;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toHaveBeenCalledTimes(writeCount);
    expect(updates).toHaveBeenCalledTimes(updateCount);
    expect(publish).not.toHaveBeenCalled();
    expect(await service.state(f.account.storeId)).toEqual(stopped);
    expect(await f.db.knowledgeEntry.count()).toBe(0);
  } finally {
    release();
    await f.engine.stop();
    writes.mockRestore();
    updates.mockRestore();
    publish.mockRestore();
  }
});

it('关闭时中止挂起的商品查询，保留已有草稿，平台迟到结果不再触发模型或写库', async () => {
  f = await setup();
  const draft = { id: 'previous-draft', qa: qa('原有可核对草稿'), source: '上次已读取商品' };
  const previous: KnowledgeBootstrapState = {
    runId: 'previous-run',
    storeId: f.account.storeId,
    status: 'completed',
    phase: '生成完成',
    products: 1,
    conversations: 0,
    messages: 0,
    warnings: [],
    saved: 0,
    drafts: [draft],
    updatedAt: new Date().toISOString(),
  };
  await f.db.appSetting.create({
    data: { key: `knowledge.bootstrap:${f.account.storeId}`, value: json(previous) },
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lateResult = blocked.then(() =>
    result('goods', {
      products: [{ goodsId: '101', title: '迟到商品' }],
      hasMore: false,
    }),
  );
  const query = vi.fn(async () => lateResult);
  f.host.query = query;
  const generator = vi.fn(async (_model: unknown, sources: KnowledgeBootstrapSource[]) => ({
    drafts: sources.map((source) => ({ sourceIds: [source.id], qa: qa(source.id) })),
  }));
  const service = new KnowledgeBootstrapService(f.engine, generator);
  const writes = vi.spyOn(f.db.appSetting, 'upsert');
  const updates = vi.spyOn(f.db.appSetting, 'update');
  const publish = vi.spyOn(f.engine.knowledge, 'publish');
  try {
    await service.start(f.account.storeId);
    await waitFor(async () => query.mock.calls.length === 1);
    await stopPromptly();
    const stopped = await service.state(f.account.storeId);
    expect(stopped?.status).toBe('failed');
    expect(stopped?.drafts).toEqual([draft]);
    const writeCount = writes.mock.calls.length;
    const updateCount = updates.mock.calls.length;
    release();
    await lateResult;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toHaveBeenCalledTimes(writeCount);
    expect(updates).toHaveBeenCalledTimes(updateCount);
    expect(query).toHaveBeenCalledTimes(1);
    expect(generator).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await service.state(f.account.storeId)).toEqual(stopped);
    expect(await f.db.knowledgeEntry.count()).toBe(0);
  } finally {
    release();
    await f.engine.stop();
    writes.mockRestore();
    updates.mockRestore();
    publish.mockRestore();
  }
});
