import {
  richActionSchemas,
  quickActionSchemas,
  quickPreviewSchema,
  type QuickOperation,
} from '../../contracts/src/commerce-extra';
import { capabilitiesSchema, getAutoReplyReadiness } from '../../contracts/src';
import { platformSchema } from '../../contracts/src/platform';
import { availableOperations } from '../../contracts/src/platform-operations';
import {
  commerceQuerySchemas,
  platformActionResultSchema,
} from '../../contracts/src/commerce-tools';
import {
  workbenchOperationNames,
  type WorkbenchActionInput,
  type WorkbenchContext,
  transferPreviewSchema,
} from '../../contracts/src/workbench';
import { CommerceService } from './commerce-service';
import { resolveReplyScope, type CommerceContext } from './commerce-scope';
import { record } from '../../platforms/src/shared';
import { json } from '../../database/src';
import { assert, uid, hash, errorText, Mutex } from './util';
import type { Engine } from './engine';

export class WorkbenchService {
  private actions = new Map<string, { signature: string; promise: Promise<unknown> }>();
  private locks = new Map<string, Mutex>();
  constructor(private engine: Engine) {}
  private async conversation(id: string) {
    const c = await this.engine.db.conversation.findUnique({
      where: { id },
      include: { store: true },
    });
    assert(c, '会话不存在');
    const account = await this.engine.db.account.findFirst({
      where: { id: c.accountId, storeId: c.storeId },
    });
    assert(account, '该会话的客服账号已移除，请在平台重新连接');
    return { c, account };
  }
  async context(conversationId: string): Promise<WorkbenchContext> {
    const { c, account } = await this.conversation(conversationId);
    const capabilities = capabilitiesSchema.parse(account.capabilities);
    let session = await this.engine.db.workbenchSession.findFirst({
      where: {
        conversationId,
        accountId: account.id,
        routeVersion: c.routeVersion,
        expiresAt: { gt: new Date(Date.now() + 5 * 60000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    session ??= await this.engine.db.workbenchSession.create({
      data: {
        conversationId,
        storeId: c.storeId,
        accountId: account.id,
        buyerId: c.buyerId,
        routeVersion: c.routeVersion,
        expiresAt: new Date(Date.now() + 30 * 60000),
      },
    });
    const platform = platformSchema.parse(c.store.platform);
    const online = account.status === 'online';
    return {
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      conversationId,
      storeId: c.storeId,
      storeName: c.store.name,
      accountId: account.id,
      accountName: account.name,
      buyerId: c.buyerId,
      buyerName: c.buyerName,
      platform,
      online,
      operations: online
        ? [
            ...availableOperations(platform, capabilities),
            ...(platform !== 'goofish' &&
            capabilities.staffTransfer &&
            this.engine.host.staff &&
            this.engine.host.executeTransfer
              ? ['staff-list', 'transfer-conversation']
              : []),
          ]
        : [],
    };
  }
  private async scope(
    sessionId: string,
    requiresHuman = false,
    operation?: string,
  ): Promise<CommerceContext> {
    const session = await this.engine.db.workbenchSession.findUnique({ where: { id: sessionId } });
    assert(session && session.expiresAt > new Date(), '工作台上下文已过期，请刷新侧栏');
    const { c, account } = await this.conversation(session.conversationId);
    assert(
      c.storeId === session.storeId &&
        c.accountId === session.accountId &&
        c.buyerId === session.buyerId &&
        c.routeVersion === session.routeVersion,
      '会话接待账号已变化，请刷新侧栏',
      'STALE',
    );
    assert(account.status === 'online', '当前客服账号未连接，请先打开原平台');
    const capabilities = capabilitiesSchema.parse(account.capabilities);
    const platform = platformSchema.parse(c.store.platform);
    if (operation)
      assert(
        operation === 'staff-list' || operation === 'transfer-conversation'
          ? platform !== 'goofish' && capabilities.staffTransfer === true
          : availableOperations(platform, capabilities).includes(operation),
        '当前账号不再支持此操作，请刷新侧栏',
      );
    if (requiresHuman) assert(c.openedByHuman, '会话已交还 AI，请重新接管后操作', 'STALE');
    return {
      sessionId,
      storeId: c.storeId,
      conversationId: c.id,
      accountId: account.id,
      buyerId: c.buyerId,
      platform: platformSchema.parse(c.store.platform),
      capabilities: capabilitiesSchema.parse(account.capabilities),
      guard: async () => {
        await this.scope(sessionId, requiresHuman, operation);
      },
    };
  }
  async query(sessionId: string, operation: string, input: Record<string, unknown>) {
    const ctx = await this.scope(sessionId, false, operation);
    if (operation === 'staff-list') {
      assert(Object.keys(input).length === 0, '客服查询无需额外参数');
      assert(
        ctx.capabilities.staffTransfer && ctx.platform !== 'goofish' && this.engine.host.staff,
        '当前平台未提供客服转接',
      );
      const staff = await this.engine.host.staff(ctx.accountId);
      await ctx.guard();
      const id = uid();
      const result = {
        operation,
        subjectId: ctx.buyerId,
        queriedAt: new Date().toISOString(),
        partial: false,
        failedSections: [],
        data: { staff: staff.map((s, i) => ({ ...s, staffRef: `staff:${id}:${i}` })) },
      };
      await this.engine.db.platformEvidence.create({
        data: {
          id,
          sessionId,
          storeId: ctx.storeId,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          buyerId: ctx.buyerId,
          operation,
          queryKey: uid(),
          input: {},
          result: json(result),
        },
      });
      return { ...result, evidenceRef: id };
    }
    assert(Object.hasOwn(commerceQuerySchemas, operation), '工作台尚未接入此查询');
    return new CommerceService(this.engine.db, this.engine.host, ctx, new Set()).query(
      operation,
      input,
      new Set(
        Object.keys(ctx.capabilities).filter(
          (k) => ctx.capabilities[k as keyof typeof ctx.capabilities] === true,
        ),
      ),
      AbortSignal.timeout(45000),
    );
  }
  async action(input: WorkbenchActionInput) {
    const signature = hash(input);
    const existing = this.actions.get(input.requestId);
    if (existing) {
      assert(existing.signature === signature, '操作编号已用于其他内容');
      return existing.promise;
    }
    const promise = (async () => {
      const ctx = await this.scope(input.sessionId);
      const lock = this.locks.get(ctx.conversationId) ?? new Mutex();
      this.locks.set(ctx.conversationId, lock);
      return lock.run(() => this.execute(input));
    })();
    this.actions.set(input.requestId, { signature, promise });
    try {
      return await promise;
    } finally {
      this.actions.delete(input.requestId);
      this.engine.onChanged();
      if (!this.actions.size) this.locks.clear();
    }
  }
  private params(input: WorkbenchActionInput) {
    return input.operation === 'ship-order'
      ? {
          orderRef: input.input.orderRef,
          deliveryMode: input.input.deliveryMode,
          note: input.input.note,
        }
      : input.input;
  }
  private receipt(row: { result: unknown; id: string }) {
    const result = platformActionResultSchema.safeParse(row.result);
    return {
      ...(result.success
        ? result.data
        : {
            status: 'unknown',
            reasonCode: 'previous_attempt_unconfirmed',
            message: '已有操作正在处理或待核对，请查看记录，勿重复提交。',
          }),
      actionId: row.id,
    };
  }
  private async selectedStaff(ctx: CommerceContext, staffRef: string) {
    const [, evidenceId, index] = staffRef.split(':');
    const source = await this.engine.db.platformEvidence.findFirst({
      where: {
        id: evidenceId,
        sessionId: ctx.sessionId,
        storeId: ctx.storeId,
        conversationId: ctx.conversationId,
        buyerId: ctx.buyerId,
        accountId: ctx.accountId,
        operation: 'staff-list',
        observedAt: { gt: new Date(Date.now() - 5 * 60000), lte: new Date() },
      },
    });
    const staff = record(record(source?.result).data).staff;
    const selected = record(Array.isArray(staff) ? staff[Number(index)] : undefined);
    assert(
      source && selected.staffRef === staffRef && typeof selected.id === 'string',
      '客服列表已过期或目标不属于当前店铺，请刷新',
    );
    return {
      source,
      selected: { ...selected, id: String(selected.id), name: String(selected.name) },
    };
  }
  private async extraAction(input: WorkbenchActionInput) {
    let ctx = await this.scope(input.sessionId, false, input.operation);
    const isRich = Object.hasOwn(richActionSchemas, input.operation);
    if (!isRich) {
      const previous = await this.engine.db.platformAction.findUnique({
        where: { requestId: input.requestId },
      });
      if (previous) {
        assert(
          previous.sessionId === input.sessionId &&
            previous.operation === input.operation &&
            hash(previous.input) === hash(input.input),
          '操作编号已用于其他内容',
        );
        return this.receipt(previous);
      }
    }
    // Legacy close-conversation records still need review; this cannot submit a new close.
    const pending = await this.engine.db.platformAction.findFirst({
      where: {
        conversationId: ctx.conversationId,
        reviewedAt: null,
        OR: [
          { status: { in: ['prepared', 'dispatched', 'unknown'] } },
          {
            operation: { in: ['transfer-conversation', 'transfer-group', 'close-conversation'] },
            status: 'confirmed',
          },
        ],
      },
    });
    assert(!pending, '已有业务操作尚待核对，请先查看处理记录');
    const business = new CommerceService(this.engine.db, this.engine.host, ctx, new Set());
    const params = input.input as Record<string, any>;
    let targetId: string | undefined, sourceId: string | undefined;
    if (params.productRef || params.materialRef || params.groupRef) {
      const kind = params.productRef ? 'product' : params.materialRef ? 'material' : 'group';
      const { source, item } = await business.resolveReference(kind, params[`${kind}Ref`]);
      sourceId = source.id;
      targetId = String(item.goodsId ?? item.materialId ?? item.id);
    } else if (params.orderRef) {
      const { source, order } = await business.resolveOrder(params.orderRef);
      sourceId = source.id;
      targetId = order.orderSn;
    }
    const requiresHuman = input.operation === 'transfer-group';
    if (requiresHuman) {
      const { c } = await this.conversation(ctx.conversationId);
      if (!c.openedByHuman) await this.engine.setReception(c.id, 'human', c.revision);
    }
    ctx = {
      ...(await this.scope(input.sessionId, requiresHuman, input.operation)),
      requestId: input.requestId,
    };
    if (isRich)
      return new CommerceService(this.engine.db, this.engine.host, ctx, new Set()).action(
        input.operation,
        params,
        new Set(Object.keys(ctx.capabilities).filter((k) => (ctx.capabilities as any)[k] === true)),
        AbortSignal.timeout(60000),
      );
    assert(
      this.engine.host.executeQuickAction && Object.hasOwn(quickActionSchemas, input.operation),
      '快捷操作不可用',
    );
    assert(sourceId && targetId, '请重新查询后选择操作目标');
    const scope = await resolveReplyScope(this.engine.db, ctx);
    const action = await this.engine.db.platformAction.create({
      data: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        storeId: ctx.storeId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        buyerId: ctx.buyerId,
        operation: input.operation,
        targetId,
        sourceEvidenceId: sourceId,
        dedupKey: hash({ requestId: input.requestId, operation: input.operation }),
        input: json(params),
        preview: {},
        result: {},
      },
    });
    let result;
    try {
      result = platformActionResultSchema.parse(
        await this.engine.host.executeQuickAction(
          {
            id: action.id,
            operation: input.operation as QuickOperation,
            accountId: ctx.accountId,
            buyerId: ctx.buyerId,
            conversationKey: scope.conversationKey,
            platformContext: scope.platformContext,
            targetId,
            note: params.note,
          },
          async (value) => {
            const preview = quickPreviewSchema.parse(value);
            assert(
              preview.operation === input.operation &&
                preview.buyerId === ctx.buyerId &&
                preview.conversationKey === scope.conversationKey &&
                preview.targetId === targetId,
              '快捷操作目标已变化',
            );
            await ctx.guard();
            assert(
              !(await this.engine.db.outboundMessage.findFirst({
                where: {
                  conversationId: ctx.conversationId,
                  status: { in: ['prepared', 'dispatching', 'unknown'] },
                },
              })),
              '当前消息发送中或待确认，请先核对',
            );
            const changed = await this.engine.db.platformAction.updateMany({
              where: { id: action.id, status: 'prepared' },
              data: { status: 'dispatched', preview: json(preview) },
            });
            assert(changed.count === 1, '操作已提交，禁止重复执行');
            await ctx.guard();
          },
        ),
      );
    } catch (e) {
      const row = await this.engine.db.platformAction.findUniqueOrThrow({
        where: { id: action.id },
      });
      result = {
        status: row.status === 'dispatched' ? ('unknown' as const) : ('rejected' as const),
        reasonCode: 'execution_interrupted',
        message: errorText(e).slice(0, 500),
      };
    }
    await this.engine.db.platformAction.update({
      where: { id: action.id },
      data: { status: result.status, result: json(result) },
    });
    if (input.operation === 'transfer-group' && result.status !== 'rejected')
      await this.engine.db.conversation.update({
        where: { id: ctx.conversationId },
        data: {
          openedByHuman: true,
          awaitingHuman: true,
          handoffReason: `${workbenchOperationNames[input.operation]}：${result.message}`,
          revision: { increment: 1 },
        },
      });
    return { ...result, actionId: action.id };
  }
  private async execute(input: WorkbenchActionInput) {
    if (
      input.operation === 'send-product-card' ||
      input.operation === 'send-video' ||
      input.operation === 'transfer-group' ||
      input.operation === 'invite-order' ||
      input.operation === 'invite-review'
    )
      return this.extraAction(input);

    let ctx = await this.scope(input.sessionId);
    const previous = await this.engine.db.platformAction.findUnique({
      where: { requestId: input.requestId },
    });
    if (previous) {
      assert(
        previous.sessionId === input.sessionId &&
          previous.operation === input.operation &&
          hash(previous.input) === hash(this.params(input)),
        '操作编号已用于其他内容',
      );
      return this.receipt(previous);
    }
    ctx = await this.scope(input.sessionId, false, input.operation);
    const blocked = await this.engine.db.platformAction.findFirst({
      where: {
        conversationId: ctx.conversationId,
        reviewedAt: null,
        OR: [
          { status: { in: ['prepared', 'dispatched', 'unknown'] } },
          {
            operation: { in: ['transfer-conversation', 'transfer-group', 'close-conversation'] },
            status: 'confirmed',
          },
        ],
      },
    });
    assert(!blocked, '已有业务操作或转接尚待核对，请先查看处理记录');
    if (input.operation === 'transfer-conversation')
      await this.selectedStaff(ctx, input.input.staffRef);
    else {
      const { order } = await new CommerceService(
        this.engine.db,
        this.engine.host,
        ctx,
        new Set(),
      ).resolveOrder(input.input.orderRef);
      if (input.operation === 'ship-order')
        assert(
          order.canShipWithoutLogistics === true && input.input.delivered === true,
          '该订单尚未确认无需物流交付',
        );
    }
    // A staff transfer explicitly changes reception; ordinary business actions keep its mode.
    const requiresHuman = input.operation === 'transfer-conversation';
    if (requiresHuman) {
      const { c } = await this.conversation(ctx.conversationId);
      if (!c.openedByHuman) await this.engine.setReception(c.id, 'human', c.revision);
    }
    ctx = {
      ...(await this.scope(input.sessionId, requiresHuman, input.operation)),
      requestId: input.requestId,
    };
    if (input.operation === 'transfer-conversation') return this.transfer(ctx, input);
    const params = this.params(input);
    try {
      return await new CommerceService(this.engine.db, this.engine.host, ctx, new Set()).action(
        input.operation,
        params,
        new Set(
          Object.keys(ctx.capabilities).filter(
            (k) => ctx.capabilities[k as keyof typeof ctx.capabilities] === true,
          ),
        ),
        AbortSignal.timeout(60000),
      );
    } catch (error) {
      // Cancellation after a command must not hide its already persisted receipt.
      const row = await this.engine.db.platformAction.findUnique({
        where: { requestId: input.requestId },
      });
      if (row && ['confirmed', 'rejected', 'unknown'].includes(row.status))
        return this.receipt(row);
      throw error;
    }
  }
  private async transfer(
    ctx: CommerceContext,
    input: Extract<WorkbenchActionInput, { operation: 'transfer-conversation' }>,
  ) {
    assert(
      ctx.capabilities.staffTransfer &&
        ctx.platform !== 'goofish' &&
        this.engine.host.executeTransfer,
      '当前平台未提供客服转接',
    );
    const { source, selected } = await this.selectedStaff(ctx, input.input.staffRef);
    const pending = await this.engine.db.outboundMessage.findFirst({
      where: {
        conversationId: ctx.conversationId,
        status: { in: ['dispatching', 'unknown', 'prepared'] },
      },
    });
    assert(!pending, '当前还有消息发送中或送达待确认，请核对后再转接');
    const scope = await resolveReplyScope(this.engine.db, ctx);
    const dedupKey = hash({ operation: input.operation, request: input.requestId });
    const prior = await this.engine.db.platformAction.findUnique({ where: { dedupKey } });
    if (prior) return this.receipt(prior);
    const action = await this.engine.db.platformAction.create({
      data: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        storeId: ctx.storeId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        buyerId: ctx.buyerId,
        operation: input.operation,
        targetId: selected.id,
        sourceEvidenceId: source.id,
        dedupKey,
        input: json(input.input),
        preview: {},
        result: {},
      },
    });
    let result;
    try {
      result = platformActionResultSchema.parse(
        await this.engine.host.executeTransfer(
          {
            id: action.id,
            accountId: ctx.accountId,
            buyerId: ctx.buyerId,
            conversationKey: scope.conversationKey,
            platformContext: scope.platformContext,
            targetStaffId: selected.id,
            note: input.input.note,
          },
          async (value) => {
            const preview = transferPreviewSchema.parse(value);
            assert(
              preview.targetStaffId === selected.id &&
                preview.buyerId === ctx.buyerId &&
                preview.conversationKey === scope.conversationKey,
              '转接目标或会话已变化',
            );
            await ctx.guard();
            const pending = await this.engine.db.outboundMessage.findFirst({
              where: {
                conversationId: ctx.conversationId,
                status: { in: ['prepared', 'dispatching', 'unknown'] },
              },
            });
            assert(!pending, '当前有消息发送中或待确认，请核对后再转接');
            const changed = await this.engine.db.platformAction.updateMany({
              where: { id: action.id, status: 'prepared' },
              data: { status: 'dispatched', preview: json(preview) },
            });
            assert(changed.count === 1, '转接已经提交');
            await ctx.guard();
          },
        ),
      );
    } catch (e) {
      const row = await this.engine.db.platformAction.findUniqueOrThrow({
        where: { id: action.id },
      });
      result = {
        status: row.status === 'dispatched' ? ('unknown' as const) : ('rejected' as const),
        reasonCode: 'execution_interrupted',
        message: errorText(e).slice(0, 500),
      };
    }
    await this.engine.db.platformAction.update({
      where: { id: action.id },
      data: { status: result.status, result: json(result) },
    });
    if (result.status !== 'rejected')
      await this.engine.db.conversation.update({
        where: { id: ctx.conversationId },
        data: {
          openedByHuman: true,
          awaitingHuman: true,
          handoffReason: `${result.status === 'confirmed' ? '已转接平台客服' : '平台转接待确认'}：${selected.name}`,
          revision: { increment: 1 },
        },
      });
    return { ...result, actionId: action.id };
  }
  async records(conversationId: string, all = false) {
    await this.conversation(conversationId);
    const rows = await this.engine.db.platformAction.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      ...(all ? {} : { take: 100 }),
    });
    return rows.map((r) => ({
      id: r.id,
      operation: r.operation,
      name: workbenchOperationNames[r.operation] ?? r.operation,
      targetId: r.targetId,
      origin: r.sessionId ? '人工' : 'AI',
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      note: String(record(r.input).note ?? ''),
      message: String(
        record(r.result).message ??
          (r.status === 'prepared' || r.status === 'dispatched' ? '处理中' : ''),
      ),
      preview: r.preview,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewNote: r.reviewNote,
    }));
  }
  async review(actionId: string, note: string) {
    const action = await this.engine.db.platformAction.findUniqueOrThrow({
      where: { id: actionId },
    });
    await this.conversation(action.conversationId);
    assert(
      action.status === 'unknown' ||
        (['transfer-conversation', 'transfer-group', 'close-conversation'].includes(
          action.operation,
        ) &&
          action.status === 'confirmed'),
      '此操作无需人工核对或仍在提交中',
    );
    assert(note.trim(), '请填写在原平台核对的结果');
    await this.engine.db.platformAction.update({
      where: { id: actionId },
      data: { reviewedAt: new Date(), reviewNote: note.trim() },
    });
    this.engine.onChanged();
    return { ok: true };
  }
  async overview() {
    const stores = await this.engine.db.store.findMany({
      where: { accounts: { some: {} } },
      include: { accounts: true, replyPolicy: true },
    });
    return Promise.all(
      stores.map(async (s) => {
        const active = { storeId: s.id, accountId: { in: s.accounts.map((a) => a.id) } };
        const [waiting, human, unread] = await Promise.all([
          this.engine.db.conversation.count({
            where: { ...active, awaitingHuman: true, openedByHuman: false },
          }),
          this.engine.db.conversation.count({ where: { ...active, openedByHuman: true } }),
          this.engine.db.conversation.count({ where: { ...active, unread: { gt: 0 } } }),
        ]);
        const readiness = getAutoReplyReadiness(s.accounts);
        return {
          id: s.id,
          name: s.name,
          platform: s.platform,
          ready: readiness.ready,
          reason: readiness.reason,
          enabled: !!s.replyPolicy?.autoReplyEnabled,
          online: s.accounts.some((a) => a.status === 'online'),
          waiting,
          human,
          unread,
        };
      }),
    );
  }
}
