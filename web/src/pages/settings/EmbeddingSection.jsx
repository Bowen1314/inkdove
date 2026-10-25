import { useCallback, useEffect, useState } from 'react';
import { PlugZap, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { Callout, Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { Select } from '../../ui/Select.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { SecretField } from '../../ui/SecretField.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { fmtFull, fmtHm, fmtNum } from '../../lib/format.js';
import { llmFormatLabel } from './LlmSection.jsx';
import { FieldError, ResetButton, TestResult, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/** 单独配置时的接口格式：地址、模型名只换占位提示，不自动填值 */
const FORMATS = {
  openai: {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    hint: '按服务商文档填写，通常以 /v1 结尾，系统自动追加 /embeddings。适用于 OpenAI、Voyage、Jina、硅基流动；本机 Ollama 填写 http://127.0.0.1:11434/v1（Docker 中改为 Ollama 所在主机地址），无需密钥。',
  },
  gemini: {
    label: 'Gemini 原生',
    baseUrl: 'https://generativelanguage.googleapis.com',
    hint: '填写 https://generativelanguage.googleapis.com，系统自动追加 /v1beta/models/模型名:batchEmbedContents。',
  },
};
const FORMAT_OPTIONS = Object.entries(FORMATS).map(([value, f]) => ({ value, label: f.label }));

/** SPEC：embedding 的默认值；密钥不在这里 */
const DEFAULTS = { enabled: false, source: 'llm', format: 'openai', baseUrl: '', model: '' };

const FIELDS = {
  'embedding.enabled': 'enabled',
  'embedding.source': 'source',
  'embedding.format': 'format',
  'embedding.baseUrl': 'baseUrl',
  'embedding.model': 'model',
  'embedding.apiKey': 'apiKey',
};
const LABELS = {
  enabled: '语义检索',
  source: '向量服务',
  format: '接口格式',
  baseUrl: '接口地址',
  model: '向量模型',
  apiKey: 'API 密钥',
};
const CODES = {
  embedding_unsupported_for_format: { field: 'source', text: 'Anthropic 不提供向量接口，请选择「单独配置」' },
  embedding_base_url_required: { field: 'baseUrl', text: '开启时需填写接口地址' },
  embedding_model_required: { field: 'model', text: '开启时需填写向量模型' },
};

/** 回复模型是 Anthropic 时不能用「和回复模型同一个」，草稿直接放在「单独配置」 */
function toDraft(e) {
  const anthropic = e?.llmFormat === 'anthropic';
  return {
    enabled: !!e?.enabled,
    source: e?.source === 'custom' || anthropic ? 'custom' : 'llm',
    format: FORMATS[e?.format] ? e.format : 'openai',
    baseUrl: e?.baseUrl || '',
    model: e?.model || '',
  };
}

/**
 * 测试和保存时真正用到的连接设置（比较用的签名）：单独配置时是格式、地址、模型和新填的密钥（空着用已保存的），
 * 用回复模型的服务时只有模型
 */
const connOf = (d, key = '') =>
  JSON.stringify(
    d.source === 'custom' ? [d.source, d.format, d.baseUrl.trim(), d.model.trim(), key.trim()] : [d.source, d.model.trim()],
  );

/** 后台计算的状态 → 圆点和文字 */
function stateOf(s) {
  if (!s) return null;
  const done = s.activeEntries > 0 && s.embeddedEntries + (s.skippedEntries || 0) >= s.activeEntries;
  switch (s.state) {
    case 'misconfigured':
      return { tone: 'danger', text: `配置有误：${s.configError || '请检查下方设置'}` };
    case 'loading':
      return { tone: 'info', pulse: true, text: '正在加载已有向量' };
    case 'running':
      return { tone: 'info', pulse: true, text: '计算中' };
    case 'waiting':
      return { tone: 'warning', text: `向量接口暂时不可用，${s.retryAt ? `${fmtHm(s.retryAt)} ` : ''}自动重试` };
    case 'stopped':
      return { tone: 'danger', text: '已停止：修正设置后点击「重试」' };
    default:
      if (!s.activeEntries) return { tone: 'neutral', text: '知识库暂无条目' };
      return done ? { tone: 'success', text: '已完成' } : { tone: 'neutral', text: '等待计算' };
  }
}

/** 还要不要接着轮询：开着、没停下，还在算、在等重试或者还有没算的 */
const shouldPoll = (s) =>
  !!s?.enabled &&
  s.state !== 'stopped' &&
  s.state !== 'misconfigured' &&
  (s.running || s.state === 'waiting' || s.embeddedEntries + (s.skippedEntries || 0) < s.activeEntries);

/**
 * 向量检索（可选）：开关、用哪个服务（和回复模型同一个 / 单独配置）、向量模型、测试、计算进度和重新计算。
 * 测试用表单里当前的值（不用先保存）；进度在开着、还在算的时候每 3 秒刷新一次。
 * 打开向量检索，或者开着时改了服务、格式、地址、密钥、模型，要先用表单里当前的值测试成功才能保存；
 * 测试结果记着测的是哪组值，改了任何一项就作废。关掉不用测试。
 */
export default function EmbeddingSection({ settings, onSaved }) {
  const em = settings.embedding || {};
  const llmFormat = settings.llm?.format || 'openai';
  const anthropic = llmFormat === 'anthropic';
  const [draft, setDraft, base] = useSliceDraft({ ...em, llmFormat }, toDraft);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // {ok, text, conn}：conn 是测试时的连接设置
  const [fieldErr, setFieldErr] = useState(null); // {field, text}
  const [formRef, reveal] = useRevealInvalid();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null); // 'rebuild' | 'retry'
  const confirm = useConfirm();

  const dirty = !sameDraft(base, draft) || apiKey.trim() !== '';
  const custom = draft.source === 'custom';
  // 测试结果只对测试时的那组值有效，改了任何一项就不显示、不算数
  const conn = connOf(draft, apiKey);
  const shownResult = testResult?.conn === conn ? testResult : null;
  const needsTest = draft.enabled && (!base.enabled || conn !== connOf(base));
  // 不能保存的原因（一句话，显示在保存栏里）；空串表示可以保存
  const saveBlock =
    !needsTest || shownResult?.ok
      ? ''
      : shownResult
        ? '测试未通过，请修正后重新测试，测试成功后可保存'
        : `${base.enabled ? '向量服务已变更' : '开启前'}需点击「测试」，测试成功后可保存`;
  const fmt = FORMATS[draft.format] || FORMATS.openai;
  const errOf = (k) => (fieldErr?.field === k ? fieldErr.text : '');
  const set = (k, v) => {
    if (fieldErr?.field === k) setFieldErr(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getVectorStatus({ silent: true }));
    } catch {
      // 状态拿不到就不显示，不打扰
    }
  }, []);
  useEffect(() => {
    loadStatus();
  }, [loadStatus, em.enabled, em.model, em.source, em.format, em.baseUrl]);
  usePolling(loadStatus, 3000, !!em.enabled && shouldPoll(status));

  const save = async () => {
    const patch = {
      enabled: draft.enabled,
      source: draft.source,
      format: draft.format,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
    };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    setSaving(true);
    setFieldErr(null);
    const r = await putSlice({ embedding: patch }, { fields: FIELDS, labels: LABELS, codes: CODES });
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        setFieldErr(r.fieldError);
        reveal();
      }
      return false;
    }
    onSaved(r.res);
    setApiKey('');
    loadStatus();
    return true;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (saveBlock) {
      toast.error(saveBlock);
      return;
    }
    if (await save()) toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    setApiKey('');
    setFieldErr(null);
  };

  const restoreDefaults = () => {
    setFieldErr(null);
    setDraft({ ...DEFAULTS, source: anthropic ? 'custom' : 'llm' });
  };

  const clearKey = async () => {
    setClearing(true);
    try {
      onSaved(await api.putSettings({ embedding: { apiKey: '' } }));
      setApiKey('');
      setTestResult(null); // 测试时用的可能是清掉的那个密钥
      toast.success('密钥已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(false);
    }
  };

  // 用表单里当前的值试算一个向量；密钥框空着时不传，服务端用已保存的密钥
  const test = async () => {
    setTestResult(null);
    setTesting(true);
    const testedConn = conn;
    try {
      const body = { source: draft.source, model: draft.model.trim() };
      if (custom) {
        body.format = draft.format;
        body.baseUrl = draft.baseUrl.trim();
        if (apiKey.trim()) body.apiKey = apiKey.trim();
      }
      const r = await api.testEmbedding(body);
      setTestResult(
        r?.ok
          ? {
              ok: true,
              text: `测试成功：模型 ${r.model || draft.model} 返回 ${fmtNum(r.dims)} 维向量，耗时 ${((r.latencyMs || 0) / 1000).toFixed(1)} 秒`,
              conn: testedConn,
            }
          : { ok: false, text: `测试失败：${r?.error || '原因未知'}`, conn: testedConn },
      );
    } catch {
      // 已提示（字段不合法的 400 也在这里）
    } finally {
      setTesting(false);
    }
  };

  const rebuild = async () => {
    const ok = await confirm({
      title: '重新计算全部向量？',
      message:
        '将清除现有向量并用当前模型重新计算全部条目，按服务商价格计费。完成前语义检索不可用，回复仍使用关键词检索。',
      confirmText: '重新计算',
      danger: true,
    });
    if (!ok) return;
    setBusy('rebuild');
    try {
      setStatus(await api.rebuildVectors());
      toast.success('已开始重新计算');
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy('retry');
    try {
      setStatus(await api.retryVectors());
    } catch {
      // 已提示
    } finally {
      setBusy(null);
    }
  };

  const st = em.enabled ? stateOf(status) : null;
  const total = status?.activeEntries || 0;
  const embedded = Math.min(status?.embeddedEntries || 0, total);
  const pct = total ? Math.round((embedded / total) * 100) : 0;

  return (
    <div ref={formRef} className="settings-group">
      <SettingsSection
        as="form"
        title="向量检索（可选）"
        desc="按语义检索知识库条目，支持跨语言和不同表述。知识库少于约 4 万字时全部内容随回复提交，无需开启。"
        onSubmit={onSubmit}
        actions={<ResetButton onClick={restoreDefaults} />}
      >
        <SettingsRow
          inline
          label="语义检索"
          htmlFor="em-enabled"
          hint="开启后为每个条目计算向量，回复时与关键词检索结合使用；向量覆盖九成以上条目后，不再调用回复模型改写检索词。"
        >
          <Switch id="em-enabled" checked={draft.enabled} onChange={(v) => set('enabled', v)} label="语义检索" />
        </SettingsRow>

        <SettingsRow
          label="向量服务"
          hint="知识库条目和客户消息将发送至该服务计算向量；使用本机 Ollama 时数据不离开本机。"
        >
          <div className="choice-list" role="radiogroup" aria-label="向量服务">
            <label className="choice">
              <input
                type="radio"
                className="radio"
                name="em-source"
                value="llm"
                checked={draft.source === 'llm'}
                disabled={anthropic}
                onChange={() => set('source', 'llm')}
              />
              <span className="choice__text">
                <span>与回复模型相同</span>
                <span className="choice__desc">
                  {anthropic
                    ? '回复模型为 Anthropic，不提供向量接口，请选择「单独配置」。'
                    : `使用「AI 模型」中的接口地址和 API 密钥（${llmFormatLabel(llmFormat)}），仅需填写向量模型。`}
                </span>
              </span>
            </label>
            <label className="choice">
              <input
                type="radio"
                className="radio"
                name="em-source"
                value="custom"
                checked={draft.source === 'custom'}
                onChange={() => set('source', 'custom')}
              />
              <span className="choice__text">
                <span>单独配置</span>
                <span className="choice__desc">支持 OpenAI、本机 Ollama、Voyage、Jina、硅基流动（OpenAI 兼容）或 Gemini。</span>
              </span>
            </label>
          </div>
          <FieldError id="em-source">{errOf('source')}</FieldError>
        </SettingsRow>

        {custom && (
          <>
            <SettingsRow label="接口格式" htmlFor="em-format">
              <Select
                id="em-format"
                value={draft.format}
                onChange={(v) => set('format', v)}
                options={FORMAT_OPTIONS}
                invalid={!!errOf('format')}
                aria-describedby={errOf('format') ? 'em-format-err' : undefined}
              />
              <FieldError id="em-format">{errOf('format')}</FieldError>
            </SettingsRow>

            <SettingsRow label="接口地址（Base URL）" htmlFor="em-base" hint={fmt.hint}>
              <input
                {...fieldProps('em-base', errOf('baseUrl'))}
                className="input input--mono"
                placeholder={fmt.baseUrl}
                value={draft.baseUrl}
                onChange={(e) => set('baseUrl', e.target.value)}
                spellCheck={false}
                inputMode="url"
              />
              <FieldError id="em-base">{errOf('baseUrl')}</FieldError>
            </SettingsRow>

            <SettingsRow label="API 密钥" htmlFor="em-key" hint="本机 Ollama 无需填写。">
              <div className="settings-page__secret">
                <SecretField
                  id="em-key"
                  isSet={!!em.apiKeySet}
                  last4={em.apiKeyLast4}
                  value={apiKey}
                  onChange={(v) => {
                    if (fieldErr?.field === 'apiKey') setFieldErr(null);
                    setApiKey(v);
                  }}
                  onClear={clearKey}
                  clearing={clearing}
                  error={errOf('apiKey')}
                />
              </div>
            </SettingsRow>
          </>
        )}

        <SettingsRow
          label="向量模型"
          htmlFor="em-model"
          hint="示例：text-embedding-3-small。更换模型或服务后将全部重新计算。"
        >
          <div className="settings-page__inline">
            <input
              {...fieldProps('em-model', errOf('model'))}
              className="input input--mono"
              placeholder="模型名称"
              value={draft.model}
              onChange={(e) => set('model', e.target.value)}
              spellCheck={false}
            />
            <button type="button" className="btn" onClick={test} disabled={testing || !draft.model.trim()}>
              {testing ? <Spinner /> : <PlugZap />}
              {testing ? '测试中…' : '测试'}
            </button>
          </div>
          <FieldError id="em-model">{errOf('model')}</FieldError>
          <TestResult result={shownResult} />
        </SettingsRow>

        {em.enabled && (
          <SettingsRow label="计算进度" hint="条目变更后数秒内自动更新向量；未完成计算的条目仍使用关键词检索。">
            <div className="vstack embedding-status">
              <div className="settings-page__test">
                {st ? (
                  <StatusDot tone={st.tone} pulse={st.pulse} wrap>
                    {st.text}
                  </StatusDot>
                ) : (
                  <span className="muted">—</span>
                )}
                <div className="hstack">
                  {(status?.state === 'stopped' || status?.state === 'waiting') && (
                    <button type="button" className="btn btn--sm" onClick={retry} disabled={!!busy}>
                      {busy === 'retry' ? <Spinner /> : <RotateCcw />}
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={rebuild}
                    disabled={!!busy || status?.state === 'misconfigured'}
                  >
                    {busy === 'rebuild' ? <Spinner /> : <RefreshCw />}
                    重新计算
                  </button>
                </div>
              </div>
              {status && status.state !== 'misconfigured' && (
                <div className="embedding-status__progress">
                  <div
                    className="progress"
                    role="progressbar"
                    aria-label="向量计算进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                  >
                    <div className={`progress__bar${status.state === 'stopped' ? ' progress__bar--danger' : ''}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="muted text-sm num">
                    已计算 {fmtNum(embedded)} / {fmtNum(total)} 条
                    {status.skippedEntries ? `，${fmtNum(status.skippedEntries)} 条无法计算已跳过` : ''}
                  </span>
                </div>
              )}
              {status?.lastError && (
                <div className="field__error" role="status">
                  {fmtFull(status.lastError.at)}：{status.lastError.message}
                </div>
              )}
              {status?.hint && <Callout tone="warning">{status.hint}</Callout>}
            </div>
          </SettingsRow>
        )}

        <SaveBar
          dirty={dirty}
          saving={saving}
          disabled={!!saveBlock}
          onDiscard={discard}
          text={saveBlock ? `有未保存的更改，${saveBlock}` : undefined}
        />
      </SettingsSection>
    </div>
  );
}
