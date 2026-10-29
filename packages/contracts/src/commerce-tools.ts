import { z } from 'zod';
import { extraQuerySchemas } from './commerce-extra';
import type { PlatformId } from './platform';

const page = z.number().int().min(1).max(100).default(1);
const pageSize = z.number().int().min(1).max(30).default(10);
const goodsId = z.string().regex(/^\d{1,30}$/, '商品 ID 必须是数字字符串');
export const commerceQuerySchemas = {
  ...extraQuerySchemas,
  'buyer-profile': z.object({}).strict(),
  'conversation-item': z.object({}).strict(),
  'order-detail': z
    .object({ orderRef: z.string().regex(/^order:[0-9a-f-]{36}:\d{1,3}$/) })
    .strict(),
  'order-logistics': z
    .object({ orderRef: z.string().regex(/^order:[0-9a-f-]{36}:\d{1,3}$/) })
    .strict(),
  goods: z.object({ page, pageSize, keyword: z.string().trim().max(100).optional() }).strict(),
  'goods-detail': z.object({ goodsId }).strict(),
  'goods-skus': z
    .object({
      goodsId,
      offset: z.number().int().min(0).max(10000).default(0),
      limit: z.number().int().min(1).max(50).default(30),
    })
    .strict(),
  'buyer-footprint': z.object({ page, pageSize }).strict(),
  history: z
    .object({
      cursor: z.string().max(100).default(''),
      pageSize: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  'buyer-orders': z
    .object({ page, pageSize, keyword: z.string().trim().max(100).optional() })
    .strict(),
};
export type CommerceQueryOperation = keyof typeof commerceQuerySchemas;
export function supportsCommerceKeywordSearch(
  platform: PlatformId | undefined,
  operation: CommerceQueryOperation,
) {
  return (
    (platform === 'douyin' && (operation === 'goods' || operation === 'buyer-orders')) ||
    (platform === 'qianniu' && operation === 'goods') ||
    (platform === 'kuaishou' && operation === 'buyer-orders')
  );
}

// The manifest describes all platforms; a running tool only exposes parameters
// supported by its current platform. Keep the shared schemas and manifest immutable.
export function commerceQuerySchemaForPlatform(
  operation: CommerceQueryOperation,
  platform: PlatformId | undefined,
) {
  if (!supportsCommerceKeywordSearch(platform, operation)) {
    if (operation === 'goods') return commerceQuerySchemas.goods.omit({ keyword: true });
    if (operation === 'buyer-orders')
      return commerceQuerySchemas['buyer-orders'].omit({ keyword: true });
  }
  return commerceQuerySchemas[operation];
}

export const commerceQueryCapability: Record<CommerceQueryOperation, string> = {
  'video-materials': 'videoMaterials',
  'order-remark-state': 'orderRemark',
  'staff-groups': 'staffGroups',
  'staff-statistics': 'staffGroups',
  'buyer-profile': 'buyerProfile',
  'conversation-item': 'goods',
  'order-detail': 'orders',
  'order-logistics': 'orders',
  goods: 'goods',
  'goods-detail': 'goods',
  'goods-skus': 'goods',
  'buyer-footprint': 'goods',
  history: 'history',
  'buyer-orders': 'orders',
};
export const commerceQueryResultSchema = z
  .object({
    operation: z.string(),
    subjectId: z.string().optional(),
    queriedAt: z.iso.datetime(),
    partial: z.boolean(),
    failedSections: z.array(z.object({ section: z.string(), reason: z.string() })),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CommerceQueryResult = z.infer<typeof commerceQueryResultSchema>;
export const commerceEvidenceResultSchema = commerceQueryResultSchema.extend({
  evidenceRef: z.string(),
  fixture: z.boolean().optional(),
});
export const orderRemarkInputSchema = z
  .object({
    orderRef: z
      .string()
      .regex(/^order:[0-9a-f-]{36}:\d{1,3}$/, '请使用当前买家订单工具返回的 orderRef'),
    note: z.string().trim().min(1).max(300),
  })
  .strict();
export const orderRemarkCommandSchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().min(1),
    buyerId: z.string().min(1).max(500),
    conversationKey: z.string().max(1000).optional(),
    platformContext: z.record(z.string(), z.unknown()).optional(),
    keyword: z.string().max(100).optional(),
    orderSn: z.string().regex(/^[0-9-]{6,80}$/),
    page,
    pageSize,
    note: z.string().trim().min(1).max(300),
  })
  .strict();
export type OrderRemarkCommand = z.infer<typeof orderRemarkCommandSchema>;
export const orderRemarkStateSchema = z
  .object({
    remark: z.string().max(10000),
    tag: z.union([z.string().max(100), z.number().int()]),
    tagName: z.string().max(100),
  })
  .strict();
export type OrderRemarkState = z.infer<typeof orderRemarkStateSchema>;
export const orderRemarkPreviewSchema = z
  .object({ before: orderRemarkStateSchema, after: orderRemarkStateSchema })
  .strict();
export type OrderRemarkPreview = z.infer<typeof orderRemarkPreviewSchema>;
export const platformActionResultSchema = z
  .object({
    status: z.enum(['confirmed', 'rejected', 'unknown']),
    reasonCode: z.string(),
    message: z.string().max(1000),
  })
  .strict();
export type PlatformActionResult = z.infer<typeof platformActionResultSchema>;
export const orderRemarkResultSchema = platformActionResultSchema.extend({
  actionId: z.string(),
  orderRef: z.string(),
  evidenceRef: z.string().optional(),
  fixture: z.boolean().optional(),
});

// Shipping is a distinct action: a note update must never accidentally dispatch an order.
export const shipmentInputSchema = z
  .object({
    orderRef: orderRemarkInputSchema.shape.orderRef,
    deliveryMode: z.literal('no_logistics'),
    note: z.string().trim().min(1).max(300),
  })
  .strict();
export const shipmentCommandSchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().min(1),
    buyerId: z.string().regex(/^\d{1,30}$/),
    orderSn: z.string().regex(/^\d{1,30}$/),
    conversationKey: z.string().min(1).max(500),
    deliveryMode: z.literal('no_logistics'),
    note: z.string().trim().min(1).max(300),
  })
  .strict();
export type ShipmentCommand = z.infer<typeof shipmentCommandSchema>;
export const shipmentPreviewSchema = z
  .object({
    orderSn: z.string().regex(/^\d{1,30}$/),
    buyerId: z.string().regex(/^\d{1,30}$/),
    sellerId: z.string().regex(/^\d{1,30}$/),
    deliveryMode: z.literal('no_logistics'),
    note: z.string().trim().min(1).max(300),
  })
  .strict();
export type ShipmentPreview = z.infer<typeof shipmentPreviewSchema>;
export const shipmentResultSchema = orderRemarkResultSchema;
