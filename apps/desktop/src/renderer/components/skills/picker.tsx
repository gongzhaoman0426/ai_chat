import { useState } from 'react';
import { BookOpenText, Search } from 'lucide-react';
import type { SkillRecord } from '../../../../../../packages/contracts/src/index';
import { date } from '../../api';
import { Button, Empty, Modal } from '../ui';
export function SkillPicker({
  skills,
  value,
  onApply,
  onClose,
}: {
  skills: SkillRecord[];
  value: string[];
  onApply: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(value);
  const shown = skills.filter((s) =>
    `${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const missing = selected.filter((id) => !skills.some((s) => s.id === id));
  const names = skills.filter((s) => selected.includes(s.id)).map((s) => s.name);
  const duplicate = new Set(names).size !== names.length;
  return (
    <Modal
      open
      title="挂载 Skill"
      description="先让 Agent 了解适用场景，处理相关问题时再加载详细步骤。"
      onOpenChange={(v) => !v && onClose()}
    >
      <div className="studio-search">
        <Search size={16} />
        <input
          aria-label="搜索技能"
          placeholder="搜索名称或适用场景…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="studio-picker-meta">
        <span>本机技能库</span>
        <span>已选 {selected.length} / 30</span>
      </div>
      <div className="studio-picker-list">
        {shown.map((skill) => (
          <label
            className={`studio-pick-option ${selected.includes(skill.id) ? 'is-selected' : ''}`}
            key={skill.id}
          >
            <input
              type="checkbox"
              aria-label={skill.name}
              checked={selected.includes(skill.id)}
              disabled={!selected.includes(skill.id) && selected.length >= 30}
              onChange={() =>
                setSelected((s) =>
                  s.includes(skill.id) ? s.filter((id) => id !== skill.id) : [...s, skill.id],
                )
              }
            />
            <div className="studio-resource-icon skill">
              <BookOpenText size={18} />
            </div>
            <div className="studio-pick-copy">
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <small>
                {Object.keys(skill.references).length} 份资料 · {Object.keys(skill.scripts).length}{' '}
                个脚本 · {date(skill.updatedAt)} 更新
              </small>
            </div>
          </label>
        ))}
      </div>
      {!shown.length && (
        <Empty icon={<BookOpenText />}>还没有匹配的 Skill，可先在能力配置中新建技能。</Empty>
      )}
      {missing.map((id) => (
        <div className="skill-missing" key={id}>
          技能已删除或缺失
          <Button variant="ghost" onClick={() => setSelected((s) => s.filter((v) => v !== id))}>
            移除引用
          </Button>
        </div>
      ))}
      {duplicate && (
        <p className="skill-editor-error" role="alert">
          同一个 Agent 不能挂载同名 Skill。
        </p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={!!missing.length || duplicate}
          onClick={() => {
            onApply(selected);
            onClose();
          }}
        >
          应用挂载
        </Button>
      </div>
    </Modal>
  );
}
