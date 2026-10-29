import type { IncomingMessage } from '../../../contracts/src';
import { record } from '../shared';

export const QIANNIU_HTTP_PORT = 3000;
export const QIANNIU_TCP_PORT = 9996;
export const QIANNIU_SCRIPT_PATH = '/qianniu-inject';

const identifier = (value: unknown): string =>
  typeof value === 'string' && value.trim() && value.length <= 1000
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : '';
const text = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || '';
const decoded = (value: unknown) => {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
};
const imageAddress = (value: string): string => {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.username || url.password || url.href.length > 4000) return '';
    // Older Qianniu messages use HTTP Alibaba CDN URLs, whose HTTPS variant is supported.
    if (
      url.protocol === 'http:' &&
      ['alicdn.com', 'taobaocdn.com', 'tbcdn.cn'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    )
      url.protocol = 'https:';
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
};

/** Preserve the bridge's capture metadata without changing the platform's original fields. */
export function readQianniuMessages(data: unknown): unknown[] {
  if (typeof data === 'string') {
    try {
      return readQianniuMessages(JSON.parse(data));
    } catch {
      return [];
    }
  }
  if (Array.isArray(data)) return data;
  const envelope = record(data);
  if (!Array.isArray(envelope.result)) return [];
  return envelope.result.map((message) => ({
    ...record(message),
    __judesk: record(envelope.__judesk),
  }));
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return;
    const millis = number < 1e12 ? number * 1000 : number;
    return Number.isFinite(new Date(millis).getTime()) ? millis : undefined;
  }
  if (typeof value === 'string') {
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) return millis;
  }
}

/** Unknown identity or message IDs are deliberately not converted into customer messages. */
export function normalizeQianniuMessage(
  raw: unknown,
  accountId: string,
  loginId: string,
  _eventKey: string,
): IncomingMessage | null {
  const message = record(raw);
  const from = record(message.fromid);
  const to = record(message.toid);
  const loggedIn = record(message.loginid);
  const original = decoded(message.originalData);
  const metadata = record(message.__judesk);
  // Native 9.52 Banama messages carry the server ID in mcode. clientId only
  // identifies a local pending message and must not become a durable message ID.
  const externalId = identifier(
    record(message.mcode).messageId ??
      message.msgid ??
      message.messageId ??
      message.msgId ??
      message.id,
  );
  const conversationKey = identifier(record(message.cid).ccode ?? message.ccode);
  const senderId = identifier(from.targetId);
  const recipientId = identifier(to.targetId);
  const messageLoginId = identifier(loggedIn.targetId ?? message.loginID);
  const loginNick = identifier(loggedIn.nick);
  if (!accountId || !loginId || !externalId || externalId === '0' || !conversationKey || !senderId)
    return null;
  if (metadata.loginId && metadata.loginId !== loginId) return null;
  if ((messageLoginId || loginNick) && messageLoginId !== loginId && loginNick !== loginId)
    return null;
  const matchesSeller = (endpoint: Record<string, unknown>) =>
    identifier(endpoint.targetId) === loginId ||
    identifier(endpoint.nick) === loginId ||
    (!!messageLoginId && loginNick === loginId && identifier(endpoint.targetId) === messageLoginId);
  const outgoing = matchesSeller(from) || record(message.extLocal).LocalSendMsg === 'SendByThisDev';
  // Native sends can appear before completion, with a client ID or a failed
  // status. Only the completed native state may become an outbound receipt.
  if (outgoing && typeof message.status === 'number' && message.status !== 0) return null;
  // A delayed native callback may run after the page has switched accounts. Envelope
  // provenance alone cannot prove ownership: verify the platform's message endpoints too.
  if (!outgoing && !matchesSeller(to)) return null;
  if (outgoing && !matchesSeller(from) && messageLoginId !== loginId && loginNick !== loginId)
    return null;
  const buyerId = outgoing ? recipientId : senderId;
  if (!buyerId || buyerId === loginId || buyerId.length > 200) return null;
  const timestamp = timestampOf(
    message.timestamp ?? message.time ?? message.sendTime ?? message.msgTime ?? original.timestamp,
  );
  const kindValue = String(message.msgType ?? message.type ?? original.type ?? '').toLowerCase();
  const templateId = identifier(message.templateId);
  const nativeImage = templateId === '102' || templateId === '103';
  const views = Array.isArray(original.jsview) ? original.jsview : [];
  const imageView = nativeImage ? record(record(views[0]).value) : {};
  const imageUrl = text(
    original.imageUrl,
    original.url,
    message.imageUrl,
    record(original.image).url,
    imageView.pic,
    imageView.url,
  );
  const isImage =
    nativeImage ||
    kindValue === 'image' ||
    kindValue === 'pic' ||
    !!message.imageUrl ||
    !!original.imageUrl ||
    !!record(original.image).url;
  const safeImage = imageAddress(imageUrl);
  // Banama text templates render ordered type-0 jsview fragments. Other view
  // types represent links, emoji or HTML and are not plain text fragments.
  const viewText = views
    .filter((view) => record(view).type === 0 || record(view).type === '0')
    .map((view) => text(record(record(view).value).text))
    .join('');
  const content = text(
    original.text,
    viewText,
    message.summary,
    message.text,
    message.content,
    message.msg,
  );
  const item = record(original.item);
  const goodsId = identifier(original.itemId ?? item.itemId);
  const isProduct =
    ['product_card', 'item', 'goods'].includes(kindValue) && /^\d{1,30}$/.test(goodsId);
  const productTitle = text(original.title, item.title, message.summary).slice(0, 1000);
  const productImage = imageAddress(text(original.pic, item.pic, original.imageUrl));
  const isSystem =
    templateId === '106' ||
    kindValue === 'system' ||
    kindValue === 'notification' ||
    message.isSystem === true ||
    (!isImage && !isProduct && !content);
  const kind = isSystem ? 'system' : isProduct ? 'product_card' : isImage ? 'image' : 'text';
  const startedAt = typeof metadata.startedAt === 'number' ? metadata.startedAt : undefined;
  // The bridge observes GetNewMsg, but some clients do not emit ReceiveNewMsg for the
  // seller's own sends. Fresh, identity-verified outbound messages still need receipts
  // and human-takeover handling; initial backlog and explicit history remain historical.
  const freshOutgoing =
    outgoing &&
    metadata.loginId === loginId &&
    startedAt !== undefined &&
    timestamp !== undefined &&
    timestamp >= startedAt;
  const buyer = outgoing ? to : from;
  const buyerNick = text(buyer.nick).trim();
  const encryptedBuyer = identifier(buyer.encryptAccountId);
  const sellerId =
    /^\d{1,30}$/.test(messageLoginId) && loginNick === loginId ? messageLoginId : undefined;
  return {
    accountId,
    externalId,
    eventKey: `message:${externalId}`,
    conversationKey,
    buyerId,
    buyerName: text((outgoing ? to : from).nick) || buyerId,
    direction: outgoing ? 'out' : 'in',
    origin: isSystem ? 'unknown' : outgoing ? 'human' : 'buyer',
    kind,
    text:
      content.slice(0, 50000) ||
      (isProduct ? `[商品] ${productTitle || goodsId}` : isImage ? '[图片]' : '[千牛系统消息]'),
    ...(kind === 'product_card'
      ? {
          richContent: {
            kind: 'product_card' as const,
            goodsId,
            title: productTitle || goodsId,
            ...(productImage ? { imageUrl: productImage } : {}),
          },
        }
      : {}),
    timestamp: new Date(timestamp ?? Date.now()).toISOString(),
    // Missing timestamps or capture provenance must never trigger a reply to backlog.
    historical:
      message.historical === true ||
      message.isHistory === true ||
      (metadata.historical !== false && !freshOutgoing) ||
      timestamp === undefined ||
      (startedAt !== undefined && timestamp < startedAt),
    withdrawn: message.withdrawn === true || message.isRecall === true,
    ...(kind === 'image' && safeImage ? { remoteImageUrl: safeImage } : {}),
    platformContext: {
      userId: buyerId,
      securityConversationId: conversationKey,
      ...(buyerNick && buyerNick.length <= 200 ? { buyerNick } : {}),
      ...(encryptedBuyer && encryptedBuyer.length <= 500 ? { securityUserId: encryptedBuyer } : {}),
      ...(sellerId ? { sellerId } : {}),
    },
    raw,
  };
}
