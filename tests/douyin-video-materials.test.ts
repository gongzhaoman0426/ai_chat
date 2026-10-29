import { expect, it } from 'vitest';
import { normalizeDouyinQuery } from '../packages/platforms/src/douyin/queries';
import { douyinVideoMaterials } from './fixtures-douyin-query';

const query = (raw: unknown, page = 1) =>
  normalizeDouyinQuery('video-materials', raw, { page, pageSize: 10 }, 'buyer').data;

it('解析真实飞鸽素材响应的嵌套列表、审核状态和视频元数据，不编造播放地址', () => {
  const data = query(douyinVideoMaterials);
  expect(data).toMatchObject({
    page: 1,
    pageSize: 10,
    hasMore: false,
    folders: [],
    materials: [
      {
        kind: 'video',
        materialId: '7650740519126992135',
        title: '安装演示视频',
        videoId: 'fixture-video-id',
        width: 1440,
        height: 1080,
        duration: 7.848,
        coverUrl: 'https://p3-shop-material-center-sign.byteimg.com/fixture.jpeg?signature=fixture',
        sendable: true,
      },
    ],
  });
  expect((data.materials as any[])[0].url).toBeUndefined();
});

it('素材中心目录与分页来自 materials 内层，只返回目录时不能视为空结果', () => {
  const raw = {
    code: 0,
    data: {
      total: 0,
      materials: {
        total: 11,
        material_list: [],
        folder_list: [{ folder_id: '7650740519126992136', name: '安装教程', child_material: [] }],
      },
    },
  };
  expect(query(raw)).toMatchObject({
    materials: [],
    folders: [{ id: '7650740519126992136', name: '安装教程' }],
    hasMore: true,
  });
  expect(query(raw, 2).hasMore).toBe(false);
  expect(
    query({ code: 0, data: { materials: { total: 0, folder_list: [], material_list: [] } } }),
  ).toMatchObject({ materials: [], folders: [], hasMore: false });
});

it('素材中心拒绝访问和未识别列表不能伪装成店铺没有视频', () => {
  expect(() =>
    query({
      ...douyinVideoMaterials,
      data: {
        ...douyinVideoMaterials.data,
        permission: { has_permission: false, no_permission_msg: '请联系主账号开通素材权限' },
      },
    }),
  ).toThrow('请联系主账号开通素材权限');
  expect(() => query({ code: 0, data: { materials: {}, list: [] } })).toThrow('列表格式');
  expect(() => query({ code: -1, msg: '参数错误', data: null })).toThrow('拒绝查询');
});

it.each([1, 2, undefined])('审核状态 %s 的飞鸽素材不提供发送入口', (status) => {
  const raw = structuredClone(douyinVideoMaterials);
  Object.assign(raw.data.materials.material_list[0], {
    audit_status: status,
    audit_status_desc: '待审核或未通过',
  });
  expect((query(raw).materials as any[])[0]).toMatchObject({
    sendable: false,
    unavailableReason: '待审核或未通过',
  });
});
