import { afterEach, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { apiInputs, qaSchema } from '../packages/contracts/src';
import { sameKnowledgeAnswer } from '../packages/contracts/src/knowledge-rules';
import {
  decideKnowledgeReply,
  resolveKnowledgeMatches,
} from '../packages/core/src/knowledge-resolution';
import { catalogEntries, resolveKnowledgeAssist } from '../packages/core/src/knowledge-assist';
import { setup, flush } from './helpers';

let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
async function fixture() {
  f = await setup();
  const attachment = await f.engine.knowledge.attach(
    f.account.storeId,
    Buffer.from('test-png'),
    'size.png',
  );
  const qa = qaSchema.parse({
    intent: '尺码怎么选',
    answerKind: 'image',
    attachmentId: attachment.id,
    answerBefore: '请参考下面的尺码表。',
    answerAfter: '介于两个尺码之间时，建议选大一码。',
  });
  return { ...f, attachment, qa };
}

it('图片前后文保存、检索、问答助手和 ZIP 导出导入完整保留', async () => {
  const t = await fixture();
  const revision = await t.engine.knowledge.save({ storeId: t.account.storeId, qa: t.qa });
  expect(revision).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });
  const match = {
    storeId: t.account.storeId,
    entryId: revision.entryId,
    revisionId: revision.id,
    intent: t.qa.intent,
    qa: t.qa,
    score: 0.99,
  };
  expect((await resolveKnowledgeMatches(t.db, t.account.storeId, [match]))[0].qa).toMatchObject(
    t.qa,
  );
  const entries = catalogEntries(await t.engine.knowledge.list(t.account.storeId));
  expect(entries[0]).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });
  const proposed = resolveKnowledgeAssist(
    {
      reply: '保留前后说明',
      proposals: [{ action: 'update', entryId: revision.entryId, qa: t.qa }],
    },
    entries,
    t.account.storeId,
    new Set(),
  );
  expect(proposed.proposals[0].qa).toMatchObject(t.qa);
  const { answerBefore: _before, answerAfter: _after, ...imageOnly } = t.qa;
  const unrelatedEdit = resolveKnowledgeAssist(
    {
      reply: '只修改问法',
      proposals: [
        { action: 'update', entryId: revision.entryId, qa: { ...imageOnly, intent: '怎么挑尺码' } },
      ],
    },
    entries,
    t.account.storeId,
    new Set(),
  );
  expect(unrelatedEdit.proposals[0].qa).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });

  const zipPath = join(t.dir, 'qa.zip');
  t.host.saveFile = async () => zipPath;
  await t.engine.knowledge.export(t.account.storeId);
  const exported = JSON.parse(new AdmZip(await readFile(zipPath)).readAsText('manifest.json'));
  expect(exported[0]).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });
  await t.engine.knowledge.remove(revision.entryId, revision.id);
  const preview = await t.engine.knowledge.previewImport(t.account.storeId, zipPath);
  expect(preview?.rows[0].qa).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });
  expect(await t.engine.knowledge.applyImport(preview!.token, [0])).toEqual([
    { index: 0, ok: true },
  ]);
  expect((await t.engine.knowledge.list(t.account.storeId))[0].revisions[0]).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });
});

it('直答按前文、图片、后文发送且三条关联同一问题（含同步平台回显）', async () => {
  const t = await fixture();
  const revision = await t.engine.knowledge.save({ storeId: t.account.storeId, qa: t.qa });
  t.ai.matches = [
    {
      storeId: t.account.storeId,
      entryId: revision.entryId,
      revisionId: revision.id,
      intent: t.qa.intent,
      qa: t.qa,
      score: 0.99,
    },
  ];
  t.host.send = async (command) => {
    t.sends.push(command);
    await t.engine.ingest(
      t.inbound(command.text, {
        externalId: `echo-${command.id}`,
        eventKey: `echo-${command.id}`,
        direction: 'out',
        origin: 'human',
        kind: command.kind,
        attachmentId: command.kind === 'image' ? t.attachment.id : undefined,
      }),
    );
    return { status: 'confirmed', externalId: `echo-${command.id}` };
  };
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  await t.engine.ingest(t.inbound(t.qa.intent));
  await flush(t.engine, t.db);
  expect(t.sends.map((s) => [s.kind, s.text])).toEqual([
    ['text', t.qa.answerBefore],
    ['image', ''],
    ['text', t.qa.answerAfter],
  ]);
  expect(t.ai.replyCalls).toBe(0);
  const turns = await t.db.answeredTurn.findMany({ include: { answers: true } });
  expect(turns).toHaveLength(1);
  expect(turns[0].answers).toHaveLength(3);
  expect(turns[0].answers.every((answer) => answer.origin === 'qa_direct')).toBe(true);
  expect((await t.db.outboundMessage.findMany()).every((o) => o.status === 'confirmed')).toBe(true);
});

it('人工快捷图文使用同一 requestId 不重发，修改后文也不能复用发送请求', async () => {
  const t = await fixture();
  const message = await t.engine.ingest(t.inbound(t.qa.intent));
  const request = {
    conversationId: message.conversationId,
    text: t.qa.answerBefore!,
    attachmentId: t.attachment.id,
    textAfter: t.qa.answerAfter,
    requestId: 'image-text-request',
  };
  expect((await t.engine.sendManual(request)).status).toBe('confirmed');
  expect((await t.engine.sendManual(request)).status).toBe('confirmed');
  expect(t.sends.map((s) => s.kind)).toEqual(['text', 'image', 'text']);
  await expect(t.engine.sendManual({ ...request, textAfter: '改成另一个说明' })).rejects.toThrow(
    '同一发送请求不能更换',
  );
  expect(t.sends).toHaveLength(3);
});

it.each(['unknown', 'rejected'] as const)(
  '图片 %s 后停止后文，重试同请求不重发前文或图片',
  async (status) => {
    const t = await fixture();
    const message = await t.engine.ingest(t.inbound(t.qa.intent));
    t.host.send = async (command) => {
      t.sends.push(command);
      return command.kind === 'image'
        ? { status, reason: '图片未确认' }
        : { status: 'confirmed', externalId: `sent-${command.id}` };
    };
    const request = {
      conversationId: message.conversationId,
      text: t.qa.answerBefore!,
      attachmentId: t.attachment.id,
      textAfter: t.qa.answerAfter,
      requestId: `image-${status}`,
    };
    expect((await t.engine.sendManual(request)).status).toBe(status);
    expect((await t.engine.sendManual(request)).status).toBe(status);
    expect(t.sends.map((s) => s.kind)).toEqual(['text', 'image']);
    const tail = await t.db.outboundMessage.findUniqueOrThrow({
      where: { intentKey: `manual:${request.requestId}:part:2` },
    });
    expect(tail.status).toBe('cancelled');
  },
);

it('图片没有前后文字时仍只发送图片，后文可单独填写', async () => {
  const t = await fixture();
  const message = await t.engine.ingest(t.inbound());
  await t.engine.sendManual({
    conversationId: message.conversationId,
    text: '',
    attachmentId: t.attachment.id,
    requestId: 'image-only',
  });
  await t.engine.sendManual({
    conversationId: message.conversationId,
    text: '  ',
    attachmentId: t.attachment.id,
    textAfter: '后文',
    requestId: 'image-tail',
  });
  expect(t.sends.map((s) => [s.kind, s.text])).toEqual([
    ['image', ''],
    ['image', ''],
    ['text', '后文'],
  ]);
});

it('同图不同前后文不能当成相同答案直接回复；旧图片输入兼容', () => {
  const image = qaSchema.parse({ intent: '尺码', answerKind: 'image', attachmentId: 'image' });
  expect(sameKnowledgeAnswer(image, { ...image, answerBefore: '', answerAfter: '' })).toBe(true);
  expect(sameKnowledgeAnswer(image, { ...image, answerAfter: '额外条件' })).toBe(false);
  const matches = [image, { ...image, answerBefore: '另一种说明' }].map((qa, i) => ({
    storeId: 'store',
    entryId: `${i}`,
    revisionId: `${i}`,
    intent: qa.intent,
    qa,
    score: 0.99,
  }));
  expect(decideKnowledgeReply(matches, 0.9).direct).toBeUndefined();
  expect(qaSchema.safeParse({ ...image, answerAfter: 'a'.repeat(10001) }).success).toBe(false);
  expect(
    apiInputs['messages.send'].safeParse({
      conversationId: 'c',
      text: '前文',
      textAfter: '缺图片',
      requestId: 'r',
    }).success,
  ).toBe(false);
});

it('同步回显后明确人工接管时，停止发送后续图片和文字', async () => {
  const t = await fixture();
  const revision = await t.engine.knowledge.save({ storeId: t.account.storeId, qa: t.qa });
  t.ai.matches = [
    {
      storeId: t.account.storeId,
      entryId: revision.entryId,
      revisionId: revision.id,
      intent: t.qa.intent,
      qa: t.qa,
      score: 0.99,
    },
  ];
  t.host.send = async (command) => {
    t.sends.push(command);
    const echo = await t.engine.ingest(
      t.inbound(command.text, {
        externalId: `echo-${command.id}`,
        eventKey: `echo-${command.id}`,
        direction: 'out',
        origin: 'human',
        kind: command.kind,
      }),
    );
    const conversation = await t.db.conversation.findUniqueOrThrow({
      where: { id: echo.conversationId },
    });
    await t.engine.setReception(conversation.id, 'human', conversation.revision);
    return { status: 'confirmed', externalId: `echo-${command.id}` };
  };
  await t.engine.setPolicy({ storeId: t.account.storeId, autoReplyEnabled: true });
  await t.engine.ingest(t.inbound(t.qa.intent));
  await flush(t.engine, t.db);
  expect(t.sends.map((s) => s.kind)).toEqual(['text']);
  expect(await t.db.outboundMessage.count({ where: { status: 'cancelled' } })).toBe(2);
});

it('学习区分同图不同说明，候选审批后保存完整前后文字', async () => {
  const t = await fixture();
  await t.engine.knowledge.save({
    storeId: t.account.storeId,
    qa: { ...t.qa, answerAfter: '旧说明' },
  });
  await t.engine.setPolicy({ storeId: t.account.storeId, autoLearnEnabled: true });
  const message = await t.engine.ingest(t.inbound(t.qa.intent));
  await t.engine.sendManual({
    conversationId: message.conversationId,
    text: t.qa.answerBefore!,
    attachmentId: t.attachment.id,
    textAfter: t.qa.answerAfter,
    requestId: 'learn-image-text',
  });
  t.ai.result.suggestions = [{ action: 'create_qa', reason: '保留更完整的说明', qa: t.qa }];
  await flush(t.engine, t.db);
  expect(t.ai.learnCalls).toBe(1);
  expect(t.ai.learnInputs[0].knowledge[0].revisions[0]).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: '旧说明',
  });
  const candidate = await t.db.knowledgeCandidate.findFirstOrThrow();
  expect(candidate.content).toMatchObject(t.qa);
  await t.engine.knowledge.review({
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    contentHash: candidate.contentHash,
    requestId: 'approve-image-text',
    decision: 'approved',
  });
  await flush(t.engine, t.db);
  const entries = await t.engine.knowledge.list(t.account.storeId);
  expect(entries).toHaveLength(2);
  expect(entries[0].revisions[0]).toMatchObject({
    answerBefore: t.qa.answerBefore,
    answerAfter: t.qa.answerAfter,
  });
});
