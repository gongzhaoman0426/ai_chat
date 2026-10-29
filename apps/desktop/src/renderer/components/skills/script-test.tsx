import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square } from 'lucide-react';
import {
  skillInputSchema,
  skillScriptCallSchema,
  type SkillInput,
  type SkillScriptResult,
} from '../../../../../../packages/contracts/src/index';
import { api } from '../../api';
import { Button } from '../ui';

const statuses: Record<SkillScriptResult['status'], string> = {
  succeeded: '运行成功',
  failed: '运行失败',
  timed_out: '运行超时',
  cancelled: '已停止',
  output_limit: '输出超限',
};

export function ScriptTest({
  config,
  path,
  onRunning,
}: {
  config: SkillInput;
  path: string;
  onRunning: (running: boolean) => void;
}) {
  const [args, setArgs] = useState('[]');
  const [stdin, setStdin] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10000);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillScriptResult | null>(null);
  const [tested, setTested] = useState('');
  const panel = useRef<HTMLElement>(null);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panel.current) return;
    if (running) panel.current.scrollTop = 0;
    else if (result && output.current) {
      panel.current.scrollTop +=
        output.current.getBoundingClientRect().top - panel.current.getBoundingClientRect().top - 12;
    }
  }, [result, running]);
  const runId = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (runId.current) void api('skills.cancelTest', { runId: runId.current }).catch(() => {});
    };
  }, []);
  const draft = JSON.stringify({ config, path, args, stdin, timeoutMs });
  const run = async () => {
    if (runId.current) return;
    setError('');
    const parsed = skillInputSchema.safeParse(config);
    if (!parsed.success) {
      setError(`请先完善技能内容：${parsed.error.issues[0].message}`);
      return;
    }
    let argv: unknown;
    try {
      argv = JSON.parse(args);
    } catch {
      setError('参数须为 JSON 字符串数组，例如 ["42", "hello"]。');
      return;
    }
    const call = skillScriptCallSchema.safeParse({ path, args: argv, stdin, timeoutMs });
    if (!call.success) {
      setError(`运行参数无效：${call.error.issues[0].message}`);
      return;
    }
    runId.current = crypto.randomUUID();
    setRunning(true);
    onRunning(true);
    setResult(null);
    setTested(draft);
    try {
      const output = await api<SkillScriptResult>('skills.test', {
        runId: runId.current,
        config: parsed.data,
        call: call.data,
      });
      if (mounted.current) setResult(output);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '脚本试运行失败');
    } finally {
      runId.current = null;
      if (mounted.current) {
        setRunning(false);
        setStopping(false);
        onRunning(false);
      }
    }
  };
  const cancel = async () => {
    if (!runId.current || stopping) return;
    setStopping(true);
    try {
      await api('skills.cancelTest', { runId: runId.current });
    } catch (e) {
      setError(e instanceof Error ? e.message : '停止失败，请重试');
      setStopping(false);
    }
  };
  return (
    <section ref={panel} className="skill-script-test" aria-label="脚本试运行">
      <div className="skill-test-controls">
        <label>
          参数（JSON 字符串数组）
          <input
            aria-label="脚本参数"
            value={args}
            disabled={running}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={'["42"]'}
          />
        </label>
        <label className="skill-timeout">
          超时（秒）
          <input
            aria-label="脚本超时秒数"
            type="number"
            min={0.1}
            max={30}
            step={0.1}
            value={timeoutMs / 1000}
            disabled={running}
            onChange={(e) => setTimeoutMs(Math.round(Number(e.target.value) * 1000))}
          />
        </label>
        {running ? (
          <Button variant="secondary" disabled={stopping} onClick={() => void cancel()}>
            {stopping ? <Loader2 size={14} className="studio-spin" /> : <Square size={14} />}
            {stopping ? '正在停止' : '停止运行'}
          </Button>
        ) : (
          <Button onClick={() => void run()}>
            <Play size={14} />
            运行脚本
          </Button>
        )}
      </div>
      <details className="skill-stdin">
        <summary>标准输入 stdin（可选）</summary>
        <textarea
          aria-label="脚本标准输入"
          rows={2}
          maxLength={64000}
          disabled={running}
          value={stdin}
          onChange={(e) => setStdin(e.target.value)}
          placeholder="通过 stdin 传入文本或 JSON"
        />
      </details>
      <p className="skill-test-note">
        运行当前草稿，无需调用模型。脚本拥有本机文件与网络权限，请使用可信代码。
      </p>
      {running && (
        <p className="skill-test-progress" role="status">
          <Loader2 size={13} className="studio-spin" />
          脚本运行中…
        </p>
      )}
      {error && (
        <p className="skill-test-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div
          ref={output}
          className={`skill-test-result ${result.status === 'succeeded' ? '' : 'is-error'}`}
          aria-label="脚本运行结果"
          role="status"
        >
          <div className="skill-test-result-heading">
            <strong>{statuses[result.status]}</strong>
            <span>
              {result.runtime} · {result.durationMs} ms · 退出码 {result.exitCode ?? '—'}
            </span>
          </div>
          {tested !== draft && (
            <p className="skill-test-note">内容或参数已修改，下方为上次试运行结果。</p>
          )}
          <small>stdout</small>
          <pre>{result.stdout || '（无输出）'}</pre>
          {result.stderr && (
            <>
              <small>stderr</small>
              <pre>{result.stderr}</pre>
            </>
          )}
          {result.truncated && (
            <p className="skill-test-note">输出超过 64 KiB，已截断并停止脚本。</p>
          )}
        </div>
      )}
    </section>
  );
}
