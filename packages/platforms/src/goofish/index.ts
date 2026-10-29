import { z } from 'zod';
import type { IncomingMessage } from '../../../contracts/src';
import { platformContextSchema } from '../../../contracts/src/platform';
export const GOOFISH_URL = 'https://www.goofish.com/im';
const numericId = z.string().regex(/^\d{1,30}$/);
export const goofishMessageSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    conversationId: numericId,
    buyerId: numericId,
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
export function normalizeGoofishMessage(accountId: string, raw: unknown): IncomingMessage | null {
  const parsed = goofishMessageSchema.safeParse(raw);
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
    raw: m,
  };
}
