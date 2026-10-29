import { create } from 'zustand';
import type { SetStateAction } from 'react';
type Draft = { text: string; attachment: any };
const empty: Draft = { text: '', attachment: null };
const useDrafts = create<{
  drafts: Record<string, Draft>;
  patch: (key: string, field: keyof Draft, value: SetStateAction<any>) => void;
}>((set) => ({
  drafts: {},
  patch: (key, field, value) =>
    set((s) => {
      const previous = s.drafts[key] ?? empty;
      return {
        drafts: {
          ...s.drafts,
          [key]: {
            ...previous,
            [field]: typeof value === 'function' ? value(previous[field]) : value,
          },
        },
      };
    }),
}));
export function useComposerDraft(key: string) {
  const draft = useDrafts((s) => s.drafts[key] ?? empty);
  return {
    ...draft,
    setText: (value: SetStateAction<string>) => useDrafts.getState().patch(key, 'text', value),
    setAttachment: (value: SetStateAction<any>) =>
      useDrafts.getState().patch(key, 'attachment', value),
  };
}
