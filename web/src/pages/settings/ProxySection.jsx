import { useCallback, useEffect, useState } from 'react';
import { Gauge, PlugZap, RefreshCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Callout, Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { Select } from '../../ui/Select.jsx';
import { SecretField } from '../../ui/SecretField.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { fmtClock, fmtFull } from '../../lib/format.js';
import { FieldError, TestResult, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/** 和服务端 server/src/proxy/index.js 的 MIHOMO_MISSING 一致 */
const MIHOMO_MISSING = '本机未安装 mihomo（Docker 镜像已内置）；本地开发可通过 INKDOVE_MIHOMO_PATH 指定';

const SOURCES = [
  {
    value: 'subscription',
    label: '订阅地址',
    desc: 'Clash 订阅链接，每日自动更新，也可点击「更新订阅」手动更新。',
  },
  {
    value: 'config',
    label: '粘贴 Clash 配置',
    desc: '粘贴 Clash 配置文件（YAML），仅使用其中的节点（proxies）。节点变更后需重新粘贴。',
  },
];

/** 服务端错误前缀 → 字段 */
const FIELDS = {
  'proxy.enabled': 'enabled',
  'proxy.source': 'source',
  'proxy.subscriptionUrl': 'subscriptionUrl',
  'proxy.config': 'config',
  'proxy.node': 'node',
  'proxy.bypass': 'bypass',
};
const LABELS = {
  enabled: '全局代理',
  source: '节点来源',
  subscriptionUrl: '订阅地址',
  config: 'Clash 配置',
  node: '节点',
  bypass: '直连地址',
};

const CONFIG_PLACEHOLDER = `proxies:
  - name: 香港 01
    type: ss
    server: hk.example.com
    port: 8388
    cipher: aes-128-gcm
    password: …`;

/** 草稿只看开关、来源、节点和直连名单：订阅地址、粘贴的配置是密钥，另外记新填的值 */
const toDraft = (p) => ({
  enabled: !!p?.enabled,
  source: p?.source === 'config' ? 'config' : 'subscription',
  node: p?.node || '',
  bypass: (p?.bypass || []).join('\n'),
});
const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const ms = (n) => `${Math.round(n)} 毫秒`;

/** 运行状态那一行 */
function stateOf(st) {
  if (!st) return null;
  if (st.state === 'running') {
    return {
      tone: 'success',
      text: `运行中 · ${st.nodeCount} 个节点${st.current ? ` · 当前「${st.current}」` : ''}`,
    };
  }
  if (st.state === 'starting') return { tone: 'info', pulse: true, text: '启动中…' };
  if (st.state === 'error') {
    const retry = st.restartAt ? `，${fmtClock(st.restartAt)} 自动重试` : '';
    return { tone: 'danger', text: `未运行：${st.error || '原因未知'}${retry}。期间经代理的请求将失败` };
  }
  return { tone: 'neutral', text: '未开启' };
}

/**
 * 设置 → 代理：全局代理。墨鸽自己连外网的请求（AI 模型、向量、翻译、发信、抓网页、检查更新、Meta 接口）都经机场节点出去；
 * 扫码号在号的设置里可以选「用全局代理」。节点来自 Clash 订阅或粘贴的 Clash 配置，由 mihomo 连。
 * 订阅地址和粘贴的配置是密钥：从不回显，订阅地址留空不改，「清除」立即保存；粘贴的配置只存解析出的节点。
 * 测试、测速、更新订阅都用已保存的设置。
 */
export default function ProxySection({ settings, onSaved }) {
  const px = settings.proxy || {};
  const slice = { enabled: px.enabled, source: px.source, node: px.node, bypass: px.bypass };
  const [draft, setDraft, base] = useSliceDraft(slice, toDraft);
  const [subUrl, setSubUrl] = useState('');
  const [configText, setConfigText] = useState('');
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(null); // 'subscriptionUrl' | 'config'
  const [busy, setBusy] = useState(null); // 'test' | 'refresh' | 'delay'
  const [testResult, setTestResult] = useState(null);
  const [refreshResult, setRefreshResult] = useState(null);
  const [delays, setDelays] = useState(null); // {map} | {error}
  const [fieldErr, setFieldErr] = useState(null);
  const [formRef, reveal] = useRevealInvalid();

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getProxyStatus({ silent: true }));
    } catch {
      // 状态拿不到就不显示，不打扰
    }
  }, []);
  useEffect(() => {
    loadStatus();
  }, [loadStatus, px.enabled, px.source, px.node, px.subscriptionUrlSet]);
  // 启动中、等着重启时勤一点，开着时隔一会儿看一次（mihomo 可能中途退出）
  const transient = status?.state === 'starting' || (status?.state === 'error' && !!status?.restartAt);
  usePolling(loadStatus, transient ? 3000 : 30000, !!status?.enabled);

  const unavailable = status?.available === false;
  const dirty = !sameDraft(base, draft) || !!subUrl.trim() || !!configText.trim();
  const errOf = (k) => (fieldErr?.field === k ? fieldErr.text : '');
  const clearErr = (k) => {
    if (fieldErr?.field === k) setFieldErr(null);
  };
  const set = (k, v) => {
    clearErr(k);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const save = async () => {
    const patch = {};
    for (const k of ['enabled', 'source', 'node']) if (draft[k] !== base[k]) patch[k] = draft[k];
    if (draft.bypass !== base.bypass) patch.bypass = lines(draft.bypass);
    if (subUrl.trim()) patch.subscriptionUrl = subUrl.trim();
    if (configText.trim()) patch.config = configText;
    setSaving(true);
    setFieldErr(null);
    const r = await putSlice({ proxy: patch }, { fields: FIELDS, labels: LABELS });
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        setFieldErr(r.fieldError);
        reveal();
      }
      return false;
    }
    onSaved(r.res);
    setSubUrl('');
    setConfigText('');
    setTestResult(null);
    setRefreshResult(null);
    setDelays(null);
    loadStatus();
    return true;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const turningOn = draft.enabled && !base.enabled;
    if (await save()) toast.success(turningOn ? '已保存，全局代理启动中' : '已保存');
  };

  const discard = () => {
    setDraft(base);
    setSubUrl('');
    setConfigText('');
    setFieldErr(null);
  };

  /** 清除订阅地址或粘贴的配置（立即保存） */
  const clearSecret = async (key) => {
    const using = base.enabled && base.source === (key === 'subscriptionUrl' ? 'subscription' : 'config');
    if (using) {
      toast.error(`${LABELS[key]}中的节点正在使用，无法清除。请先关闭全局代理或更换节点来源并保存`);
      return;
    }
    setClearing(key);
    try {
      onSaved(await api.putSettings({ proxy: { [key]: null } }));
      if (key === 'subscriptionUrl') setSubUrl('');
      else setConfigText('');
      clearErr(key);
      setRefreshResult(null);
      loadStatus();
      toast.success(`${LABELS[key]}已清除`);
    } catch {
      // 已提示
    } finally {
      setClearing(null);
    }
  };

  const test = async () => {
    setTestResult(null);
    setBusy('test');
    try {
      const r = await api.testGlobalProxy({ silent: true });
      setTestResult(
        r?.ok
          ? { ok: true, text: `访问成功：出口 IP ${r.ip}，耗时 ${ms(r.latencyMs || 0)}` }
          : { ok: false, text: r?.error || '测试失败：原因未知' },
      );
    } catch (e) {
      setTestResult({ ok: false, text: `测试失败：${e?.message || '原因未知'}` });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setRefreshResult(null);
    setBusy('refresh');
    try {
      const r = await api.refreshProxySubscription({ silent: true });
      if (r?.status) setStatus(r.status);
      if (r?.ok) {
        setRefreshResult({ ok: true, text: `订阅已更新：${r.nodeCount} 个节点` });
        setDelays(null);
        // 选的节点没了时服务端会改回自动：拿一次最新设置
        onSaved(await api.getSettings({ silent: true }));
      } else {
        setRefreshResult({ ok: false, text: r?.error || '更新失败：原因未知' });
      }
    } catch (e) {
      setRefreshResult({ ok: false, text: `更新失败：${e?.message || '原因未知'}` });
    } finally {
      setBusy(null);
    }
  };

  const measure = async () => {
    setDelays(null);
    setBusy('delay');
    try {
      const r = await api.proxyDelays({ silent: true });
      setDelays(r?.ok ? { map: r.delays || {} } : { error: r?.error || '测速失败：原因未知' });
    } catch (e) {
      setDelays({ error: `测速失败：${e?.message || '原因未知'}` });
    } finally {
      setBusy(null);
    }
  };

  // 节点下拉：列的是已保存的来源里的节点；草稿换了来源时要先保存
  const sourceChanged = draft.source !== base.source;
  const nodes = status?.nodes || [];
  const delayOf = (name) => delays?.map?.[name];
  const nodeDesc = (n) => {
    const d = delayOf(n.name);
    if (d === undefined) return n.type;
    return `${n.type} · ${d === null ? '超时' : ms(d)}`;
  };
  const nodeOptions = [
    {
      value: '',
      label: '自动（最低延迟）',
      desc: !px.node && status?.current ? `当前「${status.current}」` : '每 5 分钟测速，使用延迟最低的节点',
    },
    ...nodes.map((n) => ({ value: n.name, label: n.name, desc: nodeDesc(n) })),
  ];
  if (draft.node && !nodes.some((n) => n.name === draft.node)) nodeOptions.push({ value: draft.node, label: draft.node });

  let delayResult = null;
  if (delays?.error) delayResult = { ok: false, text: delays.error };
  else if (delays?.map) {
    const got = Object.entries(delays.map).filter(([, v]) => v !== null);
    const total = Object.keys(delays.map).length;
    if (!got.length) delayResult = { ok: false, text: `${total} 个节点均无法连接或超时` };
    else {
      const [best, bestMs] = got.reduce((a, b) => (b[1] < a[1] ? b : a));
      delayResult = { ok: true, text: `${got.length} / ${total} 个节点可连接，最快为「${best}」（${ms(bestMs)}）。各节点延迟见下拉列表` };
    }
  }

  const st = stateOf(status);
  const store = draft.source === 'config' ? status?.config : status?.subscription;
  const nodeNotes = [];
  if (store?.skipped) nodeNotes.push(`${store.skipped} 个节点类型不支持，已忽略`);
  if (store?.invalid?.length) nodeNotes.push(`mihomo 无法识别，已移除：${store.invalid.join('、')}`);

  return (
    <div ref={formRef}>
      <SettingsSection
        as="form"
        title="代理"
        desc="全局代理：墨鸽的外网请求（AI 模型、向量检索、重排、翻译接口、发信、网页抓取、检查更新、Meta 接口）经代理节点发出。WhatsApp 扫码登录的号码默认不使用，可在号码的「IP 代理」中选择「用全局代理」。"
        onSubmit={onSubmit}
      >
        {unavailable && <Callout tone="warning">{MIHOMO_MISSING}</Callout>}

        <SettingsRow
          inline
          label="使用全局代理"
          htmlFor="px-enabled"
          hint="开启后代理不可用时请求直接失败，不回退直连。本机、内网地址、不含点的主机名和 WAHA 始终直连。"
        >
          <Switch
            id="px-enabled"
            checked={draft.enabled}
            onChange={(v) => set('enabled', v)}
            disabled={unavailable && !draft.enabled}
            label="使用全局代理"
          />
        </SettingsRow>
        {errOf('enabled') && <Callout tone="danger">{errOf('enabled')}</Callout>}

        {(status?.enabled || px.enabled) && st && (
          <SettingsRow label="运行状态">
            <div className="vstack embedding-status">
              <StatusDot tone={st.tone} pulse={st.pulse} wrap>
                {st.text}
              </StatusDot>
              {status?.notice && <Callout tone="info">{status.notice}</Callout>}
              {!!status?.usedBy?.length && (
                <div className="field__hint">使用全局代理的号码：{status.usedBy.map((a) => a.name).join('、')}</div>
              )}
            </div>
          </SettingsRow>
        )}

        <SettingsRow label="节点来源">
          <div className="choice-list" role="radiogroup" aria-label="节点来源">
            {SOURCES.map((s) => (
              <label key={s.value} className="choice">
                <input
                  type="radio"
                  className="radio"
                  name="px-source"
                  value={s.value}
                  checked={draft.source === s.value}
                  onChange={() => set('source', s.value)}
                />
                <span className="choice__text">
                  <span>{s.label}</span>
                  <span className="choice__desc">{s.desc}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id="px-source">{errOf('source')}</FieldError>
        </SettingsRow>

        {draft.source === 'subscription' ? (
          <SettingsRow
            label="订阅地址"
            htmlFor="px-sub"
            hint="订阅地址含帐号凭证，按密钥保存，保存后不再显示。订阅始终直连下载。仅支持 Clash 格式。"
          >
            <div className="vstack" style={{ gap: 'var(--sp-2)', alignItems: 'stretch' }}>
              <div className="settings-page__secret">
                <SecretField
                  id="px-sub"
                  isSet={!!px.subscriptionUrlSet}
                  value={subUrl}
                  onChange={(v) => {
                    clearErr('subscriptionUrl');
                    setSubUrl(v);
                  }}
                  onClear={() => clearSecret('subscriptionUrl')}
                  clearing={clearing === 'subscriptionUrl'}
                  error={errOf('subscriptionUrl')}
                />
              </div>
              {status?.subscription?.set && (
                <div className="settings-page__test">
                  <span className="muted text-sm">
                    {status.subscription.updatedAt
                      ? `${status.subscription.nodeCount} 个节点，${fmtFull(status.subscription.updatedAt)} 更新`
                      : '尚未下载'}
                  </span>
                  <button type="button" className="btn btn--sm" onClick={refresh} disabled={!!busy || !!subUrl.trim()}>
                    {busy === 'refresh' ? <Spinner /> : <RefreshCw />}
                    {busy === 'refresh' ? '更新中…' : '更新订阅'}
                  </button>
                </div>
              )}
              {status?.subscription?.error && !refreshResult && (
                <div className="field__error" role="status">
                  {status.subscription.lastAttemptAt ? `${fmtFull(status.subscription.lastAttemptAt)} ` : ''}更新失败（沿用原节点）：
                  {status.subscription.error}
                </div>
              )}
              <TestResult result={refreshResult} />
              {nodeNotes.map((t) => (
                <div key={t} className="field__hint">
                  {t}
                </div>
              ))}
            </div>
          </SettingsRow>
        ) : (
          <SettingsRow
            label="Clash 配置"
            htmlFor="px-config"
            hint="仅使用 proxies 中的节点，忽略规则、分组和 DNS。保存时解析并仅存储节点，不保存原文；含服务器和密码，保存后不再显示。"
          >
            <div className="vstack" style={{ gap: 'var(--sp-2)', alignItems: 'stretch' }}>
              <textarea
                {...fieldProps('px-config', errOf('config'))}
                className="textarea input--mono"
                rows={8}
                spellCheck={false}
                autoComplete="off"
                placeholder={status?.config?.set ? '留空则不修改；粘贴新配置将整体替换' : CONFIG_PLACEHOLDER}
                value={configText}
                onChange={(e) => {
                  clearErr('config');
                  setConfigText(e.target.value);
                }}
              />
              <FieldError id="px-config">{errOf('config')}</FieldError>
              <div className="settings-page__test">
                {status?.config?.set ? (
                  <StatusDot tone="success" size="sm">
                    已保存 · {status.config.nodeCount} 个节点{status.config.updatedAt ? ` · ${fmtFull(status.config.updatedAt)}` : ''}
                  </StatusDot>
                ) : (
                  <StatusDot tone="neutral" size="sm">
                    未配置
                  </StatusDot>
                )}
                {status?.config?.set && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--danger btn--sm"
                    onClick={() => clearSecret('config')}
                    disabled={clearing === 'config'}
                  >
                    {clearing === 'config' ? '清除中…' : '清除'}
                  </button>
                )}
              </div>
              {nodeNotes.map((t) => (
                <div key={t} className="field__hint">
                  {t}
                </div>
              ))}
            </div>
          </SettingsRow>
        )}

        <SettingsRow
          label="节点"
          htmlFor="px-node"
          hint={
            sourceChanged
              ? '节点来源已变更，保存后可选择该来源的节点。'
              : '自动：使用延迟最低的节点。指定节点后固定使用，该节点不可用时请求失败。测速使用已保存的设置，需开启全局代理。'
          }
        >
          <div className="settings-page__inline">
            <Select
              id="px-node"
              value={draft.node}
              onChange={(v) => set('node', v)}
              options={nodeOptions}
              disabled={sourceChanged}
              invalid={!!errOf('node')}
              aria-describedby={errOf('node') ? 'px-node-err' : undefined}
              style={{ flex: '1 1 220px', maxWidth: 420 }}
            />
            <button type="button" className="btn" onClick={measure} disabled={!!busy || status?.state !== 'running'}>
              {busy === 'delay' ? <Spinner /> : <Gauge />}
              {busy === 'delay' ? '测速中…' : '测速'}
            </button>
          </div>
          <FieldError id="px-node">{errOf('node')}</FieldError>
          <TestResult result={delayResult} />
        </SettingsRow>

        <SettingsRow
          label="直连地址"
          htmlFor="px-bypass"
          hint="每行一个：example.com（仅该域名）、*.example.com（含所有子域名）、IP 或网段（如 10.0.0.0/8）。按请求中的主机名匹配，不做本地解析。"
        >
          <textarea
            {...fieldProps('px-bypass', errOf('bypass'))}
            className="textarea input--mono"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            placeholder={'api.example.com\n*.example.cn\n10.0.0.0/8'}
            value={draft.bypass}
            onChange={(e) => set('bypass', e.target.value)}
          />
          <FieldError id="px-bypass">{errOf('bypass')}</FieldError>
        </SettingsRow>

        <SettingsRow
          label="测试"
          hint={
            px.enabled
              ? `经全局代理访问 IP 查询地址，显示出口 IP 和耗时。测试使用已保存的设置${dirty ? '（有未保存的修改）' : ''}。`
              : '开启全局代理并保存后可测试。'
          }
        >
          <div className="vstack" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
            <button type="button" className="btn" onClick={test} disabled={!!busy || !px.enabled}>
              {busy === 'test' ? <Spinner /> : <PlugZap />}
              {busy === 'test' ? '测试中…' : '测试'}
            </button>
            <TestResult result={testResult} />
          </div>
        </SettingsRow>

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>
    </div>
  );
}
