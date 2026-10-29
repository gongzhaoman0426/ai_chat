import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field } from './ui';
import type { api } from '../api';

type Mode = 'password' | 'code' | 'register' | 'reset';
export function AccountAuth({
  act,
  busy,
  notify,
}: {
  act: (method: Parameters<typeof api>[0], input?: any) => Promise<any>;
  busy: boolean;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [verification, setVerification] = useState<{
    id: string;
    email: string;
    purpose: string;
  }>();
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const emailInput = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const normalizedEmail = email.trim().toLowerCase();
  const purpose = mode === 'register' ? 'register' : mode === 'reset' ? 'reset_password' : 'login';
  const seconds = Math.max(0, Math.ceil(((cooldowns[normalizedEmail] || 0) - now) / 1000));
  const needsCode = mode !== 'password';
  const verifiedRequest =
    verification?.email === normalizedEmail && verification?.purpose === purpose;
  useEffect(() => {
    if (!seconds) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  function switchMode(next: Mode) {
    if (busy || locked.current) return;
    setMode(next);
    setVerification(undefined);
    setCode('');
    notify('');
  }
  async function sendCode() {
    if (busy || locked.current || seconds || !emailInput.current?.reportValidity()) return;
    locked.current = true;
    try {
      const result = await act('license.sendEmailCode', { email: normalizedEmail, purpose });
      if (result) {
        setVerification({ id: result.verificationId, email: normalizedEmail, purpose });
        setCode('');
        setCooldowns((v) => ({ ...v, [normalizedEmail]: Date.now() + result.retryAfter * 1000 }));
        setNow(Date.now());
        notify(
          mode === 'register'
            ? '如果此邮箱尚未注册，验证码已发送；已注册的邮箱请直接登录。'
            : '若邮箱已注册且账号可用，验证码已发送，请查看收件箱或垃圾邮件。',
        );
      }
    } finally {
      locked.current = false;
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || locked.current) return;
    if (needsCode && !verifiedRequest) {
      notify('请先获取当前邮箱的验证码');
      return;
    }
    const form = new FormData(e.currentTarget);
    locked.current = true;
    try {
      const input = {
        email: normalizedEmail,
        ...(needsCode ? { code, verificationId: verification!.id } : {}),
        ...(mode !== 'code' ? { password: form.get('password') } : {}),
        ...(mode === 'register' ? { name: form.get('name') } : {}),
      };
      const result = await act(
        mode === 'password'
          ? 'license.login'
          : mode === 'code'
            ? 'license.loginCode'
            : mode === 'register'
              ? 'license.register'
              : 'license.resetPassword',
        input,
      );
      if (result && mode === 'reset') {
        setMode('password');
        setVerification(undefined);
        setCode('');
        notify('密码已重置，请使用新密码登录。');
      }
    } finally {
      locked.current = false;
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="license-tabs">
        <button
          type="button"
          disabled={busy}
          className={mode === 'password' || mode === 'code' ? 'active' : ''}
          onClick={() => switchMode('password')}
        >
          登录
        </button>
        <button
          type="button"
          disabled={busy}
          className={mode === 'register' ? 'active' : ''}
          onClick={() => switchMode('register')}
        >
          注册账号
        </button>
      </div>
      {mode === 'reset' ? (
        <h2>重置密码</h2>
      ) : (
        mode !== 'register' && (
          <div className="license-auth-methods" aria-label="登录方式">
            <Button
              type="button"
              variant={mode === 'password' ? 'secondary' : 'ghost'}
              disabled={busy}
              onClick={() => switchMode('password')}
            >
              密码登录
            </Button>
            <Button
              type="button"
              variant={mode === 'code' ? 'secondary' : 'ghost'}
              disabled={busy}
              onClick={() => switchMode('code')}
            >
              验证码登录
            </Button>
          </div>
        )
      )}
      <Field label="邮箱">
        <input
          ref={emailInput}
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="username"
          placeholder="请输入邮箱地址"
          value={email}
          disabled={busy}
          onChange={(e) => {
            setEmail(e.target.value);
            setVerification(undefined);
            setCode('');
          }}
        />
      </Field>
      {mode === 'register' && (
        <Field label="昵称">
          <input name="name" required maxLength={50} disabled={busy} />
        </Field>
      )}
      {needsCode && (
        <Field label="邮箱验证码">
          <div className="license-email-code">
            <input
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              placeholder="6 位验证码"
              disabled={busy}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !!seconds || !normalizedEmail}
              onClick={sendCode}
            >
              {seconds ? `${seconds} 秒后重发` : verification ? '重新发送' : '获取验证码'}
            </Button>
          </div>
          <small className="license-auth-hint">验证码 10 分钟内有效</small>
        </Field>
      )}
      {mode !== 'code' && (
        <Field label={mode === 'reset' ? '新密码' : '密码'}>
          <input
            key={mode}
            name="password"
            type="password"
            required
            minLength={10}
            maxLength={200}
            autoComplete={mode === 'password' ? 'current-password' : 'new-password'}
            placeholder="至少 10 位"
            disabled={busy}
          />
        </Field>
      )}
      <Button disabled={busy || (needsCode && !verifiedRequest)}>
        {busy
          ? '请稍候…'
          : mode === 'register'
            ? '验证邮箱并创建账号'
            : mode === 'reset'
              ? '重置密码'
              : '登录云端账号'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => switchMode(mode === 'reset' ? 'password' : 'reset')}
      >
        {mode === 'reset' ? '返回登录' : '忘记密码'}
      </Button>
    </form>
  );
}
