import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup } from './helpers';
import { defaultConfig, type PublishedConfig } from '../packages/agent-config/src';
import { MastraAi } from '../packages/ai/src';
import type { KnowledgeMatch, ReplyContext } from '../packages/core/src/types';
import { uid } from '../packages/core/src/util';

let f: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let server: Server | undefined;
afterEach(async () => {
  await ai?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await f?.cleanup();
  vi.restoreAllMocks();
  f = undefined;
  ai = undefined;
  server = undefined;
});

type ToolCall = { name: string; arguments: Record<string, unknown> };
const search = (query: string): ToolCall => ({ name: 'searchQaPairs', arguments: { query } });
const submit: ToolCall = {
  name: 'submitReply',
  arguments: { action: 'reply', text: '已核实的回答', evidenceIds: [], reasonCode: 'fixture' },
};

async function fixture() {
  f = await setup();
  const t = f;
  let steps: ToolCall[][] = [];
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const calls = (steps.shift() ?? [submit]).map((call, index) => ({
      index,
      id: `call-${requests.length}-${index}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    const base = { id: `chatcmpl-${requests.length}`, created: 1, model: 'fixture' };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of [
        { delta: { role: 'assistant', tool_calls: calls }, finish_reason: null },
        { delta: {}, finish_reason: 'tool_calls' },
      ])
        res.write(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, ...chunk }] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: calls },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await t.db.modelProfile.update({
    where: { id: t.model.id },
    data: { baseUrl: `http://127.0.0.1:${port}/v1`, provider: 'openai', secretRef: null },
  });
  ai = new MastraAi(t.db, t.dir, t.host);
  await ai.initialize();
  const agent = ai;
  const definition = await t.engine.agents.save({
    config: { ...defaultConfig(t.model.id), memory: { lastMessages: 0, workingMemory: false } },
  });
  const revision = await t.engine.agents.publish(definition.id, definition.draftRevision);
  const incoming = await t.engine.ingest(t.inbound('发货 时间'));
  const context: ReplyContext = {
    storeId: t.account.storeId,
    accountId: t.account.id,
    conversationId: incoming.conversationId,
    buyerId: 'buyer-a',
    runId: uid(),
    configEpoch: 1,
    question: '发货 时间',
    messages: [{ id: incoming.id, origin: 'buyer', text: '发货 时间' }],
    matches: [],
    config: revision.configSnapshot as unknown as PublishedConfig,
    revisionId: revision.id,
    capabilities: t.account.capabilities as ReplyContext['capabilities'],
    signal: new AbortController().signal,
    guard: async () => {},
  };
  return {
    ...t,
    agent,
    context,
    requests,
    run: async (calls: ToolCall[][], overrides: Partial<ReplyContext> = {}) => {
      steps = [...calls, [submit]];
      return agent.reply({ ...context, runId: uid(), ...overrides });
    },
    match: async (): Promise<KnowledgeMatch> => {
      const qa = {
        intent: '发货时间',
        answer: '付款后 24 小时内发货',
        answerKind: 'text' as const,
        scope: { productIds: [], conditions: '' },
      };
      const saved = await t.engine.knowledge.save({ storeId: t.account.storeId, qa });
      return {
        storeId: t.account.storeId,
        entryId: saved.entryId,
        revisionId: saved.id,
        intent: qa.intent,
        qa,
        score: 0.9,
      };
    },
  };
}

function prompt(request: any) {
  const message = request.messages.find((m: any) => m.role === 'user');
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.find((part: any) => part.type === 'text').text;
  return JSON.parse(text);
}

function results(request: any) {
  return request.messages
    .filter((message: any) => message.role === 'tool')
    .map((message: any) => JSON.parse(message.content));
}

it('同轮并发和后续重复查询只检索一次，不同查询及下一轮仍独立检索', async () => {
  const t = await fixture();
  const lookup = vi.spyOn(t.agent, 'search').mockResolvedValue([]);
  const response = await t.run([
    [search('  发货   时间  '), search('发货\n时间')],
    [search('发货 时间'), search('退货条件')],
  ]);
  expect(response.result.text).toBe('已核实的回答');
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(lookup.mock.calls.map(([storeId]) => storeId)).toEqual([
    t.account.storeId,
    t.account.storeId,
  ]);
  expect(results(t.requests.at(-1))).toEqual([[], [], [], []]);
  await t.run([[search('发货 时间')]]);
  expect(lookup).toHaveBeenCalledTimes(3);
});

it.each(['命中', '空结果'] as const)(
  '自动检索完成后的%s直接复用，模型能看到检索状态',
  async (kind) => {
    const t = await fixture();
    const matches = kind === '命中' ? [await t.match()] : [];
    const lookup = vi.spyOn(t.agent, 'search').mockResolvedValue([]);
    const knowledgeSearch = { query: '发货   时间', status: 'completed' as const };
    const response = await t.run([[search('  发货\n时间  ')]], { matches, knowledgeSearch });
    expect(response.result.text).toBe('已核实的回答');
    expect(lookup).not.toHaveBeenCalled();
    expect(prompt(t.requests[0])).toMatchObject({ knowledge: matches, knowledgeSearch });
    expect(results(t.requests.at(-1))).toEqual([matches]);
    expect(response.evidenceIds).toEqual(matches.map((match) => match.revisionId));
  },
);

it('自动检索失败后仍可查询原问题，并复用本轮重试成功的结果', async () => {
  const t = await fixture();
  const match = await t.match();
  const lookup = vi.spyOn(t.agent, 'search').mockResolvedValue([match]);
  const knowledgeSearch = { query: '发货 时间', status: 'failed' as const };
  const response = await t.run([[search('发货 时间')], [search('发货   时间')]], {
    knowledgeSearch,
  });
  expect(response.result.text).toBe('已核实的回答');
  expect(lookup).toHaveBeenCalledExactlyOnceWith(t.account.storeId, '发货 时间');
  expect(prompt(t.requests[0]).knowledgeSearch).toEqual(knowledgeSearch);
  expect(results(t.requests.at(-1))).toHaveLength(2);
  expect(results(t.requests.at(-1))[0][0]).toMatchObject({ revisionId: match.revisionId });
  expect(response.evidenceIds).toEqual([match.revisionId]);
});

it('父 Agent 和子 Agent 在同一轮共享已完成的知识检索', async () => {
  const t = await fixture();
  const parent = await t.engine.agents.save({
    config: {
      ...defaultConfig(t.model.id),
      memory: { lastMessages: 0, workingMemory: false },
      subAgents: [{ alias: 'helper', revisionId: t.context.revisionId }],
    },
  });
  const revision = await t.engine.agents.publish(parent.id, parent.draftRevision);
  const lookup = vi.spyOn(t.agent, 'search').mockResolvedValue([]);
  const response = await t.run(
    [
      [search('发货 时间')],
      [{ name: 'delegate_helper', arguments: { input: '核对发货时间' } }],
      [search('  发货\n时间  ')],
      [submit],
    ],
    { config: revision.configSnapshot as unknown as PublishedConfig, revisionId: revision.id },
  );
  expect(response.result.text).toBe('已核实的回答');
  expect(t.requests).toHaveLength(5);
  expect(lookup).toHaveBeenCalledExactlyOnceWith(t.account.storeId, '发货 时间');
});
