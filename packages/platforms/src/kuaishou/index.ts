import { z } from 'zod';
import { platformContextSchema, type IncomingMessage } from '../../../contracts/src';
export const KUAISHOU_URL = 'https://im.kwaixiaodian.com/';
export const KUAISHOU_LOGIN_URL = `https://login.kwaixiaodian.com/?biz=zone&redirect_url=${encodeURIComponent(KUAISHOU_URL)}`;
export const kuaishouMessageSchema = z
  .object({
    messageId: z.string().regex(/^\d{1,30}$/),
    conversationId: z.string().regex(/^0_\d{1,30}$/),
    buyerId: z.string().regex(/^\d{1,30}$/),
    buyerName: z.string().max(200),
    direction: z.enum(['in', 'out']),
    kind: z.enum(['text', 'image', 'system']),
    text: z.string().max(50000),
    timestamp: z.iso.datetime(),
    imageUrl: z.url().optional(),
    platformContext: platformContextSchema,
    historical: z.boolean(),
    withdrawn: z.boolean().optional(),
  })
  .strict();
export function normalizeKuaishouMessage(accountId: string, raw: unknown): IncomingMessage | null {
  const parsed = kuaishouMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  if (
    m.conversationId !== `0_${m.buyerId}` ||
    m.platformContext.sessionType !== 0 ||
    m.platformContext.userId !== m.buyerId ||
    !m.platformContext.sellerId
  )
    return null;
  return {
    accountId,
    externalId: m.messageId,
    eventKey: `message:${m.messageId}`,
    conversationKey: m.conversationId,
    buyerId: m.buyerId,
    buyerName: m.buyerName || `买家 ${m.buyerId.slice(-6)}`,
    direction: m.direction,
    origin: m.kind === 'system' ? 'unknown' : m.direction === 'in' ? 'buyer' : 'human',
    kind: m.kind,
    text: m.text,
    timestamp: m.timestamp,
    platformContext: m.platformContext,
    historical: m.historical,
    withdrawn: m.withdrawn,
    ...(m.imageUrl ? { remoteImageUrl: m.imageUrl } : {}),
    raw: m,
  };
}
