import { capabilitiesSchema } from '../../contracts/src/index';
import { availableOperations } from '../../contracts/src/platform-operations';
import { commerceQueryResultSchema } from '../../contracts/src/commerce-tools';
import { platformSchema, platformContextSchema } from '../../contracts/src/platform';
import { record } from '../../platforms/src/shared';
import { referenceItems } from './commerce-reference';
import { assert } from './util';
import type { Engine } from './engine';

export type StoreGoodsItem = {
  goodsId: string;
  title?: string;
  imageUrl?: string;
  priceText?: string;
};
export type StoreGoodsResult = {
  products: StoreGoodsItem[];
  page: number;
  pageSize: number;
  hasMore: boolean | null;
  online: boolean;
  reason?: string;
};

const text = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;

function catalogProduct(raw: Record<string, unknown>): StoreGoodsItem | undefined {
  const goodsId = text(raw.goodsId, 200);
  if (!goodsId) return undefined;
  return {
    goodsId,
    title: text(raw.title, 200),
    imageUrl: text(raw.imageUrl, 1500),
    priceText: text(raw.priceText, 80),
  };
}

function empty(page: number, pageSize: number, online: boolean, reason: string): StoreGoodsResult {
  return { products: [], page, pageSize, hasMore: false, online, reason };
}

export async function listStoreGoods(
  engine: Engine,
  input: { storeId: string; page: number; pageSize: number; keyword?: string },
): Promise<StoreGoodsResult> {
  const { page, pageSize } = input;
  const store = await engine.db.store.findFirst({
    where: { id: input.storeId, accounts: { some: {} } },
    include: { accounts: true },
  });
  assert(store, '店铺不存在');
  const platform = platformSchema.parse(store.platform);
  const account = store.accounts.find((row) => {
    if (row.status !== 'online') return false;
    const caps = capabilitiesSchema.safeParse(row.capabilities);
    return (
      caps.success && caps.data.goods && availableOperations(platform, caps.data).includes('goods')
    );
  });
  if (!account) return empty(page, pageSize, false, '请先连接该店铺客服账号，才能勾选店铺商品');
  const conversation = await engine.db.conversation.findFirst({
    where: { storeId: store.id, accountId: account.id },
    orderBy: { updatedAt: 'desc' },
  });
  if (platform !== 'pinduoduo' && !conversation)
    return empty(page, pageSize, true, '请先在接待中心打开该店铺的会话，才能拉取店铺商品');
  const keyword =
    input.keyword && (platform === 'douyin' || platform === 'kuaishou') ? input.keyword : undefined;
  const result = commerceQueryResultSchema.parse(
    await engine.host.query(account.id, 'goods', {
      page,
      pageSize,
      ...(keyword ? { keyword } : {}),
      buyerId: conversation?.buyerId ?? '',
      ...(platform !== 'pinduoduo' && conversation
        ? {
            conversationKey: conversation.externalKey,
            platformContext: platformContextSchema.parse(conversation.platformContext),
          }
        : {}),
    }),
  );
  assert(result.operation === 'goods', '平台响应操作不匹配');
  assert(result.subjectId === undefined, '平台响应对象不匹配');
  const data = record(result.data);
  const pagination = record(data.pagination);
  const hasMore =
    typeof data.hasMore === 'boolean'
      ? data.hasMore
      : typeof pagination.hasMore === 'boolean'
        ? pagination.hasMore
        : null;
  const products = referenceItems(data, 'product')
    .map(catalogProduct)
    .filter((item): item is StoreGoodsItem => !!item);
  return { products, page, pageSize, hasMore, online: true };
}
