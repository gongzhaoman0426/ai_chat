import type { WorkingConfiguration } from '../../../../../packages/core/src/working-configuration';
import { useData, useUi } from '../api';
import { Badge, Button } from './ui';
import { Binding } from '../pages-agents';

const kindNames = { skill: 'Skill', toolkit: 'Toolkit', workflow: 'Workflow', agent: '子 Agent' };
export function WorkingConfigurationCard({
  storeId,
  developerMode,
  openSection,
  onConfigureAssistant,
}: {
  storeId: string;
  developerMode: boolean;
  openSection: (section: string) => void;
  onConfigureAssistant?: () => void;
}) {
  const { data, error, refetch } = useData<WorkingConfiguration>('stores.configuration', {
    storeId,
  });
  const navigate = (target: string) => {
    useUi.getState().setStore(storeId);
    if ((target === 'agents' || target === 'models') && onConfigureAssistant) {
      onConfigureAssistant();
      return;
    }
    if (target === 'accounts' || target === 'models') openSection(target);
    else if (!developerMode) openSection('advanced');
    // Store bindings are chosen in this card; the global default lives on the agents page.
    else if (target === 'bindings') useUi.getState().setPage('agents');
    else useUi.getState().setPage(target as 'agents' | 'toolkits' | 'workflows' | 'skills');
  };
  if (error)
    return (
      <div className="working-configuration" role="alert">
        无法读取当前接待配置。
        <Button variant="ghost" onClick={() => void refetch()}>
          重新读取
        </Button>
      </div>
    );
  if (!data) return <div className="working-configuration">正在读取当前接待配置…</div>;
  const agent = data.agent;
  return (
    <section className="working-configuration" aria-label="当前接待配置">
      <div className="working-config-heading">
        <strong>当前接待配置</strong>
        <Badge tone={!data.replyEnabled ? 'neutral' : data.ready ? 'green' : 'orange'}>
          {!data.replyEnabled
            ? '自动回复未开启'
            : data.ready
              ? agent
                ? '自动接待已开启'
                : '问答直答已开启'
              : '自动接待需要处理'}
        </Badge>
      </div>
      <div className="working-config-grid">
        <div>
          <small>工作 Agent</small>
          <strong>{agent?.name || '未绑定 Agent'}</strong>
          <span>
            {agent
              ? agent.source === 'store'
                ? '本店专用绑定'
                : '继承全局默认'
              : '仅使用符合条件的问答直答'}
          </span>
        </div>
        <div>
          <small>实际回复模型</small>
          <strong>{agent?.model?.name || '未配置'}</strong>
          <span>
            {agent?.model
              ? `${agent.model.provider} · ${agent.model.model}`
              : '需要 Agent 回答时请先配置模型'}
          </span>
        </div>
        <div>
          <small>自动学习</small>
          <strong>{data.learning.enabled ? '已开启 · 建议需人工审批' : '未开启'}</strong>
          <span>
            {data.learning.model
              ? `${data.learning.model.name} · ${data.learning.model.model}`
              : '尚未配置学习模型'}
          </span>
        </div>
      </div>
      {(data.blockers.length > 0 || data.notices.length > 0) && (
        <div className="working-config-issues">
          {[
            ...data.blockers.map((i) => ({ ...i, blocking: true })),
            ...data.notices.map((i) => ({ ...i, blocking: false })),
          ].map((issue, i) => (
            <div
              className={issue.blocking ? 'config-issue blocking' : 'config-issue'}
              key={`${issue.message}:${i}`}
            >
              <span>{issue.message}</span>
              <Button variant="ghost" onClick={() => navigate(issue.target)}>
                去处理
              </Button>
            </div>
          ))}
        </div>
      )}
      <details className="working-config-resources">
        <summary>
          查看实际挂载与可用能力 <span>{data.resources.length} 项资源</span>
        </summary>
        <p className="hint">
          Skill 自动使用最新保存的内容，Toolkit 自动使用已启用的内容，均按店铺范围开放；Workflow
          使用 Agent 发布时的配置。
        </p>
        {data.resources.length ? (
          data.resources.map((resource, i) => (
            <div className="working-resource" key={`${resource.path}:${resource.id}:${i}`}>
              <div className="working-resource-title">
                <strong>{resource.name}</strong>
                <Badge>
                  {kindNames[resource.kind]}
                  {resource.kind !== 'agent' && resource.version && ` · ${resource.version}`}
                </Badge>
                <Badge tone={resource.status === 'available' ? 'green' : 'orange'}>
                  {resource.status === 'available'
                    ? '可用'
                    : resource.status === 'partial'
                      ? '部分可用'
                      : '不可用'}
                </Badge>
              </div>
              <small>{resource.path}</small>
              <p>{resource.reason}</p>
              {!!resource.members.length && (
                <details>
                  <summary>成员明细</summary>
                  <ul>
                    {resource.members.map((member, index) => (
                      <li key={index}>
                        <strong>{member.name}</strong>
                        <span>
                          {member.availableAccounts.length
                            ? `可用账号：${member.availableAccounts.join('、')}`
                            : member.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))
        ) : (
          <p className="hint">当前没有挂载资源。</p>
        )}
      </details>
      {developerMode && <StoreBinding storeId={storeId} />}
      <div className="working-config-actions">
        <Button variant="ghost" onClick={() => navigate('agents')}>
          编辑客服助手
        </Button>
        {!developerMode && (
          <Button variant="ghost" onClick={() => navigate('bindings')}>
            切换工作 Agent
          </Button>
        )}
      </div>
    </section>
  );
}

function StoreBinding({ storeId }: { storeId: string }) {
  const { data: catalog } = useData<{ bindings?: any[] }>('agents.list');
  const { data: stores = [] } = useData<any[]>('stores.list');
  if (!catalog) return null;
  const store = stores.find((s) => s.id === storeId);
  const scopeKey = `store:${storeId}`;
  const binding = catalog.bindings?.find((b: any) => b.scopeKey === scopeKey);
  return (
    <div className="binding-list">
      <Binding
        key={`${scopeKey}:${binding?.revision}`}
        scope={{
          id: scopeKey,
          name: store?.name || '本店',
          description: '本店专用助手，优先于全局默认。',
        }}
        catalog={catalog}
      />
    </div>
  );
}
