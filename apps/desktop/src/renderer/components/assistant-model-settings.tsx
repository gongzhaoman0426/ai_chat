import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Play, Sparkles } from 'lucide-react';
import type { OnboardingState } from '../../../../../packages/core/src/onboarding';
import { api, client } from '../api';
import { defaultModel, ModelFields, modelSaveInput } from '../setup-fields';
import { Badge, Button, Field } from './ui';

// Both entry points save a model AND apply a published assistant to the selected store.
export function AssistantModelSettings({
  data,
  disabled = false,
  onEditingChange,
  onAdvanced,
}: {
  data: OnboardingState;
  disabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onAdvanced: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(defaultModel);
  const [modelId, setModelId] = useState(data.agent.modelId || data.models[0]?.id || '');
  const [addModel, setAddModel] = useState(!data.models.length);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState('');
  const [saved, setSaved] = useState(false);
  const canConfigure = data.agent.canConfigure || data.agent.canChangeModel;
  const showingForm = canConfigure && (!data.agent.ready || editing);
  useEffect(() => {
    if (!canConfigure) setEditing(false);
  }, [canConfigure]);
  useEffect(() => {
    onEditingChange?.(editing || !!busy);
    return () => onEditingChange?.(false);
  }, [editing, busy, onEditingChange]);
  const run = async (action: string, work: () => Promise<void>) => {
    if (busy || disabled) return;
    setBusy(action);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      await client.invalidateQueries();
      setBusy('');
    }
  };
  return (
    <div className="assistant-model-settings" aria-busy={!!busy}>
      <div className="assistant-current">
        <span className="assistant-current-icon">
          <Bot size={23} />
        </span>
        <div>
          <small>
            {data.store?.name} · {data.agent.source === 'default' ? '默认助手' : '客服助手'}
          </small>
          <h2>{data.agent.name || '默认客服助手'}</h2>
          <p>
            {data.agent.model
              ? `当前回复模型：${data.agent.modelName || data.agent.model} · ${data.agent.model}`
              : '选择一个对话模型，让助手开始回答买家问题。'}
          </p>
        </div>
        <Badge tone={data.agent.ready ? 'green' : 'orange'}>
          {data.agent.ready ? '已配置' : '待配置模型'}
        </Badge>
      </div>
      {saved && (
        <p className="model-save-status" role="status">
          <CheckCircle2 size={16} />
          模型已应用到「{data.store?.name}」的客服助手
        </p>
      )}
      {data.agent.modelChanged && (
        <p className="settings-notice">
          模型服务的参数已有更新，当前助手仍使用之前的配置。
          {canConfigure
            ? '点击重新配置模型，再保存一次即可应用最新参数。'
            : '请在 Agent Studio 重新发布助手。'}
        </p>
      )}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      {showingForm ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run('save', async () => {
              if (!data.store) return;
              let chosenId = modelId;
              if (addModel) {
                const profile = await api('models.save', modelSaveInput(draft));
                chosenId = profile.id;
                setModelId(profile.id);
                setAddModel(false);
                setDraft(defaultModel());
              }
              await api('onboarding.configure', {
                storeId: data.store.id,
                modelId: chosenId,
                expectedConfigEpoch: data.store.configEpoch,
              });
              await client.invalidateQueries();
              setEditing(false);
              setTest('');
              setSaved(true);
            });
          }}
        >
          <fieldset disabled={!!busy || disabled}>
            {!!data.models.length && (
              <div className="setup-model-mode" aria-label="模型来源">
                <button
                  type="button"
                  className={!addModel ? 'active' : ''}
                  onClick={() => {
                    setAddModel(false);
                    if (!modelId) setModelId(data.models[0].id);
                  }}
                >
                  使用已有模型
                </button>
                <button
                  type="button"
                  className={addModel ? 'active' : ''}
                  onClick={() => setAddModel(true)}
                >
                  添加模型服务
                </button>
              </div>
            )}
            {addModel ? (
              <ModelFields model={draft} onChange={setDraft} chatOnly />
            ) : (
              <Field label="助手使用的对话模型" hint="选择后点击下方保存，模型才会应用到这家店铺。">
                <select required value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  <option value="">请选择一个模型</option>
                  {data.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.model}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="assistant-apply-note">
              <Sparkles size={17} />
              <p>
                保存后将模型应用到「{data.store?.name}」的回复助手，保留已有提示词和工具配置。
                {data.enabled
                  ? '本店已开启自动接待，新消息将使用更新后的配置。'
                  : '自动接待由下一步单独开启。'}
              </p>
            </div>
            <div className="actions">
              <Button type="submit" disabled={!data.store || (!addModel && !modelId)}>
                {busy === 'save' ? '正在应用…' : '保存并应用到本店助手'}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(defaultModel());
                    setError('');
                  }}
                >
                  取消修改
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      ) : (
        <>
          <p className="setup-note">{data.agent.reason}</p>
          <div className="actions">
            {canConfigure ? (
              <Button
                variant="secondary"
                disabled={!!busy || disabled}
                onClick={() => {
                  setEditing(true);
                  onEditingChange?.(true);
                  setModelId(data.agent.modelId || data.models[0]?.id || '');
                  setAddModel(!data.models.length);
                  setError('');
                  setSaved(false);
                }}
              >
                重新配置模型
              </Button>
            ) : (
              <Button variant="secondary" onClick={onAdvanced}>
                管理自定义助手
              </Button>
            )}
            {data.agent.modelId && (
              <Button
                variant="ghost"
                disabled={!!busy || disabled || data.agent.modelChanged}
                onClick={() =>
                  void run('test', async () => {
                    await api('models.test', { id: data.agent.modelId });
                    setTest('模型连接测试通过');
                  })
                }
              >
                <Play size={14} />
                {busy === 'test' ? '测试中…' : '测试模型连接'}
              </Button>
            )}
          </div>
          {data.agent.modelId && (
            <p className="hint">连接测试可选，点击时会发起一次简短模型请求。</p>
          )}
          {test && (
            <p className="model-save-status" role="status">
              <CheckCircle2 size={15} />
              {test}
            </p>
          )}
        </>
      )}
    </div>
  );
}
