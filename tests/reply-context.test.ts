import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setup } from './helpers';
import { defaultConfig, type PublishedConfig } from '../packages/agent-config/src';
import { MastraAi } from '../packages/ai/src';
import type { ReplyContext } from '../packages/core/src/types';
import { uid } from '../packages/core/src/util';

let fixture: Awaited<ReturnType<typeof setup>> | undefined;
let ai: MastraAi | undefined;
let server: Server | undefined;
afterEach(async () => {
  await ai?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await fixture?.cleanup();
  fixture = undefined;
  ai = undefined;
  server = undefined;
});

async function start(workingMemory = false) {
  fixture = await setup();
  const f = fixture;
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const remember = workingMemory && requests.length === 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: `fixture-${requests.length}`,
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: remember ? null : '收到，我先核对订单信息，请稍等。',
              ...(remember
                ? {
                    tool_calls: [
                      {
                        id: 'remember-preference',
                        type: 'function',
                        function: {
                          name: 'updateWorkingMemory',
                          arguments: JSON.stringify({ memory: '# 买家偏好\n备注姓名：赵无极' }),
                        },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: remember ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await f.db.modelProfile.update({
    where: { id: f.model.id },
    data: { baseUrl: `http://127.0.0.1:${port}/v1`, provider: 'openai', secretRef: null },
  });
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();
  const config = defaultConfig(f.model.id);
  config.memory.workingMemory = workingMemory;
  const definition = await f.engine.agents.save({ config });
  const revision = await f.engine.agents.publish(definition.id, definition.draftRevision);
  const incoming = await f.engine.ingest(f.inbound('帮我备注 赵无极'));
  const context: ReplyContext = {
    storeId: f.account.storeId,
    accountId: f.account.id,
    conversationId: incoming.conversationId,
    buyerId: 'buyer-a',
    runId: uid(),
    configEpoch: 1,
    question: '',
    messages: [],
    matches: [],
    config: revision.configSnapshot as unknown as PublishedConfig,
    revisionId: revision.id,
    capabilities: f.account.capabilities as ReplyContext['capabilities'],
    signal: new AbortController().signal,
    guard: async () => {},
  };
  return { f, ai, context, requests };
}

function userPrompt(request: any) {
  const messages = request.messages.filter((message: any) => message.role === 'user');
  expect(messages).toHaveLength(1);
  const content = messages[0].content;
  return JSON.parse(
    typeof content === 'string' ? content : content.find((part: any) => part.type === 'text').text,
  );
}

it('连续十二轮只提供一份当前真实会话，不重复累积历史上下文快照', async () => {
  const t = await start();
  const history: ReplyContext['messages'] = [];
  expect(t.context.config.memory.lastMessages).toBe(20);
  for (let round = 1; round <= 12; round++) {
    const question =
      round === 1 ? '帮我备注 赵无极' : `第${round}次核对，请确认订单备注和发货情况。`;
    history.push({ id: `buyer-${round}`, origin: 'buyer', text: question });
    const recent = history.slice(-t.context.config.memory.lastMessages);
    const result = await t.ai.reply({
      ...t.context,
      runId: uid(),
      question,
      messages: recent,
      knowledgeSearch: { query: question, status: 'completed' },
    });
    expect(t.requests).toHaveLength(round);
    const request = t.requests.at(-1);
    expect(userPrompt(request)).toMatchObject({ question, messages: recent });
    expect(request.messages.filter((message: any) => message.role !== 'system')).toHaveLength(1);
    if (round > 1)
      expect(userPrompt(request).messages).toContainEqual({
        id: `confirmed-${round - 1}`,
        origin: 'human',
        text: '客服已核对信息，请稍等。',
      });
    expect(result.result.text).toBe('收到，我先核对订单信息，请稍等。');
    // The actual confirmed reply can differ from the model's unsent candidate.
    history.push({ id: `confirmed-${round}`, origin: 'human', text: '客服已核对信息，请稍等。' });
  }
  expect(userPrompt(t.requests.at(-1)).messages).toHaveLength(20);
  expect(userPrompt(t.requests.at(-1)).messages).not.toContainEqual(history[0]);
});

it('停用重复消息召回后，同轮工具仍执行且会话工作记忆在下一轮可用', async () => {
  const t = await start(true);
  const first = await t.ai.reply({ ...t.context, question: '请记住备注姓名是赵无极' });
  expect(first.result.text).toBe('收到，我先核对订单信息，请稍等。');
  expect(t.requests).toHaveLength(2);
  expect(t.requests[0].tools.map((tool: any) => tool.function.name)).toContain(
    'updateWorkingMemory',
  );
  expect(t.requests[1].messages.some((message: any) => message.role === 'tool')).toBe(true);
  await t.ai.reply({ ...t.context, runId: uid(), question: '上次的备注姓名是什么？' });
  expect(t.requests).toHaveLength(3);
  const request = t.requests[2];
  expect(userPrompt(request).question).toBe('上次的备注姓名是什么？');
  expect(
    request.messages
      .filter((message: any) => message.role === 'system')
      .map((message: any) => message.content)
      .join('\n'),
  ).toContain('备注姓名：赵无极');
  expect(t.f.sends).toHaveLength(0);
});
