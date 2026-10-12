import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookPlus,
  CornerDownLeft,
  Image as ImageIcon,
  Languages,
  MessagesSquare,
  Mic,
  PanelRight,
  Pause,
  Play,
  Search,
  SendHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from '../../api/client.js';
import { EmptyState, ErrorState, PageHeader, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { Avatar } from '../../ui/Avatar.jsx';
import { Select } from '../../ui/Select.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { Popover, Tooltip } from '../../ui/Popover.jsx';
import { EntryRefs } from '../../ui/EntryRefs.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { useAuth } from '../../lib/auth.jsx';
import { isConnected, useAccounts } from '../../lib/accounts.js';
import { setPendingCount } from '../../lib/inboxCount.js';
import { AUTHOR_LABEL, BOT_DECISION_NOTE, LEAD_STAGES, MEDIA_LABEL, leadStageLabel } from '../../lib/labels.js';
import { fmtDay, fmtHm, fmtShortTime, fmtTime } from '../../lib/format.js';
import { SaveToKbModal } from './SaveToKbModal.jsx';
import { AttachmentCard, DraftFiles, SendFileButton, sendFilesInOrder } from './ChatFiles.jsx';

const POLL_MS = 4000;

/** URLSearchParams 已解码一次；若链接被二次编码（仍含 %40、%3A 之类），再解一次 */
function readChatParam(params) {
  let id = params.get('chat');
  if (!id) return null;
  if (/%[0-9a-f]{2}/i.test(id)) {
    try {
      id = decodeURIComponent(id);
    } catch {
      // 保持原值
    }
  }
  return id;
}

export const convName = (c) => c?.contactName || c?.contactNumber || c?.id || '未知联系人';

function sortConvs(list) {
  // needsHuman 置顶，其余按 updatedAt 倒序
  return [...(list || [])].sort((a, b) => {
    if (!!a.needsHuman !== !!b.needsHuman) return a.needsHuman ? -1 : 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
}

/** mutedUntil 未过期时返回 Date，否则 null */
function activeMute(conv) {
  if (!conv?.mutedUntil) return null;
  const d = new Date(conv.mutedUntil);
  return Number.isNaN(d.getTime()) || d.getTime() <= Date.now() ? null : d;
}

/** 静默截止时间：当天显示 HH:mm，跨天加"明天"或日期 */
function fmtMuteUntil(d) {
  const hm = fmtHm(d.toISOString());
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  const t = new Date(now);
  t.setDate(now.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function ConvState({ conv, size = 'sm', showActive = false }) {
  if (conv.needsHuman) return <StatusDot tone="danger" tinted size={size}>待你处理</StatusDot>;
  if (conv.botPaused) return <StatusDot tone="warning" tinted size={size}>人工接管中</StatusDot>;
  const mute = activeMute(conv);
  if (mute) return <StatusDot tone="neutral" muted size={size}>反复离题，静默到 {fmtMuteUntil(mute)}</StatusDot>;
  if (showActive) return <StatusDot tone="success" muted size={size}>机器人接待中</StatusDot>;
  return null;
}

/* ---------- 会话列表 ---------- */

function ConvList({ convs, selectedId, onSelect, pollFailed, noConnected, accountFilter }) {
  const [filter, setFilter] = useState('');
  const sorted = useMemo(() => sortConvs(convs), [convs]);
  const f = filter.trim().toLowerCase();
  const shown = f
    ? sorted.filter((c) =>
        [c.contactName, c.contactNumber, c.id, c.accountName].some((v) => String(v || '').toLowerCase().includes(f)),
      )
    : sorted;

  return (
    <section className="inbox__list" aria-label="会话列表">
      <div className="inbox__list-head">
        <div className="input-group">
          <Search className="input-group__icon" aria-hidden="true" />
          <input
            className="input input--sm"
            type="search"
            placeholder="搜索姓名或号码"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="搜索会话"
          />
          {filter && (
            <button type="button" className="input-group__clear" onClick={() => setFilter('')} aria-label="清空">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {pollFailed && (
        <div className="inbox__notice">
          <StatusDot tone="warning" size="sm">连接中断，正在重试…</StatusDot>
        </div>
      )}

      <div className="inbox__items">
        {convs == null ? (
          <SkeletonRows rows={6} avatar />
        ) : sorted.length === 0 ? (
          <EmptyState
            compact
            icon={MessagesSquare}
            title={accountFilter ? '这个号还没有会话' : '还没有会话'}
            desc={
              noConnected ? (
                <>
                  还没有已连接的号码。
                  <Link className="link" to="/whatsapp/numbers">
                    去连接
                  </Link>
                </>
              ) : (
                '客户给你的 WhatsApp 发消息后，会显示在这里。'
              )
            }
          />
        ) : shown.length === 0 ? (
          <EmptyState compact title="没有匹配的会话" />
        ) : (
          shown.map((c) => {
            const last = c.lastMessage;
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                type="button"
                className={`conv${active ? ' is-active' : ''}${c.needsHuman ? ' is-pending' : ''}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(c.id)}
              >
                <Avatar name={c.contactName || c.contactNumber} />
                <span className="conv__body">
                  <span className="conv__top">
                    <span className="conv__name">{convName(c)}</span>
                    <span className="conv__time">{fmtShortTime(last?.ts || c.updatedAt)}</span>
                  </span>
                  <span className="conv__preview">
                    {last ? (
                      <>
                        {last.direction === 'out' && <span className="muted">你：</span>}
                        {last.text}
                      </>
                    ) : (
                      <span className="muted">暂无消息</span>
                    )}
                  </span>
                  <span className="conv__meta">
                    <ConvState conv={c} />
                    {c.accountName && <span className="conv__acct">{c.accountName}</span>}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

/* ---------- 消息 ---------- */

/** 消息作者 → 气泡种类和标签 */
function bubbleKind(msg) {
  const author = msg.author || (msg.direction === 'in' ? 'customer' : 'operator');
  if (author === 'owner') return { kind: 'owner', label: AUTHOR_LABEL.owner };
  if (author === 'bot') {
    if (msg.via === 'campaign') return { kind: 'bot', label: '外联', campaign: true };
    return { kind: 'bot', label: AUTHOR_LABEL.bot };
  }
  if (author === 'operator') {
    if (msg.via === 'whatsapp') return { kind: 'operator', label: '人工 · 经 WhatsApp 转发' };
    return { kind: 'operator', label: msg.sentByName ? `人工 · ${msg.sentByName}` : AUTHOR_LABEL.operator };
  }
  return { kind: 'customer' };
}

const MEDIA_ICON = { voice: Mic, image: ImageIcon };
const NOTE_TONE = { handoff: 'warning', blocked: 'danger', declined: 'info' };

function KnowledgeRefs({ ids }) {
  return (
    <Popover
      label="依据的知识条目"
      trigger={
        <button type="button" className="msg__link">
          依据 {ids.length} 条知识
        </button>
      }
    >
      <EntryRefs ids={ids} />
    </Popover>
  );
}

function MessageBubble({ msg, canSaveToKb, onSaveToKb }) {
  const { kind, label, campaign } = bubbleKind(msg);
  const [showActions, setShowActions] = useState(false);
  const pressRef = useRef(null);
  const MediaIcon = kind === 'customer' && msg.media ? MEDIA_ICON[msg.media.type] : null;
  // 只发了文件、没有文字的人工消息不能存进知识库（后端会报 empty_message）
  const actionable = kind === 'operator' && canSaveToKb && msg.status !== 'failed' && !!msg.text?.trim();
  const fromUs = kind !== 'customer';

  // 人工消息：悬停（桌面）或长按（手机）时出现"存进知识库"
  const touchProps = actionable
    ? {
        onTouchStart: () => {
          clearTimeout(pressRef.current);
          pressRef.current = setTimeout(() => setShowActions(true), 450);
        },
        onTouchEnd: () => clearTimeout(pressRef.current),
        onTouchMove: () => clearTimeout(pressRef.current),
        onContextMenu: (e) => {
          // 长按会触发系统菜单，换成我们的操作
          if (window.matchMedia?.('(hover: none)').matches) {
            e.preventDefault();
            setShowActions(true);
          }
        },
      }
    : {};

  useEffect(() => () => clearTimeout(pressRef.current), []);

  const note = BOT_DECISION_NOTE[msg.botDecision];
  const ids = msg.usedEntryIds || [];

  return (
    <div
      className={`msg msg--${kind}${fromUs ? ' msg--out' : ''}${msg.status === 'failed' ? ' msg--failed' : ''}${showActions ? ' show-actions' : ''}`}
      {...touchProps}
    >
      {/* F15：发出的文件显示成文件卡片；带说明文字（caption）时文字另起一个气泡 */}
      {msg.attachment && <AttachmentCard attachment={msg.attachment} />}
      {(!msg.attachment || msg.text) && (
        <div className="msg__bubble">
          {MediaIcon && (
            <span className="msg__media" title={MEDIA_LABEL[msg.media.type]} aria-label={MEDIA_LABEL[msg.media.type]}>
              <MediaIcon />
            </span>
          )}
          {msg.text}
        </div>
      )}
      <div className="msg__meta">
        {fromUs && <span>{label}</span>}
        {kind === 'bot' && !campaign && ids.length > 0 && <KnowledgeRefs ids={ids} />}
        {kind === 'customer' && note && (
          <span className={`msg__note${NOTE_TONE[msg.botDecision] ? ` msg__note--${NOTE_TONE[msg.botDecision]}` : ''}`}>
            {note}
            {msg.decisionReason ? ` · ${msg.decisionReason}` : ''}
          </span>
        )}
        <Tooltip content={fmtTime(msg.ts)}>
          <span>{fmtHm(msg.ts)}</span>
        </Tooltip>
        {actionable && (
          <button
            type="button"
            className="msg__link msg__action"
            onClick={() => {
              setShowActions(false);
              onSaveToKb(msg);
            }}
          >
            <BookPlus aria-hidden="true" />
            存进知识库
          </button>
        )}
      </div>
      {msg.status === 'failed' && <div className="msg__error">发送失败{msg.error ? `：${msg.error}` : ''}</div>}
    </div>
  );
}

function MessageStream({ messages, convId, canSaveToKb, onSaveToKb }) {
  const ref = useRef(null);
  const stickRef = useRef(true);
  const lastConvRef = useRef(null);

  const onScroll = () => {
    const el = ref.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !messages) return;
    if (lastConvRef.current !== convId) {
      lastConvRef.current = convId;
      stickRef.current = true;
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, convId]);

  if (messages == null) {
    return (
      <div className="inbox__stream">
        <div className="vstack" style={{ gap: 16 }} aria-busy="true" aria-label="加载中">
          {[60, 42, 70].map((w, i) => (
            <span key={i} className="skeleton" style={{ width: `${w}%`, height: 36, alignSelf: i % 2 ? 'flex-end' : 'flex-start' }} />
          ))}
        </div>
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="inbox__stream">
        <EmptyState fill icon={MessagesSquare} title="暂无消息" />
      </div>
    );
  }

  let lastDay = '';
  return (
    <div className="inbox__stream" ref={ref} onScroll={onScroll}>
      {messages.map((m) => {
        const day = fmtDay(m.ts);
        const sep = day && day !== lastDay;
        lastDay = day;
        return (
          <div key={m.id} className="inbox__stream-item">
            {sep && <div className="day-sep">{day}</div>}
            <MessageBubble msg={m} canSaveToKb={canSaveToKb} onSaveToKb={onSaveToKb} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * F2a 草稿：输入框上方显示，"填入输入框"后由人工修改再发。
 * F15：草稿可以只带文件（text 为空、fileIds 有值），文件列在文字下面，旁边"发送这些文件"按顺序逐个发。
 * kept：草稿已被自己发的消息清掉（后端规则），只剩前端记住的文件建议；这时不显示文字，可以手动关掉。
 */
function DraftBox({ draft, kept, onFill, onSendFiles, sendingFiles, onDismiss }) {
  const text = !kept && draft?.text?.trim() ? draft.text : '';
  const fileIds = kept ? kept.fileIds : Array.isArray(draft?.fileIds) ? draft.fileIds : [];
  if (!text && !fileIds.length) return null;
  return (
    <div className="draft">
      <div className="draft__head">
        <Sparkles aria-hidden="true" />
        <span>{kept ? '草稿建议发送的文件（还没发）' : '建议回复（草稿，未发送）'}</span>
        {text && (
          <button type="button" className="btn btn--sm" onClick={() => onFill(text)}>
            <CornerDownLeft />
            填入输入框
          </button>
        )}
        {kept && (
          <Tooltip content="不发了，关掉">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={onDismiss}
              disabled={sendingFiles}
              aria-label="关掉草稿建议的文件"
            >
              <X />
            </button>
          </Tooltip>
        )}
      </div>
      {text && <div className="draft__text">{text}</div>}
      {fileIds.length > 0 && <DraftFiles fileIds={fileIds} onSend={onSendFiles} sending={sendingFiles} />}
    </div>
  );
}

function Composer({ conv, text, setText, onSent, inputRef }) {
  const [sending, setSending] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [status, setStatus] = useState(''); // 翻译完成后在底栏左侧短暂显示
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  // 自动增高，最多 6 行
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 12)}px`;
  }, [text, inputRef]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending || translating) return;
    setSending(true);
    try {
      const msg = await api.sendMessage(conv.id, t);
      setText('');
      onSent(msg);
    } catch {
      // 已提示
    } finally {
      setSending(false);
    }
  };

  // 一键翻译成客户的语言：只替换输入框内容，不发送。失败时接口已弹提示，原文不动
  const translate = async () => {
    const original = text;
    if (!original.trim() || sending || translating) return;
    setTranslating(true);
    setStatus('');
    try {
      const res = await api.translateText(conv.id, original);
      // 翻译期间输入框只读，但"填入输入框"仍可能换掉内容；换过就不覆盖
      if (textRef.current !== original) return;
      setText(res.text);
      setStatus(res.text === original.trim() ? `原文已是${res.language}，没有改动` : `已翻译为 ${res.language}`);
      setTimeout(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange?.(res.text.length, res.text.length);
        }
      }, 0);
    } catch {
      // 已提示
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={inputRef}
        className="composer__input"
        rows={1}
        placeholder={`回复 ${convName(conv)}…`}
        value={text}
        disabled={sending}
        readOnly={translating}
        aria-busy={translating || undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="回复内容"
      />
      <div className="composer__bar">
        <span className={`composer__hint${status ? ' composer__hint--status' : ''}`} aria-live="polite">
          {status || `Enter 发送 · Shift+Enter 换行${conv.botPaused ? '' : ' · 手动发送后机器人会暂停这个会话'}`}
        </span>
        <SendFileButton conv={conv} onSent={onSent} disabled={sending} />
        <Tooltip content="翻译成客户的语言">
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={translate}
            disabled={!text.trim() || sending || translating}
            aria-label="翻译成客户的语言"
          >
            {translating ? <Spinner /> : <Languages />}
          </button>
        </Tooltip>
        <button type="button" className="btn btn--primary btn--sm" onClick={send} disabled={!text.trim() || sending || translating}>
          {sending ? <Spinner /> : <SendHorizontal />}
          发送
        </button>
      </div>
    </div>
  );
}

/* ---------- 客户信息 ---------- */

function useLead(conv) {
  const [lead, setLead] = useState(undefined); // undefined=加载中，null=没有
  const id = conv?.id;
  const number = conv?.contactNumber;
  const accountId = conv?.accountId;
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    setLead(undefined);
    api
      .listLeads({ q: number || undefined, accountId: accountId || undefined }, { silent: true })
      .then((list) => {
        const arr = Array.isArray(list) ? list : list?.leads || [];
        if (alive) setLead(arr.find((l) => l.conversationId === id) || null);
      })
      .catch(() => alive && setLead(null));
    return () => {
      alive = false;
    };
  }, [id, number, accountId]);
  return lead;
}

const FUNNEL = LEAD_STAGES.slice(0, 4);

function CustomerInfo({ conv }) {
  const lead = useLead(conv);
  const rows = lead
    ? [
        ['名字', lead.name || conv.contactName],
        ['公司', lead.company],
        ['国家', lead.country],
        ['邮箱', lead.email],
        ['意向', lead.interest],
        ['数量', lead.quantity],
      ].filter(([, v]) => v)
    : [];
  const stageIdx = lead ? FUNNEL.findIndex((s) => s.value === lead.stage) : -1;

  return (
    <div className="info">
      <div className="info__section">
        <h3 className="info__title">联系方式</h3>
        <dl className="kv">
          <dt>号码</dt>
          <dd className="num">{conv.contactNumber || '—'}</dd>
          <dt>所属号</dt>
          <dd>{conv.accountName || '—'}</dd>
        </dl>
      </div>

      {lead === undefined ? (
        <div className="info__section">
          <span className="skeleton skeleton--text" style={{ width: '60%' }} />
          <span className="skeleton skeleton--text" style={{ width: '80%' }} />
          <span className="skeleton skeleton--text" style={{ width: '50%' }} />
        </div>
      ) : lead === null ? (
        <div className="info__section muted">还没有提取到客户信息。</div>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="info__section">
              <h3 className="info__title">客户</h3>
              <dl className="kv">
                {rows.map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="info__section">
            <div className="info__title-row">
              <h3 className="info__title">阶段</h3>
              <span className="text-strong">{leadStageLabel(lead.stage)}</span>
            </div>
            {stageIdx >= 0 && (
              <>
                <div className="stage-bar" aria-hidden="true">
                  {FUNNEL.map((s, i) => (
                    <i key={s.value} className={i <= stageIdx ? 'is-on' : ''} />
                  ))}
                </div>
                <div className="stage-bar__labels" aria-hidden="true">
                  {FUNNEL.map((s) => (
                    <span key={s.value}>{s.label}</span>
                  ))}
                </div>
              </>
            )}
          </div>
          {lead.summary && (
            <div className="info__section">
              <h3 className="info__title">摘要</h3>
              <p>{lead.summary}</p>
            </div>
          )}
          <div className="info__section">
            <Link className="link" to={`/leads?lead=${encodeURIComponent(lead.id)}`}>
              打开客户
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- 会话窗口 ---------- */

function ChatPane({ conv, convId, messages, msgError, onBack, onConvUpdate, onSent, onRetry, canSaveToKb, onToggleInfo, infoShown }) {
  const [toggling, setToggling] = useState(false);
  const [text, setText] = useState('');
  const [kbMsg, setKbMsg] = useState(null);
  const inputRef = useRef(null);
  // 自己发出任何消息后端都会清空草稿（F2a），草稿里建议的文件先在这里记住：发完、手动关掉或切换会话
  // （ChatPane 按会话 key，切换即重置）前一直显示。{draftAt: 来自哪份草稿的 createdAt, fileIds}
  const [keptFiles, setKeptFiles] = useState(null);
  const [sendingFiles, setSendingFiles] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const liveDraft = conv?.draft || null;
  const liveFileIds = Array.isArray(liveDraft?.fileIds) ? liveDraft.fileIds : [];
  // 服务端出了新草稿（createdAt 不同）就以新草稿为准；同一份草稿（轮询拿到旧数据）仍按已清掉显示
  const kept = keptFiles && (!liveDraft || liveDraft.createdAt === keptFiles.draftAt) ? keptFiles : null;
  const liveDraftAt = liveDraft?.createdAt;
  useEffect(() => {
    if (liveDraftAt !== undefined) setKeptFiles((prev) => (prev && prev.draftAt !== liveDraftAt ? null : prev));
  }, [liveDraftAt]);

  /** 自己发出消息或文件：先记住草稿里的文件建议，发出去的那个文件从里面去掉 */
  const handleSent = (msg) => {
    if (liveFileIds.length) {
      setKeptFiles((prev) => (prev && prev.draftAt === liveDraftAt ? prev : { draftAt: liveDraftAt, fileIds: liveFileIds }));
    }
    const sentFileId = msg?.status !== 'failed' ? msg?.attachment?.fileId : null;
    if (sentFileId) {
      setKeptFiles((prev) => {
        if (!prev) return prev;
        const rest = prev.fileIds.filter((id) => id !== sentFileId);
        return rest.length ? { ...prev, fileIds: rest } : null;
      });
    }
    onSent(msg);
  };

  /** 草稿里的文件按顺序逐个发，中途失败就停（已提示是哪个）；全部发完收起。切走会话后照样发完，只是不再更新这里 */
  const sendDraftFiles = async (files) => {
    if (!conv || sendingFiles || !files.length) return;
    setSendingFiles(true);
    try {
      const done = await sendFilesInOrder({ convId: conv.id, files, onSent: (msg) => aliveRef.current && handleSent(msg) });
      // 已删除、已停用的发不了，全部发完时一起收起
      if (done && aliveRef.current) setKeptFiles(null);
    } finally {
      if (aliveRef.current) setSendingFiles(false);
    }
  };

  const toggleBot = async () => {
    if (!conv) return;
    setToggling(true);
    try {
      const res = await api.setBotPaused(conv.id, !conv.botPaused);
      onConvUpdate(
        res && res.id
          ? res
          : {
              ...conv,
              botPaused: !conv.botPaused,
              needsHuman: conv.botPaused ? false : conv.needsHuman,
              // 恢复机器人会清掉草稿
              draft: conv.botPaused ? null : conv.draft,
            },
      );
    } catch {
      // 已提示
    } finally {
      setToggling(false);
    }
  };

  const fillDraft = (t) => {
    setText(t);
    setTimeout(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange?.(t.length, t.length);
      }
    }, 0);
  };

  // 存进知识库时找这条人工消息前面最近的客户消息，只用来在弹窗里给人看
  const questionFor = (msg) => {
    const list = messages || [];
    const idx = list.findIndex((m) => m.id === msg.id);
    for (let i = idx - 1; i >= 0; i -= 1) {
      if ((list[i].author || (list[i].direction === 'in' ? 'customer' : '')) === 'customer') return list[i].text;
    }
    return '';
  };

  const name = conv ? convName(conv) : convId;

  return (
    <section className="inbox__chat" aria-label={`和 ${name} 的会话`}>
      <div className="chat-head">
        <button type="button" className="btn btn--ghost btn--icon chat-head__back" onClick={onBack} aria-label="返回会话列表">
          <ArrowLeft />
        </button>
        <Avatar name={conv?.contactName || conv?.contactNumber || convId} />
        <div className="chat-head__info">
          <div className="chat-head__name">{name}</div>
          <div className="chat-head__sub">
            {conv?.contactNumber && conv.contactName && <span className="num">{conv.contactNumber}</span>}
            {conv?.accountName && <span className="chat-head__acct">经 {conv.accountName}</span>}
            {conv && <ConvState conv={conv} showActive />}
          </div>
        </div>
        {conv && (
          <div className="chat-head__actions">
            <button type="button" className={`btn btn--sm${conv.botPaused ? ' btn--primary' : ''}`} onClick={toggleBot} disabled={toggling}>
              {toggling ? <Spinner /> : conv.botPaused ? <Play /> : <Pause />}
              {conv.botPaused ? '恢复机器人' : '暂停机器人'}
            </button>
            <Tooltip content={infoShown ? '隐藏客户信息' : '客户信息'}>
              <button
                type="button"
                className={`btn btn--ghost btn--icon btn--sm${infoShown ? ' is-pressed' : ''}`}
                onClick={onToggleInfo}
                aria-label="客户信息"
                aria-pressed={infoShown}
              >
                <PanelRight />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {msgError && messages == null ? (
        <div className="inbox__stream">
          <ErrorState
            compact
            title={msgError.status === 403 ? '没有权限查看这个会话' : '消息加载失败'}
            error={msgError.status === 403 ? null : msgError}
            onRetry={msgError.status === 403 ? undefined : onRetry}
          />
        </div>
      ) : (
        <MessageStream messages={messages} convId={convId} canSaveToKb={canSaveToKb} onSaveToKb={setKbMsg} />
      )}

      {conv && (
        <div className="inbox__compose">
          <DraftBox
            draft={conv.draft}
            kept={kept}
            onFill={fillDraft}
            onSendFiles={sendDraftFiles}
            sendingFiles={sendingFiles}
            onDismiss={() => setKeptFiles(null)}
          />
          <Composer conv={conv} text={text} setText={setText} onSent={handleSent} inputRef={inputRef} />
        </div>
      )}

      {canSaveToKb && (
        <SaveToKbModal
          conv={conv}
          convId={convId}
          message={kbMsg}
          question={kbMsg ? questionFor(kbMsg) : ''}
          onClose={() => setKbMsg(null)}
        />
      )}
    </section>
  );
}

/* ---------- 主体 ---------- */

export default function ChatsTab() {
  const [params, setParams] = useSearchParams();
  const selectedId = readChatParam(params);
  const accountFilter = params.get('account') || '';
  const { isAdmin } = useAuth();
  const { accounts } = useAccounts();
  const wide = useMediaQuery('(min-width: 1280px)');
  const [infoPinned, setInfoPinned] = useState(true); // ≥1280 时右栏是否显示
  const [infoDrawer, setInfoDrawer] = useState(false); // 更窄时用抽屉

  const [convs, setConvs] = useState(null);
  const [convError, setConvError] = useState(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [messages, setMessages] = useState(null);
  const [msgError, setMsgError] = useState(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const filterRef = useRef(accountFilter);
  filterRef.current = accountFilter;

  const loadConvs = useCallback(async () => {
    const want = filterRef.current;
    try {
      const list = await api.listConversations({ accountId: want || undefined }, { silent: true });
      if (filterRef.current !== want) return; // 筛选已切换，丢弃旧结果
      setConvs(list || []);
      if (!want) setPendingCount(list || []);
      setConvError(null);
      setPollFailed(false);
    } catch (e) {
      setConvError(e);
      setPollFailed(true);
    }
  }, []);

  const loadMessages = useCallback(async (id) => {
    if (!id) return;
    try {
      const list = await api.listMessages(id, { silent: true });
      if (selectedRef.current === id) {
        setMessages(list || []);
        setMsgError(null);
      }
    } catch (e) {
      if (selectedRef.current === id) setMsgError(e);
    }
  }, []);

  useEffect(() => {
    setConvs(null);
    loadConvs();
  }, [loadConvs, accountFilter]);

  useEffect(() => {
    setMessages(null);
    setMsgError(null);
    setInfoDrawer(false);
    loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // 每 4 秒拉会话列表和当前会话的消息；离开页面自动停止
  usePolling(
    async () => {
      await Promise.all([loadConvs(), selectedRef.current ? loadMessages(selectedRef.current) : null]);
    },
    POLL_MS,
    true,
  );

  const withParams = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => {
      if (v) next.set(k, v);
      else next.delete(k);
    });
    return next;
  };
  const select = (id) => setParams(withParams({ chat: id }));
  const back = () => setParams(withParams({ chat: null }));
  // 换号筛选时关掉当前会话，避免右边显示一个列表里没有的会话
  const onFilter = (id) => setParams(withParams({ account: id, chat: null }), { replace: true });

  const conv = convs?.find((c) => c.id === selectedId) || null;
  const noConnected = Array.isArray(accounts) && !accounts.some(isConnected);
  const pending = (convs || []).filter((c) => c.needsHuman).length;

  const onConvUpdate = (next) => {
    setConvs((prev) => (prev || []).map((c) => (c.id === next.id ? { ...c, ...next } : c)));
  };

  const onSent = (msg) => {
    if (msg && msg.id) {
      setMessages((prev) => {
        const list = prev || [];
        return list.some((m) => m.id === msg.id) ? list : [...list, msg];
      });
    }
    if (conv) {
      onConvUpdate({
        ...conv,
        botPaused: true,
        draft: null, // 人工发出任何消息都会清空草稿（F2a）
        // 文件消息 text 为空，预览和后端一样显示"[文件] 文件名"（F15）
        lastMessage: msg
          ? { text: msg.text || (msg.attachment ? `[文件] ${msg.attachment.filename}` : ''), direction: 'out', ts: msg.ts }
          : conv.lastMessage,
        updatedAt: msg?.ts || conv.updatedAt,
      });
    }
  };

  const infoShown = wide ? infoPinned : infoDrawer;
  const toggleInfo = () => (wide ? setInfoPinned((v) => !v) : setInfoDrawer((v) => !v));
  const showColumn = wide && infoPinned && !!conv;

  const accountOptions = [
    { value: '', label: '全部号码' },
    ...(accounts || []).map((a) => ({ value: a.id, label: a.name || '未命名号码' })),
  ];

  return (
    <div className={`page page--fill inbox-page${selectedId ? ' has-selection' : ''}`}>
      <PageHeader
        title="会话"
        meta={pending > 0 && <StatusDot tone="danger" tinted size="sm">{pending} 个待你处理</StatusDot>}
        actions={
          accounts?.length > 0 && (
            <Select
              size="sm"
              className="select--auto"
              value={accountFilter}
              onChange={onFilter}
              options={accountOptions}
              placement="bottom-end"
              aria-label="按号筛选"
            />
          )
        }
      />
      {convError && convs == null ? (
        <ErrorState title="会话加载失败" error={convError} onRetry={loadConvs} />
      ) : (
        <div className={`inbox${showColumn ? ' inbox--with-info' : ''}`}>
          <ConvList
            convs={convs}
            selectedId={selectedId}
            onSelect={select}
            pollFailed={pollFailed && convs != null}
            noConnected={noConnected}
            accountFilter={accountFilter}
          />
          {selectedId ? (
            <ChatPane
              key={selectedId}
              conv={conv}
              convId={selectedId}
              messages={messages}
              msgError={msgError}
              onBack={back}
              onConvUpdate={onConvUpdate}
              onSent={onSent}
              onRetry={() => loadMessages(selectedId)}
              canSaveToKb={isAdmin}
              onToggleInfo={toggleInfo}
              infoShown={infoShown}
            />
          ) : (
            <section className="inbox__chat inbox__chat--empty">
              <EmptyState fill icon={MessagesSquare} title="选择一个会话" desc="在左侧选择会话，查看消息记录并手动回复。" />
            </section>
          )}
          {showColumn && (
            <aside className="inbox__info" aria-label="客户信息">
              <CustomerInfo key={conv.id} conv={conv} />
            </aside>
          )}
        </div>
      )}
      {!wide && conv && (
        <Drawer open={infoDrawer} onClose={() => setInfoDrawer(false)} title="客户信息" size="narrow">
          <CustomerInfo key={conv.id} conv={conv} />
        </Drawer>
      )}
    </div>
  );
}
