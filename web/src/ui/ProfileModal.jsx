import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../lib/auth.jsx';
import { toast } from './toastBus.js';
import { Modal } from './Modal.jsx';
import { Callout, Field, Spinner, fieldProps } from './common.jsx';

/** 个人话术最多 2000 字（和服务端 users.style_prompt 的上限一致） */
export const MAX_STYLE_PROMPT = 2000;

/** 「我的资料」各字段的上限（和服务端 auth.js 的 PROFILE_FIELDS 一致） */
const LIMITS = { displayName: 60, jobTitle: 60, contactPhone: 40, contactEmail: 120, bio: 1000 };
const EMPTY_PROFILE = { displayName: '', jobTitle: '', contactPhone: '', contactEmail: '', bio: '' };
/** 和服务端一样的宽松检查：有 @、@ 后面有点、没有空白 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STYLE_PLACEHOLDER = `例如：
- 开头直接称呼客户名字，结尾署名
- 句子短一点，少用感叹号
- 西班牙语客户用 usted 称呼`;

const profileOf = (user) => ({ ...EMPTY_PROFILE, ...(user?.profile || {}) });
/** 提交前的整理：去掉首尾空白（服务端还会把单行字段里的换行和连续空白合成一个空格） */
const trimProfile = (p) => Object.fromEntries(Object.keys(EMPTY_PROFILE).map((k) => [k, String(p[k] ?? '').trim()]));
const sameProfile = (a, b) => Object.keys(EMPTY_PROFILE).every((k) => a[k] === b[k]);

/**
 * 「我的资料」：上面是资料（对客户的称呼、职位、联系电话、联系邮箱、补充介绍，PUT /api/auth/me/profile），
 * 下面是原来的「我的话术」（PUT /api/auth/me/style-prompt）。所有角色都能改自己的，一个保存按钮，只提交改过的那部分。
 * 当前值来自 AuthContext 里的 user.profile / user.stylePrompt（GET /api/auth/me 才带），保存后用返回的 user 更新它。
 */
export function ProfileModal({ open, onClose }) {
  const { user, setUser } = useAuth();
  const [form, setForm] = useState(EMPTY_PROFILE);
  const [style, setStyle] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(profileOf(user));
    setStyle(user?.stylePrompt || '');
    setTouched(false);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const next = trimProfile(form);
  const profileDirty = !sameProfile(next, trimProfile(profileOf(user)));
  const styleDirty = style.trim() !== (user?.stylePrompt || '').trim();
  const emailErr = next.contactEmail && !EMAIL_RE.test(next.contactEmail) ? '邮箱格式不对' : '';
  const shownEmailErr = touched ? emailErr : '';

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (busy || emailErr) return;
    setBusy(true);
    setError('');
    let latest = user;
    try {
      if (profileDirty) {
        const res = await api.putMyProfile(next);
        if (res?.user?.id) latest = { ...latest, ...res.user };
        else latest = { ...latest, profile: next };
        setUser(latest);
      }
      if (styleDirty) {
        const res = await api.putStylePrompt(style.trim());
        if (res?.user?.id) latest = { ...latest, ...res.user };
        else latest = { ...latest, stylePrompt: style.trim() };
        setUser(latest);
      }
      toast.success('我的资料已保存');
      onClose();
    } catch (err) {
      setError(err?.message || '保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const counter = (n, max) => (
    <span className="muted text-sm num">
      {n} / {max}
    </span>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="我的资料"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="profile-form" className="btn btn--primary" disabled={busy || (!profileDirty && !styleDirty)}>
            {busy ? <Spinner /> : <Save />}
            保存
          </button>
        </>
      }
    >
      <form id="profile-form" className="profile-modal" onSubmit={submit} noValidate>
        <section className="profile-modal__section" aria-labelledby="profile-info-title">
          <div className="profile-modal__head">
            <h3 id="profile-info-title">资料</h3>
            <p className="field__hint">
              AI 起草推荐回复和转人工草稿时会用这些信息：自称和署名用「对客户的称呼」，客户问你是谁、要联系方式时照这里回答，没填的不会编。自动回复不会用，机器人以公司身份回复。
            </p>
          </div>
          <div className="form-grid">
            <Field label="对客户的称呼" htmlFor="pf-name">
              <input
                id="pf-name"
                className="input"
                maxLength={LIMITS.displayName}
                placeholder="例如 Lina Li"
                autoComplete="off"
                value={form.displayName}
                onChange={(e) => set('displayName', e.target.value)}
              />
            </Field>
            <Field label="职位" htmlFor="pf-title">
              <input
                id="pf-title"
                className="input"
                maxLength={LIMITS.jobTitle}
                placeholder="例如 Sales Manager"
                autoComplete="off"
                value={form.jobTitle}
                onChange={(e) => set('jobTitle', e.target.value)}
              />
            </Field>
            <Field label="联系电话" htmlFor="pf-phone">
              <input
                id="pf-phone"
                className="input"
                type="tel"
                inputMode="tel"
                maxLength={LIMITS.contactPhone}
                placeholder="例如 +86 138 0000 0000"
                autoComplete="off"
                value={form.contactPhone}
                onChange={(e) => set('contactPhone', e.target.value)}
              />
            </Field>
            <Field label="联系邮箱" htmlFor="pf-email" error={shownEmailErr}>
              <input
                {...fieldProps('pf-email', shownEmailErr)}
                className="input"
                type="email"
                inputMode="email"
                maxLength={LIMITS.contactEmail}
                placeholder="例如 lina@example.com"
                autoComplete="off"
                value={form.contactEmail}
                onChange={(e) => set('contactEmail', e.target.value)}
              />
            </Field>
            <Field label="补充介绍" htmlFor="pf-bio" className="field--full" aside={counter(form.bio.length, LIMITS.bio)}>
              <textarea
                id="pf-bio"
                className="textarea"
                rows={3}
                maxLength={LIMITS.bio}
                placeholder="例如：负责南美市场，会英语和西班牙语，北京时间 9:00–18:00 在线"
                value={form.bio}
                onChange={(e) => set('bio', e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="profile-modal__section" aria-labelledby="profile-style-title">
          <h3 id="profile-style-title">我的话术</h3>
          <Field
            label="我的说话习惯"
            htmlFor="style-prompt"
            aside={counter(style.length, MAX_STYLE_PROMPT)}
            hint="你在会话页点「推荐回复」「换一条」时，AI 照这里的习惯起草。优先级：起草规则 > 公司话术 > 我的话术，冲突时以前者为准。话术只管怎么说，不能让 AI 编价格、交期和承诺，要你拍板的地方仍会写成【待你确认：…】。"
          >
            <textarea
              id="style-prompt"
              className="textarea"
              rows={6}
              maxLength={MAX_STYLE_PROMPT}
              placeholder={STYLE_PLACEHOLDER}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            />
          </Field>
        </section>

        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Modal>
  );
}
