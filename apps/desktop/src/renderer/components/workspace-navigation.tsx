import { useState } from 'react';
import {
  MessageSquare,
  BookOpen,
  Sparkles,
  Store,
  Settings,
  Bot,
  Blocks,
  Workflow,
  BookOpenText,
  Waypoints,
  Activity,
  ChevronDown,
  CircleHelp,
  UserRound,
  PanelLeftClose,
} from 'lucide-react';
import { useUi } from '../api';
import { openSetupGuide } from '../pages-setup';
import { BrandMark } from '../brand-mark';
export function WorkspaceNavigation({ developer }: { developer: boolean }) {
  const ui = useUi();
  const [advanced, setAdvanced] = useState(true);
  const [compact, setCompact] = useState(false);
  const item = (id: typeof ui.page, label: string, Icon: typeof Store, detail?: string) => (
    <button
      key={id}
      type="button"
      title={detail || label}
      aria-label={label}
      aria-current={ui.page === id ? 'page' : undefined}
      className={ui.page === id ? 'selected' : ''}
      onClick={() => ui.setPage(id)}
    >
      <Icon size={18} strokeWidth={1.7} />
      <span>{label}</span>
    </button>
  );
  return (
    <aside className={`workspace-nav ${compact ? 'is-compact' : ''}`} aria-label="主导航">
      <div className="nav-drag" />
      <button
        className="workspace-brand"
        aria-label="句达 首页"
        onClick={() => ui.setPage('inbox')}
      >
        <span className="brand-icon">
          <BrandMark size={21} />
        </span>
        <span className="workspace-brand-copy">
          <strong>
            句达<span> AI</span>
          </strong>
          <small>智能客服工作台</small>
        </span>
      </button>
      <div className="workspace-nav-scroll">
        <nav aria-label="日常工作">
          {item('inbox', '接待中心', MessageSquare)}
          {item('knowledge', '问答库', BookOpen)}
          {item('learning', '学习审核', Sparkles)}
        </nav>
        <div className="nav-group-label">管理</div>
        <nav aria-label="工作空间管理">
          {item('stores', '店铺管理', Store)}
          {item('settings', '系统设置', Settings)}
        </nav>
        {developer && (
          <>
            <button
              className="nav-group-toggle"
              aria-label="高级工作室"
              title="高级工作室"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              <span>高级工作室</span>
              <ChevronDown size={13} />
            </button>
            {advanced && (
              <nav aria-label="高级工作室">
                {item('agents', 'Agent Studio', Bot, '配置客服助手')}
                {item('skills', 'Skills', BookOpenText, '编写技能与脚本')}
                {item('toolkits', 'Toolkit', Blocks, '管理业务工具')}
                {item('workflows', 'Workflow', Workflow, '管理业务流程')}
                {item('bindings', '工作绑定', Waypoints, '分配各店使用的助手')}
                {item('runs', 'Agent 执行', Activity, '查看每一步调用与结果')}
              </nav>
            )}
          </>
        )}
      </div>
      <nav className="workspace-nav-bottom" aria-label="帮助与账号">
        <button onClick={() => void openSetupGuide()} aria-label="上手引导" title="上手引导">
          <CircleHelp size={18} />
          <span>上手引导</span>
        </button>
        {item('account', '云端 AI', UserRound)}
        <button
          className="nav-collapse"
          aria-label={compact ? '展开导航' : '收起导航'}
          title={compact ? '展开导航' : '收起导航'}
          onClick={() => setCompact(!compact)}
        >
          <PanelLeftClose size={17} />
          <span>收起导航</span>
        </button>
      </nav>
    </aside>
  );
}
