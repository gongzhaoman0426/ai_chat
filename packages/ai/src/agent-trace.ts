import type { ToolsInput } from '@mastra/core/agent';
import type { RunTrace } from '../../core/src/run-trace';
import type { RunStepKind } from '../../contracts/src/run-trace';
import { uid } from '../../core/src/util';
import { outputLimitMessage } from './output-limit';
export interface ToolTraceInfo {
  name: string;
  kind: RunStepKind;
  assetId?: string;
}
const builtin: Record<string, ToolTraceInfo> = {
  searchQaPairs: { name: '检索问答库', kind: 'tool' },
  handoffToHuman: { name: '转交人工接待', kind: 'tool' },
  submitReply: { name: '提交回复', kind: 'tool' },
  runSkillScript: { name: '运行 Skill 脚本', kind: 'skill' },
  skill: { name: '加载 Skill', kind: 'skill' },
  skill_read: { name: '读取 Skill 文件', kind: 'skill' },
  skill_search: { name: '搜索 Skill', kind: 'skill' },
};
const failure = (value: unknown) => {
  if (value == null) return undefined;
  if (value instanceof Error) return value;
  return new Error(
    typeof value === 'string'
      ? value
      : String((value as { message?: unknown }).message ?? JSON.stringify(value)),
  );
};
const outcome = (output: any) => {
  if (output?.status === 'unknown')
    return { status: 'unknown' as const, error: failure(output.reason ?? '工具结果待确认') };
  if (output?.status === 'cancelled')
    return { status: 'cancelled' as const, error: failure(output.reason ?? '工具已取消') };
  if (
    output?.error === true ||
    output?.isError ||
    output?.success === false ||
    ['error', 'failed', 'rejected', 'timeout', 'timed_out', 'output_limit'].includes(output?.status)
  )
    return {
      status: 'failed' as const,
      error: failure(
        output.message ?? output.error ?? output.reason ?? output.stderr ?? '工具返回失败结果',
      ),
    };
  return { status: 'succeeded' as const };
};
// One instance per agent invocation, not per shop or tool name. Concurrent tool
// calls correlate by the real call ID; child invocations inherit their caller span.
export class AgentTrace {
  private round = 0;
  private modelStep?: string;
  private calls = new Map<string, Promise<string>>();
  constructor(
    readonly trace: RunTrace,
    private model: Record<string, unknown>,
    private info: Record<string, ToolTraceInfo> = {},
  ) {}
  prepareStep = async ({
    stepNumber,
    messages,
    systemMessages,
  }: {
    stepNumber: number;
    messages?: unknown;
    systemMessages?: unknown;
  }) => {
    this.round = stepNumber + 1;
    this.calls.clear();
    this.modelStep = await this.trace.start({
      kind: 'model',
      name: `第 ${this.round} 轮模型调用`,
      input: { systemMessages, messages },
      metadata: {
        round: this.round,
        model: this.model.model,
        provider: this.model.provider,
        maxOutputTokens: this.model.maxTokens,
      },
    });
  };
  private tool(name: string, input: unknown, callId: string) {
    const key = `${this.round}:${callId}`;
    if (!this.calls.has(key)) {
      const info = this.info[name] ??
        builtin[name] ?? { name, kind: name.startsWith('skill') ? 'skill' : 'tool' };
      this.calls.set(
        key,
        this.trace.start({
          kind: info.kind,
          name: info.name,
          toolName: name,
          input,
          parentId: this.modelStep,
          metadata: {
            toolCallId: callId,
            round: this.round,
            ...(info.assetId ? { assetId: info.assetId } : {}),
          },
        }),
      );
    }
    return this.calls.get(key)!;
  }
  wrapTools(tools: ToolsInput) {
    for (const [name, tool] of Object.entries(tools)) {
      const executable = tool as { execute?: (input: unknown, options: any) => Promise<unknown> };
      if (typeof executable.execute !== 'function') continue;
      const execute = executable.execute.bind(tool);
      executable.execute = async (input, options) => {
        const callId = options?.agent?.toolCallId ?? options?.toolCallId ?? uid();
        const id = await this.tool(name, input, callId);
        try {
          const output = await this.trace.within(id, () => execute(input, options));
          await this.trace.finish(id, { output, ...outcome(output) });
          return output;
        } catch (error) {
          await this.trace.finish(id, {
            error: failure(error),
            status: options?.abortSignal?.aborted ? 'cancelled' : 'failed',
          });
          throw error;
        }
      };
    }
  }
  onChunk = async (chunk: { type: string; payload?: any }) => {
    const p = chunk.payload;
    if (['tool-call', 'tool-result', 'tool-error'].includes(chunk.type) && p?.toolCallId) {
      const id = await this.tool(p.toolName ?? '未知工具', p.args, p.toolCallId);
      if (chunk.type === 'tool-error')
        await this.trace.finish(id, { error: failure(p.error ?? p.message ?? '工具执行失败') });
      if (chunk.type === 'tool-result')
        await this.trace.finish(id, {
          output: p.result,
          ...(p.isError ? { error: failure(p.result) } : outcome(p.result)),
        });
    }
    if (chunk.type === 'error' || chunk.type === 'tripwire')
      await this.fail(failure(p?.error ?? p?.reason ?? '模型执行中断'));
  };
  onStepFinish = async (step: {
    text: string;
    usage: unknown;
    finishReason?: string;
    toolCalls: unknown[];
    toolResults: unknown[];
  }) => {
    // Also reconcile outputs from native workspace tools / schema failures. These
    // use Mastra's payload envelope, unlike AI SDK's flat stopWhen step objects.
    for (const call of step.toolCalls as any[]) await this.onChunk(call);
    for (const result of step.toolResults as any[]) await this.onChunk(result);
    if (this.modelStep)
      await this.trace.finish(this.modelStep, {
        output: {
          text: step.text,
          toolCalls: (step.toolCalls as any[]).map((c) => ({
            toolName: c.payload?.toolName,
            toolCallId: c.payload?.toolCallId,
          })),
        },
        metadata: { usage: step.usage, finishReason: step.finishReason },
        ...(['length', 'error'].includes(step.finishReason ?? '')
          ? {
              status: 'failed' as const,
              error: new Error(
                step.finishReason === 'length'
                  ? outputLimitMessage(this.model.maxTokens, step.usage, step.text)
                  : '模型调用失败',
              ),
            }
          : {}),
      });
  };
  async fail(error: unknown) {
    if (this.modelStep) await this.trace.finish(this.modelStep, { error: failure(error) });
  }
}
