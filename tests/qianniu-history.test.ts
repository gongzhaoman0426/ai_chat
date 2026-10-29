import { afterEach, expect, it } from 'vitest';
import { disabledCapabilities } from '../packages/contracts/src';
import { readLocalPlatformHistory } from '../packages/core/src/platform-history';
import { setup } from './helpers';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
async function historyFixture() {
  const f = (fixture = await setup());
  const account = await f.engine.registerAccount({
    platform: 'qianniu',
    partition: 'qianniu:history-test',
    mallId: 'qn-shop',
    mallName: '千牛测试店',
    externalId: 'qn-seller',
    name: '千牛客服',
    capabilities: { ...disabledCapabilities, receive: true, sendText: true, history: true },
  });
  for (let i = 0; i < 3; i++)
    await f.engine.ingest(
      f.inbound(`已同步消息 ${i}`, {
        accountId: account.id,
        externalId: `qn-history-${i}`,
        conversationKey: 'qn-history-conversation',
        buyerId: 'qn-buyer',
        timestamp: new Date(1800000000000 + i * 1000).toISOString(),
        historical: true,
      }),
    );
  const input = {
    accountId: account.id,
    buyerId: 'qn-buyer',
    conversationKey: 'qn-history-conversation',
    cursor: '',
    pageSize: 2,
  };
  return { ...f, qnAccount: account, input };
}
it('本机历史明确标明范围，按稳定游标翻页且不会触发回复或写入重复消息', async () => {
  const f = await historyFixture();
  const before = await f.db.job.count();
  const result = await readLocalPlatformHistory(f.db, f.input);
  expect(result).toMatchObject({
    operation: 'history',
    subjectId: 'qn-buyer',
    partial: true,
    data: { source: 'local', hasMore: true },
  });
  expect(result.failedSections[0].reason).toContain('不能补齐');
  expect((result.data.messages as any[]).map((message) => message.messageId)).toEqual([
    'qn-history-2',
    'qn-history-1',
  ]);
  const next = await readLocalPlatformHistory(f.db, { ...f.input, cursor: result.data.nextCursor });
  expect(next.data).toMatchObject({
    hasMore: false,
    nextCursor: '',
    messages: [{ messageId: 'qn-history-0' }],
  });
  expect(await f.db.message.count({ where: { storeId: f.qnAccount.storeId } })).toBe(3);
  expect(await f.db.job.count()).toBe(before);
});
it('拒绝跨买家、跨会话游标和已切换接待账号的历史访问', async () => {
  const f = await historyFixture();
  const other = await f.engine.ingest(
    f.inbound('其他客户秘密', {
      accountId: f.qnAccount.id,
      buyerId: 'other',
      conversationKey: 'other-conversation',
      historical: true,
    }),
  );
  await expect(readLocalPlatformHistory(f.db, { ...f.input, buyerId: 'other' })).rejects.toThrow(
    '不匹配',
  );
  await expect(readLocalPlatformHistory(f.db, { ...f.input, cursor: other.id })).rejects.toThrow(
    '游标',
  );
  await expect(
    readLocalPlatformHistory(f.db, { ...f.input, accountId: f.account.id }),
  ).rejects.toThrow('不支持');
  const c = await f.db.conversation.findFirstOrThrow({
    where: { externalKey: f.input.conversationKey },
  });
  await f.db.conversation.update({
    where: { id: c.id },
    data: { accountId: 'moved-to-another-account' },
  });
  await expect(readLocalPlatformHistory(f.db, f.input)).rejects.toThrow('不匹配');
});
it('撤回消息不向历史查询泄漏原文或图片', async () => {
  const f = await historyFixture();
  await f.db.message.update({
    where: { storeId_externalId: { storeId: f.qnAccount.storeId, externalId: 'qn-history-2' } },
    data: { withdrawn: true, text: '已撤回的原文', attachmentId: 'unused' },
  });
  const result = await readLocalPlatformHistory(f.db, f.input);
  expect((result.data.messages as any[])[0]).toMatchObject({
    withdrawn: true,
    text: '[消息已撤回]',
  });
  expect(JSON.stringify(result)).not.toContain('已撤回的原文');
  expect((result.data.messages as any[])[0].imageUrl).toBeUndefined();
});
