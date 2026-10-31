import { RichMessage } from './components/inbox/workbench-extra';
import { ConnectPlatformDialog } from './setup-fields';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  getAutoReplyReadiness,
  type ManualOutbound,
} from '../../../../packages/contracts/src/index';
import {
  Search,
  Plus,
  MessageSquare,
  Send,
  ImagePlus,
  UserRound,
  BookOpen,
  ChevronRight,
  Inbox as InboxIcon,
  ShoppingBag,
  PanelRight,
  AlertCircle,
} from 'lucide-react';
import { useData, useUi, perform, api, client, time, date, statusText } from './api';
import { Button, Badge, Empty, Modal } from './components/ui';
import {
  mergeManualTimeline,
  submitManualText,
  useManualOutbox,
} from './components/inbox/manual-outbox';
import { useComposerDraft } from './components/inbox/composer-drafts';
import { WorkbenchPanel } from './components/inbox/workbench-panel';
import { PlatformMark } from './components/inbox/shop-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DeliveryStatus } from './components/inbox/delivery-status';
export function Inbox() {
  const ui = useUi();
  const [connecting, setConnecting] = useState(false);
  const [changingReception, setChangingReception] = useState(false);
  const [search, setSearch] = useState('');
  const filter = ui.inboxFilter;
  const setFilter = ui.setInboxFilter;
  const [sideOpen, setSideOpen] = useState(false);
  const [wideLayout, setWideLayout] = useState(
    () => window.matchMedia('(min-width: 1280px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const update = () => setWideLayout(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [quickReplies, setQuickReplies] = useState<{ search: string; inline: boolean } | null>(
    null,
  );
  const quickReplyMenuRef = useRef<QuickReplyMenuHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sendingQaId, setSendingQaId] = useState<string | null>(null);
  const [olderState, setOlderState] = useState<{ conversationId: string | null; rows: any[] }>({
    conversationId: null,
    rows: [],
  });
  const older = olderState.conversationId === ui.conversationId ? olderState.rows : [];
  const [more, setMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [associating, setAssociating] = useState<any>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const { data: stores = [] } = useData<any[]>('stores.list');
  const overview = useData<any[]>('workbench.overview');
  const query = useInfiniteQuery({
    queryKey: ['conversations.list', { storeId: ui.inboxStoreId, search, filter }],
    initialPageParam: undefined as { id: string; updatedAt: string } | undefined,
    queryFn: ({ pageParam }) =>
      api<any[]>('conversations.list', {
        storeId: ui.inboxStoreId,
        search,
        filter,
        before: pageParam,
      }),
    getNextPageParam: (rows) =>
      rows.length === 200 ? { id: rows.at(-1).id, updatedAt: rows.at(-1).updatedAt } : undefined,
  });
  const conversations = [
    ...new Map((query.data?.pages.flat() ?? []).map((c) => [c.id, c])).values(),
  ];
  const detail = useData<any>(
    'conversations.get',
    { conversationId: ui.conversationId },
    !!ui.conversationId,
  );
  const conversation = detail.isSuccess
    ? detail.data
    : detail.error
      ? undefined
      : conversations.find((c) => c.id === ui.conversationId);
  // A manual takeover and an AI handoff both pause AI; either way the buyer is with a human.
  const aiPaused = !!(conversation?.openedByHuman || conversation?.awaitingHuman);
  const store = stores.find((s) => s.id === conversation?.storeId) ?? conversation?.store;
  const storeOf = (c: any) => stores.find((s) => s.id === c.storeId);
  const { text, attachment, setText, setAttachment } = useComposerDraft(
    `${conversation?.storeId ?? ''}:${ui.conversationId ?? ''}`,
  );
  const textRef = useRef(text);
  const attachmentRef = useRef(attachment);
  textRef.current = text;
  attachmentRef.current = attachment;
  const {
    data: messages = [],
    error: messageError,
    isPending: loadingMessages,
  } = useData<any[]>(
    'conversations.messages',
    { conversationId: ui.conversationId },
    !!ui.conversationId,
  );
  const { data: outbounds = [] } = useData<ManualOutbound[]>(
    'conversations.outbounds',
    { conversationId: ui.conversationId },
    !!ui.conversationId,
  );
  const localOutbox = useManualOutbox((state) => state.pending);
  const timeline = mergeManualTimeline(
    [...older, ...messages],
    outbounds,
    Object.values(localOutbox).filter((o) => o.conversationId === ui.conversationId),
  );
  const visibleTimeline = timeline.filter((m) => m.kind !== 'system');
  useEffect(() => {
    if (outbounds.length) useManualOutbox.getState().forget(outbounds.map((o) => o.intentKey));
  }, [outbounds, localOutbox]);
  useEffect(() => {
    setMore(true);
    setLoadingOlder(false);
    setAssociating(null);
    setQuickReplies(null);
    setSideOpen(false);
    followBottom.current = true;
  }, [ui.conversationId]);
  useEffect(() => {
    if (overview.data && ui.inboxStoreId && !overview.data.some((s) => s.id === ui.inboxStoreId))
      ui.setInboxStore(null);
  }, [overview.data, ui.inboxStoreId]);
  useEffect(() => {
    const el = bottom.current?.closest('.messages');
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [ui.conversationId, timeline.length]);
  const selectStore = (id: string | null) => {
    ui.setInboxStore(id);
    setSearch('');
  };
  const open = async (id: string) => {
    ui.setConversation(id);
    try {
      await api('conversations.open', { conversationId: id });
      void client.invalidateQueries({ queryKey: ['conversations.list'] });
      void client.invalidateQueries({ queryKey: ['workbench.overview'] });
    } catch (e) {
      ui.notify(e instanceof Error ? e.message : '标记已读失败');
    }
  };
  const receptionLabel = (c: any) => {
    const owner = storeOf(c);
    const enabled = !!owner?.replyPolicy?.autoReplyEnabled;
    return c.openedByHuman
      ? '人工接待中'
      : c.awaitingHuman
        ? '等待人工处理'
        : !enabled
          ? 'AI 接待未开启'
          : getAutoReplyReadiness((owner?.accounts ?? []).filter((a: any) => a.id === c.accountId))
                .ready
            ? 'AI 自动回复开启'
            : 'AI 暂不可用';
  };
  const changeReception = async (mode: 'human' | 'ai') => {
    if (!conversation || changingReception) return;
    setChangingReception(true);
    try {
      await perform(
        'conversations.reception',
        {
          conversationId: conversation.id,
          mode,
          expectedRevision: conversation.revision,
        },
        mode === 'human' ? '已接管会话，AI 已暂停' : '已交还，AI 将按店铺设置接待之后的新消息',
      );
    } finally {
      setChangingReception(false);
    }
  };
  const sendReply = async (
    payload: { text: string; attachmentId?: string; textAfter?: string },
    qaId?: string,
  ) => {
    const conversationId = ui.conversationId;
    if (
      !store ||
      !conversationId ||
      sendingRef.current ||
      (!payload.text.trim() && !payload.attachmentId)
    )
      return;
    sendingRef.current = true;
    setSending(true);
    setSendingQaId(qaId || null);
    try {
      if (!payload.attachmentId) {
        const submission = submitManualText({
          conversationId,
          storeId: store.id,
          text: payload.text,
          requestId: crypto.randomUUID(),
        });
        if (qaId) setQuickReplies(null);
        else setText('');
        await submission;
        return;
      }
      const result = await perform('messages.send', {
        conversationId,
        ...payload,
        requestId: crypto.randomUUID(),
      });
      if (result) {
        if (useUi.getState().conversationId === conversationId) {
          if (qaId) setQuickReplies(null);
          else {
            setText((current) => (current === payload.text ? '' : current));
            setAttachment((current: any) =>
              current?.id === payload.attachmentId ? null : current,
            );
          }
        }
        const label =
          result.status === 'unknown'
            ? '发送待确认'
            : result.status === 'rejected'
              ? '发送被拒绝'
              : result.status === 'cancelled'
                ? '发送已取消'
                : statusText[result.status] || result.status;
        ui.notify(result.error ? `${label}：${result.error}` : label);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      setSendingQaId(null);
    }
  };
  const send = () => {
    followBottom.current = true;
    return sendReply({ text: textRef.current, attachmentId: attachmentRef.current?.id });
  };
  const sendQuickReply = (entry: QuickReplyEntry) => {
    const revision = entry.revisions[0];
    if (!revision) return;
    return sendReply(
      revision.answerKind === 'image'
        ? {
            text: revision.answerBefore ?? '',
            attachmentId: revision.attachmentId || undefined,
            textAfter: revision.answerAfter,
          }
        : { text: revision.answer },
      entry.id,
    );
  };
  const closeQuickReplies = () => setQuickReplies(null);
  const openQuickReplies = () => {
    if (!text.trim()) {
      textRef.current = '/';
      setText('/');
      setQuickReplies({ search: '', inline: true });
      textareaRef.current?.focus();
    } else {
      setQuickReplies({ search: '', inline: false });
    }
  };
  const selectQuickReply = (entry: QuickReplyEntry) => {
    if (quickReplies?.inline) {
      textRef.current = '';
      setText('');
    }
    setQuickReplies(null);
    return sendQuickReply(entry);
  };
  return (
    <>
      <ConnectPlatformDialog open={connecting} onClose={() => setConnecting(false)} />
      {associating && <Association message={associating} onClose={() => setAssociating(null)} />}
      <header className="reception-toolbar">
        <div className="reception-title">
          <h1>接待中心</h1>
          <span>查看各店消息，处理客户咨询</span>
        </div>
      </header>
      <div className={`reception-layout ${sideOpen ? 'side-open' : ''}`}>
        <section className="conversation-pane" aria-label="会话列表">
          <div className="conversation-scope">
            <div className="conversation-store-row">
              <h2>会话列表</h2>
              <select
                aria-label="接待店铺范围"
                value={ui.inboxStoreId ?? ''}
                onChange={(e) => selectStore(e.target.value || null)}
              >
                <option value="">全部店铺</option>
                {stores.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                title="连接店铺"
                aria-label="连接店铺"
                onClick={() => setConnecting(true)}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div className="search">
            <Search size={16} />
            <input
              aria-label="搜索会话"
              placeholder="搜索客户或最近消息"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button aria-label="清除搜索" onClick={() => setSearch('')}>
                ×
              </button>
            )}
          </div>
          <div className="conversation-filters" aria-label="会话筛选">
            {(
              [
                ['all', '全部'],
                ['waiting', '待处理'],
                ['human', '我接待的'],
                ['unread', '未读'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="conversation-list">
            {query.error ? (
              <Empty icon={<AlertCircle size={24} />}>
                <strong>会话读取失败</strong>
                <p>{query.error.message}</p>
                <Button variant="ghost" onClick={() => query.refetch()}>
                  重新加载
                </Button>
              </Empty>
            ) : query.isPending ? (
              <p className="list-loading">正在读取会话…</p>
            ) : conversations.length ? (
              conversations.map((c) => (
                <button
                  className={`conversation-item ${ui.conversationId === c.id ? 'active' : ''}`}
                  key={c.id}
                  aria-pressed={ui.conversationId === c.id}
                  onClick={() => open(c.id)}
                >
                  <div className="avatar-badge-wrap">
                    <PlatformMark platform={storeOf(c)?.platform ?? c.store?.platform} />
                    {c.unread > 0 && (
                      <b className="avatar-unread-count">{c.unread > 9 ? '9+' : c.unread}</b>
                    )}
                  </div>
                  <div className="conversation-info">
                    <div>
                      <strong>{c.buyerName}</strong>
                      <time>{date(c.updatedAt)}</time>
                    </div>
                    <p>{c.preview || '暂无消息内容'}</p>
                    <div className="conversation-row-meta">
                      <span className="conversation-shop-name">{c.store?.name}</span>
                      <span
                        className={c.awaitingHuman || c.openedByHuman ? 'human-label' : 'ai-label'}
                      >
                        {receptionLabel(c)}
                      </span>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <Empty icon={<InboxIcon size={26} />}>
                <strong>
                  {search
                    ? '没有匹配的会话'
                    : filter === 'waiting'
                      ? '没有待处理咨询'
                      : filter === 'human'
                        ? '暂未接管会话'
                        : filter === 'unread'
                          ? '未读已清空'
                          : '暂时没有会话'}
                </strong>
                <p>{stores.length ? '新消息会自动出现在这里。' : '连接店铺后开始接收消息。'}</p>
                {(search || filter !== 'all') && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setFilter('all');
                      setSearch('');
                    }}
                  >
                    查看全部会话
                  </Button>
                )}
              </Empty>
            )}
            {query.hasNextPage && (
              <Button
                variant="ghost"
                disabled={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? '加载中…' : '加载更多会话'}
              </Button>
            )}
          </div>
          <div className="conversation-list-footer">
            <span>
              {conversations.length}
              {query.hasNextPage ? '+' : ''} 个会话
            </span>
            <span>本地会话</span>
          </div>
        </section>
        <section className="chat-pane">
          {conversation ? (
            <>
              <div className="chat-header">
                <PlatformMark platform={store?.platform ?? conversation.store?.platform} />
                <div className="chat-customer-info">
                  <h3>{conversation.buyerName}</h3>
                  <div className="chat-customer-meta">
                    <small>{store?.name ?? conversation.store?.name}</small>
                    <Badge
                      tone={
                        conversation.openedByHuman || conversation.awaitingHuman
                          ? 'orange'
                          : 'neutral'
                      }
                    >
                      {receptionLabel(conversation)}
                    </Badge>
                  </div>
                </div>
                <div className="chat-header-actions">
                  <Button
                    variant="secondary"
                    disabled={changingReception}
                    onClick={() => changeReception(aiPaused ? 'ai' : 'human')}
                  >
                    <UserRound size={14} />
                    {changingReception ? '处理中…' : aiPaused ? '交还 AI' : '接管会话'}
                  </Button>
                  <Button
                    variant="ghost"
                    className="business-panel-trigger"
                    aria-label="客户与订单"
                    aria-expanded={sideOpen}
                    onClick={() => setSideOpen(!sideOpen)}
                  >
                    <PanelRight size={18} />
                    <span>客户与订单</span>
                  </Button>
                </div>
              </div>
              {(conversation.awaitingHuman ||
                !store?.accounts?.some(
                  (a: any) => a.id === conversation.accountId && a.status === 'online',
                )) && (
                <div className="conversation-alert">
                  <AlertCircle size={14} />
                  <span>
                    {conversation.awaitingHuman
                      ? conversation.handoffReason || '此咨询需要人工处理'
                      : '接待账号未连接，自动回复已暂停。'}{' '}
                  </span>
                  {!store?.accounts?.some(
                    (a: any) => a.id === conversation.accountId && a.status === 'online',
                  ) && (
                    <button
                      onClick={() => {
                        ui.openStoreSettings(store?.id, 1);
                      }}
                    >
                      检查连接
                    </button>
                  )}
                </div>
              )}
              <div
                className="messages"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                }}
              >
                {messageError && (
                  <p role="alert" className="desk-error">
                    消息读取失败：{messageError.message}
                  </p>
                )}
                {loadingMessages && <p className="list-loading">正在读取消息…</p>}

                {more && messages.length === 100 && (
                  <Button
                    variant="ghost"
                    disabled={loadingOlder}
                    onClick={async () => {
                      const requestedConversation = ui.conversationId;
                      setLoadingOlder(true);
                      const rows = await perform('conversations.messages', {
                        conversationId: ui.conversationId,
                        before: (older[0] ?? messages[0]).id,
                      });
                      if (requestedConversation !== useUi.getState().conversationId) return;
                      if (rows) {
                        followBottom.current = false;
                        setOlderState({
                          conversationId: requestedConversation,
                          rows: [...rows, ...older],
                        });
                        setMore(rows.length === 100);
                      }
                      setLoadingOlder(false);
                    }}
                  >
                    {loadingOlder ? '加载中…' : '加载更早的本地消息'}
                  </Button>
                )}
                {visibleTimeline.map((m, index) => (
                  <div className="timeline-entry" key={m.id}>
                    {(index === 0 ||
                      new Date(visibleTimeline[index - 1].timestamp).toDateString() !==
                        new Date(m.timestamp).toDateString()) && (
                      <div className="date-divider">
                        {new Date(m.timestamp).toLocaleDateString('zh-CN', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </div>
                    )}
                    <div
                      className={`message ${m.direction === 'out' ? 'outgoing' : 'incoming'}`}
                      key={m.id}
                      data-delivery-status={m.delivery?.status}
                    >
                      <div className="message-meta">
                        {m.direction === 'out'
                          ? statusText[m.origin] || '客服'
                          : conversation.buyerName}
                        <time>{time(m.timestamp)}</time>
                      </div>
                      <div className={`bubble ${m.withdrawn ? 'withdrawn' : ''}`}>
                        {m.withdrawn ? (
                          '该消息已撤回'
                        ) : m.kind === 'video' ||
                          m.kind === 'product_card' ||
                          m.kind === 'review_card' ? (
                          <RichMessage
                            value={m.raw?.richContent}
                            fallback={m.text || '请在原平台查看此消息'}
                          />
                        ) : m.kind === 'image' ? (
                          m.attachmentId ? (
                            <Attachment id={m.attachmentId} storeId={conversation.storeId} />
                          ) : (
                            <span>图片消息（请在平台查看）</span>
                          )
                        ) : (
                          m.text
                        )}
                      </div>
                      {m.delivery && !m.withdrawn && (
                        <DeliveryStatus
                          outbound={m.delivery}
                          onEdit={(value) => {
                            if (text.trim() && !window.confirm('输入框已有草稿，替换为这条消息？'))
                              return;
                            setText(value);
                            setAttachment(null);
                          }}
                        />
                      )}
                      {m.origin !== 'human' &&
                        m.associationStatus === 'needs_association' &&
                        !m.withdrawn && (
                          <Button variant="ghost" onClick={() => setAssociating(m)}>
                            关联买家问题后参与学习
                          </Button>
                        )}
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <div
                className="composer"
                onBlur={(e) => {
                  if (quickReplies && !e.currentTarget.contains(e.relatedTarget as Node)) {
                    closeQuickReplies();
                  }
                }}
              >
                {quickReplies && conversation && (
                  <QuickReplyMenu
                    ref={quickReplyMenuRef}
                    storeId={conversation.storeId}
                    search={quickReplies.search}
                    sending={sending}
                    sendingId={sendingQaId}
                    onSend={selectQuickReply}
                    onClose={closeQuickReplies}
                  />
                )}
                <div className="composer-toolbar">
                  <button
                    title="选择图片"
                    onClick={async () => {
                      if (!store) return;
                      const a = await perform('attachments.pick', { storeId: store.id });
                      if (a) setAttachment(a);
                    }}
                  >
                    <ImagePlus size={18} />
                  </button>
                  <button
                    title="话术（也可在输入框中输入 / 呼出）"
                    aria-label="话术"
                    aria-haspopup="listbox"
                    aria-expanded={!!quickReplies}
                    className="quick-reply-trigger"
                    onClick={openQuickReplies}
                  >
                    <BookOpen size={18} />
                    话术
                  </button>
                  <span>{attachment ? `已选图片：${attachment.name}` : '人工回复'}</span>
                  {attachment && <button onClick={() => setAttachment(null)}>移除</button>}
                </div>
                <textarea
                  ref={textareaRef}
                  placeholder="输入回复内容，Enter 发送，Shift + Enter 换行，输入 / 呼出话术…"
                  value={text}
                  maxLength={10000}
                  onChange={(e) => {
                    const value = e.target.value;
                    textRef.current = value;
                    setText(value);
                    if (value.startsWith('/')) {
                      setQuickReplies({ search: value.slice(1), inline: true });
                    } else if (quickReplies) {
                      setQuickReplies(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (quickReplies) {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeQuickReplies();
                        return;
                      }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        quickReplyMenuRef.current?.moveDown();
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        quickReplyMenuRef.current?.moveUp();
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (!quickReplyMenuRef.current?.selectHighlighted()) closeQuickReplies();
                        return;
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <small>
                    {aiPaused
                      ? '人工接待中 · 处理完成后交还 AI'
                      : '发送消息不会暂停 AI，如需暂停请接管会话'}
                  </small>
                  <Button disabled={sending || (!text.trim() && !attachment)} onClick={send}>
                    {sending ? (attachment ? '发送中…' : '提交中…') : '发送'}
                    <Send size={15} />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="reception-empty">
              <div className="reception-empty-icon">
                <MessageSquare size={32} />
              </div>
              <h2>
                {detail.error
                  ? '暂时无法打开会话'
                  : ui.conversationId && detail.isPending
                    ? '正在打开会话…'
                    : stores.length
                      ? '选择客户，开始处理咨询'
                      : '连接第一家店铺'}
              </h2>
              <p>
                {detail.error
                  ? detail.error.message
                  : stores.length
                    ? '左侧选择会话，查看聊天、回复客户和处理订单。查看不会暂停 AI 接待。'
                    : '登录平台客服账号，将消息汇集到一个工作空间。'}
              </p>
              {!stores.length ? (
                <Button onClick={() => setConnecting(true)}>
                  <Plus size={16} />
                  连接店铺
                </Button>
              ) : detail.error ? (
                <Button variant="secondary" onClick={() => detail.refetch()}>
                  重新加载
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setFilter('waiting')}>
                  查看待处理咨询
                  <ChevronRight size={14} />
                </Button>
              )}
            </div>
          )}
        </section>
        {(wideLayout || sideOpen) &&
          (conversation ? (
            <>
              <button
                className="desk-backdrop"
                aria-label="关闭业务侧栏"
                onClick={() => setSideOpen(false)}
              />
              <WorkbenchPanel
                key={conversation.id}
                conversationId={conversation.id}
                onClose={() => setSideOpen(false)}
              />
            </>
          ) : (
            <aside className="workbench-panel desk-panel-empty">
              <ShoppingBag size={26} />
              <strong>客户与订单</strong>
              <p>随当前会话展示商品、订单和可用操作。</p>
            </aside>
          ))}
      </div>
    </>
  );
}
type QuickReplyEntry = {
  id: string;
  storeId: string | null;
  status: string;
  revisions: {
    intent: string;
    answerKind: 'text' | 'image';
    answer: string;
    answerBefore?: string;
    answerAfter?: string;
    attachmentId?: string | null;
    scope?: { conditions?: string };
    validUntil?: string | null;
  }[];
};
type QuickReplyMenuHandle = {
  moveUp: () => void;
  moveDown: () => void;
  selectHighlighted: () => boolean;
};
const QuickReplyMenu = forwardRef<
  QuickReplyMenuHandle,
  {
    storeId: string;
    search: string;
    sending: boolean;
    sendingId: string | null;
    onSend: (entry: QuickReplyEntry) => unknown;
    onClose: () => void;
  }
>(function QuickReplyMenu({ storeId, search, sending, sendingId, onSend, onClose }, ref) {
  const [highlighted, setHighlighted] = useState(0);
  const {
    data: entries = [],
    isPending,
    error,
    refetch,
  } = useData<QuickReplyEntry[]>('knowledge.list', { storeId });
  const query = search.trim().toLocaleLowerCase();
  const rows = entries.filter((entry) => {
    const revision = entry.revisions[0];
    return (
      revision &&
      (entry.storeId === null || entry.storeId === storeId) &&
      (!query ||
        [
          revision.intent,
          revision.answer,
          revision.answerBefore || '',
          revision.answerAfter || '',
          revision.scope?.conditions || '',
        ].some((value) => value.toLocaleLowerCase().includes(query)))
    );
  });
  useEffect(() => {
    setHighlighted(0);
  }, [search, rows.length]);
  const available = (entry: QuickReplyEntry) => {
    const revision = entry.revisions[0];
    return (
      revision &&
      (revision.answerKind === 'image' ? !!revision.attachmentId : !!revision.answer.trim())
    );
  };
  useImperativeHandle(
    ref,
    () => ({
      moveUp() {
        setHighlighted((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
      },
      moveDown() {
        setHighlighted((i) => (rows.length ? (i + 1) % rows.length : 0));
      },
      selectHighlighted() {
        const entry = rows[highlighted];
        if (!entry || sending || !available(entry)) return false;
        void onSend(entry);
        return true;
      },
    }),
    [rows, highlighted, sending, onSend],
  );
  return (
    <div className="quick-reply-menu" role="listbox" aria-label="话术">
      <div className="quick-reply-menu-head">
        <BookOpen size={13} />
        <span>话术</span>
        {!isPending && !error && <span className="muted">{rows.length} 条匹配</span>}
        <button
          type="button"
          className="quick-reply-menu-close"
          aria-label="关闭话术面板"
          onClick={onClose}
        >
          esc
        </button>
      </div>
      <div className="quick-reply-menu-list">
        {isPending ? (
          <div className="quick-reply-empty" role="status">
            正在加载话术…
          </div>
        ) : error ? (
          <div className="quick-reply-empty" role="alert">
            <p>话术暂时无法加载</p>
            <Button variant="secondary" onClick={() => void refetch()}>
              重新加载
            </Button>
          </div>
        ) : rows.length ? (
          rows.map((entry, i) => {
            const revision = entry.revisions[0];
            const image = revision.answerKind === 'image';
            const canSend = available(entry);
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={i === highlighted}
                className={`quick-reply-item ${i === highlighted ? 'is-active' : ''}`}
                disabled={sending || !canSend}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => void onSend(entry)}
              >
                <span className="quick-reply-item-icon">
                  {image ? <ImagePlus size={14} /> : <MessageSquare size={14} />}
                </span>
                <span className="quick-reply-item-body">
                  <strong>{revision.intent}</strong>
                  {image ? (
                    <small>
                      {[revision.answerBefore, '[图片]', revision.answerAfter]
                        .filter(Boolean)
                        .join(' → ')}
                    </small>
                  ) : (
                    revision.answer && <small>{revision.answer}</small>
                  )}
                </span>
                {entry.storeId !== null && <Badge>本店</Badge>}
                {entry.status === 'disabled' && <Badge tone="orange">已停用</Badge>}
                <span className="quick-reply-item-send">
                  {sendingId === entry.id ? (
                    '发送中…'
                  ) : (
                    <>
                      <Send size={12} />
                      发送
                    </>
                  )}
                </span>
              </button>
            );
          })
        ) : (
          <div className="quick-reply-empty">
            <p>{entries.length ? '没有找到匹配的话术' : '暂无本店或通用问答'}</p>
          </div>
        )}
      </div>
      <div className="quick-reply-menu-foot">↑↓ 选择 · Enter 发送 · Esc 取消</div>
    </div>
  );
});
export function Attachment({ id, storeId }: { id: string; storeId?: string }) {
  const { data } = useData('attachments.get', { id });
  return data ? <img alt={data.name || '图片消息'} src={data.url} /> : <span>正在加载图片…</span>;
}

function Association({ message, onClose }: { message: any; onClose: () => void }) {
  const { data: groups = [] } = useData<any[]>('conversations.groups', {
    conversationId: message.conversationId,
  });
  return (
    <Modal
      open
      onOpenChange={onClose}
      title="关联回答与问题"
      description="仅将这条实际回答关联到你确认的问题；关联后按店铺学习开关重新评估，结果仍需审批。"
    >
      <div className="modal-body">
        <p>回答：{message.kind === 'image' ? '[图片]' : message.text}</p>
        {groups
          .filter(
            (g) =>
              g.questions.length &&
              g.questions.every((q: any) => new Date(q.timestamp) <= new Date(message.timestamp)),
          )
          .map((g) => (
            <div className="association-option" key={g.id}>
              <div>
                {g.questions.map((q: any) => (
                  <p key={q.id}>
                    {date(q.timestamp)} · {q.text || '[图片]'}
                  </p>
                ))}
              </div>
              <Button
                variant="secondary"
                onClick={async () => {
                  if (
                    await perform('conversations.associate', {
                      messageId: message.id,
                      groupId: g.id,
                    })
                  )
                    onClose();
                }}
              >
                关联此问题
              </Button>
            </div>
          ))}
        {!groups.length && <p>没有可关联的买家问题。</p>}
      </div>
    </Modal>
  );
}
