import { capabilitiesSchema, qaSchema, type QaInput } from '../../contracts/src';
import {
  knowledgeBootstrapResultSchema,
  type KnowledgeBootstrapSource,
  type KnowledgeBootstrapState,
} from '../../contracts/src/knowledge-bootstrap';
import { availableOperations } from '../../contracts/src/platform-operations';
import { platformSchema } from '../../contracts/src/platform';
import { commerceQueryResultSchema } from '../../contracts/src/commerce-tools';
import { json } from '../../database/src';
import { record } from '../../platforms/src/shared';
import { referenceItems } from './commerce-reference';
import { resolveAssistModel } from './knowledge-assist';
import { assert, errorText, hash, uid } from './util';
import type { Engine } from './engine';

export type BootstrapGenerator = (
  model: Record<string, unknown>,
  sources: KnowledgeBootstrapSource[],
  signal: AbortSignal,
) => Promise<unknown>;
const stateKey = (storeId: string) => `knowledge.bootstrap:${storeId}`;
const chatScopeCondition =
  '仅限原聊天所指的商品或场景；适用对象不明确时，先向买家确认，不作为全店通用承诺。';
const fingerprint = (qa: QaInput) =>
  hash({
    intent: qa.intent.trim().replace(/\s+/g, '').toLowerCase(),
    productIds: [...qa.scope.productIds].sort(),
    conditions: qa.scope.conditions.trim(),
  });

async function interruptible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('应用维护或关闭，生成已停止；已生成的草稿已保留。'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

// These jobs are read-only until the user saves drafts. Persist every batch so that
// closing the application never loses already generated suggestions.
export class KnowledgeBootstrapService {
  private active = new Set<string>();
  private starting = new Map<string, Promise<KnowledgeBootstrapState>>();
  private controllers = new Map<string, AbortController>();
  private tasks = new Set<Promise<void>>();
  constructor(
    private engine: Engine,
    private generate: BootstrapGenerator,
  ) {
    engine.stopHandlers.add(() => this.stop());
  }

  async stop() {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.tasks]);
  }

  private async read(storeId: string) {
    const row = await this.engine.db.appSetting.findUnique({ where: { key: stateKey(storeId) } });
    return (row?.value as KnowledgeBootstrapState | null) ?? null;
  }
  private async persist(state: KnowledgeBootstrapState) {
    state.updatedAt = new Date().toISOString();
    await this.engine.db.appSetting.upsert({
      where: { key: stateKey(state.storeId) },
      create: { key: stateKey(state.storeId), value: json(state) },
      update: { value: json(state) },
    });
    this.engine.onChanged();
  }
  private write(state: KnowledgeBootstrapState, signal?: AbortSignal) {
    return this.engine.lock.run(() => {
      signal?.throwIfAborted();
      return this.persist(state);
    });
  }
  async state(storeId: string) {
    const state = await this.read(storeId);
    if (state?.status === 'running' && !this.active.has(storeId)) {
      state.status = 'failed';
      state.error = '上次生成因应用关闭而中断，已生成的草稿已保留，可重新读取。';
      await this.write(state);
    }
    return state;
  }
  start(storeId: string): Promise<KnowledgeBootstrapState> {
    const pending = this.starting.get(storeId);
    if (pending) return pending;
    const work = this.startRun(storeId);
    this.starting.set(storeId, work);
    void work.finally(() => this.starting.delete(storeId)).catch(() => {});
    return work;
  }
  private async startRun(storeId: string): Promise<KnowledgeBootstrapState> {
    // Reserve synchronously before the first await, including model resolution.
    if (this.active.has(storeId)) {
      const current = await this.read(storeId);
      assert(current, '生成任务正在启动，请稍后重试');
      return current;
    }
    this.active.add(storeId);
    const controller = new AbortController();
    this.controllers.set(storeId, controller);
    try {
      const store = await this.engine.db.store.findFirst({
        where: { id: storeId, accounts: { some: {} } },
      });
      assert(store, '店铺不存在或已移除');
      const model = await resolveAssistModel(this.engine, storeId);
      const state = await this.engine.lock.run(async () => {
        controller.signal.throwIfAborted();
        const previous = await this.read(storeId);
        const next: KnowledgeBootstrapState = {
          runId: uid(),
          storeId,
          status: 'running',
          phase: '准备读取店铺资料',
          products: 0,
          conversations: 0,
          messages: 0,
          warnings: [],
          drafts: previous?.drafts ?? [],
          saved: previous?.saved ?? 0,
          updatedAt: new Date().toISOString(),
        };
        await this.persist(next);
        return next;
      });
      const task = this.collect(
        state,
        model as unknown as Record<string, unknown>,
        controller.signal,
      )
        .catch(async (error) => {
          state.status = 'failed';
          state.error = errorText(error);
          state.phase = '生成中断，已保留草稿';
          await this.write(state);
        })
        .finally(() => {
          this.active.delete(storeId);
          this.controllers.delete(storeId);
          this.tasks.delete(task);
        })
        .catch((error) => console.error('knowledge bootstrap:', errorText(error)));
      this.tasks.add(task);
      return state;
    } catch (error) {
      this.active.delete(storeId);
      this.controllers.delete(storeId);
      throw error;
    }
  }

  async apply(storeId: string, runId: string, rows: Array<{ id: string; qa: QaInput }>) {
    return this.engine.lock.run(() =>
      this.engine.db.$transaction(async (tx) => {
        const row = await tx.appSetting.findUnique({ where: { key: stateKey(storeId) } });
        const state = row?.value as KnowledgeBootstrapState | undefined;
        assert(state && state.runId === runId, '草稿批次已变化，请刷新后重试');
        assert(state.status !== 'running' && !this.active.has(storeId), '请等待生成完成后保存');
        const selected = new Set(rows.map((row) => row.id));
        assert(selected.size === rows.length, '不能重复保存同一条草稿');
        const known = new Map(state.drafts.map((draft) => [draft.id, draft]));
        for (const row of rows) {
          // A retry of a successfully saved batch is a no-op.
          const draft = known.get(row.id);
          if (!draft) continue;
          const revision = await this.engine.knowledge.publish(
            tx,
            storeId,
            qaSchema.parse(row.qa),
            {
              sourceKind: 'bootstrap',
            },
          );
          await tx.auditEvent.create({
            data: {
              type: 'knowledge.bootstrap.save',
              scope: revision.entryId,
              actor: 'local-user',
              details: { runId, draftId: draft.id, source: draft.source },
            },
          });
          state.saved++;
        }
        state.drafts = state.drafts.filter((draft) => !selected.has(draft.id));
        state.updatedAt = new Date().toISOString();
        await tx.appSetting.update({
          where: { key: stateKey(storeId) },
          data: { value: json(state) },
        });
        return state;
      }),
    );
  }

  private async collect(
    state: KnowledgeBootstrapState,
    model: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { engine } = this;
    const store = await engine.db.store.findUniqueOrThrow({
      where: { id: state.storeId },
      include: { accounts: true },
    });
    const platform = platformSchema.parse(store.platform);
    const operations = (account: (typeof store.accounts)[number]) => {
      const caps = capabilitiesSchema.safeParse(account.capabilities);
      return account.status === 'online' && caps.success
        ? availableOperations(platform, caps.data)
        : [];
    };
    const warn = (message: string) => {
      if (!state.warnings.includes(message)) state.warnings.push(message);
    };
    warn(
      '聊天读取范围为本机已同步的买家会话及平台允许补充的历史；平台未提供全店会话枚举，无法读取未同步买家的聊天。',
    );
    const existing = await engine.knowledge.list(store.id, '', 'owned');
    const seenDrafts = new Set(state.drafts.map((draft) => fingerprint(draft.qa)));
    for (const entry of existing) {
      const rev = entry.revisions[0];
      if (rev) {
        const scope = record(rev.scope);
        seenDrafts.add(
          fingerprint({
            intent: rev.intent,
            scope: {
              productIds: Array.isArray(scope.productIds) ? (scope.productIds as string[]) : [],
              conditions: typeof scope.conditions === 'string' ? scope.conditions : '',
            },
          } as QaInput),
        );
      }
    }
    let sources: KnowledgeBootstrapSource[] = [];
    let chars = 0;
    const flush = async () => {
      if (!sources.length) return;
      const batch = sources;
      sources = [];
      chars = 0;
      signal.throwIfAborted();
      const result = knowledgeBootstrapResultSchema.parse(
        await interruptible(this.generate(model, batch, signal), signal),
      );
      const byId = new Map(batch.map((source) => [source.id, source]));
      for (const item of result.drafts) {
        if (item.sourceIds.some((id) => !byId.has(id))) {
          warn('已忽略无法核对来源的模型草稿。');
          continue;
        }
        const evidence = item.sourceIds.map((id) => byId.get(id)!);
        const products = [...new Set(evidence.flatMap((source) => source.productIds))];
        if (
          item.qa.answerKind !== 'text' ||
          item.qa.scope.overridesEntryId ||
          item.qa.scope.productIds.some((id) => !products.includes(id))
        ) {
          warn('已忽略图片来源或商品范围无法核对的模型草稿。');
          continue;
        }
        // Neither product facts nor historical, buyer-specific exceptions may
        // accidentally become an unconditional answer for the whole shop.
        const conditions =
          !products.length && evidence.some((source) => source.kind === 'conversation')
            ? `${chatScopeCondition}${item.qa.scope.conditions ? ` ${item.qa.scope.conditions}` : ''}`.slice(
                0,
                2000,
              )
            : item.qa.scope.conditions;
        const qa = qaSchema.parse({
          ...item.qa,
          attachmentId: undefined,
          scope: {
            ...item.qa.scope,
            productIds: products.length ? products : item.qa.scope.productIds,
            conditions,
          },
        });
        const key = fingerprint(qa);
        if (seenDrafts.has(key)) continue;
        seenDrafts.add(key);
        state.drafts.push({ id: uid(), qa, source: evidence.map((s) => s.label).join('；') });
      }
      await this.write(state, signal);
    };
    const add = async (source: KnowledgeBootstrapSource) => {
      signal.throwIfAborted();
      const size = JSON.stringify(source).length;
      if (sources.length && (chars + size > 18000 || sources.length >= 8)) await flush();
      sources.push(source);
      chars += size;
    };
    const checkedQuery = async (
      accountId: string,
      operation: string,
      input: Record<string, unknown>,
      subjectId?: string,
    ) => {
      signal.throwIfAborted();
      const result = commerceQueryResultSchema.parse(
        await interruptible(engine.host.query(accountId, operation, input), signal),
      );
      assert(
        result.operation === operation && result.subjectId === subjectId,
        '平台响应与当前店铺查询对象不匹配',
      );
      for (const section of result.failedSections) warn(`${operation}：${section.reason}`);
      if (result.partial && !result.failedSections.length)
        warn(`${operation}：平台仅返回部分资料。`);
      if (
        Object.entries(result.data).some(
          ([key, value]) =>
            (key.toLowerCase().includes('truncated') && value === true) ||
            (key === 'omittedMessageCount' && Number(value) > 0),
        )
      )
        warn(`${operation}：部分内容已被平台接口截断或省略。`);
      return result.data;
    };
    const goodsAccount = store.accounts.find((account) => operations(account).includes('goods'));
    if (!goodsAccount) warn('商品未读取：请连接支持商品查询的店铺账号后重试。');
    else {
      const conversation = await engine.db.conversation.findFirst({
        where: { storeId: store.id, accountId: goodsAccount.id },
        orderBy: { updatedAt: 'desc' },
      });
      if (platform !== 'pinduoduo' && !conversation)
        warn('商品未读取：请先在接待中心打开该店铺的买家会话后重试。');
      else {
        const context = {
          buyerId: conversation?.buyerId ?? '',
          ...(conversation
            ? {
                conversationKey: conversation.externalKey,
                platformContext: conversation.platformContext,
              }
            : {}),
        };
        const seenProducts = new Set<string>();
        state.phase = '读取商品目录与详情';
        for (let page = 1; page <= 100; page++) {
          signal.throwIfAborted();
          let data: Record<string, unknown>;
          try {
            data = await checkedQuery(goodsAccount.id, 'goods', { ...context, page, pageSize: 30 });
          } catch (error) {
            warn(`商品第 ${page} 页读取失败：${errorText(error)}`);
            break;
          }
          const items = referenceItems(data, 'product');
          let added = 0;
          for (const product of items) {
            const goodsId = String(product.goodsId ?? '');
            if (!goodsId || seenProducts.has(goodsId)) continue;
            seenProducts.add(goodsId);
            added++;
            state.products++;
            let detail: unknown;
            if (operations(goodsAccount).includes('goods-detail')) {
              try {
                detail = await checkedQuery(
                  goodsAccount.id,
                  'goods-detail',
                  { ...context, goodsId },
                  goodsId,
                );
              } catch (error) {
                warn(`商品 ${goodsId} 详情读取失败：${errorText(error)}`);
              }
            } else warn('当前平台只支持商品列表，无法补充商品详情。');
            await add({
              id: `product:${goodsId}`,
              kind: 'product',
              productIds: [goodsId],
              label: `商品：${String(product.title || goodsId)}`,
              content: { product, detail: detail ?? null },
            });
            if (operations(goodsAccount).includes('goods-skus')) {
              const offsets = new Set<number>();
              let offset = 0;
              while (offset <= 10000) {
                let skus: Record<string, unknown>;
                try {
                  skus = await checkedQuery(
                    goodsAccount.id,
                    'goods-skus',
                    {
                      ...context,
                      goodsId,
                      offset,
                      limit: 50,
                    },
                    goodsId,
                  );
                } catch (error) {
                  warn(`商品 ${goodsId} 规格读取失败：${errorText(error)}`);
                  break;
                }
                await add({
                  id: `product:${goodsId}:skus:${offset}`,
                  kind: 'product',
                  productIds: [goodsId],
                  label: `商品规格：${String(product.title || goodsId)}`,
                  content: skus,
                });
                const next = skus.nextOffset;
                if (skus.hasMore === false || next === null || next === undefined) break;
                if (typeof next !== 'number' || next <= offset || offsets.has(next)) {
                  warn(`商品 ${goodsId} 规格分页无法继续，可能不完整。`);
                  break;
                }
                offsets.add(next);
                offset = next;
                if (offset > 10000) warn(`商品 ${goodsId} 规格达到接口分页上限。`);
              }
            }
          }
          await this.write(state, signal);
          const more = data.hasMore ?? record(data.pagination).hasMore;
          if (more === false) break;
          if (!items.length) {
            if (more === true) warn('商品分页提前返回空页，目录可能不完整。');
            break;
          }
          if (!added) {
            warn('平台商品分页重复，已停止读取，目录可能不完整。');
            break;
          }
          if (page === 100) warn('商品目录达到平台接口的 100 页上限，超出范围未读取。');
        }
      }
    }
    await flush();
    signal.throwIfAborted();
    state.phase = '读取买家会话与历史聊天';
    const conversations = await engine.db.conversation.findMany({
      where: { storeId: store.id },
      orderBy: { id: 'asc' },
    });
    for (const conversation of conversations) {
      signal.throwIfAborted();
      state.conversations++;
      const messages = new Map<
        string,
        { direction: string; text: string; timestamp: string; origin?: string }
      >();
      const local = await engine.db.message.findMany({
        where: { storeId: store.id, conversationId: conversation.id },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      });
      if (local.some((message) => message.kind !== 'text'))
        warn('历史图片、语音等非文字内容未做识别，请手动补充需要保留的问答。');
      const excludedIds = new Set(
        local
          .filter((message) => message.withdrawn || !['buyer', 'human'].includes(message.origin))
          .map((message) => message.externalId),
      );
      for (const message of local)
        if (message.text.trim() && !excludedIds.has(message.externalId))
          messages.set(message.externalId, {
            direction: message.direction,
            text: message.text,
            timestamp: message.timestamp.toISOString(),
            origin: message.origin,
          });
      const account = store.accounts.find((account) => account.id === conversation.accountId);
      if (platform === 'qianniu')
        warn('千牛聊天仅包含本机已同步记录，登录前和离线期间的聊天无法补齐。');
      else if (account && operations(account).includes('history')) {
        let cursor = '';
        const cursors = new Set<string>();
        for (let page = 1; page <= 100; page++) {
          let data: Record<string, unknown>;
          try {
            data = await checkedQuery(
              account.id,
              'history',
              {
                buyerId: conversation.buyerId,
                conversationKey: conversation.externalKey,
                platformContext: conversation.platformContext,
                cursor,
                pageSize: 50,
              },
              conversation.buyerId,
            );
          } catch (error) {
            warn(`会话历史补充失败，已使用本机记录：${errorText(error)}`);
            break;
          }
          const rows = Array.isArray(data.messages) ? data.messages.map(record) : [];
          if (rows.some((message) => message.imageUrl || (message.kind && message.kind !== 'text')))
            warn('历史图片、语音等非文字内容未做识别，请手动补充需要保留的问答。');
          for (const message of rows) {
            if (message.withdrawn || typeof message.text !== 'string' || !message.text.trim())
              continue;
            const id = typeof message.messageId === 'string' ? message.messageId : hash(message);
            if (excludedIds.has(id)) continue;
            const direction = ['in', 'out'].includes(String(message.direction))
              ? String(message.direction)
              : message.senderId === conversation.buyerId
                ? 'in'
                : message.senderId === account.externalId
                  ? 'out'
                  : undefined;
            if (!direction) {
              warn('部分历史消息无法核验发言人，已跳过。');
              continue;
            }
            const timestamp = String(message.timestamp ?? '');
            const numericTime = /^\d{10,13}$/.test(timestamp)
              ? Number(timestamp) * (timestamp.length === 10 ? 1000 : 1)
              : NaN;
            if (!messages.has(id))
              messages.set(id, {
                direction,
                text: message.text,
                timestamp: Number.isFinite(numericTime)
                  ? new Date(numericTime).toISOString()
                  : timestamp,
              });
          }
          if (data.hasMore === false) break;
          const next = typeof data.nextCursor === 'string' ? data.nextCursor : '';
          if (!rows.length || !next || cursors.has(next) || next === cursor) {
            if (data.hasMore !== false) warn('部分聊天历史没有可继续读取的游标，可能无法补齐。');
            break;
          }
          cursors.add(next);
          cursor = next;
          if (page === 100) warn('部分会话历史达到 100 页读取上限，超出范围未读取。');
        }
      } else warn('部分会话账号离线或不支持历史查询，仅使用本机已同步记录。');
      const ordered = [...messages.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      state.messages += ordered.length;
      // Bound model context and overlap a question/answer pair across batch boundaries.
      for (let offset = 0; offset < ordered.length; ) {
        const slice: typeof ordered = [];
        let length = 0;
        for (const message of ordered.slice(offset, offset + 40)) {
          if (slice.length && length + Math.min(message.text.length, 6000) > 14000) break;
          if (message.text.length > 6000)
            warn('个别超长聊天文本只分析前 6000 字，请核对原始记录。');
          slice.push({ ...message, text: message.text.slice(0, 6000) });
          length += slice.at(-1)!.text.length;
        }
        if (slice.some((m) => m.direction === 'in') && slice.some((m) => m.direction === 'out'))
          await add({
            id: `conversation:${conversation.id}:${offset}`,
            kind: 'conversation',
            productIds: [],
            label: `聊天记录：会话 ${state.conversations}（${slice[0].timestamp}）`,
            content: slice,
          });
        if (offset + slice.length >= ordered.length) break;
        offset += Math.max(1, slice.length - 2);
      }
      await this.write(state, signal);
    }
    state.phase = '整理默认问答草稿';
    await flush();
    if (!state.products && !state.messages)
      warn('没有读到商品或聊天内容，请保持店铺连接并同步会话后重新生成。');
    state.status = 'completed';
    state.phase = '生成完成，请核对并保存草稿';
    await this.write(state, signal);
  }
}
