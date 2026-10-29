import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';
import { apiInputs, platformsForRuntime, type QianniuSetupState } from '../packages/contracts/src';
import { client } from '../apps/desktop/src/renderer/api';
import { QianniuSetup } from '../apps/desktop/src/renderer/components/qianniu-setup';
import { normalizeQianniuMessage, readQianniuMessages } from '../packages/platforms/src/qianniu';

afterEach(() => client.clear());
const state: QianniuSetupState = {
  supported: true,
  downloadUrl: '',
  executablePath: null,
  phase: 'not_configured',
  message: '点击启动千牛。',
  scriptUrl: 'http://127.0.0.1:3000/qianniu-inject',
  tcpPort: 9996,
  accounts: [],
};
function render(runtimePlatform: string, value = state) {
  client.setQueryData(['app.state', {}], { runtimePlatform });
  client.setQueryData(['qianniu.status', {}], value);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(QianniuSetup)),
  );
}
describe('千牛平台入口', () => {
  it('Windows 显示引导；macOS、Linux 和未知系统隐藏入口', () => {
    expect(platformsForRuntime('win32')).toContain('qianniu');
    for (const platform of ['darwin', 'linux', '']) {
      expect(platformsForRuntime(platform)).not.toContain('qianniu');
      expect(render(platform)).toBe('');
    }
    expect(render('win32')).toContain('登录后自动连接');
  });
  it('未配置下载地址时禁用下载，仍可直接启动；流程无需选择文件或手动注入', () => {
    const html = render('win32');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?下载千牛客户端/);
    expect(html).toContain('下载地址尚未配置');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>[\s\S]*?启动千牛/);
    expect(html).not.toContain('选择客户端');
    expect(html).not.toContain('AliWorkbench.exe');
    expect(html).not.toContain('注入 Hook');
    expect(html).not.toContain('重新连接消息');
  });
  it('已配置下载地址时允许静默下载', () => {
    const html = render('win32', {
      ...state,
      downloadUrl: 'https://updates.quantaflow.one/qianniu.zip',
    });
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>[\s\S]*?下载千牛客户端/);
    expect(html).toContain('静默下载并解压');
    expect(html).not.toContain('下载地址尚未配置');
  });
  it('连接后显示验收和接待设置引导，错误时允许恢复连接', () => {
    expect(render('win32', { ...state, phase: 'connected' })).toContain('请先验收消息收发');
    const html = render('win32', {
      ...state,
      phase: 'error',
      accounts: [{ loginId: '客服', websocket: true, tcp: false }],
    });
    expect(html).toContain('重新连接消息');
  });
  it('桌面能力不接受调用方任意传入可执行文件、下载地址或进程 ID', () => {
    for (const method of [
      'qianniu.launch',
      'qianniu.addAccount',
      'qianniu.download',
      'qianniu.retryHook',
    ] as const) {
      expect(apiInputs[method].safeParse({}).success).toBe(true);
      expect(
        apiInputs[method].safeParse({ pid: 123, url: 'http://example.com', file: 'cmd.exe' })
          .success,
      ).toBe(false);
    }
  });
  it('一家店铺在线时仍可登录其他店铺，并显示每个账号的连接状态和重连入口', () => {
    const html = render('win32', {
      ...state,
      phase: 'connected',
      accounts: [
        { loginId: '店铺甲:客服', websocket: true, tcp: true },
        { loginId: '店铺乙:客服', websocket: true, tcp: false },
        { loginId: '店铺丙', websocket: false, tcp: false },
      ],
    });
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>[\s\S]*?登录其他店铺/);
    expect(html).toContain('已连接 1 个账号');
    expect(html).toContain('店铺甲:客服');
    expect(html).toContain('店铺乙:客服');
    expect(html).toContain('店铺丙');
    expect(html).toContain('消息连接待完成');
    expect(html).toContain('已离线');
    expect(html).toContain('重新连接消息');
  });
});

describe('千牛 9.52 原始消息', () => {
  const loginId = '测试店铺:客服';
  const sellerId = '1001';
  // Shape from webui.zip recent/index.js Banama parsing and text rendering.
  const nativeMessage = {
    mcode: { messageId: '4200000000000000123', clientId: 'local-message-1' },
    cid: { ccode: '220000000001.1-1001.1#11001@cntaobao' },
    fromid: { targetId: '220000000001', nick: '测试买家' },
    toid: { targetId: sellerId, nick: loginId },
    loginid: { targetId: sellerId, nick: loginId },
    sendTime: 1900000000000,
    templateId: 101,
    originalData: {
      jsview: [
        { type: 0, value: { text: '客户' } },
        { type: 0, value: { text: '测试文本' } },
      ],
    },
  };
  const capture = (raw: unknown = nativeMessage, capturedLogin = loginId) =>
    readQianniuMessages(
      JSON.stringify({
        result: [raw],
        __judesk: { loginId: capturedLogin, startedAt: 1800000000000, historical: false },
      }),
    )[0];

  it.each([false, true])(
    'imports native mcode IDs and jsview customer text when originalData is serialized: %s',
    (serialized) => {
      const raw = {
        ...nativeMessage,
        originalData: serialized
          ? JSON.stringify(nativeMessage.originalData)
          : nativeMessage.originalData,
      };
      expect(normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery')).toMatchObject({
        externalId: '4200000000000000123',
        eventKey: 'message:4200000000000000123',
        conversationKey: nativeMessage.cid.ccode,
        buyerId: '220000000001',
        direction: 'in',
        origin: 'buyer',
        kind: 'text',
        text: '客户测试文本',
        historical: false,
        timestamp: new Date(nativeMessage.sendTime).toISOString(),
        platformContext: { sellerId },
      });
    },
  );

  it('keeps a customer message incoming when selfState reports that the seller has read it', () => {
    const raw = {
      ...nativeMessage,
      selfState: 1,
      toid: { targetId: 1001 },
      loginid: { targetId: 1001, nick: loginId },
    };
    expect(normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery')).toMatchObject({
      buyerId: '220000000001',
      direction: 'in',
      origin: 'buyer',
      platformContext: { sellerId: '1001' },
    });
  });

  it('uses server IDs independently of client IDs and bridge replay deliveries', () => {
    const first = normalizeQianniuMessage(capture(), 'account', loginId, 'delivery-a');
    const replay = normalizeQianniuMessage(capture(), 'account', loginId, 'delivery-b');
    const other = normalizeQianniuMessage(
      capture({
        ...nativeMessage,
        mcode: { ...nativeMessage.mcode, messageId: '4200000000000000124' },
      }),
      'account',
      loginId,
      'delivery-c',
    );
    expect(first?.eventKey).toBe(replay?.eventKey);
    expect(first?.eventKey).not.toBe(other?.eventKey);
    expect(other?.externalId).toBe('4200000000000000124');
  });

  it.each([undefined, '0'])('rejects a client-only message with server ID %s', (messageId) => {
    const raw = { ...nativeMessage, mcode: { messageId, clientId: 'local-message-1' } };
    expect(normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery')).toBeNull();
  });

  it.each([1, 13])(
    'does not turn an incomplete or failed outgoing native status %i into a receipt',
    (status) => {
      const raw = {
        ...nativeMessage,
        fromid: nativeMessage.toid,
        toid: nativeMessage.fromid,
        status,
      };
      expect(normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery')).toBeNull();
      expect(
        normalizeQianniuMessage(capture({ ...raw, status: 0 }), 'account', loginId, 'delivery'),
      ).toMatchObject({ direction: 'out', externalId: nativeMessage.mcode.messageId });
    },
  );

  it('retains account and endpoint verification for native messages from another subaccount', () => {
    const otherLogin = '测试店铺:售后';
    expect(
      normalizeQianniuMessage(capture(nativeMessage, otherLogin), 'other', otherLogin, 'delivery'),
    ).toBeNull();
    expect(
      normalizeQianniuMessage(
        capture({ ...nativeMessage, loginid: { targetId: sellerId, nick: otherLogin } }),
        'account',
        loginId,
        'delivery',
      ),
    ).toBeNull();
    expect(
      normalizeQianniuMessage(
        capture({ ...nativeMessage, toid: { targetId: '2002', nick: otherLogin } }),
        'account',
        loginId,
        'delivery',
      ),
    ).toBeNull();
  });

  it.each([102, 103])('reads a native image template %i from its jsview picture', (templateId) => {
    const raw = {
      ...nativeMessage,
      templateId,
      originalData: { jsview: [{ value: { pic: '//img.alicdn.com/native-picture.png' } }] },
    };
    expect(normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery')).toMatchObject({
      kind: 'image',
      remoteImageUrl: 'https://img.alicdn.com/native-picture.png',
    });
  });

  it('does not turn an emoji URL inside a text template into a customer image', () => {
    const raw = {
      ...nativeMessage,
      originalData: {
        jsview: [
          ...nativeMessage.originalData.jsview,
          { type: 2, value: { pic: 'https://img.alicdn.com/emoji.png' } },
        ],
      },
    };
    const message = normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery');
    expect(message).toMatchObject({ kind: 'text', text: '客户测试文本' });
    expect(message?.remoteImageUrl).toBeUndefined();
  });

  it('preserves the native system template instead of treating its text as a customer request', () => {
    const raw = { ...nativeMessage, templateId: 106 };
    expect(normalizeQianniuMessage(capture(raw), 'account', loginId, 'delivery')).toMatchObject({
      kind: 'system',
      origin: 'unknown',
    });
  });
});
