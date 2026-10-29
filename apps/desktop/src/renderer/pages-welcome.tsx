import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api, client } from './api';
import { BrandMark } from './brand-mark';
import { Button } from './components/ui';
import { defaultModel, ModelFields, modelSaveInput } from './setup-fields';
import './styles-welcome.css';

export function ServiceWelcome({
  onContinue,
  hasExistingConfiguration = false,
  savedMode,
}: {
  onContinue: () => void;
  hasExistingConfiguration?: boolean;
  savedMode?: 'own' | 'later';
}) {
  const [model, setModel] = useState(defaultModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function complete(choice: 'own' | 'later', modelId?: string) {
    await api('app.settings', {
      aiSetupMode: choice,
      ...(modelId ? { defaultModelId: modelId } : {}),
    });
    await client.invalidateQueries();
    onContinue();
  }

  return (
    <div className="service-welcome">
      <div className="service-welcome-content">
        <header className="service-welcome-heading">
          <span className="brand-icon">
            <BrandMark size={28} />
          </span>
          <h1>连接你的模型服务</h1>
          <p>
            填写任意 OpenAI 兼容接口的地址、密钥与模型名称，支持 OpenAI、DeepSeek、通义千问、Ollama
            等。用量由你选择的服务商计费。
          </p>
        </header>
        <form
          className="service-own-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            try {
              const saved = await api('models.save', modelSaveInput(model));
              await complete('own', saved.id);
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存失败，请重试');
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy}>
            <ModelFields model={model} onChange={setModel} chatOnly />
            <div className="modal-actions">
              <Button type="submit">
                {busy ? '正在保存…' : '保存并进入工作空间'} <ArrowRight size={15} />
              </Button>
            </div>
          </fieldset>
        </form>
        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}
        <div className="service-skip">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await complete(savedMode ?? 'later');
              } catch (e) {
                setError(e instanceof Error ? e.message : '暂时无法进入，请重试');
              } finally {
                setBusy(false);
              }
            }}
          >
            {hasExistingConfiguration ? '保留现有配置，继续使用' : '稍后配置，先使用人工接待'}
          </Button>
        </div>
      </div>
    </div>
  );
}
