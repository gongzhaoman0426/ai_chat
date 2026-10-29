import { normalizeRichMessage } from '../commerce-extra';
import { z } from 'zod';
import { platformContextSchema, type IncomingMessage } from '../../../contracts/src/index';
export const DOUYIN_URL = 'https://im.jinritemai.com/pc_seller_v2/';
export const DOUYIN_LOGIN_URL = 'https://fxg.jinritemai.com/login';
// The injected bridge translates SDK variants into this strict boundary. Unknown events
// never acquire a random ID, an inferred buyer, or a reconstructed conversation ID.
export const douyinMessageSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(1000),
    buyerId: z.string().min(1).max(500),
    buyerName: z.string().max(200),
    direction: z.enum(['in', 'out']),
    kind: z.enum(['text', 'image', 'system', 'video', 'product_card', 'review_card']),
    richContent: z.unknown().optional(),
    text: z.string().max(50000),
    timestamp: z.iso.datetime(),
    imageUrl: z.string().max(3000).optional(),
    platformContext: platformContextSchema,
    historical: z.boolean().optional(),
    withdrawn: z.boolean().optional(),
  })
  .strict();
export function normalizeDouyinMessage(accountId: string, raw: unknown): IncomingMessage | null {
  const parsed = douyinMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  return {
    accountId,
    externalId: m.messageId,
    eventKey: `message:${m.messageId}`,
    conversationKey: m.conversationId,
    buyerId: m.buyerId,
    buyerName: m.buyerName || `买家 ${m.buyerId.slice(-6)}`,
    direction: m.direction,
    origin: m.direction === 'in' ? 'buyer' : 'human',
    kind: m.kind,
    text: m.text,
    timestamp: m.timestamp,
    platformContext: m.platformContext,
    historical: m.historical,
    withdrawn: m.withdrawn,
    ...(m.imageUrl ? { remoteImageUrl: m.imageUrl } : {}),
    ...(m.kind === 'video' || m.kind === 'product_card' || m.kind === 'review_card'
      ? { richContent: normalizeRichMessage('douyin', m.kind, m.richContent, m.messageId) }
      : {}),
    raw: m,
  };
}
