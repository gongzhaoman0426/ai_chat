(() => {
  if (window.__judeskBridge?.version === 21) return { installed: true };
  const previous = window.__judeskBridge;
  if (previous?.active) return { installed: true, updating: false };
  if (previous) {
    if (previous.socket && previous.listener) {
      if (typeof previous.socket.off === 'function')
        previous.socket.off('message', previous.listener);
      else if (typeof previous.socket.removeListener === 'function')
        previous.socket.removeListener('message', previous.listener);
      previous.socket = null;
    }
    if (previous.sdk?.__judeskOriginalSend) {
      previous.sdk.sendCmdMsg = previous.sdk.__judeskOriginalSend;
      delete previous.sdk.__judeskOriginalSend;
    }
  }
  const bridge = {
    version: 21,
    runtimes: [],
    moduleStats: {},
    sdk: null,
    socket: null,
    listener: null,
    moduleScanAt: 0,
    moduleCandidates: [],
    queue: previous?.queue || [],
    sends: previous?.sends || new Map(),
    active: null,
    im: null,
    upload: null,
    state: null,
    overflow: previous?.overflow || false,
    sequence: previous?.sequence || 0,
  };
  const push = (event) => {
    if (bridge.queue.length >= 500) {
      bridge.overflow = true;
      return;
    }
    bridge.queue.push({ ...event, sequence: ++bridge.sequence });
  };
  const failureReason = (error) => {
    const code = error?.error_code;
    const detail = [error?.error_msg, error?.error, error?.message].find(
      (v) => typeof v === 'string',
    );
    return `${code != null ? `（${String(code).slice(0, 40)}）` : ''}${detail ? `：${detail.slice(0, 300)}` : ''}`;
  };
  const refused = (response) =>
    response?.result === 'fail' ||
    response?.result === 'error' ||
    response?.success === false ||
    (response?.error_code != null && Number(response.error_code) !== 0);
  const merchantRefused = (response) =>
    refused(
      response?.success === true && Number(response.error_code) === 1000000
        ? { ...response, error_code: 0 }
        : response,
    ) ||
    (response?.errorCode != null &&
      Number(response.errorCode) !== 0 &&
      !(response.success === true && Number(response.errorCode) === 1000000));
  const accepted = (response) =>
    response?.msg_id != null &&
    !refused(response) &&
    (response.result == null || response.result === 'ok');
  const settle = (active, result) => {
    const previous = bridge.sends.get(active.id);
    if (previous?.status === 'confirmed' || previous?.status === 'rejected') return;
    bridge.sends.set(active.id, result);
    if (result.status === 'confirmed')
      push({ type: 'message', outboundId: active.id, message: { msg_id: result.externalId } });
    else if (result.status === 'rejected')
      push({ type: 'send_rejected', outboundId: active.id, reason: result.reason });
    active.finish();
  };
  const handleReceipt = (active, response) => {
    if (
      response?.request_id == null ||
      active.requestId == null ||
      String(response.request_id) !== active.requestId
    )
      return;
    active.receiptSeen = true;
    if (refused(response))
      settle(active, { status: 'rejected', reason: `拼多多拒绝发送${failureReason(response)}` });
    else if (accepted(response))
      settle(active, { status: 'confirmed', externalId: String(response.msg_id) });
  };
  const normalize = (message) => {
    if (!message || typeof message !== 'object') return;
    const m = { ...message, from: { ...message.from }, to: { ...message.to } };
    if (m.msg_id != null) m.msg_id = String(m.msg_id);
    if (m.ts != null) m.ts = String(m.ts);
    if (m.from.uid != null) m.from.uid = String(m.from.uid);
    if (m.to.uid != null) m.to.uid = String(m.to.uid);
    return m;
  };
  const read = (object, key) => {
    try {
      return object?.[key];
    } catch {
      return undefined;
    }
  };
  const values = (object) => {
    let keys;
    try {
      keys = Object.keys(object || {});
    } catch {
      return [];
    }
    return keys.map((key) => read(object, key));
  };
  function modules() {
    const found = [];
    const stats = {
      webpackRuntimes: 0,
      moduleFactories: 0,
      matchedFactories: 0,
      cachedModules: 0,
      sendCandidates: 0,
      failedFactories: 0,
    };
    bridge.moduleStats = stats;
    const isIm = (m) =>
      typeof read(m, 'sendMsg') === 'function' &&
      typeof read(m, 'getLatestConversation') === 'function';
    const isUpload = (m) =>
      typeof read(m, 'uploadImage') === 'function' &&
      typeof read(m, 'updateUserRemark') === 'function';
    for (const key of Object.getOwnPropertyNames(window).filter(
      (k) => /^webpackChunk/.test(k) || k === 'webpackJsonp',
    )) {
      const chunk = read(window, key);
      if (!chunk || typeof chunk.push !== 'function') continue;
      let require = bridge.runtimes.find((runtime) => runtime.chunk === chunk)?.require;
      if (!require) {
        const moduleId = `judesk_${Date.now()}_${Math.random()}`;
        // Capture once per page runtime. Repeated polls must not add endless webpack modules.
        try {
          if (key === 'webpackJsonp')
            chunk.push([
              [moduleId],
              {
                [moduleId]: (_module, _exports, r) => {
                  require = r;
                },
              },
              [[moduleId]],
            ]);
          else
            chunk.push([
              [moduleId],
              {},
              (r) => {
                require = r;
              },
            ]);
        } catch {
          continue;
        }
        if (require) bridge.runtimes.push({ chunk, require });
      }
      if (!require) continue;
      stats.webpackRuntimes++;
      stats.moduleFactories += Object.keys(require.m || {}).length;
      // Only instantiate factories matching the known IM/upload signatures. Other cached
      // exports are optional: a throwing getter in an unrelated module must not abort discovery.
      for (const [id, factory] of Object.entries(require.m || {})) {
        const source = String(factory);
        if (
          (source.includes('sendMsgWeb') &&
            (source.includes('getLatestConversation') ||
              ['setCsStatus', 'markRead', 'moveConversation'].every((token) =>
                source.includes(token),
              ))) ||
          (source.includes('uploadImage') && source.includes('updateUserRemark'))
        ) {
          stats.matchedFactories++;
          try {
            const m = require(id);
            found.push(m, ...values(m));
          } catch {
            stats.failedFactories++;
          }
        }
      }
      if (!found.some(isIm) || !found.some(isUpload)) {
        for (const cached of values(require.c)) {
          stats.cachedModules++;
          const exports = read(cached, 'exports');
          found.push(exports, ...values(exports));
        }
      }
    }
    const candidates = found.filter(
      (value) => value && (typeof value === 'object' || typeof value === 'function'),
    );
    stats.sendCandidates = candidates.filter(isIm).length;
    return candidates;
  }
  function vueState(el) {
    return (
      el?.__vue__?.$store?.state ||
      el?.__vue_app__?._instance?.proxy?.$store?.state ||
      el?.__vue_app__?._instance?.ctx?.$store?.state ||
      el?.__vueParentComponent?.proxy?.$store?.state ||
      null
    );
  }
  function findState() {
    const roots = [
      document.getElementById?.('app'),
      document.getElementById?.('root'),
      document.querySelector?.('[data-v-app]'),
    ];
    let fallback = null;
    for (const el of roots) {
      const state = vueState(el);
      if (state?.IMSDK) return state;
      if (state?.userInfo) fallback = state;
    }
    // Some PDD builds mount the chat application below the outer merchant shell.
    for (const el of Array.from(
      document.querySelectorAll?.('[data-v-app], #app *, #root *') || [],
    ).slice(0, 3000)) {
      const state = vueState(el);
      if (state?.IMSDK) return state;
      if (!fallback && state?.userInfo) fallback = state;
    }
    return fallback;
  }
  function attach() {
    const state = findState();
    bridge.state = state;
    if (
      (!bridge.im || !bridge.upload || !state?.IMSDK) &&
      Date.now() - bridge.moduleScanAt > 3000
    ) {
      bridge.moduleScanAt = Date.now();
      bridge.moduleCandidates = modules();
    }
    const all = [state?.IMSDK, window._imsdk, window._uploadsdk, ...bridge.moduleCandidates].filter(
      Boolean,
    );
    bridge.im =
      all.find(
        (m) =>
          typeof read(m, 'sendMsg') === 'function' &&
          typeof read(m, 'getLatestConversation') === 'function',
      ) || null;
    bridge.upload =
      all.find(
        (m) =>
          typeof read(m, 'uploadImage') === 'function' &&
          typeof read(m, 'updateUserRemark') === 'function',
      ) || null;
    const sdk =
      state?.IMSDK ||
      all.find((m) => read(m, 'socket')?.on && typeof read(m, 'sendCmdMsg') === 'function');
    bridge.sdk = sdk || null;
    const socket = sdk?.socket;
    if (bridge.socket !== socket) {
      if (bridge.socket && bridge.listener) {
        if (typeof bridge.socket.off === 'function') bridge.socket.off('message', bridge.listener);
        else if (typeof bridge.socket.removeListener === 'function')
          bridge.socket.removeListener('message', bridge.listener);
      }
      bridge.socket = null;
      bridge.listener = null;
      if (typeof socket?.on === 'function') {
        const listener = (event) => {
          if (bridge.socket !== socket) return;
          const payload = event?.payload;
          const data = Array.isArray(payload?.push_data?.data) ? payload.push_data.data : [];
          const messages = [
            ...data.map((d) => d.message),
            ...(payload?.message ? [payload.message] : []),
          ];
          for (const message of messages) {
            const m = normalize(message);
            if (m) push({ type: 'message', message: m });
          }
        };
        socket.on('message', listener);
        bridge.socket = socket;
        bridge.listener = listener;
      }
    }
    if (typeof sdk?.sendCmdMsg === 'function' && !sdk.__judeskOriginalSend) {
      const original = sdk.sendCmdMsg.bind(sdk);
      sdk.__judeskOriginalSend = original;
      sdk.sendCmdMsg = async function (body, ...args) {
        const active = bridge.active;
        const buyer = body?.message?.to?.uid;
        const tracked =
          active &&
          body?.cmd === 'send_message' &&
          body.request_id != null &&
          active.requestId == null &&
          String(buyer) === active.buyerId &&
          body.message.content === active.content;
        // Bind this command once, before awaiting the platform response. sendMsg may schedule
        // sendCmdMsg after returning, and multiple unrelated platform requests may overlap.
        const requestId = body?.request_id == null ? null : String(body.request_id);
        if (tracked) active.requestId = requestId;
        let res;
        try {
          res = await original(body, ...args);
        } catch (error) {
          if (tracked) {
            // A rejected platform response is definitive; transport exceptions are not.
            if (
              refused(error) &&
              (error.request_id == null || String(error.request_id) === requestId)
            )
              handleReceipt(active, { ...error, request_id: requestId });
            else
              settle(active, {
                status: 'unknown',
                reason: `拼多多发送请求异常${failureReason(error)}；请核对平台记录`,
              });
          }
          throw error;
        }
        if (tracked) handleReceipt(active, res);
        if (
          !tracked &&
          body?.cmd === 'send_message' &&
          requestId != null &&
          res?.request_id != null &&
          requestId === String(res.request_id) &&
          accepted(res)
        ) {
          const message = normalize({
            ...body.message,
            from: {
              role: 'mall_cs',
              uid: String(bridge.state?.userInfo?.mall_id || ''),
              ...body.message.from,
            },
            msg_id: String(res.msg_id),
            ts: body.message.ts || Date.now(),
          });
          push({ type: 'message', message });
        }
        return res;
      };
    }
    return !!bridge.socket && socketConnected(bridge.socket) !== false;
  }
  function socketConnected(socket) {
    if (!socket) return false;
    if (typeof socket.connected === 'boolean') return socket.connected;
    if (typeof socket.readyState === 'number') return socket.readyState === 1;
    return null; // An installed listener alone cannot establish transport connectivity.
  }
  const transferMethod = () =>
    ['moveConversation', 'moveconv'].find((name) => typeof read(bridge.im, name) === 'function');
  bridge.poll = () => {
    const attached = attach();
    return {
      attached,
      events: bridge.queue.slice(0, 100),
      overflow: bridge.overflow,
      capabilities: {
        receive: attached,
        sendText: !!bridge.im,
        sendImage: !!bridge.im && !!bridge.upload,
        history: attached,
        goods: attached,
        orders: attached,
        orderRemark: attached,
        markRead: attached,
        videoMaterials: attached,
        sendVideo: attached,
        staffTransfer: attached && !!transferMethod(),
      },
      diagnostics: {
        ...bridge.moduleStats,
        hasStore: !!bridge.state,
        hasImsdk: !!bridge.sdk,
        listenerAttached: !!bridge.listener,
        socketConnected: socketConnected(bridge.socket),
        sendSdk: !!bridge.im,
        sendReceiptHook: !!bridge.sdk?.__judeskOriginalSend,
        uploadSdk: !!bridge.upload,
        transferMethod: transferMethod() || null,
      },
    };
  };
  bridge.ack = (sequence) => {
    bridge.queue = bridge.queue.filter((e) => e.sequence > sequence);
  };
  bridge.staff = async () => {
    if (!bridge.poll().capabilities.staffTransfer)
      throw new Error('拼多多尚未提供可调用的转接接口');
    return post('/latitude/assign/getAssignCsList', { wechatCheck: true });
  };
  bridge.transfer = async (command) => {
    await bridge.identity();
    if (!bridge.poll().capabilities.staffTransfer) throw new Error('拼多多转接接口不可用');
    if (!/^[\w-]{1,100}$/.test(command.targetStaffId) || typeof command.buyerId !== 'string')
      throw new Error('无效转接目标');
    if (command.targetStaffId === String(bridge.state?.userInfo?.cs_id))
      throw new Error('不能转接给当前客服');
    const params = {
      csid: command.targetStaffId,
      uid: command.buyerId,
      need_wx: false,
      remark: command.note,
    };
    const im = bridge.im;
    if (transferMethod() === 'moveconv') return await im.moveconv(params);
    // The merchant SDK binds moveConversation to its store. It returns void;
    // only this invocation's callback is a receipt. Never call the legacy method
    // as a retry, since the first call may already have transferred the buyer.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), 12000);
      const finish = (receipt) => {
        clearTimeout(timer);
        resolve(receipt);
      };
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      try {
        Promise.resolve(im.moveConversation(params, finish)).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  };
  bridge.identity = async () => {
    // The merchant shell's user.id and the chat store's cs_id are not interchangeable.
    // Always resolve the canonical account from the same authenticated endpoint, on every page.
    const response = await fetch(
      'https://mms.pinduoduo.com/chats/userinfo/realtime?get_response=true',
      { credentials: 'include', cache: 'no-store', signal: globalThis.AbortSignal?.timeout(10000) },
    );
    if (!response.ok) throw new Error('登录身份不可用');
    const r = await response.json();
    const result = r.result && typeof r.result === 'object' ? r.result : r;
    if (result.mall?.mall_id == null || result.id == null)
      throw new Error('尚未登录拼多多商家账号');
    return {
      mallId: String(result.mall.mall_id),
      mallName: String(result.mall.mall_name || '拼多多店铺'),
      externalId: String(result.id),
      name: String(result.username || result.id),
    };
  };
  bridge.send = async (command) => {
    if (bridge.sends.has(command.id)) return bridge.sends.get(command.id);
    if (command.kind === 'video') return bridge.sendVideo(command);
    if (bridge.active) return { status: 'rejected', reason: '账号正在发送上一条消息' };
    attach();
    if (!bridge.im) return { status: 'rejected', reason: '页面 IM SDK 尚不可用' };
    let content = command.text;
    const params = { uid: command.buyerId, content };
    // Reserve the account before asynchronous image upload as well as SDK dispatch.
    const active = {
      id: command.id,
      buyerId: command.buyerId,
      content,
      requestId: null,
      receiptSeen: false,
      finish: () => {},
    };
    bridge.active = active;
    let timer;
    try {
      if (command.kind === 'image') {
        if (!bridge.upload) return { status: 'rejected', reason: '图片上传能力不可用' };
        const image = await bridge.upload.uploadImage(
          { rawImage: `data:${command.imageMime};base64,${command.imageData}` },
          bridge.state.userInfo.mall_id,
        );
        if (!image?.url) return { status: 'rejected', reason: '图片上传没有返回可用地址' };
        content = image.url;
        Object.assign(params, {
          content,
          type: 1,
          config: { size: { height: image.height, width: image.width, image_size: 1 } },
        });
      }
      active.content = content;
      const receipt = new Promise((resolve) => {
        active.finish = resolve;
      });
      timer = setTimeout(() => {
        settle(active, {
          status: 'unknown',
          reason: active.receiptSeen
            ? '拼多多已返回对应请求，但未包含可确认的消息 ID 或明确拒绝；请核对平台记录'
            : active.requestId
              ? `拼多多请求 ${active.requestId} 尚未返回明确回执；请核对平台记录`
              : '已调用拼多多发送接口，但未观察到该命令提交请求；请查看平台窗口是否有发送限制或提示',
        });
      }, 3000);
      bridge.sends.set(command.id, {
        status: 'unknown',
        reason: '等待平台 request_id / msg_id 确认',
      });
      // PDD's sendMsg returns void and queues the actual request with setTimeout. Its return
      // value is not a receipt; retain the command until the exact request gets confirmed.
      // The SDK callback belongs to this exact invocation, and can still report a late
      // receipt if its internal service instance differs from the currently hooked one.
      params.cb = (response) => {
        if (response?.request_id == null) return;
        active.requestId ??= String(response.request_id);
        handleReceipt(active, response);
      };
      Promise.resolve(bridge.im.sendMsg(params)).catch((error) =>
        settle(active, {
          status: 'unknown',
          reason: `拼多多发送调用异常${failureReason(error)}；请核对平台记录`,
        }),
      );
      await receipt;
      return bridge.sends.get(command.id);
    } catch (error) {
      settle(active, {
        status: 'unknown',
        reason: `拼多多发送调用中断${failureReason(error)}；请核对平台记录`,
      });
      return bridge.sends.get(command.id);
    } finally {
      if (timer) clearTimeout(timer);
      if (bridge.active === active) bridge.active = null;
    }
  };
  // Fixed endpoints only. No credentials, arbitrary URLs or raw fetch are exposed to tools.
  const post = async (path, body) => {
    const response = await fetch(`https://mms.pinduoduo.com${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`平台查询返回 ${response.status}`);
    if (response.url && !response.url.startsWith(`https://mms.pinduoduo.com${path}`))
      throw new Error('平台会话已跳转，请检查登录状态');
    if (Number(response.headers?.get('content-length')) > 2000000) throw new Error('平台响应过大');
    const bodyText = await response.text();
    if (bodyText.length > 2000000) throw new Error('平台响应过大');
    return JSON.parse(bodyText);
  };
  const integer = (value, fallback, max) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('无效分页参数');
    return n;
  };
  const buyer = (input) => {
    if (typeof input.buyerId !== 'string' || !input.buyerId || input.buyerId.length > 100)
      throw new Error('缺少当前买家');
    return input.buyerId;
  };
  const goodsId = (input) => {
    if (typeof input.goodsId !== 'string' || !/^\d{1,30}$/.test(input.goodsId))
      throw new Error('无效商品 ID');
    return input.goodsId;
  };
  bridge.query = async (operation, input) => {
    attach();
    if (operation === 'video-materials') {
      const raw = await post('/latitude/user/file/list', {
        page: integer(input.page, 1, 100),
        page_size: integer(input.pageSize, 10, 30),
        order_by: 'create_time desc',
        check_status_list: [2],
        file_type_desc: 'video',
      });
      return raw;
    }
    if (operation === 'order-remark-state') return bridge.orderState(input);
    if (input.keyword) throw new Error('拼多多当前接口不支持关键词搜索');
    if (operation === 'conversations')
      return JSON.parse(JSON.stringify(bridge.state?.chatList || []));
    if (operation === 'goods' || operation === 'buyer-footprint') {
      return post('/latitude/goods/recommendGoods', {
        pageNum: integer(input.page, 1, 100),
        // The shared toolkit accepts smaller pages, but PDD rejects them with
        // 3000000 / bad params. Match its native minimum and report the effective
        // size in normalizePddQuery so subsequent pages use the same boundaries.
        pageSize: Math.max(10, integer(input.pageSize, 10, 30)),
        ...(operation === 'buyer-footprint' ? { uid: buyer(input), type: 2 } : {}),
      });
    }
    if (operation === 'goods-detail') {
      const id = goodsId(input);
      const entries = await Promise.all(
        [
          ['/glide/v2/mms/query/commit/on_shop/detail', { goods_id: id }],
          ['/latitude/goods/goodsProperties', { goodsId: id }],
        ].map(async ([path, body]) => {
          try {
            return { ok: true, data: await post(path, body) };
          } catch (e) {
            return { ok: false, error: String(e.message || e).slice(0, 300) };
          }
        }),
      );
      return { detail: entries[0], properties: entries[1] };
    }
    if (operation === 'goods-skus')
      return post('/latitude/goods/skuSelectorForMall', { goodsId: goodsId(input) });
    if (operation === 'buyer-orders')
      return post('/latitude/order/userAllOrder', {
        uid: buyer(input),
        pageNo: integer(input.page, 1, 100),
        pageSize: integer(input.pageSize, 10, 30),
        showHistory: true,
      });
    if (operation === 'history') {
      if (input.cursor != null && (typeof input.cursor !== 'string' || input.cursor.length > 100))
        throw new Error('无效历史游标');
      return post('/plateau/chat/list', {
        client: 'web',
        data: {
          cmd: 'list',
          list: {
            size: integer(input.pageSize, 20, 50),
            start_msg_id: input.cursor || '',
            sync: true,
            with: { id: buyer(input), role: 'user' },
          },
        },
      });
    }
    throw new Error('unsupported');
  };
  const orderSn = (input) => {
    if (typeof input.orderSn !== 'string' || !/^[0-9-]{6,80}$/.test(input.orderSn))
      throw new Error('无效订单号');
    return input.orderSn;
  };
  // Host-only primitives. Order references, ownership and authorization are checked in service/main.
  bridge.orderState = async (input) => {
    const body = { orderSn: orderSn(input), source: 1 };
    const [note, tag] = await Promise.all([
      post('/pizza/order/note/query', body),
      post('/pizza/order/noteTag/query', body),
    ]);
    return { note, tag };
  };
  bridge.writeOrderRemark = (input) => {
    if (
      typeof input.remark !== 'string' ||
      input.remark.length > 300 ||
      input.remarkTag == null ||
      typeof input.remarkTagName !== 'string'
    )
      throw new Error('无效备注参数');
    return post('/pizza/order/noteTag/update', {
      orderSn: orderSn(input),
      remark: input.remark,
      source: 1,
      remarkTag: input.remarkTag,
      remarkTagName: input.remarkTagName,
    });
  };

  bridge.markRead = async (input) => {
    await bridge.identity();
    const raw = await post('/plateau/chat/mark_read', {
      client: 'web',
      data: { cmd: 'mark_read', conversation: { uid: buyer(input) } },
    });
    if (refused(raw)) throw new Error(`拼多多标记已读失败${failureReason(raw)}`);
    return { ok: true };
  };
  bridge.sendVideo = async (command) => {
    if (bridge.active) return { status: 'rejected', reason: '账号正在发送上一条消息' };
    const video = command.richContent;
    let invoked = false;
    const active = { id: command.id, buyerId: command.buyerId, requestId: null, finish: () => {} };
    bridge.active = active;
    try {
      await bridge.identity();
      const url = new URL(video?.url);
      if (
        video?.kind !== 'video' ||
        url.protocol !== 'https:' ||
        !['pddpic.com', 'pddvideo.com', 'yangkeduo.com'].some(
          (d) => url.hostname === d || url.hostname.endsWith('.' + d),
        )
      )
        throw new Error('视频素材来源无效，请重新查询店铺素材');
      bridge.sends.set(command.id, { status: 'unknown', reason: '等待视频发送回执' });
      invoked = true;
      const raw = await post('/plateau/message/library_file/send', {
        uid: buyer(command),
        url: url.href,
      });
      const result =
        typeof raw.result === 'object' ? raw.result : typeof raw.data === 'object' ? raw.data : raw;
      if (merchantRefused(raw) || merchantRefused(result))
        settle(active, { status: 'rejected', reason: `拼多多拒绝发送视频${failureReason(raw)}` });
      else if (
        result?.msg_id != null &&
        (typeof result.msg_id === 'string' || Number.isSafeInteger(result.msg_id))
      )
        settle(active, { status: 'confirmed', externalId: String(result.msg_id) });
      else
        settle(active, {
          status: 'unknown',
          reason: '平台未返回视频消息编号，请核对原平台，勿重复发送',
        });
    } catch (e) {
      settle(active, {
        status: invoked ? 'unknown' : 'rejected',
        reason: String(e.message || e).slice(0, 300),
      });
    } finally {
      if (bridge.active === active) bridge.active = null;
    }
    return bridge.sends.get(command.id);
  };

  window.__judeskBridge = bridge;
  attach();
  return { installed: true };
})();
