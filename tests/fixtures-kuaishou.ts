// Contract fixtures derived from the public merchant SDK, not authenticated production captures.
export const kuaishouOrders = {
  result: 1,
  data: {
    total: 1,
    orderInfoList: [
      {
        orderBaseInfo: {
          oid: '90071992547409931',
          buyerId: '200',
          statusDesc: '待发货',
          noteList: [{ text: '周末配送' }],
        },
        itemAndPriceInfo: {
          itemId: '501',
          itemTitle: '快手测试水杯',
          itemPicUrl: 'https://static.yximgs.com/fixture.png',
          skuDesc: '白色',
          itemNum: 2,
          paymentInfo: { price: 2500 },
        },
      },
    ],
  },
};
export const kuaishouGoods = {
  result: 1,
  data: {
    total: 1,
    size: 1,
    itemInfo: [
      {
        itemId: '26953364011874',
        title: '快手测试水杯',
        imageUrls: ['https://static.yximgs.com/fixture.png'],
        minPrice: 2500,
        maxPrice: 2500,
        stock: 99,
        deliverDesc: '48小时发货',
      },
    ],
  },
};
export const kuaishouPageScript = String.raw`
(() => {
  const listeners = new Set();
  const f = window.__fixture = {
    signedIn: true, ready: true, sends: [], queries: [], read: [], transfers: [],
    response: { result: 1, data: { shopId: '100', userId: '101', nickname: '快手客服', shopName: '快手验收店' } },
    sendMode: 'success', seq: 1000,
    emit(message, type = 'insert', timing = 'push') { for (const cb of listeners) cb(type, [message], timing); },
    message(messageId = '9001', value = '你好', extra = {}) {
      const rawMsg = { state: 4, msgId: messageId, clientSeqId: messageId, sessionTargetId: '200', sessionTargetType: 0,
        fromUserId: '200', toUserId: '100', contentType: 0, timestampMs: Date.now(), ...extra };
      return { ...rawMsg, rawMsg, sessionId: '0_' + rawMsg.sessionTargetId, date: new Date(rawMsg.timestampMs), text: value,
        seqId: messageId, ...extra };
    },
  };
  const im = f.im = {
    isConnected: true, on: (event, cb) => listeners.add(cb), off: (event, cb) => listeners.delete(cb),
    file: { resourceUrlToHttpUrl: async () => 'https://static.yximgs.com/fixture.png' },
    getKwaiMsgConstructor: type => ({ create: args => ({
      ...args, contentType: type, state: 0, sessionId: args.targetType + '_' + args.targetId,
      sessionTargetId: args.targetId, sessionTargetType: args.targetType, rawMsg: {},
    }) }),
    sendMessage: async (m, cb) => {
      f.sends.push(m);
      Object.assign(m, { fromUserId: '100', clientSeqId: String(++f.seq), state: 1 });
      cb?.(m, 'beforeSend');
      f.emit(m, 'insert', 'update');
      if (f.sendMode === 'void') return;
      if (f.sendMode === 'pending') return new Promise(() => {});
      if (f.sendMode === 'network') throw new Error('network');
      Object.assign(m, { state: 4, msgId: String(++f.seq), date: new Date() });
      f.emit(m, 'update', 'update');
      return m;
    },
    openSession: async (type, targetId) => ({ id: type + '_' + targetId, targetId, chatTargetType: type }),
    markSessionRead: async s => { f.read.push(s.id); },
    loadMessages: async (...args) => { f.historyArgs = args; return { hasMore: false, messages: [f.message('8001', '历史咨询')] }; },
  };
  const commonRequest = {
    getGoodsListNew: async args => {
      f.queries.push({ path: '/gateway/business/cs/list/item/info', args });
      return f.goods ?? { result: 1, data: { total: 0, size: 0, itemInfo: [] } };
    },
    getOnlineCsList: async () => ({ result: 1, data: { stat: [
      { userId: '101', userName: '快手客服', onlineStatusDesc: '在线', workingSession: 2 },
      { userId: '102', userName: '售后客服', onlineStatusDesc: '在线', workingSession: 1 },
    ] } }),
    getSessionTransferGroupList: async () => ({ result: 1, data: { groupDispatch: true, groups: [
      { groupId: '301', groupName: '售后组', memberCount: 2, onlineCount: 1 },
    ] } }),
    batchTransferSessions: async args => { f.transfers.push(args); return f.transferResponse ?? { result: 1, data: args.buyerIds }; },
  };
  const sdk = f.sdk = {
    store: { state: { loginUserInfo: { userId: '101', belongShopId: '100', loginImId: '100', role: 2 } } },
    esImSdk: im, commonRequest, sessionModel: { provider: {
      getUserInfoById: targetId => ({ targetId, nickname: '快手买家', avatar: 'https://static.yximgs.com/fixture.png' }),
    } },
    imReady: () => f.ready ? Promise.resolve() : new Promise(() => {}),
    https: { post: async (path, args) => {
      f.queries.push({ path, args });
      if (path === '/rest/app/tts/cs/card/preSendCommodity') {
        return f.preCommodity ?? { result: 1, preCommodity: {
          commodity: {
            itemId: String(args.commodityId),
            itemTitle: '快手测试水杯',
            itemPrice: '¥25.00',
            itemImg: 'https://static.yximgs.com/fixture.png',
          },
          preSendButton: {},
          logParams: '',
        } };
      }
      if (path === '/gateway/business/cs/list/item/info') {
        return f.goods ?? { result: 1, data: { total: 0, size: 0, itemInfo: [] } };
      }
      return f.orders;
    } },
    messageSender: {
      sendCommodityMsg: async (args, dry) => {
        f.commodityCreates = f.commodityCreates || [];
        f.commodityCreates.push({ args, dry: !!dry });
        const m = im.getKwaiMsgConstructor(2000).create({
          targetId: args.targetId, targetType: args.targetType ?? 0, extra: args.extra, content: args.content,
        });
        if (!dry) await im.sendMessage(m);
        return m;
      },
    },
  };
  f.module = { singleton: sdk };
  const runtime = () => ({ renamed: f.module });
  runtime.m = { changedModuleId: function () { return 'singleton store commonRequest sessionModel esImSdk imReady'; } };
  f.install = () => { window.webpackChunkkwaishop_seller_cs_main = { push: chunk => chunk[2](runtime) }; };
  f.install();
  window.fetch = async () => ({ ok: true, json: async () => f.signedIn ? f.response : { result: 401, error_msg: '尚未登录' } });
})();
`;
