import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { MastraAi } from '../packages/ai/src/index';
import { Engine } from '../packages/core/src/engine';
import { setup, flush } from './helpers';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let runtime: Engine | undefined;
let server: Server | undefined;
afterEach(async () => {
  await runtime?.stop();
  await ai?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await fixture?.cleanup();
  fixture = undefined;
  ai = undefined;
  runtime = undefined;
  server = undefined;
});

type Mode =
  | 'json'
  | 'fenced'
  | 'reasoning-only'
  | 'truncated-json'
  | 'empty'
  | 'prose'
  | 'invalid'
  | 'array'
  | 'fake-evidence'
  | 'short-refs'
  | 'mixed-evidence';
async function init(mode: Mode = 'json') {
  fixture = await setup();
  const f = fixture;
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const user = body.messages.find((message: any) => message.role === 'user');
    const text =
      typeof user.content === 'string'
        ? user.content
        : user.content.find((part: any) => part.type === 'text').text;
    const input = JSON.parse(text);
    const value = {
      matchVerdict: 'not_applicable',
      replyVerdict: 'reasonable',
      reuseVerdict: 'reusable',
      reason: '人工实际回复可沉淀，仍待人工审批',
      evidenceIds: [input.questions.at(-1).id, input.answers[0].message.id],
      suggestions: [
        {
          action: 'create_qa',
          reason: '发货规则可复用',
          qa: {
            intent: '现货多久发货',
            answerKind: 'text',
            answer: '现货付款后 48 小时内发出。',
            scope: { productIds: [], conditions: '' },
          },
        },
      ],
    };
    let content = JSON.stringify(value);
    if (mode === 'fake-evidence')
      content = JSON.stringify({ ...value, evidenceIds: ['not-in-this-turn'] });
    if (mode === 'short-refs')
      content = JSON.stringify({
        ...value,
        evidenceIds: [
          input.questions.at(-1).evidenceRef,
          input.answers[0].message.evidenceRef,
          input.answers[0].message.id,
        ],
      });
    if (mode === 'mixed-evidence')
      content = JSON.stringify({
        ...value,
        evidenceIds: [input.questions.at(-1).evidenceRef, 'E999999'],
      });
    if (mode === 'fenced') content = '```json\n' + content + '\n```';
    if (mode === 'reasoning-only' || mode === 'empty') content = '';
    if (mode === 'prose') content = '这轮回答合理，我建议保存为问答对。';
    if (mode === 'invalid') content = JSON.stringify({ reason: '缺少评估字段' });
    if (mode === 'array') content = '[]';
    const truncated = mode === 'reasoning-only' || mode === 'truncated-json';
    const usage = {
      prompt_tokens: 50,
      completion_tokens: truncated ? 2048 : 300,
      total_tokens: truncated ? 2098 : 350,
      completion_tokens_details: { reasoning_tokens: truncated ? 2048 : 20 },
    };
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'learning-fixture',
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
                reasoning_content: '不应读取或当成评估结果的内部推理',
              },
              finish_reason: truncated ? 'length' : 'stop',
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content,
              reasoning_content: '不应读取或当成评估结果的内部推理',
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }], usage },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'learning-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            ...chunk,
          }) +
          '\n\n',
      );
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: {
      model: 'glm-5.3-flash',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      maxTokens: 2048,
    },
  });
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  runtime = new Engine(f.db, f.dir, f.host, ai);
  return { ...f, ai, runtime, requests };
}
const source = {
  questions: [{ id: 'question', text: '现货多久发货' }],
  answers: [{ message: { id: 'answer', text: '现货付款后 48 小时内发出。' } }],
};

it.each(['json', 'fenced'] as const)(
  '学习单次生成完整 %s，GLM 5.3 使用低思考预算并保留严格校验',
  async (mode) => {
    const f = await init(mode);
    const result = await f.ai.evaluate(source, f.model.id, new AbortController().signal);
    expect(result.result.suggestions).toHaveLength(1);
    expect(result.usage).toMatchObject({
      outputMode: 'learning_json',
      finishReason: 'stop',
      reasoningEffort: 'low',
      maxOutputTokens: 2048,
      reasoningTokens: 20,
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({
      reasoning_effort: 'low',
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    });
    expect(f.requests[0].thinking?.type).not.toBe('disabled');
  },
);

it.each(['glm-4.7', 'fixture'])('模型 %s 不注入 GLM 5.3 专有的思考参数', async (model) => {
  const f = await init();
  await f.db.modelProfile.update({ where: { id: f.model.id }, data: { model } });
  const result = await f.ai.evaluate(source, f.model.id, new AbortController().signal);
  expect(result.result.suggestions).toHaveLength(1);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].reasoning_effort).toBeUndefined();
  expect(f.requests[0].max_tokens).toBe(2048);
});

it.each([
  'reasoning-only',
  'truncated-json',
  'empty',
  'prose',
  'invalid',
  'array',
  'fake-evidence',
  'mixed-evidence',
] as const)('学习 %s 不能伪造结果、补模型请求或自动重试，失败用量仍可追踪', async (mode) => {
  const f = await init(mode);
  await f.runtime.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  const message = await f.runtime.ingest(f.inbound('现货多久发货'));
  await f.runtime.setOpened(message.conversationId);
  await f.runtime.sendManual({
    conversationId: message.conversationId,
    text: '现货付款后 48 小时内发出。',
    requestId: 'learning-human',
  });
  await flush(f.runtime, f.db);
  const run = await f.db.aiRun.findFirstOrThrow({ where: { role: 'learning' } });
  expect(run.status).toBe('failed');
  expect(run.error).not.toContain('received undefined');
  expect(run.usage).toMatchObject({
    inputTokens: 50,
    outputMode: 'learning_json',
    maxOutputTokens: 2048,
  });
  if (mode === 'reasoning-only' || mode === 'truncated-json') {
    expect(run.error).toContain('2048');
    expect(run.usage).toMatchObject({
      finishReason: 'length',
      outputTokens: 2048,
      reasoningTokens: 2048,
    });
  }
  if (mode === 'fake-evidence' || mode === 'mixed-evidence') {
    const invalid = mode === 'fake-evidence' ? 'not-in-this-turn' : 'E999999';
    expect(run.output).toMatchObject({
      reuseVerdict: 'reusable',
      evidenceIds: expect.arrayContaining([invalid]),
    });
    expect(run.evidence).toMatchObject({
      invalidEvidenceIds: [invalid],
      catalog: expect.arrayContaining([
        expect.objectContaining({ id: message.id, kind: 'message' }),
      ]),
    });
    expect(run.error).toContain(invalid);
  }
  expect(await f.db.job.findUnique({ where: { id: run.jobId! } })).toMatchObject({
    status: 'failed',
    attempts: 1,
  });
  await flush(f.runtime, f.db);
  expect(f.requests).toHaveLength(1);
  expect(await f.db.learningEvaluation.count()).toBe(0);
  expect(await f.db.knowledgeCandidate.count()).toBe(0);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  expect(f.sends).toHaveLength(1); // The real answered source is the fixture's manual send.
});

it('真实问答经过 Mastra 学习只产生待审批建议，不自动发布或回复买家', async () => {
  const f = await init();
  await f.runtime.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  await f.runtime.ingest(f.inbound('有现货吗'));
  const waiting = await f.db.messageGroup.findFirstOrThrow();
  await f.db.messageGroup.update({ where: { id: waiting.id }, data: { createdAt: new Date(0) } });
  const message = await f.runtime.ingest(f.inbound('现货多久发货'));
  await f.runtime.setOpened(message.conversationId);
  await f.runtime.sendManual({
    conversationId: message.conversationId,
    text: '现货付款后 48 小时内发出。',
    requestId: 'learning-success',
  });
  await flush(f.runtime, f.db);
  expect(f.requests).toHaveLength(1);
  expect(await f.db.aiRun.findFirst({ where: { role: 'learning' } })).toMatchObject({
    status: 'succeeded',
    input: { associationMode: 'conversation_context' },
    output: { reuseVerdict: 'reusable' },
    usage: { outputMode: 'learning_json' },
  });
  const candidate = await f.db.knowledgeCandidate.findFirstOrThrow();
  expect(candidate.status).toBe('pending_review');
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  expect(await f.db.knowledgeReview.count()).toBe(0);
  expect(f.sends).toHaveLength(1);
  await flush(f.runtime, f.db);
  expect(f.requests).toHaveLength(1);
  expect(await f.db.knowledgeCandidate.count()).toBe(1);
});

it('学习用短证据编号引用真实消息，本地映射保存；不暴露回答关联和运行 ID', async () => {
  const f = await init('short-refs');
  await f.runtime.setPolicy({ storeId: f.account.storeId, autoLearnEnabled: true });
  const question = await f.runtime.ingest(f.inbound('现货多久发货'));
  await f.runtime.setOpened(question.conversationId);
  await f.runtime.sendManual({
    conversationId: question.conversationId,
    text: '现货付款后 48 小时内发出。',
    requestId: 'learning-short-refs',
  });
  await flush(f.runtime, f.db);
  const answer = await f.db.message.findFirstOrThrow({ where: { direction: 'out' } });
  const joinRow = await f.db.turnAnswer.findFirstOrThrow();
  const run = await f.db.aiRun.findFirstOrThrow({ where: { role: 'learning' } });
  expect(run).toMatchObject({
    status: 'succeeded',
    output: { evidenceIds: [question.id, answer.id] },
  });
  expect(run.evidence).toMatchObject({
    returnedEvidenceIds: ['E1', 'E2', answer.id],
    invalidEvidenceIds: [],
  });
  const evaluation = await f.db.learningEvaluation.findFirstOrThrow();
  expect(evaluation.result).toMatchObject({ evidenceIds: [question.id, answer.id] });
  expect(evaluation.inputSnapshot).toMatchObject({
    evidenceCatalog: [
      { ref: 'E1', id: question.id, kind: 'message' },
      { ref: 'E2', id: answer.id, kind: 'message' },
    ],
    answers: [{ message: { id: answer.id, evidenceRef: 'E2' } }],
  });
  expect(JSON.stringify(evaluation.inputSnapshot)).not.toContain(joinRow.id);
  expect(JSON.stringify(evaluation.inputSnapshot)).not.toContain(joinRow.outboundId!);
  expect(JSON.stringify(evaluation.inputSnapshot)).not.toContain(joinRow.turnId);
  expect(await f.db.knowledgeCandidate.findFirstOrThrow()).toMatchObject({
    status: 'pending_review',
  });
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  expect(f.requests).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
});
