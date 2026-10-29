import { record } from '../shared';

const codeFields = ['error_code', 'errorCode'] as const;
function acceptedCode(field: (typeof codeFields)[number], value: unknown, success: unknown) {
  if (value == null || value === 0 || value === '0') return true;
  // Merchant HTTP APIs use success:true + errorCode:1000000 for success.
  // The chat protocol's error_code is separate and still uses zero.
  return field === 'errorCode' && success === true && (value === 1000000 || value === '1000000');
}

export function isPddRejected(raw: unknown): boolean {
  const r = record(raw);
  return (
    r.success === false ||
    // In merchant envelopes result is payload (an order note can literally be "fail").
    (r.success !== true && (r.result === 'fail' || r.result === 'error')) ||
    codeFields.some((field) => !acceptedCode(field, r[field], r.success))
  );
}

export function pddFailureReason(raw: unknown): string {
  const r = record(raw);
  const field =
    codeFields.find((key) => !acceptedCode(key, r[key], r.success)) ??
    codeFields.find((key) => r[key] != null);
  const value = field ? r[field] : undefined;
  const code =
    typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 40) : '';
  const detail = [r.error_msg, r.errorMsg, r.message, r.error, r.msg].find(
    (v): v is string => typeof v === 'string' && !!v.trim(),
  );
  return `${code ? `（错误码 ${code}）` : ''}：${detail?.trim().slice(0, 300) || '平台业务失败'}`;
}
