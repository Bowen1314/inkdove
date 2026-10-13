import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, MessageSquare, Sparkles } from 'lucide-react';
import { api } from '../../api/client.js';
import { notifyBlockwordAck, onBlockwordAck } from '../../lib/blockwords.js';
import { fmtFull, fmtNum } from '../../lib/format.js';
import {
  BLOCKWORD_LANGUAGES,
  BLOCKWORD_RISK,
  blockwordLanguageLabel,
  blockwordResult,
  blockwordSourceLabel,
  blockwordWho,
  CONDUCT_SEVERITY,
  conductLabel,
} from '../../lib/labels.js';
import { BlockwordText, BlockwordWords, blockwordWhere } from '../../ui/BlockwordAlerts.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { Select } from '../../ui/Select.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { TimeText } from '../../ui/TimeText.jsx';
import { toast } from '../../ui/toastBus.js';
import { Callout, EmptyState, ErrorState, Segmented, Spinner, Switch, fieldProps } from '../../ui/common.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, ResetButton, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/**
 * 屏蔽词（admin）：开关、词表、AI 扩充、AI 发言检查的开关，下面是命中记录（含 AI 发言检查发现的）。
 * 开关和词表走 PUT /api/settings 的 blockwords，命中记录、误报和 AI 扩充走 /api/blockwords/*。上限和服务端 server/src/blockwords/ 下的一致。
 */

const MAX_WORDS = 500;
const MAX_WORD_CHARS = 40;
const MAX_SEEDS = 30;
const MAX_LANGUAGES = 8;
const DEFAULT_LANGUAGES = ['zh', 'en'];
const PAGE_SIZE = 50;

const FIELDS = { 'blockwords.words': 'words', 'blockwords.enabled': 'enabled', 'blockwords.aiCheck': 'aiCheck' };
const LABELS = { words: '屏蔽词', enabled: '发出前检查屏蔽词', aiCheck: 'AI 发言检查' };
const DEFAULTS = { enabled: false, text: '', aiCheck: false };

const toDraft = (b) => ({ enabled: !!b?.enabled, text: (b?.words || []).join('\n'), aiCheck: !!b?.aiCheck });

/** 输入框里的词：去掉首尾空白、跳过空行（服务端还会按大小写、全角半角去重） */
const wordsOf = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** 前端先查一遍明显的问题（太多、太长）；「第 N 行」按输入框里的行数算，和服务端一致 */
function validate(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if ([...lines[i].trim()].length > MAX_WORD_CHARS) return `第 ${i + 1} 行太长了，每个词最多 ${MAX_WORD_CHARS} 个字`;
  }
  const n = wordsOf(text).length;
  if (n > MAX_WORDS) return `最多 ${MAX_WORDS} 个词，现在有 ${n} 个`;
  return '';
}

const AI_CHECK_HELP =
  '查哪些：后台发的消息和文件说明、通知号码上转发的话、外联开场消息、机器人的自动回复、机主在手机上发的。' +
  '一键翻译（AI 翻译）和自动回复在翻译、审核的那一次模型调用里顺带查，不多调模型；其余的发出后再查：同一个会话停下来 30 秒后，把这一阵发的一起查，' +
  '每个会话这一阵多一次模型调用（不算进会话每天的模型次数）。24 小时内查过一模一样的话不再查。撤回的、没发出去的、没有文字的不查，打开之前发的也不查。' +
  '要查的消息和它前面的几条（包括客户的话）会发给「AI 模型」里设置的回复模型，所以要先配好回复模型才能打开。';

const RULES_HELP =
  '不分大小写和全角半角。中文、日文、韩文、泰文按字面匹配，夹在别的字中间也算（「坏词」会命中「这个坏词啊」），所以单个字容易误拦；' +
  '英文等用空格分词的文字按整词匹配（cat 不会命中 category），夹着符号接数字的型号（SB-200）也不算。' +
  '故意拆开的写法照样拦：中间夹符号（b.a.d、坏*词）、零宽字符，或者一个字母一个字母用空格隔开（b a d）；夹着逗号、句号这类断句标点或换行的不算。';

export default function BlockwordsSection({ settings, onSaved }) {
  const [draft, setDraft, base] = useSliceDraft(settings.blockwords, toDraft);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState(null); // {field, text}
  const [expandOpen, setExpandOpen] = useState(false);
  const [formRef, reveal] = useRevealInvalid();

  const dirty = !sameDraft(base, draft);
  const localErr = validate(draft.text);
  const wordsErr = (touched && localErr) || (serverErr?.field === 'words' ? serverErr.text : '');
  const aiCheckErr = serverErr?.field === 'aiCheck' ? serverErr.text : '';
  const count = wordsOf(draft.text).length;

  const setText = (text) => {
    if (serverErr) setServerErr(null);
    setDraft((d) => ({ ...d, text }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setTouched(true);
    if (localErr) {
      toast.error(`${LABELS.words}：${localErr}`);
      reveal();
      return;
    }
    setSaving(true);
    setServerErr(null);
    // 空行也带上，服务端报的「第 N 行」才和输入框对得上
    const r = await putSlice(
      { blockwords: { enabled: draft.enabled, words: draft.text.split('\n'), aiCheck: draft.aiCheck } },
      { fields: FIELDS, labels: LABELS },
    );
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        setServerErr(r.fieldError);
        reveal();
      }
      return;
    }
    onSaved(r.res);
    setTouched(false);
    toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    setTouched(false);
    setServerErr(null);
  };

  /** AI 扩充选好的词加到输入框末尾（不保存） */
  const addWords = (words) => {
    const have = new Set(wordsOf(draft.text).map((w) => w.toLowerCase()));
    const fresh = words.filter((w) => !have.has(w.toLowerCase()));
    const room = Math.max(0, MAX_WORDS - have.size);
    const take = fresh.slice(0, room);
    if (take.length) setText(draft.text.replace(/\s+$/, '') + (draft.text.trim() ? '\n' : '') + take.join('\n'));
    if (take.length < fresh.length) toast.error(`词表最多 ${MAX_WORDS} 个词，有 ${fresh.length - take.length} 个没加进去`);
    else if (take.length) toast.success(`加了 ${take.length} 个词，检查后点保存才生效`);
  };

  return (
    <>
      <SettingsSection
        as="form"
        title="屏蔽词"
        desc="防止骂人之类的话发给客户。只查我方发出去的文字，客户发来的不查。开着屏蔽词或 AI 发言检查时，业务员的输入框下面会提示「发出的消息会做合规检查」。"
        onSubmit={onSubmit}
        actions={<ResetButton onClick={() => setDraft({ ...DEFAULTS })} disabled={sameDraft(draft, DEFAULTS)} />}
      >
        <div ref={formRef}>
          <SettingsRow
            inline
            label="发出前检查屏蔽词"
            htmlFor="bw-enabled"
            hint="业务员和管理员在后台发的消息、文件说明、一键翻译的原文，机器人的自动回复，通知号码上转发的话，外联的开场消息，发出前都查一遍：有屏蔽词就不发，管理员马上收到弹窗提醒。机主在手机上发的拦不住，只提醒。"
          >
            <Switch
              id="bw-enabled"
              checked={draft.enabled}
              onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
              label="发出前检查屏蔽词"
            />
          </SettingsRow>

          <SettingsRow
            label="屏蔽词"
            htmlFor="bw-words"
            hint={`每行一个词或短语，最多 ${MAX_WORDS} 个，每个最多 ${MAX_WORD_CHARS} 个字。`}
            help={RULES_HELP}
          >
            <textarea
              {...fieldProps('bw-words', wordsErr)}
              className="textarea"
              rows={10}
              placeholder="每行一个"
              value={draft.text}
              onChange={(e) => setText(e.target.value)}
            />
            <FieldError id="bw-words">{wordsErr}</FieldError>
            <div className="blockwords__foot">
              <button type="button" className="btn btn--sm" onClick={() => setExpandOpen(true)} disabled={!count}>
                <Sparkles />
                AI 扩充
              </button>
              <span className={`num ${count > MAX_WORDS ? 'text-danger' : 'muted'} text-sm`}>
                {count} / {MAX_WORDS}
              </span>
            </div>
          </SettingsRow>

          <SettingsRow
            inline
            label="AI 发言检查"
            htmlFor="bw-ai-check"
            hint="用 AI 看发给客户的话里有没有辱骂、威胁、歧视、骚扰、粗鲁这类说法。只提醒管理员，从不拦、不改任何消息：严重的弹窗，轻微的只记在下面的命中记录里。和上面的屏蔽词互不相干，可以只开一个。"
            help={AI_CHECK_HELP}
          >
            <Switch
              id="bw-ai-check"
              checked={draft.aiCheck}
              onChange={(v) => {
                if (serverErr?.field === 'aiCheck') setServerErr(null);
                setDraft((d) => ({ ...d, aiCheck: v }));
              }}
              label="AI 发言检查"
            />
            <FieldError id="bw-ai-check">{aiCheckErr}</FieldError>
          </SettingsRow>
        </div>

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>

      <HitHistory />

      <ExpandModal open={expandOpen} onClose={() => setExpandOpen(false)} words={[...new Set(wordsOf(draft.text))]} onAdd={addWords} />
    </>
  );
}

/* ---------- AI 扩充 ---------- */

/**
 * 种子词默认选前 30 个（服务端一次最多 30 个），语言默认中文和英语。生成的候选：低风险的默认勾上，中、高不勾；
 * 服务端已经去掉了输入框里有的词，太短的强制成高风险。「加入列表」只加到输入框，保存还是点保存栏。
 */
function ExpandModal({ open, onClose, words, onAdd }) {
  const [seeds, setSeeds] = useState(() => new Set());
  const [languages, setLanguages] = useState(DEFAULT_LANGUAGES);
  const [candidates, setCandidates] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  // 每次打开都从头来：种子是输入框里现在的词（没保存的也算）
  useEffect(() => {
    if (!open) return;
    setSeeds(new Set(words.slice(0, MAX_SEEDS)));
    setLanguages(DEFAULT_LANGUAGES);
    setCandidates(null);
    setPicked(new Set());
    setError('');
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    seq.current += 1; // 关掉之后回来的结果不要了
    onClose();
  };

  const toggle = (set, setter, v) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };
  const toggleLanguage = (code) =>
    setLanguages((ls) => (ls.includes(code) ? ls.filter((c) => c !== code) : BLOCKWORD_LANGUAGES.map((l) => l.value).filter((c) => c === code || ls.includes(c))));

  const seedList = words.filter((w) => seeds.has(w));
  const tooManySeeds = seedList.length > MAX_SEEDS;
  const canGenerate = !busy && seedList.length > 0 && !tooManySeeds && languages.length > 0;

  const generate = async () => {
    if (!canGenerate) return;
    const my = ++seq.current;
    setBusy(true);
    setError('');
    try {
      const res = await api.expandBlockwords({ seeds: seedList, languages, existing: words });
      if (my !== seq.current) return;
      const list = res?.candidates || [];
      setCandidates(list);
      setPicked(new Set(list.filter((c) => c.risk === 'low').map((c) => c.word)));
    } catch (e) {
      if (my !== seq.current || e?.status === 401) return;
      setError(e?.message || '扩充失败，请重试');
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  const add = () => {
    onAdd(candidates.filter((c) => picked.has(c.word)).map((c) => c.word));
    close();
  };

  const columns = [
    { key: 'word', header: '词', render: (c) => <span className="text-strong">{c.word}</span> },
    { key: 'language', header: '语言', shrink: true, render: (c) => blockwordLanguageLabel(c.language) },
    { key: 'seed', header: '来自', shrink: true, hide: 'sm', render: (c) => c.seed || <span className="muted">—</span> },
    {
      key: 'risk',
      header: '误判风险',
      fluid: true,
      render: (c) => {
        const r = BLOCKWORD_RISK[c.risk] || BLOCKWORD_RISK.high;
        return (
          <StatusDot tone={r.tone} wrap>
            {r.label}
            {c.reason && <span className="muted"> · {c.reason}</span>}
          </StatusDot>
        );
      },
    },
  ];

  return (
    <Modal
      open={open}
      title="AI 扩充屏蔽词"
      onClose={close}
      width={720}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className={candidates ? 'btn' : 'btn btn--primary'}
            onClick={generate}
            disabled={!canGenerate}
          >
            {busy ? <Spinner /> : <Sparkles />}
            {candidates ? '重新生成' : '生成'}
          </button>
          {candidates && (
            <button type="button" className="btn btn--primary" onClick={add} disabled={busy || picked.size === 0}>
              加入列表{picked.size ? `（${picked.size}）` : ''}
            </button>
          )}
        </>
      }
    >
      <div className="blockwords-expand">
        <p className="muted text-sm">
          用回复模型按种子词生成更多的词：同义的说法，谐音、拼音缩写、拆字、错拼、夹符号这些变体，以及选中语言里的说法。会产生一次模型调用费用。
          挑好的词只加到输入框里，检查后点保存才生效。
        </p>

        <div className="field">
          <div className="field__label-row">
            <span className="field__label">种子词</span>
            <span className={`num text-sm ${tooManySeeds ? 'text-danger' : 'muted'}`}>
              已选 {seedList.length} / {MAX_SEEDS}
            </span>
          </div>
          <div className="choice-list blockwords-expand__seeds" role="group" aria-label="种子词">
            {words.map((w) => (
              <label key={w} className="choice">
                <input type="checkbox" className="checkbox" checked={seeds.has(w)} onChange={() => toggle(seeds, setSeeds, w)} disabled={busy} />
                <span className="ellipsis">{w}</span>
              </label>
            ))}
          </div>
          {tooManySeeds && <div className="field__error">一次最多 {MAX_SEEDS} 个种子词</div>}
        </div>

        <div className="field">
          <div className="field__label-row">
            <span className="field__label">要生成的语言</span>
            <span className="muted num text-sm">
              {languages.length} / {MAX_LANGUAGES}
            </span>
          </div>
          <div className="choice-list blockwords-expand__langs" role="group" aria-label="要生成的语言">
            {BLOCKWORD_LANGUAGES.map((l) => {
              const on = languages.includes(l.value);
              return (
                <label key={l.value} className="choice">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={on}
                    onChange={() => toggleLanguage(l.value)}
                    disabled={busy || (!on && languages.length >= MAX_LANGUAGES)}
                  />
                  <span>{l.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        {error && <Callout tone="danger">{error}</Callout>}

        {busy && !candidates && (
          <div className="muted hstack">
            <Spinner /> 正在生成，可能要几十秒…
          </div>
        )}

        {candidates && (
          <div className="blockword-table">
            <DataTable
              label="候选词"
              columns={columns}
              rows={candidates}
              rowKey={(c) => c.word}
              selectable
              selected={picked}
              onSelectedChange={setPicked}
              pageSize={100}
              empty={<EmptyState compact title="没有新的词" desc="生成的词都已经在列表里了，可以换几个种子词或语言再试。" />}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------- 命中记录 ---------- */

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '未处理' },
  { value: 'acked', label: '已处理' },
  { value: 'false_positive', label: '误报' },
];
const DETECTOR_FILTERS = [
  { value: '', label: '所有方式' },
  { value: 'word', label: '屏蔽词' },
  { value: 'ai', label: 'AI 发言检查' },
];
const SEVERITY_FILTERS = [
  { value: '', label: '所有程度' },
  { value: 'severe', label: CONDUCT_SEVERITY.severe.label },
  { value: 'mild', label: CONDUCT_SEVERITY.mild.label },
];
const RANGE_FILTERS = [
  { value: '', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];
const WHO_SOURCES = [
  { value: 'bot', label: '机器人' },
  { value: 'phone', label: '机主手机' },
  { value: 'relay', label: '通知号码' },
];

/** 时间筛选 → 起点（ISO，按浏览器时区算「今天」） */
function rangeFrom(range) {
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const days = { '7d': 7, '30d': 30 }[range];
  return days ? new Date(Date.now() - days * 86400_000).toISOString() : undefined;
}

/** 历史：按状态、检测方式（AI 的再按严重程度）、人、时间筛选，服务端分页（每页 50）；点一行展开原文 */
function HitHistory() {
  const [status, setStatus] = useState('');
  const [detector, setDetector] = useState('');
  const [severity, setSeverity] = useState('');
  const [who, setWho] = useState('');
  const [range, setRange] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null); // {total, items}
  const [senders, setSenders] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [acking, setAcking] = useState(null);
  const seq = useRef(0);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      const my = ++seq.current;
      if (!quiet) setLoading(true);
      try {
        const res = await api.listBlockwordHits(
          { status, detector, severity: detector === 'ai' ? severity : '', who, from: rangeFrom(range), page, pageSize: PAGE_SIZE },
          { silent: true },
        );
        if (my !== seq.current) return;
        setData({ total: res.total || 0, items: res.items || [] });
        setSenders(res.senders || []);
        setError(null);
      } catch (e) {
        if (my !== seq.current || e.status === 401) return;
        setError(e);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [status, detector, severity, who, range, page],
  );

  // 换筛选或翻页：先清空再取（显示骨架）
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // 弹窗里或这里点了「知道了」：安静地刷新当前这页
  useEffect(() => onBlockwordAck(() => load({ quiet: true })), [load]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    if (data && page > pages) setPage(pages);
  }, [data, page, pages]);

  const filter = (setter) => (v) => {
    setter(v);
    setPage(1);
  };

  /** 「知道了」；falsePositive 时标「误报」（只有 AI 发现的，同时算处理了，不能撤销） */
  const ack = async (h, falsePositive = false) => {
    if (acking) return;
    setAcking(`${h.id}:${falsePositive ? 'fp' : 'ack'}`);
    try {
      if (falsePositive) await api.falsePositiveBlockwordHit(h.id);
      else await api.ackBlockwordHit(h.id);
      notifyBlockwordAck();
    } catch {
      // 已提示
    } finally {
      setAcking(null);
    }
  };
  const fpButton = (h) => (
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => ack(h, true)} disabled={!!acking}>
      {acking === `${h.id}:fp` && <Spinner />}
      误报
    </button>
  );

  const whoOptions = [
    { value: '', label: '所有人' },
    ...senders.map((s) => ({ value: s.id, label: s.name || '未命名成员' })),
    ...WHO_SOURCES,
  ];

  // 窄屏隐藏：< 768 号和会话；< 640 结果
  const columns = [
    { key: 'ts', header: '时间', shrink: true, render: (h) => <TimeText iso={h.ts} /> },
    {
      key: 'who',
      header: '谁',
      render: (h) => <CellText primary={blockwordWho(h)} secondary={blockwordSourceLabel(h.source)} />,
    },
    { key: 'where', header: '号和会话', hide: 'md', render: (h) => <span className="ellipsis">{blockwordWhere(h)}</span> },
    {
      key: 'words',
      header: '屏蔽词 / 问题',
      render: (h) =>
        h.detector === 'ai' ? (
          <StatusDot tone={CONDUCT_SEVERITY[h.severity]?.tone || 'warning'} wrap>
            {conductLabel(h)}
            {h.reason && <span className="muted"> · {h.reason}</span>}
          </StatusDot>
        ) : (
          <BlockwordWords words={h.words} />
        ),
    },
    {
      key: 'result',
      header: '结果',
      hide: 'sm',
      render: (h) => {
        const r = blockwordResult(h);
        return <StatusDot tone={r.tone}>{r.label}</StatusDot>;
      },
    },
    {
      key: 'ack',
      header: '处理',
      shrink: true,
      render: (h) => {
        if (h.falsePositiveAt) {
          return (
            <Tooltip content={`${h.falsePositiveByName || '管理员'} · ${fmtFull(h.falsePositiveAt)}`}>
              <span className="muted nowrap">误报</span>
            </Tooltip>
          );
        }
        const isAi = h.detector === 'ai';
        if (h.ackedAt) {
          return (
            <span className="hstack nowrap">
              <Tooltip content={fmtFull(h.ackedAt)}>
                <span className="muted nowrap">{h.ackedByName || '已处理'}</span>
              </Tooltip>
              {isAi && fpButton(h)}
            </span>
          );
        }
        return (
          <span className="hstack nowrap">
            <button type="button" className="btn btn--sm" onClick={() => ack(h)} disabled={!!acking}>
              {acking === `${h.id}:ack` && <Spinner />}
              知道了
            </button>
            {isAi && fpButton(h)}
          </span>
        );
      },
    },
  ];

  const emptyTitle = status || detector || who || range ? '没有符合条件的记录' : '还没有命中记录';

  return (
    <SettingsSection
      title="命中记录"
      desc="谁在什么时候发了带屏蔽词的话，以及 AI 发言检查发现的问题（AI 看错了可以标「误报」）。原文只有管理员能看到；点一行看原文。"
    >
      <div className="blockword-table">
        <TableToolbar count={data && !error ? total : undefined} end={loading && data ? <Spinner /> : null}>
          <Segmented label="按处理状态筛选" options={STATUS_FILTERS} value={status} onChange={filter(setStatus)} />
          <Select
            size="sm"
            className="select--auto"
            value={detector}
            onChange={filter(setDetector)}
            options={DETECTOR_FILTERS}
            aria-label="按检测方式筛选"
          />
          {detector === 'ai' && (
            <Select
              size="sm"
              className="select--auto"
              value={severity}
              onChange={filter(setSeverity)}
              options={SEVERITY_FILTERS}
              aria-label="按严重程度筛选"
            />
          )}
          <Select size="sm" className="select--auto" value={who} onChange={filter(setWho)} options={whoOptions} aria-label="按人筛选" />
          <Select size="sm" className="select--auto" value={range} onChange={filter(setRange)} options={RANGE_FILTERS} aria-label="按时间筛选" />
        </TableToolbar>
        {error ? (
          <ErrorState compact title="命中记录加载失败" error={error} onRetry={() => load()} />
        ) : (
          <>
            <DataTable
              label="命中记录"
              columns={columns}
              rows={data ? data.items : null}
              rowKey={(h) => h.id}
              pageSize={PAGE_SIZE}
              onRowClick={(h) => setExpanded((k) => (k === h.id ? null : h.id))}
              renderExpanded={(h) => (
                <div className="blockword-history__detail">
                  <BlockwordText text={h.text} ranges={h.ranges} />
                  <div className="hstack muted text-sm">
                    <span className="num">{fmtFull(h.ts)}</span>
                    {h.conversationId && (
                      <Link className="btn btn--sm btn--ghost" to={`/whatsapp/chats?chat=${encodeURIComponent(h.conversationId)}`}>
                        <MessageSquare />
                        打开会话
                      </Link>
                    )}
                  </div>
                </div>
              )}
              expandedKey={expanded}
              empty={<EmptyState compact title={emptyTitle} />}
            />
            {data && pages > 1 && (
              <div className="pagination">
                <span>
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE)} / {fmtNum(total)}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--icon"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={page <= 1 || loading}
                  aria-label="上一页"
                >
                  <ChevronLeft />
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--icon"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= pages || loading}
                  aria-label="下一页"
                >
                  <ChevronRight />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
