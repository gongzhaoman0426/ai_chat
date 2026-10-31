import { z } from 'zod';
export const resourceKindSchema = z.enum(['agent', 'skill', 'toolkit']);
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export const storeScopeSchema = z
  .object({
    mode: z.enum(['all', 'selected']),
    storeIds: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .strict();
export type StoreScope = z.infer<typeof storeScopeSchema>;
export type ResourceScopeRecord = StoreScope & {
  kind: ResourceKind;
  resourceId: string;
  revision: number;
};
export const resourceScopeInput = storeScopeSchema.extend({
  kind: resourceKindSchema,
  resourceId: z.string().min(1).max(200),
  expectedRevision: z.number().int().min(0),
});
export function scopeAllows(scope: StoreScope | undefined | null, storeId: string) {
  return !scope || scope.mode === 'all' || scope.storeIds.includes(storeId);
}
