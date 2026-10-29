import type { PlatformId } from './platform';
import type { Capabilities } from './index';
import { commerceQueryCapability } from './commerce-tools';
export const operationCapabilities: Record<string, string[]> = Object.fromEntries([
  ...Object.entries(commerceQueryCapability).map(([operation, capability]) => [
    operation,
    [capability],
  ]),
  ['order-remark', ['orders', 'orderRemark']],
  ['ship-order', ['orders', 'shipment']],
  ['send-product-card', ['sendProductCard', 'goods']],
  ['send-video', ['sendVideo', 'videoMaterials']],
  ['transfer-group', ['staffGroups']],
  ['invite-order', ['quickActions', 'goods']],
  ['invite-review', ['quickActions', 'orders']],
]);
const platformOperations: Record<PlatformId, string[]> = {
  qianniu: [
    'history',
    'buyer-profile',
    'goods',
    'goods-detail',
    'buyer-footprint',
    'buyer-orders',
    'order-detail',
    'order-logistics',
    'staff-groups',
    'staff-statistics',
    'transfer-group',
    'send-product-card',
    'invite-order',
  ],
  kuaishou: [
    'buyer-profile',
    'history',
    'buyer-orders',
    'goods',
    'buyer-footprint',
    'staff-groups',
    'staff-statistics',
    'transfer-group',
    'send-product-card',
  ],
  pinduoduo: [
    'goods',
    'goods-detail',
    'goods-skus',
    'buyer-footprint',
    'history',
    'buyer-orders',
    'order-remark',
    'order-remark-state',
    'video-materials',
    'send-video',
  ],
  goofish: [
    'buyer-profile',
    'conversation-item',
    'goods',
    'goods-detail',
    'buyer-footprint',
    'history',
    'buyer-orders',
    'order-detail',
    'order-logistics',
    'ship-order',
  ],
  douyin: [
    'goods',
    'goods-detail',
    'buyer-footprint',
    'history',
    'buyer-orders',
    'order-remark-state',
    'order-remark',
    'video-materials',
    'send-video',
    'send-product-card',
    'staff-groups',
    'staff-statistics',
    'transfer-group',
    'invite-order',
    'invite-review',
  ],
};
export function availableOperations(platform: PlatformId, capabilities: Capabilities) {
  return platformOperations[platform].filter(
    (op) =>
      operationCapabilities[op].every((c) => capabilities[c as keyof Capabilities] === true) &&
      (!capabilities.operations || capabilities.operations.includes(op)),
  );
}
