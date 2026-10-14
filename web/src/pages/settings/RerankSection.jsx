import { useState } from 'react';
import { PlugZap } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { SecretField } from '../../ui/SecretField.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, ResetButton, TestResult, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/** rerank 的默认值；密钥不在这里 */
const DEFAULTS = { enabled: false, baseUrl: '', model: '' };

const FIELDS = {
  'rerank.enabled': 'enabled',
  'rerank.baseUrl': 'baseUrl',
  'rerank.model': 'model',
  'rerank.apiKey': 'apiKey',
};
const LABELS = {
  enabled: '重排',
  baseUrl: '接口地址',
  model: '重排模型',
  apiKey: 'API 密钥',
};
const CODES = {
  rerank_base_url_required: { field: 'baseUrl', text: '开启时必须填写接口地址' },
  rerank_model_required: { field: 'model', text: '开启时必须填写重排模型' },
};

const toDraft = (r) => ({ enabled: !!r?.enabled, baseUrl: r?.baseUrl || '', model: r?.model || '' });

/** 测试和保存时真正用到的连接设置（比较用的签名）：地址、模型和新填的密钥（空着用已保存的） */
const connOf = (d, key = '') => JSON.stringify([d.baseUrl.trim(), d.model.trim(), key.trim()]);

/**
 * 重排（可选，和向量检索放在同一页）：开关、接口地址、API 密钥、重排模型、测试。
 * 测试用表单里当前的值（不用先保存）。打开重排，或者开着时改了地址、密钥、模型，要先用表单里当前的值测试成功才能保存；
 * 测试结果记着测的是哪组值，改了任何一项就作废。关掉不用测试。和向量检索一样，这条规矩只在设置页，服务端只查开着时有没有地址和模型。
 */
export default function RerankSection({ settings, onSaved }) {
  const rr = settings.rerank || {};
  const [draft, setDraft, base] = useSliceDraft(rr, toDraft);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // {ok, text, conn}：conn 是测试时的连接设置
  const [fieldErr, setFieldErr] = useState(null); // {field, text}
  const [formRef, reveal] = useRevealInvalid();

  const dirty = !sameDraft(base, draft) || apiKey.trim() !== '';
  const conn = connOf(draft, apiKey);
  const shownResult = testResult?.conn === conn ? testResult : null;
  const needsTest = draft.enabled && (!base.enabled || conn !== connOf(base));
  const saveBlock =
    !needsTest || shownResult?.ok
      ? ''
      : shownResult
        ? '测试没通过，改好后再测试，成功了才能保存'
        : `${base.enabled ? '改了重排服务' : '开启前'}要先点「测试」，测试成功才能保存`;
  const errOf = (k) => (fieldErr?.field === k ? fieldErr.text : '');
  const set = (k, v) => {
    if (fieldErr?.field === k) setFieldErr(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const save = async () => {
    const patch = { enabled: draft.enabled, baseUrl: draft.baseUrl.trim(), model: draft.model.trim() };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    setSaving(true);
    setFieldErr(null);
    const r = await putSlice({ rerank: patch }, { fields: FIELDS, labels: LABELS, codes: CODES });
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

  const clearKey = async () => {
    setClearing(true);
    try {
      onSaved(await api.putSettings({ rerank: { apiKey: '' } }));
      setApiKey('');
      setTestResult(null); // 测试时用的可能是清掉的那个密钥
      toast.success('密钥已清除');
    } catch {
      // 已提示
    } finally {
      setClearing(false);
    }
  };

  // 用表单里当前的值给一组固定的文字排一次；密钥框空着时不传，服务端用已保存的密钥
  const test = async () => {
    setTestResult(null);
    setTesting(true);
    const testedConn = conn;
    try {
      const body = { baseUrl: draft.baseUrl.trim(), model: draft.model.trim() };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const r = await api.testRerank(body);
      setTestResult(
        r?.ok
          ? {
              ok: true,
              text: `测试成功：模型 ${r.model || draft.model} 排好了 ${r.results} 段文字${
                r.topMatches ? '，中文的问题把英文的答案排在了第一' : ''
              }，用时 ${((r.latencyMs || 0) / 1000).toFixed(1)} 秒`,
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

  return (
    <div ref={formRef} className="settings-group">
      <SettingsSection
        as="form"
        title="重排（rerank，可选）"
        desc="关键词和按意思搜找出来的候选条目，再请专门的重排模型按和客户问题的相关度排一次，带进回复的条目更准。只在知识库超过约 4 万字、要检索时才用（首页 AI 助手查知识库时超过 6000 字就用）；出错或超时就照原来的顺序，不影响回复。"
        onSubmit={onSubmit}
        actions={<ResetButton onClick={() => setDraft({ ...DEFAULTS })} disabled={sameDraft(draft, DEFAULTS)} />}
      >
        <SettingsRow
          inline
          label="重排"
          htmlFor="rr-enabled"
          hint="开启后，每次检索会把客户最近的话（最多 1500 字）和前 40 条候选条目（每条最多 2000 字）发给重排服务，按服务商的价格计费。"
        >
          <Switch id="rr-enabled" checked={draft.enabled} onChange={(v) => set('enabled', v)} label="重排" />
        </SettingsRow>

        <SettingsRow
          label="接口地址（Base URL）"
          htmlFor="rr-base"
          hint="按服务商文档填，系统会在后面加上 /rerank。Jina 填 https://api.jina.ai/v1，Cohere 填 https://api.cohere.com/v2，硅基流动填 https://api.siliconflow.cn/v1，Voyage 填 https://api.voyageai.com/v1；自己部署的 vLLM、Xinference 填 http://<主机>:<端口>/v1。"
        >
          <input
            {...fieldProps('rr-base', errOf('baseUrl'))}
            className="input input--mono"
            placeholder="https://api.jina.ai/v1"
            value={draft.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            spellCheck={false}
            inputMode="url"
          />
          <FieldError id="rr-base">{errOf('baseUrl')}</FieldError>
        </SettingsRow>

        <SettingsRow label="API 密钥" htmlFor="rr-key" hint="自己部署的服务没设密钥就不用填。">
          <div className="settings-page__secret">
            <SecretField
              id="rr-key"
              isSet={!!rr.apiKeySet}
              last4={rr.apiKeyLast4}
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

        <SettingsRow
          label="重排模型"
          htmlFor="rr-model"
          hint="例如 Jina 的 jina-reranker-v2-base-multilingual、Cohere 的 rerank-v3.5、硅基流动的 BAAI/bge-reranker-v2-m3 或 Qwen/Qwen3-Reranker-8B、Voyage 的 rerank-2.5。客户和知识库语言不同时选多语言的模型。"
        >
          <div className="settings-page__inline">
            <input
              {...fieldProps('rr-model', errOf('model'))}
              className="input input--mono"
              placeholder="重排模型的名字"
              value={draft.model}
              onChange={(e) => set('model', e.target.value)}
              spellCheck={false}
            />
            <button type="button" className="btn" onClick={test} disabled={testing || !draft.model.trim() || !draft.baseUrl.trim()}>
              {testing ? <Spinner /> : <PlugZap />}
              {testing ? '正在测试…' : '测试'}
            </button>
          </div>
          <FieldError id="rr-model">{errOf('model')}</FieldError>
          <TestResult result={shownResult} />
        </SettingsRow>

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
