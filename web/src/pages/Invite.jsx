import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { api } from '../api/client.js';
import { Callout, Field, Spinner, fieldProps } from '../ui/common.jsx';
import { roleLabel } from '../lib/labels.js';
import { MIN_PASSWORD } from '../ui/ChangePasswordModal.jsx';
import { AuthShell } from './Login.jsx';

/**
 * 邀请和重置密码页 /invite/:token（不需要登录，也不调 me()，否则全局 401 会跳登录页）。
 * GET /api/invites/:token → {email, name, role, kind:"invite"|"reset"}；404 = 链接失效。
 * POST /api/invites/:token/accept {name?, password}：设置密码并直接登录。
 */
export default function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(undefined); // undefined=加载中, null=失效
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .getInvite(token)
      .then((res) => {
        if (!alive) return;
        setInfo(res || null);
        setName(res?.name || '');
      })
      .catch((e) => {
        if (!alive) return;
        if (e.status === 404 || e.status === 410) setInfo(null);
        else setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const isReset = info?.kind === 'reset';
  const errs = {
    name: !isReset && !name.trim() ? '请填写你的名字' : '',
    password: password.length < MIN_PASSWORD ? `密码至少 ${MIN_PASSWORD} 个字符` : '',
    again: again !== password ? '两次输入的密码不一样' : '',
  };
  const invalid = Object.values(errs).some(Boolean);
  const show = (k) => (touched ? errs[k] : '');

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.acceptInvite(token, isReset ? { password } : { name: name.trim(), password });
      navigate('/', { replace: true });
    } catch (err) {
      if (err.status === 404 || err.status === 410) setInfo(null);
      else setError(err.message || '提交失败，请稍后重试');
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <AuthShell title="暂时打不开这个链接">
        <p className="muted">{loadError.message || '请稍后刷新重试'}</p>
      </AuthShell>
    );
  }

  if (info === undefined) {
    return (
      <AuthShell>
        <div className="hstack muted" aria-busy="true">
          <Spinner /> 正在验证链接…
        </div>
      </AuthShell>
    );
  }

  if (info === null) {
    return (
      <AuthShell title="链接已失效，请联系管理员重新发送">
        <div className="vstack auth__form">
          <p className="muted">邀请和重置链接 7 天内有效，并且只能用一次。</p>
          <Link to="/login" className="btn btn--block">
            去登录
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={isReset ? '重新设置密码' : '欢迎加入'}>
      <form className="vstack auth__form" onSubmit={submit} noValidate>
        <dl className="kv auth__info">
          <dt>邮箱</dt>
          <dd className="ellipsis">{info.email}</dd>
          <dt>角色</dt>
          <dd>{roleLabel(info.role)}</dd>
        </dl>
        {!isReset && (
          <Field label="你的名字" htmlFor="inv-name" hint="会显示在你发出的人工回复上。" error={show('name')}>
            <input
              {...fieldProps('inv-name', show('name'))}
              className="input"
              value={name}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label="设置密码" htmlFor="inv-pass" hint={`至少 ${MIN_PASSWORD} 个字符。`} error={show('password')}>
          <input
            {...fieldProps('inv-pass', show('password'))}
            className="input"
            type="password"
            autoComplete="new-password"
            autoFocus={isReset}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="再输一次密码" htmlFor="inv-again" error={show('again')}>
          <input
            {...fieldProps('inv-again', show('again'))}
            className="input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </Field>
        {error && <Callout tone="danger">{error}</Callout>}
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={busy}>
          {busy ? <Spinner /> : <Check />}
          {busy ? '正在提交…' : isReset ? '保存并登录' : '完成并进入后台'}
        </button>
      </form>
    </AuthShell>
  );
}
