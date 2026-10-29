import { WorkspaceNavigation } from './components/workspace-navigation';
import { StoresPage } from './pages-stores';
import { AccountPage } from './pages-account';
import { ServiceWelcome } from './pages-welcome';
import React, { useEffect, useRef, useState } from 'react';
import type { OnboardingState } from '../../../../packages/core/src/onboarding';
import { SetupGuide, openSetupGuide } from './pages-setup';
import { BrandMark } from './brand-mark';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider, useQuery, keepPreviousData } from '@tanstack/react-query';
import { ArrowUpRight, RefreshCw, Info } from 'lucide-react';
import { api, client, useData, useUi, perform, invalidateLocalData } from './api';
import { Button } from './components/ui';
import { Inbox } from './pages-inbox';
import { Knowledge, Learning } from './pages-knowledge';
import { Skills } from './pages-skills';
import { Agents, Assets, Bindings } from './pages-agents';
import { SettingsPage } from './pages-settings';
import { AgentRuns } from './pages-runs';
import './styles.css';
import './styles-settings.css';
import './styles-workbench.css';
import './styles-product.css';
import './styles-setup.css';
const pageTitles = {
  inbox: '接待中心',
  knowledge: '问答库',
  learning: '学习审核',
  stores: '店铺管理',
  settings: '系统设置',
  account: '云端 AI',
  agents: 'Agent Studio',
  skills: 'Skills',
  toolkits: 'Toolkit',
  workflows: 'Workflow',
  bindings: '工作绑定',
  runs: 'Agent 执行',
  setup: '上手引导',
};
function App() {
  const ui = useUi();
  const { data: state, error, refetch } = useData('app.state');
  const { data: models } = useData<any[]>('models.list');
  const [welcomeDone, setWelcomeDone] = useState(false);
  const [serviceChoiceOpen, setServiceChoiceOpen] = useState(false);
  const { data: stores = [], isSuccess: storesLoaded } = useData<any[]>('stores.list');
  const linkedStores = stores.filter((s) => s.accounts?.length);
  const store = linkedStores.find((s) => s.id === ui.storeId) ?? linkedStores[0];
  const developer = state?.settings?.developerModeEnabled === true;
  const needsWelcome =
    serviceChoiceOpen ||
    (!welcomeDone && !!state && !!models && storesLoaded && !state.settings?.aiSetupMode);
  const {
    data: guide,
    error: guideError,
    refetch: refreshGuide,
    isPlaceholderData: guideRefreshing,
  } = useQuery<OnboardingState>({
    queryKey: ['onboarding.state', { storeId: store?.id }],
    queryFn: () => api('onboarding.state', { storeId: store?.id }),
    placeholderData: keepPreviousData,
  });
  const guideInitialized = useRef(false);
  useEffect(() => {
    if (!guide || guideInitialized.current) return;
    guideInitialized.current = true;
    if (guide.autoOpen) {
      ui.setPage('setup');
      if (guide.guideState !== 'active')
        void perform('app.settings', { setupGuideState: 'active' });
    }
  }, [guide]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const offNotice = window.judesk.onNotice?.((message) => useUi.getState().notify(message));
    const off = window.judesk.onChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void invalidateLocalData(), 150);
    });
    return () => {
      offNotice?.();
      off();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (linkedStores.length && !linkedStores.some((s) => s.id === ui.storeId))
      useUi.setState({ storeId: linkedStores[0].id });
    if (!linkedStores.length && ui.storeId) useUi.setState({ storeId: '' });
  }, [linkedStores, ui.storeId]);
  useEffect(() => {
    if (
      !developer &&
      ['agents', 'skills', 'toolkits', 'workflows', 'bindings', 'runs'].includes(ui.page)
    )
      ui.setPage('inbox');
  }, [developer, ui.page]);
  useEffect(() => {
    if (ui.page !== 'inbox' && ui.conversationId) {
      void perform('conversations.open', { conversationId: null });
      ui.setConversation(null);
    }
  }, [ui.page]);
  useEffect(() => {
    if (state && !ui.conversationId)
      void api('conversations.open', { conversationId: null }).catch(() => {});
  }, [!!state, ui.conversationId]);
  if (needsWelcome)
    return (
      <ServiceWelcome
        hasExistingConfiguration={!!models?.length || !!stores.length}
        savedMode={state?.settings?.aiSetupMode}
        onContinue={() => {
          setWelcomeDone(true);
          setServiceChoiceOpen(false);
        }}
      />
    );
  if (
    !error &&
    (!state || !models || !storesLoaded || !guide || (guide.autoOpen && !guideInitialized.current))
  )
    return (
      <div className="startup">
        <div className="brand-icon">
          <BrandMark size={28} />
        </div>
        <h2>{guideError ? '暂时无法读取配置' : '正在准备你的工作空间'}</h2>
        {guideError && (
          <>
            <p>{guideError.message}</p>
            <Button onClick={() => refreshGuide()}>重新加载</Button>
          </>
        )}
      </div>
    );
  if (ui.page === 'setup' && guide)
    return (
      <>
        <SetupGuide
          data={guide}
          stores={linkedStores}
          refresh={refreshGuide}
          loading={guideRefreshing}
          onChooseAi={() => setServiceChoiceOpen(true)}
        />
        {ui.toast && (
          <div className="toast" role="status">
            <Info size={18} />
            <span>{ui.toast}</span>
          </div>
        )}
      </>
    );
  return (
    <div className="app-shell">
      <WorkspaceNavigation developer={developer} />
      <main className="main">
        <header className="app-titlebar">
          <span>
            工作空间 <i>/</i> {pageTitles[ui.page]}
          </span>
          <span className="app-runtime">
            <span className="status-dot" />
            本地运行
          </span>
        </header>
        {error ? (
          <div className="startup">
            <div className="brand-icon">
              <BrandMark size={28} />
            </div>
            <h2>正在连接本地工作空间</h2>
            <p>{error.message}</p>
            <Button onClick={() => refetch()}>
              <RefreshCw size={15} />
              重新连接
            </Button>
          </div>
        ) : (
          <div className={`page page-${ui.page}`}>
            {ui.page === 'inbox' && guide?.guideState === 'active' && (
              <div className="setup-resume">
                <span>
                  <strong>上手配置尚未完成</strong> · 人工收发测试完成后，返回引导开启 AI 接待。
                </span>
                <Button variant="secondary" onClick={() => void openSetupGuide()}>
                  继续配置
                  <ArrowUpRight size={15} />
                </Button>
              </div>
            )}
            {ui.page === 'account' ? (
              <AccountPage />
            ) : ui.page === 'inbox' ? (
              <Inbox />
            ) : ui.page === 'stores' ? (
              <StoresPage stores={linkedStores} state={state} />
            ) : ui.page === 'knowledge' ? (
              <Knowledge store={store} />
            ) : ui.page === 'learning' ? (
              <Learning key={store?.id} store={store} />
            ) : ui.page === 'agents' ? (
              <Agents />
            ) : ui.page === 'skills' ? (
              <Skills />
            ) : ui.page === 'toolkits' ? (
              <Assets key="toolkit" kind="toolkit" />
            ) : ui.page === 'workflows' ? (
              <Assets key="workflow" kind="workflow" />
            ) : ui.page === 'bindings' ? (
              <Bindings stores={linkedStores} />
            ) : ui.page === 'runs' && developer ? (
              <AgentRuns store={store} />
            ) : (
              <SettingsPage state={state} onChooseAi={() => setServiceChoiceOpen(true)} />
            )}
          </div>
        )}
      </main>
      {ui.toast && (
        <div className="toast" role="status">
          <Info size={18} />
          <span>{ui.toast}</span>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
