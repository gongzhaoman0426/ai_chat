(() => {
  const VERSION = 5;
  const previous = window.__judeskBridge;
  if (previous?.platform === 'douyin' && previous.version === VERSION) return { installed: true };
  if (previous?.active) return { installed: true, upgradeDeferred: true };
  previous?.dispose?.();
  const bridge = {
    platform: 'douyin',
    version: VERSION,
    createdAt: Date.now(),
    queue: previous?.queue ?? [],
    sequence: previous?.sequence ?? 0,
    sends: previous?.sends ?? new Map(),
    pending: new Map(),
    conversations: new Map(),
    recentMessages: new Map(),
    readMessages: new Set(),
    overflow: false,
    unsupportedEvents: 0,
    receivedEvents: 0,
    lastEventKeys: '',
    stream: null,
    subscription: null,
    updateSubscription: null,
    deleteSubscription: null,
    streamError: false,
    extra: null,
    identityValue: null,
    work: Promise.resolve(),
    waiting: 0,
    upload: null,
    scanAt: 0,
    runtimes: new Map(),
    disposed: false,
    active: false,
  };
  window.__judeskBridge = bridge;
  const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const id = (v) =>
    typeof v === 'string' && v.length <= 1000 && v.trim() && v !== '0'
      ? v
      : typeof v === 'number' && Number.isSafeInteger(v) && v > 0
        ? String(v)
        : undefined;
  const text = (v, max = 50000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const check = (v, message) => {
    if (!v) throw new Error(message);
  };
  const extra = () =>
    (typeof __workbench__ !== 'undefined' ? __workbench__ : window.__workbench__)?.workbenchOptions
      ?.extra;
  const rejected = (v) =>
    v?.success === false ||
    ['code', 'st', 'status_code', 'err_no', 'errno', 'error_code'].some(
      (k) => v?.[k] != null && Number(v[k]) !== 0,
    );
  const payload = (raw) => {
    let v = object(raw);
    for (let i = 0; i < 3; i++) {
      check(!rejected(v), '抖店接口拒绝请求，请检查登录和权限');
      if (v.data && typeof v.data === 'object' && !Array.isArray(v.data)) v = v.data;
      else return v;
    }
    return v;
  };
  const push = (event) => {
    if (bridge.disposed) return;
    if (bridge.queue.length >= 500) {
      bridge.overflow = true;
      return;
    }
    bridge.queue.push({ ...event, sequence: ++bridge.sequence });
  };
  const unsubscribe = () => {
    try {
      if (typeof bridge.subscription === 'function') bridge.subscription();
      else bridge.subscription?.unsubscribe?.();
    } catch {
      /* old SDK already disposed */
    }
    for (const sub of [bridge.updateSubscription, bridge.deleteSubscription]) {
      try {
        sub?.unsubscribe?.();
      } catch {
        /* old SDK */
      }
    }
    bridge.updateSubscription = null;
    bridge.deleteSubscription = null;
    bridge.subscription = null;
    bridge.stream = null;
  };
  bridge.dispose = () => {
    bridge.disposed = true;
    unsubscribe();
  };
  bridge.identity = async () => {
    const e = extra();
    check(e && typeof e.get === 'function', '等待抖店飞鸽工作台加载');
    const p = payload(await e.get('/backstage/currentuser', { _pms: 1, biz_type: 4 }));
    const shop = object(p.shop ?? p.shop_info ?? p.shopInfo);
    const user = object(p.CustomerServiceInfo ?? p.user ?? p.user_info ?? p.userInfo ?? p.staff);
    const mallId = id(p.ShopId ?? p.shop_id ?? p.shopId ?? shop.shop_id ?? shop.id);
    const externalId = id(
      p.staff_id ?? p.staffId ?? p.user_id ?? p.id ?? user.staff_id ?? user.user_id ?? user.id,
    );
    check(mallId && externalId, '抖店登录身份不可用：当前用户接口未返回可识别的店铺和客服 ID');
    if (bridge.identityValue)
      check(
        mallId === bridge.identityValue.mallId && externalId === bridge.identityValue.externalId,
        '登录身份已改变，请为新身份添加账号',
      );
    bridge.identityValue = {
      mallId,
      externalId,
      mallName:
        text(p.ShopName ?? p.shop_name ?? p.shopName ?? shop.name ?? shop.shop_name, 200) ||
        `抖店 ${mallId}`,
      name:
        text(
          p.staff_name ?? p.name ?? p.username ?? user.screen_name ?? user.name ?? user.nick_name,
          200,
        ) || `客服 ${externalId}`,
    };
    return bridge.identityValue;
  };
  const conversationId = (m) => id(m.conversationId ?? m.conversation_id ?? m.biz_conversation_id);
  const serverId = (m) => id(m.serverId ?? m.server_id ?? m.message_id ?? m.msg_id);
  const extension = (m) => {
    let v = m.originExt ?? m.ext ?? m.message_ext;
    if (typeof v === 'string')
      try {
        v = JSON.parse(v);
      } catch {
        v = {};
      }
    return object(v);
  };
  const failedMessage = (m) =>
    rejected(m) ||
    [-2, -3].includes(m.flightStatus) ||
    ['failed', 'fail', 'rejected'].includes(m.sendStatus ?? m.send_status ?? m.status);
  const receiptId = (raw) => {
    const m = object(raw);
    if (
      failedMessage(m) ||
      (typeof m.flightStatus === 'number' && ![3, 4].includes(m.flightStatus)) ||
      ['pending', 'sending', 'created'].includes(m.sendStatus ?? m.send_status ?? m.status)
    )
      return undefined;
    return serverId(m);
  };
  const settle = (pending, result) => {
    if (['confirmed', 'rejected'].includes(bridge.sends.get(pending.id)?.status)) return;
    bridge.sends.set(pending.id, result);
    if (result.status === 'confirmed')
      push({ type: 'confirmed', outboundId: pending.id, externalId: result.externalId });
    if (result.status === 'rejected')
      push({ type: 'send_rejected', outboundId: pending.id, reason: result.reason });
    pending.finish(result);
    if (result.status !== 'unknown') bridge.pending.delete(pending.id);
  };
  const processReceipt = (m) => {
    const ext = extension(m);
    const requestId = ext['p:check_Send'] ?? ext['p:uuid'] ?? ext.uuid;
    const pending = typeof requestId === 'string' ? bridge.pending.get(requestId) : null;
    if (!pending || conversationId(m) !== pending.conversationId) return false;
    if (failedMessage(m)) settle(pending, { status: 'rejected', reason: '抖店明确拒绝发送该消息' });
    else if (receiptId(m)) settle(pending, { status: 'confirmed', externalId: receiptId(m) });
    else return false;
    return true;
  };
  const conversation = async (cid) => {
    const cached = bridge.conversations.get(cid);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const im = extra()?.im;
    const value =
      typeof im?.getConversation === 'function' ? payload(await im.getConversation(cid)) : {};
    const actualId = conversationId(value) ?? id(value.id);
    check(!actualId || actualId === cid, '抖店返回了其他会话');
    bridge.conversations.set(cid, { at: Date.now(), value });
    if (bridge.conversations.size > 500)
      bridge.conversations.delete(bridge.conversations.keys().next().value);
    return value;
  };
  // The six-part address is verified against the platform's parseBizConversationId
  // in its public SDK. Read it only after checking the logged-in shop; never construct one.
  const address = (cid) => {
    const parts = typeof cid === 'string' ? cid.split(':') : [];
    if (parts.length !== 6 || parts[5] !== 'pigeon' || !parts[0] || !parts[1]) return {};
    check(parts[1] === bridge.identityValue?.mallId, '抖店会话属于其他店铺');
    return { buyerId: parts[0], secure: !/^\d+$/.test(parts[0]), cid };
  };
  const getContext = (m, c) => {
    const ext = extension(m),
      convExt = extension(c),
      cid = conversationId(m) ?? id(c.id ?? c.conversation_id);
    const parsed = address(cid);
    const user = object(c.user ?? c.buyer ?? c.customer);
    const userId = id(
      c.user_id ??
        c.userId ??
        user.user_id ??
        user.id ??
        m.user_id ??
        ext.user_id ??
        (parsed.secure === false ? parsed.buyerId : undefined),
    );
    const securityUserId = id(
      c.security_user_id ??
        c.securityUserId ??
        user.security_user_id ??
        m.security_user_id ??
        ext.security_user_id ??
        convExt.security_user_id ??
        (parsed.secure ? parsed.buyerId : undefined),
    );
    const securityConversationId = id(
      c.securityConversationId ??
        c.securityBizConversationId ??
        c.security_conversation_id ??
        m.securityConversationId ??
        m.securityBizConversationId ??
        (parsed.secure ? parsed.cid : undefined),
    );
    return {
      ...(userId ? { userId } : {}),
      ...(securityUserId ? { securityUserId } : {}),
      ...(securityConversationId ? { securityConversationId } : {}),
    };
  };
  const normalize = async (raw, event) => {
    const m = object(raw),
      cid = conversationId(m),
      mid = receiptId(m) ?? (m.msgFrom === 'history' ? serverId(m) : undefined);
    if (!cid || !mid) return null;
    bridge.recentMessages.set(`${cid}:${mid}`, m);
    if (bridge.recentMessages.size > 1000)
      bridge.recentMessages.delete(bridge.recentMessages.keys().next().value);
    const identity = bridge.identityValue ?? (await bridge.identity());
    const c = await conversation(cid);
    const ext = extension(m),
      convExt = extension(c);
    if (m.visible === false && !m.isRecalled) return null;
    const shopId = id(m.shop_id ?? ext.shop_id ?? c.shop_id ?? c.shopId ?? convExt.shop_id);
    if (shopId && shopId !== identity.mallId) return null;
    const actor = object(m.sender ?? m.from),
      recipient = object(m.to);
    const sender = id(m.sender_id ?? m.senderId ?? actor.id ?? actor.uid ?? m.sender);
    const role = m.sender_role ?? m.senderRole ?? actor.role ?? ext.sender_role;
    const ctx = getContext(m, c);
    let direction;
    if (['1', 'user', 'buyer', 'customer'].includes(role)) direction = 'in';
    else if (
      ['2', '4', 'staff', 'seller', 'shop', 'service'].includes(role) ||
      sender === identity.externalId ||
      m.isFromMe === true
    )
      direction = 'out';
    else if (role == null && sender && [ctx.userId, ctx.securityUserId].includes(sender))
      direction = 'in';
    if (!direction) return null;
    const buyerId =
      ctx.userId ??
      ctx.securityUserId ??
      (direction === 'in' ? sender : id(recipient.id ?? recipient.uid));
    if (!buyerId) return null;
    if (!ctx.userId && !ctx.securityUserId && direction === 'in') {
      if (m.securitySender === buyerId) ctx.securityUserId = buyerId;
      else ctx.userId = buyerId;
    }
    let content = m.content ?? m.text;
    if (typeof content === 'string' && content.startsWith('{'))
      try {
        content = JSON.parse(content);
      } catch {
        /* regular text */
      }
    const contentObject = object(content);
    const type = ext.type ?? m.pigeonMsgType ?? m.type ?? m.message_type ?? contentObject.type;
    const image = type === 'file_image' || type === 'image';
    const kind =
      type === 'file_video' || type === 'video'
        ? 'video'
        : type === 'comment' || ext.card_type === 'comment' || contentObject.card_type === 'comment'
          ? 'review_card'
          : type === 'goods_card'
            ? 'product_card'
            : image
              ? 'image'
              : type === 'text' ||
                  typeof contentObject.text === 'string' ||
                  (typeof content === 'string' && type == null)
                ? 'text'
                : 'system';
    let timestamp = m.timestamp ?? m.create_time ?? m.createdAt ?? m.createTime ?? m.ts;
    if (typeof timestamp === 'string' && !/^\d+$/.test(timestamp))
      timestamp = Date.parse(timestamp);
    else timestamp = Number(timestamp);
    if (timestamp < 1e12) timestamp *= 1000;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 300000)
      return null;
    let imageUrl = text(ext.imageUrl ?? contentObject.imageUrl ?? contentObject.image_url, 3000);
    if (image && imageUrl && !imageUrl.startsWith('https://')) {
      try {
        const resolved = payload(
          await extra().get('/backstage/getURLForURI', { uri: imageUrl, file_type: 'image' }),
        );
        imageUrl = text(resolved.url, 3000);
      } catch {
        imageUrl = '';
      }
    }
    return {
      messageId: mid,
      conversationId: cid,
      buyerId,
      buyerName: text(c.user_name ?? c.nickname ?? m.nickname ?? actor.name, 200),
      direction,
      kind,
      ...(kind === 'video' || kind === 'product_card' || kind === 'review_card'
        ? {
            richContent: {
              ...contentObject,
              ...ext,
              orderSn:
                ext.order_id ?? ext.data_id ?? contentObject.order_id ?? contentObject.data_id,
              goodsId:
                ext.goods_id ??
                contentObject.goods_id ??
                contentObject.product_id ??
                contentObject.data_id,
              title: contentObject.title ?? contentObject.product_name,
              url: ext.videoUrl ?? contentObject.video_url ?? contentObject.url,
              videoId: ext.videoId ?? contentObject.videoId ?? contentObject.video_id,
              coverUrl: ext.coverURL ?? contentObject.cover_url,
            },
          }
        : {}),
      text:
        kind === 'video'
          ? '[视频消息]'
          : kind === 'review_card'
            ? '[邀请评价]'
            : kind === 'product_card'
              ? '[商品卡片]'
              : image
                ? '[图片]'
                : kind === 'system'
                  ? text(contentObject.text ?? content) || '[平台消息]'
                  : text(contentObject.text ?? content),
      timestamp: new Date(timestamp).toISOString(),
      platformContext: ctx,
      withdrawn: m.isRecalled === true || ext.is_recalled === 'true',
      historical:
        m.msgFrom === 'history' ||
        m.isOffline === true ||
        event?.isHistory === true ||
        event?.source === 'history' ||
        timestamp < bridge.createdAt - 10000,
      ...(image && imageUrl.startsWith('https://') ? { imageUrl } : {}),
    };
  };
  const onEvent = (event, updateOnly = false) => {
    if (bridge.disposed) return;
    if (++bridge.waiting > 500) {
      bridge.waiting--;
      bridge.overflow = true;
      return;
    }
    bridge.work = bridge.work
      .catch(() => {})
      .then(async () => {
        const e = object(event);
        const messages = Array.isArray(event)
          ? event
          : Array.isArray(e.messages)
            ? e.messages
            : [e.message ?? event];
        for (const m of messages) {
          bridge.receivedEvents++;
          if (processReceipt(object(m))) continue;
          const normalized = await normalize(m, e);
          if (normalized) {
            // sendCustomCard has no client-id argument. Its stream echo can arrive
            // before its promise receipt; only the exact returned server ID is ours.
            if (normalized.direction === 'out' && normalized.kind === 'review_card') {
              const pending = [...bridge.pending.values()].filter(
                (p) => p.kind === 'review_card' && p.conversationId === normalized.conversationId,
              );
              await Promise.all(pending.map((p) => p.completion));
              if (
                [...bridge.sends.values()].some(
                  (r) => r.status === 'confirmed' && r.externalId === normalized.messageId,
                )
              )
                continue;
            }
            if (!updateOnly || normalized.direction === 'out' || normalized.withdrawn)
              push({ type: 'message', message: normalized });
          } else {
            // Only field names, never customer content, tokens or credentials.
            bridge.lastEventKeys = Object.keys(object(m)).slice(0, 20).join(',').slice(0, 300);
            bridge.unsupportedEvents++;
          }
        }
      })
      .catch(() => {
        bridge.unsupportedEvents++;
      })
      .finally(() => {
        bridge.waiting--;
      });
  };
  const findUpload = () => {
    if (bridge.upload || Date.now() - bridge.scanAt < 3000) return;
    bridge.scanAt = Date.now();
    for (const name of Object.keys(window).filter(
      (k) => k === 'masterWebpackJsonp' || k.startsWith('@ecom-vmok/pigeon-im-pc'),
    )) {
      try {
        const chunk = window[name];
        if (typeof chunk?.push !== 'function') continue;
        let require = bridge.runtimes.get(chunk);
        if (!require) {
          chunk.push([
            [`judesk_dy_${Date.now()}`],
            {},
            (r) => {
              require = r;
            },
          ]);
          if (require) bridge.runtimes.set(chunk, require);
        }
        for (const [key, factory] of Object.entries(require?.m ?? {})) {
          if (!String(factory).includes('doImageXUpload')) continue;
          const exports = require(key);
          if (typeof exports?.iP === 'function') {
            bridge.upload = exports.iP;
            return;
          }
        }
      } catch {
        /* another lazy runtime may contain the upload module */
      }
    }
  };
  const attach = () => {
    const e = extra(),
      stream = e?.im?.message$;
    if (e !== bridge.extra) {
      unsubscribe();
      bridge.extra = e;
      bridge.upload = null;
      bridge.scanAt = 0;
      bridge.conversations.clear();
    }
    if (stream !== bridge.stream || bridge.streamError) {
      unsubscribe();
      bridge.streamError = false;
      if (typeof stream?.subscribe === 'function') {
        try {
          bridge.stream = stream;
          bridge.updateSubscription = e.im.onMessageChange?.((event) => {
            if (bridge.stream === stream && !bridge.disposed) onEvent(event, true);
          });
          bridge.deleteSubscription = e.im._messageDel$?.subscribe((event) => {
            if (bridge.stream === stream && !bridge.disposed) onEvent(event, true);
          });
          bridge.subscription = stream.subscribe(
            (event) => {
              if (bridge.stream === stream && !bridge.disposed) onEvent(event);
            },
            () => {
              if (bridge.stream === stream) bridge.streamError = true;
            },
            () => {
              if (bridge.stream === stream) bridge.streamError = true;
            },
          );
        } catch {
          bridge.streamError = true;
        }
      }
    }
    findUpload();
    return !!bridge.stream && !bridge.streamError;
  };
  bridge.poll = () => {
    const e = extra(),
      attached = attach() && (!e?.im?.initialStatus || e.im.initialStatus === 'succeed');
    const canQuery = typeof e?.get === 'function' && typeof e?.im?.getConversation === 'function';
    const operations = canQuery
      ? [
          'goods',
          'goods-detail',
          'buyer-footprint',
          'history',
          ...(typeof e.post === 'function'
            ? [
                'buyer-orders',
                'order-remark-state',
                'order-remark',
                'invite-order',
                'transfer-group',
              ]
            : []),
          'video-materials',
          'staff-groups',
          'staff-statistics',
          ...(typeof e.im.sendVideo === 'function' ? ['send-video'] : []),
          ...(typeof e.im.sendCard === 'function' ? ['send-product-card'] : []),
          ...(typeof e.im.sendCustomCard === 'function' ? ['invite-review'] : []),
        ]
      : [];
    return {
      attached: attached && !bridge.overflow,
      events: bridge.queue.slice(0, 100),
      overflow: bridge.overflow,
      capabilities: {
        receive: attached && !bridge.overflow,
        sendText: typeof e?.im?.sendText === 'function',
        sendImage: !!bridge.upload && typeof e?.im?._sendMsg === 'function',
        history: canQuery,
        goods: canQuery,
        orders: operations.includes('buyer-orders'),
        orderRemark: canQuery && typeof e?.post === 'function',
        markRead:
          typeof e?.im?.markReadMessage === 'function' ||
          typeof e?.im?.markReadConversation === 'function',
        videoMaterials: canQuery,
        sendVideo: typeof e?.im?.sendVideo === 'function',
        sendProductCard: typeof e?.im?.sendCard === 'function',
        staffGroups: canQuery && typeof e?.post === 'function',
        quickActions: canQuery,
        staffTransfer: canQuery && typeof e?.im?.sendTransferService === 'function',
        operations,
      },
      diagnostics: {
        workbench: !!e,
        listenerAttached: attached,
        sendReceiptHook: attached,
        sdkState: text(e?.im?.initialStatus, 100) || 'unknown',
        uploadSdk: !!bridge.upload,
        receivedEvents: bridge.receivedEvents,
        unsupportedEvents: bridge.unsupportedEvents,
        lastEventKeys: bridge.lastEventKeys,
        waitingEvents: bridge.waiting,
      },
    };
  };
  bridge.ack = (sequence) => {
    bridge.queue = bridge.queue.filter((e) => e.sequence > sequence);
  };
  const scoped = async (command) => {
    check(
      typeof command.conversationKey === 'string' && command.conversationKey.length > 0,
      '缺少抖店原始会话 ID',
    );
    const c = await conversation(command.conversationKey),
      live = getContext({}, c),
      saved = object(command.platformContext);
    const ctx = { ...saved, ...live };
    const actualBuyer = live.userId ?? live.securityUserId;
    check(
      !live.userId || !saved.userId || live.userId === saved.userId,
      '抖店会话的买家 ID 已变化',
    );
    check(
      !live.securityUserId || !saved.securityUserId || live.securityUserId === saved.securityUserId,
      '抖店会话的安全买家 ID 已变化',
    );
    const sameSecurity = !!live.securityUserId && live.securityUserId === saved.securityUserId;
    check(
      !actualBuyer ||
        [live.userId, live.securityUserId].includes(command.buyerId) ||
        (sameSecurity && saved.userId === command.buyerId),
      '抖店会话与当前买家不匹配',
    );
    check(
      id(c.shop_id ?? c.shopId) == null ||
        id(c.shop_id ?? c.shopId) === bridge.identityValue?.mallId,
      '抖店会话属于其他店铺',
    );
    return ctx;
  };
  bridge.staff = async () => {
    await bridge.identity();
    check(bridge.poll().capabilities.staffTransfer, '抖店尚未提供客服转接');
    return extra().get('/pcbackstage/getCanAssignStaffList');
  };
  bridge.transfer = async (command) => {
    await bridge.identity();
    check(bridge.poll().capabilities.staffTransfer, '抖店转接接口不可用');
    await scoped(command);
    check(/^[\w-]{1,100}$/.test(command.targetStaffId), '无效转接目标');
    return await extra().im.sendTransferService(command.conversationKey, command.targetStaffId);
  };
  bridge.query = async (operation, command) => {
    await bridge.identity();
    check(bridge.poll().capabilities.operations.includes(operation), '抖店未提供该业务能力');
    const ctx = await scoped(command),
      e = extra();
    const buyer = {
      ...(ctx.userId ? { user_id: ctx.userId } : {}),
      ...(ctx.securityUserId ? { security_user_id: ctx.securityUserId } : {}),
    };
    check(ctx.securityUserId || ctx.userId, '当前会话尚未提供买家平台标识');
    const page = { page_no: command.page - 1, page_size: command.pageSize };
    const goods = {
      ...page,
      ...buyer,
      service_entity_id: '',
      check_status: 3,
      hot_style: 0,
      status: 0,
      is_channel: 0,
      business_type: 4,
      biz_type: 4,
      search_words: command.keyword || '',
    };
    if (operation === 'order-remark-state') return bridge.orderState(command);
    if (operation === 'video-materials')
      return e.get('/backstage/search_pigeon_materials', {
        material_type: 'video',
        order_by: 'UpdateTimeDesc',
        page: command.page,
        size: command.pageSize,
        // Feige's built-in "all videos" root; 103 is the corresponding photo root.
        // This is a platform constant, not a folder belonging to a particular shop.
        parent_folder_id: command.folderId || '203',
      });
    if (operation === 'staff-groups') return e.get('/backstage/queryShopGroupListWithCustomer');
    if (operation === 'staff-statistics')
      return e.get('/backstage/getRealtimeStaffStatistics', {
        queryStaffName: '',
        shopId: bridge.identityValue.mallId,
        page: command.page,
        size: command.pageSize,
        staffStatus: 1,
      });
    if (operation === 'goods')
      return e.get('/backstage/workstation/get_product_list', {
        ...goods,
        presale_biz_scene: 'b_product_list',
      });
    if (operation === 'goods-detail')
      return e.get('/backstage/productdetail', {
        ...buyer,
        product_id: command.goodsId,
        channel_params: '',
        type: '',
        card_uuid: '',
      });
    if (operation === 'buyer-footprint')
      return e.get('/pcbackstage/workstation/get_product_list', {
        ...page,
        ...buyer,
        app_id: 1128,
        presale_biz_scene: 'b_user_footprint',
      });
    if (operation === 'buyer-orders') {
      check(ctx.securityUserId, '当前会话尚未提供买家安全标识，无法核验订单');
      return e.post('/backstage/cmpoent/order/query', {
        ...page,
        security_user_id: ctx.securityUserId,
        tab_type: 0,
        search_words: command.keyword || '',
        is_init_tab: 0,
        biz_type: 2,
        version: '1.0',
        open_params: {},
        workstation_opt_version: 'v2',
        service_entity_id: '',
        workstation_opt_gray: true,
      });
    }
    if (operation === 'history') {
      check(
        ctx.userId || (ctx.securityUserId && ctx.securityConversationId),
        '当前会话尚未提供安全会话标识，无法补拉历史',
      );
      return e.get('/chat/api/backstage/conversation/get_history_msg', {
        biz_type: 4,
        PIGEON_BIZ_TYPE: 2,
        _pms: 1,
        device_platform: 'web',
        FUSION: true,
        cursor: command.cursor || '0',
        ...(ctx.securityUserId
          ? {
              securityUserId: ctx.securityUserId,
              securityBizConversationId: ctx.securityConversationId,
            }
          : { userId: ctx.userId, bizConversationId: command.conversationKey }),
        direction: 0,
        size: command.pageSize,
      });
    }
    throw new Error('不支持的抖店操作');
  };
  const dimensions = (file) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file),
        image = new Image();
      const release = () => URL.revokeObjectURL(url);
      image.onload = () => {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
        release();
      };
      image.onerror = () => {
        reject(new Error('无法读取图片尺寸'));
        release();
      };
      image.src = url;
    });

  bridge.markRead = async (command) => {
    await bridge.identity();
    await scoped(command);
    const ids = Array.isArray(command.messageIds)
      ? command.messageIds
          .slice(0, 50)
          .filter((id) => !bridge.readMessages.has(`${command.conversationKey}:${id}`))
      : [];
    if (!ids.length) return { ok: true };
    let messages = ids
      .map((id) => bridge.recentMessages.get(`${command.conversationKey}:${id}`))
      .filter(Boolean);
    if (!messages.length && ids.length) {
      const raw = payload(await bridge.query('history', { ...command, cursor: '', pageSize: 50 }));
      const list = raw.msgList ?? raw.messages ?? raw.message_list ?? raw.list;
      if (Array.isArray(list))
        messages = list.filter(
          (m) =>
            ids.includes(serverId(m)) &&
            (!conversationId(m) || conversationId(m) === command.conversationKey),
        );
    }
    check(messages.length, '尚未找到当前已查看消息的原始对象，暂未同步平台已读');
    const im = extra().im;
    if (typeof im.markReadConversation === 'function') {
      const raw = await im.markReadConversation(command.conversationKey, messages[0]);
      check(!rejected(raw), '平台拒绝标记已读');
    } else {
      check(typeof im.markReadMessage === 'function', '平台未提供已读接口');
      for (const m of messages) {
        const raw = await im.markReadMessage(command.conversationKey, m);
        check(!rejected(raw), '平台拒绝标记已读');
      }
    }
    for (const m of messages) bridge.readMessages.add(`${command.conversationKey}:${serverId(m)}`);
    while (bridge.readMessages.size > 2000)
      bridge.readMessages.delete(bridge.readMessages.values().next().value);
    return { ok: true };
  };
  bridge.orderState = async (command) => {
    check(
      typeof command.orderSn === 'string' && /^\d{1,30}$/.test(command.orderSn),
      '缺少订单编号',
    );
    const raw = payload(
      await bridge.query('buyer-orders', {
        ...command,
        page: 1,
        pageSize: 30,
        keyword: command.orderSn,
      }),
    );
    const rows = raw.orders ?? raw.order_list ?? raw.list ?? raw.items;
    check(Array.isArray(rows), '订单备注查询未返回可识别的订单列表');
    const order = rows.find((o) => id(o.order_id ?? o.orderId ?? o.order_sn) === command.orderSn);
    check(order, '当前买家订单中未找到目标订单');
    const r = object(order.remark_info ?? order.remarkInfo ?? order);
    const remark = r.remark ?? r.order_remark ?? r.seller_remark;
    const star = r.star ?? r.remark_star;
    check(
      typeof remark === 'string' && Number.isInteger(star) && star >= 0 && star <= 5,
      '平台尚未返回完整备注和星标，禁止覆盖，请在原平台处理',
    );
    return { remark, tag: star, tagName: String(star) };
  };
  bridge.writeOrderRemark = async (command) => {
    await bridge.identity();
    await scoped(command);
    check(
      typeof command.remark === 'string' &&
        command.remark.length <= 300 &&
        Number.isInteger(command.remarkTag) &&
        command.remarkTag >= 0 &&
        command.remarkTag <= 5,
      '备注或星标无效',
    );
    return extra().post('/backstage/workshop/addRemark?_pms=1', {
      order_id: command.orderSn,
      remark_info: {
        is_add_remark: true,
        is_add_star: false,
        remark: command.remark,
        star: command.remarkTag,
      },
      order_remark_auto_expand: true,
    });
  };
  bridge.quickAction = async (command) => {
    await bridge.identity();
    const ctx = await scoped(command),
      e = extra();
    check(
      bridge.poll().capabilities.operations.includes(command.operation),
      '当前平台不支持此操作',
    );
    if (command.operation === 'transfer-group')
      return e.post('/backstage/conversationToShopGroup', {
        fromStaffId: bridge.identityValue.externalId,
        groupId: command.targetId,
        receiverUid: ctx.userId || ctx.securityUserId,
        ignoreSnap: false,
      });
    if (command.operation === 'invite-order') {
      check(ctx.userId, '当前会话未提供邀请下单所需的买家标识');
      return e.post('/backstage/workstation/order_create_care', {
        product_id: command.targetId,
        user_id: ctx.userId,
      });
    }
    throw new Error('未知快捷操作');
  };

  bridge.send = async (command) => {
    if (bridge.sends.has(command.id)) return bridge.sends.get(command.id);
    if (bridge.active)
      return { status: 'rejected', reason: '当前账号仍有消息正在发送，请稍后重试' };
    bridge.active = true;
    let timer,
      pending,
      invoked = false;
    try {
      check(
        typeof command.id === 'string' && typeof command.buyerId === 'string',
        '发送命令不完整',
      );
      await bridge.identity();
      check(bridge.poll().attached, '抖店消息通道尚未就绪');
      bridge.conversations.delete(command.conversationKey);
      await scoped(command);
      const e = extra();
      let send;
      if (command.kind === 'image') {
        check(
          bridge.upload && typeof e.im._sendMsg === 'function',
          '抖店图片上传模块尚未加载，请先在平台打开图片功能',
        );
        check(
          typeof command.imageData === 'string' &&
            command.imageData.length <= 12 * 1024 * 1024 &&
            /^image\/(png|jpeg|webp|gif)$/.test(command.imageMime),
          '图片无效或过大',
        );
        const bytes = Uint8Array.from(atob(command.imageData), (c) => c.charCodeAt(0));
        const file = new File([bytes], `judesk-${command.id}`, { type: command.imageMime });
        const size = await dimensions(file),
          upload = await bridge.upload(file);
        check(
          typeof upload?.uri === 'string' && size.width > 0 && size.height > 0,
          '抖店图片上传未返回有效 URI',
        );
        check(extra() === e, '上传期间工作台已变化');
        await bridge.identity();
        bridge.conversations.delete(command.conversationKey);
        await scoped(command);
        send = () =>
          e.im._sendMsg(command.conversationKey, {
            content: '[图片]',
            type: 'file_image',
            ext: {
              imageUrl: upload.uri,
              imageWidth: String(size.width),
              imageHeight: String(size.height),
              tag_valid: '1',
              uuid: command.id,
              'p:check_Send': command.id,
            },
          });
      } else if (command.kind === 'product_card') {
        const p = command.richContent;
        check(
          p?.kind === 'product_card' &&
            /^\d{1,30}$/.test(p.goodsId) &&
            typeof e.im.sendCard === 'function',
          '商品卡片无效或平台尚不支持',
        );
        send = () =>
          e.im.sendCard({
            card_type: 'goods_card',
            content: '[商品]',
            conversation_id: command.conversationKey,
            data_id: p.goodsId,
            message_ext: JSON.stringify({
              type: 'goods_card',
              card_type: 'goods_card',
              start_scene: '1',
              tag_valid: '1',
              goods_id: p.goodsId,
              'p:uuid': command.id,
              'p:check_Send': command.id,
            }),
          });
      } else if (command.kind === 'review_card') {
        const card = command.richContent;
        check(
          card?.kind === 'review_card' &&
            /^[0-9-]{6,80}$/.test(card.orderSn) &&
            typeof e.im.sendCustomCard === 'function',
          '评价邀请无效或平台尚不支持',
        );
        send = () =>
          e.im.sendCustomCard(command.conversationKey, {
            card_type: 'comment',
            data_id: card.orderSn,
          });
      } else if (command.kind === 'video') {
        const v = command.richContent;
        check(
          v?.kind === 'video' &&
            v.videoId &&
            v.width > 0 &&
            v.height > 0 &&
            v.coverUrl &&
            typeof v.duration === 'number' &&
            typeof e.im.sendVideo === 'function',
          '视频素材不完整，请刷新素材列表',
        );
        send = () =>
          e.im.sendVideo(command.conversationKey, {
            videoId: v.videoId,
            width: v.width,
            height: v.height,
            coverURL: v.coverUrl,
            duration: v.duration,
          });
      } else {
        check(
          command.kind === 'text' &&
            typeof command.text === 'string' &&
            command.text.trim() &&
            command.text.length <= 10000,
          '文本消息无效',
        );
        send = () =>
          e.im.sendText(command.conversationKey, command.text, { 'p:check_Send': command.id });
      }
      const confirmation = new Promise((resolve) => {
        pending = { id: command.id, conversationId: command.conversationKey, finish: resolve };
      });
      pending.kind = command.kind;
      pending.completion = confirmation;
      bridge.pending.set(command.id, pending);
      bridge.sends.set(command.id, { status: 'unknown', reason: '等待抖店消息确认' });
      timer = setTimeout(
        () =>
          settle(pending, {
            status: 'unknown',
            reason: '未收到对应消息的平台确认，请核对抖店记录，勿重复发送',
          }),
        12000,
      );
      invoked = true;
      Promise.resolve(send())
        .then((raw) => {
          if (rejected(raw))
            return settle(pending, { status: 'rejected', reason: '抖店明确拒绝发送该消息' });
          const result = payload(raw),
            m = object(result.message ?? result);
          if (failedMessage(m))
            return settle(pending, {
              status: 'rejected',
              reason: '抖店拒绝发送或将消息设为仅自己可见，买家未收到',
            });
          // A void result or local client ID is not a platform receipt.
          if (receiptId(m) && (!conversationId(m) || conversationId(m) === pending.conversationId))
            settle(pending, { status: 'confirmed', externalId: receiptId(m) });
        })
        .catch(() => {
          /* network rejection is ambiguous; wait for an exact stream receipt */
        });
      return await confirmation;
    } catch (error) {
      const result = {
        status: invoked ? 'unknown' : 'rejected',
        reason: invoked
          ? '发送结果不确定，请核对抖店记录，勿自动重试'
          : `抖店发送前检查未通过：${text(error?.message, 300) || '请确认登录、会话身份及所需发送能力'}`,
      };
      if (pending) settle(pending, result);
      return result;
    } finally {
      clearTimeout(timer);
      bridge.active = false;
      if (bridge.sends.size > 500) {
        const key = bridge.sends.keys().next().value;
        bridge.sends.delete(key);
        bridge.pending.delete(key);
      }
    }
  };
  attach();
  return { installed: true };
})();
