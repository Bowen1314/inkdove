import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { api } from '../api/client.js';
import { Callout, Field, Spinner } from '../ui/common.jsx';
import { BrandMark } from '../ui/BrandMark.jsx';
import { useBranding } from '../lib/branding.jsx';

/**
 * 登录、邀请页共用的外框：--bg-subtle 底，中间 360 宽的一栏，
 * 自上而下是品牌标识、H1、卡片（1px 边、无阴影、内边距 24），卡片下面可放一行灰字。
 */
export function AuthShell({ title, children, foot }) {
  return (
    <div className="auth">
      <main className="auth__col">
        <div className="auth__brand">
          <BrandMark size="lg" />
        </div>
        {title && <h1 className="auth__title">{title}</h1>}
        <div className="card auth__card">{children}</div>
        {foot && <p className="auth__foot text-sm muted">{foot}</p>}
      </main>
    </div>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { displayTitle } = useBranding();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 已登录时直接进后台
  useEffect(() => {
    let alive = true;
    api
      .me()
      .then(() => alive && navigate('/', { replace: true }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [navigate]);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.login(email.trim(), password);
      const from = location.state?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      if (err.code === 'bad_credentials') setError('邮箱或密码不正确，请重新输入');
      else if (err.code === 'account_disabled') setError('这个账号已被停用，请联系管理员');
      else if (err.status === 429) setError('尝试次数太多，请一分钟后再试');
      else setError(err.message || '登录失败，请稍后重试');
      setBusy(false);
    }
  };

  const clearErr = () => error && setError('');
  const invalid = error ? true : undefined;
  const describedBy = error ? 'login-error' : undefined;

  return (
    <AuthShell title={`登录 ${displayTitle}`} foot="忘记密码请联系管理员，在「成员」里给你生成重置密码链接。">
      <form className="vstack auth__form" onSubmit={submit} noValidate>
        <Field label="邮箱" htmlFor="login-email">
          <input
            id="login-email"
            className="input"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoFocus
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearErr();
            }}
            aria-invalid={invalid}
            aria-describedby={describedBy}
          />
        </Field>
        <Field label="密码" htmlFor="login-password">
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearErr();
            }}
            aria-invalid={invalid}
            aria-describedby={describedBy}
          />
        </Field>

        {error && (
          <div id="login-error">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}

        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={!email.trim() || !password || busy}>
          {busy ? <Spinner /> : <LogIn />}
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>
    </AuthShell>
  );
}
