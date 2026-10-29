import { ResourceScopeEditor, StoreScopeField, initialStoreScope } from '../resource-scope';
import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  BookOpenText,
  Code2,
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  Save,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  skillInputSchema,
  skillReferencePath,
  skillScriptPath,
  type SkillInput,
  type SkillRecord,
} from '../../../../../../packages/contracts/src/index';
import { api, client, date, useUi } from '../../api';
import { Button, Field } from '../ui';
import { ScriptTest } from './script-test';

type FileKind = 'references' | 'scripts';
const language = (path: string) =>
  /\.[cm]?ts$/.test(path)
    ? 'TypeScript'
    : /\.[cm]?js$/.test(path)
      ? 'JavaScript'
      : path.endsWith('.py')
        ? 'Python'
        : path.endsWith('.sh')
          ? 'Bash'
          : '文本';
const starter = (path: string) => {
  if (/\.[cm]?[jt]s$/.test(path))
    return `// 参数通过 process.argv.slice(2) 读取；结果写到 stdout。\nconst input = JSON.parse(process.argv[2] ?? '{}');\nconsole.log(JSON.stringify(input));\n`;
  if (path.endsWith('.py'))
    return `import json\nimport sys\n\ninput_data = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}\nprint(json.dumps(input_data, ensure_ascii=False))\n`;
  return `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "\${1:-hello}"\n`;
};

export function SkillEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial?: SkillInput | SkillRecord;
  onClose: () => void;
  onSaved: (skill: SkillRecord) => void;
}) {
  const [storeScope, setStoreScope] = useState(initialStoreScope);
  const [config, setConfig] = useState<SkillInput>(() => ({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    instructions:
      initial?.instructions ?? '# 适用场景\n\n说明何时使用此技能。\n\n# 处理步骤\n\n1. \n',
    references: { ...initial?.references },
    scripts: { ...initial?.scripts },
  }));
  const baseline = useRef(JSON.stringify(config));
  const [file, setFile] = useState('SKILL.md');
  const [adding, setAdding] = useState<FileKind | null>(null);
  const [path, setPath] = useState('references/');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [testing, setTesting] = useState(false);
  const busyRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const busy = saving || running;
  const record = initial && 'id' in initial ? initial : undefined;
  const patch = (values: Partial<SkillInput>) => setConfig((c) => ({ ...c, ...values }));
  const selectFile = (key: string) => {
    if (!busyRef.current) {
      setFile(key);
      setTesting(false);
    }
  };
  const close = () => {
    if (busyRef.current) return;
    if (JSON.stringify(config) !== baseline.current) setLeaving(true);
    else onClose();
  };
  const add = () => {
    if (!adding || busyRef.current) return;
    const parsed = (adding === 'scripts' ? skillScriptPath : skillReferencePath).safeParse(
      path.trim(),
    );
    if (!parsed.success) {
      setError(
        adding === 'scripts'
          ? '路径须为 scripts/ 下的 TS、JS、Python 或 Shell 文件，例如 scripts/calculate.ts。'
          : '路径须为 references/ 下的文件，例如 references/faq.md。',
      );
      return;
    }
    const paths = [...Object.keys(config.references), ...Object.keys(config.scripts)];
    if (
      paths.some(
        (p) =>
          p === parsed.data || p.startsWith(parsed.data + '/') || parsed.data.startsWith(p + '/'),
      )
    ) {
      setError('同名文件已存在，或文件名与目录冲突。');
      return;
    }
    if (paths.length >= 99) {
      setError('参考资料和脚本合计最多 99 个文件。');
      return;
    }
    patch({
      [adding]: {
        ...config[adding],
        [parsed.data]: adding === 'scripts' ? starter(parsed.data) : '',
      },
    });
    selectFile(parsed.data);
    setAdding(null);
    setError('');
  };
  const save = async () => {
    if (busyRef.current) return;
    const parsed = skillInputSchema.safeParse(config);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const labels: Record<string, string> = {
        name: '技能名称',
        description: '适用场景',
        instructions: 'SKILL.md',
        references: '参考资料',
        scripts: '脚本',
      };
      setError(`${labels[String(issue.path[0])] || '技能内容'}：${issue.message}`);
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await api<SkillRecord>('skills.save', {
        ...(!record ? { storeScope } : {}),
        id: record?.id,
        expectedRevision: record?.revision,
        config: parsed.data,
      });
      await client.invalidateQueries({ queryKey: ['skills.list'] });
      useUi.getState().notify('Skill 已保存，后续接待会自动使用最新内容，无需重新发布 Agent。');
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };
  const kind: FileKind = file.startsWith('scripts/') ? 'scripts' : 'references';
  const isScript = kind === 'scripts';
  const content = file === 'SKILL.md' ? config.instructions : (config[kind][file] ?? '');
  const fileCount = Object.keys(config.references).length + Object.keys(config.scripts).length;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay skill-editor-overlay" />
        <Dialog.Content
          className="skill-editor-dialog"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <header className="skill-editor-header">
            <div className="skill-heading-icon">
              <BookOpenText size={22} />
            </div>
            <div>
              <Dialog.Title>{record ? '编辑 Skill' : '新建 Skill'}</Dialog.Title>
              <Dialog.Description>
                编写处理方法、参考资料和脚本，Agent 会按需加载并调用。
              </Dialog.Description>
            </div>
            <button
              className="studio-icon-button"
              aria-label="关闭技能编辑器"
              disabled={busy}
              onClick={close}
            >
              <X size={19} />
            </button>
          </header>
          <fieldset className="agent-fieldset skill-editor-fields" disabled={busy}>
            <Field label="技能名称" hint="小写字母、数字和连字符，最多 64 字符。">
              <input
                aria-label="技能名称"
                placeholder="例如 after-sales-guide"
                value={config.name}
                maxLength={64}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="适用场景" hint="Agent 根据这段说明决定何时使用技能。">
              <textarea
                aria-label="技能适用场景"
                rows={2}
                placeholder="例如：处理退款和退货问题时使用。"
                value={config.description}
                maxLength={1024}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </fieldset>
          <div className="skill-editor-workspace">
            <aside className="skill-file-tree">
              {record ? (
                <ResourceScopeEditor kind="skill" id={record.id} />
              ) : (
                <StoreScopeField value={storeScope} onChange={setStoreScope} />
              )}
              <div className="skill-tree-heading">
                <FolderOpen size={14} />
                技能文件<span>{fileCount + 1}</span>
              </div>
              <button
                className={`skill-file ${file === 'SKILL.md' ? 'selected' : ''}`}
                disabled={busy}
                onClick={() => selectFile('SKILL.md')}
              >
                <BookOpenText size={15} />
                <span>SKILL.md</span>
              </button>
              {(['references', 'scripts'] as const).map((group) => (
                <div key={group}>
                  <div className="skill-tree-heading skill-references-heading">
                    {group === 'scripts' ? <Code2 size={14} /> : <FileText size={14} />}
                    {group === 'scripts' ? '脚本' : '参考资料'}
                    <button
                      className="studio-icon-button"
                      aria-label={group === 'scripts' ? '添加脚本' : '添加参考资料'}
                      disabled={busy || fileCount >= 99}
                      onClick={() => {
                        setAdding(adding === group ? null : group);
                        setPath(group === 'scripts' ? 'scripts/example.ts' : 'references/');
                      }}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  {adding === group && (
                    <div className="skill-add-reference">
                      <input
                        aria-label={group === 'scripts' ? '脚本路径' : '参考资料路径'}
                        autoFocus
                        disabled={busy}
                        placeholder={`${group}/example.${group === 'scripts' ? 'ts' : 'md'}`}
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            add();
                          }
                        }}
                      />
                      <Button variant="secondary" disabled={busy} onClick={add}>
                        添加文件
                      </Button>
                    </div>
                  )}
                  <div className="skill-file-list">
                    {Object.keys(config[group]).map((key) => (
                      <div key={key} className={`skill-file-row ${file === key ? 'selected' : ''}`}>
                        <button
                          className="skill-file"
                          title={key}
                          disabled={busy}
                          onClick={() => selectFile(key)}
                        >
                          {group === 'scripts' ? <Code2 size={14} /> : <FileText size={14} />}
                          <span>{key}</span>
                        </button>
                        <button
                          className="studio-icon-button"
                          aria-label={`${group === 'scripts' ? '删除脚本' : '删除资料'} ${key}`}
                          disabled={busy}
                          onClick={() => {
                            if (
                              config[group][key] &&
                              !window.confirm(`删除文件 ${key}？保存技能后生效。`)
                            )
                              return;
                            const next = { ...config[group] };
                            delete next[key];
                            patch({ [group]: next });
                            if (file === key) selectFile('SKILL.md');
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {!Object.keys(config[group]).length && (
                    <p className="skill-tree-empty">
                      {group === 'scripts'
                        ? 'TS / JS 使用内置运行时；Python / Bash 需本机已安装。'
                        : '可添加业务规则、操作说明和案例。资料会按需读取。'}
                    </p>
                  )}
                </div>
              ))}
            </aside>
            <section className="skill-file-editor">
              <div className="skill-file-bar">
                <span title={file}>{file}</span>
                <small>
                  {isScript ? language(file) : file.endsWith('.md') ? 'Markdown' : '文本'} ·{' '}
                  {content.length.toLocaleString()} 字符
                </small>
                {isScript && (
                  <button
                    className={`skill-test-toggle ${testing ? 'selected' : ''}`}
                    disabled={busy}
                    aria-expanded={testing}
                    onClick={() => setTesting(!testing)}
                  >
                    <Terminal size={14} />
                    试运行
                  </button>
                )}
              </div>
              <textarea
                aria-label={`编辑 ${file}`}
                className="skill-markdown"
                spellCheck={false}
                disabled={busy}
                maxLength={200000}
                value={content}
                onChange={(e) =>
                  file === 'SKILL.md'
                    ? patch({ instructions: e.target.value })
                    : patch({ [kind]: { ...config[kind], [file]: e.target.value } })
                }
              />
              {isScript && testing && (
                <ScriptTest
                  key={file}
                  config={config}
                  path={file}
                  onRunning={(value) => {
                    busyRef.current = value;
                    setRunning(value);
                  }}
                />
              )}
              <p className="skill-file-hint">
                {file === 'SKILL.md'
                  ? '这里只写正文；名称和场景说明会在导出时生成文件头。可引用 references/ 资料，并说明 scripts/ 脚本的参数和用途。'
                  : isScript
                    ? '在 SKILL.md 中说明何时调用 runSkillScript、需要哪些参数及如何理解输出。结果请写入 stdout。'
                    : '在 SKILL.md 中说明何时读取这份资料。参考文件作为文本使用。'}
              </p>
            </section>
          </div>
          {error && (
            <div className="skill-editor-error" role="alert">
              {error}
            </div>
          )}
          {leaving && (
            <div className="skill-unsaved" role="alert">
              <span>还有未保存的技能修改。</span>
              <Button variant="ghost" onClick={() => setLeaving(false)}>
                继续编辑
              </Button>
              <Button variant="danger" onClick={onClose}>
                放弃修改并关闭
              </Button>
            </div>
          )}
          <footer className="skill-editor-footer">
            <span>
              {record
                ? `${date(record.updatedAt)} 更新 · 保存后后续接待自动使用最新内容，无需重新发布 Agent`
                : '保存在本机技能库，可被多个 Agent 挂载'}
            </span>
            <Button variant="secondary" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {saving ? <Loader2 size={15} className="studio-spin" /> : <Save size={15} />}保存技能
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
