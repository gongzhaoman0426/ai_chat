import { KnowledgeAnswer } from './knowledge-answer';
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Send, Sparkles, X } from 'lucide-react';
import { api, client, useUi } from '../api';
import { Button, Badge } from './ui';
import { Attachment } from '../pages-inbox';
import type { KnowledgeAssistResult } from '../../../../../packages/contracts/src/index';

type Proposal = KnowledgeAssistResult['proposals'][number];
type PendingImage = { id: string; name: string };
type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  attachments?: PendingImage[];
  proposals?: Proposal[];
  done?: string[];
  intro?: boolean;
};

const actionLabel: Record<Proposal['action'], string> = {
  create: '新建',
  update: '修改',
  enable: '启用',
  disable: '停用',
  delete: '删除',
};

const introText = (storeId: string | null, storeName: string | undefined, scope: string) => {
  const images = '也可上传一张或多张图片，例如尺码表、规格图或问答截图。';
  if (scope === 'all')
    return `可以说「添加：问…答…」「把发货改成 48 小时」或「停用预售那条」。也可以说「打招呼你好之类的帮我创建或编辑一条」。${images}当前能看到全部问答；新建默认写入通用库。提案需你点确认才会写入。`;
  if (storeId)
    return `用一句话创建或改问答即可，例如「问多久发货，答付款后 48 小时内发出」。也可以说「打招呼你好之类的帮我创建或编辑一条」。${images}当前范围：${storeName || '本店'}。提案需你点确认才会写入。`;
  return `当前是通用问答。可以说「打招呼你好之类的帮我创建或编辑一条」，或「把本店那条你好改成通用」。${images}提案需你点确认才会写入。`;
};

export function KnowledgeChat({
  storeId,
  storeName,
  scope,
}: {
  storeId: string | null;
  storeName?: string;
  scope: 'available' | 'owned' | 'all';
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canSend = !busy && !!(text.trim() || pending.length);
  useEffect(() => {
    setMessages([
      {
        role: 'assistant',
        intro: true,
        text: introText(storeId, storeName, scope),
      },
    ]);
    setText('');
    setPending([]);
  }, [storeId, storeName, scope]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy, pending]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 128)}px`;
  }, [text]);
  const pick = async () => {
    if (busy || pending.length >= 8) return;
    try {
      const rows = await api<PendingImage[]>('attachments.pickMany', { storeId });
      if (!rows?.length) return;
      setPending((current) => {
        const seen = new Set(current.map((item) => item.id));
        const extra = rows.filter((item) => item?.id && !seen.has(item.id));
        return [...current, ...extra].slice(0, 8);
      });
    } catch (e) {
      useUi.getState().notify(e instanceof Error ? e.message : '选图失败');
    }
  };
  const send = async () => {
    const value = text.trim();
    const images = pending;
    if (busy || (!value && !images.length)) return;
    const history = messages
      .filter((m) => !m.intro)
      .slice(-12)
      .map((m) => ({
        role: m.role,
        text:
          m.text || (m.attachments?.length ? `已上传 ${m.attachments.length} 张图片` : '（空）'),
      }));
    const instruction = value || `请根据这${images.length}张图片创建或修改问答对`;
    setText('');
    setPending([]);
    setMessages((rows) => [...rows, { role: 'user', text: value, attachments: images }]);
    setBusy(true);
    try {
      const result = await api<KnowledgeAssistResult>('knowledge.assist', {
        storeId,
        scope,
        text: instruction,
        attachmentIds: images.map((item) => item.id),
        history,
      });
      setMessages((rows) => [
        ...rows,
        { role: 'assistant', text: result.reply, proposals: result.proposals, done: [] },
      ]);
    } catch (e) {
      setMessages((rows) => [
        ...rows,
        {
          role: 'assistant',
          text: e instanceof Error ? e.message : '这次没能理解，请换一种说法。',
        },
      ]);
      setPending((rows) => (rows.length ? rows : images));
    } finally {
      setBusy(false);
    }
  };
  const apply = async (index: number, proposal: Proposal) => {
    if (applying) return;
    setApplying(proposal.key);
    try {
      if (proposal.action === 'create' || proposal.action === 'update') {
        if (!proposal.qa) throw new Error('提案缺少问答内容');
        await api('knowledge.save', {
          storeId: proposal.storeId,
          ...(proposal.action === 'update'
            ? {
                entryId: proposal.entryId,
                expectedRevisionId: proposal.expectedRevisionId,
                expectedStoreId:
                  proposal.expectedStoreId !== undefined
                    ? proposal.expectedStoreId
                    : proposal.storeId,
              }
            : {}),
          qa: proposal.qa,
        });
      } else if (proposal.action === 'delete') {
        await api('knowledge.delete', {
          id: proposal.entryId,
          expectedRevisionId: proposal.expectedRevisionId,
        });
      } else {
        await api('knowledge.status', {
          id: proposal.entryId,
          status: proposal.action === 'enable' ? 'enabled' : 'disabled',
          expectedRevisionId: proposal.expectedRevisionId,
        });
      }
      await client.invalidateQueries();
      useUi.getState().notify(`已${actionLabel[proposal.action]}问答`);
      setMessages((rows) =>
        rows.map((row, i) =>
          i === index ? { ...row, done: [...(row.done || []), proposal.key] } : row,
        ),
      );
    } catch (e) {
      useUi.getState().notify(e instanceof Error ? e.message : '写入失败');
    } finally {
      setApplying('');
    }
  };
  return (
    <aside className="knowledge-chat" aria-label="问答助手">
      <header>
        <span className="knowledge-chat-mark" aria-hidden>
          <Sparkles size={14} />
        </span>
        <div>
          <strong>问答助手</strong>
          <small>可发文字或图片，确认后生效</small>
        </div>
      </header>
      <div className="knowledge-chat-log">
        {messages.map((m, i) => (
          <div key={`${m.role}-${i}`} className={`knowledge-chat-bubble ${m.role}`}>
            {m.text ? <p>{m.text}</p> : null}
            {m.attachments?.length ? (
              <div className="knowledge-chat-thumbs">
                {m.attachments.map((a) => (
                  <div key={a.id} className="knowledge-chat-thumb">
                    <Attachment id={a.id} />
                  </div>
                ))}
              </div>
            ) : null}
            {m.proposals?.map((p) => {
              const done = m.done?.includes(p.key);
              return (
                <div key={p.key} className="knowledge-chat-proposal">
                  <Badge tone={p.action === 'delete' ? 'neutral' : 'green'}>
                    {actionLabel[p.action]}
                  </Badge>
                  <strong>{p.title}</strong>
                  <small>{p.detail}</small>
                  {p.qa?.answerKind === 'image' && p.qa.attachmentId ? (
                    <KnowledgeAnswer qa={p.qa} />
                  ) : null}
                  <Button
                    variant={p.action === 'delete' ? 'danger' : 'secondary'}
                    disabled={done || !!applying}
                    onClick={() => void apply(i, p)}
                  >
                    {done
                      ? '已写入'
                      : applying === p.key
                        ? '写入中…'
                        : `确认${actionLabel[p.action]}`}
                  </Button>
                </div>
              );
            })}
          </div>
        ))}
        {busy && <p className="muted">正在理解你的要求…</p>}
        <div ref={end} />
      </div>
      <form
        className="knowledge-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="knowledge-chat-box">
          {pending.length > 0 && (
            <div className="knowledge-chat-thumbs">
              {pending.map((a) => (
                <div key={a.id} className="knowledge-chat-thumb">
                  <Attachment id={a.id} />
                  <button
                    type="button"
                    aria-label={`移除 ${a.name || '图片'}`}
                    disabled={busy}
                    onClick={() => setPending((rows) => rows.filter((row) => row.id !== a.id))}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={2}
            value={text}
            disabled={busy}
            placeholder="用一句话说要创建或修改的问答，也可先贴图"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="knowledge-chat-tools">
            <button
              type="button"
              className="knowledge-chat-icon"
              disabled={busy || pending.length >= 8}
              title="上传图片，可多选"
              aria-label="上传图片，可多选"
              onClick={() => void pick()}
            >
              <ImagePlus size={16} />
            </button>
            <small>{pending.length ? `${pending.length}/8 张图` : 'Enter 发送'}</small>
            <button
              type="submit"
              className="knowledge-chat-send"
              disabled={!canSend}
              aria-label="发送"
              title="发送"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </form>
    </aside>
  );
}
