type ReplyAccount = {
  status: string;
  verifiedAt?: unknown;
  capabilities?: unknown;
};

// Use the same account prerequisites for the switch, message eligibility and dispatch.
// Verification is a user acknowledgement, independent of current transport readiness.
export function getAutoReplyReadiness(accounts: readonly ReplyAccount[]) {
  const connected = accounts.filter((account) => {
    const caps = account.capabilities as { receive?: boolean; sendText?: boolean } | null;
    return account.status === 'online' && caps?.receive === true && caps.sendText === true;
  });
  const ready = connected.filter((account) => !!account.verifiedAt);
  if (ready.length)
    return {
      ready: true,
      action: null,
      reason:
        ready.length < accounts.length
          ? `仅 ${ready.length} / ${accounts.length} 个账号可自动接待，其余账号请到设置检查。`
          : '账号已具备自动接待条件。',
    } as const;
  if (connected.length)
    return {
      ready: false,
      action: 'verify',
      reason: '账号尚未完成接入验证，请到“系统设置 → 店铺接待 → 开启接待”完成收发验收确认。',
    } as const;
  return {
    ready: false,
    action: 'connect',
    reason: accounts.length
      ? '消息通道未连接，请打开平台并进入客服聊天页，等待消息通道连接。'
      : '请先连接店铺客服账号。',
  } as const;
}

// Explain the exact ingest decision without making a model request.
export function getReplyEligibility(input: {
  autoReplyEnabled: boolean;
  openedByHuman: boolean;
  awaitingHuman: boolean;
  account: ReplyAccount;
}) {
  if (!input.autoReplyEnabled)
    return { eligible: false, code: 'auto_reply_disabled', reason: '店铺未开启 AI 自动回复。' };
  if (input.openedByHuman)
    return {
      eligible: false,
      code: 'opened_by_human',
      reason: '此会话已由人工接管，点击“交还 AI”后接待新消息。',
    };
  if (input.awaitingHuman)
    return {
      eligible: false,
      code: 'awaiting_human',
      reason: '此会话正在等待人工处理；处理后点击“交还 AI”恢复接待新消息。',
    };
  const readiness = getAutoReplyReadiness([input.account]);
  if (!readiness.ready)
    return {
      eligible: false,
      code: readiness.action === 'verify' ? 'account_unverified' : 'account_disconnected',
      reason: readiness.reason,
    };
  return { eligible: true, code: 'queued', reason: '已进入自动回复队列，等待合并连续消息后执行。' };
}
