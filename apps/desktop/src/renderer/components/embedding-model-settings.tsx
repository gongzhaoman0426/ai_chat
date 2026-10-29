import { useState } from 'react';
import { CheckCircle2, Play, ScanSearch } from 'lucide-react';
import type { OnboardingState } from '../../../../../packages/core/src/onboarding';
import { api, client } from '../api';
import { defaultEmbeddingModel, ModelFields, modelSaveInput } from '../setup-fields';
import { Badge, Button, Field } from './ui';

export function EmbeddingModelSettings({
  data,
  disabled = false,
}: {
  data: OnboardingState;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(!data.embedding.ready);
  const [draft, setDraft] = useState(defaultEmbeddingModel);
  const [modelId, setModelId] = useState(
    data.embedding.profileId || data.embeddingModels[0]?.id || '',
  );
  const [addModel, setAddModel] = useState(!data.embeddingModels.length);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState('');
  const [saved, setSaved] = useState(false);
  const showingForm = editing || !data.embedding.ready;
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
          <ScanSearch size={23} />
        </span>
        <div>
          <small>全局配置 · 全店共用</small>
          <h2>{data.embedding.name || '问答检索模型'}</h2>
          <p>
            {data.embedding.model
              ? `当前向量模型：${data.embedding.name || data.embedding.model} · ${data.embedding.model}${
                  data.embedding.dimensions ? ` · ${data.embedding.dimensions} 维` : ''
                }`
              : '按含义匹配已生效问答。不负责生成回复，云端登录后会自动加入可用模型。'}
          </p>
        </div>
        <Badge tone={data.embedding.ready ? 'green' : 'orange'}>
          {data.embedding.ready ? '已配置' : '待配置'}
        </Badge>
      </div>
      {saved && (
        <p className="model-save-status" role="status">
          <CheckCircle2 size={16} />
          已设为全局问答检索模型，切换后会后台重建知识索引
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
              let chosenId = modelId;
              if (addModel) {
                const profile = await api('models.save', modelSaveInput(draft));
                chosenId = profile.id;
                setModelId(profile.id);
                setAddModel(false);
                setDraft(defaultEmbeddingModel());
              }
              await api('app.settings', { embeddingProfileId: chosenId });
              await client.invalidateQueries();
              setEditing(false);
              setTest('');
              setSaved(true);
            });
          }}
        >
          <fieldset disabled={!!busy || disabled}>
            {!!data.embeddingModels.length && (
              <div className="setup-model-mode" aria-label="向量模型来源">
                <button
                  type="button"
                  className={!addModel ? 'active' : ''}
                  onClick={() => {
                    setAddModel(false);
                    if (!modelId) setModelId(data.embeddingModels[0].id);
                  }}
                >
                  使用已有模型
                </button>
                <button
                  type="button"
                  className={addModel ? 'active' : ''}
                  onClick={() => setAddModel(true)}
                >
                  添加自有向量模型
                </button>
              </div>
            )}
            {addModel ? (
              <ModelFields model={draft} onChange={setDraft} embeddingOnly />
            ) : (
              <Field label="全局问答检索模型" hint="保存后全店共用。对话模型在下一步单独配置。">
                <select required value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  <option value="">请选择一个向量模型</option>
                  {data.embeddingModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · {model.model}
                      {model.dimensions ? ` · ${model.dimensions} 维` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="assistant-apply-note">
              <ScanSearch size={17} />
              <p>
                云端模型登录后会自动出现在列表里，选中保存即可。没配也能继续配置助手，相近问法不会走语义直答。
              </p>
            </div>
            <div className="actions">
              <Button type="submit" disabled={!addModel && !modelId}>
                {busy === 'save' ? '正在保存…' : '保存为全局检索模型'}
              </Button>
              {data.embedding.ready && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(defaultEmbeddingModel());
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
          <p className="setup-note">
            这是全店共用的检索模型，不生成回复。下一步再给客服助手接对话模型。
          </p>
          <div className="actions">
            <Button
              variant="secondary"
              disabled={!!busy || disabled}
              onClick={() => {
                setEditing(true);
                setModelId(data.embedding.profileId || data.embeddingModels[0]?.id || '');
                setAddModel(!data.embeddingModels.length);
                setError('');
                setSaved(false);
              }}
            >
              重新配置向量模型
            </Button>
            {data.embedding.profileId && (
              <Button
                variant="ghost"
                disabled={!!busy || disabled}
                onClick={() =>
                  void run('test', async () => {
                    await api('models.test', { id: data.embedding.profileId });
                    setTest('向量模型连接测试通过');
                  })
                }
              >
                <Play size={14} />
                {busy === 'test' ? '测试中…' : '测试向量模型'}
              </Button>
            )}
          </div>
          {data.embedding.profileId && (
            <p className="hint">连接测试可选，点击时会发起一次简短向量请求。</p>
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
