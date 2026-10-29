import { z } from 'zod';

export const scopedReference = (kind: string) =>
  z
    .string()
    .regex(new RegExp(`^${kind}:[0-9a-f-]{36}:\\d{1,3}$`), '请重新查询后选择当前店铺的资料');
const page = z.number().int().min(1).max(100).default(1);
const pageSize = z.number().int().min(1).max(30).default(10);
export const extraQuerySchemas = {
  'video-materials': z
    .object({
      page,
      pageSize,
      folderId: z
        .string()
        .regex(/^\d{1,30}$/)
        .optional(),
    })
    .strict(),
  'order-remark-state': z.object({ orderRef: scopedReference('order') }).strict(),
  'staff-groups': z.object({}).strict(),
  'staff-statistics': z.object({ page, pageSize }).strict(),
};
export const richActionSchemas = {
  'send-product-card': z.object({ productRef: scopedReference('product') }).strict(),
  'send-video': z.object({ materialRef: scopedReference('material') }).strict(),
  'invite-review': z.object({ orderRef: scopedReference('order') }).strict(),
};
export const richActionCapabilities = {
  'send-product-card': ['sendProductCard', 'goods'],
  'send-video': ['sendVideo', 'videoMaterials'],
  'invite-review': ['quickActions', 'orders'],
} as const;
export const quickActionSchemas = {
  'transfer-group': z
    .object({ groupRef: scopedReference('group'), note: z.string().trim().max(300).default('') })
    .strict(),
  'invite-order': z.object({ productRef: scopedReference('product') }).strict(),
};
export type QuickOperation = keyof typeof quickActionSchemas;
const httpsUrl = z
  .string()
  .url()
  .max(4000)
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password;
  }, '素材地址必须为 HTTPS');
export const richContentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('review_card'),
      orderSn: z.string().regex(/^[0-9-]{6,80}$/),
      title: z.literal('邀请评价'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('product_card'),
      goodsId: z.string().regex(/^\d{1,30}$/),
      title: z.string().max(1000),
      imageUrl: httpsUrl.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('video'),
      materialId: z.string().min(1).max(300),
      title: z.string().max(1000),
      url: httpsUrl.optional(),
      videoId: z.string().max(300).optional(),
      coverUrl: httpsUrl.optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      duration: z.number().nonnegative().optional(),
    })
    .strict(),
]);
export type RichContent = z.infer<typeof richContentSchema>;
export const richMessageOperation = (kind: RichContent['kind']) =>
  kind === 'video' ? 'send-video' : kind === 'review_card' ? 'invite-review' : 'send-product-card';
export const richMessageTarget = (value: RichContent) =>
  value.kind === 'video'
    ? value.materialId
    : value.kind === 'review_card'
      ? value.orderSn
      : value.goodsId;
export const richSendResultSchema = z.object({
  status: z.enum(['queued', 'confirmed', 'rejected', 'unknown']),
  reasonCode: z.string(),
  message: z.string(),
  outboundId: z.string().optional(),
});
export const quickCommandSchema = z
  .object({
    id: z.string().uuid(),
    operation: z.enum(['transfer-group', 'invite-order']),
    accountId: z.string().min(1),
    buyerId: z.string().min(1).max(500),
    conversationKey: z.string().min(1).max(1000),
    platformContext: z.record(z.string(), z.unknown()),
    targetId: z.string().min(1).max(300).optional(),
    note: z.string().max(300).optional(),
  })
  .strict();
export type QuickCommand = z.infer<typeof quickCommandSchema>;
export const quickPreviewSchema = quickCommandSchema.pick({
  operation: true,
  buyerId: true,
  conversationKey: true,
  targetId: true,
});
export type QuickPreview = z.infer<typeof quickPreviewSchema>;
export const humanOnlyQueries = new Set<string>(['staff-groups', 'staff-statistics']);
