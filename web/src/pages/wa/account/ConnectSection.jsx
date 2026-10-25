import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, PlayCircle, PlugZap, RefreshCw, Send, Shuffle } from 'lucide-react';
import { api } from '../../../api/client.js';
import { toast } from '../../../ui/toastBus.js';
import { useConfirm } from '../../../ui/Modal.jsx';
import { Callout, CopyButton, Segmented, Spinner, Switch } from '../../../ui/common.jsx';
import { Advanced, SaveBar, SettingsRow, SettingsSection } from '../../../ui/Settings.jsx';
import { HintIcon } from '../../../ui/Popover.jsx';
import { Select } from '../../../ui/Select.jsx';
import { StatusDot } from '../../../ui/StatusDot.jsx';
import { SecretField } from '../../../ui/SecretField.jsx';
import { Avatar } from '../../../ui/Avatar.jsx';
import { usePolling } from '../../../hooks/usePolling.js';
import { isTelegram, waState } from '../../../lib/labels.js';
import { fmtTime } from '../../../lib/format.js';
import { mapServerError } from '../../settings/shared.jsx';
import { tgApiHashError, tgApiIdError, TGUSER_WARNING } from '../../../lib/tguser.js';
import { defaultCountry, formatPhone, toE164 } from '../../../lib/phone.js';
import { PhoneInput } from '../../../ui/PhoneInput.jsx';

/**
 * waha/start、waha/logout "语义同 SPEC.md 3.6"，返回的可能是 status 对象，也可能是整个 Account。
 * 两种都接：有 id 和 status 的当 Account，有 state 的当 status。
 */
export function mergeAccount(account, res) {
  if (!res || typeof res !== 'object') return account;
  if (res.id && res.status && typeof res.status === 'object') return { ...account, ...res };
  if (typeof res.state === 'string') return { ...account, status: { ...(account.status || {}), ...res } };
  return account;
}

const PRIVATE_OK = '支持个人号与 WhatsApp Business 号。';
const PRIVATE_TIP = '个人号建议在「回复」中设置白名单或黑名单，避免机器人回复亲友。';

/** 连接状态行：状态圆点，下面一行最近收到消息的时间 */
function StatusRow({ label, account, pollFailed }) {
  const status = account.status || {};
  const st = waState(status.state);
  return (
    <SettingsRow inline label={label} hint={status.lastWebhookAt ? `最近收到消息：${fmtTime(status.lastWebhookAt)}` : null}>
      {pollFailed && (
        <StatusDot tone="warning" size="sm">
          无法连接服务器，正在自动重试…
        </StatusDot>
      )}
      <StatusDot tone={st.tone} pulse={st.pulse}>
        {st.label}
      </StatusDot>
    </SettingsRow>
  );
}

/* ---------- IP 代理（admin，只作用于扫码连接） ---------- */

const PROXY_PROTOCOLS = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks4', label: 'SOCKS4' },
  { value: 'socks5', label: 'SOCKS5' },
];
const PROXY_DEFAULT_PORT = { http: '8080', https: '443', socks4: '1080', socks5: '1080' };
const protoLabel = (v) => PROXY_PROTOCOLS.find((p) => p.value === v)?.label || String(v || '').toUpperCase();

function proxyDraft(p) {
  return {
    enabled: !!p?.enabled,
    // 用全局代理（设置 → 代理）：这时下面自己的代理字段留着不用
    useGlobal: !!p?.useGlobal,
    // F13：四种协议都能用，默认 SOCKS5
    protocol: PROXY_PROTOCOLS.some((x) => x.value === p?.protocol) ? p.protocol : 'socks5',
    host: p?.host || '',
    port: p?.port === null || p?.port === undefined ? '' : String(p.port),
    username: p?.username || '',
  };
}

function validateProxy(d) {
  const errors = {};
  const host = d.host.trim();
  const port = d.port.trim();
  if (host.includes('://')) errors.host = '仅填写 IP 或域名，不含 http:// 等前缀';
  else if (/\s/.test(host)) errors.host = '地址不能包含空格';
  else if (d.enabled && !d.useGlobal && !host) errors.host = '开启代理时须填写地址';
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = '端口须为 1–65535 的整数';
  } else if (d.enabled && !d.useGlobal) {
    errors.port = '请填写端口';
  }
  return errors;
}

function ProxySection({ account, setAccount, connected, onApplied }) {
  const proxy = account.waha?.proxy || {};
  const wrapRef = useRef(null);
  const [draft, setDraft] = useState(() => proxyDraft(proxy));
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  // 全局代理开没开（开着才能选「用全局代理」）；null：还不知道
  const [globalOn, setGlobalOn] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .getSettings({ silent: true })
      .then((s) => alive && setGlobalOn(!!s?.proxy?.enabled))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const base = proxyDraft(proxy);
  const dirty = Object.keys(base).some((k) => base[k] !== draft[k]) || password !== '';
  const errors = validateProxy(draft);
  const errOf = (k) => (showErrors ? errors[k] : null);
  const id = account.id;

  const set = (k, v) => {
    setSaveError(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const discard = () => {
    setDraft(proxyDraft(proxy));
    setPassword('');
    setShowErrors(false);
    setSaveError(null);
  };

  const save = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) {
      // 出错的字段在折叠区里：展开让用户看到
      const details = wrapRef.current?.querySelector('details');
      if (details) details.open = true;
      toast.error('代理设置有误，请检查标红项');
      return false;
    }
    const patch = {
      enabled: draft.enabled,
      useGlobal: draft.useGlobal,
      protocol: draft.protocol,
      host: draft.host.trim(),
      port: draft.port.trim() ? Number(draft.port.trim()) : null,
      username: draft.username.trim(),
    };
    // 密码：只在输入了新值时提交，留空不改
    if (password !== '') patch.password = password;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.putAccount(account.id, { waha: { proxy: patch } }, { silent: true });
      const next = res && res.id ? res : { ...account, waha: { ...account.waha, proxy: { ...proxy, ...patch } } };
      setAccount(next);
      setDraft(proxyDraft(next.waha?.proxy));
      setPassword('');
      setShowErrors(false);
      onApplied?.();
      return true;
    } catch (e) {
      // 400 之类（如 proxy_protocol_unsupported）：把后端说明留在表单里
      const msg = e?.message || '保存失败';
      setSaveError(msg);
      toast.error(msg);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    setTestResult(null);
    if (await save()) toast.success(connected ? '已保存，WhatsApp 连接正在重启' : '已保存');
  };

  const clearPassword = async () => {
    setClearing(true);
    try {
      const res = await api.putAccount(account.id, { waha: { proxy: { password: '' } } });
      if (res && res.id) setAccount(res);
      setPassword('');
      toast.success('代理密码已清除');
      if (proxy.enabled) onApplied?.();
    } catch {
      // 已提示
    } finally {
      setClearing(false);
    }
  };

  const test = async () => {
    setTestResult(null);
    // 测试的是已保存的代理：有未保存的修改时先保存
    if (dirty && !(await save())) return;
    setTesting(true);
    try {
      setTestResult(await api.testProxy(account.id, { silent: true }));
    } catch (e) {
      setTestResult({ ok: false, error: e?.message });
    } finally {
      setTesting(false);
    }
  };

  const summary = !proxy.enabled
    ? '未开启'
    : proxy.useGlobal
      ? '使用全局代理'
      : `${protoLabel(proxy.protocol)} · ${proxy.host || '未填地址'}${proxy.port ? `:${proxy.port}` : ''}`;
  const own = !draft.useGlobal;

  return (
    <>
      <div ref={wrapRef}>
        <Advanced label={`IP 代理（可选） · ${summary}`}>
          <SettingsRow
            inline
            label="使用代理"
            htmlFor={`px-enabled-${id}`}
            hint="WhatsApp 将看到代理 IP；关闭时使用服务器自身网络。"
          >
            <Switch id={`px-enabled-${id}`} checked={draft.enabled} onChange={(v) => set('enabled', v)} label="使用代理" />
          </SettingsRow>

          <SettingsRow label="代理来源">
            <div className="choice-list" role="radiogroup" aria-label="代理来源">
              <label className="choice">
                <input
                  type="radio"
                  className="radio"
                  name={`px-kind-${id}`}
                  checked={own}
                  onChange={() => set('useGlobal', false)}
                />
                <span className="choice__text">
                  <span>独立代理</span>
                  <span className="choice__desc">该号码专用的 HTTP 或 SOCKS 代理。</span>
                </span>
              </label>
              <label className="choice">
                <input
                  type="radio"
                  className="radio"
                  name={`px-kind-${id}`}
                  checked={draft.useGlobal}
                  disabled={globalOn === false && !draft.useGlobal}
                  onChange={() => set('useGlobal', true)}
                />
                <span className="choice__text">
                  <span>全局代理</span>
                  <span className="choice__desc">
                    {globalOn === false && !draft.useGlobal
                      ? '全局代理未开启，请先在「设置 → 代理」中开启。'
                      : '经「设置 → 代理」中的节点连接 WhatsApp，与墨鸽自身请求共用出口。'}
                  </span>
                </span>
              </label>
            </div>
          </SettingsRow>

          {own && (
            <>
              <SettingsRow label="协议" htmlFor={`px-proto-${id}`}>
                <Select
                  id={`px-proto-${id}`}
                  value={draft.protocol}
                  onChange={(v) => set('protocol', v)}
                  options={PROXY_PROTOCOLS}
                />
              </SettingsRow>

              <SettingsRow
                label="地址"
                htmlFor={`px-host-${id}`}
                hint="127.0.0.1 指容器本身；使用服务器本机代理请填写 host.docker.internal"
              >
                <input
                  id={`px-host-${id}`}
                  className="input input--mono"
                  placeholder="proxy.example.com"
                  value={draft.host}
                  onChange={(e) => set('host', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={errOf('host') ? true : undefined}
                  aria-describedby={errOf('host') ? `px-host-${id}-err` : undefined}
                />
                {errOf('host') && (
                  <div className="field__error" id={`px-host-${id}-err`}>
                    {errOf('host')}
                  </div>
                )}
              </SettingsRow>

              <SettingsRow label="端口" htmlFor={`px-port-${id}`}>
                <input
                  id={`px-port-${id}`}
                  className="input input--mono numbers-port"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  placeholder={`${PROXY_DEFAULT_PORT[draft.protocol]}`}
                  value={draft.port}
                  onChange={(e) => set('port', e.target.value)}
                  aria-invalid={errOf('port') ? true : undefined}
                  aria-describedby={errOf('port') ? `px-port-${id}-err` : undefined}
                />
                {errOf('port') && (
                  <div className="field__error" id={`px-port-${id}-err`}>
                    {errOf('port')}
                  </div>
                )}
              </SettingsRow>

              <SettingsRow label="用户名（可选）" htmlFor={`px-user-${id}`} hint="代理无需认证时留空。">
                <input
                  id={`px-user-${id}`}
                  className="input"
                  value={draft.username}
                  onChange={(e) => set('username', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </SettingsRow>

              <SettingsRow label="密码（可选）" htmlFor={`px-pass-${id}`}>
                <SecretField
                  id={`px-pass-${id}`}
                  isSet={!!proxy.passwordSet}
                  value={password}
                  onChange={(v) => {
                    setSaveError(null);
                    setPassword(v);
                  }}
                  onClear={clearPassword}
                  clearing={clearing}
                />
              </SettingsRow>
            </>
          )}

          <SettingsRow
            label="连通测试"
            hint={
              !draft.enabled
                ? '开启「使用代理」后可测试。'
                : dirty
                  ? '有未保存的修改，测试前将自动保存。'
                  : '使用已保存的代理访问外网，显示出口 IP 与延迟。'
            }
          >
            <div className="numbers-test">
              <button type="button" className="btn" onClick={test} disabled={testing || saving || !draft.enabled}>
                {testing ? <Spinner /> : <PlugZap />}
                {testing ? '测试中…' : '测试代理'}
              </button>
              {testResult && (
                <div className="test-result" role="status">
                  {testResult.ok ? (
                    <StatusDot tone="success">
                      代理可用：出口 IP <span className="mono">{testResult.ip || '未知'}</span>
                      {typeof testResult.latencyMs === 'number' && <> · 延迟 {Math.round(testResult.latencyMs)} 毫秒</>}
                    </StatusDot>
                  ) : (
                    <StatusDot tone="danger">代理不可用：{testResult.error || '原因未知'}</StatusDot>
                  )}
                </div>
              )}
            </div>
          </SettingsRow>
        </Advanced>
      </div>

      {saveError && (
        <div className="numbers-block">
          <Callout tone="danger">代理设置保存失败：{saveError}</Callout>
        </div>
      )}

      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={discard}
        onSave={onSave}
        text={connected ? '有未保存的更改，保存后将重启 WhatsApp 连接' : '有未保存的更改'}
      />
    </>
  );
}

/* ---------- 扫码连接（WAHA） ---------- */

const LINK_MODES = [
  { value: 'qr', label: '扫码' },
  { value: 'code', label: '手机号配对码' },
];

// 服务端的 FAILED / 通行密钥提示以「重新连接」结尾（扫码模式的按钮名）；配对码模式下对应的是「重新获取配对码」
const codeModeError = (msg) => msg.replace(/重新连接$/, '重新获取配对码');

/** 扫码号的连接（admin）：扫码 / 配对码、登出、IP 代理 */
function WahaPanel({ account, setAccount }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null); // 'start' | 'logout' | 'code'
  const [qrTs, setQrTs] = useState(() => Date.now());
  const [qrState, setQrState] = useState('loading'); // loading | ok | error
  const [pollFailed, setPollFailed] = useState(false);
  // 点"开始连接"或改代理后 30 秒内也轮询，防止后端先返回 stopped 再异步变成 starting/scan_qr
  const [kickUntil, setKickUntil] = useState(0);
  // 关联方式：扫码或手机号配对码，两种共用同一轮等待关联和状态轮询
  const [mode, setMode] = useState('qr');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState(null);
  const [pair, setPair] = useState(null); // {code, phone, expired}

  const status = account.status || {};
  const state = status.state || 'not_configured';
  const waiting = state === 'scan_qr' || state === 'starting' || Date.now() < kickUntil;

  // 扫码/启动中：每 3 秒同时刷新状态和二维码（带时间戳防缓存）；离开页面自动停止
  usePolling(
    async () => {
      try {
        const a = await api.getAccount(account.id, { silent: true });
        setPollFailed(false);
        if (a) setAccount((prev) => ({ ...prev, ...a }));
        if (a?.status?.state === 'scan_qr') setQrTs(Date.now());
      } catch {
        setPollFailed(true);
      }
    },
    3000,
    waiting,
  );

  useEffect(() => {
    setQrState('loading');
    // 配对码只在这一轮等待关联里有效：连上了就收起；会话停掉或失败了，码随之作废
    if (state === 'working') setPair(null);
    else if (state === 'failed' || state === 'stopped') setPair((p) => (p ? { ...p, expired: true } : p));
  }, [state]);

  const refresh = () =>
    api
      .getAccount(account.id, { silent: true })
      .then((a) => a && setAccount((prev) => ({ ...prev, ...a })))
      .catch(() => {});

  // 申请配对码：服务端会先把会话拉起来、等到可以关联（最多十几秒），同一个号 20 秒内只能申请一次
  const requestCode = async (number = phone) => {
    const value = number.trim();
    if (!value) {
      setPhoneError('请填写手机号码');
      return;
    }
    setBusy('code');
    setPhoneError(null);
    try {
      const res = await api.wahaRequestCode(account.id, value, { silent: true });
      setPair({ code: res.code, phone: value, expired: false });
      setKickUntil(Date.now() + 30000);
      refresh();
    } catch (e) {
      if (e?.status === 401) return;
      // 号码格式不对：回到输入框，错误显示在下面；其余弹 Toast
      const fieldError = mapServerError(e, {}, { bad_phone: { field: 'phone', text: e?.message } });
      if (fieldError) {
        setPair(null);
        setPhoneError(fieldError.text);
      } else {
        toast.error(e?.message || '获取配对码失败');
      }
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy('start');
    try {
      const res = await api.wahaStart(account.id);
      setAccount((prev) => mergeAccount(prev, res));
      setQrTs(Date.now());
      setKickUntil(Date.now() + 30000);
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const onProxyApplied = () => {
    setKickUntil(Date.now() + 30000);
  };

  const logout = async () => {
    const ok = await confirm({
      title: '退出 WhatsApp 登录？',
      message: `退出后「${account.name}」将无法收发消息，需重新扫码恢复。手机上的聊天记录不受影响。`,
      confirmText: '退出登录',
      danger: true,
    });
    if (!ok) return;
    setBusy('logout');
    try {
      const res = await api.wahaLogout(account.id);
      setKickUntil(0);
      setAccount((prev) => mergeAccount(prev, res));
      toast.success('已退出登录');
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const meName = status.me?.pushName || '已登录帐号';

  return (
    <SettingsSection title="连接">
      <StatusRow label="连接状态" account={account} pollFailed={pollFailed} />

      {status.error && (
        <div className="numbers-block">
          <Callout tone="danger">{mode === 'code' ? codeModeError(status.error) : status.error}</Callout>
        </div>
      )}

      {state !== 'working' && (
        <SettingsRow inline label="关联方式">
          <Segmented label="关联方式" options={LINK_MODES} value={mode} onChange={setMode} />
        </SettingsRow>
      )}

      {state === 'working' ? (
        <SettingsRow label="已登录帐号">
          <div className="numbers-me">
            <Avatar name={status.me?.pushName || status.me?.id} />
            <div className="numbers-me__text">
              <span className="text-strong ellipsis">{meName}</span>
              <span className="muted text-sm mono ellipsis">{status.me?.id || ''}</span>
            </div>
            <span className="spacer" />
            <button type="button" className="btn btn--danger" onClick={logout} disabled={busy === 'logout'}>
              {busy === 'logout' ? <Spinner /> : <LogOut />}
              退出登录
            </button>
          </div>
        </SettingsRow>
      ) : mode === 'code' && pair ? (
        <div className="numbers-block">
          <div className="numbers-qr">
            <div className="card numbers-qr__card numbers-code" aria-live="polite">
              {pair.expired ? (
                <div className="numbers-code__expired">配对码已失效，请重新获取</div>
              ) : (
                <div className="numbers-code__value">{pair.code}</div>
              )}
              <div className="numbers-code__phone">
                关联号码 <span className="mono">{pair.phone}</span>
              </div>
              <div className="numbers-code__actions">
                {!pair.expired && <CopyButton text={pair.code} />}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => requestCode(pair.phone)}
                  disabled={busy === 'code'}
                >
                  {busy === 'code' ? <Spinner /> : <RefreshCw />}
                  重新获取
                </button>
              </div>
              <button type="button" className="btn btn--link btn--sm" onClick={() => setPair(null)}>
                更换号码
              </button>
            </div>
            <div className="numbers-qr__steps">
              <h3>使用手机号码关联</h3>
              <ol className="numbers-qr__list">
                <li>打开手机上的 WhatsApp</li>
                <li>
                  进入 <strong>设置</strong>（iPhone）或右上角 <strong>⋮ 菜单</strong>（安卓）→ <strong>已关联设备</strong>
                </li>
                <li>
                  点击 <strong>关联新设备</strong>，再点击 <strong>改用手机号码关联</strong>
                </li>
                <li>输入此处显示的配对码</li>
              </ol>
              <div className="field__hint">配对码有效期约 2 分钟，过期请重新获取。关联成功后状态自动变为「已连接」。</div>
            </div>
          </div>
        </div>
      ) : mode === 'code' ? (
        <SettingsRow label="手机号码" htmlFor={`pair-phone-${account.id}`} hint="含国家区号，如 +86 138 0000 0000">
          <form
            className="numbers-phone"
            onSubmit={(e) => {
              e.preventDefault();
              requestCode();
            }}
          >
            <input
              id={`pair-phone-${account.id}`}
              className="input input--mono"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="+86 138 0000 0000"
              value={phone}
              onChange={(e) => {
                setPhoneError(null);
                setPhone(e.target.value);
              }}
              aria-invalid={phoneError ? true : undefined}
              aria-describedby={phoneError ? `pair-phone-${account.id}-err` : undefined}
            />
            <button type="submit" className="btn btn--primary" disabled={busy === 'code'}>
              {busy === 'code' ? <Spinner /> : <KeyRound />}
              {busy === 'code' ? '获取中…' : '获取配对码'}
            </button>
          </form>
          {phoneError && (
            <div className="field__error" id={`pair-phone-${account.id}-err`}>
              {phoneError}
            </div>
          )}
        </SettingsRow>
      ) : state === 'scan_qr' || state === 'starting' ? (
        <div className="numbers-block">
          <div className="numbers-qr">
            <div className="card numbers-qr__card">
              {state === 'scan_qr' && (
                <img
                  src={api.wahaQrUrl(account.id, qrTs)}
                  alt="WhatsApp 登录二维码"
                  className={`numbers-qr__img${qrState === 'ok' ? '' : ' is-loading'}`}
                  onLoad={() => setQrState('ok')}
                  onError={() => setQrState('error')}
                />
              )}
              {state === 'starting' && <div className="numbers-qr__img is-loading" aria-hidden="true" />}
              {(state === 'starting' || qrState !== 'ok') && (
                <div className="numbers-qr__placeholder" role="status">
                  <Spinner size={20} />
                  <span>
                    {state === 'starting' ? '正在启动，即将显示二维码…' : qrState === 'error' ? '二维码生成中…' : '加载中…'}
                  </span>
                </div>
              )}
            </div>
            <div className="numbers-qr__steps">
              <h3>使用手机扫码登录</h3>
              <ol className="numbers-qr__list">
                <li>打开手机上的 WhatsApp</li>
                <li>
                  进入 <strong>设置</strong>（iPhone）或右上角 <strong>⋮ 菜单</strong>（安卓）→ <strong>已关联设备</strong>
                </li>
                <li>
                  点击 <strong>关联新设备</strong>，扫描二维码
                </li>
              </ol>
              <div className="field__hint">二维码每隔数秒自动刷新，扫码成功后状态自动变为「已连接」。</div>
              <div className="field__hint">
                {PRIVATE_OK}
                {PRIVATE_TIP}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <SettingsRow
          inline
          label={
            <span className="hstack" style={{ gap: 'var(--sp-1)' }}>
              WhatsApp 扫码登录
              <HintIcon label="扫码说明">{`${PRIVATE_OK}${PRIVATE_TIP}`}</HintIcon>
            </span>
          }
          hint={
            state === 'failed'
              ? '连接异常，可尝试重新连接；仍失败时将退出登录，需重新扫码。'
              : '点击按钮生成二维码，使用手机 WhatsApp 扫码关联。'
          }
        >
          <button type="button" className="btn btn--primary" onClick={start} disabled={busy === 'start'}>
            {busy === 'start' ? <Spinner /> : state === 'failed' ? <RefreshCw /> : <PlayCircle />}
            {state === 'failed' ? '重新连接' : '开始扫码登录'}
          </button>
        </SettingsRow>
      )}

      <ProxySection account={account} setAccount={setAccount} connected={state === 'working'} onApplied={onProxyApplied} />
    </SettingsSection>
  );
}

/**
 * 业务员看到的扫码号「连接」：只显示状态和已登录的账号。扫码、二维码、配对码、登出都只有管理员能做（agent 调会 403），
 * 这里一个都不渲染，二维码图片也不请求。
 */
function WahaReadOnly({ account }) {
  const status = account.status || {};
  const state = status.state || 'not_configured';
  return (
    <SettingsSection title="连接">
      <StatusRow label="连接状态" account={account} />
      {state === 'working' ? (
        <SettingsRow label="已登录帐号">
          <div className="numbers-me">
            <Avatar name={status.me?.pushName || status.me?.id} />
            <div className="numbers-me__text">
              <span className="text-strong ellipsis">{status.me?.pushName || '已登录帐号'}</span>
              <span className="muted text-sm mono ellipsis">{status.me?.id || ''}</span>
            </div>
          </div>
        </SettingsRow>
      ) : (
        <>
          {status.error && (
            <div className="numbers-block">
              <Callout tone="danger">{status.error}</Callout>
            </div>
          )}
          <div className="numbers-block muted">该号码未连接。扫码登录由管理员操作，如有问题请联系管理员。</div>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------- Meta 官方接口 ---------- */

function randomToken() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function metaDraft(meta) {
  return {
    phoneNumberId: meta?.phoneNumberId || '',
    apiVersion: meta?.apiVersion || 'v23.0',
    verifyToken: meta?.verifyToken || '',
  };
}

function MetaPanel({ account, setAccount, isAdmin }) {
  const meta = account.meta || {};
  const [form, setForm] = useState(() => metaDraft(meta));
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(null);

  const webhookUrl = meta.webhookUrl || '';
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const base = metaDraft(meta);
  const dirty = Object.keys(base).some((k) => base[k] !== form[k]) || accessToken.trim() !== '' || appSecret.trim() !== '';

  const discard = () => {
    setForm(metaDraft(meta));
    setAccessToken('');
    setAppSecret('');
  };

  const save = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const metaPatch = {
      phoneNumberId: form.phoneNumberId.trim(),
      apiVersion: form.apiVersion.trim() || 'v23.0',
      verifyToken: form.verifyToken.trim(),
    };
    // 密钥：只在输入了新值时提交，留空不改
    if (accessToken.trim()) metaPatch.accessToken = accessToken.trim();
    if (appSecret.trim()) metaPatch.appSecret = appSecret.trim();
    setSaving(true);
    try {
      const res = await api.putAccount(account.id, { meta: metaPatch });
      if (res && res.id) setAccount(res);
      else setAccount((prev) => ({ ...prev, meta: { ...prev.meta, ...metaPatch } }));
      setForm(metaDraft(res && res.id ? res.meta : { ...meta, ...metaPatch }));
      setAccessToken('');
      setAppSecret('');
      toast.success('已保存');
      api
        .getAccount(account.id, { silent: true })
        .then((a) => a && setAccount((prev) => ({ ...prev, ...a })))
        .catch(() => {});
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  const clearSecret = async (field) => {
    setClearing(field);
    try {
      const res = await api.putAccount(account.id, { meta: { [field]: '' } });
      if (res && res.id) setAccount(res);
      toast.success('已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(null);
    }
  };

  const errorBlock = account.status?.error && (
    <div className="numbers-block">
      <Callout tone="danger">{account.status.error}</Callout>
    </div>
  );

  // Meta 凭证只有 admin 能看和改
  if (!isAdmin) {
    return (
      <SettingsSection title="连接">
        <StatusRow label="接口状态" account={account} />
        {errorBlock}
        <div className="numbers-block muted">该号码通过 Meta 官方接口接入，凭证由管理员配置。</div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="连接" as="form" onSubmit={save}>
      <StatusRow label="接口状态" account={account} />
      {errorBlock}

      <SettingsRow
        label="Webhook 回调地址"
        htmlFor={`meta-hook-${account.id}`}
        hint="每个号码地址独立。在 Meta 开发者后台 → WhatsApp → 配置 → Webhook 中填写该地址，并订阅 messages 字段。"
      >
        <div className="numbers-inline">
          <input
            id={`meta-hook-${account.id}`}
            className="input input--mono"
            value={webhookUrl}
            readOnly
            onFocus={(e) => e.target.select()}
          />
          <CopyButton text={webhookUrl} size="md" />
        </div>
      </SettingsRow>

      <SettingsRow label="电话号码 ID（Phone number ID）" htmlFor="meta-pnid">
        <input
          id="meta-pnid"
          className="input input--mono"
          value={form.phoneNumberId}
          placeholder="见 WhatsApp → API 设置页面"
          onChange={(e) => set('phoneNumberId', e.target.value)}
          autoComplete="off"
        />
      </SettingsRow>

      <SettingsRow label="访问令牌（Access token）" htmlFor="meta-token">
        <SecretField
          id="meta-token"
          hint="建议使用系统用户的永久令牌。"
          isSet={!!meta.accessTokenSet}
          value={accessToken}
          onChange={setAccessToken}
          onClear={() => clearSecret('accessToken')}
          clearing={clearing === 'accessToken'}
        />
      </SettingsRow>

      <SettingsRow label="应用密钥（App secret）" htmlFor="meta-secret">
        <SecretField
          id="meta-secret"
          hint="用于校验消息来源；未设置时不接收任何消息。"
          isSet={!!meta.appSecretSet}
          value={appSecret}
          onChange={setAppSecret}
          onClear={() => clearSecret('appSecret')}
          clearing={clearing === 'appSecret'}
        />
      </SettingsRow>

      <SettingsRow label="验证令牌（Verify token）" htmlFor="meta-verify" hint="自定义字符串，需与 Meta 后台填写的值一致。">
        <div className="numbers-inline">
          <input
            id="meta-verify"
            className="input input--mono"
            value={form.verifyToken}
            onChange={(e) => set('verifyToken', e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn" onClick={() => set('verifyToken', randomToken())}>
            <Shuffle /> 生成
          </button>
        </div>
      </SettingsRow>

      <SettingsRow label="接口版本" htmlFor="meta-ver" hint="通常保持默认。">
        <input
          id="meta-ver"
          className="input input--mono"
          value={form.apiVersion}
          onChange={(e) => set('apiVersion', e.target.value)}
          autoComplete="off"
        />
      </SettingsRow>

      <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
    </SettingsSection>
  );
}

/* ---------- LINE 官方帐号 ---------- */

/**
 * LINE 官方帐号的「连接」：回调地址、Channel ID、Channel secret、Channel access token。
 * 状态里的 error 是最近一次推送失败的原因（每月额度用完、token 不对），推送成功后服务端会清掉
 */
function LinePanel({ account, setAccount, isAdmin }) {
  const line = account.line || {};
  const [channelId, setChannelId] = useState(line.channelId || '');
  const [channelSecret, setChannelSecret] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(null);

  const webhookUrl = line.webhookUrl || '';
  // LINE 只接受 https 的回调地址，发图片、文件给的也是这个域名下的地址
  const httpsOk = /^https:\/\//i.test(webhookUrl);
  const idError = channelId.trim() && !/^\d+$/.test(channelId.trim()) ? 'Channel ID 须为数字' : null;
  const dirty = channelId !== (line.channelId || '') || channelSecret.trim() !== '' || accessToken.trim() !== '';

  const discard = () => {
    setChannelId(line.channelId || '');
    setChannelSecret('');
    setAccessToken('');
  };

  const save = async (e) => {
    e?.preventDefault();
    if (saving || idError) return;
    const patch = { channelId: channelId.trim() };
    // 密钥：只在输入了新值时提交，留空不改
    if (channelSecret.trim()) patch.channelSecret = channelSecret.trim();
    if (accessToken.trim()) patch.accessToken = accessToken.trim();
    setSaving(true);
    try {
      const res = await api.putAccount(account.id, { line: patch });
      if (res && res.id) setAccount(res);
      setChannelId(res?.line?.channelId ?? patch.channelId);
      setChannelSecret('');
      setAccessToken('');
      toast.success('已保存');
      api
        .getAccount(account.id, { silent: true })
        .then((a) => a && setAccount((prev) => ({ ...prev, ...a })))
        .catch(() => {});
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  const clearSecret = async (field) => {
    setClearing(field);
    try {
      const res = await api.putAccount(account.id, { line: { [field]: '' } });
      if (res && res.id) setAccount(res);
      toast.success('已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(null);
    }
  };

  const errorBlock = account.status?.error && (
    <div className="numbers-block">
      <Callout tone="danger">{account.status.error}</Callout>
    </div>
  );
  const limits = (
    <div className="numbers-block muted text-sm">
      与 WhatsApp 的差异：仅可向好友发送消息，客户无手机号；客户消息 1 分钟内的回复不计入每月额度，超时回复和人工消息按推送计入；
      不支持发送文件，图片以外的文件以下载链接发送；已发消息不可撤回；不支持外联。
    </div>
  );

  // LINE 的凭证只有 admin 能看和改
  if (!isAdmin) {
    return (
      <SettingsSection title="连接">
        <StatusRow label="接口状态" account={account} />
        {errorBlock}
        <div className="numbers-block muted">该号码为 LINE 官方帐号，凭证由管理员配置。</div>
        {limits}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="连接" as="form" onSubmit={save}>
      <StatusRow label="接口状态" account={account} />
      {errorBlock}
      {!httpsOk && (
        <div className="numbers-block">
          <Callout tone="warning">
            LINE 仅接受 https:// 回调地址，当前地址无法接收消息或发送图片和文件。请按部署文档（docs/deploy.md）配置域名和
            HTTPS 反向代理，并将 INKDOVE_PUBLIC_BASE_URL 设为 https:// 公网地址。
          </Callout>
        </div>
      )}

      <SettingsRow
        label="Webhook URL"
        htmlFor={`line-hook-${account.id}`}
        hint="每个号码地址独立。在 LINE Developers Console → 该 channel 的 Messaging API 页面填入 Webhook URL，并开启「Use webhook」。"
      >
        <div className="numbers-inline">
          <input
            id={`line-hook-${account.id}`}
            className="input input--mono"
            value={webhookUrl}
            readOnly
            onFocus={(e) => e.target.select()}
          />
          <CopyButton text={webhookUrl} size="md" />
        </div>
      </SettingsRow>

      <SettingsRow label="Channel ID" htmlFor="line-channel-id" hint="见 Basic settings 页面。">
        <input
          id="line-channel-id"
          className="input input--mono"
          value={channelId}
          inputMode="numeric"
          placeholder="纯数字"
          onChange={(e) => setChannelId(e.target.value)}
          autoComplete="off"
          aria-invalid={idError ? true : undefined}
          aria-describedby={idError ? 'line-channel-id-err' : undefined}
        />
        {idError && (
          <div className="field__error" id="line-channel-id-err">
            {idError}
          </div>
        )}
      </SettingsRow>

      <SettingsRow label="Channel secret" htmlFor="line-secret">
        <SecretField
          id="line-secret"
          hint="见 Basic settings 页面。用于校验消息来源；未设置时不接收任何消息。"
          isSet={!!line.channelSecretSet}
          value={channelSecret}
          onChange={setChannelSecret}
          onClear={() => clearSecret('channelSecret')}
          clearing={clearing === 'channelSecret'}
        />
      </SettingsRow>

      <SettingsRow label="Channel access token" htmlFor="line-token">
        <SecretField
          id="line-token"
          hint="在 Messaging API 页面底部签发长期（long-lived）token。"
          isSet={!!line.accessTokenSet}
          value={accessToken}
          onChange={setAccessToken}
          onClear={() => clearSecret('accessToken')}
          clearing={clearing === 'accessToken'}
        />
      </SettingsRow>

      {limits}
      <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
    </SettingsSection>
  );
}

/* ---------- Telegram（机器人、私人号） ---------- */

const TG_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

/** 私人号「聊天自动化」里给机器人的一项权限：有就绿点，没有就灰点 */
function TgRight({ on, children }) {
  return (
    <StatusDot tone={on ? 'success' : 'neutral'} size="sm">
      {children}
      {on ? '：已开启' : '：未开启'}
    </StatusDot>
  );
}

/**
 * Telegram 号的「连接」：机器人 token、机器人的用户名；私人号再加绑定号主（绑定链接、换号主）和「聊天自动化」的连接、权限。
 * 墨鸽主动去 Telegram 取消息，不需要回调地址。没连好之前每 3 秒刷新一次状态，连好后每 15 秒（看有没有断开、改权限）
 */
function TelegramPanel({ account, setAccount, isAdmin }) {
  const confirm = useConfirm();
  const isBiz = account.channel === 'tgbiz';
  const tokenSet = !!account.telegram?.botTokenSet;
  const status = account.status || {};
  const tg = status.telegram || {};
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [rebinding, setRebinding] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);

  const tokenError = token.trim() && !TG_TOKEN_RE.test(token.trim()) ? '格式错误：应为 @BotFather 提供的完整 token（数字:字母串）' : null;
  const dirty = token.trim() !== '';

  usePolling(
    async () => {
      try {
        const a = await api.getAccount(account.id, { silent: true });
        setPollFailed(false);
        if (a) setAccount((prev) => ({ ...prev, ...a }));
      } catch {
        setPollFailed(true);
      }
    },
    status.state === 'working' ? 15000 : 3000,
    tokenSet,
  );

  const save = async (e) => {
    e?.preventDefault();
    if (saving || tokenError || !dirty) return;
    setSaving(true);
    try {
      const res = await api.putAccount(account.id, { telegram: { botToken: token.trim() } });
      if (res && res.id) setAccount(res);
      setToken('');
      toast.success('已保存，正在连接 Telegram');
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    const ok = await confirm({
      title: '清除机器人 token？',
      message: `清除后「${account.name}」停止收发 Telegram 消息，已有聊天记录不受影响。重新填写同一机器人的 token 即可恢复。`,
      confirmText: '清除',
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    try {
      const res = await api.putAccount(account.id, { telegram: { botToken: '' } });
      if (res && res.id) setAccount(res);
      toast.success('已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(false);
    }
  };

  const rebind = async () => {
    const ok = await confirm({
      title: '更换号主？',
      message: '将解除当前号主并生成新的绑定链接。重新绑定前，该号码无法收发 Telegram 消息。',
      confirmText: '更换号主',
      danger: true,
    });
    if (!ok) return;
    setRebinding(true);
    try {
      const res = await api.telegramRebind(account.id);
      if (res && res.id) setAccount(res);
      toast.success('已解除号主，请使用新的绑定链接重新绑定');
    } catch {
      // 已提示
    } finally {
      setRebinding(false);
    }
  };

  const tone = status.state === 'failed' ? 'danger' : 'warning';
  const errorBlock = status.error && (
    <div className="numbers-block">
      <Callout tone={tone}>{status.error}</Callout>
    </div>
  );

  const botLink = tg.botUsername ? `https://t.me/${tg.botUsername}` : '';
  const botRow = botLink && (
    <SettingsRow
      label="机器人"
      hint={isBiz ? '该机器人仅供该号码使用，勿用于其他程序。' : '客户打开链接或在 Telegram 中搜索机器人用户名即可发起会话。'}
    >
      <div className="numbers-inline">
        <a className="mono" href={botLink} target="_blank" rel="noreferrer">
          @{tg.botUsername}
        </a>
        <CopyButton text={botLink} label="复制链接" />
      </div>
    </SettingsRow>
  );

  const c = tg.connection;
  const bizRows = isBiz && tokenSet && (
    <>
      <SettingsRow
        label="号主"
        hint={
          tg.owner
            ? '仅接收号主本人在「聊天自动化」中关联的消息。'
            : isAdmin
              ? '由号主本人在 Telegram 中打开链接，点击「开始」（Start），机器人回复「已绑定到墨鸽」即完成。链接仅限使用一次，请勿转发。'
              : null
        }
      >
        {tg.owner ? (
          <div className="numbers-inline">
            <StatusDot tone="success">{tg.owner.name || '已绑定'}</StatusDot>
            {isAdmin && (
              <button type="button" className="btn btn--sm" onClick={rebind} disabled={rebinding}>
                {rebinding ? <Spinner /> : <RefreshCw />}
                更换号主
              </button>
            )}
          </div>
        ) : tg.bindLink ? (
          <div className="numbers-inline">
            <input className="input input--mono" value={tg.bindLink} readOnly onFocus={(e) => e.target.select()} aria-label="绑定链接" />
            <CopyButton text={tg.bindLink} size="md" />
          </div>
        ) : (
          <span className="muted">{isAdmin ? '连接 Telegram 后显示绑定链接…' : '未绑定，由管理员绑定'}</span>
        )}
      </SettingsRow>
      <SettingsRow
        label="聊天自动化"
        hint="在 Telegram「设置 → 聊天自动化」（英文界面：Settings → Chat Automation）中添加该机器人。撤回消息需开启删除消息权限，标记已读需开启读取消息权限。"
      >
        {!c ? (
          <span className="muted">未连接</span>
        ) : !c.enabled ? (
          <StatusDot tone="neutral">已断开{c.at ? `（${fmtTime(c.at)}）` : ''}</StatusDot>
        ) : !c.byOwner ? (
          <StatusDot tone="warning">已连接帐号「{c.name || '其他帐号'}」，非号主</StatusDot>
        ) : (
          <div className="vstack" style={{ gap: 'var(--sp-1)' }}>
            <StatusDot tone="success">已连接</StatusDot>
            <TgRight on={c.canReply}>回复消息</TgRight>
            <TgRight on={c.canRead}>标记已读</TgRight>
            <TgRight on={c.canDelete}>删除消息（撤回）</TgRight>
          </div>
        )}
      </SettingsRow>
    </>
  );

  const limits = (
    <div className="numbers-block muted text-sm">
      {isBiz
        ? '与 WhatsApp 的差异：客户看到的回复来自本人帐号；机器人仅可回复 24 小时内发来消息的私聊，不支持外联；客户无手机号，白名单和黑名单不适用；手机上发送的消息同步至墨鸽，记为手机回复；客户发来的文件超过 20MB 时无法下载。'
        : '与 WhatsApp 的差异：客户需先向机器人发送消息，机器人无法主动发起会话，不支持外联；客户无手机号，白名单和黑名单不适用；不支持标记已读；已发消息 48 小时内可撤回；客户发来的文件超过 20MB 时无法下载。'}
      服务器无法访问 Telegram 时，请在「设置 → 代理」中开启全局代理。
    </div>
  );

  // token 只有 admin 能看和改；业务员看得到状态、机器人、号主和连接，看不到绑定链接
  if (!isAdmin) {
    return (
      <SettingsSection title="连接">
        <StatusRow label="连接状态" account={account} pollFailed={pollFailed} />
        {errorBlock}
        {!tokenSet && <div className="numbers-block muted">该号码未填写机器人 token，由管理员配置。</div>}
        {botRow}
        {bizRows}
        {limits}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="连接" as="form" onSubmit={save}>
      <StatusRow label="连接状态" account={account} pollFailed={pollFailed} />
      {errorBlock}
      {isBiz && (
        <div className="numbers-block">
          <Callout tone="warning">
            {'墨鸽将接收该 Telegram 帐号的全部私聊消息（「聊天自动化」中排除的聊天除外），包括亲友消息；开启自动回复时，机器人以本人身份回复。' +
              '建议在「聊天自动化」中排除联系人、仅处理新聊天，或对该号码使用人工回复。'}
          </Callout>
        </div>
      )}
      {!tokenSet && (
        <div className="numbers-block">
          <Callout tone="info">
            {isBiz
              ? '1. 在 Telegram 打开 @BotFather，发送 /newbot 创建机器人，在 Bot Settings → Business Mode 中开启 Business Mode，将 token 填入下方。2. 保存后显示绑定链接，由号主本人在 Telegram 中打开。3. 在 Telegram「设置 → 聊天自动化」中添加该机器人，并开启回复消息权限。'
              : '在 Telegram 打开 @BotFather，发送 /newbot 创建机器人，将返回的 token 填入下方。墨鸽主动拉取消息，无需公网地址。'}
          </Callout>
        </div>
      )}

      <SettingsRow label="机器人 token" htmlFor={`tg-token-${account.id}`}>
        <SecretField
          id={`tg-token-${account.id}`}
          hint={
            isBiz
              ? '在 @BotFather 中选择该机器人 → API Token。更换机器人后需重新绑定号主，并在「聊天自动化」中重新添加。'
              : '在 @BotFather 中选择该机器人 → API Token。'
          }
          error={tokenError}
          isSet={tokenSet}
          value={token}
          onChange={setToken}
          onClear={clearToken}
          clearing={clearing}
        />
      </SettingsRow>
      {botRow}
      {bizRows}

      {limits}
      <SaveBar dirty={dirty} saving={saving} onDiscard={() => setToken('')} />
    </SettingsSection>
  );
}

/* ---------- Telegram 扫码登录 ---------- */

/** 登录的帐号：名字和用户名 */
function TgUserMe({ me, children }) {
  return (
    <div className="numbers-me">
      <Avatar name={me?.name || me?.username} />
      <div className="numbers-me__text">
        <span className="text-strong ellipsis">{me?.name || '已登录帐号'}</span>
        {me?.username && <span className="muted text-sm mono ellipsis">@{me.username}</span>}
      </div>
      {children}
    </div>
  );
}

const TGUSER_LIMITS =
  '与 WhatsApp 的差异：客户无手机号，白名单和黑名单不适用；仅接收私聊，不接收群组、频道和机器人消息；首次登录不导入历史聊天，仅接收登录后的新消息；' +
  '手机上发送的消息同步至墨鸽，记为手机回复；已发消息可随时撤回；不支持外联；客户发来的文件超过存储上限时不下载。服务器无法访问 Telegram 时，请在「设置 → 代理」中开启全局代理。';

/**
 * 从 my.telegram.org 自动取 api_id、api_hash：填手机号 → my.telegram.org 往这个帐号的 Telegram 里发验证码 → 填验证码 → 服务端登录、
 * 读出（没有就新建）应用并存进号。验证码填错可以再填，别的错回到填手机号这一步。这块在外层表单里，回车只做这一步，不提交外层
 */
function TgApiFetch({ account, onGot }) {
  const [stage, setStage] = useState('phone'); // phone | code
  const [phone, setPhone] = useState(() => ({ iso: defaultCountry(), digits: '' }));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null); // 'send' | 'apply'
  const [error, setError] = useState(null);
  const id = `tgu-fetch-${account.id}`;

  const send = async (e) => {
    e?.preventDefault();
    if (busy) return;
    if (!phone.digits) {
      setError('请输入手机号');
      return;
    }
    setBusy('send');
    setError(null);
    try {
      await api.tgUserApiCode(account.id, toE164(phone), { silent: true });
      setCode('');
      setStage('code');
    } catch (err) {
      if (err?.status === 401) return;
      setError(err?.message || '发送失败');
    } finally {
      setBusy(null);
    }
  };

  const apply = async (e) => {
    e?.preventDefault();
    if (busy) return;
    if (!code.trim()) {
      setError('请输入验证码');
      return;
    }
    setBusy('apply');
    setError(null);
    try {
      const res = await api.tgUserApiApply(account.id, code, { silent: true });
      onGot(res.account);
      toast.success(res.created ? '已创建应用 Inkdove，凭证已填入' : '凭证已填入');
    } catch (err) {
      if (err?.status === 401) return;
      // 验证码填错可以再填；别的错这个验证码已经作废，回到填手机号
      if (err?.code !== 'bad_code' && err?.code !== 'busy') setStage('phone');
      setError(err?.message || '获取失败');
    } finally {
      setBusy(null);
    }
  };

  const enter = (fn) => (e) => {
    if (e.key === 'Enter') fn(e);
  };
  const errorLine = error && (
    <div className="field__error" id={`${id}-err`}>
      {error}
    </div>
  );

  if (stage === 'code') {
    return (
      <SettingsRow
        key="code"
        label="验证码"
        htmlFor={`${id}-code`}
        hint={`已发送至 ${formatPhone(phone)} 的 Telegram（发件人：Telegram 官方），非短信。该验证码也可用于删除帐号，仅用于本次获取，不保存、不记录。`}
      >
        <div className="numbers-phone">
          <input
            id={`${id}-code`}
            className="input input--mono"
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            onChange={(e) => {
              setError(null);
              setCode(e.target.value);
            }}
            onKeyDown={enter(apply)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
          />
          <button type="button" className="btn btn--primary" onClick={apply} disabled={!!busy}>
            {busy === 'apply' ? <Spinner /> : <KeyRound />}
            {busy === 'apply' ? '获取中…' : '获取凭证'}
          </button>
          <button type="button" className="btn" onClick={send} disabled={!!busy}>
            {busy === 'send' ? <Spinner /> : null}
            重新发送
          </button>
          <button
            type="button"
            className="btn btn--link"
            onClick={() => {
              setError(null);
              setStage('phone');
            }}
            disabled={!!busy}
          >
            更换号码
          </button>
        </div>
        {errorLine}
      </SettingsRow>
    );
  }

  return (
    <SettingsRow
      key="phone"
      label="自动获取"
      htmlFor={`${id}-phone`}
      hint="通过 my.telegram.org 获取 api_id 和 api_hash；帐号下无应用时自动创建（名称 Inkdove）。"
    >
      <div className="numbers-phone">
        <PhoneInput
          id={`${id}-phone`}
          value={phone}
          onChange={(v) => {
            setError(null);
            setPhone(v);
          }}
          onEnter={send}
          invalid={!!error}
          describedBy={error ? `${id}-err` : undefined}
        />
        <button type="button" className="btn btn--primary" onClick={send} disabled={!!busy}>
          {busy === 'send' ? <Spinner /> : <Send />}
          {busy === 'send' ? '发送中…' : '发送验证码'}
        </button>
      </div>
      {errorLine}
    </SettingsRow>
  );
}

/**
 * Telegram 扫码登录的「连接」：api_id、api_hash（可以从 my.telegram.org 自动获取）；扫码登录（二维码约 30 秒换一次，按 qrVersion 换图），开了两步验证的接着输密码；
 * 登录的帐号和退出登录。等扫码、等密码时每 2 秒刷新一次状态，其余每 15 秒（看登录有没有失效）。业务员只看状态和登录的帐号
 */
function TgUserPanel({ account, setAccount, isAdmin }) {
  const confirm = useConfirm();
  const cfg = account.telegram || {};
  const configured = !!cfg.apiId && !!cfg.apiHashSet;
  const status = account.status || {};
  const state = status.state || 'not_configured';
  const tg = status.telegram || {};
  const [apiId, setApiId] = useState(cfg.apiId || '');
  const [apiHash, setApiHash] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(null); // 'login' | 'logout' | 'cancel' | 'password'
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState(null);
  const [qrState, setQrState] = useState('loading'); // loading | ok | error
  const [pollFailed, setPollFailed] = useState(false);
  // 点「扫码登录」后 10 秒内也按等扫码的频率刷新（服务端先回 starting，二维码随后才有）
  const [kickUntil, setKickUntil] = useState(0);

  const pending = state === 'starting' || state === 'scan_qr' || state === 'password';
  usePolling(
    async () => {
      try {
        const a = await api.getAccount(account.id, { silent: true });
        setPollFailed(false);
        if (a) setAccount((prev) => ({ ...prev, ...a }));
      } catch {
        setPollFailed(true);
      }
    },
    pending || Date.now() < kickUntil ? 2000 : 15000,
    configured,
  );

  useEffect(() => {
    if (state === 'scan_qr') setQrState('loading');
    if (state !== 'password') {
      setPassword('');
      setPwError(null);
    }
  }, [state]);

  const apiIdErr = tgApiIdError(apiId);
  const apiHashErr = tgApiHashError(apiHash);
  const dirty = apiId.trim() !== (cfg.apiId || '') || apiHash.trim() !== '';
  const discard = () => {
    setApiId(cfg.apiId || '');
    setApiHash('');
  };

  const save = async (e) => {
    e?.preventDefault();
    if (saving || apiIdErr || apiHashErr || !dirty) return;
    const patch = { apiId: apiId.trim() };
    // api_hash 只在输入了新值时提交，留空不改
    if (apiHash.trim()) patch.apiHash = apiHash.trim();
    setSaving(true);
    try {
      const res = await api.putAccount(account.id, { telegram: patch });
      if (res && res.id) setAccount(res);
      setApiId(res?.telegram?.apiId ?? patch.apiId);
      setApiHash('');
      toast.success('已保存');
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  // 自动获取到了：号已经存好，输入框跟着换成新的 api_id
  const onGot = (acc) => {
    if (acc && acc.id) setAccount((prev) => ({ ...prev, ...acc }));
    setApiId(acc?.telegram?.apiId ?? '');
    setApiHash('');
  };

  const clearHash = async () => {
    const ok = await confirm({
      title: '清除 api_hash？',
      message: `清除后「${account.name}」断开 Telegram，停止收发消息；登录状态保留，重新填写 api_hash 后自动连接。`,
      confirmText: '清除',
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    try {
      const res = await api.putAccount(account.id, { telegram: { apiHash: '' } });
      if (res && res.id) setAccount(res);
      toast.success('已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(false);
    }
  };

  const login = async () => {
    setBusy('login');
    try {
      const res = await api.tgUserLogin(account.id);
      if (res && res.id) setAccount((prev) => ({ ...prev, ...res }));
      setKickUntil(Date.now() + 10000);
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  // 正在扫码、等密码时停下：服务端按退出登录处理（还没登录上，不用通知 Telegram）
  const cancel = async () => {
    setBusy('cancel');
    try {
      const res = await api.tgUserLogout(account.id);
      if (res && res.id) setAccount((prev) => ({ ...prev, ...res }));
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    const ok = await confirm({
      title: '退出 Telegram 登录？',
      message: `退出后「${account.name}」停止收发 Telegram 消息，墨鸽将从帐号设备列表中移除，需重新扫码恢复。手机上的聊天记录不受影响。`,
      confirmText: '退出登录',
      danger: true,
    });
    if (!ok) return;
    setBusy('logout');
    try {
      const res = await api.tgUserLogout(account.id);
      if (res && res.id) setAccount((prev) => ({ ...prev, ...res }));
      toast.success('已退出登录');
    } catch {
      // 已提示；服务端这时也已经删掉了本地的登录态，刷新一下状态
      api
        .getAccount(account.id, { silent: true })
        .then((a) => a && setAccount((prev) => ({ ...prev, ...a })))
        .catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const submitPassword = async (e) => {
    e?.preventDefault();
    if (busy === 'password') return;
    if (!password) {
      setPwError('请输入两步验证密码');
      return;
    }
    setBusy('password');
    setPwError(null);
    try {
      const res = await api.tgUserPassword(account.id, password, { silent: true });
      setPassword('');
      if (res && res.id) setAccount((prev) => ({ ...prev, ...res }));
      toast.success('已登录 Telegram');
    } catch (err) {
      if (err?.status === 401) return;
      if (err?.code === 'wrong_password') setPwError(err.message);
      else toast.error(err?.message || '登录失败');
    } finally {
      setBusy(null);
    }
  };

  const errorBlock = status.error && (
    <div className="numbers-block">
      <Callout tone={state === 'failed' ? 'danger' : 'warning'}>{status.error}</Callout>
    </div>
  );
  const limits = <div className="numbers-block muted text-sm">{TGUSER_LIMITS}</div>;

  // api_id、api_hash、扫码、密码、退出登录只有 admin 能做（业务员调会 403），二维码图片也不请求
  if (!isAdmin) {
    return (
      <SettingsSection title="连接">
        <StatusRow label="连接状态" account={account} pollFailed={pollFailed} />
        {errorBlock}
        {state === 'working' ? (
          <SettingsRow label="登录的帐号">
            <TgUserMe me={tg.me} />
          </SettingsRow>
        ) : (
          <div className="numbers-block muted">该号码未登录 Telegram。扫码登录由管理员操作，如有问题请联系管理员。</div>
        )}
        {limits}
      </SettingsSection>
    );
  }

  let loginBlock = null;
  if (state === 'working') {
    loginBlock = (
      <SettingsRow label="登录的帐号" hint="墨鸽（Inkdove）显示在手机 Telegram「设置 → 设备」中，在该处结束会话等同于退出登录。">
        <TgUserMe me={tg.me}>
          <span className="spacer" />
          <button type="button" className="btn btn--danger" onClick={logout} disabled={busy === 'logout'}>
            {busy === 'logout' ? <Spinner /> : <LogOut />}
            退出登录
          </button>
        </TgUserMe>
      </SettingsRow>
    );
  } else if (state === 'scan_qr' || state === 'starting') {
    loginBlock = (
      <div className="numbers-block">
        <div className="numbers-qr">
          <div className="card numbers-qr__card">
            {state === 'scan_qr' && tg.qrVersion != null ? (
              <img
                src={api.tgUserQrUrl(account.id, tg.qrVersion)}
                alt="Telegram 登录二维码"
                className={`numbers-qr__img${qrState === 'ok' ? '' : ' is-loading'}`}
                onLoad={() => setQrState('ok')}
                onError={() => setQrState('error')}
              />
            ) : (
              <div className="numbers-qr__img is-loading" aria-hidden="true" />
            )}
            {(state === 'starting' || qrState !== 'ok') && (
              <div className="numbers-qr__placeholder" role="status">
                <Spinner size={20} />
                <span>{state === 'starting' ? '正在连接 Telegram…' : qrState === 'error' ? '二维码生成中…' : '加载中…'}</span>
              </div>
            )}
          </div>
          <div className="numbers-qr__steps">
            <h3>使用手机 Telegram 扫码登录</h3>
            <ol className="numbers-qr__list">
              <li>在手机上打开 Telegram，登录待接入的帐号</li>
              <li>
                进入 <strong>设置 → 设备</strong>
              </li>
              <li>
                点击 <strong>连接桌面设备</strong>（英文界面：Link Desktop Device），扫描二维码
              </li>
            </ol>
            <div className="field__hint">二维码约 30 秒自动刷新；已开启两步验证的帐号扫码后需在此输入密码。5 分钟内未完成将自动停止。</div>
            <div>
              <button type="button" className="btn btn--sm" onClick={cancel} disabled={busy === 'cancel'}>
                {busy === 'cancel' ? <Spinner /> : null}
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  } else if (state === 'password') {
    loginBlock = (
      <SettingsRow
        label="两步验证密码"
        htmlFor={`tgu-pw-${account.id}`}
        hint="该帐号已开启两步验证（Telegram「设置 → 隐私与安全 → 两步验证」）。密码仅用于本次登录，不保存。"
      >
        <div className="numbers-phone">
          <input
            id={`tgu-pw-${account.id}`}
            className="input"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => {
              setPwError(null);
              setPassword(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPassword(e);
            }}
            aria-invalid={pwError ? true : undefined}
            aria-describedby={pwError ? `tgu-pw-${account.id}-err` : undefined}
          />
          <button type="button" className="btn btn--primary" onClick={submitPassword} disabled={busy === 'password'}>
            {busy === 'password' ? <Spinner /> : <KeyRound />}
            登录
          </button>
          <button type="button" className="btn" onClick={cancel} disabled={busy === 'cancel'}>
            取消
          </button>
        </div>
        {pwError && (
          <div className="field__error" id={`tgu-pw-${account.id}-err`}>
            {pwError}
          </div>
        )}
      </SettingsRow>
    );
  } else if (configured) {
    loginBlock = (
      <SettingsRow
        inline
        label="扫码登录"
        hint={state === 'failed' ? '连接异常，正在自动重试；也可重新扫码登录。' : '点击按钮生成二维码，使用手机 Telegram 扫码登录该帐号。'}
      >
        <button type="button" className="btn btn--primary" onClick={login} disabled={busy === 'login'}>
          {busy === 'login' ? <Spinner /> : <PlayCircle />}
          {state === 'failed' ? '重新扫码登录' : '扫码登录'}
        </button>
      </SettingsRow>
    );
  }

  return (
    <SettingsSection title="连接" as="form" onSubmit={save}>
      <StatusRow label="连接状态" account={account} pollFailed={pollFailed} />
      {errorBlock}
      {state !== 'working' && (
        <div className="numbers-block">
          <Callout tone="warning">{TGUSER_WARNING}</Callout>
        </div>
      )}
      {!configured && (
        <>
          <div className="numbers-block">
            <Callout tone="info">
              1. 获取 api_id 和 api_hash：在下方自动获取，或在{' '}
              <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
                my.telegram.org
              </a>{' '}
              → API development tools 创建应用后手动填入。2. 点击「扫码登录」，用手机 Telegram 扫码。
            </Callout>
          </div>
          <TgApiFetch account={account} onGot={onGot} />
        </>
      )}
      {loginBlock}

      <SettingsRow label="api_id" htmlFor={`tgu-api-id-${account.id}`} hint="my.telegram.org → API development tools 中的 App api_id。">
        <input
          id={`tgu-api-id-${account.id}`}
          className="input input--mono"
          value={apiId}
          inputMode="numeric"
          placeholder="纯数字"
          onChange={(e) => setApiId(e.target.value)}
          autoComplete="off"
          aria-invalid={apiIdErr ? true : undefined}
          aria-describedby={apiIdErr ? `tgu-api-id-${account.id}-err` : undefined}
        />
        {apiIdErr && (
          <div className="field__error" id={`tgu-api-id-${account.id}-err`}>
            {apiIdErr}
          </div>
        )}
      </SettingsRow>
      <SettingsRow label="api_hash" htmlFor={`tgu-api-hash-${account.id}`}>
        <SecretField
          id={`tgu-api-hash-${account.id}`}
          hint="同一页面的 App api_hash。"
          error={apiHashErr}
          isSet={!!cfg.apiHashSet}
          value={apiHash}
          onChange={setApiHash}
          onClear={clearHash}
          clearing={clearing}
        />
      </SettingsRow>

      {limits}
      <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
    </SettingsSection>
  );
}

/** 号详情的「连接」分组：扫码号显示扫码流程和 IP 代理，Meta 号、LINE 官方帐号、Telegram 号显示凭证；业务员只看状态 */
export default function ConnectSection({ account, setAccount, isAdmin }) {
  if (account.channel === 'meta') return <MetaPanel account={account} setAccount={setAccount} isAdmin={isAdmin} />;
  if (account.channel === 'line') return <LinePanel account={account} setAccount={setAccount} isAdmin={isAdmin} />;
  if (account.channel === 'tguser') return <TgUserPanel account={account} setAccount={setAccount} isAdmin={isAdmin} />;
  if (isTelegram(account.channel)) return <TelegramPanel account={account} setAccount={setAccount} isAdmin={isAdmin} />;
  if (account.channel !== 'waha') {
    return (
      <SettingsSection title="连接">
        <div className="numbers-block">
          <Callout tone="warning">不支持该号码的接入方式（{String(account.channel || '空')}），请升级墨鸽后重试。</Callout>
        </div>
      </SettingsSection>
    );
  }
  if (!isAdmin) return <WahaReadOnly account={account} />;
  return <WahaPanel account={account} setAccount={setAccount} />;
}
