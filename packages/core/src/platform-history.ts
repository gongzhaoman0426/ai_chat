import { basename } from 'node:path';
import { z } from 'zod';
import { commerceQuerySchemas, type CommerceQueryResult } from '../../contracts/src/commerce-tools';
import type { PrismaClient } from '../../database/src';
import { assert } from './util';

const inputSchema = commerceQuerySchemas.history
  .extend({
    accountId: z.string().min(1).max(200),
    buyerId: z.string().min(1).max(200),
    conversationKey: z.string().min(1).max(1000),
  })
  .strict();
const note = '仅包含 JuDesk 本机已同步的消息，不能补齐千牛登录前或离线期间的记录。';

/** Read-only fallback when a platform does not expose a verified remote history API. */
export async function readLocalPlatformHistory(
  db: PrismaClient,
  raw: unknown,
): Promise<CommerceQueryResult> {
  const input = inputSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const account = await tx.account.findUnique({
      where: { id: input.accountId },
      include: { store: true },
    });
    assert(account?.store.platform === 'qianniu', '当前账号不支持此本机历史查询');
    const conversation = await tx.conversation.findFirst({
      where: {
        storeId: account.storeId,
        accountId: account.id,
        externalKey: input.conversationKey,
        buyerId: input.buyerId,
      },
    });
    assert(conversation, '历史消息会话与当前账号、买家不匹配');
    const scope = { storeId: account.storeId, conversationId: conversation.id };
    const cursor = input.cursor
      ? await tx.message.findFirst({ where: { ...scope, id: input.cursor } })
      : null;
    assert(!input.cursor || cursor, '历史消息游标已失效或不属于当前会话');
    const messages = await tx.message.findMany({
      where: {
        ...scope,
        ...(cursor
          ? {
              OR: [
                { timestamp: { lt: cursor.timestamp } },
                { timestamp: cursor.timestamp, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: input.pageSize + 1,
      select: {
        id: true,
        externalId: true,
        direction: true,
        kind: true,
        text: true,
        timestamp: true,
        withdrawn: true,
        attachmentId: true,
      },
    });
    const hasMore = messages.length > input.pageSize;
    const page = messages.slice(0, input.pageSize);
    const attachments = await tx.attachment.findMany({
      where: {
        id: {
          in: page.flatMap((message) =>
            message.attachmentId && !message.withdrawn ? [message.attachmentId] : [],
          ),
        },
        OR: [{ storeId: account.storeId }, { storeId: null }],
      },
      select: { id: true, relativePath: true },
    });
    const images = new Map(
      attachments.map((attachment) => [
        attachment.id,
        `judesk://attachment/${basename(attachment.relativePath)}`,
      ]),
    );
    return {
      operation: 'history',
      subjectId: input.buyerId,
      queriedAt: new Date().toISOString(),
      partial: true,
      failedSections: [{ section: 'remote_history', reason: note }],
      data: {
        source: 'local',
        note,
        hasMore,
        nextCursor: hasMore ? page.at(-1)!.id : '',
        messages: page.map((message) => ({
          messageId: message.externalId,
          direction: message.direction,
          kind: message.kind,
          text: message.withdrawn ? '[消息已撤回]' : message.text,
          timestamp: message.timestamp.toISOString(),
          withdrawn: message.withdrawn,
          ...(!message.withdrawn && message.attachmentId && images.has(message.attachmentId)
            ? { imageUrl: images.get(message.attachmentId) }
            : {}),
        })),
      },
    };
  });
}
