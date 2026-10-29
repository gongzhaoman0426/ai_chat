export interface QianniuBridgeConfig {
  websocketUrl: string;
  scriptUrl: string;
}
// Qianniu versions differ: these may be global lexical bindings or window properties.
declare const imsdk: any;
declare const TASK_CACHE: Record<string, any>;

/** Self-contained because this function executes inside the preprocessed Qianniu page. */
function installQianniuBridge(config: QianniuBridgeConfig) {
  const page = window as any;
  if (page.__judeskQianniuBridge) {
    page.__judeskQianniuBridge.configure(config);
    return;
  }
  const startedAt = Date.now();
  const sessionId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let socket: WebSocket | undefined;
  let loginId = '';
  let sentLoginId = '';
  let connectedAt = 0;
  let sdk: any;
  let invokeWrapper: any;
  let scriptLoading = false;
  let lastReload = 0;
  let pendingBytes = 0;
  const pending = new Map<string, { loginId: string; payload: string; bytes: number }>();
  const liveConversations = new Map<string, number>();
  const taskLogins = new WeakMap<object, string>();
  const subscriptions = new WeakMap<object, Set<string>>();
  const receiptLookups = new Set<string>();
  // Native GetNewMsg yields Banama messages, while GetOriginalMsgByID can yield
  // a different { msgType, code, ... } model. Join the observed message with its
  // status delta by clientId, as the native UI does, instead of assuming both
  // query methods return the same schema.
  const localSends = new Map<string, { message?: any; update?: any; at: number }>();
  const localKey = (account: string, ccode: unknown, clientId: unknown) =>
    account && typeof ccode === 'string' && ccode && typeof clientId === 'string' && clientId
      ? JSON.stringify([account, ccode, clientId])
      : '';
  const rememberLocal = (key: string, value: { message?: any; update?: any }) => {
    const previous = localSends.get(key);
    localSends.delete(key);
    localSends.set(key, {
      ...(previous && Date.now() - previous.at < 10 * 60_000 ? previous : {}),
      ...value,
      at: Date.now(),
    });
    while (localSends.size > 100) localSends.delete(localSends.keys().next().value!);
    return localSends.get(key)!;
  };
  const completedLocal = (entry: { message?: any; update?: any }) => {
    const { message, update } = entry;
    if (!message || !update) return;
    const existingId = message.mcode?.messageId;
    if (existingId && existingId !== '0' && existingId !== update.mcode.messageId) return;
    return {
      ...message,
      mcode: { ...message.mcode, ...update.mcode },
      status: 0,
      sendTime: update.sendTime ?? message.sendTime,
    };
  };
  const rememberTasks = () => {
    if (!loginId) return;
    const tasks = typeof TASK_CACHE !== 'undefined' ? TASK_CACHE : page.TASK_CACHE;
    if (!tasks || typeof tasks !== 'object') return;
    for (const task of Object.values(tasks))
      if (task && typeof task === 'object' && !taskLogins.has(task)) taskLogins.set(task, loginId);
  };
  const parse = (value: any) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  const identity = () => {
    const state = page._vs || {};
    // 9.52 returns an IM user object. Hook getusername uses the full nickname,
    // including the subaccount suffix; targetId is a different, numeric identity.
    const login = state.loginID;
    const value = typeof login === 'string' ? login : login?.nick;
    return typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : '';
  };
  const send = (data: unknown) => {
    try {
      if (socket?.readyState === 1) socket.send(JSON.stringify(data));
    } catch {}
  };
  const hello = () => {
    if (
      !loginId ||
      socket?.readyState !== 1 ||
      !sdk ||
      !invokeWrapper ||
      page.onInvokeNotify !== invokeWrapper
    )
      return;
    const state = page._vs || {};
    send({
      type: 'hello',
      identity: {
        loginId,
        ...(typeof state.sellerId === 'string' && /^\d{1,30}$/.test(state.sellerId)
          ? { sellerId: state.sellerId }
          : {}),
        ...(typeof state.sellerName === 'string'
          ? { sellerName: state.sellerName.slice(0, 200) }
          : {}),
      },
    });
    sentLoginId = loginId;
  };
  const flush = () => {
    if (socket?.readyState !== 1 || !loginId || sentLoginId !== loginId) return;
    for (const item of pending.values()) {
      if (item.loginId === loginId && socket.bufferedAmount < 1024 * 1024)
        socket.send(item.payload);
    }
  };
  const capture = (response: any, ccode: string, captureLoginId = loginId) => {
    const parsed = parse(response);
    const rawMessages = Array.isArray(parsed) ? parsed : parsed?.result;
    if (!captureLoginId || !Array.isArray(rawMessages) || !rawMessages.length) return;
    const messages = rawMessages.map((message: any) => {
      const key = localKey(captureLoginId, message?.cid?.ccode, message?.mcode?.clientId);
      if (!key || !message.fromid || !message.toid || captureLoginId !== loginId) return message;
      // Bound retained content as well as entry count. Never retain a mutable
      // native object: its UI callback may update it after this observation.
      const serialized = JSON.stringify(message);
      if (serialized.length > 20000) return message;
      const entry = rememberLocal(key, { message: JSON.parse(serialized) });
      return completedLocal(entry) ?? message;
    });
    const eventKey = `${sessionId}:${++sequence}`;
    const observed = liveConversations.get(ccode) || 0;
    const payload = JSON.stringify({
      type: 'messages',
      loginId: captureLoginId,
      eventKey,
      data: {
        result: messages,
        __judesk: {
          loginId: captureLoginId,
          startedAt,
          historical: !(observed && Date.now() - observed < 30000),
        },
      },
    });
    // Retain up to 500 deliveries / 4 MiB until JuDesk confirms durable ingestion.
    const bytes = payload.length * 2;
    if (bytes > 4 * 1024 * 1024) return;
    while (pending.size >= 500 || pendingBytes + bytes > 4 * 1024 * 1024) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pendingBytes -= pending.get(oldest)!.bytes;
      pending.delete(oldest);
    }
    pending.set(eventKey, { loginId: captureLoginId, payload, bytes });
    pendingBytes += bytes;
    flush();
  };
  const reloadConfig = () => {
    if (scriptLoading || Date.now() - lastReload < 5000) return;
    const parent = document.head || document.body || document.documentElement;
    if (!parent) return;
    scriptLoading = true;
    lastReload = Date.now();
    const script = document.createElement('script');
    script.src = `${config.scriptUrl}?reload=${Date.now()}`;
    script.onload = script.onerror = () => {
      scriptLoading = false;
      script.remove();
    };
    parent.appendChild(script);
  };
  const connect = () => {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    const connection = new WebSocket(config.websocketUrl);
    socket = connection;
    connection.onopen = () => {
      connectedAt = Date.now();
      sentLoginId = '';
      hello();
      flush();
    };
    connection.onclose = () => {
      if (socket === connection) {
        socket = undefined;
        sentLoginId = '';
      }
      // A new JuDesk process rotates its secret; reload the fixed bootstrap URL to recover.
      reloadConfig();
    };
    connection.onerror = () => {};
    connection.onmessage = async (event) => {
      const message = parse(event.data);
      if (!message) return;
      if (message.type === 'ack') {
        const item = pending.get(message.eventKey);
        if (item && item.loginId === message.loginId) {
          pendingBytes -= item.bytes;
          pending.delete(message.eventKey);
        }
      } else if (message.type === 'invoke') {
        refreshIdentity();
        if (message.loginId !== loginId || socket !== connection) return;
        try {
          if (!sdk || typeof sdk.invoke !== 'function') throw new Error('千牛 SDK 尚未就绪');
          // JuDesk must never drain the native queue: the Qianniu UI needs it to
          // insert its own sent bubbles. Also make older host pull requests read-only.
          const method =
            message.method === 'im.singlemsg.GetNewMsg'
              ? 'im.singlemsg.PeekNewMsg'
              : message.method;
          const result = await sdk.invoke(method, message.params);
          refreshIdentity();
          if (socket === connection) {
            // Some SDK paths bypass onInvokeNotify. Preserve a host-requested
            // message pull in the same ACK/replay queue as native callbacks.
            if (method === 'im.singlemsg.PeekNewMsg')
              capture(result, message.params?.ccode, message.loginId);
            send({ type: 'response', requestId: message.requestId, success: true, data: result });
          }
        } catch (error) {
          refreshIdentity();
          if (socket === connection)
            send({
              type: 'response',
              requestId: message.requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }
    };
  };
  const refreshIdentity = () => {
    const nextLogin = identity();
    if (nextLogin === loginId) {
      rememberTasks();
      return;
    }
    // Unknown tasks may already belong to the new login. Only preserve old task
    // ownership that was observed while the page still had that old identity.
    loginId = nextLogin;
    liveConversations.clear();
    localSends.clear();
    sentLoginId = '';
    if (socket) {
      const previous = socket;
      socket = undefined;
      previous.close();
    }
  };
  let sdkLoadAttempts = 0;
  let sdkLoading = false;
  let nextSdkLoad = 0;
  const hook = () => {
    const nextSdk = typeof imsdk !== 'undefined' ? imsdk : page.imsdk;
    if (!nextSdk && !sdkLoading && Date.now() >= nextSdkLoad) {
      const parent = document.head || document.body || document.documentElement;
      if (parent) {
        sdkLoading = true;
        sdkLoadAttempts += 1;
        nextSdkLoad = Date.now() + Math.min(120000, 10000 * sdkLoadAttempts);
        const script = document.createElement('script');
        script.src = 'https://iseiya.taobao.com/imsupport';
        script.onload = script.onerror = () => {
          sdkLoading = false;
          script.remove();
        };
        parent.appendChild(script);
      }
    }
    if (
      nextSdk &&
      nextSdk !== sdk &&
      typeof nextSdk.on === 'function' &&
      typeof nextSdk.invoke === 'function'
    ) {
      let registered = subscriptions.get(nextSdk);
      if (!registered) subscriptions.set(nextSdk, (registered = new Set()));
      const subscribe = (name: string, listener: (value: any) => void) => {
        if (registered!.has(name)) return;
        nextSdk.on([name], listener);
        registered!.add(name);
      };
      const peekConversations = (value: any) => {
        // Login can change between polling ticks. Bind the first new event to the
        // current page account before observing its messages.
        refreshIdentity();
        connect();
        const parsed = parse(value);
        const conversations = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.result)
            ? parsed.result
            : parsed?.ccode || parsed?.cid?.ccode
              ? [parsed]
              : [];
        for (const item of conversations) {
          // ReceiveNewMsg carries conversation IDs; SendNewMsg carries { cid, mcode }.
          const ccode = item?.cid?.ccode ?? item?.ccode;
          if (typeof ccode !== 'string' || !loginId) continue;
          liveConversations.set(ccode, Date.now());
          if (liveConversations.size > 1000)
            liveConversations.delete(liveConversations.keys().next().value!);
          // Observe without consuming; Qianniu's own GetNewMsg must still obtain
          // these messages to insert them into its conversation view.
          const originLoginId = loginId;
          Promise.resolve()
            .then(() => {
              refreshIdentity();
              if (loginId !== originLoginId) return;
              return nextSdk.invoke('im.singlemsg.PeekNewMsg', { ccode });
            })
            .then((response) => capture(response, ccode, originLoginId))
            .catch(() => {});
        }
      };
      subscribe('im.singlemsg.onReceiveNewMsg', peekConversations);
      subscribe('im.singlemsg.onSendNewMsg', peekConversations);
      subscribe('im.singlemsg.onMsgSendUpdate', (value: any) => {
        refreshIdentity();
        connect();
        const parsed = parse(value);
        const updates = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.result)
            ? parsed.result
            : [];
        for (const update of updates) {
          const ccode = update?.cid?.ccode;
          const messageId = update?.mcode?.messageId;
          // Native 9.52 first emits a client-only pending message, then assigns
          // the server ID in this delta event. GetNewMsg may already be empty.
          if (
            !loginId ||
            typeof ccode !== 'string' ||
            !ccode ||
            update.sendStatus !== 0 ||
            typeof messageId !== 'string' ||
            !messageId ||
            messageId === '0'
          )
            continue;
          const originLoginId = loginId;
          const originSocket = socket;
          const clientKey = localKey(originLoginId, ccode, update.mcode.clientId);
          if (clientKey) {
            const entry = rememberLocal(clientKey, {
              update: { mcode: { ...update.mcode }, sendTime: update.sendTime },
            });
            const completed = completedLocal(entry);
            if (completed) {
              capture([completed], ccode, originLoginId);
              continue;
            }
          }
          const key = JSON.stringify([originLoginId, ccode, messageId]);
          if (receiptLookups.has(key) || receiptLookups.size >= 100) continue;
          receiptLookups.add(key);
          const cid = { ...update.cid };
          const mcode = { ...update.mcode };
          void Promise.resolve()
            .then(() => {
              refreshIdentity();
              if (loginId !== originLoginId || socket !== originSocket) return;
              return nextSdk.invoke('im.singlemsg.GetOriginalMsgByID', { cid, mcodes: [mcode] });
            })
            .then((response) => {
              refreshIdentity();
              if (loginId !== originLoginId || socket !== originSocket) return;
              const result = parse(response);
              const messages = Array.isArray(result) ? result : result?.result;
              if (!Array.isArray(messages)) return;
              // A status delta lacks content/participants. Only forward the
              // exact platform message retrieved by its ID for normal verification.
              const matching = messages.filter(
                (message: any) =>
                  message?.cid?.ccode === ccode &&
                  message?.mcode?.messageId === messageId &&
                  (message.status === undefined || message.status === 0),
              );
              capture(matching, ccode, originLoginId);
            })
            .catch(() => {})
            .finally(() => receiptLookups.delete(key));
        }
      });
      sdk = nextSdk;
    }
    if (typeof page.onInvokeNotify === 'function' && page.onInvokeNotify !== invokeWrapper) {
      const original = page.onInvokeNotify;
      invokeWrapper = function (this: unknown, sid: string, status: number, response: unknown) {
        refreshIdentity();
        connect();
        // The original callback may delete TASK_CACHE[sid], so read it first.
        const task = (typeof TASK_CACHE !== 'undefined' ? TASK_CACHE : page.TASK_CACHE)?.[sid];
        const ccode = task?.config?.param?.ccode;
        const isMessages =
          ['im.singlemsg.GetNewMsg', 'im.singlemsg.PeekNewMsg'].includes(task?.config?.fn) &&
          status === 0;
        const originLoginId =
          task && typeof task === 'object' ? taskLogins.get(task) || loginId : loginId;
        try {
          return original.apply(this, arguments);
        } finally {
          if (isMessages) {
            try {
              capture(response, ccode, originLoginId);
            } catch {}
          }
        }
      };
      page.onInvokeNotify = invokeWrapper;
    }
  };
  const tick = () => {
    refreshIdentity();
    hook();
    connect();
    if (loginId && sentLoginId !== loginId) hello();
    if (connectedAt && Date.now() - connectedAt > 30000) {
      send({ type: 'ping' });
      connectedAt = Date.now();
    }
  };
  const safeTick = () => {
    try {
      tick();
    } catch {}
  };
  page.__judeskQianniuBridge = {
    configure(next: QianniuBridgeConfig) {
      config = next;
      safeTick();
    },
  };
  setInterval(safeTick, 1000);
  setInterval(() => {
    try {
      flush();
    } catch {}
  }, 3000);
  safeTick();
}

export function generateQianniuInjectionScript(config: QianniuBridgeConfig): string {
  return `;(${installQianniuBridge.toString()})(${JSON.stringify(config).replace(/</g, '\\u003c')});`;
}
