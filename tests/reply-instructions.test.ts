import { describe, expect, it } from 'vitest';
import {
  replyInstructions,
  SEARCH_QA_TOOL_DESCRIPTION,
} from '../packages/ai/src/reply-instructions';
import {
  DEFAULT_REPLY_PROMPT,
  REPLY_RECEPTION_GUIDANCE,
  REPLY_STYLE_GUIDANCE,
} from '../packages/contracts/src/reply-guidance';

describe.each([
  ['默认模板', DEFAULT_REPLY_PROMPT],
  ['自定义提示词', '你是本店的售后客服，语气简洁，优先处理买家的具体诉求。'],
  ['已发布的旧提示词', '你是店铺客服。回答业务问题前先检索问答库，优先使用本店知识。'],
])('%s 的运行时问答检索规则', (_name, configuredPrompt) => {
  const instructions = replyInstructions(configuredPrompt, 'douyin');

  it('保留配置并追加一次统一规则，已有知识可答时无需重新调用工具', () => {
    expect(instructions.startsWith(`${configuredPrompt}\n`)).toBe(true);
    expect(instructions.split(REPLY_RECEPTION_GUIDANCE)).toHaveLength(2);
    expect(instructions.split(REPLY_STYLE_GUIDANCE)).toHaveLength(2);
    expect(instructions.indexOf(REPLY_STYLE_GUIDANCE)).toBeGreaterThan(
      instructions.indexOf(REPLY_RECEPTION_GUIDANCE),
    );
    expect(REPLY_STYLE_GUIDANCE).toContain('条与条之间空一行');
    expect(instructions.split('问答检索规则：')).toHaveLength(2);
    expect(instructions.indexOf('问答检索规则：')).toBeGreaterThanOrEqual(configuredPrompt.length);
    expect(instructions).toContain('先读本轮 messages、knowledge 和已有工具结果');
    expect(instructions).toContain('已有适用依据足以回答时直接回答');
    expect(instructions).toContain('不是每轮先调用 searchQaPairs');
    expect(instructions).toContain('问候、礼貌回应、澄清问题和明确转人工都不需要先查问答');
  });

  it('区分已经查过、查询失败和未查，只有新线索或缺失知识点才补查', () => {
    expect(instructions).toContain('knowledgeSearch');
    expect(instructions).toContain('completed 表示已完成');
    expect(instructions).toContain('空数组也表示已经查过');
    expect(instructions).toContain('failed 表示检索失败，不能当成没有相关问答');
    expect(instructions).toContain('not_run 表示尚未检索');
    expect(instructions).toContain('分数未达到直答阈值也不是重复检索的理由');
    expect(instructions).toContain('现有 knowledge 未覆盖时，才调用 searchQaPairs');
    expect(instructions).toContain('新线索或明确遗漏的知识点才补查');
    expect(instructions).toContain('不为同一个问题反复改写措辞搜索');
  });

  it('实时业务事实直接使用当前平台工具，缺信息先澄清', () => {
    expect(instructions).toContain('当前平台：抖店');
    expect(instructions).toContain('实时价格、库存、订单状态和物流进度用对应平台工具查询');
    expect(instructions).toContain('不把问答检索作为平台查询的前置步骤');
    expect(instructions).toContain('缺少商品或订单信息时先澄清或用平台工具确认');
    expect(instructions).toContain('工具不可用或依据仍不足时说明能确认的部分');
  });
});

it('问答工具描述要求按需补查缺失静态知识，复用已有结果并把实时问题交给平台', () => {
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('仅用于现有上下文缺少的');
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('商品说明、使用方法或店铺政策');
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('先读本轮 knowledge');
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('已有答案、问候、礼貌回应、澄清或转人工无需调用');
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('实时价格、库存、订单和物流状态应查询对应平台工具');
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('不要重复检索本轮已经查过的问题');
  expect(SEARCH_QA_TOOL_DESCRIPTION).toContain('没有命中不代表必须转人工');
});
