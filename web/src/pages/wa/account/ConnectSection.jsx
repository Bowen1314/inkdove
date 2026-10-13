import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogOut, PlayCircle, PlugZap, RefreshCw, Shuffle } from 'lucide-react';
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
import { waState } from '../../../lib/labels.js';
import { fmtTime } from '../../../lib/format.js';
import { mapServerError } from '../../settings/shared.jsx';

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
  else if (d.enabled && !host) errors.host = '开启代理时必须填写地址';
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = '端口是 1–65535 之间的整数';
  } else if (d.enabled) {
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

  const summary = proxy.enabled
    ? `${protoLabel(proxy.protocol)} · ${proxy.host || '未填地址'}${proxy.port ? `:${proxy.port}` : ''}`
    : '未开启';

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

/** 号详情的「连接」分组：扫码号显示扫码流程和 IP 代理，Meta 号显示凭证；业务员只看状态 */
export default function ConnectSection({ account, setAccount, isAdmin }) {
  if (account.channel === 'meta') return <MetaPanel account={account} setAccount={setAccount} isAdmin={isAdmin} />;
  if (!isAdmin) return <WahaReadOnly account={account} />;
  return <WahaPanel account={account} setAccount={setAccount} />;
}
