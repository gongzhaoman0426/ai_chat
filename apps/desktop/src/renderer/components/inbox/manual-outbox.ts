import { create } from 'zustand';
import type { ManualOutbound } from '../../../../../../packages/contracts/src/index';
import { api, client } from '../../api';

// Keep optimistic intents across conversation/page switches until SQLite has caught up.
export const useManualOutbox = create<{
  pending: Record<string, ManualOutbound>;
  put: (outbound: ManualOutbound) => void;
  forget: (intentKeys: string[]) => void;
}>((set) => ({
  pending: {},
  put: (outbound) => set((s) => ({ pending: { ...s.pending, [outbound.intentKey]: outbound } })),
  forget: (keys) =>
    set((s) => {
      if (!keys.some((key) => key in s.pending)) return s;
      const pending = { ...s.pending };
      for (const key of keys) delete pending[key];
      return { pending };
    }),
}));

export function submitManualText(input: {
  requestId: string;
  conversationId: string;
  storeId: string;
  text: string;
}) {
  const optimistic: ManualOutbound = {
    id: `local:${input.requestId}`,
    intentKey: `manual:${input.requestId}`,
    conversationId: input.conversationId,
    storeId: input.storeId,
    body: { text: input.text },
    status: 'prepared',
    externalId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  useManualOutbox.getState().put(optimistic);
  // Do not await invalidation: acknowledgement only means the local intent was saved.
  return api<ManualOutbound>('messages.send', {
    conversationId: input.conversationId,
    text: input.text,
    requestId: input.requestId,
  })
    .then((outbound) => {
      useManualOutbox.getState().put(outbound);
      return outbound;
    })
    .catch((error: unknown) => {
      // A lost IPC reply can follow a successful commit. Preserve the request identity
      // and never automatically resend, or claim that the platform rejected it.
      useManualOutbox.getState().put({
        ...optimistic,
        status: 'unknown',
        error: `提交结果待确认：${error instanceof Error ? error.message : '本地服务未返回结果'}`,
      });
    })
    .finally(() => {
      void client.invalidateQueries({
        queryKey: ['conversations.outbounds', { conversationId: input.conversationId }],
      });
      void client.invalidateQueries({
        queryKey: ['conversations.messages', { conversationId: input.conversationId }],
      });
      void client.invalidateQueries({ queryKey: ['outbound.list'] });
    });
}

type TimelineMessage = {
  id: string;
  externalId?: string;
  conversationId: string;
  storeId?: string;
  direction: string;
  origin: string;
  kind: string;
  text: string;
  attachmentId?: string | null;
  timestamp: string | Date;
  withdrawn?: boolean;
  associationStatus?: string;
  raw?: {
    confirmedOutboundId?: string;
    richContent?: import('../../../../../../packages/contracts/src/commerce-extra').RichContent;
  };
  delivery?: ManualOutbound;
};
export function mergeManualTimeline(
  messages: TimelineMessage[],
  outbounds: ManualOutbound[],
  local: ManualOutbound[],
): TimelineMessage[] {
  const sends = new Map(local.map((o) => [o.intentKey, o]));
  // Durable rows win over optimistic / IPC results, including late confirmations.
  for (const outbound of outbounds) sends.set(outbound.intentKey, outbound);
  const actual = new Map(messages.map((m) => [m.id, m]));
  const byExternal = new Map(
    [...actual.values()]
      .filter((m) => m.direction === 'out' && m.externalId)
      .map((m) => [m.externalId!, m]),
  );
  const byOutbound = new Map(
    [...actual.values()]
      .filter((m) => m.direction === 'out' && m.raw?.confirmedOutboundId)
      .map((m) => [m.raw!.confirmedOutboundId!, m]),
  );
  const timeline: TimelineMessage[] = [];
  for (const outbound of sends.values()) {
    const confirmed =
      (outbound.externalId ? byExternal.get(outbound.externalId) : undefined) ??
      byOutbound.get(outbound.id);
    if (confirmed) actual.delete(confirmed.id);
    timeline.push({
      ...confirmed,
      id: outbound.intentKey,
      conversationId: outbound.conversationId,
      storeId: outbound.storeId,
      direction: 'out',
      origin: 'human',
      kind: outbound.body.richContent?.kind ?? (outbound.body.attachmentId ? 'image' : 'text'),
      raw: {
        ...confirmed?.raw,
        ...(outbound.body.richContent ? { richContent: outbound.body.richContent } : {}),
      },
      text: outbound.body.text,
      attachmentId: outbound.body.attachmentId,
      timestamp: outbound.createdAt,
      delivery: confirmed
        ? {
            ...outbound,
            status: 'confirmed',
            externalId: confirmed.externalId ?? outbound.externalId,
            error: null,
          }
        : outbound,
    });
  }
  return [...actual.values(), ...timeline].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() || a.id.localeCompare(b.id),
  );
}
