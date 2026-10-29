import { Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '../../database/src';
import { json } from '../../database/src';
import type { RunStepKind, RunStepStatus } from '../../contracts/src/run-trace';
import { errorText, uid } from './util';

const traceJson = (value: unknown) => (value == null ? Prisma.JsonNull : json(value));
const privateKey =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|password|secret(?:ref)?|access[_-]?token|refresh[_-]?token|reasoning(?:Text|_content|Details)?)$/i;
// Tool outputs are untrusted and may contain credentials, binary images or cycles.
// Never serialize SDK request objects / hidden reasoning into the product timeline.
export function traceValue(value: unknown, secrets: Iterable<string> = []) {
  const values = [...secrets].filter((s) => s.length >= 4);
  let remaining = 48000;
  const seen = new WeakSet<object>();
  const text = (raw: string) => {
    let v = raw
      .replace(/data:[\w/+.-]+;base64,[a-z\d+/=\s]+/gi, '[图片或文件内容已省略]')
      .replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [已隐藏]');
    for (const secret of values) v = v.split(secret).join('[已隐藏]');
    const limit = Math.max(0, Math.min(12000, remaining));
    remaining -= Math.min(v.length, limit);
    return v.length > limit ? `${v.slice(0, limit)}\n…[内容过长，已截断]` : v;
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (remaining-- <= 0) return '[内容过长，已截断]';
    if (v == null) return null;
    if (typeof v === 'string') return text(v);
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return String(v);
    if (typeof v !== 'object') return String(v);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return '[二进制内容已省略]';
    if (v instanceof Date) return v.toISOString();
    if (
      'type' in v &&
      ['reasoning', 'reasoning-delta', 'thinking', 'redacted-thinking'].includes(String(v.type))
    )
      return '[推理内容已省略]';
    if (v instanceof Error) return { name: v.name, message: text(v.message) };
    if (depth > 12) return '[嵌套内容已截断]';
    if (seen.has(v)) return '[重复引用]';
    seen.add(v);
    if (Array.isArray(v)) {
      const result = v.slice(0, 100).map((x) => visit(x, depth + 1));
      if (v.length > 100) result.push(`[已省略 ${v.length - 100} 项]`);
      return result;
    }
    return Object.fromEntries(
      Object.entries(v)
        .slice(0, 100)
        .map(([k, x]) => [k, privateKey.test(k) ? '[已隐藏]' : visit(x, depth + 1)]),
    );
  };
  return visit(value, 0);
}
export interface StepInput {
  kind: RunStepKind;
  name: string;
  toolName?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
  startedAt?: Date;
}
export interface StepFinish {
  output?: unknown;
  error?: unknown;
  status?: Exclude<RunStepStatus, 'running'>;
  metadata?: Record<string, unknown>;
  finishedAt?: Date;
}
export class RunTrace {
  private sequence = 0;
  private scope = new AsyncLocalStorage<string>();
  private pending = new Map<string, Record<string, unknown>>();
  private secrets = new Set<string>();
  constructor(
    private db: PrismaClient,
    readonly runId: string,
    private changed: () => void = () => {},
  ) {}
  get parentId() {
    return this.scope.getStore() ?? null;
  }
  hide(value: string) {
    if (value) this.secrets.add(value);
  }
  safe(value: unknown) {
    return traceValue(value, this.secrets);
  }
  within<T>(id: string, work: () => Promise<T>) {
    return this.scope.run(id, work);
  }
  private async write(work: () => Promise<unknown>) {
    try {
      await work();
      this.changed();
    } catch (error) {
      console.error('Agent 步骤记录保存失败', errorText(error));
    }
  }
  async start(input: StepInput) {
    const id = uid(),
      sequence = ++this.sequence;
    this.pending.set(id, input.metadata ?? {});
    const data = {
      id,
      runId: this.runId,
      sequence,
      parentId: input.parentId === undefined ? this.parentId : input.parentId,
      kind: input.kind,
      name: input.name,
      toolName: input.toolName,
      input: traceJson(this.safe(input.input)),
      output: Prisma.JsonNull,
      metadata: traceJson(this.safe(input.metadata ?? {})),
      startedAt: input.startedAt ?? new Date(),
    };
    await this.write(() => this.db.aiRunStep.create({ data }));
    return id;
  }
  async finish(id: string, result: StepFinish = {}) {
    const metadata = this.pending.get(id);
    if (!metadata) return;
    this.pending.delete(id);
    await this.write(() =>
      this.db.aiRunStep.updateMany({
        where: { id, runId: this.runId, status: 'running' },
        data: {
          status: result.status ?? (result.error ? 'failed' : 'succeeded'),
          output: traceJson(this.safe(result.output)),
          error: result.error ? String(this.safe(errorText(result.error))) : null,
          metadata: traceJson(this.safe({ ...metadata, ...result.metadata })),
          finishedAt: result.finishedAt ?? new Date(),
        },
      }),
    );
  }
  async record(input: StepInput & StepFinish) {
    const id = await this.start(input);
    await this.finish(id, input);
    return id;
  }
  async span<T>(input: StepInput, work: () => Promise<T>) {
    const id = await this.start(input);
    try {
      const result = await this.within(id, work);
      await this.finish(id, { output: result });
      return result;
    } catch (error) {
      await this.finish(id, {
        error,
        status:
          errorText(error).startsWith('STALE:') ||
          (error instanceof Error && error.name === 'AbortError')
            ? 'cancelled'
            : 'failed',
      });
      throw error;
    }
  }
  async finishPending(error: unknown = new Error('执行已结束，该步骤没有返回结果')) {
    for (const id of [...this.pending.keys()])
      await this.finish(id, { status: 'cancelled', error });
  }
}
