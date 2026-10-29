import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type {
  WorkbenchContext,
  WorkbenchQueryResult,
} from '../../../../../../packages/contracts/src/workbench';
export function useWorkbenchQuery(
  ctx: WorkbenchContext,
  operation: string,
  input: Record<string, unknown> = {},
  enabled = true,
) {
  return useQuery({
    queryKey: ['workbench.query', ctx.sessionId, operation, input],
    queryFn: () =>
      api<WorkbenchQueryResult>('workbench.query', { sessionId: ctx.sessionId, operation, input }),
    enabled: enabled && ctx.online && ctx.operations.includes(operation),
    retry: false,
    staleTime: operation === 'staff-list' ? 0 : 30000,
  });
}
export const object = (v: any): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : {};
export const rows = (v: any): Record<string, any>[] => (Array.isArray(v) ? v.map(object) : []);
export const money = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) ? `¥${(v / 100).toFixed(2)}` : '';
export function products(data: any) {
  const p = object(data);
  const list = [
    ...rows(p.products),
    ...rows(p.groups).flatMap((g) => rows(g.items)),
    ...(p.product ? [p.product] : []),
  ];
  return [...new Map(list.map((item) => [item.goodsId, item])).values()];
}
export const productPrice = (p: any) =>
  p.priceText ||
  money(p.groupPriceMinCents) +
    (p.groupPriceMaxCents != null && p.groupPriceMaxCents !== p.groupPriceMinCents
      ? `–${money(p.groupPriceMaxCents)}`
      : '');
export function morePages(data: any): boolean | null {
  const d = object(data);
  return d.hasMore ?? object(d.pagination).hasMore ?? null;
}
