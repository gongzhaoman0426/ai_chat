import type { Engine } from './engine';
import { getAutoReplyReadiness } from '../../contracts/src/index';
import { errorText } from './util';

// Progress is derived from saved business state, never from a client-side checklist.
export async function onboardingState(engine: Engine, requestedStoreId?: string) {
  const { db } = engine;
  const [stores, models, embeddingModels, preference, embeddingSetting] = await Promise.all([
    db.store.findMany({
      where: { accounts: { some: {} } },
      include: { accounts: true, replyPolicy: true, learningPolicy: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.modelProfile.findMany({
      where: { kind: 'chat' },
      select: { id: true, name: true, model: true, revision: true },
      orderBy: { name: 'asc' },
    }),
    db.modelProfile.findMany({
      where: { kind: 'embedding' },
      select: { id: true, name: true, model: true, dimensions: true, revision: true },
      orderBy: { name: 'asc' },
    }),
    db.appSetting.findUnique({ where: { key: 'setupGuideState' } }),
    db.appSetting.findUnique({ where: { key: 'embeddingProfileId' } }),
  ]);
  const store = requestedStoreId ? stores.find((s) => s.id === requestedStoreId) : stores[0];
  let agent: {
    ready: boolean;
    canConfigure: boolean;
    canChangeModel?: boolean;
    name?: string;
    modelId?: string;
    model?: string;
    modelName?: string;
    modelChanged?: boolean;
    source?: 'default' | 'store';
    reason: string;
  } = {
    ready: false,
    canConfigure: true,
    reason: '选择一个对话模型，即可配置这家店铺的基础客服助手。',
  };
  if (store) {
    try {
      const resolved = await engine.agents.resolve(store.id);
      if (resolved) {
        const definition = await db.agentDefinition.findUniqueOrThrow({
          where: { id: resolved.revision.agentId },
        });
        const canChangeModel = await engine.agents.canChangeStarterModel(
          store.id,
          resolved.revision.id,
        );
        const profile = models.find((model) => model.id === resolved.config.modelProfileId);
        agent = {
          ready: !!resolved.config.modelSnapshot,
          canConfigure: canChangeModel && !resolved.config.modelSnapshot,
          canChangeModel,
          name: definition.name,
          source: resolved.binding.scopeKey === 'global' ? 'default' : 'store',
          modelId: resolved.config.modelProfileId ?? undefined,
          modelName:
            typeof resolved.config.modelSnapshot?.name === 'string'
              ? resolved.config.modelSnapshot.name
              : undefined,
          modelChanged:
            !!resolved.config.modelSnapshot &&
            profile?.revision !== resolved.config.modelSnapshot.revision,
          model:
            typeof resolved.config.modelSnapshot?.model === 'string'
              ? resolved.config.modelSnapshot.model
              : undefined,
          reason: !canChangeModel
            ? '此助手由高级配置管理，或有待发布修改、共用绑定。请在 Agent Studio 修改模型并发布。'
            : resolved.binding.scopeKey === 'global'
              ? '当前使用默认助手。在这里更换模型后，将为本店单独应用。'
              : '模型已应用到这家店铺的客服助手，后续回复使用这里的配置。',
        };
      }
    } catch (error) {
      agent = {
        ready: false,
        canConfigure: false,
        reason: `已有工作助手需要修复：${errorText(error)}。请到高级定制检查，完成后返回引导。`,
      };
    }
  }
  const connected = getAutoReplyReadiness(
    (store?.accounts ?? []).map((account) => ({ ...account, verifiedAt: true })),
  ).ready;
  const readiness = getAutoReplyReadiness(store?.accounts ?? []);
  const enabled = !!store?.replyPolicy?.autoReplyEnabled;
  const ready = connected && readiness.ready && agent.ready;
  const guideState = typeof preference?.value === 'string' ? preference.value : null;
  const selectedEmbeddingId =
    typeof embeddingSetting?.value === 'string' ? embeddingSetting.value : undefined;
  const embeddingProfile = embeddingModels.find((model) => model.id === selectedEmbeddingId);
  const embedding = {
    ready: !!embeddingProfile,
    profileId: embeddingProfile?.id,
    name: embeddingProfile?.name,
    model: embeddingProfile?.model,
    dimensions: embeddingProfile?.dimensions ?? undefined,
  };
  return {
    guideState,
    autoOpen: guideState === 'active' || (!guideState && !stores.length),
    store: store
      ? {
          id: store.id,
          name: store.name,
          configEpoch: store.replyConfigEpoch,
          autoLearnEnabled: !!store.learningPolicy?.autoLearnEnabled,
        }
      : null,
    models,
    embeddingModels,
    embedding,
    agent,
    connected,
    readiness,
    enabled,
    ready,
    nextStep: !connected ? 1 : !agent.ready && !embedding.ready ? 2 : !agent.ready ? 3 : 4,
    completedSteps: Number(connected) + Number(agent.ready) + Number(ready && enabled),
  };
}
export type OnboardingState = Awaited<ReturnType<typeof onboardingState>>;
