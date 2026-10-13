import { useState } from 'react';
import { PlugZap } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Callout, Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { Select } from '../../ui/Select.jsx';
import { SecretField } from '../../ui/SecretField.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { TRANSLATION_MODES, TRANSLATION_PROVIDERS } from '../../lib/labels.js';
import { FieldError, TestResult, mapServerError, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/** 新标签页打开的外部链接 */
const ext = (href, text) => (
  <a className="link" href={href} target="_blank" rel="noreferrer">
    {text}
  </a>
);

/**
 * 每家服务的字段（和服务端 server/src/translate/ 下各家的 fields 对应）和说明。
 * type：secret 密钥（从不回显，留空不改）；secretUrl 带密钥的地址（同密钥，保存后只显示协议和主机）；url、text 普通字段。
 * 免费额度只写个大概，都注明以官网为准。
 */
const PROVIDERS = {
  deepl: {
    fields: [
      {
        key: 'apiKey',
        type: 'secret',
        label: 'API Key',
        required: true,
        hint: '以 :fx 结尾的是免费版（DeepL API Free）的密钥，会自动用免费版的地址。',
      },
    ],
    note: (
      <>
        在 DeepL 账户的{ext('https://www.deepl.com/your-account/keys', '「API 密钥」页面')}创建。免费版每月约 50 万字符，超出后当月停用（以官网为准）。
      </>
    ),
  },
  deeplx: {
    fields: [
      {
        key: 'url',
        type: 'secretUrl',
        label: '服务地址',
        required: true,
        hint: '例如 http://127.0.0.1:1188/translate（不带 /translate 会自动补上）。地址里可能带着令牌，按密钥保存，保存后只显示协议和主机。',
      },
      { key: 'token', type: 'secret', label: '访问令牌', required: false, hint: '部署时设了 TOKEN 才填。' },
    ],
    note: (
      <>
        {ext('https://github.com/OwO-Network/DeepLX', 'DeepLX')} 是开源的非官方 DeepL 接口，不用 DeepL 的密钥，但不稳定、容易被限流。建议自己部署；网上公开的地址能看到你发过去的每一句话。
      </>
    ),
  },
  azure: {
    fields: [
      { key: 'apiKey', type: 'secret', label: 'API Key', required: true, hint: '翻译器资源「密钥和终结点」里的密钥 1 或密钥 2。' },
      {
        key: 'region',
        type: 'text',
        label: '区域',
        required: false,
        placeholder: '例如 eastasia',
        hint: '同一页的「位置/区域」，例如 eastasia、southeastasia；全局（Global）资源不填。',
      },
      {
        key: 'endpoint',
        type: 'url',
        label: '自定义终结点',
        required: false,
        placeholder: 'https://api.cognitive.microsofttranslator.com',
        hint: '一般不填。只有资源用了自定义域名（https://名字.cognitiveservices.azure.com）时才填。',
      },
    ],
    note: (
      <>
        在 {ext('https://portal.azure.com', 'Azure 门户')} 创建「翻译器（Translator）」资源。免费层（F0）每月约 200 万字符（以官网为准）。
      </>
    ),
  },
  google: {
    fields: [
      {
        key: 'apiKey',
        type: 'secret',
        label: 'API Key',
        required: true,
        hint: '建议在控制台把这个密钥限制为只能调用 Cloud Translation API。',
      },
    ],
    note: (
      <>
        Cloud Translation 基础版（v2）。在 {ext('https://console.cloud.google.com/apis/credentials', 'Google Cloud 控制台的「凭据」')}里创建 API 密钥，并给项目启用 Cloud Translation API、绑定结算账号。每月有约 50 万字符的免费额度，超出按量计费（以官网为准）。
      </>
    ),
  },
  baidu: {
    fields: [
      { key: 'appId', type: 'secret', label: 'APP ID', required: true },
      { key: 'appKey', type: 'secret', label: '密钥', required: true },
    ],
    note: (
      <>
        在百度翻译开放平台的{ext('https://fanyi-api.baidu.com/manage/developer', '「开发者信息」')}里查看 APP ID 和密钥，并开通「通用文本翻译」。标准版每月 5 万字符、每秒 1 次；个人认证后的高级版每月 100 万字符（以官网为准）。
      </>
    ),
    warning:
      '超出免费额度后按字符计费、次日结算，余额不够会欠费，请留意用量。个人版只能译 28 个常见语种，印尼语、土耳其语、印地语、马来语等用不了。',
  },
  volcengine: {
    fields: [
      { key: 'accessKeyId', type: 'secret', label: 'Access Key ID', required: true },
      { key: 'secretAccessKey', type: 'secret', label: 'Secret Access Key', required: true },
    ],
    note: (
      <>
        在火山引擎控制台的{ext('https://console.volcengine.com/iam/keymanage/', '「访问控制 → 密钥管理」')}创建，建议用只给了机器翻译权限的子账号。每月前 200 万字符免费（以官网为准）。
      </>
    ),
    warning: '超出免费额度后按量后付费、每天结算，没有「用完就停」的开关，请留意用量。开通机器翻译可能要先提交申请。',
  },
  libretranslate: {
    fields: [
      {
        key: 'url',
        type: 'url',
        label: '服务地址',
        required: true,
        placeholder: 'http://127.0.0.1:5000',
        hint: '自己部署的 LibreTranslate 地址。',
      },
      { key: 'apiKey', type: 'secret', label: 'API Key', required: false, hint: '自己部署且没开 API Key 时不填；用 libretranslate.com 的服务要填。' },
    ],
    note: (
      <>
        {ext('https://github.com/LibreTranslate/LibreTranslate', 'LibreTranslate')} 开源、可以自己部署：数据不出自己的服务器，不按字数收费。能译哪些语言看部署时装了哪些语言模型。
      </>
    ),
  },
  tencent: {
    fields: [
      { key: 'secretId', type: 'secret', label: 'SecretId', required: true },
      { key: 'secretKey', type: 'secret', label: 'SecretKey', required: true },
      { key: 'region', type: 'text', label: '区域', required: true, placeholder: 'ap-guangzhou', hint: '例如 ap-guangzhou、ap-shanghai、ap-hongkong。' },
    ],
    note: (
      <>
        在腾讯云{ext('https://console.cloud.tencent.com/cam/capi', '「访问密钥」')}页面创建。后付费默认关闭；关闭后付费时，资源包用完会自动停服。
      </>
    ),
    warning: '腾讯云机器翻译已停止接受新用户，免费资源包从 2026-10-01 起不再发放，2027-10-01 起全部停用。已经在用的可以用到那时，新接入请选别家。',
  },
};
/** 两种方式下面的说明 */
const MODE_DESC = {
  ai: '回复模型看客户最近的消息判断语言并翻译。要先在「AI 模型」里配好回复模型，每次翻译按模型的价格计费。',
  api: '用 DeepL、谷歌、百度等专门的翻译服务，不需要回复模型。业务员要翻译的话，和客户最近几条消息里的几百字（用来判断客户的语言）会发给所选的服务。',
};
const PROVIDER_IDS = Object.keys(PROVIDERS);
const PROVIDER_OPTIONS = TRANSLATION_PROVIDERS.filter((p) => PROVIDERS[p.value]);
const providerLabel = (id) => TRANSLATION_PROVIDERS.find((p) => p.value === id)?.label || id;

const isSecret = (f) => f.type === 'secret' || f.type === 'secretUrl';
const plainFields = (id) => PROVIDERS[id].fields.filter((f) => !isSecret(f));

/** 服务端错误前缀 → 字段（各家的字段是「服务.字段」） */
const FIELDS = { 'translation.mode': 'mode', 'translation.provider': 'provider', 'translation.fallbackToAi': 'fallbackToAi' };
const LABELS = { mode: '翻译方式', provider: '翻译服务', fallbackToAi: '出错时改用 AI 翻译' };
for (const id of PROVIDER_IDS) {
  for (const f of PROVIDERS[id].fields) {
    FIELDS[`translation.providers.${id}.${f.key}`] = `${id}.${f.key}`;
    LABELS[`${id}.${f.key}`] = `${providerLabel(id)} 的 ${f.label}`;
  }
}

const asIs = (d) => d;

/** 草稿：方式、服务、开关，和每家的普通字段（密钥不在这里，另外记新填的值） */
function toDraft(tr) {
  const fields = {};
  for (const id of PROVIDER_IDS) {
    fields[id] = {};
    for (const f of plainFields(id)) fields[id][f.key] = tr?.providers?.[id]?.[f.key] ?? '';
  }
  return {
    mode: tr?.mode === 'api' ? 'api' : 'ai',
    provider: PROVIDERS[tr?.provider] ? tr.provider : 'deepl',
    fallbackToAi: tr?.fallbackToAi !== false,
    fields,
  };
}

/**
 * 设置 → 翻译：会话输入框里「翻译成客户的语言」用 AI 翻译（回复模型）还是翻译 API，翻译 API 用哪家、怎么连。
 * 每家的配置分开存，换服务不丢已填的密钥。密钥从不回显：留空不改，「清除」立即保存。
 * 测试用表单里当前的值（不用先保存），把一句中文译成英语。
 */
export default function TranslationSection({ settings, onSaved }) {
  const tr = settings.translation || {};
  const pub = tr.providers || {};
  // 草稿只看方式、服务、开关和普通字段：清除密钥后设置刷新，不会冲掉这里没保存的修改（比如刚换的服务）
  const [draft, setDraft, base] = useSliceDraft(toDraft(tr), asIs);
  const [secrets, setSecrets] = useState({}); // {服务: {字段: 新填的值}}
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(null); // '服务.字段'
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // {ok, text, conn}
  const [fieldErr, setFieldErr] = useState(null); // {field, text}
  const [formRef, reveal] = useRevealInvalid();

  const id = draft.provider;
  const def = PROVIDERS[id];
  const typed = (pid, key) => secrets[pid]?.[key] ?? '';
  const anyTyped = Object.values(secrets).some((o) => Object.values(o).some((v) => v.trim()));
  const dirty = !sameDraft(base, draft) || anyTyped;
  const errOf = (k) => (fieldErr?.field === k ? fieldErr.text : '');
  const clearErr = (k) => {
    if (fieldErr?.field === k) setFieldErr(null);
  };
  const set = (k, v) => {
    clearErr(k);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const setField = (key, v) => {
    clearErr(`${id}.${key}`);
    setDraft((d) => ({ ...d, fields: { ...d.fields, [id]: { ...d.fields[id], [key]: v } } }));
  };
  const setSecret = (key, v) => {
    clearErr(`${id}.${key}`);
    setSecrets((s) => ({ ...s, [id]: { ...(s[id] || {}), [key]: v } }));
  };

  /** 测试时发的配置：普通字段用表单里的，密钥只发新填的（空着用已保存的） */
  const testConfig = () => {
    const c = {};
    for (const f of plainFields(id)) c[f.key] = draft.fields[id][f.key].trim();
    for (const [k, v] of Object.entries(secrets[id] || {})) if (v.trim()) c[k] = v.trim();
    return c;
  };
  // 测试结果只对测试时的那组值有效，换了服务或改了任何一项就不显示
  const conn = JSON.stringify([id, testConfig()]);
  const shownResult = testResult?.conn === conn ? testResult : null;

  /** 选了翻译 API 时，选的那家还缺哪个必填字段 */
  const missingField = () =>
    def.fields.find((f) => {
      if (!f.required) return false;
      if (isSecret(f)) return !pub[id]?.[`${f.key}Set`] && !typed(id, f.key).trim();
      return !draft.fields[id][f.key].trim();
    });

  const save = async () => {
    const patch = { mode: draft.mode, provider: draft.provider, fallbackToAi: draft.fallbackToAi };
    const providers = {};
    for (const pid of PROVIDER_IDS) {
      const p = {};
      for (const f of plainFields(pid)) {
        if (draft.fields[pid][f.key] !== base.fields[pid][f.key]) p[f.key] = draft.fields[pid][f.key].trim();
      }
      for (const [k, v] of Object.entries(secrets[pid] || {})) if (v.trim()) p[k] = v.trim();
      if (Object.keys(p).length) providers[pid] = p;
    }
    if (Object.keys(providers).length) patch.providers = providers;
    setSaving(true);
    setFieldErr(null);
    const r = await putSlice({ translation: patch }, { fields: FIELDS, labels: LABELS });
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        // 出错的字段可能在别家（没显示），换到那一家再定位
        const pid = r.fieldError.field.split('.')[0];
        if (PROVIDERS[pid] && pid !== draft.provider) setDraft((d) => ({ ...d, provider: pid }));
        setFieldErr(r.fieldError);
        reveal();
      }
      return false;
    }
    onSaved(r.res);
    setSecrets({});
    return true;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (draft.mode === 'api') {
      const miss = missingField();
      if (miss) {
        const text = `选「翻译 API」时要填 ${miss.label}`;
        setFieldErr({ field: `${id}.${miss.key}`, text });
        toast.error(`${providerLabel(id)}：${text}`);
        reveal();
        return;
      }
    }
    if (await save()) toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    setSecrets({});
    setFieldErr(null);
  };

  const clearSecret = async (f) => {
    if (f.required && base.mode === 'api' && base.provider === id) {
      toast.error(`正在用${providerLabel(id)}翻译，不能清除${f.label}。先换成别的方式或服务并保存，再清除`);
      return;
    }
    setClearing(`${id}.${f.key}`);
    try {
      onSaved(await api.putSettings({ translation: { providers: { [id]: { [f.key]: null } } } }));
      setSecret(f.key, '');
      setTestResult(null); // 测试时用的可能是清掉的那个
      toast.success(`${f.label}已清除`);
    } catch {
      // 已提示
    } finally {
      setClearing(null);
    }
  };

  const test = async () => {
    setTestResult(null);
    setTesting(true);
    const testedConn = conn;
    try {
      const r = await api.testTranslation({ provider: id, config: testConfig() });
      if (r?.ok) {
        setTestResult({ ok: true, text: `测试成功（用时 ${((r.latencyMs || 0) / 1000).toFixed(1)} 秒）：${r.text}`, conn: testedConn });
      } else {
        setTestResult({ ok: false, text: `测试失败：${r?.error || '原因未知'}`, conn: testedConn });
        if (r?.field && PROVIDERS[id].fields.some((f) => f.key === r.field)) setFieldErr({ field: `${id}.${r.field}`, text: r.error });
      }
    } catch (e) {
      // 字段不合法的 400：已弹提示，再把错误放到字段下面
      const fe = mapServerError(e, FIELDS);
      if (fe) setFieldErr(fe);
    } finally {
      setTesting(false);
    }
  };

  const renderField = (f) => {
    const fid = `tr-${id}-${f.key}`;
    const err = errOf(`${id}.${f.key}`);
    const label = f.required ? f.label : `${f.label}（可选）`;
    if (isSecret(f)) {
      const p = pub[id] || {};
      const isSet = !!p[`${f.key}Set`];
      return (
        <SettingsRow key={fid} label={label} htmlFor={fid} hint={f.hint}>
          <div className="settings-page__secret">
            <SecretField
              id={fid}
              isSet={isSet}
              last4={f.type === 'secret' ? p[`${f.key}Last4`] : null}
              hint={f.type === 'secretUrl' && isSet && p[`${f.key}Display`] ? `当前：${p[`${f.key}Display`]}` : undefined}
              value={typed(id, f.key)}
              onChange={(v) => setSecret(f.key, v)}
              onClear={() => clearSecret(f)}
              clearing={clearing === `${id}.${f.key}`}
              error={err}
            />
          </div>
        </SettingsRow>
      );
    }
    return (
      <SettingsRow key={fid} label={label} htmlFor={fid} hint={f.hint}>
        <input
          {...fieldProps(fid, err)}
          className="input input--mono"
          placeholder={f.placeholder}
          value={draft.fields[id][f.key]}
          onChange={(e) => setField(f.key, e.target.value)}
          spellCheck={false}
          autoComplete="off"
          inputMode={f.type === 'url' ? 'url' : undefined}
        />
        <FieldError id={fid}>{err}</FieldError>
      </SettingsRow>
    );
  };

  return (
    <div ref={formRef}>
      <SettingsSection
        as="form"
        title="翻译"
        desc="会话输入框里的「翻译成客户的语言」：把业务员写的话译成客户用的语言，只替换输入框里的内容，不会直接发出。"
        onSubmit={onSubmit}
      >
        <SettingsRow label="翻译方式">
          <div className="choice-list" role="radiogroup" aria-label="翻译方式">
            {TRANSLATION_MODES.map((m) => (
              <label key={m.value} className="choice">
                <input
                  type="radio"
                  className="radio"
                  name="tr-mode"
                  value={m.value}
                  checked={draft.mode === m.value}
                  onChange={() => set('mode', m.value)}
                />
                <span className="choice__text">
                  <span>{m.label}</span>
                  <span className="choice__desc">{MODE_DESC[m.value]}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id="tr-mode">{errOf('mode')}</FieldError>
        </SettingsRow>

        {draft.mode === 'api' && (
          <>
            <SettingsRow label="翻译服务" htmlFor="tr-provider">
              <div className="vstack" style={{ gap: 'var(--sp-2)', alignItems: 'stretch' }}>
                <Select
                  id="tr-provider"
                  value={id}
                  onChange={(v) => {
                    clearErr('provider');
                    setDraft((d) => ({ ...d, provider: v }));
                  }}
                  options={PROVIDER_OPTIONS}
                  invalid={!!errOf('provider')}
                  aria-describedby={errOf('provider') ? 'tr-provider-err' : undefined}
                  style={{ maxWidth: 320 }}
                />
                <FieldError id="tr-provider">{errOf('provider')}</FieldError>
                <div className="field__hint">{def.note}</div>
                {def.warning && <Callout tone="warning">{def.warning}</Callout>}
              </div>
            </SettingsRow>

            {def.fields.map(renderField)}

            <SettingsRow label="测试" hint="用上面填的值把一句中文译成英语，不用先保存。会调用一次翻译接口，计入这家服务的用量。">
              <div className="vstack" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
                <button type="button" className="btn" onClick={test} disabled={testing}>
                  {testing ? <Spinner /> : <PlugZap />}
                  {testing ? '正在测试…' : '测试'}
                </button>
                <TestResult result={shownResult} />
              </div>
            </SettingsRow>

            <SettingsRow
              inline
              label="翻译接口出错时改用 AI 翻译"
              htmlFor="tr-fallback"
              hint="接口超时、额度用完、不支持客户的语言等情况下，这次改用回复模型翻译，并在输入框下面说明原因。回复模型没配好时照常报错。"
            >
              <Switch
                id="tr-fallback"
                checked={draft.fallbackToAi}
                onChange={(v) => set('fallbackToAi', v)}
                label="翻译接口出错时改用 AI 翻译"
              />
            </SettingsRow>
          </>
        )}

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>
    </div>
  );
}
