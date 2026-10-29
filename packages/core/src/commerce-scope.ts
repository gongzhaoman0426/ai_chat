import {
  platformSchema,
  platformContextSchema,
  type PlatformId,
} from '../../contracts/src/platform';
import type { PrismaClient } from '../../database/src';
import type { ReplyContext } from './types';
import { assert } from './util';
export type CommerceContext = Pick<
  ReplyContext,
  | 'mode'
  | 'platform'
  | 'storeId'
  | 'accountId'
  | 'conversationId'
  | 'buyerId'
  | 'capabilities'
  | 'guard'
> & { runId?: string; sessionId?: string; requestId?: string; messages?: ReplyContext['messages'] };
// Called once per execution. The database, not a tool argument or an Agent prompt,
// selects the account, platform and opaque conversation address.
export async function resolveReplyScope(db: PrismaClient, ctx: CommerceContext) {
  if (ctx.mode === 'debug')
    return {
      platform: ctx.platform ?? ('pinduoduo' as PlatformId),
      conversationKey: 'fixture',
      platformContext: {},
    };
  const [account, conversation] = await Promise.all([
    db.account.findUniqueOrThrow({ where: { id: ctx.accountId }, include: { store: true } }),
    db.conversation.findUniqueOrThrow({ where: { id: ctx.conversationId } }),
  ]);
  assert(
    account.storeId === ctx.storeId &&
      conversation.storeId === ctx.storeId &&
      conversation.accountId === ctx.accountId &&
      conversation.buyerId === ctx.buyerId,
    '当前会话、店铺、账号或买家范围不匹配',
  );
  const platform = platformSchema.parse(account.store.platform);
  assert(!ctx.platform || ctx.platform === platform, '执行平台与当前店铺不匹配');
  return {
    platform,
    conversationKey: conversation.externalKey,
    platformContext: platformContextSchema.parse(conversation.platformContext),
  };
}
