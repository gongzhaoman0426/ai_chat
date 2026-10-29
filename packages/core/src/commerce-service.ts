import { availableOperations } from '../../contracts/src/platform-operations';
import {
  richActionSchemas,
  richContentSchema,
  richActionCapabilities,
  richMessageTarget,
  humanOnlyQueries,
} from '../../contracts/src/commerce-extra';
import { referenceItems, referenceOperations } from './commerce-reference';
import { resolveReplyScope, type CommerceContext } from './commerce-scope';
import {
  commerceQuerySchemas,
  commerceQueryCapability,
  supportsCommerceKeywordSearch,
  commerceQueryResultSchema,
  orderRemarkInputSchema,
  shipmentInputSchema,
  shipmentPreviewSchema,
  orderRemarkPreviewSchema,
  platformActionResultSchema,
  type CommerceQueryOperation,
  type CommerceQueryResult,
  type PlatformActionResult,
} from '../../contracts/src/commerce-tools';
import type { PrismaClient } from '../../database/src/index';
import { json } from '../../database/src/index';
import { assert, uid, hash, errorText } from './util';
import type { AppHost } from './types';
import { record } from '../../platforms/src/shared';

export const pddFixtureQuery = (
  operation: string,
): CommerceQueryResult & { evidenceRef: string; fixture: true } => ({
  operation,
  queriedAt: new Date().toISOString(),
  partial: false,
  failedSections: [],
  data: { items: [], meaning: '隔离调试数据，不代表真实平台结果。' },
  evidenceRef: 'fixture-platform-evidence',
  fixture: true,
});
export const pddFixtureAction = (input: Record<string, unknown>) => ({
  status: 'rejected' as const,
  reasonCode: 'debug_readonly',
  message: '隔离调试不会写入真实订单。',
  actionId: 'fixture-action',
  orderRef: String(input.orderRef),
  fixture: true,
});

export class CommerceService {
  private scope?: ReturnType<typeof resolveReplyScope>;
  private queries = new Map<string, Promise<unknown>>();
  private actions = new Map<string, Promise<unknown>>();
  constructor(
    private db: PrismaClient,
    private host: AppHost,
    private ctx: CommerceContext,
    private evidenceIds: Set<string>,
    private canSubmit: () => void = () => {},
  ) {}
  private get owner() {
    return this.ctx.sessionId ? { sessionId: this.ctx.sessionId } : { runId: this.ctx.runId! };
  }
  private evidenceKey(queryKey: string) {
    return this.ctx.sessionId
      ? { sessionId_queryKey: { sessionId: this.ctx.sessionId, queryKey } }
      : { runId_queryKey: { runId: this.ctx.runId!, queryKey } };
  }
  private async guard(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.ctx.guard();
    signal.throwIfAborted();
  }
  async query(
    operation: string,
    input: Record<string, unknown>,
    allowed: Set<string>,
    signal: AbortSignal,
    allowedOperations?: Set<string>,
  ) {
    assert(Object.hasOwn(commerceQuerySchemas, operation), '不支持的平台查询');
    assert(!humanOnlyQueries.has(operation) || !!this.ctx.sessionId, '此查询仅供人工工作台使用');
    const scope = await (this.scope ??= resolveReplyScope(this.db, this.ctx));
    assert(
      availableOperations(scope.platform, this.ctx.capabilities).includes(operation) &&
        (!allowedOperations || allowedOperations.has(operation)),
      '该操作不适用于当前店铺平台或未挂载',
    );
    const op = operation as CommerceQueryOperation;
    assert(allowed.has(commerceQueryCapability[op]), '平台能力未挂载或不可用');
    const params = commerceQuerySchemas[op].parse(input) as Record<string, unknown>;
    assert(
      !params.keyword || supportsCommerceKeywordSearch(scope.platform, op),
      '当前平台不支持关键词搜索',
    );
    await this.guard(signal);
    if (this.ctx.mode === 'debug') return pddFixtureQuery(op);
    const key = hash({
      operation: op,
      input: params,
      ...(this.ctx.sessionId ? { request: uid() } : {}),
    });
    if (!this.queries.has(key)) this.queries.set(key, this.fetch(op, params, key, signal));
    const result = await this.queries.get(key)!;
    await this.guard(signal);
    return result;
  }
  private async fetch(
    operation: CommerceQueryOperation,
    input: Record<string, unknown>,
    queryKey: string,
    signal: AbortSignal,
  ) {
    const scope = await (this.scope ??= resolveReplyScope(this.db, this.ctx));
    const order =
      typeof input.orderRef === 'string'
        ? (await this.resolveOrder(input.orderRef)).order
        : undefined;
    const result = commerceQueryResultSchema.parse(
      await this.host.query(this.ctx.accountId, operation, {
        ...input,
        ...(order ? { orderSn: order.orderSn } : {}),
        buyerId: this.ctx.buyerId,
        ...(scope.platform !== 'pinduoduo'
          ? { conversationKey: scope.conversationKey, platformContext: scope.platformContext }
          : {}),
      }),
    );
    assert(result.operation === operation, '平台响应操作不匹配');
    const subjectId =
      typeof input.goodsId === 'string'
        ? input.goodsId
        : [
              'history',
              'buyer-footprint',
              'buyer-orders',
              'buyer-profile',
              'conversation-item',
              'order-detail',
              'order-logistics',
              'order-remark-state',
            ].includes(operation)
          ? this.ctx.buyerId
          : undefined;
    assert(result.subjectId === subjectId, '平台响应对象不匹配');
    if (order && operation !== 'order-remark-state')
      assert(
        (operation === 'order-detail' ? record(result.data.order).orderSn : result.data.orderSn) ===
          order.orderSn,
        '平台返回了其他订单',
      );
    assert(JSON.stringify(result).length <= 100000, '平台返回内容超出工具上限');
    await this.guard(signal);
    const evidenceRef = uid();
    for (const [kind, operations] of Object.entries(referenceOperations)) {
      if (operations.includes(operation))
        referenceItems(result.data, kind).forEach((item, index) => {
          item[`${kind}Ref`] = `${kind}:${evidenceRef}:${index}`;
        });
    }
    if (operation === 'buyer-orders') {
      assert(Array.isArray(result.data.orders), '订单查询结果无效');
      result.data.orders = result.data.orders.map((o, index) => ({
        ...record(o),
        orderRef: `order:${evidenceRef}:${index}`,
      }));
    }
    const saved = await this.db.platformEvidence.upsert({
      where: this.evidenceKey(queryKey),
      update: {},
      create: {
        id: evidenceRef,
        ...this.owner,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation,
        subjectId,
        queryKey,
        input: json(input),
        result: json(result),
        observedAt: new Date(result.queriedAt),
      },
    });
    await this.guard(signal);
    this.evidenceIds.add(saved.id);
    return { ...commerceQueryResultSchema.parse(saved.result), evidenceRef: saved.id };
  }
  async action(
    operation: string,
    input: Record<string, unknown>,
    allowed: Set<string>,
    signal: AbortSignal,
    allowedOperations?: Set<string>,
  ) {
    assert(
      operation === 'order-remark' ||
        operation === 'ship-order' ||
        Object.hasOwn(richActionSchemas, operation),
      '不支持的平台操作',
    );
    const scope = await (this.scope ??= resolveReplyScope(this.db, this.ctx));
    assert(
      availableOperations(scope.platform, this.ctx.capabilities).includes(operation) &&
        (!allowedOperations || allowedOperations.has(operation)),
      '当前店铺未提供此操作所需的平台能力',
    );
    if (Object.hasOwn(richActionSchemas, operation)) {
      const isVideo = operation === 'send-video';
      const isReview = operation === 'invite-review';
      assert(
        richActionCapabilities[operation as keyof typeof richActionSchemas].every((c) =>
          allowed.has(c),
        ),
        '发送能力未挂载',
      );
      const params = richActionSchemas[operation as keyof typeof richActionSchemas].parse(input);
      await this.guard(signal);
      if (this.ctx.mode === 'debug')
        return {
          status: 'rejected',
          reasonCode: 'debug_readonly',
          message: '隔离调试不会向真实客户发送消息。',
          outboundId: 'fixture-outbound',
        };
      const item: Record<string, unknown> = isReview
        ? await this.resolveOrder((params as any).orderRef).then(({ source, order }) => {
            this.evidenceIds.add(source.id);
            return order;
          })
        : (
            await this.resolveReference(
              isVideo ? 'material' : 'product',
              String(isVideo ? (params as any).materialRef : (params as any).productRef),
            )
          ).item;
      if (isVideo) assert(item.sendable === true, '视频素材信息不完整，暂不能发送');
      const richContent = richContentSchema.parse(
        isReview
          ? { kind: 'review_card', orderSn: item.orderSn, title: '邀请评价' }
          : isVideo
            ? {
                kind: 'video',
                materialId: item.materialId,
                title: item.title,
                url: item.url,
                videoId: item.videoId,
                coverUrl: item.coverUrl,
                width: item.width,
                height: item.height,
                duration: item.duration,
              }
            : {
                kind: 'product_card',
                goodsId: item.goodsId,
                title: item.title ?? '店铺商品',
                imageUrl: item.imageUrl,
              },
      );
      assert(this.host.sendBusinessMessage, '发送队列尚未就绪');
      this.canSubmit();
      const sent = await this.host.sendBusinessMessage({
        conversationId: this.ctx.conversationId,
        richContent,
        human: !!this.ctx.sessionId,
        runId: this.ctx.runId,
        intentKey: this.ctx.sessionId
          ? `commerce:human:${this.ctx.requestId}`
          : `commerce:${this.ctx.runId}:${hash({ operation, target: richMessageTarget(richContent) })}`,
        guard: async () => {
          this.canSubmit();
          await this.guard(signal);
        },
      });
      const status = ['prepared', 'dispatching'].includes(sent.status)
        ? 'queued'
        : sent.status === 'confirmed'
          ? 'confirmed'
          : ['rejected', 'cancelled'].includes(sent.status)
            ? 'rejected'
            : 'unknown';
      return {
        status,
        outboundId: sent.id,
        reasonCode: 'outbox',
        message:
          status === 'queued'
            ? '已加入发送队列，可在聊天中查看发送状态'
            : status === 'confirmed'
              ? '平台已确认消息发送'
              : (sent.error ?? '发送结果待确认，请核对平台，勿重复发送'),
      };
    }
    if (operation === 'ship-order') {
      assert(allowed.has('orders') && allowed.has('shipment'), '发货能力未挂载或不可用');
      const params = shipmentInputSchema.parse(input);
      await this.guard(signal);
      if (this.ctx.mode === 'debug') return pddFixtureAction(params);
      const key = hash({ operation, ...params });
      if (!this.actions.has(key)) this.actions.set(key, this.ship(params, signal));
      return this.actions.get(key)!;
    }
    assert(allowed.has('orders') && allowed.has('orderRemark'), '订单备注能力未挂载或不可用');
    const params = orderRemarkInputSchema.parse(input);
    await this.guard(signal);
    if (this.ctx.mode === 'debug') return pddFixtureAction(params);
    const key = hash(params);
    if (!this.actions.has(key)) this.actions.set(key, this.remark(params, signal));
    return this.actions.get(key)!;
  }
  async resolveOrder(orderRef: string) {
    const [, sourceId, position] = orderRef.split(':');
    const source = await this.db.platformEvidence.findFirst({
      where: {
        id: sourceId,
        ...this.owner,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation: 'buyer-orders',
        observedAt: { gte: new Date(Date.now() - 5 * 60000), lte: new Date() },
      },
    });
    assert(source, '订单引用已过期或不属于本轮当前买家，请重新查询订单', 'ORDER_UNVERIFIED');
    const orders = record(record(source.result).data).orders;
    const order = record(Array.isArray(orders) ? orders[Number(position)] : undefined);
    assert(
      order.orderRef === orderRef && typeof order.orderSn === 'string',
      '订单引用无效',
      'ORDER_UNVERIFIED',
    );
    return {
      source,
      order: {
        ...order,
        orderSn: String(order.orderSn),
        canShipWithoutLogistics: order.canShipWithoutLogistics,
      },
    };
  }
  async resolveReference(kind: string, ref: string) {
    const [prefix, id, position] = ref.split(':');
    assert(
      prefix === kind && /^\d{1,3}$/.test(position ?? '') && referenceOperations[kind],
      '资料引用无效',
    );
    const source = await this.db.platformEvidence.findFirst({
      where: {
        id,
        ...this.owner,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation: { in: referenceOperations[kind] },
        observedAt: { gte: new Date(Date.now() - 5 * 60000), lte: new Date() },
      },
    });
    const item =
      source && referenceItems(record(record(source.result).data), kind)[Number(position)];
    assert(
      source && item && item[`${kind}Ref`] === ref,
      '资料已过期或不属于当前店铺会话，请刷新后重新选择',
    );
    this.evidenceIds.add(source.id);
    return { source, item };
  }
  private async ship(
    input: { orderRef: string; deliveryMode: 'no_logistics'; note: string },
    signal: AbortSignal,
  ) {
    assert(this.host.executeShipment, '当前平台不支持无需物流发货');
    const scope = await (this.scope ??= resolveReplyScope(this.db, this.ctx));
    assert(scope.platform === 'goofish', '当前平台不支持无需物流发货');
    const { source, order } = await this.resolveOrder(input.orderRef);
    assert(
      order.canShipWithoutLogistics === true,
      '该订单查询未确认无需物流发货能力，请核对平台订单',
    );
    const actionId = uid();
    // An unconfirmed delivery must not be dispatched again by another run/restart or changed wording.
    const dedupKey = hash({
      operation: 'ship-order',
      store: this.ctx.storeId,
      order: order.orderSn,
    });
    await this.guard(signal);
    let action = await this.db.platformAction.upsert({
      where: { dedupKey },
      update: {},
      create: {
        id: actionId,
        ...this.owner,
        requestId: this.ctx.requestId,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation: 'ship-order',
        targetId: order.orderSn,
        sourceEvidenceId: source.id,
        dedupKey,
        input: json(input),
        preview: {},
        result: {},
      },
    });
    let result: PlatformActionResult;
    if (action.id !== actionId) {
      const old = platformActionResultSchema.safeParse(action.result);
      result = old.success
        ? old.data
        : {
            status: 'unknown',
            reasonCode: 'previous_attempt_unconfirmed',
            message: '此订单已有发货尝试，禁止重复提交，请核对平台。',
          };
    } else {
      try {
        result = platformActionResultSchema.parse(
          await this.host.executeShipment(
            {
              id: action.id,
              accountId: this.ctx.accountId,
              buyerId: this.ctx.buyerId,
              orderSn: order.orderSn,
              conversationKey: scope.conversationKey,
              deliveryMode: input.deliveryMode,
              note: input.note,
            },
            async (value) => {
              const preview = shipmentPreviewSchema.parse(value);
              const account = await this.db.account.findUniqueOrThrow({
                where: { id: this.ctx.accountId },
                include: { store: true },
              });
              assert(
                preview.orderSn === order.orderSn &&
                  preview.buyerId === this.ctx.buyerId &&
                  preview.sellerId === account.store.externalId &&
                  preview.note === input.note &&
                  preview.deliveryMode === input.deliveryMode,
                '发货预览与当前订单请求不一致',
              );
              this.canSubmit();
              await this.guard(signal);
              this.canSubmit();
              const changed = await this.db.platformAction.updateMany({
                where: { id: action.id, status: 'prepared' },
                data: { status: 'dispatched', preview: json(preview) },
              });
              assert(changed.count === 1, '发货操作已提交或失效，禁止重复执行');
              await this.guard(signal);
              this.canSubmit();
            },
          ),
        );
      } catch (e) {
        action = await this.db.platformAction.findUniqueOrThrow({ where: { id: action.id } });
        result = {
          status: action.status === 'dispatched' ? 'unknown' : 'rejected',
          reasonCode: 'execution_interrupted',
          message:
            action.status === 'dispatched'
              ? '发货结果未知，请核对平台，禁止重试。'
              : `未提交发货：${errorText(e)}`,
        };
      }
      await this.db.platformAction.update({
        where: { id: action.id },
        data: { status: result.status, result: json(result) },
      });
    }
    const queryKey = `action:${action.id}`;
    const evidence = await this.db.platformEvidence.upsert({
      where: this.evidenceKey(queryKey),
      update: {},
      create: {
        ...this.owner,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation: 'ship-order',
        subjectId: order.orderSn,
        queryKey,
        input: json(input),
        result: json({
          operation: 'ship-order',
          subjectId: order.orderSn,
          queriedAt: new Date().toISOString(),
          partial: false,
          failedSections: [],
          data: {
            ...result,
            actionId: action.id,
            orderRef: input.orderRef,
            meaning: '仅属于当前订单的交付操作，不是通用知识。',
          },
        }),
      },
    });
    this.evidenceIds.add(evidence.id);
    await this.guard(signal);
    return { ...result, actionId: action.id, orderRef: input.orderRef, evidenceRef: evidence.id };
  }
  private async remark(input: { orderRef: string; note: string }, signal: AbortSignal) {
    assert(this.host.executeAction, '当前平台不支持订单备注');
    const { source, order } = await this.resolveOrder(input.orderRef);
    const scope = await (this.scope ??= resolveReplyScope(this.db, this.ctx));
    const buyerMessageId = (this.ctx.messages ?? []).filter((m) => m.origin === 'buyer').at(-1)?.id;
    const dedupKey = hash({
      store: this.ctx.storeId,
      buyer: this.ctx.buyerId,
      message: buyerMessageId ?? this.ctx.sessionId ?? this.ctx.runId,
      order: order.orderSn,
      note: input.note,
    });
    await this.guard(signal);
    const actionId = uid();
    let action = await this.db.platformAction.upsert({
      where: { dedupKey },
      update: {},
      create: {
        id: actionId,
        ...this.owner,
        requestId: this.ctx.requestId,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation: 'order-remark',
        targetId: order.orderSn,
        sourceEvidenceId: source.id,
        dedupKey,
        input: json(input),
        preview: {},
        result: {},
      },
    });
    let result: PlatformActionResult;
    if (action.id !== actionId) {
      const previous = platformActionResultSchema.safeParse(action.result);
      result = previous.success
        ? previous.data
        : {
            status: 'unknown',
            reasonCode: 'previous_attempt_unconfirmed',
            message: '同一诉求已有操作记录，结果尚未确认；请核对平台，不要重复提交。',
          };
    } else {
      try {
        const params = commerceQuerySchemas['buyer-orders'].parse(source.input);
        result = platformActionResultSchema.parse(
          await this.host.executeAction(
            {
              id: action.id,
              accountId: this.ctx.accountId,
              buyerId: this.ctx.buyerId,
              orderSn: order.orderSn,
              ...params,
              ...(scope.platform !== 'pinduoduo'
                ? { conversationKey: scope.conversationKey, platformContext: scope.platformContext }
                : {}),
              note: input.note,
            },
            async (value) => {
              const preview = orderRemarkPreviewSchema.parse(value);
              const expected = preview.before.remark
                .split(/\r?\n/)
                .some((line) => line.trim() === input.note)
                ? preview.before.remark
                : [preview.before.remark, input.note].filter(Boolean).join('\n');
              assert(
                preview.after.remark === expected &&
                  preview.before.tag === preview.after.tag &&
                  preview.before.tagName === preview.after.tagName,
                '备注提交内容与请求不一致',
              );
              this.canSubmit();
              await this.guard(signal);
              this.canSubmit();
              const changed = await this.db.platformAction.updateMany({
                where: { id: action.id, status: 'prepared' },
                data: { status: 'dispatched', preview: json(preview) },
              });
              assert(changed.count === 1, '订单操作已提交或失效，禁止重复执行');
              await this.guard(signal);
              this.canSubmit();
            },
          ),
        );
      } catch (e) {
        action = await this.db.platformAction.findUniqueOrThrow({ where: { id: action.id } });
        result = {
          status: action.status === 'dispatched' ? 'unknown' : 'rejected',
          reasonCode: 'execution_interrupted',
          message:
            action.status === 'dispatched'
              ? '订单操作结果未知，请核对平台，不要重试。'
              : `未提交备注：${errorText(e)}`,
        };
      }
      await this.db.platformAction.update({
        where: { id: action.id },
        data: { status: result.status, result: json(result) },
      });
    }
    // Keep an immutable receipt in the current run, including reused/unknown outcomes.
    const fact = {
      operation: 'order-remark',
      subjectId: order.orderSn,
      queriedAt: new Date().toISOString(),
      partial: false,
      failedSections: [],
      data: {
        actionId: action.id,
        orderRef: input.orderRef,
        note: input.note,
        ...result,
        meaning: '仅属于本次订单操作，不是通用知识或发货、改址承诺。',
      },
    };
    const queryKey = `action:${action.id}`;
    const evidence = await this.db.platformEvidence.upsert({
      where: this.evidenceKey(queryKey),
      update: {},
      create: {
        ...this.owner,
        storeId: this.ctx.storeId,
        accountId: this.ctx.accountId,
        conversationId: this.ctx.conversationId,
        buyerId: this.ctx.buyerId,
        operation: 'order-remark',
        subjectId: order.orderSn,
        queryKey,
        input: json(input),
        result: json(fact),
      },
    });
    this.evidenceIds.add(evidence.id);
    await this.guard(signal);
    return { ...result, actionId: action.id, orderRef: input.orderRef, evidenceRef: evidence.id };
  }
}
