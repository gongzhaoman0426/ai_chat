import { useEffect, useState } from 'react';
import { ListRestart, ShieldCheck } from 'lucide-react';
import { api, client, useAvailablePlatforms, useUi } from './api';
import { platformNames } from '../../../../packages/contracts/src/platform';
import { QianniuSetup } from './components/qianniu-setup';
import { Button, Field, Modal } from './components/ui';

export const defaultModel = () => ({
  name: '客服对话模型',
  kind: 'chat',
  provider: 'openai',
  model: '',
  baseUrl: '',
  apiKey: '',
  dimensions: undefined as number | undefined,
  maxTokens: 2048,
  timeoutMs: 60000,
});
export const defaultEmbeddingModel = () => ({
  ...defaultModel(),
  name: '问答向量模型',
  kind: 'embedding',
});
// Suggestions only: any OpenAI-compatible base URL can be typed in.
const baseUrlHints = [
  ['https://api.openai.com/v1', 'OpenAI'],
  ['https://api.deepseek.com/v1', 'DeepSeek'],
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', '通义千问'],
  ['https://open.bigmodel.cn/api/paas/v4', '智谱 GLM'],
  ['https://ark.cn-beijing.volces.com/api/v3', '火山方舟'],
  ['http://127.0.0.1:11434/v1', 'Ollama 本地'],
];
export function modelSaveInput(model: any) {
  return {
    id: model.id,
    name: model.name.trim() || '客服对话模型',
    kind: model.kind,
    provider: model.provider,
    model: model.model.trim(),
    baseUrl: model.baseUrl.trim(),
    apiKey: model.apiKey || undefined,
    dimensions: model.kind === 'embedding' ? model.dimensions : undefined,
    maxTokens: model.maxTokens,
    timeoutMs: model.timeoutMs,
  };
}
export function ModelFields({
  model,
  onChange,
  chatOnly = false,
  embeddingOnly = false,
}: {
  model: any;
  onChange: (value: any) => void;
  chatOnly?: boolean;
  embeddingOnly?: boolean;
}) {
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const listId = `model-ids-${model.kind}`;
  async function discover() {
    setDiscovering(true);
    setDiscoverError('');
    try {
      const ids = await api<string[]>('models.discover', {
        id: model.id,
        baseUrl: model.baseUrl.trim(),
        apiKey: model.apiKey || undefined,
      });
      setRemoteModels(ids);
      if (!model.model && ids.length === 1) onChange({ ...model, model: ids[0] });
    } catch (e) {
      setRemoteModels([]);
      setDiscoverError(e instanceof Error ? e.message : '获取模型列表失败');
    } finally {
      setDiscovering(false);
    }
  }
  return (
    <div className="form-grid model-fields">
      {!chatOnly && !embeddingOnly && (
        <Field label="类型" hint="日常接待选择对话模型；向量模型用于可选的问答检索。">
          <select
            value={model.kind}
            onChange={(e) =>
              onChange({
                ...model,
                kind: e.target.value,
                dimensions: e.target.value === 'embedding' ? model.dimensions : undefined,
              })
            }
          >
            <option value="chat">对话模型 · 回复与学习</option>
            <option value="embedding">向量模型 · 问答检索</option>
          </select>
        </Field>
      )}
      <p className="model-fields-intro">
        从模型服务商的控制台获取以下三项信息，使用 OpenAI 兼容接口。
      </p>
      <Field label="API Base URL" hint="复制模型服务商提供的兼容接口地址，通常以 /v1 结尾。">
        <input
          type="url"
          placeholder="https://api.example.com/v1"
          list="model-base-url-hints"
          value={model.baseUrl}
          onChange={(e) => onChange({ ...model, baseUrl: e.target.value })}
          required
        />
        <datalist id="model-base-url-hints">
          {baseUrlHints.map(([url, label]) => (
            <option key={url} value={url} label={label} />
          ))}
        </datalist>
      </Field>
      <Field
        label="API Key"
        hint={
          model.hasKey ? '留空保留已保存的密钥。' : '填入服务商提供的密钥；本地无鉴权服务可留空。'
        }
      >
        <input
          type="password"
          autoComplete="new-password"
          placeholder={model.hasKey ? '已保存，留空不更改' : '输入你的 API Key'}
          value={model.apiKey}
          onChange={(e) => onChange({ ...model, apiKey: e.target.value })}
        />
      </Field>
      <Field
        label="模型标识"
        hint={
          discoverError ||
          (remoteModels.length
            ? `已获取 ${remoteModels.length} 个模型，输入时可从列表选择。`
            : '与服务商控制台中的 model ID 保持一致，也可以从服务商获取列表。')
        }
      >
        <div className="model-id-row">
          <input
            placeholder="填写服务商的 model ID"
            list={listId}
            value={model.model}
            onChange={(e) => onChange({ ...model, model: e.target.value })}
            required
          />
          <Button
            type="button"
            variant="secondary"
            disabled={discovering || !/^https?:\/\/./.test(model.baseUrl.trim())}
            onClick={() => void discover()}
          >
            <ListRestart size={15} />
            {discovering ? '获取中…' : '获取模型列表'}
          </Button>
        </div>
        <datalist id={listId}>
          {remoteModels.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      </Field>
      {model.kind === 'embedding' && (
        <Field
          label="向量维度"
          hint="与服务商提供的向量维度一致。豆包 doubao-embedding-vision 常见 2048 或 1024。"
        >
          <input
            type="number"
            min={1}
            value={model.dimensions || ''}
            onChange={(e) => onChange({ ...model, dimensions: Number(e.target.value) })}
            required
          />
        </Field>
      )}
      <details className="settings-advanced">
        <summary>
          更多模型设置 <span>名称、输出长度与超时 · 通常保留默认值</span>
        </summary>
        <div className="form-two">
          <Field label="名称">
            <input
              value={model.name}
              onChange={(e) => onChange({ ...model, name: e.target.value })}
            />
          </Field>
        </div>
        <div className="form-two">
          <Field label="输出 token 上限">
            <input
              type="number"
              min={1}
              value={model.maxTokens}
              onChange={(e) => onChange({ ...model, maxTokens: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="超时（秒）"
            hint="单轮模型调用（含该轮工具）的等待上限；深度思考模型建议 120 秒以上。"
          >
            <input
              type="number"
              min={1}
              value={model.timeoutMs / 1000}
              onChange={(e) => onChange({ ...model, timeoutMs: Number(e.target.value) * 1000 })}
            />
          </Field>
        </div>
      </details>
    </div>
  );
}
export function AccountVerificationDialog({
  account,
  onClose,
  onVerified,
}: {
  account: any;
  onClose: () => void;
  onVerified?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      open={!!account}
      onOpenChange={(open) => !open && !busy && onClose()}
      title="确认账号可以正常接待"
      description="先用测试会话确认收发正常，再允许这个账号自动回复。"
    >
      <ol className="verify-steps">
        <li>
          <strong>收到消息</strong>
          <span>用测试买家发一条消息，确认接待中心能看到。</span>
        </li>
        <li>
          <strong>人工发出回复</strong>
          <span>在句达回复一次，确认买家端收到，句达显示发送成功。</span>
        </li>
        <li>
          <strong>确认平台同步</strong>
          <span>在平台原聊天页人工回复一次，确认句达能同步看到。图片功能需另外实测。</span>
        </li>
      </ol>
      <p className="hint">点击确认后会检查当前账号身份与消息通道。自动回复仍由你在最后一步开启。</p>
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          稍后验证
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api('accounts.verify', { accountId: account.id });
              await client.invalidateQueries();
              useUi.getState().notify('本账号验收已记录');
              onVerified?.();
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : '接入检查失败，请重试');
            } finally {
              setBusy(false);
            }
          }}
        >
          <ShieldCheck size={15} />
          {busy ? '正在检查…' : '已在测试会话完成验证'}
        </Button>
      </div>
    </Modal>
  );
}

export function ConnectPlatformDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [qianniu, setQianniu] = useState(false);
  const platforms = useAvailablePlatforms(open);
  useEffect(() => {
    if (!open) {
      setQianniu(false);
      setError('');
    }
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={(value) => !value && !busy && onClose()}
      title={qianniu ? '连接千牛店铺' : '连接店铺'}
      description={
        qianniu
          ? '按以下步骤准备客户端，登录后自动连接消息。'
          : '选择店铺所在的平台，在平台窗口完成登录。每个账号保留独立登录状态。'
      }
    >
      <div className="form-grid">
        {qianniu ? (
          <>
            <Button variant="ghost" onClick={() => setQianniu(false)}>
              返回平台选择
            </Button>
            <QianniuSetup enabled={open} />
          </>
        ) : (
          platforms.map((platform) => (
            <Button
              key={platform}
              variant="secondary"
              disabled={!!busy}
              onClick={async () => {
                if (platform === 'qianniu') {
                  setQianniu(true);
                  return;
                }
                setBusy(platform);
                setError('');
                try {
                  await api('accounts.connect', { platform });
                  onClose();
                } catch (e) {
                  setError(e instanceof Error ? e.message : '打开平台失败');
                } finally {
                  setBusy('');
                }
              }}
            >
              {busy === platform ? '正在打开…' : `登录${platformNames[platform]}`}
            </Button>
          ))
        )}
        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
