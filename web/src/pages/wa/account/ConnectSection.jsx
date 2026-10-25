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

const PRIVATE_OK = '私人号和 WhatsApp Business 号都可以扫码连接。';
const PRIVATE_TIP = '如果用的是私人号，建议在「回复」里设置白名单或黑名单，避免机器人回复亲友。';

/** 连接状态行：状态圆点，下面一行最近收到消息的时间 */
function StatusRow({ label, account, pollFailed }) {
  const status = account.status || {};
  const st = waState(status.state);
  return (
    <SettingsRow inline label={label} hint={status.lastWebhookAt ? `最近收到消息：${fmtTime(status.lastWebhookAt)}` : null}>
      {pollFailed && (
        <StatusDot tone="warning" size="sm">
          暂时连不上服务器，正在自动重试…
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
  if (host.includes('://')) errors.host = '只填地址或域名，不要带 http:// 之类的前缀';
  else if (/\s/.test(host)) errors.host = '地址里不能有空格';
  else if (d.enabled && !d.useGlobal && !host) errors.host = '开启代理时必须填写地址';
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = '端口是 1–65535 之间的整数';
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
      toast.error('代理设置有误，请检查标红的项目');
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
    if (await save()) toast.success(connected ? '代理设置已保存，WhatsApp 连接正在重启' : '已保存');
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
      ? '用全局代理'
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
            hint="WhatsApp 会看到这个代理的 IP；不填就用服务器本身的网络。"
          >
            <Switch id={`px-enabled-${id}`} checked={draft.enabled} onChange={(v) => set('enabled', v)} label="使用代理" />
          </SettingsRow>

          <SettingsRow label="用哪个代理">
            <div className="choice-list" role="radiogroup" aria-label="用哪个代理">
              <label className="choice">
                <input
                  type="radio"
                  className="radio"
                  name={`px-kind-${id}`}
                  checked={own}
                  onChange={() => set('useGlobal', false)}
                />
                <span className="choice__text">
                  <span>单独填一个代理</span>
                  <span className="choice__desc">这个号自己的 HTTP 或 SOCKS 代理，填在下面。</span>
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
                  <span>用全局代理</span>
                  <span className="choice__desc">
                    {globalOn === false && !draft.useGlobal
                      ? '全局代理没有开启：请先在「设置 → 代理」里开启。'
                      : '经「设置 → 代理」里的机场节点连 WhatsApp，和墨鸽自己的请求用同一个出口。'}
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
                hint="填 127.0.0.1 指的是容器自己，要用服务器本机上的代理请填 host.docker.internal"
              >
                <input
                  id={`px-host-${id}`}
                  className="input input--mono"
                  placeholder="例如 1.2.3.4 或 proxy.example.com"
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
                  placeholder={`例如 ${PROXY_DEFAULT_PORT[draft.protocol]}`}
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

              <SettingsRow label="用户名（可选）" htmlFor={`px-user-${id}`} hint="代理不需要登录就留空。">
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
                ? '打开"使用代理"后才能测试。'
                : dirty
                  ? '有未保存的修改；点"测试代理"会先保存。'
                  : '用已保存的代理连一次外网，显示出口 IP 和延迟。'
            }
          >
            <div className="numbers-test">
              <button type="button" className="btn" onClick={test} disabled={testing || saving || !draft.enabled}>
                {testing ? <Spinner /> : <PlugZap />}
                {testing ? '正在测试…' : '测试代理'}
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
          <Callout tone="danger">代理设置没有保存：{saveError}</Callout>
        </div>
      )}

      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={discard}
        onSave={onSave}
        text={connected ? '有未保存的更改，保存后会重启 WhatsApp 连接' : '有未保存的更改'}
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
      message: `退出后「${account.name}」将无法收发消息，需要重新扫码才能恢复。手机上的聊天记录不受影响。`,
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

  const meName = status.me?.pushName || '已登录账号';

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
        <SettingsRow label="已登录账号">
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
                换号码
              </button>
            </div>
            <div className="numbers-qr__steps">
              <h3>用手机号码关联</h3>
              <ol className="numbers-qr__list">
                <li>打开手机上的 WhatsApp</li>
                <li>
                  进入 <strong>设置</strong>（iPhone）或右上角 <strong>⋮ 菜单</strong>（安卓）→ <strong>已关联设备</strong>
                </li>
                <li>
                  点 <strong>关联新设备</strong>，再点 <strong>改用手机号码关联</strong>
                </li>
                <li>输入这里显示的配对码</li>
              </ol>
              <div className="field__hint">配对码约 2 分钟内有效，过期请重新获取。关联成功后这里会自动变为"已连接"。</div>
            </div>
          </div>
        </div>
      ) : mode === 'code' ? (
        <SettingsRow label="手机号码" htmlFor={`pair-phone-${account.id}`} hint="带国家码，例如 +86 138 0000 0000">
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
              {busy === 'code' ? '正在获取…' : '获取配对码'}
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
                    {state === 'starting' ? '正在启动，马上就会显示二维码…' : qrState === 'error' ? '二维码生成中…' : '加载中…'}
                  </span>
                </div>
              )}
            </div>
            <div className="numbers-qr__steps">
              <h3>用手机扫码登录</h3>
              <ol className="numbers-qr__list">
                <li>打开手机上的 WhatsApp</li>
                <li>
                  进入 <strong>设置</strong>（iPhone）或右上角 <strong>⋮ 菜单</strong>（安卓）→ <strong>已关联设备</strong>
                </li>
                <li>
                  点 <strong>关联新设备</strong>，扫描二维码
                </li>
              </ol>
              <div className="field__hint">二维码每隔几秒自动刷新，扫码成功后这里会自动变为"已连接"。</div>
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
              扫码连接
              <HintIcon label="扫码说明">{`${PRIVATE_OK}${PRIVATE_TIP}`}</HintIcon>
            </span>
          }
          hint={
            state === 'failed'
              ? '连接出了问题，可以尝试重新连接；还连不上才会退出登录重来，那时需要重新扫码。'
              : '点击按钮生成二维码，然后用手机 WhatsApp 扫码关联。'
          }
        >
          <button type="button" className="btn btn--primary" onClick={start} disabled={busy === 'start'}>
            {busy === 'start' ? <Spinner /> : state === 'failed' ? <RefreshCw /> : <PlayCircle />}
            {state === 'failed' ? '重新连接' : '开始扫码连接'}
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
        <SettingsRow label="已登录账号">
          <div className="numbers-me">
            <Avatar name={status.me?.pushName || status.me?.id} />
            <div className="numbers-me__text">
              <span className="text-strong ellipsis">{status.me?.pushName || '已登录账号'}</span>
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
          <div className="numbers-block muted">这个号还没连上。扫码连接由管理员操作，有问题请联系管理员。</div>
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
        <div className="numbers-block muted">这个号通过 Meta 官方接口接入，接口凭证由管理员配置。</div>
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
        hint="每个号各有一个地址。在 Meta 开发者后台 → WhatsApp → 配置 → Webhook 中填写这个地址，并订阅 messages 字段。"
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
          placeholder="在 WhatsApp → API 设置 页面可以找到"
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
          hint="用于校验消息确实来自 Meta，未设置时不会接收任何消息。"
          isSet={!!meta.appSecretSet}
          value={appSecret}
          onChange={setAppSecret}
          onClear={() => clearSecret('appSecret')}
          clearing={clearing === 'appSecret'}
        />
      </SettingsRow>

      <SettingsRow label="验证令牌（Verify token）" htmlFor="meta-verify" hint="自己设定的一串字符，在 Meta 后台填写相同的值。">
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

      <SettingsRow label="接口版本" htmlFor="meta-ver" hint="一般保持默认即可。">
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
  const idError = channelId.trim() && !/^\d+$/.test(channelId.trim()) ? 'Channel ID 只能是数字' : null;
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
      LINE 和 WhatsApp 不一样的地方：只能给加了好友的人发消息，客户没有手机号；客户来消息 1 分钟内的回复不算每月额度，
      更晚的回复、人工发的消息按推送算进每月额度；发不了文件，图片以外的文件会发成下载链接；已发出的消息不能撤回；不能外联群发。
    </div>
  );

  // LINE 的凭证只有 admin 能看和改
  if (!isAdmin) {
    return (
      <SettingsSection title="连接">
        <StatusRow label="接口状态" account={account} />
        {errorBlock}
        <div className="numbers-block muted">这个号是 LINE 官方帐号，接口凭证由管理员配置。</div>
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
            LINE 只接受 https:// 开头的回调地址，现在的地址收不到消息，也发不了图片和文件。请按部署文档（docs/deploy.md）给墨鸽配好域名和
            HTTPS 反向代理，并把 INKDOVE_PUBLIC_BASE_URL 设成 https:// 开头的公网地址。
          </Callout>
        </div>
      )}

      <SettingsRow
        label="Webhook URL"
        htmlFor={`line-hook-${account.id}`}
        hint="每个号各有一个地址。在 LINE Developers Console → 这个 channel 的 Messaging API 页面填到 Webhook URL，并打开「Use webhook」。"
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

      <SettingsRow label="Channel ID" htmlFor="line-channel-id" hint="在 Basic settings 页面。">
        <input
          id="line-channel-id"
          className="input input--mono"
          value={channelId}
          inputMode="numeric"
          placeholder="一串数字"
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
          hint="在 Basic settings 页面。用于校验消息确实来自 LINE，未设置时不会接收任何消息。"
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
          hint="在 Messaging API 页面最下面签发长期的（long-lived）token。"
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
      {on ? '：已打开' : '：没打开'}
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

  const tokenError = token.trim() && !TG_TOKEN_RE.test(token.trim()) ? '格式不对：应该是 @BotFather 给的「数字:一串字母」那一整段' : null;
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
      message: `清除后「${account.name}」不再收发 Telegram 消息，已有的聊天记录不受影响。填回同一个机器人的 token 后接着用。`,
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
      title: '换号主？',
      message: '会清掉现在绑定的号主，生成新的绑定链接。重新绑定之前，这个号收不到也发不出 Telegram 消息。',
      confirmText: '换号主',
      danger: true,
    });
    if (!ok) return;
    setRebinding(true);
    try {
      const res = await api.telegramRebind(account.id);
      if (res && res.id) setAccount(res);
      toast.success('已清掉号主，请用新的绑定链接重新绑定');
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
      hint={isBiz ? '这个机器人只给这个号用，不要再给别的程序。' : '客户打开这个链接、或者在 Telegram 里搜索机器人的用户名就能来聊。'}
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
            ? '只收号主本人在「聊天自动化」里连上的消息。'
            : isAdmin
              ? '用这个私人号本人的 Telegram 打开链接，点「开始」（Start），机器人会回一句「已绑定到墨鸽」。链接只能用一次，不要发给别人。'
              : null
        }
      >
        {tg.owner ? (
          <div className="numbers-inline">
            <StatusDot tone="success">{tg.owner.name || '已绑定'}</StatusDot>
            {isAdmin && (
              <button type="button" className="btn btn--sm" onClick={rebind} disabled={rebinding}>
                {rebinding ? <Spinner /> : <RefreshCw />}
                换号主
              </button>
            )}
          </div>
        ) : tg.bindLink ? (
          <div className="numbers-inline">
            <input className="input input--mono" value={tg.bindLink} readOnly onFocus={(e) => e.target.select()} aria-label="绑定链接" />
            <CopyButton text={tg.bindLink} size="md" />
          </div>
        ) : (
          <span className="muted">{isAdmin ? '连上 Telegram 后显示绑定链接…' : '还没有绑定，由管理员绑定'}</span>
        )}
      </SettingsRow>
      <SettingsRow
        label="聊天自动化"
        hint="在 Telegram 的「设置 → 聊天自动化」（英文界面是 Settings → Chat Automation）里添加这个机器人。要撤回消息，再打开删除消息的权限；要标已读，再打开读消息的权限。"
      >
        {!c ? (
          <span className="muted">还没有连上</span>
        ) : !c.enabled ? (
          <StatusDot tone="neutral">已断开{c.at ? `（${fmtTime(c.at)}）` : ''}</StatusDot>
        ) : !c.byOwner ? (
          <StatusDot tone="warning">连上的是「{c.name || '另一个帐号'}」，不是号主</StatusDot>
        ) : (
          <div className="vstack" style={{ gap: 'var(--sp-1)' }}>
            <StatusDot tone="success">已连上</StatusDot>
            <TgRight on={c.canReply}>回复消息</TgRight>
            <TgRight on={c.canRead}>标已读</TgRight>
            <TgRight on={c.canDelete}>删除消息（撤回）</TgRight>
          </div>
        )}
      </SettingsRow>
    </>
  );

  const limits = (
    <div className="numbers-block muted text-sm">
      {isBiz
        ? '和 WhatsApp 不一样的地方：客户看到的是你本人在回复；机器人只能回复 24 小时内给你发过消息的私聊，不能外联群发；客户没有手机号，白名单和黑名单用不上；你在手机上发的消息也会同步进墨鸽，记为手机回复；客户发来的文件超过 20MB 时下载不了。'
        : '和 WhatsApp 不一样的地方：客户要先在 Telegram 里给机器人发消息，机器人不能主动找人，不能外联群发；客户没有手机号，白名单和黑名单用不上；机器人不能把消息标成已读；发出的消息 48 小时内能撤回；客户发来的文件超过 20MB 时下载不了。'}
      服务器访问不了 Telegram 时，请在「设置 → 代理」里开启全局代理。
    </div>
  );

  // token 只有 admin 能看和改；业务员看得到状态、机器人、号主和连接，看不到绑定链接
  if (!isAdmin) {
    return (
      <SettingsSection title="连接">
        <StatusRow label="连接状态" account={account} pollFailed={pollFailed} />
        {errorBlock}
        {!tokenSet && <div className="numbers-block muted">这个号还没有填机器人 token，由管理员配置。</div>}
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
            {'墨鸽会收到这个 Telegram 号的私聊消息（「聊天自动化」里排除的聊天除外），亲友发来的也会进来；开着自动回复时，机器人以你本人的身份回复。' +
              '建议在「聊天自动化」里排除联系人、只管新聊天，或者这个号用人工回复。'}
          </Callout>
        </div>
      )}
      {!tokenSet && (
        <div className="numbers-block">
          <Callout tone="info">
            {isBiz
              ? '第 1 步：在 Telegram 里打开 @BotFather，发送 /newbot 创建一个机器人，再在 Bot Settings → Business Mode 里打开 Business Mode，把 token 填到下面。第 2 步：保存后这里出现绑定链接，用这个私人号本人的 Telegram 打开。第 3 步：在 Telegram 的「设置 → 聊天自动化」里添加这个机器人，打开回复消息的权限。'
              : '在 Telegram 里打开 @BotFather，发送 /newbot 创建一个机器人，把它给的 token 填到下面。墨鸽主动去 Telegram 取消息，不需要公网地址。'}
          </Callout>
        </div>
      )}

      <SettingsRow label="机器人 token" htmlFor={`tg-token-${account.id}`}>
        <SecretField
          id={`tg-token-${account.id}`}
          hint={
            isBiz
              ? '在 @BotFather 里选这个机器人 → API Token。换成别的机器人时，要重新绑定号主、重新在「聊天自动化」里添加。'
              : '在 @BotFather 里选这个机器人 → API Token。'
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
        <span className="text-strong ellipsis">{me?.name || '已登录的帐号'}</span>
        {me?.username && <span className="muted text-sm mono ellipsis">@{me.username}</span>}
      </div>
      {children}
    </div>
  );
}

const TGUSER_LIMITS =
  '和 WhatsApp 不一样的地方：客户没有手机号，白名单和黑名单用不上；只收私聊，群、频道、机器人发来的不收；第一次登录不导入以前的聊天，登录以后的新消息才进墨鸽；' +
  '你在手机上发的消息也会同步进墨鸽，记为手机回复；发出的消息随时可以撤回；不能外联群发；客户发来的文件超过存储上限时不下载。服务器访问不了 Telegram 时，请在「设置 → 代理」里开启全局代理。';

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
      message: `清除后「${account.name}」断开 Telegram，不再收发消息；登录态还留着，填回 api_hash 后自动连上。`,
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
      message: `退出后「${account.name}」不再收发 Telegram 消息，帐号的设备列表里也不再有墨鸽，要重新扫码才能恢复。手机上的聊天记录不受影响。`,
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
          <div className="numbers-block muted">这个号还没登录 Telegram。扫码登录由管理员操作，有问题请联系管理员。</div>
        )}
        {limits}
      </SettingsSection>
    );
  }

  let loginBlock = null;
  if (state === 'working') {
    loginBlock = (
      <SettingsRow label="登录的帐号" hint="在手机 Telegram 的「设置 → 设备」里能看到墨鸽（Inkdove），在那里结束它和在这里退出登录一样。">
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
            <h3>用手机 Telegram 扫码登录</h3>
            <ol className="numbers-qr__list">
              <li>打开手机上的 Telegram，用要接入的这个帐号</li>
              <li>
                进入 <strong>设置 → 设备</strong>
              </li>
              <li>
                点 <strong>连接桌面设备</strong>（英文界面是 Link Desktop Device），扫描二维码
              </li>
            </ol>
            <div className="field__hint">二维码约 30 秒换一次，这里会自动刷新；扫码后开了两步验证的帐号要在这里输密码。5 分钟内没有完成会自动停下。</div>
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
        hint="这个帐号开了两步验证（Telegram 的「设置 → 隐私与安全 → 两步验证」）。密码只用来这一次登录，墨鸽不保存。"
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
        hint={state === 'failed' ? '连接出了问题，墨鸽会自动重试；也可以重新扫码登录。' : '点按钮生成二维码，用手机 Telegram 扫码登录这个帐号。'}
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

      <SettingsRow label="api_id" htmlFor={`tgu-api-id-${account.id}`} hint="my.telegram.org → API development tools 里的 App api_id。">
        <input
          id={`tgu-api-id-${account.id}`}
          className="input input--mono"
          value={apiId}
          inputMode="numeric"
          placeholder="一串数字"
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
          hint="同一页的 App api_hash。"
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
          <Callout tone="warning">不认识这个号的接入方式（{String(account.channel || '空')}），请升级墨鸽后再看。</Callout>
        </div>
      </SettingsSection>
    );
  }
  if (!isAdmin) return <WahaReadOnly account={account} />;
  return <WahaPanel account={account} setAccount={setAccount} />;
}
