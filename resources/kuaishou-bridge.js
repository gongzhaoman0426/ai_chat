(() => {
  const VERSION = 4;
  const previous = window.__judeskBridge;
  if (previous?.platform === 'kuaishou' && previous.version === VERSION) return { installed: true };
  if (previous?.active) return { installed: true, upgradeDeferred: true };
  previous?.dispose?.();
  const bridge = {
    platform: 'kuaishou',
    version: VERSION,
    createdAt: Date.now(),
    queue: previous?.queue ?? [],
    sequence: previous?.sequence ?? 0,
    sends: previous?.sends ?? new Map(),
    pending: new Map(),
    seen: new Map(),
    sdk: null,
    sdkWindow: null,
    stream: null,
    listener: null,
    sdkReady: false,
    identityValue: null,
    identityPending: null,
    require: null,
    chunk: null,
    module: null,
    scanAt: 0,
    disposed: false,
    active: false,
    overflow: false,
    receivedEvents: 0,
    unsupportedEvents: 0,
  };
  window.__judeskBridge = bridge;
  const check = (v, message) => {
    if (!v) throw new Error(message);
  };
  const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const text = (v, max = 50000) => (typeof v === 'string' ? v.slice(0, max) : '');
  // Long values supplied by the native SDK must never pass through Number().
  const id = (v) => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
    if (v && typeof v === 'object' && Number.isInteger(v.low) && Number.isInteger(v.high))
      v = v.toString();
    return typeof v === 'string' && /^[1-9]\d{0,29}$/.test(v) ? v : undefined;
  };
  const rejected = (v) =>
    v?.success === false ||
    (v?.result != null && Number(v.result) !== 1) ||
    (v?.code != null && Number(v.code) !== 0);
  const payload = (raw) => {
    check(raw && typeof raw === 'object', '快手返回了无法识别的数据');
    check(
      !rejected(raw),
      `快手拒绝请求：${text(raw.error_msg ?? raw.message, 250) || '请检查登录和账号权限'}`,
    );
    return raw.data ?? raw;
  };
  // Electron executeJavaScript cannot clone axios wrappers / SDK Response objects.
  const transferable = (raw) => {
    try {
      return JSON.parse(
        JSON.stringify(raw, (_, value) => (typeof value === 'bigint' ? String(value) : value)),
      );
    } catch {
      throw new Error('快手返回了无法序列化的数据');
    }
  };
  const push = (event) => {
    if (bridge.disposed) return;
    if (bridge.queue.length >= 500) {
      bridge.overflow = true;
      return;
    }
    bridge.queue.push({ ...event, sequence: ++bridge.sequence });
  };
  const detach = () => {
    try {
      bridge.stream?.off('messagesUpdate', bridge.listener);
    } catch {
      /* replaced SDK */
    }
    bridge.stream = null;
    bridge.listener = null;
    bridge.sdkReady = false;
    bridge.sdkWindow = null;
    bridge.require = null;
    bridge.chunk = null;
  };
  bridge.dispose = () => {
    bridge.disposed = true;
    detach();
  };
  // Install this independently of Webpack/IM readiness so login always registers the store.
  bridge.identity = () => {
    if (bridge.identityPending) return bridge.identityPending;
    bridge.identityPending = (async () => {
      const response = await fetch(
        'https://im.kwaixiaodian.com/gateway/business/cs/solution/login/user/info/get',
        {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        },
      );
      check(response.ok, '快手登录身份查询失败，请重新登录');
      const raw = await response.json();
      const p = payload(raw),
        mallId = id(p.shopId),
        externalId = id(p.userId);
      check(mallId && externalId, '快手尚未返回店铺和客服身份，请完成登录及店铺选择');
      if (bridge.identityValue)
        check(
          bridge.identityValue.mallId === mallId && bridge.identityValue.externalId === externalId,
          '登录身份已改变，请为新店铺或客服新增账号',
        );
      bridge.identityValue = {
        mallId,
        externalId,
        mallName: text(p.shopName, 200) || `快手店铺 ${mallId}`,
        name: text(p.nickname ?? p.userNickname, 200) || `客服 ${externalId}`,
      };
      return bridge.identityValue;
    })().finally(() => {
      bridge.identityPending = null;
    });
    return bridge.identityPending;
  };
  const validSdk = (sdk) =>
    !!sdk?.store?.state &&
    !!sdk?.esImSdk &&
    typeof sdk.imReady === 'function' &&
    typeof sdk.esImSdk.on === 'function' &&
    typeof sdk.esImSdk.off === 'function';
  const sameIdentity = (sdk) => {
    const info = sdk?.store?.state?.loginUserInfo,
      identity = bridge.identityValue;
    return (
      !!identity &&
      id(info?.belongShopId) === identity.mallId &&
      id(info?.userId) === identity.externalId
    );
  };
  const sdkWindows = () => {
    const targets = [window];
    if (typeof document === 'undefined') return targets;
    try {
      const frames = [
        document.getElementById('__chat_sdk_iframe__'),
        ...document.querySelectorAll('iframe[src*="/workbench/chat-sdk"]'),
      ];
      for (const frame of frames) {
        const target = frame?.contentWindow;
        if (target && !targets.includes(target)) targets.push(target);
      }
    } catch {
      /* A third-party iframe may reject same-origin inspection. */
    }
    return targets;
  };
  const extract = () => {
    if (Date.now() - bridge.scanAt < 2000) return null;
    bridge.scanAt = Date.now();
    const inspect = (module) => {
      for (const value of Object.values(object(module))) {
        const sdk = value?.singleton;
        if (validSdk(sdk) && sameIdentity(sdk)) {
          bridge.module = value;
          return sdk;
        }
      }
      return null;
    };
    // The merchant shell keeps the IM SDK in a same-origin hidden chat-sdk iframe.
    // Use only the known page runtimes, not arbitrary globals or another platform's SDK.
    for (const target of sdkWindows()) {
      let chunk;
      try {
        chunk = target.webpackChunkkwaishop_seller_cs_main;
      } catch {
        continue;
      }
      if (!chunk || typeof chunk.push !== 'function') continue;
      try {
        let runtime = target === bridge.sdkWindow && chunk === bridge.chunk ? bridge.require : null;
        if (!runtime)
          chunk.push([
            [`judesk_${Date.now()}`],
            {},
            (captured) => {
              runtime = captured;
            },
          ]);
        if (runtime) bridge.chunk = chunk;
        if (!runtime?.m) continue;
        for (const cached of Object.values(runtime.c ?? {})) {
          const sdk = inspect(cached?.exports);
          if (sdk) {
            bridge.sdkWindow = target;
            bridge.require = runtime;
            return sdk;
          }
        }
        for (const [moduleId, factory] of Object.entries(runtime.m)) {
          const code = factory.toString();
          if (
            !['singleton', 'commonRequest', 'sessionModel', 'esImSdk', 'imReady'].every((k) =>
              code.includes(k),
            )
          )
            continue;
          const sdk = inspect(runtime(moduleId));
          if (sdk) {
            bridge.sdkWindow = target;
            bridge.require = runtime;
            return sdk;
          }
        }
      } catch {
        /* the page or iframe may still be registering chunks; retry on the next poll */
      }
    }
    return null;
  };
  const messageId = (m) =>
    Number(m?.state ?? m?.rawMsg?.state) === 4
      ? (id(m?.msgId ?? m?.rawMsg?.msgId) ??
        id(m?.seqId ?? m?.rawMsg?.seqId) ??
        id(m?.clientSeqId ?? m?.rawMsg?.clientSeqId))
      : undefined;
  // 与入站 messageId 对齐：线上常见 msgId=0，真实 ID 在 seqId。
  const receipt = (m) => messageId(m);
  const clientSeq = (m) => id(m?.clientSeqId ?? m?.rawMsg?.clientSeqId);
  const clientKey = (m) => {
    const seq = clientSeq(m),
      from = id(m?.fromUserId ?? m?.rawMsg?.fromUserId);
    return seq && from ? `${from}:${seq}` : undefined;
  };
  const settle = (pending, result) => {
    const last = bridge.sends.get(pending.id);
    if (last?.status === 'confirmed' || last?.status === 'rejected') return;
    bridge.sends.set(pending.id, result);
    if (result.status === 'confirmed')
      push({ type: 'confirmed', outboundId: pending.id, externalId: result.externalId });
    pending.resolve?.(result);
  };
  const rememberClient = (pending, m) => {
    pending.clientKey = clientKey(m) || pending.clientKey;
    pending.clientSeq = clientSeq(m) || pending.clientSeq;
  };
  const ownedReceipt = (m) => {
    const key = clientKey(m),
      seq = clientSeq(m),
      sid = text(m?.sessionId) || text(m?.rawMsg?.sessionId);
    const pending = [...bridge.pending.values()].find((p) => {
      if (sid !== p.conversationKey) return false;
      if (p.message === m) return true;
      if (key && p.clientKey === key) return true;
      // fromUserId 可能在 loginImId / userId 间变化；同会话内 clientSeqId 足够唯一。
      if (seq && p.clientSeq && seq === p.clientSeq) return true;
      return false;
    });
    if (!pending) return false;
    rememberClient(pending, m);
    const externalId = receipt(m);
    if (externalId) settle(pending, { status: 'confirmed', externalId });
    return true;
  };
  const imageUrl = async (value) => {
    if (typeof value !== 'string') return undefined;
    try {
      if (value.startsWith('ks://'))
        value = await bridge.sdk.esImSdk.file.resourceUrlToHttpUrl(value);
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  const normalize = async (m, historical) => {
    const raw = object(m?.rawMsg),
      messageKey = messageId(m),
      buyerId = id(m?.sessionTargetId ?? raw.sessionTargetId);
    const sessionType = m?.sessionTargetType ?? raw.sessionTargetType;
    if (
      !messageKey ||
      !buyerId ||
      sessionType !== 0 ||
      m?.sessionId !== `0_${buyerId}` ||
      !sameIdentity(bridge.sdk)
    )
      return null;
    const info = bridge.sdk.store.state.loginUserInfo;
    const self = [id(info.loginImId), id(info.userId), id(info.belongShopId)].filter(Boolean);
    const from = id(m.fromUserId ?? raw.fromUserId),
      to = id(m.toUserId ?? raw.toUserId);
    const direction =
      from === buyerId && (!to || self.includes(to)) ? 'in' : self.includes(from) ? 'out' : null;
    if (!direction) return null;
    const date = m.date ?? raw.timestampMs;
    const timestamp = new Date(date);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= 0) return null;
    const type = m.contentType ?? raw.contentType;
    const kind = type === 0 ? 'text' : type === 1 ? 'image' : 'system';
    const content = kind === 'text' ? text(m.text) : kind === 'image' ? '[图片]' : '[快手平台消息]';
    if (kind === 'text' && !content) return null;
    const profile = bridge.sdk.sessionModel?.provider?.getUserInfoById?.(buyerId);
    const url = kind === 'image' ? await imageUrl(m.url) : undefined;
    return {
      messageId: messageKey,
      conversationId: m.sessionId,
      buyerId,
      buyerName: text(profile?.nickname, 200),
      direction,
      kind,
      text: content,
      timestamp: timestamp.toISOString(),
      historical,
      platformContext: { sessionType: 0, userId: buyerId, sellerId: bridge.identityValue.mallId },
      ...(url ? { imageUrl: url } : {}),
    };
  };
  const onMessages = (sdk, type, messages, timing) => {
    if (bridge.disposed || bridge.sdk !== sdk || !sameIdentity(sdk) || type === 'remove') return;
    if (!Array.isArray(messages)) {
      bridge.unsupportedEvents++;
      return;
    }
    for (const raw of messages) {
      bridge.receivedEvents++;
      // Correlate this exact SDK message before treating seller events as human replies.
      if (ownedReceipt(raw)) continue;
      const historical =
        timing !== 'push' &&
        !(
          type === 'update' &&
          Number(raw?.rawMsg?.timestampMs) >= bridge.createdAt &&
          [
            id(sdk.store.state.loginUserInfo.loginImId),
            id(sdk.store.state.loginUserInfo.belongShopId),
          ].includes(id(raw?.fromUserId))
        );
      void normalize(raw, historical)
        .then((message) => {
          if (!message || bridge.sdk !== sdk || bridge.disposed) {
            bridge.unsupportedEvents++;
            return;
          }
          if (ownedReceipt(raw)) return;
          const key = message.messageId;
          if (bridge.seen.has(key)) return;
          bridge.seen.set(key, true);
          if (bridge.seen.size > 3000) bridge.seen.delete(bridge.seen.keys().next().value);
          push({ type: 'message', message });
        })
        .catch(() => {
          bridge.unsupportedEvents++;
        });
    }
  };
  const attach = () => {
    if (bridge.disposed || !bridge.identityValue) return;
    if (bridge.module?.singleton && bridge.sdk && bridge.module.singleton !== bridge.sdk) {
      detach();
      bridge.sdk = null;
      bridge.scanAt = 0;
    }
    if (bridge.sdk && !sameIdentity(bridge.sdk)) {
      detach();
      bridge.sdk = null;
      bridge.scanAt = 0;
    }
    const discovered = extract();
    if (discovered && bridge.sdk && discovered !== bridge.sdk) {
      detach();
      bridge.sdk = null;
    }
    const sdk = bridge.sdk ?? discovered;
    if (!sdk) return;
    if (bridge.stream === sdk.esImSdk) return;
    detach();
    bridge.sdk = sdk;
    bridge.stream = sdk.esImSdk;
    bridge.listener = (type, messages, timing) => onMessages(sdk, type, messages, timing);
    bridge.stream.on('messagesUpdate', bridge.listener);
    Promise.resolve(sdk.imReady())
      .then(() => {
        if (!bridge.disposed && bridge.sdk === sdk) bridge.sdkReady = true;
      })
      .catch(() => {
        if (bridge.sdk === sdk) {
          detach();
          bridge.sdk = null;
        }
      });
  };
  bridge.poll = () => {
    attach();
    const sdk = bridge.sdk,
      im = sdk?.esImSdk;
    const connected =
      !!bridge.listener && bridge.sdkReady && sameIdentity(sdk) && im?.isConnected === true;
    const operations = connected
      ? [
          ...(typeof sdk.sessionModel?.provider?.getUserInfoById === 'function'
            ? ['buyer-profile']
            : []),
          ...(typeof im.loadMessages === 'function' && typeof im.openSession === 'function'
            ? ['history']
            : []),
          ...(typeof sdk.https?.post === 'function' ? ['buyer-orders'] : []),
          ...(typeof sdk.commonRequest?.getGoodsListNew === 'function'
            ? ['goods', 'buyer-footprint']
            : []),
          ...(typeof sdk.commonRequest?.getSessionTransferGroupList === 'function'
            ? ['staff-groups']
            : []),
          ...(typeof sdk.commonRequest?.getOnlineCsList === 'function' ? ['staff-statistics'] : []),
          ...(typeof sdk.commonRequest?.getSessionTransferGroupList === 'function' &&
          typeof sdk.commonRequest?.batchTransferSessions === 'function'
            ? ['transfer-group']
            : []),
          ...(typeof sdk.messageSender?.sendCommodityMsg === 'function' &&
          typeof sdk.https?.post === 'function' &&
          typeof sdk.commonRequest?.getGoodsListNew === 'function'
            ? ['send-product-card']
            : []),
        ]
      : [];
    const constructor = (type) => {
      try {
        return typeof im?.getKwaiMsgConstructor?.(type)?.create === 'function';
      } catch {
        return false;
      }
    };
    return {
      attached: connected && !bridge.overflow,
      events: bridge.queue.slice(0, 100),
      overflow: bridge.overflow,
      capabilities: {
        receive: connected && !bridge.overflow,
        sendText: connected && typeof im.sendMessage === 'function' && constructor(0),
        sendImage: connected && typeof im.sendMessage === 'function' && constructor(1),
        buyerProfile: operations.includes('buyer-profile'),
        history: operations.includes('history'),
        orders: operations.includes('buyer-orders'),
        goods: operations.includes('goods'),
        sendProductCard: operations.includes('send-product-card'),
        markRead:
          connected &&
          typeof im.markSessionRead === 'function' &&
          typeof im.openSession === 'function',
        staffTransfer:
          connected &&
          typeof sdk.commonRequest?.getOnlineCsList === 'function' &&
          typeof sdk.commonRequest?.batchTransferSessions === 'function',
        staffGroups: operations.includes('staff-groups'),
        operations,
      },
      diagnostics: {
        listenerAttached: !!bridge.listener,
        sendReceiptHook: connected,
        sdkState: connected ? 'connected' : 'waiting',
        receivedEvents: bridge.receivedEvents,
        unsupportedEvents: bridge.unsupportedEvents,
      },
    };
  };
  bridge.ack = (sequence) => {
    bridge.queue = bridge.queue.filter((e) => e.sequence > sequence);
  };
  const scoped = (command) => {
    check(bridge.poll().attached, '快手消息通道尚未连接');
    const context = object(command.platformContext),
      buyer = id(command.buyerId);
    check(
      buyer &&
        command.conversationKey === `0_${buyer}` &&
        context.sessionType === 0 &&
        context.userId === buyer &&
        context.sellerId === bridge.identityValue.mallId,
      '快手会话、买家或店铺范围不匹配',
    );
    check(sameIdentity(bridge.sdk), '快手 SDK 登录身份已变化');
    return bridge.sdk;
  };
  bridge.query = async (operation, command) => {
    await bridge.identity();
    const sdk = scoped(command),
      im = sdk.esImSdk;
    check(bridge.poll().capabilities.operations.includes(operation), '当前快手账号不支持该查询');
    if (operation === 'buyer-profile') {
      const provider = sdk.sessionModel.provider;
      let user = provider.getUserInfoById(command.buyerId);
      if (!user && typeof provider.fetchUsersInfoByIds === 'function') {
        await provider.fetchUsersInfoByIds([command.buyerId]);
        user = provider.getUserInfoById(command.buyerId);
      }
      check(!user?.targetId || id(user.targetId) === command.buyerId, '快手返回了其他买家资料');
      return {
        buyerId: command.buyerId,
        name: text(user?.nickname, 200),
        avatar: await imageUrl(user?.avatar),
        unavailable: !user,
      };
    }
    if (operation === 'buyer-orders') {
      return transferable(
        await sdk.https.post('/gateway/business/cs/order/list', {
          buyerId: command.buyerId,
          itemTitle: command.keyword || '',
          limit: command.pageSize,
          offset: (command.page - 1) * command.pageSize,
          oid: '',
          orderStatus: 0,
          searchCondition: null,
          grayMap: { aftersaleIssue: 'true' },
        }),
      );
    }
    if (operation === 'goods' || operation === 'buyer-footprint') {
      // Prefer https.post over commonRequest.getGoodsListNew: the latter attaches axios
      // response/config that Electron IPC cannot clone ("An object could not be cloned").
      return transferable(
        await sdk.https.post('/gateway/business/cs/list/item/info', {
          buyerId: command.buyerId,
          limit: command.pageSize,
          offset: (command.page - 1) * command.pageSize,
          // 原生 UI：1=全部商品，2=浏览足迹，3=热销商品
          viewTab: operation === 'buyer-footprint' ? 2 : 1,
          searchKeyword: command.keyword || '',
        }),
      );
    }
    if (operation === 'staff-groups')
      return transferable(await sdk.commonRequest.getSessionTransferGroupList());
    if (operation === 'staff-statistics')
      return transferable(await sdk.commonRequest.getOnlineCsList());
    if (operation === 'history') {
      check(!command.cursor || /^[1-9]\d{0,29}$/.test(command.cursor), '快手历史游标无效');
      const session = await im.openSession(0, command.buyerId);
      check(session?.id === command.conversationKey, '快手返回了其他会话');
      const result = await im.loadMessages(
        session,
        command.cursor || '9223372036854775807',
        true,
        command.pageSize,
        false,
        false,
        'preload',
      );
      check(
        Array.isArray(result?.messages) && typeof result.hasMore === 'boolean',
        '快手历史消息结构未识别',
      );
      const messages = (await Promise.all(result.messages.map((m) => normalize(m, true)))).filter(
        Boolean,
      );
      const seqs = result.messages
        .map((m) => id(m.seqId ?? m.rawMsg?.seqId))
        .filter(Boolean)
        .map((s) => BigInt(s));
      const cursor = seqs.length ? String(seqs.reduce((a, b) => (a < b ? a : b))) : undefined;
      check(!result.hasMore || cursor, '快手历史未返回下一页游标');
      return {
        messages,
        hasMore: result.hasMore,
        nextCursor: result.hasMore ? cursor : '',
        partial: messages.length !== result.messages.length,
      };
    }
  };
  bridge.markRead = async (command) => {
    await bridge.identity();
    const sdk = scoped(command),
      session = await sdk.esImSdk.openSession(0, command.buyerId);
    check(session?.id === command.conversationKey, '已读会话不匹配');
    await sdk.esImSdk.markSessionRead(session);
    return { synced: true };
  };
  bridge.staff = async () => {
    await bridge.identity();
    check(bridge.poll().capabilities.staffTransfer, '快手客服转接尚未就绪');
    return bridge.sdk.commonRequest.getOnlineCsList();
  };
  const transfer = async (command, group) => {
    await bridge.identity();
    const sdk = scoped(command),
      target = id(group ? command.targetId : command.targetStaffId);
    check(target, '快手转接目标无效');
    const p = payload(
      await (group
        ? sdk.commonRequest.getSessionTransferGroupList()
        : sdk.commonRequest.getOnlineCsList()),
    );
    const list = group ? p.groups : p.stat;
    check(!group || p.groupDispatch !== false, '快手尚未开启分组转接');
    check(
      Array.isArray(list) && list.some((row) => id(group ? row.groupId : row.userId) === target),
      '目标已不在当前店铺可转接列表',
    );
    check(group || target !== bridge.identityValue.externalId, '不能转接给当前客服');
    const result = await sdk.commonRequest.batchTransferSessions({
      sellerId: bridge.identityValue.mallId,
      buyerIds: [command.buyerId],
      message: text(command.note, 300) || '商家人工转接',
      ...(group ? { allocationGroupId: target } : { allocationUserId: target }),
    });
    // Native UI treats one returned successful item per requested buyer as acknowledgement.
    if (rejected(result))
      return {
        status: 'rejected',
        reasonCode: 'platform_rejected',
        message: `快手拒绝转接：${text(result.error_msg, 250) || '请检查客服状态'}`,
      };
    const listResult = result?.data;
    if (
      (result?.result === 1 || result?.success === true || result?.code === 0) &&
      Array.isArray(listResult) &&
      listResult.length === 1 &&
      listResult[0] != null &&
      listResult[0] !== false
    ) {
      const row = listResult[0],
        explicitBuyer = id(typeof row === 'object' ? row?.buyerId : row);
      if ((!explicitBuyer || explicitBuyer === command.buyerId) && row?.success !== false)
        return { status: 'confirmed', reasonCode: 'platform_confirmed', message: '快手已确认转接' };
    }
    return {
      status: 'unknown',
      reasonCode: 'missing_receipt',
      message: '快手未确认转接完成，请在原平台核对，勿重复提交',
    };
  };
  bridge.transfer = (command) => transfer(command, false);
  bridge.quickAction = (command) => {
    check(command.operation === 'transfer-group', '快手不支持此快捷操作');
    return transfer(command, true);
  };
  const dimensions = (file) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file),
        image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取图片'));
      };
      image.src = url;
    });
  bridge.send = async (command) => {
    if (bridge.sends.has(command.id)) return bridge.sends.get(command.id);
    if (bridge.active) return { status: 'rejected', reason: '当前账号仍有消息正在发送' };
    bridge.active = true;
    let invoked = false,
      timer,
      pending;
    try {
      check(typeof command.id === 'string' && command.id.length > 0, '缺少发送标识');
      await bridge.identity();
      const sdk = scoped(command),
        im = sdk.esImSdk;
      const info = sdk.store.state.loginUserInfo;
      check(Number.isInteger(info.role), '快手客服身份角色尚未就绪');
      const args = { targetId: command.buyerId, targetType: 0, extra: { realFromRole: info.role } };
      let message;
      if (command.kind === 'text') {
        check(
          typeof command.text === 'string' && command.text.trim() && command.text.length <= 10000,
          '文本消息无效',
        );
        message = im.getKwaiMsgConstructor(0).create({ ...args, text: command.text });
      } else if (command.kind === 'image') {
        check(
          typeof command.imageData === 'string' &&
            command.imageData.length <= 12 * 1024 * 1024 &&
            /^image\/(png|jpeg|webp|gif)$/.test(command.imageMime),
          '图片无效或过大',
        );
        const file = new File(
          [Uint8Array.from(atob(command.imageData), (c) => c.charCodeAt(0))],
          `judesk-${command.id}`,
          { type: command.imageMime },
        );
        const size = await dimensions(file);
        check(size.width > 0 && size.height > 0, '图片尺寸无效');
        message = im.getKwaiMsgConstructor(1).create({ ...args, image: file, ...size });
        await bridge.identity();
        scoped(command);
        check(bridge.sdk === sdk, '读取图片期间快手账号已变化');
      } else if (command.kind === 'product_card') {
        const p = command.richContent;
        check(
          p?.kind === 'product_card' && /^\d{1,30}$/.test(p.goodsId),
          '商品卡片无效或缺少商品 ID',
        );
        check(
          typeof sdk.messageSender?.sendCommodityMsg === 'function' &&
            typeof sdk.https?.post === 'function',
          '快手商品卡片发送尚未就绪',
        );
        const pre = payload(
          await sdk.https.post('/rest/app/tts/cs/card/preSendCommodity', {
            targetId: command.buyerId,
            commodityId: p.goodsId,
          }),
        );
        const card = pre.preCommodity;
        check(card && typeof card === 'object', '快手未返回商品卡片预发内容');
        const commodity =
          card.commodity && typeof card.commodity === 'object' ? card.commodity : {};
        // Second arg true: only construct the Commodity(2000) message; bridge owns send+receipt.
        message = await sdk.messageSender.sendCommodityMsg(
          {
            ...args,
            content: { ...card, ...commodity },
          },
          true,
        );
        check(message, '快手未能构造商品卡片消息');
        await bridge.identity();
        scoped(command);
        check(bridge.sdk === sdk, '预发商品卡片期间快手账号已变化');
      } else throw new Error('快手当前仅支持发送文本、图片和商品卡片');
      const done = new Promise((resolve) => {
        pending = { id: command.id, conversationKey: command.conversationKey, message, resolve };
      });
      bridge.pending.set(command.id, pending);
      bridge.sends.set(command.id, { status: 'unknown', reason: '等待快手消息回执' });
      timer = setTimeout(
        () =>
          settle(pending, {
            status: 'unknown',
            reason: '未收到快手消息确认，请核对原平台，勿重复发送',
          }),
        12000,
      );
      invoked = true;
      Promise.resolve(
        im.sendMessage(message, (m) => {
          rememberClient(pending, m);
          ownedReceipt(m);
        }),
      )
        .then((result) => {
          rememberClient(pending, message);
          if (result) rememberClient(pending, result);
          if (result?.sessionId === command.conversationKey && receipt(result))
            settle(pending, { status: 'confirmed', externalId: receipt(result) });
          else ownedReceipt(message);
          if (result && result !== message) ownedReceipt(result);
        })
        .catch(() => {
          /* a network failure may happen after submission; keep waiting for the exact receipt */
        });
      rememberClient(pending, message);
      return await done;
    } catch (error) {
      const result = {
        status: invoked ? 'unknown' : 'rejected',
        reason: text(error?.message, 300) || '快手发送失败',
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
  return { installed: true };
})();
