import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { api } from '../../../api/client.js';
import { toast } from '../../../ui/toastBus.js';
import { Callout, Segmented, Spinner, Switch } from '../../../ui/common.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../../ui/Settings.jsx';
import { StatusDot } from '../../../ui/StatusDot.jsx';
import { REPLY_MODES, REPLY_SCOPES, replyModeLabel, replyModeOf } from '../../../lib/labels.js';
import { isConnected, patchAccountCache } from '../../../lib/accounts.js';

/** 每行一个号码 → 数组（规范化交给后端） */
const splitLines = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

/** 收件人：逗号（中英文）、分号或换行分隔 → 数组 */
const splitList = (text) =>
  String(text || '')
    .split(/[,，;；\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const joinLines = (arr) => (Array.isArray(arr) ? arr.join('\n') : '');
const sameDraft = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

/** 把 PUT 的返回写回详情页和号码缓存；没有返回完整 Account 时返回 null */
function makeApplyAccount(setAccount) {
  return (res) => {
    if (res && res.id) {
      setAccount(res);
      patchAccountCache(res);
      return res;
    }
    return null;
  };
}

function RestoreButton({ onClick, disabled }) {
  return (
    <button type="button" className="btn btn--ghost btn--sm" onClick={onClick} disabled={disabled}>
      恢复默认
    </button>
  );
}

/* ================= 回复 ================= */

// SPEC 默认值：persona 留空（用全局）、回复所有私聊、黑白名单为空。回复方式是即时生效的，不在这里
const REPLY_DEFAULTS = { persona: '', scope: 'all', allowlist: '', blocklist: '' };

function replyDraft(a) {
  return {
    persona: a?.persona || '',
    scope: a?.scope === 'allowlist' ? 'allowlist' : 'all',
    allowlist: joinLines(a?.allowlist),
    blocklist: joinLines(a?.blocklist),
  };
}

const MODE_OPTIONS = REPLY_MODES.map(({ value, label }) => ({ value, label }));
const modeDesc = (m) => REPLY_MODES.find((x) => x.value === m)?.desc || '';
const scopeLabel = (s) => REPLY_SCOPES.find((x) => x.value === (s === 'allowlist' ? 'allowlist' : 'all'))?.label;

/**
 * 号详情的「回复」分组。admin：回复方式（Segmented，即时生效）、persona、回复范围、黑白名单（走保存栏）；
 * agent：同样几项只读展示（PUT /api/accounts/:id 对 agent 一律 403）。
 * 回复范围和名单对两种回复方式都生效（范围外的消息不保存），persona 自动回复和推荐回复都用，所以一直显示。
 * globalSettings：admin 才拿得到，用来在 persona 占位里显示全局设置。
 */
export default function ReplySection({ account, setAccount, globalSettings, isAdmin }) {
  if (!isAdmin) return <ReplyReadOnly account={account} />;
  return <ReplyForm account={account} setAccount={setAccount} globalSettings={globalSettings} />;
}

/** 业务员看到的只读版：号的设置只有管理员能改 */
function ReplyReadOnly({ account }) {
  const mode = replyModeOf(account);
  const allowCount = Array.isArray(account.allowlist) ? account.allowlist.length : 0;
  const blockCount = Array.isArray(account.blocklist) ? account.blocklist.length : 0;
  return (
    <SettingsSection title="回复" desc="号的设置只有管理员能修改">
      <SettingsRow inline label="回复方式" hint={modeDesc(mode)}>
        <span className="text-strong nowrap">{replyModeLabel(mode)}</span>
      </SettingsRow>
      <SettingsRow label="身份和语气">
        {account.persona ? (
          <div className="pre-wrap numbers-readonly">{account.persona}</div>
        ) : (
          <div className="muted numbers-readonly">使用全局设置</div>
        )}
      </SettingsRow>
      <SettingsRow inline label="回复范围">
        <span>{scopeLabel(account.scope)}</span>
      </SettingsRow>
      {account.scope === 'allowlist' && (
        <SettingsRow inline label="白名单">
          <span className="num">{allowCount} 个号码</span>
        </SettingsRow>
      )}
      <SettingsRow inline label="黑名单">
        <span className="num">{blockCount} 个号码</span>
      </SettingsRow>
    </SettingsSection>
  );
}

function ReplyForm({ account, setAccount, globalSettings }) {
  const [draft, setDraft] = useState(() => replyDraft(account));
  const [saving, setSaving] = useState(false);
  const [pendingMode, setPendingMode] = useState(null); // 正在切换到的回复方式
  const applyAccount = makeApplyAccount(setAccount);

  const base = useMemo(() => replyDraft(account), [account]);
  const dirty = !sameDraft(base, draft);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const savedMode = replyModeOf(account) || 'off';
  const mode = pendingMode ?? savedMode;
  const allowCount = splitLines(draft.allowlist).length;
  const blockCount = splitLines(draft.blocklist).length;
  const globalPersona = globalSettings?.reply?.persona || '';
  const connectPath = `/whatsapp/numbers/${encodeURIComponent(account.id)}/connect`;

  // 回复方式和原来的自动回复开关一样即时生效；接口没回完整的号时，replyMode 和兼容的 autoReply 一起改
  const changeMode = async (next) => {
    if (next === savedMode || pendingMode) return;
    setPendingMode(next);
    try {
      const res = await api.putAccount(account.id, { replyMode: next });
      if (!applyAccount(res)) {
        const patch = { replyMode: next, autoReply: next === 'auto' };
        setAccount((prev) => ({ ...prev, ...patch }));
        patchAccountCache({ id: account.id, ...patch });
      }
      toast.success(`回复方式已改为「${replyModeLabel(next)}」`);
    } catch {
      // 已提示
    } finally {
      setPendingMode(null);
    }
  };

  const save = async (e) => {
    e?.preventDefault();
    if (saving || !dirty) return;
    const patch = {
      persona: draft.persona,
      scope: draft.scope,
      allowlist: splitLines(draft.allowlist),
      blocklist: splitLines(draft.blocklist),
    };
    setSaving(true);
    try {
      const res = await api.putAccount(account.id, patch);
      const next = applyAccount(res) || { ...account, ...patch };
      if (!res?.id) setAccount(next);
      setDraft(replyDraft(next));
      toast.success('已保存');
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      as="form"
      title="回复"
      onSubmit={save}
      actions={<RestoreButton onClick={() => setDraft(REPLY_DEFAULTS)} disabled={saving || sameDraft(draft, REPLY_DEFAULTS)} />}
    >
      <SettingsRow label="回复方式">
        <div className="numbers-reply__mode">
          <Segmented label="回复方式" options={MODE_OPTIONS} value={mode} onChange={changeMode} disabled={!!pendingMode} />
          {pendingMode && <Spinner />}
        </div>
        <div className="field__hint">
          {modeDesc(mode)}
          {mode === 'off' && (
            <>
              {' '}
              公司话术在
              <Link to="/settings/suggest" className="link">
                设置 → 推荐回复
              </Link>
              里写。
            </>
          )}
        </div>
        {mode === 'auto' && !isConnected(account) && (
          <div className="field__hint numbers-reply__warn">
            这个号还没连接，{replyModeLabel(mode)}暂时不会生效。
            <Link to={connectPath} className="link">
              去连接
            </Link>
          </div>
        )}
      </SettingsRow>

      <SettingsRow
        label="身份和语气"
        htmlFor="rp-persona"
        hint="自动回复和推荐回复都按这里的身份和语气写，留空就用全局设置。例如：你是某某公司的销售小王，语气热情、专业，称呼客户为“您”。"
      >
        <textarea
          id="rp-persona"
          className="textarea"
          rows={3}
          placeholder={globalPersona ? `留空则使用全局设置：${globalPersona}` : '留空则使用全局设置'}
          value={draft.persona}
          onChange={(e) => set('persona', e.target.value)}
        />
      </SettingsRow>

      <SettingsRow label="回复范围" hint="范围外的号码，消息不会被回复，也不会保存到后台。群聊一律不回复。">
        <div className="choice-list" role="radiogroup" aria-label="回复范围">
          {REPLY_SCOPES.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                className="radio"
                name={`scope-${account.id}`}
                value={o.value}
                checked={draft.scope === o.value}
                onChange={() => set('scope', o.value)}
              />
              <span className="choice__text">
                <span>{o.label}</span>
                <span className="choice__desc">{o.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </SettingsRow>

      {draft.scope === 'allowlist' && (
        <SettingsRow label="白名单" htmlFor="rp-allow" hint="每行一个号码，带国家码，例如 8613800138000 或 +1 415 555 0100。">
          <textarea
            id="rp-allow"
            className="textarea input--mono"
            rows={6}
            value={draft.allowlist}
            placeholder={'8613800138000\n+1 415 555 0100'}
            onChange={(e) => set('allowlist', e.target.value)}
            spellCheck={false}
            aria-describedby="rp-allow-meta"
          />
          <div className="numbers-list-meta" id="rp-allow-meta">
            {allowCount === 0 ? (
              <span className="text-warning">白名单是空的，机器人不会回复任何人（外联对象除外）。</span>
            ) : (
              <span />
            )}
            <span className="num">{allowCount} 个号码</span>
          </div>
        </SettingsRow>
      )}

      <SettingsRow
        label="黑名单"
        htmlFor="rp-block"
        hint="每行一个号码。这些号码的消息不会保存到后台，也不会自动回复，适合填家人、朋友。"
      >
        <textarea
          id="rp-block"
          className="textarea input--mono"
          rows={6}
          value={draft.blocklist}
          placeholder="8613900139000"
          onChange={(e) => set('blocklist', e.target.value)}
          spellCheck={false}
        />
        <div className="numbers-list-meta">
          <span />
          <span className="num">{blockCount} 个号码</span>
        </div>
      </SettingsRow>

      <SaveBar dirty={dirty} saving={saving} onDiscard={() => setDraft(replyDraft(account))} />
    </SettingsSection>
  );
}

/* ================= 通知（拿不准时通知我） ================= */

const NOTIFY_DEFAULTS = { emailEnabled: false, emailTo: '', waEnabled: false, waNumber: '' };

function notifyDraft(a) {
  const e = a?.notify?.email || {};
  const w = a?.notify?.whatsapp || {};
  return {
    emailEnabled: !!e.enabled,
    emailTo: joinLines(e.to),
    waEnabled: !!w.enabled,
    waNumber: w.number || '',
  };
}

function validateNotify(d) {
  const err = {};
  if (d.emailEnabled && splitList(d.emailTo).length === 0) err.emailTo = '请至少填写一个收件人';
  if (d.waEnabled && !d.waNumber.trim()) err.waNumber = '请填写接收通知的号码';
  return err;
}

function TestLine({ label, result }) {
  if (result === undefined) return null;
  if (result === null) {
    return <StatusDot tone="neutral">{label}：未开启，没有发送</StatusDot>;
  }
  return result.ok ? (
    <StatusDot tone="success">{label}：发送成功，请查收</StatusDot>
  ) : (
    <StatusDot tone="danger">
      {label}：发送失败{result.error ? `：${result.error}` : ''}
    </StatusDot>
  );
}

const EMAIL_NOT_CONFIGURED = '还没有配置发信方式，先到设置里配置才能发邮件通知';

const NOTIFY_DESC = '需要人来处理时通知你：自动回复模式下机器人拿不准、没回复的问题，以及客户发来的语音、图片等机器人处理不了的消息';

/**
 * 号详情的「通知」分组。admin 能改；agent 只看开关状态（收件邮箱、号码接口不给 agent，改和测试通知都是 403）。
 */
export function NotifySection({ account, setAccount, globalSettings, isAdmin }) {
  if (!isAdmin) return <NotifyReadOnly account={account} />;
  return <NotifyForm account={account} setAccount={setAccount} globalSettings={globalSettings} />;
}

function OnOff({ on }) {
  return <StatusDot tone={on ? 'success' : 'neutral'}>{on ? '已开启' : '未开启'}</StatusDot>;
}

function NotifyReadOnly({ account }) {
  return (
    <SettingsSection title="通知" desc={`${NOTIFY_DESC}。收件人只有管理员能看和修改。`}>
      <SettingsRow inline label="邮件通知">
        <OnOff on={!!account.notify?.email?.enabled} />
      </SettingsRow>
      <SettingsRow inline label="WhatsApp 通知">
        <OnOff on={!!account.notify?.whatsapp?.enabled} />
      </SettingsRow>
    </SettingsSection>
  );
}

/**
 * 「通知」的编辑表单（admin）：邮件通知（开关和收件人，发信方式在设置页统一配置，F10）、WhatsApp 通知、发送测试通知。
 * globalSettings：admin 才拿得到。拿到时在全局没配发信方式时把邮件通知开关置灰，否则靠保存时的 400 email_not_configured 提示。
 */
function NotifyForm({ account, setAccount, globalSettings }) {
  const [draft, setDraft] = useState(() => notifyDraft(account));
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [emailBlocked, setEmailBlocked] = useState(false);
  const applyAccount = makeApplyAccount(setAccount);

  const base = useMemo(() => notifyDraft(account), [account]);
  const dirty = !sameDraft(base, draft);
  const errors = useMemo(() => validateNotify(draft), [draft]);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const errOf = (k) => (showErrors ? errors[k] : undefined);
  const savedEmailOn = !!account.notify?.email?.enabled;
  const savedWaOn = !!account.notify?.whatsapp?.enabled;
  const anyNotify = draft.emailEnabled || draft.waEnabled;
  // null = 不知道（全局设置还没拿到）
  const emailConfigured = globalSettings ? !!globalSettings.email?.provider : emailBlocked ? false : null;
  const emailSwitchDisabled = emailConfigured === false && !draft.emailEnabled;

  /** 保存通知设置；返回是否成功 */
  const saveAll = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) {
      toast.error('有设置需要修改，请检查标红的项目');
      return false;
    }
    const patch = {
      notify: {
        email: { enabled: draft.emailEnabled, to: splitList(draft.emailTo) },
        whatsapp: { enabled: draft.waEnabled, number: draft.waNumber.trim() },
      },
    };
    setSaving(true);
    try {
      const res = await api.putAccount(account.id, patch);
      const next = applyAccount(res) || { ...account, ...patch };
      if (!res?.id) setAccount(next);
      setDraft(notifyDraft(next));
      setShowErrors(false);
      setEmailBlocked(false);
      return true;
    } catch (e) {
      if (e?.code === 'email_not_configured') setEmailBlocked(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving || !dirty) return;
    if (await saveAll()) toast.success('已保存');
  };

  const discard = () => {
    setDraft(notifyDraft(account));
    setShowErrors(false);
  };

  const sendTest = async () => {
    setTestResult(null);
    // 测试的是已保存的设置：有未保存的修改时先保存
    if (dirty && !(await saveAll())) return;
    setTesting(true);
    try {
      const res = await api.testNotify(account.id);
      setTestResult(res || {});
    } catch {
      // 已提示
    } finally {
      setTesting(false);
    }
  };

  const testHint = !anyNotify
    ? '先开启至少一种通知方式'
    : dirty
      ? '会先保存当前修改，再发送测试'
      : `将发送到：${[savedEmailOn && '邮件', savedWaOn && 'WhatsApp'].filter(Boolean).join('、') || '—'}`;

  return (
    <SettingsSection
      as="form"
      title="通知"
      desc={NOTIFY_DESC}
      onSubmit={onSubmit}
      actions={<RestoreButton onClick={() => setDraft(NOTIFY_DEFAULTS)} disabled={saving || sameDraft(draft, NOTIFY_DEFAULTS)} />}
    >
      <SettingsRow inline label="邮件通知" hint="用「设置」里配置的发信方式发送">
        <Switch
          checked={draft.emailEnabled}
          onChange={(v) => set('emailEnabled', v)}
          disabled={emailSwitchDisabled}
          label="开启邮件通知"
        />
      </SettingsRow>

      {emailConfigured === false && (
        <div className="numbers-block">
          <Callout
            tone="warning"
            action={
              <Link to="/settings/email" className="btn btn--sm">
                去设置
              </Link>
            }
          >
            {EMAIL_NOT_CONFIGURED}
          </Callout>
        </div>
      )}

      {draft.emailEnabled && (
        <SettingsRow label="收件人" htmlFor="nt-to" hint="多个地址用逗号或换行分隔">
          <textarea
            id="nt-to"
            className="textarea"
            rows={2}
            placeholder="boss@example.com, sales@example.com"
            value={draft.emailTo}
            onChange={(e) => set('emailTo', e.target.value)}
            spellCheck={false}
            aria-invalid={errOf('emailTo') ? true : undefined}
            aria-describedby={errOf('emailTo') ? 'nt-to-err' : undefined}
          />
          {errOf('emailTo') && (
            <div className="field__error" id="nt-to-err">
              {errOf('emailTo')}
            </div>
          )}
        </SettingsRow>
      )}

      <SettingsRow inline label="WhatsApp 通知" hint="用这个号发给下面的号码；这个号码发来的消息不会被自动回复">
        <Switch checked={draft.waEnabled} onChange={(v) => set('waEnabled', v)} label="开启 WhatsApp 通知" />
      </SettingsRow>

      {draft.waEnabled && (
        <SettingsRow
          label="接收通知的号码"
          htmlFor="nt-wa"
          hint="带国家码，例如 8613800138000。Meta 官方接口的号，这个号码 24 小时内给企业号发过消息才能收到。"
        >
          <input
            id="nt-wa"
            className="input input--mono"
            placeholder="8613800138000"
            inputMode="tel"
            autoComplete="off"
            value={draft.waNumber}
            onChange={(e) => set('waNumber', e.target.value)}
            aria-invalid={errOf('waNumber') ? true : undefined}
            aria-describedby={errOf('waNumber') ? 'nt-wa-err' : 'nt-wa-usage'}
          />
          {errOf('waNumber') && (
            <div className="field__error" id="nt-wa-err">
              {errOf('waNumber')}
            </div>
          )}
          <div className="field__hint" id="nt-wa-usage">
            在 WhatsApp 里直接引用通知回复，内容会转发给客户；回复 /d 发送草稿，回复 /resume 恢复机器人。
          </div>
        </SettingsRow>
      )}

      <SettingsRow label="测试通知" hint={testHint}>
        <div className="numbers-test">
          <button type="button" className="btn" onClick={sendTest} disabled={testing || saving || !anyNotify}>
            {testing ? <Spinner /> : <Send />}
            发送测试通知
          </button>
          {testResult && (
            <div className="test-result" role="status">
              <TestLine label="邮件" result={testResult.email ?? null} />
              <TestLine label="WhatsApp" result={testResult.whatsapp ?? null} />
            </div>
          )}
        </div>
      </SettingsRow>

      <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
    </SettingsSection>
  );
}
