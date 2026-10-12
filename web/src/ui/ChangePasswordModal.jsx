import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api/client.js';
import { toast } from './toastBus.js';
import { Modal } from './Modal.jsx';
import { Callout, Field, Spinner, fieldProps } from './common.jsx';

export const MIN_PASSWORD = 10;

/** 修改自己的密码：POST /api/auth/password {currentPassword, newPassword} */
export function ChangePasswordModal({ open, onClose }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setCur('');
      setNext('');
      setAgain('');
      setTouched(false);
      setError('');
    }
  }, [open]);

  const errs = {
    cur: !cur ? '请输入当前密码' : '',
    next: next.length < MIN_PASSWORD ? `新密码至少 ${MIN_PASSWORD} 个字符` : '',
    again: again !== next ? '两次输入的新密码不一样' : '',
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
      await api.changePassword(cur, next);
      toast.success('密码已修改，其他设备上的登录已失效');
      onClose();
    } catch (err) {
      if (err.code === 'bad_credentials' || err.status === 401 || err.status === 403) setError('当前密码不正确');
      else setError(err.message || '修改失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="修改密码"
      width={420}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="pwd-form" className="btn btn--primary" disabled={busy}>
            {busy ? <Spinner /> : <Save />}
            保存新密码
          </button>
        </>
      }
    >
      <form id="pwd-form" className="vstack" style={{ gap: 16, alignItems: 'stretch' }} onSubmit={submit} noValidate>
        <Field label="当前密码" htmlFor="pwd-cur" error={show('cur')}>
          <input
            {...fieldProps('pwd-cur', show('cur'))}
            className="input"
            type="password"
            autoComplete="current-password"
            value={cur}
            onChange={(e) => setCur(e.target.value)}
          />
        </Field>
        <Field label="新密码" htmlFor="pwd-new" error={show('next')} hint={`至少 ${MIN_PASSWORD} 个字符。修改后，你在其他设备上的登录会失效。`}>
          <input
            {...fieldProps('pwd-new', show('next'))}
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="再输一次新密码" htmlFor="pwd-again" error={show('again')}>
          <input
            {...fieldProps('pwd-again', show('again'))}
            className="input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </Field>
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Modal>
  );
}
