import { createHash, randomUUID } from 'node:crypto';
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export function assert(value: unknown, message: string, code = 'INVALID_STATE'): asserts value {
  if (!value) throw new DomainError(code, message);
}
export function hash(value: unknown) {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
export const uid = () => randomUUID();
// Profiles created by the removed hosted-AI service keep their `cloud:` ids in old workspaces.
export const isRetiredCloudModel = (model: { id?: unknown }) =>
  typeof model.id === 'string' && model.id.startsWith('cloud:');
export const errorText = (e: unknown) =>
  e instanceof DomainError ? e.message : e instanceof Error ? e.message.slice(0, 500) : '未知错误';
export class Mutex {
  private tail = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
export const iso = (date: Date | number) => new Date(date).toISOString();
