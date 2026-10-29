import { record } from '../../platforms/src/shared';
export const referenceOperations: Record<string, string[]> = {
  product: ['goods', 'goods-detail', 'buyer-footprint', 'conversation-item'],
  material: ['video-materials'],
  group: ['staff-groups'],
};
export function referenceItems(data: Record<string, unknown>, kind: string): Record<string, any>[] {
  if (kind === 'product') {
    if (Array.isArray(data.products)) return data.products.map(record);
    if (Array.isArray(data.groups))
      return data.groups.flatMap((g) => ((record(g).items as unknown[]) ?? []).map(record));
    const p = data.product ?? data.item ?? data.detail;
    if (p && typeof p === 'object') {
      const item = record(p);
      item.goodsId ??= data.goodsId;
      return [item];
    }
    return [];
  }
  const rows = data[{ material: 'materials', group: 'groups' }[kind] ?? ''];
  return Array.isArray(rows) ? rows.map(record) : [];
}
