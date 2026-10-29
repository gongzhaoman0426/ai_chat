export function outputLimitMessage(maxOutputTokens: unknown, usage: unknown, text: string): string {
  const details: string[] = [];
  const tokens = (value: unknown, label: string) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      details.push(`${label} ${value} tokens`);
  };
  tokens(maxOutputTokens, '配置输出上限');
  if (usage && typeof usage === 'object') {
    tokens((usage as { outputTokens?: unknown }).outputTokens, '实际输出');
    tokens((usage as { reasoningTokens?: unknown }).reasoningTokens, '输出中用于思考');
  }
  return [
    '模型输出达到长度限制，尚未完成回复',
    details.length ? `（${details.join('，')}）` : '',
    text.trim() ? '；回复正文被截断。' : '；未生成回复正文。',
  ].join('');
}
