import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, ChevronRight, FileText, Play, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { Callout, Field, Metric, PageHeader, Segmented, Spinner, fieldProps } from '../../ui/common.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { isConnected, useAccounts } from '../../lib/accounts.js';
import { CAMPAIGN_MODES, CHANNEL_LABEL, skipReasonLabel, waState } from '../../lib/labels.js';
import { fmtNum, fmtSize } from '../../lib/format.js';
import { CountrySelect } from './CountrySelect.jsx';
import { errorText, startConfirmMessage, toCampaign, useOutreachSettings } from './shared.jsx';

/**
 * 新建外联（DESIGN 第 7 节：一整页，顶部 3 步横向步骤条）。
 * 1 上传号码文件、任务名称、默认国家 → 2 选模式和号 → 3 写开场消息（右边实时预览；有 Meta 号时填模板）。
 * 提交 POST /api/campaigns（multipart）建出草稿，接着在同一页显示预检结果，可以「开始发送」或先「保存为草稿」。
 */

const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 10000;
const INVALID_SHOWN = 200;

const STEPS = ['上传号码', '选号', '开场消息'];

/** 本地数一下文件里有多少行号码（空行、# 开头的行不算），只用来估算每个号分到多少；真正的解析和校验在服务端 */
function countNumberLines(text) {
  return String(text || '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).length;
}

const baseName = (name) => String(name || '').replace(/\.[^.]+$/, '');

function Steps({ current, done }) {
  return (
    <ol className="steps outreach-new__steps" aria-label="新建步骤">
      {STEPS.map((label, i) => {
        const isDone = done || i < current;
        const isCurrent = !done && i === current;
        const cls = ['steps__item', isDone && 'is-done', isCurrent && 'is-current'].filter(Boolean).join(' ');
        return (
          <li key={label} className={cls} aria-current={isCurrent ? 'step' : undefined}>
            <span className="steps__index">{isDone ? <Check aria-hidden="true" /> : i + 1}</span>
            <span className="outreach-new__step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 选号列表：single 用单选，pooled 用多选。每行显示接入方式和连接状态 */
function AccountChoices({ accounts, mode, value, onChange }) {
  const selected = new Set(value);
  const single = mode === 'single';
  const toggle = (id) => {
    if (single) {
      onChange([id]);
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(accounts.map((a) => a.id).filter((x) => next.has(x)));
  };
  return (
    <div
      className="choice-list outreach-new__accounts"
      role={single ? 'radiogroup' : 'group'}
      aria-label={single ? '用哪个号发' : '用哪些号发'}
    >
      {accounts.map((a) => {
        const st = waState(a.status?.state);
        return (
          <label key={a.id} className="choice outreach-new__account">
            <input
              type={single ? 'radio' : 'checkbox'}
              name="outreach-account"
              className={single ? 'radio' : 'checkbox'}
              checked={selected.has(a.id)}
              onChange={() => toggle(a.id)}
            />
            <span className="outreach-new__account-name ellipsis">
              {a.name || '未命名号码'}
              <span className="muted text-sm"> · {CHANNEL_LABEL[a.channel] || a.channel}</span>
            </span>
            <StatusDot tone={st.tone} pulse={st.pulse} size="sm" muted>
              {st.label}
            </StatusDot>
          </label>
        );
      })}
    </div>
  );
}

/** 预检结果：有效、无效（可展开看是哪几行）、各种跳过原因 */
function PreviewResult({ preview }) {
  const p = preview || {};
  const invalidLines = Array.isArray(p.invalidLines) ? p.invalidLines : [];
  const skipped = p.skipped && typeof p.skipped === 'object' ? p.skipped : {};
  const invalidCount = Math.max(invalidLines.length, Number(skipped.invalid) || 0);
  const reasons = Object.entries(skipped).filter(([k, n]) => k !== 'invalid' && Number(n) > 0);
  const skippedTotal = reasons.reduce((s, [, n]) => s + Number(n), 0);

  return (
    <div className="outreach-new__preview">
      <div className="grid-12" role="group" aria-label="预检汇总">
        <div className="span-4 outreach-metric">
          <Metric label="有效号码" value={fmtNum(p.valid ?? 0)} unit="个" foot="开始后会给这些号码各发一条" />
        </div>
        <div className="span-4 outreach-metric">
          <Metric label="格式不对" value={fmtNum(invalidCount)} unit="行" tone={invalidCount > 0 ? 'warning' : undefined} />
        </div>
        <div className="span-4 outreach-metric">
          <Metric label="跳过" value={fmtNum(skippedTotal)} unit="个" />
        </div>
      </div>

      {reasons.length > 0 && (
        <section className="outreach-new__block" aria-label="跳过原因">
          <h3>跳过原因</h3>
          <dl className="outreach-new__reasons">
            {reasons.map(([k, n]) => (
              <div key={k} className="outreach-new__reason">
                <dt>{skipReasonLabel(k)}</dt>
                <dd className="num">{fmtNum(n)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {invalidLines.length > 0 && (
        <details className="disclosure outreach-new__invalid">
          <summary>
            <ChevronRight aria-hidden="true" />
            查看格式不对的 {fmtNum(invalidLines.length)} 行
          </summary>
          <ul className="outreach-new__invalid-list">
            {invalidLines.slice(0, INVALID_SHOWN).map((l, i) => (
              <li key={`${l.line}-${i}`}>
                <span className="outreach-new__invalid-line num">第 {l.line} 行</span>
                <span className="mono outreach-new__invalid-raw">{l.raw || <span className="muted">（空）</span>}</span>
              </li>
            ))}
          </ul>
          {invalidLines.length > INVALID_SHOWN && (
            <div className="muted text-sm outreach-new__invalid-more">
              还有 {fmtNum(invalidLines.length - INVALID_SHOWN)} 行没有列出
            </div>
          )}
        </details>
      )}
    </div>
  );
}

export default function CampaignNew() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin } = useAuth();
  const { accounts } = useAccounts();
  const settings = useOutreachSettings();
  const fileRef = useRef(null);

  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null); // {file, lines} | null
  const [name, setName] = useState('');
  const [country, setCountry] = useState('CN');
  const [mode, setMode] = useState('pooled');
  const [accountIds, setAccountIds] = useState([]);
  const [message, setMessage] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplLang, setTplLang] = useState('');
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(null); // {campaign, preview}
  const [starting, setStarting] = useState(false);

  // 号列表到了以后设一次默认：勾上已连接的号；只有一个能用的号时直接用「指定一个号」
  const inited = useRef(false);
  useEffect(() => {
    // 空列表不算到了（可能是还没拉到，或拉取失败），等有号了再设
    if (inited.current || !accounts?.length) return;
    inited.current = true;
    const connected = accounts.filter(isConnected).map((a) => a.id);
    if (accounts.length <= 1 || connected.length <= 1) {
      setMode('single');
      setAccountIds((connected.length ? connected : accounts.map((a) => a.id)).slice(0, 1));
    } else {
      setAccountIds(connected);
    }
  }, [accounts]);

  const selectedAccounts = useMemo(
    () => (accounts || []).filter((a) => accountIds.includes(a.id)),
    [accounts, accountIds],
  );
  const hasMeta = selectedAccounts.some((a) => a.channel === 'meta');
  const offline = selectedAccounts.filter((a) => !isConnected(a));

  const clearErr = (k) => {
    if (errors[k]) setErrors((e) => ({ ...e, [k]: null }));
  };

  const changeMode = (m) => {
    setMode(m);
    clearErr('accounts');
    const connected = (accounts || []).filter(isConnected).map((a) => a.id);
    if (m === 'single') {
      setAccountIds((ids) => (ids.length ? ids.slice(0, 1) : connected.slice(0, 1)));
    } else {
      // 换成平均分配时，默认勾上所有已连接的号（保留已经选的）
      setAccountIds((ids) => (accounts || []).map((a) => a.id).filter((id) => ids.includes(id) || connected.includes(id)));
    }
  };

  const pickFile = () => fileRef.current?.click();
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    clearErr('file');
    if (!/\.txt$/i.test(f.name)) {
      setFile(null);
      setErrors((x) => ({ ...x, file: '只支持 .txt 文件' }));
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setErrors((x) => ({ ...x, file: '文件不能超过 1MB' }));
      return;
    }
    let lines = 0;
    try {
      lines = countNumberLines(await f.text());
    } catch {
      setFile(null);
      setErrors((x) => ({ ...x, file: '读取文件失败，请重新选择' }));
      return;
    }
    if (lines === 0) {
      setFile(null);
      setErrors((x) => ({ ...x, file: '文件里没有号码' }));
      return;
    }
    if (lines > MAX_LINES) {
      setFile(null);
      setErrors((x) => ({ ...x, file: `号码不能超过 ${fmtNum(MAX_LINES)} 行，这个文件有 ${fmtNum(lines)} 行` }));
      return;
    }
    setFile({ file: f, lines });
    if (!name.trim()) {
      setName(baseName(f.name).slice(0, 60));
      setErrors((x) => (x.name ? { ...x, name: null } : x));
    }
  };

  const validateStep = (i) => {
    const e = {};
    if (i === 0) {
      if (!file) e.file = errors.file || '请选择号码文件';
      if (!name.trim()) e.name = '请填写任务名称';
      if (!country) e.country = '请选择默认国家';
    } else if (i === 1) {
      if (!accountIds.length) e.accounts = mode === 'single' ? '请选择一个号' : '至少选择一个号';
      else if (mode === 'single' && accountIds.length > 1) e.accounts = '「指定一个号」只能选一个';
    } else if (i === 2) {
      if (!message.trim()) e.message = '请填写开场消息';
      if (hasMeta && !tplName.trim()) e.tplName = '选中的号里有 Meta 号，请填写模板名';
      if (hasMeta && !tplLang.trim()) e.tplLang = '请填写模板语言';
    }
    return e;
  };

  const scrollTop = () => document.querySelector('.main')?.scrollTo?.(0, 0);

  const focusFirstInvalid = () =>
    setTimeout(() => document.querySelector('.outreach-new [aria-invalid="true"]')?.focus?.(), 0);

  const goNext = () => {
    const e = validateStep(step);
    if (Object.keys(e).length) {
      setErrors((x) => ({ ...x, ...e }));
      focusFirstInvalid();
      return;
    }
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      scrollTop();
    } else {
      submit();
    }
  };

  const goBack = () => {
    setSubmitError(null);
    setStep((s) => Math.max(0, s - 1));
    scrollTop();
  };

  const submit = async () => {
    if (submitting) return;
    // 前两步也再查一遍（比如号被删了）
    for (let i = 0; i < STEPS.length; i += 1) {
      const e = validateStep(i);
      if (Object.keys(e).length) {
        setErrors((x) => ({ ...x, ...e }));
        setStep(i);
        focusFirstInvalid();
        return;
      }
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.createCampaign(
        {
          file: file.file,
          name: name.trim(),
          mode,
          accountIds: mode === 'single' ? accountIds.slice(0, 1) : accountIds,
          message: message.trim(),
          metaTemplateName: hasMeta ? tplName.trim() : '',
          metaTemplateLanguage: hasMeta ? tplLang.trim() : '',
          defaultCountry: country,
        },
        { silent: true },
      );
      const campaign = toCampaign(res);
      if (!campaign) throw new Error('服务端没有返回创建好的任务，请到外联列表里查看');
      setCreated({ campaign, preview: res?.preview || null });
      scrollTop();
    } catch (e) {
      if (e?.status === 401) return;
      if (e?.code === 'template_required') {
        setErrors((x) => ({
          ...x,
          tplName: tplName.trim() ? x.tplName : '选中的号里有 Meta 号，必须填模板名',
          tplLang: tplLang.trim() ? x.tplLang : '必须填模板语言',
        }));
        setSubmitError({ message: e.message || 'Meta 号主动发起会话必须用审核通过的模板消息，请填写模板名和语言' });
        setStep(2);
        focusFirstInvalid();
      } else {
        setSubmitError({ message: errorText(e) });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const detailUrl = created ? `/outreach/${encodeURIComponent(created.campaign.id)}` : null;

  const start = async () => {
    if (!created || starting) return;
    const ok = await confirm({ title: '开始发送？', message: startConfirmMessage(settings), confirmText: '开始发送' });
    if (!ok) return;
    setStarting(true);
    try {
      await api.startCampaign(created.campaign.id);
      toast.success('已开始发送');
      navigate(detailUrl, { replace: true });
    } catch {
      setStarting(false);
    }
  };

  /* ---------- 各步内容 ---------- */

  const perAccount =
    file && accountIds.length ? Math.ceil(file.lines / (mode === 'single' ? 1 : accountIds.length)) : null;

  const step1 = (
    <div className="vstack outreach-new__fields">
      <Field
        label="号码文件"
        htmlFor="on-file"
        error={errors.file}
        hint="每行一个号码，可以带 +、00、空格、横线和括号；# 开头的行忽略。UTF-8 编码的 .txt，不超过 1MB、10,000 行。"
      >
        <div className="outreach-new__file">
          <button
            type="button"
            id="on-file"
            className="btn"
            onClick={pickFile}
            aria-invalid={errors.file ? true : undefined}
            aria-describedby={errors.file ? 'on-file-err' : undefined}
          >
            <Upload />
            {file ? '重新选择' : '选择文件'}
          </button>
          {file && (
            <span className="outreach-new__file-info">
              <FileText aria-hidden="true" />
              <span className="ellipsis" title={file.file.name}>
                {file.file.name}
              </span>
              <span className="muted text-sm num nowrap">
                {fmtSize(file.file.size)} · {fmtNum(file.lines)} 行号码
              </span>
            </span>
          )}
        </div>
      </Field>
      <Field label="任务名称" htmlFor="on-name" error={errors.name}>
        <input
          {...fieldProps('on-name', errors.name)}
          className="input"
          value={name}
          maxLength={60}
          placeholder="例如：10 月展会客户回访"
          onChange={(e) => {
            setName(e.target.value);
            clearErr('name');
          }}
        />
      </Field>
      <Field
        label="默认国家"
        htmlFor="on-country"
        error={errors.country}
        hint="号码没带国家码时，按这个国家的区号补全。"
      >
        <CountrySelect
          id="on-country"
          value={country}
          invalid={!!errors.country}
          aria-describedby={errors.country ? 'on-country-err' : undefined}
          onChange={(v) => {
            setCountry(v);
            clearErr('country');
          }}
        />
      </Field>
    </div>
  );

  let accountsBody;
  if (accounts == null) {
    accountsBody = (
      <div className="muted text-sm hstack">
        <Spinner /> 正在加载号码…
      </div>
    );
  } else if (!accounts.length) {
    accountsBody = (
      <div className="muted">
        {isAdmin ? (
          <>
            还没有号码，先去
            <Link className="link" to="/whatsapp/numbers">
              号码
            </Link>
            里添加一个。
          </>
        ) : (
          '还没有分配给你的号码，请联系管理员。'
        )}
      </div>
    );
  } else {
    accountsBody = (
      <AccountChoices
        accounts={accounts}
        mode={mode}
        value={accountIds}
        onChange={(ids) => {
          setAccountIds(ids);
          clearErr('accounts');
        }}
      />
    );
  }

  let accountsHint = null;
  if (perAccount != null) {
    accountsHint =
      mode === 'single'
        ? `${fmtNum(file.lines)} 个号码都由这个号发。`
        : `每个号约分到 ${fmtNum(perAccount)} 个（共 ${fmtNum(file.lines)} 行号码，去掉无效和跳过的之后平均分）。`;
  }

  const step2 = (
    <div className="vstack outreach-new__fields">
      <Field label="发送方式">
        <div>
          <Segmented label="发送方式" options={CAMPAIGN_MODES} value={mode} onChange={changeMode} />
        </div>
      </Field>
      <Field
        label={mode === 'single' ? '用哪个号发' : '用哪些号发'}
        error={errors.accounts}
        hint={accountsHint}
      >
        {accountsBody}
      </Field>
      {offline.length > 0 && (
        <div className="muted text-sm">
          {offline.map((a) => `「${a.name || '未命名号码'}」`).join('')}还没连接，连上之后才会发送。
        </div>
      )}
    </div>
  );

  const step3 = (
    <div className="outreach-new__compose">
      <div className="vstack outreach-new__fields">
        <Field
          label="开场消息"
          htmlFor="on-message"
          error={errors.message}
          hint="每个号码只发这一条；对方不回复就不会再发。"
        >
          <textarea
            {...fieldProps('on-message', errors.message)}
            className="textarea"
            rows={6}
            maxLength={4000}
            placeholder="例如：您好，我是 XX 公司的小王，之前在展会上加过您，想跟您确认一下样品的需求。"
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              clearErr('message');
            }}
          />
        </Field>
        {hasMeta && (
          <>
            <Field
              label="Meta 模板名"
              htmlFor="on-tpl-name"
              error={errors.tplName}
              hint="Meta 号主动联系客户只能发审核通过的模板消息，Meta 号发的是这个模板，不是上面的开场消息。"
            >
              <input
                {...fieldProps('on-tpl-name', errors.tplName)}
                className="input input--mono"
                value={tplName}
                placeholder="例如：follow_up_intro"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setTplName(e.target.value);
                  clearErr('tplName');
                }}
              />
            </Field>
            <Field label="模板语言" htmlFor="on-tpl-lang" error={errors.tplLang} hint="和模板审核时的语言代码一致，例如 zh_CN、en_US。">
              <input
                {...fieldProps('on-tpl-lang', errors.tplLang)}
                className="input input--mono"
                value={tplLang}
                placeholder="zh_CN"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setTplLang(e.target.value);
                  clearErr('tplLang');
                }}
              />
            </Field>
          </>
        )}
      </div>
      <aside className="outreach-new__aside" aria-label="消息预览">
        <div className="outreach-new__aside-title">预览</div>
        <div className="outreach-new__chat">
          {message.trim() ? (
            <div className="msg msg--out msg--bot">
              <div className="msg__bubble">{message}</div>
              <div className="msg__meta">
                <span>外联</span>
              </div>
            </div>
          ) : (
            <div className="outreach-new__chat-empty">写好开场消息后，这里显示对方看到的样子。</div>
          )}
        </div>
        <ul className="outreach-new__rules">
          <li>每个号码只发一条开场消息，不跟进。</li>
          <li>对方拒绝后不再联系，也不会被别的外联任务再次联系。</li>
          <li>发送受每个号每天的上限和对方当地时间的发送时段限制。</li>
        </ul>
      </aside>
    </div>
  );

  /* ---------- 页面 ---------- */

  let content;
  if (created) {
    const valid = Number(created.preview?.valid ?? created.campaign?.stats?.pending ?? 0);
    content = (
      <>
        <Steps current={STEPS.length} done />
        <div className="outreach-new__panel">
          <div className="outreach-new__head">
            <h2>预检结果</h2>
            <div className="muted">已建好草稿「{created.campaign.name || name}」，还没有发送。</div>
          </div>
          {created.preview ? (
            <PreviewResult preview={created.preview} />
          ) : (
            <div className="muted">服务端没有返回预检结果，可以到任务详情里查看收件人。</div>
          )}
          {valid === 0 && created.preview && (
            <Callout tone="warning">没有可以发送的号码，这个任务开始后不会发出任何消息。</Callout>
          )}
        </div>
        <div className="outreach-new__foot">
          <button type="button" className="btn" onClick={() => navigate(detailUrl, { replace: true })} disabled={starting}>
            保存为草稿
          </button>
          <button type="button" className="btn btn--primary" onClick={start} disabled={starting || (created.preview && valid === 0)}>
            {starting ? <Spinner /> : <Play />}
            开始发送
          </button>
        </div>
      </>
    );
  } else {
    content = (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          goNext();
        }}
      >
        <Steps current={step} />
        <div className="outreach-new__panel">
          {step === 0 && step1}
          {step === 1 && step2}
          {step === 2 && step3}
          {submitError && step === 2 && <Callout tone="danger">{submitError.message}</Callout>}
        </div>
        <div className="outreach-new__foot">
          {step > 0 ? (
            <button type="button" className="btn" onClick={goBack} disabled={submitting}>
              <ArrowLeft />
              上一步
            </button>
          ) : (
            <Link className="btn" to="/outreach">
              取消
            </Link>
          )}
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {step < STEPS.length - 1 ? (
              '下一步'
            ) : (
              <>
                {submitting && <Spinner />}
                创建并预检
              </>
            )}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { label: '外联', to: '/outreach' },
          { label: '新建外联' },
        ]}
      />
      <div className="page-body page-body--form outreach-new">{content}</div>
      <input ref={fileRef} type="file" accept=".txt,text/plain" hidden onChange={onFile} />
    </div>
  );
}
