// 快手客服工作台「全店商品 / 商品卡片」探路笔记，不是运行时代码。
// 实际桥接：resources/kuaishou-bridge.js。说明：docs/kuaishou-integration.md
//
// 用法（已登录 https://im.kwaixiaodian.com/ 的商家页，或 JuDesk 内嵌快手分区）：
// 1. 打开 DevTools → Console
// 2. 整段粘贴本文件后回车
// 3. 按提示依次执行下方导出的函数，把结果 JSON 贴回 JuDesk 开发讨论
//
// 不要把带真实买家 ID / 完整订单号的日志提交到公开仓库。

(() => {
  const out = (label, value) => {
    console.log(`[judesk-ks-goods] ${label}`, value);
    return value;
  };

  const sdk =
    window.__judeskBridge?.sdk ||
    window._imsdk?.chatSdk ||
    window.imsdk?.chatSdk ||
    null;

  const postJson = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _parseError: true, raw: text.slice(0, 500) };
    }
    return {
      url,
      httpStatus: response.status,
      ok: response.ok,
      result: json?.result,
      success: json?.success,
      code: json?.code,
      message: json?.error_msg ?? json?.message,
      dataKeys:
        json?.data && typeof json.data === 'object' && !Array.isArray(json.data)
          ? Object.keys(json.data).slice(0, 40)
          : Array.isArray(json?.data)
            ? [`array(${json.data.length})`]
            : [],
      sample: json,
    };
  };

  /** 列出 SDK 上可能与商品/卡片相关的方法名，便于对照原生 UI。 */
  window.__judeskKsDumpSdk = () => {
    if (!sdk) return out('sdk', '未找到 chatSdk / __judeskBridge.sdk，请确认已登录且 IM 已就绪');
    const pick = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 2) return [];
      return Object.keys(obj)
        .filter((k) => /item|product|goods|card|commodity|sku|shelf|catalog|send/i.test(k))
        .slice(0, 80);
    };
    return out('sdk-surface', {
      commonRequest: pick(sdk.commonRequest),
      https: pick(sdk.https),
      esImSdk: pick(sdk.esImSdk),
      storeKeys: pick(sdk.store?.state),
      constructorTypes: (() => {
        const types = [];
        for (let t = 0; t <= 40; t++) {
          try {
            if (typeof sdk.esImSdk?.getKwaiMsgConstructor?.(t)?.create === 'function')
              types.push(t);
          } catch {
            /* ignore */
          }
        }
        return types;
      })(),
    });
  };

  /**
   * 探测候选「店铺商品列表」接口。
   * 成功标准：HTTP 200，且 result===1 / success===true / code===0，且 data 里有商品数组字段。
   * 任一候选成功都不等于已可上线；还需要字段映射与权限验收。
   */
  window.__judeskKsProbeGoodsList = async (opts = {}) => {
    const page = Number(opts.page) > 0 ? Number(opts.page) : 1;
    const pageSize = Math.min(Number(opts.pageSize) || 10, 20);
    const keyword = typeof opts.keyword === 'string' ? opts.keyword : '';
    const offset = (page - 1) * pageSize;
    const bodies = [
      { limit: pageSize, offset, itemTitle: keyword, title: keyword, keyword },
      {
        page,
        pageSize,
        pageNum: page,
        pageNumber: page,
        itemTitle: keyword,
        title: keyword,
        keyword,
        searchWord: keyword,
      },
      {
        pager: { page, pageSize },
        sortType: 0,
        title: keyword,
        itemId: '',
        categoryId: [],
        spuNumber: '',
        skuNumber: '',
      },
    ];
    const paths = [
      '/gateway/business/cs/item/list',
      '/gateway/business/cs/item/search',
      '/gateway/business/cs/product/list',
      '/gateway/business/cs/product/search',
      '/gateway/business/cs/goods/list',
      '/gateway/business/cs/commodity/list',
      '/gateway/business/cs/shelf/item/list',
      '/gateway/business/cs/solution/item/list',
      '/rest/app/tts/item/list',
      '/rest/pc/product/item/list',
    ];
    const hosts = ['https://s.kwaixiaodian.com', 'https://im.kwaixiaodian.com'];
    const results = [];
    for (const host of hosts) {
      for (const path of paths) {
        for (const body of bodies) {
          const url = `${host}${path}?caver=2`;
          try {
            results.push(await postJson(url, body));
          } catch (error) {
            results.push({ url, error: String(error?.message || error).slice(0, 200) });
          }
        }
      }
    }
    const hits = results.filter(
      (row) =>
        row.ok &&
        (row.result === 1 || row.success === true || row.code === 0) &&
        row.dataKeys?.length,
    );
    return out('goods-list-probe', {
      hits: hits.length,
      promising: hits.slice(0, 10),
      // 默认只回传摘要，避免控制台刷屏；需要全量时传 { verbose: true }
      all: opts.verbose ? results : results.map(({ sample, ...rest }) => rest),
    });
  };

  /**
   * Network 抓包辅助：在「原生工作台点一次发送商品卡片」前后执行。
   * 会把最近一段时间里 URL/方法名含 item|product|goods|card 的 fetch 摘要打出来。
   */
  window.__judeskKsWatchNetwork = (ms = 60000) => {
    if (window.__judeskKsFetchHooked) return out('watch', '已在监听中');
    window.__judeskKsFetchHooked = true;
    const original = window.fetch.bind(window);
    const captured = (window.__judeskKsCaptured = []);
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = (init.method || 'GET').toUpperCase();
      const interesting = /item|product|goods|card|commodity|sku|shelf/i.test(url);
      const started = Date.now();
      const response = await original(...args);
      if (interesting) {
        let bodyPreview = '';
        try {
          bodyPreview =
            typeof init.body === 'string'
              ? init.body.slice(0, 400)
              : init.body
                ? '[non-string-body]'
                : '';
        } catch {
          /* ignore */
        }
        captured.push({
          at: new Date().toISOString(),
          method,
          url: url.slice(0, 500),
          status: response.status,
          ms: Date.now() - started,
          bodyPreview,
        });
        console.log('[judesk-ks-goods] fetch', captured[captured.length - 1]);
      }
      return response;
    };
    setTimeout(() => {
      window.fetch = original;
      window.__judeskKsFetchHooked = false;
      out('watch-done', { count: captured.length, captured });
    }, ms);
    return out('watch', `已 hook fetch ${ms}ms：请马上在原生 UI 打开商品面板并发送一张商品卡片`);
  };

  /**
   * 对照抖店：商品卡片通常不是普通 text/image。
   * 在原生发送一张商品卡片后，把最近一条出站消息的 contentType / rawMsg 打出来。
   */
  window.__judeskKsInspectLastOutbound = async (buyerId) => {
    if (!sdk?.esImSdk) return out('inspect', 'SDK 未就绪');
    const id = String(buyerId || '').trim();
    if (!/^[1-9]\d{0,29}$/.test(id)) return out('inspect', '请传入买家 buyerId 字符串');
    const session = await sdk.esImSdk.openSession(0, id);
    const messages = await sdk.esImSdk.getMessages?.(session?.id ?? `0_${id}`);
    const list = Array.isArray(messages) ? messages : messages?.messages || [];
    const sample = list.slice(-8).map((m) => ({
      contentType: m?.contentType ?? m?.rawMsg?.contentType,
      text: typeof m?.text === 'string' ? m.text.slice(0, 80) : undefined,
      msgId: m?.msgId ?? m?.rawMsg?.msgId,
      seqId: String(m?.seqId ?? m?.rawMsg?.seqId ?? ''),
      keys: Object.keys(m || {}).slice(0, 30),
      rawKeys: Object.keys(m?.rawMsg || {}).slice(0, 40),
      extra: m?.extra ?? m?.rawMsg?.extra,
    }));
    return out('last-outbound', sample);
  };

  out('ready', {
    helpers: [
      '__judeskKsDumpSdk()',
      '__judeskKsProbeGoodsList()',
      '__judeskKsWatchNetwork()',
      '__judeskKsInspectLastOutbound(buyerId)',
    ],
    note: '探路成功后把 promising URL + 请求体 + 一条脱敏响应、以及发送卡片的 contentType/构造参数贴回；再接到 bridge。',
  });
})();
