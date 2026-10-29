import { ResourceScopeBadge } from './components/resource-scope';
import { useState } from 'react';
import { BookOpenText, Download, Plus, Search, Trash2, Upload } from 'lucide-react';
import type { SkillInput, SkillRecord } from '../../../../packages/contracts/src/index';
import { date, perform, useData } from './api';
import { Button, Empty, Modal } from './components/ui';
import { SkillEditor } from './components/skills/editor';

export function Skills() {
  const { data: skills = [], error } = useData<SkillRecord[]>('skills.list');
  const [editor, setEditor] = useState<{ initial?: SkillInput | SkillRecord } | null>(null);
  const [deleting, setDeleting] = useState<SkillRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const shown = skills.filter((s) =>
    `${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SKILL LIBRARY</div>
          <h1>Skills 技能库</h1>
          <p>用 Markdown、参考资料和脚本沉淀处理方法，挂载给 Agent 后按需使用。</p>
        </div>
        <div className="actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const input = await perform<SkillInput | null>('skills.import');
                if (input) setEditor({ initial: input });
              } finally {
                setBusy(false);
              }
            }}
          >
            <Upload size={16} />
            导入技能
          </Button>
          <Button onClick={() => setEditor({})}>
            <Plus size={16} />
            新建 Skill
          </Button>
        </div>
      </div>
      <div className="page-body">
        <div className="skill-library-toolbar">
          <div className="studio-search">
            <Search size={16} />
            <input
              aria-label="搜索 Skill"
              placeholder="搜索技能名称、适用场景…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span>{skills.length} 个本地技能</span>
        </div>
        {error && <p role="alert">{error.message}</p>}
        <div className="agent-grid">
          {shown.map((skill) => (
            <article className="card skill-card" key={skill.id}>
              <button
                className="skill-card-open"
                onClick={() => setEditor({ initial: skill })}
                aria-label={`编辑 Skill ${skill.name}`}
              >
                <div className="agent-card-top">
                  <div className="skill-heading-icon">
                    <BookOpenText size={23} />
                  </div>
                </div>
                <h3>{skill.name}</h3>
                <ResourceScopeBadge kind="skill" id={skill.id} />
                <p>{skill.description}</p>
                <div className="skill-card-meta">
                  SKILL.md · {Object.keys(skill.references).length} 份资料 ·{' '}
                  {Object.keys(skill.scripts).length} 个脚本
                </div>
              </button>
              <div className="skill-card-footer">
                <span title={skill.mountedBy.map((a) => a.name).join('、')}>
                  {skill.mountedBy.length
                    ? `${skill.mountedBy.length} 个 Agent 草稿已挂载`
                    : '尚未挂载'}
                  <small>{date(skill.updatedAt)} 更新</small>
                </span>
                <button
                  className="studio-icon-button"
                  aria-label={`导出 Skill ${skill.name}`}
                  onClick={() => perform('skills.export', { id: skill.id }, '技能 ZIP 已导出')}
                >
                  <Download size={16} />
                </button>
                <button
                  className="studio-icon-button"
                  aria-label={`删除 Skill ${skill.name}`}
                  onClick={() => setDeleting(skill)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          ))}
        </div>
        {!shown.length && !error && (
          <Empty
            icon={<BookOpenText size={28} />}
            action={
              !query && (
                <Button variant="secondary" onClick={() => setEditor({})}>
                  创建第一个技能
                </Button>
              )
            }
          >
            {query
              ? '没有匹配的技能'
              : '还没有 Skill。可新建技能，或导入包含 SKILL.md、references/ 资料和 scripts/ 脚本的 ZIP。'}
          </Empty>
        )}
      </div>
      {editor && (
        <SkillEditor
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={() => setEditor(null)}
        />
      )}
      {deleting && (
        <Modal
          open
          title={`删除 ${deleting.name}？`}
          description="从技能库移除后，已发布 Agent 继续使用发布时的副本。"
          onOpenChange={(v) => !v && !busy && setDeleting(null)}
        >
          <p>
            {deleting.mountedBy.length
              ? `以下 Agent 草稿需要移除或替换这个 Skill，才能再次发布：${deleting.mountedBy.map((a) => a.name).join('、')}。`
              : '再次使用时，需要重新创建或导入技能。'}
          </p>
          <div className="modal-actions">
            <Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  if (
                    await perform(
                      'skills.delete',
                      { id: deleting.id, expectedRevision: deleting.revision },
                      'Skill 已删除',
                    )
                  )
                    setDeleting(null);
                } finally {
                  setBusy(false);
                }
              }}
            >
              删除技能
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
