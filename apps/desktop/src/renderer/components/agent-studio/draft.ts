import {
  toolkitIdentity,
  normalizeAgentToolkits,
} from '../../../../../../packages/contracts/src/toolkit-catalog';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentConfigSchema,
  agentConfigFields,
  type AgentConfig,
} from '../../../../../../packages/contracts/src/index';
import { api, client } from '../../api';
import { DEFAULT_REPLY_PROMPT } from '../../../../../../packages/contracts/src/reply-guidance';

export type { AgentConfig };
export type AgentRevision = {
  id: string;
  revision: number;
  publishedAt: string;
  configSnapshot?: AgentConfig;
};
export type AgentRecord = {
  id: string;
  name: string;
  origin: string;
  draftConfig: AgentConfig;
  draftRevision: number;
  revisions: AgentRevision[];
};
export type ModelOption = { id: string; name: string; kind: string; model: string };
export type AssetOption = {
  legacy?: boolean;
  id: string;
  version: string;
  status: string;
  manifest: {
    kind: string;
    platforms?: string[];
    name: string;
    description: string;
    members: { id: string; name: string }[];
  };
};
export type MountKind = 'toolkit';
export const mountKey = { toolkit: 'toolkitIds' } as const;
export const mountLabel = { toolkit: 'Toolkit' } as const;
export const findMountedAsset = (assets: AssetOption[], kind: MountKind, id: string) =>
  assets.find(
    (asset) => asset.manifest.kind === kind && toolkitIdentity(asset.id) === toolkitIdentity(id),
  );
export const newAgent = (): AgentConfig => ({
  name: '',
  description: '',
  prompt: DEFAULT_REPLY_PROMPT,
  modelProfileId: null,
  toolkitIds: ['builtin/utilities', 'builtin/commerce'],
  skillIds: [],
  subAgents: [],
  memory: { lastMessages: 20, workingMemory: false },
  maxSteps: 8,
  maxDepth: 2,
});
const equal = (a: AgentConfig, b: AgentConfig) => JSON.stringify(a) === JSON.stringify(b);
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');
export { errorText };
export function publicationStatus(record: AgentRecord, config = record.draftConfig) {
  const latest = record.revisions[0];
  if (!latest) return '未发布';
  if (!latest.configSnapshot) return '已发布';
  const comparable = (value: AgentConfig) => {
    const fields = Object.fromEntries(agentConfigFields.map((key) => [key, (value as any)[key]]));
    const parsed = agentConfigSchema.safeParse(fields);
    return JSON.stringify(parsed.success ? normalizeAgentToolkits(parsed.data) : fields);
  };
  return comparable(config) === comparable(latest.configSnapshot) ? '已发布' : '有修改待发布';
}
export function validateDraft(config: AgentConfig) {
  const result = agentConfigSchema.safeParse(config);
  if (result.success) return null;
  const field = result.error.issues[0]?.path[0];
  const messages: Record<string, string> = {
    name: 'Agent 名称需要 1–80 个字符。',
    description: '说明不能超过 1000 个字符。',
    prompt: '请填写系统提示词，最多 30000 个字符。',
    memory: '近期消息数需要是 0–80 之间的整数。',
    maxSteps: '最大执行步骤需要是 1–20 之间的整数。',
    maxDepth: '子 Agent 最大深度需要是 1–4 之间的整数。',
    skillIds: '最多挂载 30 个 Skill。',
    subAgents: '请检查子 Agent：最多挂载 8 个，别名须以字母开头，仅使用字母、数字和下划线。',
  };
  return messages[String(field)] || '请检查配置内容后保存。';
}

// A single writer owns draftRevision. Edits made during a save are flushed in order.
export function useAgentDraft(initial: AgentRecord, paused: boolean) {
  const [record, setRecord] = useState(initial);
  const [config, setConfig] = useState(initial.draftConfig);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const recordRef = useRef(initial);
  const configRef = useRef(initial.draftConfig);
  const pending = useRef<Promise<AgentRecord> | null>(null);
  const dirty = !equal(config, record.draftConfig);
  const validationError = validateDraft(config);

  const patch = useCallback((values: Partial<AgentConfig>) => {
    configRef.current = { ...configRef.current, ...values };
    setConfig(configRef.current);
    // Do not retry a conflicting revision in the background on every keystroke.
    setSaveError((old) => (old?.includes('草稿已') || old?.includes('CONFLICT') ? old : null));
  }, []);

  const replace = useCallback((next: AgentRecord) => {
    recordRef.current = next;
    configRef.current = next.draftConfig;
    setRecord(next);
    setConfig(next.draftConfig);
    setSaveError(null);
  }, []);

  const flush = useCallback((): Promise<AgentRecord> => {
    if (pending.current) return pending.current;
    const task = (async () => {
      setSaving(true);
      try {
        while (!equal(configRef.current, recordRef.current.draftConfig)) {
          const snapshot = configRef.current;
          const invalid = validateDraft(snapshot);
          if (invalid) throw new Error(invalid);
          const saved = await api<AgentRecord>('agents.save', {
            id: recordRef.current.id,
            expectedRevision: recordRef.current.draftRevision,
            config: snapshot,
          });
          const next = { ...saved, revisions: recordRef.current.revisions };
          recordRef.current = next;
          setRecord(next);
          if (equal(configRef.current, snapshot)) {
            configRef.current = saved.draftConfig;
            setConfig(saved.draftConfig);
          }
          void client.invalidateQueries({ queryKey: ['agents.list'] });
        }
        setSaveError(null);
        return recordRef.current;
      } catch (error) {
        setSaveError(errorText(error));
        throw error;
      } finally {
        setSaving(false);
      }
    })();
    pending.current = task;
    void task.then(
      () => {
        pending.current = null;
      },
      () => {
        pending.current = null;
      },
    );
    return task;
  }, []);

  useEffect(() => {
    if (!dirty || paused || saveError || validationError) return;
    const timer = window.setTimeout(() => void flush().catch(() => {}), 900);
    return () => window.clearTimeout(timer);
  }, [config, dirty, paused, saveError, validationError, flush]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const settle = () =>
    pending.current?.catch(() => recordRef.current) ?? Promise.resolve(recordRef.current);
  return {
    record,
    config,
    patch,
    replace,
    flush,
    settle,
    dirty,
    saving,
    saveError,
    validationError,
  };
}
