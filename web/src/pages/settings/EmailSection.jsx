import { useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Spinner, fieldProps } from '../../ui/common.jsx';
import { SecretField } from '../../ui/SecretField.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { EMAIL_PROVIDERS } from '../../lib/labels.js';
import { FieldError, ResetButton, TestResult, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** SPEC-phase2「新的全局 GET /api/settings」里的默认值；SMTP 密码和 Resend API key 不在这里 */
const DEFAULTS = { provider: '', from: '', host: '', port: '465', secure: true, user: '' };

const FIELDS = {
  'email.provider': 'provider',
  'email.from': 'from',
  'email.smtp.host': 'host',
  'email.smtp.port': 'port',
  'email.smtp.secure': 'secure',
  'email.smtp.user': 'user',
  'email.smtp.password': 'password',
  'email.resend.apiKey': 'apiKey',
};
const LABELS = {
  provider: '发送方式',
  from: '发件人',
  host: 'SMTP 服务器',
  port: '端口',
  secure: '加密方式',
  user: '用户名',
  password: '密码',
  apiKey: 'Resend API key',
};

/** 发送方式下面的一行说明 */
const PROVIDER_DESC = {
  '': '号码详情中的邮件通知不可用，转人工仅支持 WhatsApp 通知。',
  resend: (
    <>
      在{' '}
      <a className="link" href="https://resend.com" target="_blank" rel="noreferrer">
        resend.com
      </a>{' '}
      创建 API key 并验证发件域名，发件人须使用已验证的域名。
    </>
  ),
};

const SECURE_OPTIONS = [
  { value: 'ssl', label: 'SSL（通常 465）' },
  { value: 'starttls', label: 'STARTTLS（通常 587）' },
];

function toDraft(e) {
  return {
    provider: e?.provider || '',
    from: e?.from || '',
    host: e?.smtp?.host || '',
    port: String(e?.smtp?.port ?? 465),
    secure: e?.smtp?.secure !== false,
    user: e?.smtp?.user || '',
  };
}

function validate(d) {
  const errs = {};
  if (d.provider && !d.from.trim()) errs.from = '请填写发件人';
  if (d.provider === 'smtp') {
    if (!d.host.trim()) errs.host = '请填写 SMTP 服务器';
    const p = Number(d.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errs.port = '端口须为 1–65535 的整数';
  }
  return errs;
}

/** F10 发信方式：不发邮件 / SMTP / Resend。号详情里的邮件通知只管开关和收件人。 */
export default function EmailSection({ settings, onSaved }) {
  const email = settings.email || {};
  const [draft, setDraft, base] = useSliceDraft(email, toDraft);
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(null); // 'password' | 'apiKey'
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState(null); // {field, text}
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [formRef, reveal] = useRevealInvalid();

  const dirty = !sameDraft(base, draft) || password !== '' || apiKey.trim() !== '';
  const errs = validate(draft);
  const errOf = (k) => (touched && errs[k]) || (serverErr?.field === k ? serverErr.text : '');
  const set = (k, v) => {
    if (serverErr?.field === k) setServerErr(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const setSecure = (secure) =>
    setDraft((d) => {
      // 端口还是另一种模式的默认值时跟着换
      const port = d.port === (secure ? '587' : '465') ? (secure ? '465' : '587') : d.port;
      return { ...d, secure, port };
    });

  const save = async () => {
    setTouched(true);
    const first = Object.keys(errs)[0];
    if (first) {
      toast.error(`${LABELS[first]}：${errs[first]}`);
      reveal();
      return false;
    }
    const patch = { provider: draft.provider || null, from: draft.from.trim() };
    if (draft.provider === 'smtp') {
      patch.smtp = { host: draft.host.trim(), port: Number(draft.port), secure: draft.secure, user: draft.user.trim() };
      if (password !== '') patch.smtp.password = password;
    }
    if (draft.provider === 'resend' && apiKey.trim()) patch.resend = { apiKey: apiKey.trim() };
    setSaving(true);
    setServerErr(null);
    const r = await putSlice({ email: patch }, { fields: FIELDS, labels: LABELS });
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        setServerErr(r.fieldError);
        reveal();
      }
      return false;
    }
    onSaved(r.res);
    setPassword('');
    setApiKey('');
    setTouched(false);
    return true;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (await save()) toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    setPassword('');
    setApiKey('');
    setTouched(false);
    setServerErr(null);
  };

  const restoreDefaults = () => {
    setServerErr(null);
    setTouched(false);
    setDraft({ ...DEFAULTS });
  };

  const clearSecret = async (which) => {
    setClearing(which);
    try {
      const patch = which === 'password' ? { smtp: { password: '' } } : { resend: { apiKey: '' } };
      onSaved(await api.putSettings({ email: patch }));
      if (which === 'password') setPassword('');
      else setApiKey('');
      toast.success(which === 'password' ? '密码已清除' : 'API key 已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(null);
    }
  };

  const testOk = EMAIL_RE.test(testTo.trim());
  const sendTest = async () => {
    if (!testOk || testing) return;
    setTestResult(null);
    // 测试的是已保存的发信方式：有未保存的修改时先保存
    if (dirty && !(await save())) return;
    setTesting(true);
    try {
      const r = await api.testEmail(testTo.trim());
      setTestResult(
        r?.ok
          ? { ok: true, text: '测试邮件已发送，请查看收件箱（含垃圾邮件）。' }
          : { ok: false, text: `发送失败：${r?.error || '原因未知'}` },
      );
    } catch {
      // 已提示
    } finally {
      setTesting(false);
    }
  };

  const savedProvider = email.provider || '';

  return (
    <div ref={formRef}>
      <SettingsSection as="form" title="发信方式" onSubmit={onSubmit} actions={<ResetButton onClick={restoreDefaults} />}>
        <SettingsRow
          label="发送方式"
          hint="用于发送转人工邮件通知和测试邮件。各号码的邮件通知开关和收件人在号码详情中设置。"
        >
          <div className="choice-list" role="radiogroup" aria-label="发送方式">
            {EMAIL_PROVIDERS.map((p) => (
              <label key={p.value || 'none'} className="choice">
                <input
                  type="radio"
                  className="radio"
                  name="em-provider"
                  value={p.value}
                  checked={draft.provider === p.value}
                  onChange={() => set('provider', p.value)}
                />
                <span className="choice__text">
                  <span>{p.label}</span>
                  {PROVIDER_DESC[p.value] && <span className="choice__desc">{PROVIDER_DESC[p.value]}</span>}
                </span>
              </label>
            ))}
          </div>
          <FieldError id="em-provider">{errOf('provider')}</FieldError>
        </SettingsRow>

        {draft.provider && (
          <SettingsRow label="发件人" htmlFor="em-from" hint="收件人看到的发件人，可含名称。">
            <input
              {...fieldProps('em-from', errOf('from'))}
              className="input"
              placeholder="墨鸽 <notify@example.com>"
              value={draft.from}
              onChange={(e) => set('from', e.target.value)}
              spellCheck={false}
            />
            <FieldError id="em-from">{errOf('from')}</FieldError>
          </SettingsRow>
        )}

        {draft.provider === 'smtp' && (
          <>
            <SettingsRow label="SMTP 服务器" htmlFor="em-host">
              <input
                {...fieldProps('em-host', errOf('host'))}
                className="input input--mono"
                placeholder="smtp.example.com"
                value={draft.host}
                onChange={(e) => set('host', e.target.value)}
                spellCheck={false}
              />
              <FieldError id="em-host">{errOf('host')}</FieldError>
            </SettingsRow>
            <SettingsRow label="端口" htmlFor="em-port">
              <input
                {...fieldProps('em-port', errOf('port'))}
                className="input num"
                style={{ maxWidth: 160 }}
                type="number"
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => set('port', e.target.value)}
              />
              <FieldError id="em-port">{errOf('port')}</FieldError>
            </SettingsRow>
            <SettingsRow label="加密方式">
              <div className="choice-list" role="radiogroup" aria-label="加密方式">
                {SECURE_OPTIONS.map((o) => (
                  <label key={o.value} className="choice">
                    <input
                      type="radio"
                      className="radio"
                      name="em-secure"
                      value={o.value}
                      checked={(draft.secure ? 'ssl' : 'starttls') === o.value}
                      onChange={() => setSecure(o.value === 'ssl')}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow label="用户名" htmlFor="em-user">
              <input
                {...fieldProps('em-user', errOf('user'))}
                className="input"
                autoComplete="off"
                value={draft.user}
                onChange={(e) => set('user', e.target.value)}
                spellCheck={false}
              />
              <FieldError id="em-user">{errOf('user')}</FieldError>
            </SettingsRow>
            <SettingsRow label="密码" htmlFor="em-pass">
              <div className="settings-page__secret">
                <SecretField
                  id="em-pass"
                  isSet={!!email.smtp?.passwordSet}
                  value={password}
                  onChange={(v) => {
                    if (serverErr?.field === 'password') setServerErr(null);
                    setPassword(v);
                  }}
                  onClear={() => clearSecret('password')}
                  clearing={clearing === 'password'}
                  error={errOf('password')}
                />
              </div>
            </SettingsRow>
          </>
        )}

        {draft.provider === 'resend' && (
          <SettingsRow label="Resend API key" htmlFor="em-resend">
            <div className="settings-page__secret">
              <SecretField
                id="em-resend"
                isSet={!!email.resend?.apiKeySet}
                last4={email.resend?.apiKeyLast4}
                value={apiKey}
                onChange={(v) => {
                  if (serverErr?.field === 'apiKey') setServerErr(null);
                  setApiKey(v);
                }}
                onClear={() => clearSecret('apiKey')}
                clearing={clearing === 'apiKey'}
                error={errOf('apiKey')}
              />
            </div>
          </SettingsRow>
        )}

        {(draft.provider || savedProvider) && (
          <SettingsRow label="发送测试邮件" htmlFor="em-test-to">
            <div className="settings-page__inline">
              <input
                id="em-test-to"
                className="input"
                type="email"
                inputMode="email"
                placeholder="收件地址，如 you@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    sendTest();
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                onClick={sendTest}
                disabled={!testOk || testing || saving || !draft.provider}
              >
                {testing ? <Spinner /> : <Send />}
                发送测试邮件
              </button>
            </div>
            <TestResult result={testResult} />
          </SettingsRow>
        )}

        <SaveBar
          dirty={dirty}
          saving={saving}
          onDiscard={discard}
          text={draft.provider ? '有未保存的更改，发送测试邮件前将自动保存' : '有未保存的更改'}
        />
      </SettingsSection>
    </div>
  );
}
