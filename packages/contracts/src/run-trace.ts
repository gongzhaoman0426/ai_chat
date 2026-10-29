export type RunStepKind =
  | 'agent'
  | 'model'
  | 'tool'
  | 'workflow'
  | 'workflow_step'
  | 'skill'
  | 'knowledge';
export type RunStepStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'skipped';
export interface RunStep {
  id: string;
  runId: string;
  sequence: number;
  parentId: string | null;
  kind: RunStepKind;
  name: string;
  toolName: string | null;
  status: RunStepStatus;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
  error: string | null;
  startedAt: string | Date;
  finishedAt: string | Date | null;
}
