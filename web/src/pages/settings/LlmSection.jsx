import { useEffect, useRef, useState } from 'react';
import { PlugZap, RefreshCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Spinner, fieldProps } from '../../ui/common.jsx';
import { Select } from '../../ui/Select.jsx';
import { Combobox } from '../../ui/Combobox.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { SecretField } from '../../ui/SecretField.jsx';
import { Advanced, SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, ResetButton, TestResult, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/** 接口格式：baseUrl / 模型名只换占位提示，不自动填值（SPEC 第 4 节末尾） */
export const LLM_FORMATS = {
  openai: {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    model: '例如 gpt-4o-mini',
    hint: '按服务商文档原样填写，通常以 /v1 结尾。系统会在后面加上 /chat/completions。',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: '例如 claude-sonnet-4-5',
    hint: '填 https://api.anthropic.com 即可。系统会在后面加上 /v1/messages（地址已以 /v1 结尾时只加 /messages）。',
  },
  gemini: {
    label: 'Gemini 原生',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: '例如 gemini-2.5-flash',
    hint: '填 https://generativelanguage.googleapis.com 即可。系统会在后面加上 /v1beta/models/模型名:generateContent。',
  },
};
const fmtOf = (f) => LLM_FORMATS[f] || LLM_FORMATS.openai;
export const llmFormatLabel = (f) => fmtOf(f).label;

const FORMAT_OPTIONS = Object.entries(LLM_FORMATS).map(([value, f]) => ({ value, label: f.label }));

/** SPEC-phase2「新的全局 GET /api/settings」里的默认值；密钥不在这里 */
const DEFAULTS = { format: 'openai', baseUrl: '', model: '', distillModel: '' };

const FIELDS = {
  'llm.format': 'format',
  'llm.baseUrl': 'baseUrl',
  'llm.model': 'model',
  'llm.distillModel': 'distillModel',
  'llm.apiKey': 'apiKey',
};
const LABELS = {
  format: '接口格式',
  baseUrl: '接口地址',
  model: '回复模型',
  distillModel: '整理知识库用的模型',
  apiKey: 'API 密钥',
};

/** 服务商返回的模型 → Combobox 选项：去重、按 id 排序；label 和 id 一样时不重复显示 */
function toModelOptions(models) {
  const seen = new Set();
  return (Array.isArray(models) ? models : [])
    .filter((m) => typeof m?.id === 'string' && m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((m) => ({ value: m.id, label: m.label && m.label !== m.id ? String(m.label) : undefined }));
}

function toDraft(llm) {
  return {
    format: LLM_FORMATS[llm?.format] ? llm.format : 'openai',
    baseUrl: llm?.baseUrl || '',
    model: llm?.model || '',
    distillModel: llm?.distillModel || '',
  };
}

export default function LlmSection({ settings, onSaved, health, refreshHealth }) {
  const llm = settings.llm || {};
  const [draft, setDraft, base] = useSliceDraft(llm, toDraft);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [fieldErr, setFieldErr] = useState(null); // {field, text}
  const [formRef, reveal] = useRevealInvalid();
  // 获取到的模型列表，回复模型和整理模型共用
  const [models, setModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsResult, setModelsResult] = useState(null); // {ok, text}
  const modelsSeq = useRef(0);

  const dirty = !sameDraft(base, draft) || apiKey.trim() !== '';
  const fmt = fmtOf(draft.format);
  const errOf = (k) => (fieldErr?.field === k ? fieldErr.text : '');
  const set = (k, v) => {
    if (fieldErr?.field === k) setFieldErr(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  /** 列表可能不对了：清空列表和提示，还在路上的请求结果也不要了 */
  const resetModels = () => {
    modelsSeq.current += 1;
    setModels([]);
    setModelsResult(null);
    setFetchingModels(false);
  };
  // 接口格式、接口地址变了（包括放弃、恢复默认）就清空；密钥框在它的 onChange 里清
  useEffect(resetModels, [draft.format, draft.baseUrl]);

  const save = async () => {
    const patch = {
      format: draft.format,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      distillModel: draft.distillModel.trim(),
    };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    setSaving(true);
    setFieldErr(null);
    const r = await putSlice({ llm: patch }, { fields: FIELDS, labels: LABELS });
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
    refreshHealth();
    return true;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (await save()) toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    if (apiKey) resetModels();
    setApiKey('');
    setFieldErr(null);
  };

  const restoreDefaults = () => {
    setFieldErr(null);
    setDraft({ ...DEFAULTS });
  };

  const clearKey = async () => {
    setClearing(true);
    try {
      onSaved(await api.putSettings({ llm: { apiKey: '' } }));
      setApiKey('');
      resetModels();
      refreshHealth();
      toast.success('密钥已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(false);
    }
  };

  const test = async () => {
    setTestResult(null);
    // 测试的是已保存的设置：有未保存的修改时先保存
    if (dirty && !(await save())) return;
    setTesting(true);
    try {
      const r = await api.testLlm();
      setTestResult(
        r?.ok
          ? {
              ok: true,
              text: `连接成功：模型 ${r.model || draft.model} 响应正常，用时 ${((r.latencyMs || 0) / 1000).toFixed(1)} 秒`,
            }
          : { ok: false, text: `连接失败：${r?.error || '原因未知'}` },
      );
    } catch {
      // 已提示
    } finally {
      setTesting(false);
    }
  };

  // 用表单里当前的值（可能还没保存）去拉；密钥框空着时不传，服务端用已保存的密钥
  const canFetchModels = !!draft.baseUrl.trim() || !!health?.mock;
  const fetchModels = async () => {
    const seq = ++modelsSeq.current;
    setModelsResult(null);
    setFetchingModels(true);
    try {
      const body = { format: draft.format, baseUrl: draft.baseUrl.trim() };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const r = await api.listLlmModels(body);
      if (seq !== modelsSeq.current) return;
      if (r?.ok) {
        const list = toModelOptions(r.models);
        setModels(list);
        setModelsResult({
          ok: true,
          text: list.length ? `已获取 ${list.length} 个模型，点输入框选择` : '服务商没有返回模型，请手动填写',
        });
      } else {
        setModels([]);
        setModelsResult({ ok: false, text: `获取失败：${r?.error || '原因未知'}` });
      }
    } catch {
      // 已提示
    } finally {
      if (seq === modelsSeq.current) setFetchingModels(false);
    }
  };

  const modelDescribedBy = [errOf('model') && 'llm-model-err', modelsResult && 'llm-models-result'].filter(Boolean).join(' ');

  return (
    <div ref={formRef}>
      <SettingsSection as="form" title="AI 模型" onSubmit={onSubmit} actions={<ResetButton onClick={restoreDefaults} />}>
        <SettingsRow label="连接状态">
          <div className="settings-page__test">
            {health ? (
              <StatusDot tone={health.llmConfigured ? 'success' : 'neutral'}>
                {health.llmConfigured ? '已配置' : '尚未配置'}
                {health.mock ? ' · 演示模式' : ''}
              </StatusDot>
            ) : (
              <span className="muted">—</span>
            )}
            <button type="button" className="btn btn--sm" onClick={test} disabled={testing || saving}>
              {testing ? <Spinner /> : <PlugZap />}
              {testing ? '正在测试…' : '测试连接'}
            </button>
          </div>
          <TestResult result={testResult} />
        </SettingsRow>

        <SettingsRow label="接口格式" htmlFor="llm-format" hint="按模型服务商支持的接口选择；不确定时选 OpenAI 兼容。">
          <Select
            id="llm-format"
            value={draft.format}
            onChange={(v) => set('format', v)}
            options={FORMAT_OPTIONS}
            invalid={!!errOf('format')}
            aria-describedby={errOf('format') ? 'llm-format-err' : undefined}
          />
          <FieldError id="llm-format">{errOf('format')}</FieldError>
        </SettingsRow>

        <SettingsRow label="接口地址（Base URL）" htmlFor="llm-base" hint={fmt.hint}>
          <input
            {...fieldProps('llm-base', errOf('baseUrl'))}
            className="input input--mono"
            placeholder={fmt.baseUrl}
            value={draft.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            spellCheck={false}
            inputMode="url"
          />
          <FieldError id="llm-base">{errOf('baseUrl')}</FieldError>
        </SettingsRow>

        <SettingsRow label="API 密钥" htmlFor="llm-key">
          <div className="settings-page__secret">
            <SecretField
              id="llm-key"
              isSet={!!llm.apiKeySet}
              last4={llm.apiKeyLast4}
              value={apiKey}
              onChange={(v) => {
                if (fieldErr?.field === 'apiKey') setFieldErr(null);
                setApiKey(v);
                resetModels();
              }}
              onClear={clearKey}
              clearing={clearing}
              error={errOf('apiKey')}
            />
          </div>
        </SettingsRow>

        <SettingsRow label="回复模型" htmlFor="llm-model" hint="回复客户时使用，建议选速度快的模型。">
          <div className="settings-page__inline">
            <Combobox
              id="llm-model"
              mono
              value={draft.model}
              onChange={(v) => set('model', v)}
              options={models}
              placeholder={fmt.model}
              invalid={!!errOf('model')}
              aria-describedby={modelDescribedBy || undefined}
            />
            <button
              type="button"
              className="btn"
              onClick={fetchModels}
              disabled={!canFetchModels || fetchingModels}
            >
              {fetchingModels ? <Spinner /> : <RefreshCw />}
              {fetchingModels ? '获取中…' : '获取模型'}
            </button>
          </div>
          <FieldError id="llm-model">{errOf('model')}</FieldError>
          {modelsResult && (
            <div id="llm-models-result" className={modelsResult.ok ? 'field__hint' : 'field__error'} role="status">
              {modelsResult.text}
            </div>
          )}
        </SettingsRow>

        <Advanced>
          <SettingsRow
            label="整理知识库用的模型"
            htmlFor="llm-distill"
            hint="留空则和回复模型相同。可选更强的模型，整理质量更好。"
          >
            <Combobox
              id="llm-distill"
              mono
              value={draft.distillModel}
              onChange={(v) => set('distillModel', v)}
              options={models}
              placeholder="留空则使用回复模型"
              invalid={!!errOf('distillModel')}
              aria-describedby={errOf('distillModel') ? 'llm-distill-err' : undefined}
            />
            <FieldError id="llm-distill">{errOf('distillModel')}</FieldError>
          </SettingsRow>
        </Advanced>

        <SaveBar
          dirty={dirty}
          saving={saving}
          onDiscard={discard}
          text={'有未保存的更改，点"测试连接"会先保存'}
        />
      </SettingsSection>
    </div>
  );
}
