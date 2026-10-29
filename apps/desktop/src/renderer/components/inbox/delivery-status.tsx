import { useState } from 'react';
import { Check, CircleAlert, Loader2 } from 'lucide-react';
import type { ManualOutbound } from '../../../../../../packages/contracts/src/index';
import { api, client } from '../../api';

export function DeliveryStatus({
  outbound,
  onEdit,
}: {
  outbound: ManualOutbound;
  onEdit: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = ['prepared', 'dispatching'].includes(outbound.status);
  const failed = ['rejected', 'cancelled'].includes(outbound.status);
  const confirmed = outbound.status === 'confirmed';
  const unknown = outbound.status === 'unknown';
  const label = pending ? '发送中' : confirmed ? '已发送' : failed ? '发送失败' : '发送待确认';
  const acknowledge = async (outcome: 'delivered' | 'failed') => {
    if (busy) return;
    const note =
      outcome === 'delivered' ? '已在原平台确认该消息送达' : '确认未送达或放弃等待平台回执';
    if (
      !window.confirm(
        outcome === 'delivered'
          ? '确认已在原平台看到这条消息？确认后可交还 AI。'
          : '确认结束等待？将标记为发送失败，然后可交还 AI。',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('outbound.acknowledge', { id: outbound.id, outcome, note });
      await client.invalidateQueries({
        queryKey: ['conversations.outbounds', { conversationId: outbound.conversationId }],
      });
      await client.invalidateQueries({ queryKey: ['conversations.messages'] });
      await client.invalidateQueries({ queryKey: ['conversations.get'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '核对失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`message-delivery ${pending ? 'pending' : confirmed ? 'confirmed' : 'attention'}`}
      role="status"
      aria-label={label}
    >
      {pending ? (
        <Loader2 size={12} className="studio-spin" />
      ) : confirmed ? (
        <Check size={12} />
      ) : (
        <CircleAlert size={12} />
      )}
      <span>{label}</span>
      {!pending && !confirmed && (
        <span className="message-delivery-reason">
          {unknown
            ? `请核对平台记录${outbound.error ? ` · ${outbound.error}` : ''}`
            : outbound.error || '平台未接收这条消息'}
        </span>
      )}
      {unknown && (
        <>
          <button disabled={busy} onClick={() => void acknowledge('delivered')}>
            已在平台确认
          </button>
          <button disabled={busy} onClick={() => void acknowledge('failed')}>
            结束等待
          </button>
        </>
      )}
      {failed && !outbound.body.attachmentId && !outbound.body.richContent && (
        <button onClick={() => onEdit(outbound.body.text)}>重新编辑</button>
      )}
      {error && (
        <span className="message-delivery-reason" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
