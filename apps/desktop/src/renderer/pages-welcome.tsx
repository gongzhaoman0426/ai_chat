import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Cloud, KeyRound } from 'lucide-react';
import { api, client, useData } from './api';
import { BrandMark } from './brand-mark';
import { Button } from './components/ui';
import { AccountPage } from './pages-account';
import { defaultModel, ModelFields, modelSaveInput } from './setup-fields';
import './styles-cloud.css';

export function ServiceWelcome({
  onContinue,
  hasExistingConfiguration = false,
  savedMode,
}: {
  onContinue: () => void;
  hasExistingConfiguration?: boolean;
  savedMode?: 'own' | 'cloud' | 'later';
}) {
  const [mode, setMode] = useState<'choose' | 'own' | 'cloud'>('choose');
  const [model, setModel] = useState(defaultModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data: account } = useData('license.state');
  // Loading / missing state must not look like Pro. Only unlock when cloud is
  // truly absent, or the server says BYOK is allowed.
  const canUseByok = !!account && (!account.configured || !!account.canUseByok);

  async function complete(choice: 'own' | 'cloud' | 'later', modelId?: string) {
    await api('app.settings', {
      aiSetupMode: choice,
      ...(modelId ? { defaultModelId: modelId } : {}),
    });
    await client.invalidateQueries();
    onContinue();
  }

  if (mode === 'cloud')
    return (
      <div className="service-welcome service-welcome-cloud">
        <div className="service-welcome-back">
          <Button variant="ghost" onClick={() => setMode('choose')}>
            <ArrowLeft size={16} /> 返回选择
          </Button>
        </div>
        <AccountPage onContinue={onContinue} onUseOwn={() => setMode(canUseByok ? 'own' : 'cloud')} />
      </div>
    );

  return (
    <div className="service-welcome">
      <div className="service-welcome-content">
        <header className="service-welcome-heading">
          <span className="brand-icon">
            <BrandMark size={28} />
          </span>
          <span className="service-free-label">句达 · 软件功能免费</span>
          <h1>{mode === 'choose' ? '选一种方式，让 AI 开始工作' : '连接你自己的模型服务'}</h1>
          <p>
            {mode === 'choose'
              ? '多店铺接待、自动学习和高级定制全部开放。自有 API Key 需句达 Pro；也可直接使用云端按量 AI。'
              : '填写接口地址、密钥与模型名称。用量由你选择的服务商计费。'}
          </p>
        </header>
        {mode === 'choose' ? (
          <>
            <div className="service-choice-grid">
              <button
                className="service-choice"
                onClick={() => {
                  if (canUseByok) setMode('own');
                  else setMode('cloud');
                }}
              >
                <span className="service-choice-icon">
                  <KeyRound size={25} />
                </span>
                <h2>使用自己的 API Key</h2>
                <p>
                  {canUseByok
                    ? '已有模型服务或本地模型，直接填写接口地址、密钥与模型名称。'
                    : '需要登录并开通句达 Pro 后，才能配置自有 API Key。'}
                </p>
                <span className="service-choice-benefit">
                  <Check size={15} /> {canUseByok ? 'Pro 已解锁' : '需开通 Pro'}
                </span>
                <strong>
                  {canUseByok ? '设置自己的模型' : '去开通 Pro'} <ArrowRight size={17} />
                </strong>
              </button>
              <button className="service-choice" onClick={() => setMode('cloud')}>
                <span className="service-choice-icon">
                  <Cloud size={25} />
                </span>
                <h2>注册账号，使用云端 AI</h2>
                <p>无需申请模型密钥，登录后云端模型自动加入可用列表，充值余额并按实际用量付费。</p>
                <span className="service-choice-benefit">
                  <Check size={15} /> 价格透明，用量可查
                </span>
                <strong>
                  注册或登录云端账号 <ArrowRight size={17} />
                </strong>
              </button>
            </div>
            <p className="service-choice-footer">
              {hasExistingConfiguration
                ? '已保存的店铺、模型和助手配置会保留。两种 AI 服务可随时切换。'
                : '两种方式可随时在「系统设置」与「云端 AI」中切换。'}
            </p>
          </>
        ) : (
          <form
            className="license-card service-own-form"
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
                <Button type="button" variant="ghost" onClick={() => setMode('choose')}>
                  <ArrowLeft size={15} /> 返回选择
                </Button>
                <Button type="submit">
                  {busy ? '正在保存…' : '保存并进入工作空间'} <ArrowRight size={15} />
                </Button>
              </div>
            </fieldset>
          </form>
        )}
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
