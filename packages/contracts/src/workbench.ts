import { z } from 'zod';
import { richActionSchemas, quickActionSchemas } from './commerce-extra';
import {
  orderRemarkInputSchema,
  shipmentInputSchema,
  type CommerceQueryResult,
} from './commerce-tools';
import type { PlatformId } from './platform';

const reference = z.string().uuid();
const session = { sessionId: reference };
export const workbenchInputs = {
  'workbench.overview': z.object({}).strict(),
  'workbench.context': z.object({ conversationId: z.string().min(1).max(200) }).strict(),
  'workbench.query': z
    .object({
      ...session,
      operation: z.string().min(1).max(60),
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  'workbench.action': z.discriminatedUnion('operation', [
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('send-product-card'),
        input: richActionSchemas['send-product-card'],
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('send-video'),
        input: richActionSchemas['send-video'],
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('transfer-group'),
        input: quickActionSchemas['transfer-group'],
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('invite-order'),
        input: quickActionSchemas['invite-order'],
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('invite-review'),
        input: richActionSchemas['invite-review'],
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('order-remark'),
        input: orderRemarkInputSchema,
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('ship-order'),
        input: shipmentInputSchema.extend({ delivered: z.literal(true) }).strict(),
      })
      .strict(),
    z
      .object({
        ...session,
        requestId: reference,
        operation: z.literal('transfer-conversation'),
        input: z
          .object({
            staffRef: z.string().regex(/^staff:[0-9a-f-]{36}:\d{1,3}$/),
            note: z.string().trim().max(300),
          })
          .strict(),
      })
      .strict(),
  ]),
  'workbench.records': z.object({ conversationId: z.string().min(1).max(200) }).strict(),
  'workbench.export': z.object({ conversationId: z.string().min(1).max(200) }).strict(),
  'workbench.review': z
    .object({ actionId: reference, note: z.string().trim().min(1).max(300) })
    .strict(),
};
export type WorkbenchActionInput = z.infer<(typeof workbenchInputs)['workbench.action']>;
export type WorkbenchContext = {
  sessionId: string;
  expiresAt: string;
  conversationId: string;
  storeId: string;
  storeName: string;
  accountId: string;
  accountName: string;
  buyerId: string;
  buyerName: string;
  platform: PlatformId;
  online: boolean;
  operations: string[];
};
export type WorkbenchQueryResult = CommerceQueryResult & { evidenceRef: string };
export const staffSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,100}$/),
    name: z.string().min(1).max(200),
    statusText: z.string().max(100).optional(),
  })
  .strict();
export type PlatformStaff = z.infer<typeof staffSchema>;
export const transferCommandSchema = z
  .object({
    id: reference,
    accountId: z.string().min(1).max(200),
    buyerId: z.string().min(1).max(200),
    conversationKey: z.string().min(1).max(1000),
    platformContext: z.record(z.string(), z.unknown()),
    targetStaffId: staffSchema.shape.id,
    note: z.string().max(300),
  })
  .strict();
export type TransferCommand = z.infer<typeof transferCommandSchema>;
export const transferPreviewSchema = z
  .object({
    buyerId: transferCommandSchema.shape.buyerId,
    conversationKey: transferCommandSchema.shape.conversationKey,
    targetStaffId: staffSchema.shape.id,
    targetName: staffSchema.shape.name,
  })
  .strict();
export type TransferPreview = z.infer<typeof transferPreviewSchema>;

// New platform capabilities register here and provide a service handler and a business UI.
// Financial operations deliberately have no callable endpoint until their contracts are available.
export const workbenchOperationNames: Record<string, string> = {
  'buyer-profile': '客户资料',
  'conversation-item': '当前咨询商品',
  goods: '店铺商品',
  'goods-detail': '商品详情',
  'goods-skus': '规格与库存',
  'buyer-footprint': '关联商品',
  history: '平台聊天历史',
  'buyer-orders': '客户订单',
  'order-detail': '订单详情',
  'order-logistics': '物流与交付',
  'order-remark': '追加订单备注',
  'ship-order': '无需物流发货',
  'staff-list': '可转接客服',
  'transfer-conversation': '转接平台客服',
  'video-materials': '视频素材',
  'send-video': '发送视频',
  'send-product-card': '发送商品卡片',
  'order-remark-state': '订单备注',
  'staff-groups': '客服分组',
  'staff-statistics': '客服接待状态',
  'transfer-group': '转接客服组',
  'invite-order': '邀请下单',
  'invite-review': '邀请评价',
  // Display legacy records only; this operation is no longer callable.
  'close-conversation': '结束平台会话',
};
