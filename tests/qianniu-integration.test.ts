import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { QianniuTransport } from '../apps/desktop/src/main/qianniu-transport';
import { QianniuHost } from '../apps/desktop/src/main/qianniu-host';
import { setup, waitFor } from './helpers';
import { WorkbenchService } from '../packages/core/src/workbench';
import { readLocalPlatformHistory } from '../packages/core/src/platform-history';
import { transferPreviewSchema, type TransferPreview } from '../packages/contracts/src/workbench';
import { uid } from '../packages/core/src/util';

it('千牛真实桥接协议通过主机适配器入库，重放去重并保留人工回复', async () => {
  const f = await setup();
  const transport = new QianniuTransport({ httpPort: 0, tcpPort: 0 });
  const notices: unknown[] = [];
  const host = new QianniuHost({
    transport,
    platform: 'win32',
    imageDirectory: join(f.dir, 'qianniu-images'),
    native: { start: async () => {}, onLogin: async () => {} },
    notify: (value) => notices.push(value),
    request: async (data) => {
      if (data.type === 'account') return f.engine.registerAccount(data.input as any);
      if (data.type === 'connection') return f.engine.updateConnection(data.input as any);
      if (data.type === 'incoming') return f.engine.ingest(data.input as any);
      if (data.type === 'call') return [];
      throw new Error(`Unexpected request ${data.type}`);
    },
  });
  let page: WebSocket | undefined;
  let hook: Socket | undefined;
  try {
    await host.restore([]);
    const port = (transport as any).http.address().port;
    const tcpPort = (transport as any).tcp.address().port;
    const source = await (await fetch(`http://127.0.0.1:${port}/qianniu-inject`)).text();
    const websocketUrl = /"websocketUrl":"([^"]+)"/.exec(source)![1];
    page = new WebSocket(websocketUrl, { origin: 'null' });
    const acks: string[] = [];
    page.on('message', (bytes) => {
      const data = JSON.parse(bytes.toString());
      if (data.type === 'ack') acks.push(data.eventKey);
    });
    await once(page, 'open');
    const loginId = '千牛集成测试店:客服';
    page.send(JSON.stringify({ type: 'hello', identity: { loginId } }));
    hook = connect(tcpPort, '127.0.0.1');
    await once(hook, 'data');
    hook.write(JSON.stringify({ username: loginId }) + '\r\n\r\n');
    await waitFor(
      async () =>
        !!(await f.db.account.findFirst({ where: { externalId: loginId, status: 'online' } })),
    );
    const account = await f.db.account.findFirstOrThrow({ where: { externalId: loginId } });
    expect(await f.db.store.findUnique({ where: { id: account.storeId } })).toMatchObject({
      platform: 'qianniu',
    });
    const send = (eventKey: string, outgoing = false) =>
      page!.send(
        JSON.stringify({
          type: 'messages',
          loginId,
          eventKey,
          data: {
            result: [
              {
                msgid: outgoing ? 'qn-human-1' : 'qn-buyer-1',
                cid: { ccode: 'qn-cid' },
                fromid: {
                  targetId: outgoing ? loginId : 'buyer',
                  nick: outgoing ? '客服' : '买家',
                },
                toid: { targetId: outgoing ? 'buyer' : loginId },
                loginid: { targetId: loginId },
                originalData: { text: outgoing ? '这是千牛人工回复' : '测试买家消息' },
                timestamp: Date.now(),
              },
            ],
            __judesk: { loginId, startedAt: Date.now() - 10000, historical: false },
          },
        }),
      );
    send('first');
    await waitFor(async () => acks.includes('first'));
    expect(await f.db.message.findFirst({ where: { storeId: account.storeId } })).toMatchObject({
      externalId: 'qn-buyer-1',
      direction: 'in',
      origin: 'buyer',
      text: '测试买家消息',
    });
    send('replay');
    send('human', true);
    await waitFor(async () => acks.includes('replay') && acks.includes('human'));
    expect(await f.db.message.count({ where: { storeId: account.storeId } })).toBe(2);
    expect(await f.db.message.findFirst({ where: { externalId: 'qn-human-1' } })).toMatchObject({
      direction: 'out',
      origin: 'human',
      text: '这是千牛人工回复',
    });
    page.close();
    await waitFor(
      async () =>
        (await f.db.account.findUnique({ where: { id: account.id } }))?.status === 'offline',
    );
    expect(notices).toEqual([]);
  } finally {
    page?.terminate();
    hook?.destroy();
    await host.close();
    await f.cleanup();
  }
});

it('千牛侧栏商品、订单、物流、历史与客服转接贯通真实 WS、适配器和服务授权', async () => {
  const f = await setup();
  const transport = new QianniuTransport({ httpPort: 0, tcpPort: 0 });
  const transferGuards = new Map<string, (preview: TransferPreview) => Promise<void>>();
  const guarded: string[] = [],
    commands: any[] = [],
    sdkCalls: any[] = [],
    notices: unknown[] = [];
  const buyerId = '220000000001',
    sellerId = '1001',
    goodsId = '90071992547409931',
    orderSn = '4900000000000000123';
  const loginId = '千牛贯通测试店:接待',
    buyerNick = '买家甲',
    encryptedBuyer = 'ENCRYPTED_BUYER_A';
  const ccode = `${buyerId}.1-${sellerId}.1#11001@cntaobao`;
  const apis = {
    contact: 'mtop.taobao.qianniu.airisland.contact.search',
    goods: 'mtop.taobao.qianniu.cs.item.search',
    orders: 'mtop.taobao.qianniu.cs.trade.query',
    logistics: 'mtop.alibaba.fulfillment.printorder.consign.logistics.query',
    staff: 'mtop.taobao.qianniu.cloudkefu.accountstatus.getbyid',
    forward: 'mtop.taobao.qianniu.cloudkefu.forward',
  };
  const host = new QianniuHost({
    transport,
    platform: 'win32',
    imageDirectory: join(f.dir, 'qianniu-images'),
    native: { start: async () => {}, onLogin: async () => {} },
    notify: (data) => notices.push(data),
    request: async (data) => {
      if (data.type === 'account') return f.engine.registerAccount(data.input as any);
      if (data.type === 'connection') return f.engine.updateConnection(data.input as any);
      if (data.type === 'incoming') return f.engine.ingest(data.input as any);
      if (data.type === 'call') return [];
      if (data.type === 'platform_local_history') return readLocalPlatformHistory(f.db, data.input);
      if (data.type === 'platform_transfer_guard') {
        const authorize = transferGuards.get(String(data.actionId));
        if (!authorize) throw new Error('转接授权已失效');
        expect(
          (await f.db.platformAction.findUniqueOrThrow({ where: { id: String(data.actionId) } }))
            .status,
        ).toBe('prepared');
        await authorize(transferPreviewSchema.parse(data.preview));
        expect(
          (await f.db.platformAction.findUniqueOrThrow({ where: { id: String(data.actionId) } }))
            .status,
        ).toBe('dispatched');
        guarded.push(String(data.actionId));
        return;
      }
      throw new Error(`Unexpected request ${data.type}`);
    },
  });
  f.host.query = (...args) => host.query(...args);
  f.host.staff = (accountId) => host.staff(accountId);
  f.host.executeTransfer = async (command, authorize) => {
    commands.push(command);
    transferGuards.set(command.id, authorize);
    try {
      return await host.executeTransfer(command);
    } finally {
      transferGuards.delete(command.id);
    }
  };
  let page: WebSocket | undefined, hook: Socket | undefined;
  try {
    await host.restore([]);
    const port = (transport as any).http.address().port,
      tcpPort = (transport as any).tcp.address().port;
    const source = await (await fetch(`http://127.0.0.1:${port}/qianniu-inject`)).text();
    page = new WebSocket(/"websocketUrl":"([^"]+)"/.exec(source)![1], { origin: 'null' });
    const acks: string[] = [];
    page.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'ack') {
        acks.push(message.eventKey);
        return;
      }
      if (message.type !== 'invoke') return;
      try {
        expect(message.loginId).toBe(loginId);
        expect(message.method).toBe('application.invokeMTopChannelService');
        const { method: api, param, version } = message.params;
        sdkCalls.push({ api, param, version });
        let data: unknown;
        if (api === apis.contact) {
          expect(param.searchQuery).toBe(buyerNick);
          data = {
            code: '0',
            data: [
              {
                accountId: buyerId,
                accountType: 3,
                nick: buyerNick,
                encryptAccountId: encryptedBuyer,
              },
            ],
          };
        } else if (api === apis.goods) {
          expect(param.encryptId).toBe(encryptedBuyer);
          data = {
            page: param.pageNo,
            pageSize: param.pageSize,
            totalCount: 1,
            data: [
              {
                itemId: goodsId,
                title: '贯通测试商品',
                pic: '//img.alicdn.com/fixture.png',
                price: '12.30',
                approveStatus: 'onsale',
                buttons: [{ code: 'sendItem', hidden: false }],
              },
            ],
          };
        } else if (api === apis.orders) {
          expect(param.securityBuyerUid).toBe(encryptedBuyer);
          data = {
            pageNum: param.pageNum,
            totalCount: 1,
            orders: [
              {
                bizOrderId: orderSn,
                buyerId,
                buyerNick,
                cardTypeText: '待发货',
                orderPrice: '12.30',
                itemList: [
                  {
                    bizOrderId: orderSn,
                    auctionId: goodsId,
                    auctionTitle: '贯通测试商品',
                    price: '12.30',
                    buyAmount: 1,
                  },
                ],
              },
            ],
          };
        } else if (api === apis.logistics) {
          expect(param.bizOrderId).toBe(orderSn);
          data = {
            logisticsInfoList: [
              {
                goodsList: [{ taobaoTradeId: orderSn }],
                logisticsDetailList: [{ time: '2026-09-26 12:00:00', desc: '订单已创建' }],
              },
            ],
            orderDetailList: [{ mainBizOrderId: orderSn }],
          };
        } else if (api === apis.staff) {
          data = {
            errorCode: 0,
            module: [
              {
                accountId: '9001',
                mainAccountId: sellerId,
                nick: '接待',
                pcOnline: true,
                suspend: false,
              },
              {
                accountId: '9002',
                mainAccountId: sellerId,
                nick: '售后',
                pcOnline: true,
                suspend: false,
              },
            ],
          };
        } else if (api === apis.forward) {
          expect(guarded).toHaveLength(1);
          expect(param).toMatchObject({
            buyerId,
            toId: '9002',
            reason: '请协助订单售后',
          });
          expect(version).toBe('3.0');
          expect(JSON.parse(param.options)).toMatchObject({
            appCid: ccode,
            buyerDomain: 'cntaobao',
            loginDomain: 'cntaobao',
          });
          data = { errorCode: 0, module: true };
        } else throw new Error(`Unexpected Qianniu SDK operation ${api}`);
        page!.send(
          JSON.stringify({
            type: 'response',
            requestId: message.requestId,
            success: true,
            data: { api, ret: ['SUCCESS::调用成功'], data },
          }),
        );
      } catch (error) {
        page!.send(
          JSON.stringify({
            type: 'response',
            requestId: message.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
    await once(page, 'open');
    page.send(JSON.stringify({ type: 'hello', identity: { loginId } }));
    hook = connect(tcpPort, '127.0.0.1');
    await once(hook, 'data');
    hook.write(JSON.stringify({ username: loginId }) + '\r\n\r\n');
    await waitFor(
      async () =>
        !!(await f.db.account.findFirst({ where: { externalId: loginId, status: 'online' } })),
    );
    const account = await f.db.account.findFirstOrThrow({ where: { externalId: loginId } });
    page.send(
      JSON.stringify({
        type: 'messages',
        loginId,
        eventKey: 'commerce-inbound',
        data: {
          result: [
            {
              msgid: 'qianniu-commerce-inbound',
              cid: { ccode },
              fromid: { targetId: buyerId, nick: buyerNick, encryptAccountId: encryptedBuyer },
              toid: { targetId: sellerId, nick: loginId },
              loginid: { targetId: sellerId, nick: loginId },
              originalData: JSON.stringify({ text: '咨询商品和订单' }),
              timestamp: Date.now(),
            },
          ],
          __judesk: { loginId, startedAt: Date.now() - 10000, historical: false },
        },
      }),
    );
    await waitFor(async () => acks.includes('commerce-inbound'));
    const incoming = await f.db.message.findFirstOrThrow({
      where: { storeId: account.storeId, externalId: 'qianniu-commerce-inbound' },
    });
    const service = new WorkbenchService(f.engine);
    const context = await service.context(incoming.conversationId);
    expect(context).toMatchObject({
      platform: 'qianniu',
      accountId: account.id,
      buyerId,
      online: true,
    });
    expect(context.operations).toEqual(
      expect.arrayContaining([
        'goods',
        'buyer-orders',
        'order-detail',
        'order-logistics',
        'history',
        'staff-list',
        'transfer-conversation',
      ]),
    );
    const goods = (await service.query(context.sessionId, 'goods', {
      page: 1,
      pageSize: 10,
    })) as any;
    expect(goods.data.products[0]).toMatchObject({
      goodsId,
      productRef: expect.stringMatching(/^product:/),
    });
    const orders = (await service.query(context.sessionId, 'buyer-orders', {
      page: 1,
      pageSize: 10,
    })) as any;
    const orderRef = orders.data.orders[0].orderRef;
    expect(orderRef).toMatch(/^order:/);
    expect(
      ((await service.query(context.sessionId, 'order-detail', { orderRef })) as any).data.order
        .orderSn,
    ).toBe(orderSn);
    expect(
      ((await service.query(context.sessionId, 'order-logistics', { orderRef })) as any).data
        .records,
    ).toContainEqual({ label: '2026-09-26 12:00:00', value: '订单已创建' });
    const history = (await service.query(context.sessionId, 'history', {
      cursor: '',
      pageSize: 20,
    })) as any;
    expect(history).toMatchObject({
      partial: true,
      data: {
        source: 'local',
        messages: [
          expect.objectContaining({
            messageId: 'qianniu-commerce-inbound',
            text: '咨询商品和订单',
          }),
        ],
      },
    });
    const staff = (await service.query(context.sessionId, 'staff-list', {})) as any;
    expect(staff.data.staff).toEqual([
      expect.objectContaining({
        id: '9002',
        name: '售后',
        staffRef: expect.stringMatching(/^staff:/),
      }),
    ]);
    const requestId = uid();
    const action = {
      sessionId: context.sessionId,
      requestId,
      operation: 'transfer-conversation' as const,
      input: { staffRef: staff.data.staff[0].staffRef, note: '请协助订单售后' },
    };
    expect(await service.action(action)).toMatchObject({ status: 'confirmed' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      accountId: account.id,
      buyerId,
      conversationKey: ccode,
      targetStaffId: '9002',
    });
    expect(guarded).toEqual([commands[0].id]);
    expect(transferGuards.size).toBe(0);
    expect(await service.action(action)).toMatchObject({ status: 'confirmed' });
    expect(sdkCalls.filter((call) => call.api === apis.forward)).toHaveLength(1);
    expect(
      await f.db.platformEvidence.count({ where: { sessionId: context.sessionId } }),
    ).toBeGreaterThanOrEqual(6);
    expect(
      (await f.db.conversation.findUniqueOrThrow({ where: { id: incoming.conversationId } }))
        .openedByHuman,
    ).toBe(true);
    expect(notices).toEqual([]);
  } finally {
    page?.terminate();
    hook?.destroy();
    await host.close();
    await f.cleanup();
  }
});
