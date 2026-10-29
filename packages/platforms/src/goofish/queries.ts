import { z } from 'zod';
import {
  commerceQueryResultSchema,
  commerceQuerySchemas,
  type CommerceQueryOperation,
  type CommerceQueryResult,
} from '../../../contracts/src/commerce-tools';
import { assert } from '../../../core/src/util';
const id = z.string().regex(/^\d{1,30}$/);
const text = z.string().max(10000);
const url = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  });
const product = z
  .object({
    goodsId: id,
    title: text.optional(),
    imageUrl: url.optional(),
    priceText: text.optional(),
    description: text.optional(),
    sellerId: id.optional(),
  })
  .strict();
const order = z
  .object({
    orderSn: id,
    goodsId: id.optional(),
    productTitle: text.optional(),
    statusText: text.optional(),
    amountText: text.optional(),
    source: z.literal('current_conversation'),
    canShipWithoutLogistics: z.boolean(),
    details: z
      .array(z.object({ label: text, value: text }).strict())
      .max(80)
      .optional(),
  })
  .strict();
const dataSchemas: Partial<Record<CommerceQueryOperation, z.ZodType>> = {
  'buyer-profile': z
    .object({
      buyerId: id,
      name: text.optional(),
      avatarUrl: url.optional(),
      introduction: text.optional(),
    })
    .strict(),
  'conversation-item': z.object({ product: product.nullable(), orderSn: id.optional() }).strict(),
  goods: z
    .object({
      products: z.array(product).max(30),
      page: z.number().int(),
      pageSize: z.number().int(),
      hasMore: z.boolean().nullable(),
    })
    .strict(),
  'buyer-footprint': z
    .object({
      products: z.array(product).max(30),
      page: z.number().int(),
      pageSize: z.number().int(),
      hasMore: z.boolean().nullable(),
    })
    .strict(),
  'goods-detail': z
    .object({
      product,
      properties: z.array(z.object({ label: text, value: text }).strict()).max(80),
      propertiesAvailable: z.boolean(),
    })
    .strict(),
  'buyer-orders': z
    .object({
      orders: z.array(order).max(30),
      page: z.number().int(),
      pageSize: z.number().int(),
      hasMore: z.boolean().nullable(),
    })
    .strict(),
  'order-detail': z.object({ order }).strict(),
  'order-logistics': z
    .object({
      orderSn: id,
      records: z.array(z.object({ label: text, value: text }).strict()).max(80),
    })
    .strict(),
  history: z
    .object({
      messages: z
        .array(
          z
            .object({
              messageId: z.string().min(1).max(200),
              text,
              senderId: id,
              timestamp: z.iso.datetime(),
              kind: z.enum(['text', 'image', 'system']),
              imageUrl: url.optional(),
            })
            .strict(),
        )
        .max(50),
      nextCursor: z.string().max(100).nullable(),
      hasMore: z.boolean().nullable(),
    })
    .strict(),
};
export function normalizeGoofishQuery(
  operation: CommerceQueryOperation,
  raw: unknown,
  input: Record<string, unknown>,
  buyerId: string,
): CommerceQueryResult {
  const params = commerceQuerySchemas[operation].parse(input) as Record<string, unknown>;
  const result = commerceQueryResultSchema.parse(raw);
  assert(result.operation === operation, '闲鱼响应操作不匹配');
  const subjectId =
    operation === 'goods' ? undefined : operation === 'goods-detail' ? params.goodsId : buyerId;
  assert(result.subjectId === subjectId, '闲鱼响应不属于当前买家或商品');
  const schema = dataSchemas[operation];
  assert(schema, '闲鱼不支持此查询');
  return { ...result, data: schema.parse(result.data) as Record<string, unknown> };
}
