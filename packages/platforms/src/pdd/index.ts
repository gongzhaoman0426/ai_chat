import { normalizeRichMessage, mediaUrl } from '../commerce-extra';
import { record } from '../shared';
import { z } from 'zod';
import type { IncomingMessage } from '../../../contracts/src/index';
// Field names are based on botsdk/PddWorkbench/Dtos/MallMessage.cs. Unknown shapes are rejected.
const actor = z
  .object({
    uid: z.union([z.string(), z.number().safe()]).transform(String),
    role: z.string(),
    name: z.string().optional(),
  })
  .passthrough();
const message = z
  .object({
    msg_id: z.union([z.string(), z.number().safe()]).transform(String),
    from: actor,
    to: actor,
    content: z.string().default(''),
    type: z.number().int(),
    ts: z.union([z.string(), z.number()]),
    nickname: z.string().optional(),
  })
  .passthrough();
export function normalizePddMessage(accountId: string, raw: unknown): IncomingMessage | null {
  const p = message.safeParse(raw);
  if (!p.success) return null;
  const m = p.data;
  if (m.type === 31) return null;
  const inbound = m.from.role === 'user';
  const outbound = m.to.role === 'user' && ['mall_cs', 'mall'].includes(m.from.role);
  if (!inbound && !outbound) return null;
  const buyer = inbound ? m.from : m.to;
  let ms = Number(m.ts);
  if (ms < 1e12) ms *= 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  let content: Record<string, unknown> = {};
  try {
    content = record(JSON.parse(m.content));
  } catch {
    /* plain text */
  }
  const videoUrl =
    content.video_url ??
    record(content.video).url ??
    (m.type !== 0 && /\.mp4(?:[?#]|$)/i.test(m.content) ? m.content : undefined);
  const rich =
    m.type !== 0 && m.type !== 1 && videoUrl && mediaUrl('pinduoduo', videoUrl)
      ? normalizeRichMessage('pinduoduo', 'video', { ...content, url: videoUrl }, m.msg_id)
      : undefined;
  const kind = rich ? 'video' : m.type === 1 ? 'image' : m.type === 0 ? 'text' : 'system';
  return {
    accountId,
    externalId: m.msg_id,
    eventKey: `message:${m.msg_id}`,
    buyerId: buyer.uid,
    buyerName: buyer.name || m.nickname || `买家 ${buyer.uid.slice(-6)}`,
    conversationKey: `buyer:${buyer.uid}`,
    direction: inbound ? 'in' : 'out',
    origin: inbound ? 'buyer' : 'human',
    kind,
    text: kind === 'video' ? '[视频消息]' : kind === 'image' ? '[图片]' : m.content,
    ...(rich ? { richContent: rich } : {}),
    ...(kind === 'image' ? { remoteImageUrl: m.content } : {}),
    timestamp: new Date(ms).toISOString(),
    raw: m,
  };
}
export const PDD_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html';
