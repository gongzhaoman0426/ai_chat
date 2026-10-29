import { useState } from 'react';
import { Plus, ArrowUpRight, Store } from 'lucide-react';
import { useData, useUi } from './api';
import { Button, Empty } from './components/ui';
import { ConnectPlatformDialog } from './setup-fields';
import { StoreReceptionSettings } from './components/store-reception-settings';
import { PlatformMark } from './components/inbox/shop-list';
import { platformNames, type PlatformId } from '../../../../packages/contracts/src/platform';
export function StoresPage({ stores, state }: { stores: any[]; state: any }) {
  const ui = useUi();
  const [connecting, setConnecting] = useState(false);
  const { data: models = [] } = useData<any[]>('models.list');
  const store = stores.find((s) => s.id === ui.storeId) ?? stores[0];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>店铺管理</h1>
          <p>连接平台账号，为每家店铺配置助手和接待方式。</p>
        </div>
        <Button onClick={() => setConnecting(true)}>
          <Plus size={16} />
          连接店铺
        </Button>
      </div>
      <div className="store-management page-body">
        <aside className="management-shop-list" aria-label="选择配置店铺">
          <span className="management-list-label">已连接的店铺 · {stores.length}</span>
          {stores.map((s) => (
            <button key={s.id} aria-pressed={store?.id === s.id} onClick={() => ui.setStore(s.id)}>
              <PlatformMark platform={s.platform} />
              <span>
                <strong>{s.name}</strong>
                <small>
                  {s.accounts.some((a: any) => a.status === 'online') ? '账号已连接' : '账号未连接'}
                </small>
              </span>
            </button>
          ))}
          {!stores.length && <p className="hint">尚未添加店铺</p>}
        </aside>
        <div className="management-shop-detail settings-body">
          {store ? (
            <>
              <div className="management-shop-heading">
                <div>
                  <h2>{store.name}</h2>
                  <p>
                    {platformNames[store.platform as PlatformId]} · {store.accounts.length}{' '}
                    个客服账号
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    ui.setInboxStore(store.id);
                    ui.setPage('inbox');
                  }}
                >
                  查看会话
                  <ArrowUpRight size={15} />
                </Button>
              </div>
              <StoreReceptionSettings
                key={`${store.id}:${ui.storeSettingsStep}`}
                initialStep={ui.storeSettingsStep}
                store={store}
                models={models}
                developerMode={state?.settings?.developerModeEnabled === true}
                defaultModelId={state?.settings?.defaultModelId}
                management
              />
            </>
          ) : (
            <Empty
              icon={<Store size={32} />}
              action={<Button onClick={() => setConnecting(true)}>连接第一家店铺</Button>}
            >
              <h2>先连接你的店铺</h2>
              <p>选择平台并登录客服账号，自动识别店铺后继续配置。</p>
            </Empty>
          )}
        </div>
      </div>
      <ConnectPlatformDialog open={connecting} onClose={() => setConnecting(false)} />
    </>
  );
}
