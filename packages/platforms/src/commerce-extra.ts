import type { CommerceQueryResult } from '../../contracts/src/commerce-tools';
import type { PlatformId } from '../../contracts/src/platform';
import { richContentSchema } from '../../contracts/src/commerce-extra';
import { assert } from '../../core/src/util';
import { record } from './shared';

export function mediaUrl(platform: PlatformId, value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const u = new URL(value);
    const domains =
      platform === 'pinduoduo'
        ? ['pddpic.com', 'pddvideo.com', 'yangkeduo.com']
        : [
            'byteimg.com',
            'douyinpic.com',
            'douyincdn.com',
            'ibytedtos.com',
            'pstatp.com',
            'bytedance.com',
            'volccdn.com',
          ];
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      !domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))
    )
      return;
    u.protocol = 'https:';
    return u.href;
  } catch {
    return;
  }
}
const text = (v: unknown, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const id = (v: unknown) =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' && Number.isSafeInteger(v)
      ? String(v)
      : undefined;
const number = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const pickList = (p: unknown, keys: string[]) => {
  const rows = Array.isArray(p) ? p : keys.map((k) => record(p)[k]).find(Array.isArray);
  assert(Array.isArray(rows), '平台列表格式尚未识别，请在原平台核对，不能视为空列表');
  return rows;
};
export function normalizeRichMessage(
  platform: PlatformId,
  kind: string,
  raw: unknown,
  messageId: string,
) {
  const r = record(raw);
  const value =
    kind === 'review_card'
      ? { kind, orderSn: id(r.orderSn ?? r.order_id ?? r.data_id), title: '邀请评价' }
      : kind === 'product_card'
        ? {
            kind,
            goodsId: id(r.goodsId ?? r.goods_id ?? r.product_id),
            title: text(r.title ?? r.product_name) ?? '商品卡片',
            imageUrl: mediaUrl(platform, r.imageUrl ?? r.image_url),
          }
        : {
            kind: 'video',
            materialId: id(r.materialId ?? r.videoId ?? r.video_id) ?? messageId,
            title: text(r.title) ?? '视频消息',
            url: mediaUrl(platform, r.url ?? r.video_url ?? r.play_url),
            videoId: id(r.videoId ?? r.video_id),
            coverUrl: mediaUrl(platform, r.coverUrl ?? r.coverURL ?? r.cover_url),
            width: number(r.width),
            height: number(r.height),
            duration: number(r.duration),
          };
  const parsed = richContentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function normalizeExtraQuery(
  operation: string,
  payload: unknown,
  input: Record<string, unknown>,
  buyerId: string,
  platform: PlatformId,
): CommerceQueryResult | undefined {
  const p = record(payload);
  let pagination = p;
  let data: Record<string, unknown>;
  if (operation === 'video-materials') {
    // Feige returns { permission, materials: { total, folder_list, material_list } }.
    // The nested object is authoritative, including its pagination and empty lists.
    const nativeDouyin =
      platform === 'douyin' && Object.hasOwn(p, 'materials') && !Array.isArray(p.materials);
    if (platform === 'douyin')
      assert(
        record(p.permission).has_permission !== false,
        text(record(p.permission).no_permission_msg) || '当前抖店客服账号没有素材中心访问权限',
      );
    const source = nativeDouyin ? record(p.materials) : p;
    pagination = source;
    const rows = pickList(nativeDouyin ? source : payload, [
      'file_with_check_dtolist',
      'files',
      'file_list',
      'materials',
      'material_list',
      'items',
      'list',
      'records',
    ]);
    data = {
      materials: rows.slice(0, Number(input.pageSize)).map((raw) => {
        const r = record(raw),
          v = record(r.video_info ?? r.video ?? r.material_info ?? r);
        const materialId = id(
          r.id ?? r.file_id ?? r.material_id ?? v.video_id ?? v.videoId ?? r.url,
        );
        assert(materialId, '视频素材缺少稳定编号');
        const video = richContentSchema.parse({
          kind: 'video',
          materialId,
          title: text(r.name ?? r.file_name ?? r.title ?? r.material_name) ?? '店铺视频',
          url: mediaUrl(platform, v.url ?? v.video_url ?? r.origin_url ?? r.url ?? r.file_url),
          videoId: id(v.videoId ?? v.video_id ?? v.vid ?? r.video_id),
          coverUrl: mediaUrl(
            platform,
            v.video_cover_url ?? v.coverURL ?? v.cover_url ?? v.cover ?? r.cover_url ?? r.cover,
          ),
          width: number(v.width) || undefined,
          height: number(v.height) || undefined,
          duration: number(v.duration),
        });
        const complete =
          platform === 'pinduoduo'
            ? !!('url' in video && video.url)
            : !!(
                'videoId' in video &&
                video.videoId &&
                video.width &&
                video.height &&
                video.coverUrl &&
                video.duration != null
              );
        const approved = !nativeDouyin || r.audit_status === 3;
        return {
          ...video,
          sendable: complete && approved,
          ...(!approved
            ? { unavailableReason: text(r.audit_status_desc) || '平台尚未确认视频审核通过' }
            : {}),
        };
      }),
      folders: (nativeDouyin
        ? pickList(source, ['folder_list'])
        : Array.isArray(source.folders)
          ? source.folders
          : []
      )
        .slice(0, 100)
        .map((raw) => {
          const folder = record(raw),
            folderId = id(folder.folder_id ?? folder.id);
          assert(folderId && /^\d{1,30}$/.test(folderId), '视频素材文件夹缺少有效编号');
          return { id: folderId, name: text(folder.name) || '未命名文件夹' };
        }),
    };
  } else if (operation === 'staff-groups') {
    data = {
      groups: pickList(payload, ['group_list', 'groups', 'shop_group_list', 'list', 'items'])
        .slice(0, 100)
        .map((raw) => {
          const r = record(raw),
            groupId = id(r.group_id ?? r.groupId ?? r.id),
            name = text(r.group_name ?? r.groupName ?? r.name);
          assert(groupId && name, '客服分组缺少编号或名称');
          return { id: groupId, name, statusText: text(r.status_text ?? r.status_desc) };
        }),
    };
  } else if (operation === 'staff-statistics') {
    data = {
      staff: pickList(payload, ['staff_list', 'staff_statistics', 'list', 'items', 'records'])
        .slice(0, Number(input.pageSize))
        .map((raw) => {
          const r = record(raw);
          return {
            id: id(r.staff_id ?? r.id),
            name: text(r.staff_name ?? r.name),
            statusText: text(r.status_text ?? r.status_desc),
            activeCount: number(r.reception_count ?? r.current_reception_count),
          };
        }),
    };
  } else return;
  return {
    operation,
    queriedAt: new Date().toISOString(),
    partial: false,
    failedSections: [],
    data: {
      ...data,
      page: input.page,
      pageSize: input.pageSize,
      hasMore:
        typeof pagination.has_more === 'boolean'
          ? pagination.has_more
          : typeof pagination.hasMore === 'boolean'
            ? pagination.hasMore
            : typeof pagination.total === 'number'
              ? Number(input.page) * Number(input.pageSize) < pagination.total
              : null,
    },
  };
}
