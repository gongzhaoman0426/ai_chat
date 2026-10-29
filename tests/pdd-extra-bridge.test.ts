import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { normalizePddQuery } from '../packages/platforms/src/pdd/queries';
const source = await readFile('resources/pdd-bridge.js', 'utf8');
function fixture(response: any = { success: true, result: {} }) {
  const fetch = vi.fn(async () => ({
    ok: true,
    headers: new Headers(),
    text: async () => JSON.stringify(response),
  }));
  const window: any = {};
  runInNewContext(source, {
    window,
    document: { getElementById: () => null },
    fetch,
    Headers,
    AbortSignal,
    URL,
    setTimeout,
    clearTimeout,
  });
  const bridge = window.__judeskBridge;
  bridge.identity = async () => ({ externalId: 'cs', mallId: 'shop' });
  return { bridge, fetch };
}
it('拼多多已读与视频素材请求固定端点，并带当前买家或审核通过筛选', async () => {
  const f = fixture();
  await f.bridge.markRead({ buyerId: '123456' });
  expect(f.fetch.mock.calls[0]).toMatchObject([
    'https://mms.pinduoduo.com/plateau/chat/mark_read',
    { credentials: 'include' },
  ]);
  expect(JSON.parse((f.fetch.mock.calls[0] as any)[1].body)).toEqual({
    client: 'web',
    data: { cmd: 'mark_read', conversation: { uid: '123456' } },
  });
  await f.bridge.query('video-materials', { page: 2, pageSize: 10 });
  expect(JSON.parse((f.fetch.mock.calls[1] as any)[1].body)).toEqual({
    page: 2,
    page_size: 10,
    order_by: 'create_time desc',
    check_status_list: [2],
    file_type_desc: 'video',
  });
});
it.each([
  { success: true, result: { msg_id: 'video-message' } },
  { success: true, error_code: 1000000, result: { msg_id: 'video-message' } },
  { success: true, result: {} },
  { success: false, error_code: 99 },
])('视频发送只认消息回执 %j，重复命令不重复提交', async (response) => {
  const f = fixture(response);
  const command = {
    id: 'video-send',
    buyerId: '123456',
    kind: 'video',
    richContent: {
      kind: 'video',
      materialId: '1',
      title: '教程',
      url: 'https://video.pddpic.com/a.mp4',
    },
  };
  const result = await f.bridge.send(command);
  expect(result.status).toBe(
    response.success ? ('msg_id' in (response.result ?? {}) ? 'confirmed' : 'unknown') : 'rejected',
  );
  await f.bridge.send(command);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it.each([1000000, '1000000'])(
  '真实素材接口成功码 %s 和 file_with_check_dtolist 正常解析，不误报业务失败',
  (error_code) => {
    const raw = {
      success: true,
      error_code,
      error_msg: null,
      result: { total: 0, file_with_check_dtolist: [] },
    };
    expect(normalizePddQuery('video-materials', raw, {}, 'buyer').data).toMatchObject({
      materials: [],
    });
    expect(() => normalizePddQuery('history', raw, {}, 'buyer')).toThrow('拼多多拒绝查询');
  },
);
it('素材成功响应依然检查列表结构，并保留平台明确错误', () => {
  const raw = {
    success: true,
    error_code: 1000000,
    result: {
      total: 1,
      file_with_check_dtolist: [
        { file_id: 1, file_name: '安装教程', file_url: 'https://video.pddpic.com/demo.mp4' },
      ],
    },
  };
  expect(normalizePddQuery('video-materials', raw, {}, 'buyer').data).toMatchObject({
    materials: [{ materialId: '1', title: '安装教程', sendable: true }],
  });
  for (const invalid of [
    { ...raw, success: false },
    { ...raw, error_code: 403 },
    { ...raw, errorCode: 403 },
  ])
    expect(() => normalizePddQuery('video-materials', invalid, {}, 'buyer')).toThrow(
      '拼多多拒绝查询',
    );
  expect(() =>
    normalizePddQuery('video-materials', { ...raw, result: { total: 0 } }, {}, 'buyer'),
  ).toThrow('平台列表格式尚未识别');
});
it('不把任意外部地址作为拼多多视频素材发送', async () => {
  const f = fixture();
  expect(
    await f.bridge.send({
      id: 'bad',
      buyerId: '123456',
      kind: 'video',
      richContent: { kind: 'video', url: 'https://example.org/a.mp4' },
    }),
  ).toMatchObject({ status: 'rejected' });
  expect(f.fetch).not.toHaveBeenCalled();
});
