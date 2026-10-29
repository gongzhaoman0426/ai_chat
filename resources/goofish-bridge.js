// Protocol observations: docs/goofish-integration.md. Runs only in the logged-in IM page.
(() => {
  const VERSION = 5;
  const previous = window.__judeskBridge;
  if (previous?.platform === 'goofish' && previous.version === VERSION) return { installed: true };
  if (previous?.active) return { installed: true, upgradeDeferred: true };
  previous?.dispose?.();
  const bridge = {
    platform: 'goofish',
    version: VERSION,
    createdAt: Date.now(),
    disposed: false,
    queue: previous?.queue ?? [],
    sequence: previous?.sequence ?? 0,
    sends: previous?.sends ?? new Map(),
    pending: new Map(),
    seen: new Map(),
    runtimes: new Map(),
    subscriptions: [],
    sdk: null,
    client: null,
    events: null,
    identityValue: null,
    scopes: new Map(),
    drafts: new Map(),
    active: false,
    attached: false,
    overflow: false,
    unsupportedEvents: 0,
    ignoredEvents: 0,
    work: Promise.resolve(),
    waiting: 0,
    scanAt: 0,
    attachment: 0,
  };
  window.__judeskBridge = bridge;
  const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const check = (v, reason) => {
    if (!v) throw new Error(reason);
  };
  const str = (v, max = 10000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const id = (v) =>
    typeof v === 'string' && /^[1-9]\d{0,29}$/.test(v)
      ? v
      : typeof v === 'number' && Number.isSafeInteger(v) && v > 0
        ? String(v)
        : undefined;
  const opaque = (v) => (typeof v === 'string' && v.length && v.length <= 200 ? v : id(v));
  const uiId = (v) => (typeof v === 'string' ? id(v.split('@')[0]) : id(v));
  const compact = (v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  const parse = (v) => {
    if (typeof v !== 'string') return object(v);
    try {
      return object(JSON.parse(v));
    } catch {
      return {};
    }
  };
  const imageUrl = (v) => {
    if (typeof v !== 'string' || !v) return undefined;
    try {
      const u = new URL(v.startsWith('//') ? `https:${v}` : v);
      if (
        !['https:', 'http:'].includes(u.protocol) ||
        u.username ||
        u.password ||
        !['alicdn.com', 'goofish.com', 'taobaocdn.com'].some(
          (d) => u.hostname === d || u.hostname.endsWith('.' + d),
        )
      )
        return undefined;
      // Native headinfo, item search and item detail return HTTP CDN URLs.
      // These CDNs serve HTTPS; keep renderer and asset transport HTTPS-only.
      u.protocol = 'https:';
      return u.href;
    } catch {
      return undefined;
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
  bridge.ack = (sequence) => {
    bridge.queue = bridge.queue.filter((e) => e.sequence > sequence);
  };
  const read = (o, k) => {
    try {
      return o?.[k];
    } catch {
      return undefined;
    }
  };
  const isSdk = (v) =>
    [
      'getUserId',
      'getStore',
      'getMessageServiceSync',
      'registerMessageChangeLisnter',
      'getConnectionStatus',
    ].every((k) => typeof read(v, k) === 'function');
  const isClient = (v) =>
    ['getEventService', 'getMsgService', 'getConvService', 'getAuthService'].every(
      (k) => typeof read(v, k) === 'function',
    );
  function inspect(module) {
    for (const v of [
      module,
      ...Object.keys(object(module))
        .slice(0, 100)
        .map((k) => read(module, k)),
    ]) {
      if (isClient(v)) bridge.client = v;
      if (isSdk(v)) bridge.foundSdk = v;
      else if (typeof read(v, 'getInstance') === 'function') {
        // Instantiate only a class with the IM SDK prototype, never unrelated singletons.
        if (isSdk(v.prototype)) {
          try {
            const s = v.getInstance();
            if (isSdk(s)) bridge.foundSdk = s;
          } catch {}
        }
      }
    }
  }
  function discover() {
    if (Date.now() - bridge.scanAt < 5000 && bridge.sdk && bridge.client) return;
    bridge.scanAt = Date.now();
    bridge.foundSdk = null;
    for (const key of Object.getOwnPropertyNames(window).filter((k) => /^webpackChunk/.test(k))) {
      const chunk = read(window, key);
      if (typeof read(chunk, 'push') !== 'function') continue;
      let require = bridge.runtimes.get(chunk);
      if (!require) {
        try {
          chunk.push([
            [`judesk_goofish_${Date.now()}_${Math.random()}`],
            {},
            (r) => {
              require = r;
            },
          ]);
        } catch {}
        if (require) bridge.runtimes.set(chunk, require);
      }
      if (!require) continue;
      for (const m of Object.values(require.c || {})) inspect(m.exports);
      for (const [moduleId, factory] of Object.entries(require.m || {})) {
        const source = String(factory);
        if (
          !(
            (source.includes('registerMessageChangeLisnter') &&
              source.includes('getMessageServiceSync')) ||
            (source.includes('PaaSMessageChange') &&
              source.includes('getAuthService') &&
              source.includes('getEventService'))
          )
        )
          continue;
        try {
          inspect(require(moduleId));
        } catch {}
      }
    }
    if (!bridge.foundSdk) {
      for (const s of [window._imsdk?.chatSdk, window._imsdk, window.imsdk?.chatSdk])
        if (isSdk(s)) bridge.foundSdk = s;
    }
    if (bridge.foundSdk && bridge.sdk !== bridge.foundSdk) {
      detach();
      bridge.sdk = bridge.foundSdk;
      bridge.scopes.clear();
    }
  }
  const mtop = async (api, data, v = '1.0') => {
    check(typeof window.lib?.mtop?.request === 'function', '等待闲鱼网页接口加载');
    const result = await window.lib.mtop
      .request({
        api,
        v,
        data,
        valueType: 'string',
        type: 'POST',
        dataType: 'json',
        appKey: '34839810',
        accountSite: 'xianyu',
        timeout: 10000,
        needLogin: false,
        sessionOption: 'AutoLoginOnly',
        ecode: 0,
      })
      .catch((error) => {
        // MTOP rejects with a response object, not an Error. Keep its useful status only.
        const statuses = Array.isArray(error?.ret) ? error.ret.join(',') : '';
        if (/FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED|NOT_LOGIN|NEED_LOGIN|登录/.test(statuses))
          throw new Error('闲鱼尚未登录，请在平台窗口完成登录');
        throw new Error(
          '闲鱼接口未成功：' + str(statuses || error?.message || '网络请求失败', 250),
        );
      });
    check(
      Array.isArray(result?.ret) &&
        result.ret.some((r) => /^SUCCESS(?:::|$)/.test(r)) &&
        !result.ret.some((r) => /^(FAIL|ERROR)/.test(r)),
      '闲鱼接口未成功：' + str(result?.ret?.join(',') || '返回结构无法识别', 250),
    );
    check(result.data && typeof result.data === 'object', '闲鱼接口缺少数据');
    return result.data;
  };
  const pickId = (...values) => {
    for (const value of values) {
      const next = uiId(value) || id(value);
      if (next) return next;
    }
  };
  bridge.identity = async () => {
    discover();
    const p = object(await mtop('mtop.taobao.idlemessage.pc.loginuser.get', {}));
    const user = object(p.user || p.userInfo || p.account || p.data);
    const externalId = pickId(p.userId, p.uid, p.accountId, user.userId, user.uid);
    const mallId = pickId(p.mainUserId, p.mainUid, p.hid, user.mainUserId, externalId);
    check(externalId && mallId, '闲鱼登录身份缺少有效用户 ID');
    check(
      !bridge.identityValue ||
        (bridge.identityValue.externalId === externalId && bridge.identityValue.mallId === mallId),
      '闲鱼登录身份已改变，请为新身份添加账号',
    );
    const sdkId = uiId(bridge.sdk?.getUserId?.());
    if (sdkId) check(sdkId === externalId, '闲鱼网页身份与聊天 SDK 不一致');
    bridge.identityValue = {
      externalId,
      mallId,
      mallName:
        str(p.mainUserNick || p.nick || p.userNick || user.nick || user.userNick, 200) ||
        `闲鱼 ${mallId}`,
      name: str(p.nick || p.userNick || user.nick, 200) || `闲鱼用户 ${externalId}`,
    };
    attach();
    return bridge.identityValue;
  };
  const ownId = (value) =>
    value && [bridge.identityValue?.externalId, bridge.identityValue?.mallId].includes(value);
  function sessionFromRaw(raw) {
    const c = object(raw.singleChatUserConversation?.singleChatConversation),
      e = object(c.extension);
    return {
      sessionId: uiId(c.cid),
      sessionType: Number(c.bizType),
      ownerInfo: { userId: id(e.ownerUserId) },
      userInfo: { userId: id(e.extUserId) },
      itemInfo: {
        itemId: id(e.itemId),
        sellerInfo: { userId: id(e.itemSellerId) },
        title: e.itemTitle,
        mainPic: e.itemMainPic,
      },
      extension: e,
    };
  }
  async function scope(sessionId, buyerId, refresh = false) {
    check(id(sessionId) && bridge.identityValue, '缺少闲鱼会话或登录身份');
    const known = bridge.scopes.get(sessionId);
    if (!refresh && known && Date.now() - known.at < 30000) {
      check(!buyerId || known.buyerId === buyerId, '闲鱼会话买家不匹配');
      return known;
    }
    const store = bridge.sdk?.getStore();
    let c = store?.convMap?.get?.(sessionId);
    if (!c && bridge.client) {
      const raw = await bridge.client.getConvService().getConversation(sessionId);
      c = sessionFromRaw(object(raw));
    }
    check(
      c && id(c.sessionId) === sessionId && Number(c.sessionType) === 1,
      '当前会话不是可识别的闲鱼单聊',
    );
    const owner = id(c.ownerInfo?.userId),
      peer = id(c.userInfo?.userId);
    check(owner && peer && ownId(owner) !== ownId(peer), '无法确认闲鱼会话参与人');
    const other = ownId(peer) ? owner : peer;
    check(!buyerId || buyerId === other, '闲鱼会话与当前买家不匹配');
    const itemId = id(c.itemInfo?.itemId),
      sellerId = id(c.itemInfo?.sellerInfo?.userId);
    check(sellerId && ownId(sellerId), '当前账号不是此商品的卖家，已跳过非卖家接待会话');
    const value = {
      sessionId,
      buyerId: other,
      sellerId,
      itemId,
      sessionType: 1,
      session: c,
      at: Date.now(),
    };
    bridge.scopes.set(sessionId, value);
    if (bridge.scopes.size > 1000) bridge.scopes.delete(bridge.scopes.keys().next().value);
    return value;
  }
  function contentFromRaw(message) {
    const c = object(message.content);
    if (Number(c.contentType) !== 101) return c;
    const value = c.custom?.data;
    let result = parse(value);
    if (!Object.keys(result).length && typeof value === 'string') {
      try {
        result = parse(
          new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))),
        );
      } catch {}
    }
    return result;
  }
  function uiMessage(raw) {
    if (!raw?.message) return raw;
    const m = raw.message;
    return {
      messageId: opaque(m.messageId),
      sessionId: uiId(m.cid),
      timeStamp: m.createAt,
      senderInfo: { userId: uiId(m.sender?.uid) },
      content: contentFromRaw(m),
      sendState: !m.messageId ? 1 : raw.msgStatus === -1 ? 2 : 0,
      messageStatus: raw.msgStatus,
      extension: m.extension,
      extJson: m.extension?.extJson,
      recallFeature: raw.recallFeature,
    };
  }
  function normalized(m, s, historical = false) {
    const messageId = opaque(m.messageId),
      senderId = id(m.senderInfo?.userId);
    check(
      messageId &&
        senderId &&
        [s.buyerId, bridge.identityValue.externalId, bridge.identityValue.mallId].includes(
          senderId,
        ),
      '消息缺少稳定 ID 或发送人不属于当前会话',
    );
    check(
      m.sendState === 0 && ![0, 3, 4].includes(m.messageStatus),
      '未成功发送或不对买家可见的消息',
    );
    const ms = Number(m.timeStamp);
    check(Number.isSafeInteger(ms) && ms > 0, '消息时间无效');
    const c = object(m.content),
      kind =
        Number(c.contentType) === 1 ? 'text' : Number(c.contentType) === 2 ? 'image' : 'system';
    check(
      kind !== 'text' || (typeof c.text?.text === 'string' && c.text.text.trim()),
      '文本消息内容未识别',
    );
    const image = kind === 'image' ? imageUrl(c.image?.pics?.[0]?.url) : undefined;
    check(kind !== 'image' || image, '图片消息的地址无法识别');
    return compact({
      messageId,
      conversationId: s.sessionId,
      buyerId: s.buyerId,
      buyerName: str(s.session.userName || s.session.title, 200),
      direction: ownId(senderId) ? 'out' : 'in',
      kind,
      text:
        kind === 'text'
          ? str(c.text?.text, 50000)
          : kind === 'image'
            ? '[图片]'
            : str(c.tip?.text || m.reminder?.content || '[平台消息]', 2000),
      timestamp: new Date(ms).toISOString(),
      imageUrl: image,
      platformContext: compact({
        itemId: s.itemId,
        sellerId: s.sellerId,
        sessionType: 1,
        userId: s.buyerId,
      }),
      historical: historical || ms < bridge.createdAt - 5000,
      withdrawn: m.messageStatus === 2 || Number(c.contentType) === 27,
    });
  }
  const marker = (m) => parse(m.extJson || m.extension?.extJson).judeskOutboundId;
  function settle(p, result) {
    const before = bridge.sends.get(p.id);
    if (before?.status === 'confirmed' || before?.status === 'rejected') return;
    bridge.sends.set(p.id, result);
    if (result.status === 'confirmed')
      push({ type: 'message', outboundId: p.id, message: { msg_id: result.externalId } });
    if (result.status === 'rejected')
      push({ type: 'send_rejected', outboundId: p.id, reason: result.reason });
    p.finish?.(result);
  }
  async function handle(message) {
    if (!bridge.identityValue || bridge.disposed || !message) return;
    // High-level SDK onAdd also emits local pending messages. Never ingest those as human answers.
    if (message.sendState !== 0) return;
    const sid = id(message.sessionId);
    if (!sid) {
      bridge.unsupportedEvents++;
      return;
    }
    try {
      const s = await scope(sid);
      const m = normalized(message, s);
      const p = bridge.pending.get(marker(message));
      if (p && p.sessionId === sid && m.direction === 'out') {
        settle(p, { status: 'confirmed', externalId: m.messageId });
        return;
      }
      const key = `${sid}:${m.messageId}:${m.withdrawn ? 'withdrawn' : 'message'}`;
      if (bridge.seen.has(key)) return;
      bridge.seen.set(key, true);
      if (bridge.seen.size > 5000) bridge.seen.delete(bridge.seen.keys().next().value);
      push({ type: 'message', message: m });
    } catch (e) {
      if (String(e?.message).includes('卖家') || String(e?.message).includes('单聊'))
        bridge.ignoredEvents++;
      else bridge.unsupportedEvents++;
    }
  }
  function enqueue(m) {
    if (bridge.waiting >= 500) {
      bridge.overflow = true;
      return;
    }
    bridge.waiting++;
    const epoch = bridge.attachment;
    bridge.work = bridge.work
      .then(() => (epoch === bridge.attachment ? handle(m) : undefined))
      .catch(() => {
        bridge.unsupportedEvents++;
      })
      .finally(() => bridge.waiting--);
  }
  function detach() {
    bridge.attachment++;
    for (const cleanup of bridge.subscriptions) {
      try {
        cleanup?.();
      } catch {}
    }
    bridge.subscriptions = [];
    bridge.attached = false;
    bridge.events = null;
  }
  function track(promise, epoch) {
    Promise.resolve(promise)
      .then((cleanup) => {
        if (typeof cleanup !== 'function') return;
        if (bridge.disposed || epoch !== bridge.attachment) cleanup();
        else bridge.subscriptions.push(cleanup);
      })
      .catch(() => {
        if (epoch === bridge.attachment) bridge.attached = false;
      });
  }
  function attach() {
    if (!bridge.sdk || !bridge.identityValue || bridge.disposed) return;
    let events = null;
    try {
      events = bridge.client?.getEventService?.() || null;
    } catch {
      events = null;
    }
    if (events === bridge.events && bridge.attached) return;
    detach();
    bridge.events = events;
    const epoch = bridge.attachment;
    try {
      track(bridge.sdk.registerMessageChangeLisnter({ onAdd: enqueue, onLocalRemove() {} }), epoch);
      if (events && typeof events.register === 'function') {
        const cleanup = events.register((name, data) => {
          if (epoch !== bridge.attachment || bridge.disposed) return;
          if (name === 'paas.message.add') enqueue(uiMessage(data));
          else if (name === 'paas.message.changed') {
            const raw = object(data),
              model = object(raw.messageModel);
            const tag = parse(raw.extension?.extJson || model.extension?.extJson).judeskOutboundId;
            const p = bridge.pending.get(tag);
            if (p && uiId(raw.cid) === p.sessionId && raw.recordStatus === -1) {
              settle(p, { status: 'rejected', reason: '闲鱼明确拒绝发送该消息' });
              return;
            }
            if (raw.recordStatus === 1 && model.messageId)
              enqueue(
                uiMessage({
                  message: { ...model, extension: model.extension || raw.extension },
                  msgStatus: 1,
                }),
              );
          } else if (name === 'paas.message.recall' && data?.messageId) {
            Promise.resolve(bridge.sdk.getMessageServiceSync().getMessageById(data.messageId))
              .then((r) => {
                if (r?.data) enqueue({ ...r.data, messageStatus: 2 });
              })
              .catch(() => {});
          }
        });
        if (typeof cleanup === 'function') bridge.subscriptions.push(cleanup);
      }
      bridge.attached = true;
    } catch {
      detach();
    }
  }
  bridge.dispose = () => {
    bridge.disposed = true;
    detach();
  };
  bridge.poll = () => {
    discover();
    attach();
    const online = bridge.sdk?.getConnectionStatus() === 4 && navigator.onLine !== false;
    const attached = Boolean(online && bridge.attached);
    const api = typeof window.lib?.mtop?.request === 'function';
    const history = typeof bridge.client?.getMsgService()?.listPrevMsgs === 'function';
    const sendText =
      attached && typeof bridge.sdk?.getMessageServiceSync()?.sendMessage === 'function';
    const operations = api
      ? [
          'buyer-profile',
          'conversation-item',
          'goods',
          'goods-detail',
          'buyer-footprint',
          'buyer-orders',
          'order-detail',
          'order-logistics',
          'ship-order',
        ]
      : [];
    if (history) operations.push('history');
    return {
      attached,
      events: bridge.queue.slice(0, 100),
      overflow: bridge.overflow,
      capabilities: {
        receive: attached,
        sendText,
        sendImage: sendText && typeof fetch === 'function' && typeof FormData === 'function',
        history: attached && history,
        goods: attached && api,
        buyerProfile: attached && api,
        orders: attached && api,
        shipment: attached && api,
        verified: false,
        operations: attached ? operations : [],
      },
      diagnostics: {
        sdk: !!bridge.sdk,
        sendReceiptHook: bridge.attached,
        connectionStatus: Number(bridge.sdk?.getConnectionStatus() ?? -1),
        unsupportedEvents: bridge.unsupportedEvents,
        ignoredEvents: bridge.ignoredEvents,
        pendingEvents: bridge.waiting,
        mtop: api,
      },
    };
  };
  bridge.markRead = async (input) => {
    const s = await scope(input.conversationKey, input.buyerId, true);
    const service = bridge.sdk.getMessageServiceSync();
    check(typeof service.updateMessageToRead === 'function', '闲鱼暂不支持标记已读');
    const messages = [];
    for (const messageId of (input.messageIds || []).slice(0, 50)) {
      const result = await service.getMessageById(messageId),
        m = result?.data;
      check(m && id(m.sessionId) === s.sessionId, '已读消息不属于当前会话');
      messages.push(m);
    }
    if (messages.length) await service.updateMessageToRead(s.sessionId, messages, s.session, 1);
    return { updated: messages.length };
  };
  async function upload(command) {
    check(
      typeof command.imageData === 'string' &&
        command.imageData.length <= 12 * 1024 * 1024 &&
        /^image\/(png|jpeg|webp|gif)$/.test(command.imageMime),
      '图片格式或大小不支持',
    );
    const bytes = Uint8Array.from(atob(command.imageData), (c) => c.charCodeAt(0));
    const file = new File([bytes], `judesk-${command.id}.${command.imageMime.split('/')[1]}`, {
      type: command.imageMime,
    });
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(
      'https://stream-upload.goofish.com/api/upload.api?floderId=0&appkey=xy_chat&_input_charset=utf-8',
      { method: 'POST', credentials: 'include', body: form },
    );
    check(response.ok, '闲鱼图片上传失败');
    const result = await response.json(),
      value = object(result.object),
      url = imageUrl(value.url);
    check(result.success === true && url, '闲鱼图片上传未返回可用地址');
    const match = typeof value.pix === 'string' && value.pix.match(/^(\d+)[x*_](\d+)$/i);
    let width = match ? Number(match[1]) : 0,
      height = match ? Number(match[2]) : 0;
    if (!width || !height) {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    }
    check(width > 0 && height > 0, '图片尺寸无效');
    return { contentType: 2, image: { pics: [{ url, width, height, type: 0 }] } };
  }
  bridge.send = async (command) => {
    if (bridge.sends.has(command.id)) return bridge.sends.get(command.id);
    if (bridge.active) return { status: 'rejected', reason: '当前账号仍有消息正在发送' };
    bridge.active = true;
    let invoked = false,
      timer,
      p;
    try {
      check(typeof command.id === 'string' && id(command.buyerId), '发送命令无效');
      await bridge.identity();
      check(bridge.poll().capabilities.sendText, '闲鱼聊天连接尚未就绪');
      await scope(command.conversationKey, command.buyerId, true);
      const sdk = bridge.sdk,
        identity = bridge.identityValue.externalId;
      const content =
        command.kind === 'image'
          ? await upload(command)
          : (() => {
              check(
                command.kind === 'text' &&
                  typeof command.text === 'string' &&
                  command.text.trim() &&
                  command.text.length <= 10000,
                '文本消息无效',
              );
              return { contentType: 1, text: { text: command.text } };
            })();
      await bridge.identity();
      check(
        sdk === bridge.sdk &&
          identity === bridge.identityValue.externalId &&
          bridge.poll().capabilities.sendText,
        '发送期间闲鱼页面连接已变化',
      );
      await scope(command.conversationKey, command.buyerId, true);
      const confirmation = new Promise((resolve) => {
        p = { id: command.id, sessionId: command.conversationKey, finish: resolve };
      });
      bridge.pending.set(command.id, p);
      bridge.sends.set(command.id, { status: 'unknown', reason: '等待闲鱼服务器确认' });
      timer = setTimeout(
        () =>
          settle(p, {
            status: 'unknown',
            reason: '未收到对应闲鱼消息的服务器确认，请核对平台，勿重复发送',
          }),
        12000,
      );
      invoked = true;
      Promise.resolve(
        sdk.getMessageServiceSync().sendMessage({
          sessionId: command.conversationKey,
          content,
          extJson: JSON.stringify({ judeskOutboundId: command.id }),
        }),
      ).catch(() => {});
      // The public SDK resolves void. Only a correlated server event is a receipt.
      return await confirmation;
    } catch (e) {
      const result = {
        status: invoked ? 'unknown' : 'rejected',
        reason: invoked
          ? '闲鱼发送结果未知，请核对平台，勿重复发送'
          : str(e?.message, 300) || '闲鱼发送前检查失败',
      };
      if (p) settle(p, result);
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
  function nodes(value) {
    const result = [],
      stack = [value];
    for (let n = 0; stack.length && n < 1500; n++) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        stack.push(...v.slice(0, 100));
        continue;
      }
      result.push(v);
      for (const x of Object.values(v)) if (x && typeof x === 'object') stack.push(x);
    }
    return result;
  }
  function facts(raw) {
    return nodes(raw)
      .flatMap((v) => {
        const label = str(v.label || v.title || v.name, 200),
          value = str(v.value || v.content || v.text || v.desc, 2000);
        return label && value ? [{ label, value }] : [];
      })
      .slice(0, 80);
  }
  function product(p) {
    const goodsId = id(p.itemId || p.goodsId);
    check(goodsId, '闲鱼商品缺少有效 ID');
    return compact({
      goodsId,
      title: str(p.title || p.itemTitle, 2000),
      imageUrl: [p.mainPic, p.absoluteMajorPicture, p.picUrl, p.imageInfos?.[0]?.url]
        .map(imageUrl)
        .find(Boolean),
      priceText: str(p.price || p.reservePrice, 200),
      description: str(p.desc, 10000),
      sellerId: id(p.sellerId || p.sellerInfo?.userId),
    });
  }
  function relatedProducts(raw) {
    const seen = new Set(),
      products = [];
    for (const v of nodes(raw)) {
      const goodsId = id(v.itemId || v.goodsId || v.commonData?.itemId);
      if (!goodsId || seen.has(goodsId)) continue;
      try {
        products.push(
          product({
            itemId: goodsId,
            title: v.title || v.itemTitle || v.middle?.data?.title || v.commonData?.title,
            mainPic:
              v.mainPic || v.picUrl || v.left?.data?.picUrl || v.commonData?.picUrl || v.image,
            price: v.price || v.reservePrice || v.middle?.data?.price,
            sellerId: v.sellerId || v.sellerInfo?.userId || v.commonData?.sellerId,
          }),
        );
        seen.add(goodsId);
      } catch {}
    }
    return { products, seen };
  }
  const trade = (s) =>
    mtop('mtop.idle.trade.message.chat.tradeinfo', {
      sessionId: s.sessionId,
      sessionType: 1,
      peerUserId: s.buyerId,
    });
  const head = (s) => {
    check(s.itemId, '当前会话没有可识别的咨询商品');
    return mtop('mtop.idle.trade.pc.message.headinfo', {
      itemId: s.itemId,
      sessionId: s.sessionId,
      sessionType: 1,
    });
  };
  function orderIds(p) {
    return [
      ...new Set(
        nodes(p).flatMap((v) => {
          const value = id(
            v.orderId ||
              v.bizOrderId ||
              v.tradeId ||
              v.orderSn ||
              (/^订单(编号|号)$/.test(v.label || v.title || v.name || '') ? v.value : undefined),
          );
          if (value) return [value];
          if (typeof v.orderDetailUrl === 'string') {
            try {
              const u = new URL(v.orderDetailUrl);
              const value = id(u.searchParams.get('orderId'));
              return value ? [value] : [];
            } catch {}
          }
          return [];
        }),
      ),
    ];
  }
  function checkOrderScope(value, reason) {
    if (value) return;
    const error = new Error(reason);
    error.code = 'GOOFISH_ORDER_SCOPE_MISMATCH';
    throw error;
  }
  function checkOrderOwner(value, s, label) {
    if (value.buyerId !== undefined)
      checkOrderScope(id(value.buyerId) === s.buyerId, `${label}买家不匹配`);
    if (value.peerUserId !== undefined)
      checkOrderScope(id(value.peerUserId) === s.buyerId, `${label}会话买家不匹配`);
    if (value.sellerId !== undefined)
      checkOrderScope(ownId(id(value.sellerId)), `${label}卖家不匹配`);
    if (value.seller !== undefined)
      checkOrderScope(
        value.seller === true || value.seller === 'true',
        `当前账号不是${label}的卖家`,
      );
  }
  async function relatedOrders(s) {
    const sources = [
      {
        section: 'conversationTrade',
        read: async () => {
          const data = await trade(s);
          check(Array.isArray(data.module?.items), '闲鱼会话订单结构尚未识别');
          return orderIds(data);
        },
      },
    ];
    if (s.itemId)
      sources.push({
        section: 'conversationHead',
        read: async () => {
          const data = await head(s),
            common = object(data.commonData),
            ids = orderIds(data);
          check(
            Object.keys(common).length || (data.left?.data && data.middle?.data),
            '闲鱼会话订单头部结构尚未识别',
          );
          check(common.itemId !== undefined, '闲鱼订单头部缺少会话商品编号');
          checkOrderScope(id(common.itemId) === s.itemId, '闲鱼订单头部商品不属于当前会话');
          for (const value of [data, common]) checkOrderOwner(value, s, '闲鱼订单头部');
          return ids;
        },
      });
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          return { ids: await source.read() };
        } catch (error) {
          if (error?.code === 'GOOFISH_ORDER_SCOPE_MISMATCH') throw error;
          return {
            ids: [],
            failure: {
              section: source.section,
              reason: str(error?.message, 300) || '闲鱼会话关联订单查询失败',
            },
          };
        }
      }),
    );
    const ids = [...new Set(results.flatMap((result) => result.ids))],
      failedSections = results.flatMap((result) => (result.failure ? [result.failure] : []));
    // A failed source plus no evidence is unknown, not an empty order list.
    check(ids.length || !failedSections.length, failedSections.map((v) => v.reason).join('；'));
    return { ids, failedSections };
  }
  async function detail(s, orderSn, related = undefined) {
    check(id(orderSn), '订单编号无效');
    related ??= await relatedOrders(s);
    checkOrderScope(related.ids.includes(orderSn), '订单不属于当前买家会话');
    const raw = await mtop('mtop.idle.web.trade.order.detail', { tid: orderSn });
    const list = nodes(raw),
      ids = orderIds(raw);
    check(ids.includes(orderSn), '闲鱼订单详情未返回对应的订单编号');
    const common = list.find((v) => id(v.orderId || v.bizOrderId) === orderSn) || {};
    const owners = new Set([
      raw,
      object(raw.commonData),
      ...list.filter((v) =>
        [v.orderId, v.bizOrderId, v.tradeId, v.orderSn].some((value) => id(value) === orderSn),
      ),
    ]);
    for (const value of owners) checkOrderOwner(value, s, '订单');
    const canShipWithoutLogistics = list.some(
      (v) => (v.api || v.apiName) === 'mtop.taobao.idle.logistic.consign.dummy',
    );
    const state =
      list.find((v) => typeof v.statusText === 'string' || typeof v.statusDesc === 'string') || {};
    const components = Array.isArray(raw.components) ? raw.components : [];
    const status = components.find((v) => v.render === 'orderStatusVO')?.data?.orderStatusInfo;
    const amount = components.find((v) => v.render === 'orderInfoVO')?.data?.priceInfo?.amount
      ?.value;
    const itemInfo = nodes(raw).find((v) => v.itemInfo?.title)?.itemInfo;
    return {
      raw,
      failedSections: related.failedSections,
      order: compact({
        orderSn,
        goodsId: id(common.itemId || raw.itemId),
        productTitle: str(common.itemTitle || itemInfo?.title, 2000),
        statusText: str(state.statusText || state.statusDesc || status?.title, 200),
        amountText:
          str(common.amountText || common.actualPayFeeText, 200) ||
          (typeof amount === 'string' && /^\d+(?:\.\d{1,2})?$/.test(amount) ? `${amount}元` : ''),
        source: 'current_conversation',
        canShipWithoutLogistics,
        details: facts(raw),
      }),
    };
  }
  bridge.query = async (operation, input) => {
    await bridge.identity();
    check(bridge.poll().attached, '闲鱼消息连接尚未就绪');
    if (operation === 'conversations') return [];
    const s = await scope(input.conversationKey, input.buyerId, true),
      failedSections = [];
    let data,
      partial = false;
    if (operation === 'buyer-profile') {
      const raw = await mtop(
        'mtop.taobao.idlemessage.pc.user.query',
        { type: 0, sessionType: 1, sessionId: s.sessionId, isOwner: false },
        '4.0',
      );
      const p = object(raw.userInfo || raw);
      check(Object.keys(p).length > 0, '闲鱼买家资料结构尚未识别');
      // The official SDK sets userId from the scoped request; v4 userInfo may omit it.
      if (p.userId !== undefined) check(id(p.userId) === s.buyerId, '闲鱼资料不属于当前买家');
      data = compact({
        buyerId: s.buyerId,
        name: str(p.nick || p.fishNick || p.userNick, 200),
        avatarUrl: imageUrl(p.logo || p.avatar || p.avatarUrl),
        introduction: str(p.desc || p.introduction || p.description, 2000),
      });
    } else if (operation === 'conversation-item') {
      if (!s.itemId) data = { product: null };
      else {
        const h = await head(s);
        check(h.left?.data && h.middle?.data, '闲鱼咨询商品结构尚未识别');
        data = compact({
          product: product({
            itemId: s.itemId,
            title: h.middle.data.title || h.middle.data.subTitle,
            mainPic: h.left.data.picUrl,
            price: h.middle.data.price,
            sellerId: s.sellerId,
          }),
          orderSn: orderIds(h)[0],
        });
      }
    } else if (operation === 'goods') {
      const p = await mtop('mtop.taobao.idlemessage.pc.tool.item.search', {
        sessionId: s.sessionId,
        pageSize: input.pageSize,
        pageNumber: input.page,
        searchItemRole: 'own',
        queryWord: '',
      });
      check(Array.isArray(p.items), '闲鱼店铺商品列表结构尚未识别');
      data = {
        products: p.items.slice(0, input.pageSize).map(product),
        page: input.page,
        pageSize: input.pageSize,
        hasMore: typeof p.nextPage === 'boolean' ? p.nextPage : null,
      };
    } else if (operation === 'goods-detail') {
      const p = await mtop('mtop.taobao.idle.pc.detail', { itemId: input.goodsId });
      const item = object(p.itemDO),
        seller = object(p.sellerDO);
      check(
        id(item.itemId) === input.goodsId &&
          ownId(id(seller.sellerId || seller.userId || item.sellerId)),
        '商品不属于当前闲鱼卖家或详情结构尚未识别',
      );
      data = {
        product: product({
          ...item,
          desc: item.desc,
          sellerId: id(seller.sellerId || seller.userId || item.sellerId),
        }),
        properties: facts(item.itemProperties || []),
        propertiesAvailable: Array.isArray(item.itemProperties),
      };
    } else if (operation === 'buyer-footprint') {
      const collected = relatedProducts(await trade(s));
      if (s.itemId && !collected.seen.has(s.itemId)) {
        let extra;
        try {
          const h = await head(s);
          extra = {
            itemId: s.itemId,
            title: h.middle?.data?.title || h.middle?.data?.subTitle || s.session?.itemInfo?.title,
            mainPic: h.left?.data?.picUrl || s.session?.itemInfo?.mainPic,
            price: h.middle?.data?.price,
            sellerId: s.sellerId,
          };
        } catch {
          extra = {
            itemId: s.itemId,
            title: s.session?.itemInfo?.title,
            mainPic: s.session?.itemInfo?.mainPic,
            sellerId: s.sellerId,
          };
        }
        try {
          collected.products.unshift(product(extra));
        } catch {}
      }
      data = {
        products: input.page === 1 ? collected.products.slice(0, input.pageSize) : [],
        page: input.page,
        pageSize: input.pageSize,
        hasMore: false,
      };
      partial = true;
      failedSections.push({
        section: 'browseHistory',
        reason: '闲鱼没有完整浏览足迹，只返回当前会话能核实的关联商品',
      });
      if (!collected.products.length)
        failedSections.push({
          section: 'conversationItem',
          reason: '当前会话没有可识别的咨询商品或关联订单商品',
        });
    } else if (operation === 'history') {
      const cursor = input.cursor || String(Date.now() + 1);
      check(/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor)), '闲鱼历史游标无效');
      const raw = await bridge.client
        .getMsgService()
        .listPrevMsgs(s.sessionId, cursor, input.pageSize);
      check(Array.isArray(raw?.userMessageModels), '闲鱼历史消息结构尚未识别');
      const messages = [];
      for (const item of raw.userMessageModels.slice(0, input.pageSize)) {
        const m = uiMessage(item);
        check(m.sessionId === s.sessionId, '历史消息来自其他会话');
        try {
          const n = normalized(m, s, true);
          messages.push(
            compact({
              messageId: n.messageId,
              text: n.text,
              senderId: id(m.senderInfo.userId),
              timestamp: n.timestamp,
              kind: n.kind,
              imageUrl: n.imageUrl,
            }),
          );
        } catch {
          partial = true;
        }
      }
      if (partial) failedSections.push({ section: 'messages', reason: '部分平台消息类型未识别' });
      data = {
        messages,
        nextCursor: opaque(raw.nextCursor) || null,
        hasMore: typeof raw.hasMore === 'boolean' ? raw.hasMore : null,
      };
    } else if (operation === 'buyer-orders') {
      const related = await relatedOrders(s),
        start = (input.page - 1) * input.pageSize,
        orders = [];
      failedSections.push(...related.failedSections);
      for (const orderSn of related.ids.slice(start, start + input.pageSize)) {
        try {
          orders.push((await detail(s, orderSn, related)).order);
        } catch (error) {
          if (error?.code === 'GOOFISH_ORDER_SCOPE_MISMATCH') throw error;
          orders.push({ orderSn, source: 'current_conversation', canShipWithoutLogistics: false });
          failedSections.push({
            section: `order:${orderSn}`,
            reason: '订单详情获取失败，可再次单独查询',
          });
        }
      }
      data = {
        orders,
        page: input.page,
        pageSize: input.pageSize,
        hasMore: related.ids.length > start + input.pageSize,
      };
      partial = true;
      failedSections.push({
        section: 'allBuyerOrders',
        reason: '返回当前会话中平台明确关联的订单，不代表买家的全部历史订单',
      });
    } else if (operation === 'order-detail') {
      const current = await detail(s, input.orderSn);
      data = { order: current.order };
      failedSections.push(...current.failedSections);
      partial = failedSections.length > 0;
    } else if (operation === 'order-logistics') {
      const current = await detail(s, input.orderSn);
      failedSections.push(...current.failedSections);
      partial = failedSections.length > 0;
      const raw = await mtop('mtop.cainiao.ld.detail.tradeid.ordercode.mailno.rescode.get.xy', {
        tradeId: input.orderSn,
      }).catch(() => ({}));
      const views = Array.isArray(raw.detailViewList) ? raw.detailViewList : [];
      const records = views
        .flatMap((v) =>
          Array.isArray(v.detailList)
            ? v.detailList
                .map((e) => ({
                  label: str(e.ocurrTimeStr || e.statusDesc, 200),
                  value: str(e.standerdDesc || e.statusDesc, 2000),
                }))
                .filter((e) => e.value)
            : [],
        )
        .slice(0, 80);
      if (!records.length) {
        const delivery = await mtop('mtop.taobao.idle.unconsign.detail', {
          orderId: input.orderSn,
        });
        const notes = nodes(delivery)
          .map((v) => str(v.tradeText || v.text || v.content, 2000))
          .filter(Boolean);
        if (notes.length)
          records.push(
            ...notes.slice(0, 80).map((value) => ({ label: '无需物流交付记录', value })),
          );
      }
      check(records.length, '闲鱼物流返回结构尚未识别或暂未提供物流');
      data = { orderSn: input.orderSn, records };
    } else throw new Error('闲鱼不支持此工具');
    await scope(s.sessionId, s.buyerId, true);
    return {
      operation,
      ...(operation === 'goods'
        ? {}
        : { subjectId: operation === 'goods-detail' ? input.goodsId : s.buyerId }),
      queriedAt: new Date().toISOString(),
      partial,
      failedSections,
      data,
    };
  };
  bridge.prepareShipment = async (command) => {
    check(!bridge.drafts.get(command.id)?.submitted, '此发货操作已经提交');
    await bridge.identity();
    const s = await scope(command.conversationKey, command.buyerId, true);
    check(
      command.deliveryMode === 'no_logistics' &&
        typeof command.note === 'string' &&
        command.note.trim() &&
        command.note.length <= 300,
      '无需物流发货参数无效',
    );
    const current = await detail(s, command.orderSn);
    check(current.order.canShipWithoutLogistics, '平台未明确提供该订单的无需物流发货能力');
    const preview = {
      orderSn: command.orderSn,
      buyerId: s.buyerId,
      sellerId: s.sellerId,
      deliveryMode: 'no_logistics',
      note: command.note,
    };
    bridge.drafts.set(command.id, {
      preview,
      sdk: bridge.sdk,
      externalId: bridge.identityValue.externalId,
      sessionId: s.sessionId,
      createdAt: Date.now(),
      submitted: false,
    });
    if (bridge.drafts.size > 500) bridge.drafts.delete(bridge.drafts.keys().next().value);
    return preview;
  };
  bridge.commitShipment = async (command) => {
    const draft = bridge.drafts.get(command.id);
    check(
      draft && !draft.submitted && Date.now() - draft.createdAt < 30000,
      '发货准备已过期或已经提交',
    );
    check(
      draft.preview.orderSn === command.orderSn && draft.preview.note === command.note,
      '发货参数已变化',
    );
    // All network reads happen in prepare/host verification BEFORE the service guard.
    // After the guard use only local checks, then dispatch without another query gap.
    const s = bridge.scopes.get(draft.sessionId);
    check(
      s &&
        s.buyerId === draft.preview.buyerId &&
        bridge.sdk === draft.sdk &&
        uiId(bridge.sdk.getUserId()) === draft.externalId &&
        bridge.sdk.getConnectionStatus() === 4,
      '发货准备后的账号或连接已变化',
    );
    const current = bridge.sdk.getStore()?.convMap?.get?.(draft.sessionId);
    if (current)
      check(
        id(current.itemInfo?.sellerInfo?.userId) === draft.preview.sellerId,
        '发货店铺身份已变化',
      );
    check(
      ownId(draft.preview.sellerId) && s.sellerId === draft.preview.sellerId,
      '发货店铺身份已变化',
    );
    draft.submitted = true;
    try {
      await mtop('mtop.taobao.idle.logistic.consign.dummy', {
        orderId: command.orderSn,
        tradeText: command.note,
        picList: [],
        newUnconsign: true,
      });
      const readback = await mtop('mtop.taobao.idle.unconsign.detail', {
        orderId: command.orderSn,
      });
      const matched = nodes(readback).some(
        (v) => v.tradeText === command.note || v.text === command.note,
      );
      const after = await detail(s, command.orderSn);
      if (matched && !after.order.canShipWithoutLogistics)
        return {
          status: 'confirmed',
          reasonCode: 'delivery_readback',
          message: '已提交无需物流发货并核对交付记录',
        };
      return {
        status: 'unknown',
        reasonCode: 'delivery_unconfirmed',
        message: '发货接口已返回，但交付记录尚未核验，请核对平台，勿重复提交',
      };
    } catch {
      return {
        status: 'unknown',
        reasonCode: 'delivery_unconfirmed',
        message: '发货结果未确认，请核对闲鱼订单，勿重复提交',
      };
    }
  };
  discover();
  return { installed: true };
})();
