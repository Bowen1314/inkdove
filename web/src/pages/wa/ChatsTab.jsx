import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookPlus,
  Check,
  CornerDownLeft,
  Image as ImageIcon,
  Languages,
  ListChecks,
  MessagesSquare,
  Mic,
  PanelRight,
  Pause,
  Play,
  RefreshCw,
  Search,
  SendHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from '../../api/client.js';
import { EmptyState, ErrorState, PageHeader, Segmented, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { Avatar } from '../../ui/Avatar.jsx';
import { Select } from '../../ui/Select.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { Popover, Tooltip } from '../../ui/Popover.jsx';
import { useConfirm } from '../../ui/Modal.jsx';
import { toast } from '../../ui/toastBus.js';
import { EntryPeek, EntryRefs } from '../../ui/EntryRefs.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { useAuth } from '../../lib/auth.jsx';
import { isConnected, useAccounts } from '../../lib/accounts.js';
import { setPendingCount } from '../../lib/inboxCount.js';
import {
  AUTHOR_LABEL,
  BOT_DECISION_NOTE,
  LEAD_STAGES,
  MEDIA_LABEL,
  leadStageLabel,
  replyModeOf,
  suggestErrorText,
} from '../../lib/labels.js';
import { fmtDay, fmtHm, fmtShortTime, fmtTime } from '../../lib/format.js';
import { SaveToKbModal } from './SaveToKbModal.jsx';
import { AttachmentCard, DraftFiles, SendFileButton, sendFilesInOrder } from './ChatFiles.jsx';
import {
  AssigneeMark,
  AssigneeSelect,
  AssigneeText,
  AssignmentHistory,
  BulkAssignBar,
  assigneeFilterOptions,
} from './Assignee.jsx';

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

/**
 * 会话状态。showActive（会话头部）时，没有别的状态也显示一句：自动回复的号是"机器人接待中"，
 * 人工回复的号不显示。replyMode 不知道（号已删除、还没拿到号列表）时按旧样子显示
 */
function ConvState({ conv, size = 'sm', showActive = false, replyMode = null }) {
  if (conv.needsHuman) return <StatusDot tone="danger" tinted size={size}>待你处理</StatusDot>;
  if (conv.botPaused) return <StatusDot tone="warning" tinted size={size}>人工接管中</StatusDot>;
  const mute = activeMute(conv);
  if (mute) return <StatusDot tone="neutral" muted size={size}>反复离题，静默到 {fmtMuteUntil(mute)}</StatusDot>;
  if (!showActive || replyMode === 'off') return null;
  return <StatusDot tone="success" muted size={size}>机器人接待中</StatusDot>;
}

/** 待回复：最后一条消息是客户发的（纯前端判断，导入的历史消息也算） */
export const isWaiting = (c) => c?.lastMessage?.direction === 'in';

/* ---------- 会话列表 ---------- */

/** 列表为空时的标题：业务员只看得到分给自己的会话；admin 按负责人筛选时说明是哪种空 */
function emptyTitle({ isAdmin, accountFilter, assigneeFilter }) {
  if (!isAdmin) return accountFilter ? '这个号还没有分配给你的客户' : '管理员还没有给你分配客户';
  if (assigneeFilter === 'none') return '没有未分配的会话';
  if (assigneeFilter) return '这个成员还没有负责的会话';
  return accountFilter ? '这个号还没有会话' : '还没有会话';
}

const VIEW_OPTIONS = (waitingCount) => [
  { value: '', label: '全部' },
  { value: 'waiting', label: waitingCount > 0 ? `待回复 ${waitingCount}` : '待回复' },
];

function ConvList({
  convs,
  selectedId,
  onSelect,
  pollFailed,
  noConnected,
  accountFilter,
  assigneeFilter,
  view,
  onView,
  isAdmin,
  users,
  onBulkAssigned,
}) {
  const [filter, setFilter] = useState('');
  const [selecting, setSelecting] = useState(false); // admin 批量分配的多选模式
  const [checked, setChecked] = useState(() => new Set());
  const sorted = useMemo(() => sortConvs(convs), [convs]);
  const waitingCount = sorted.filter(isWaiting).length;
  const f = filter.trim().toLowerCase();
  const shown = sorted.filter(
    (c) =>
      (view !== 'waiting' || isWaiting(c)) &&
      (!f || [c.contactName, c.contactNumber, c.id, c.accountName].some((v) => String(v || '').toLowerCase().includes(f))),
  );

  // 只算还在列表里的（轮询后消失的会话不再算进去）
  const checkedIds = sorted.filter((c) => checked.has(c.id)).map((c) => c.id);
  const allChecked = shown.length > 0 && shown.every((c) => checked.has(c.id));
  const someChecked = shown.some((c) => checked.has(c.id));
  const toggleOne = (id) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      shown.forEach((c) => (allChecked ? next.delete(c.id) : next.add(c.id)));
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setChecked(new Set());
  };

  return (
    <section className="inbox__list" aria-label="会话列表">
      {selecting && (
        <div className="inbox__list-head">
          <BulkAssignBar
            ids={checkedIds}
            allChecked={allChecked}
            someChecked={someChecked}
            onToggleAll={toggleAll}
            users={users}
            onCancel={stopSelecting}
            onAssigned={(ids, assignee) => {
              setChecked(new Set());
              onBulkAssigned(ids, assignee);
            }}
          />
        </div>
      )}
      <div className="inbox__list-head inbox__list-head--search">
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
        {isAdmin && !selecting && (
          <Tooltip content="批量分配">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => setSelecting(true)}
              disabled={!sorted.length}
              aria-label="批量分配"
            >
              <ListChecks />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="inbox__list-head inbox__list-head--view">
        <Segmented label="按回复状态筛选" options={VIEW_OPTIONS(waitingCount)} value={view} onChange={onView} />
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
            title={emptyTitle({ isAdmin, accountFilter, assigneeFilter })}
            desc={
              !isAdmin || assigneeFilter ? null : noConnected ? (
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
          <EmptyState compact title={view === 'waiting' && !f ? '没有待回复的会话' : '没有匹配的会话'} />
        ) : (
          shown.map((c) => {
            const last = c.lastMessage;
            const active = c.id === selectedId;
            const isChecked = selecting && checked.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={`conv${active ? ' is-active' : ''}${c.needsHuman ? ' is-pending' : ''}${isChecked ? ' is-checked' : ''}`}
                aria-current={active ? 'true' : undefined}
                aria-pressed={selecting ? isChecked : undefined}
                onClick={() => (selecting ? toggleOne(c.id) : onSelect(c.id))}
              >
                {selecting && (
                  <span className="conv__check" aria-hidden="true">
                    {isChecked && <Check />}
                  </span>
                )}
                <Avatar name={c.contactName || c.contactNumber} />
                <span className="conv__body">
                  <span className="conv__top">
                    <span className="conv__name">{convName(c)}</span>
                    <span className="conv__time">{fmtShortTime(last?.ts || c.updatedAt)}</span>
                  </span>
                  <span className="conv__row">
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
                    {isWaiting(c) && (
                      <StatusDot tone="info" tinted size="sm" className="conv__waiting">
                        待回复
                      </StatusDot>
                    )}
                  </span>
                  <span className="conv__meta">
                    <ConvState conv={c} />
                    {isAdmin && <AssigneeMark assignee={c.assignee} />}
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

/** 条目弹窗放在浮层外面：点条目时先关浮层再开弹窗，免得两层叠在一起、在弹窗上按鼠标被当成点了浮层外面 */
function KnowledgeRefs({ ids }) {
  const [peek, setPeek] = useState(null);
  return (
    <>
      <Popover
        label="依据的知识条目"
        trigger={
          <button type="button" className="msg__link">
            依据 {ids.length} 条知识
          </button>
        }
      >
        {(close) => (
          <EntryRefs
            ids={ids}
            onOpen={(id) => {
              close();
              setPeek(id);
            }}
          />
        )}
      </Popover>
      <EntryPeek entryId={peek} onClose={() => setPeek(null)} />
    </>
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
            {msg.decisionReason && msg.decisionReason !== note ? ` · ${msg.decisionReason}` : ''}
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

/** 推荐回复和草稿里要人拍板的占位：【待你确认：…】 */
const TODO_RE = /【待你确认[^】]*】/g;
const countTodos = (t) => (String(t || '').match(TODO_RE) || []).length;

/** 文字里的【待你确认：…】高亮显示 */
function TodoText({ text }) {
  const parts = String(text || '').split(/(【待你确认[^】]*】)/);
  return parts.map((p, i) =>
    i % 2 ? (
      <mark key={i} className="draft__todo">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

/** 输入框里光标之后的下一处【待你确认】（没有就从头找）→ [start, end] 或 null */
function nextTodoRange(text, from = 0) {
  const all = [...String(text || '').matchAll(TODO_RE)].map((m) => [m.index, m.index + m[0].length]);
  if (!all.length) return null;
  return all.find(([start]) => start >= from) || all[0];
}

/**
 * 草稿：输入框上方显示，"填入输入框"后由人工修改再发。kind 是 suggest 的是推荐回复，handoff（老数据没有 kind）是转人工时起草的。
 * 「换一条」调 POST suggest 让 AI 换个写法（转人工草稿也可以换，换出来的是推荐回复）。
 * F15：草稿可以只带文件（text 为空、fileIds 有值），文件列在文字下面，旁边"发送这些文件"按顺序逐个发。
 * kept：草稿已被自己发的消息清掉（后端规则），只剩前端记住的文件建议；这时不显示文字，可以手动关掉。
 */
function DraftBox({ draft, kept, onFill, onSendFiles, sendingFiles, onDismiss, onRegenerate, regenerating }) {
  const text = !kept && draft?.text?.trim() ? draft.text : '';
  const fileIds = kept ? kept.fileIds : Array.isArray(draft?.fileIds) ? draft.fileIds : [];
  if (!text && !fileIds.length) return null;
  const isSuggest = !kept && draft?.kind === 'suggest';
  const title = kept ? '草稿建议发送的文件（还没发）' : isSuggest ? '推荐回复' : '建议回复（草稿，未发送）';
  return (
    <div className="draft" aria-busy={regenerating || undefined}>
      <div className="draft__head">
        <Sparkles aria-hidden="true" />
        <span className="draft__title">{title}</span>
        <span className="draft__actions">
          {!kept && (
            <Tooltip content="让 AI 换一种写法">
              <button type="button" className="btn btn--ghost btn--sm" onClick={onRegenerate} disabled={regenerating}>
                {regenerating ? <Spinner /> : <RefreshCw />}
                换一条
              </button>
            </Tooltip>
          )}
          {text && (
            <button type="button" className="btn btn--sm" onClick={() => onFill(text)} disabled={regenerating}>
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
        </span>
      </div>
      {text && (
        <div className="draft__text">
          <TodoText text={text} />
        </div>
      )}
      {fileIds.length > 0 && <DraftFiles fileIds={fileIds} onSend={onSendFiles} sending={sendingFiles} />}
    </div>
  );
}

/**
 * 输入框。showSuggest：没有可填的草稿时，底栏多一个「推荐回复」按钮手动要一条。
 * 文字里还有【待你确认：…】时底栏提示还有几处（点一下选中下一处），发送前再用确认框拦一次。
 */
function Composer({ conv, text, setText, onSent, inputRef, showSuggest, onSuggest, suggesting, suggestBlocked }) {
  const confirm = useConfirm();
  const [sending, setSending] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [status, setStatus] = useState(''); // 翻译完成后在底栏左侧短暂显示
  const textRef = useRef(text);
  textRef.current = text;
  const todos = countTodos(text);

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

  /** 选中输入框里光标后面的下一处【待你确认】，直接打字就能替换掉 */
  const selectTodo = (fromStart = false) => {
    const el = inputRef.current;
    if (!el) return;
    const range = nextTodoRange(el.value, fromStart ? 0 : el.selectionEnd ?? 0);
    el.focus();
    if (range) el.setSelectionRange?.(range[0], range[1]);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending || translating) return;
    const left = countTodos(t);
    if (left > 0) {
      const ok = await confirm({
        title: `还有 ${left} 处【待你确认】没填`,
        message: '消息里还留着【待你确认：…】，发出去客户会原样看到。建议先改好再发。',
        confirmText: '照样发送',
        cancelText: '回去修改',
        danger: true,
        focusCancel: true,
      });
      if (!ok) {
        setTimeout(() => selectTodo(true), 0);
        return;
      }
    }
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
        {todos > 0 && !status ? (
          <button type="button" className="composer__hint composer__hint--todo" onClick={() => selectTodo()}>
            还有 {todos} 处【待你确认】没填，点这里定位
          </button>
        ) : (
          <span className={`composer__hint${status ? ' composer__hint--status' : ''}`} aria-live="polite">
            {status || `Enter 发送 · Shift+Enter 换行${conv.botPaused ? '' : ' · 手动发送后机器人会暂停这个会话'}`}
          </span>
        )}
        {showSuggest && (
          <Tooltip content={suggestBlocked || '让 AI 读上下文起草一条推荐回复，不会直接发出'}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onSuggest}
              disabled={suggesting || !!suggestBlocked}
              aria-label={suggestBlocked ? `推荐回复（${suggestBlocked}）` : undefined}
            >
              {suggesting ? <Spinner /> : <Sparkles />}
              推荐回复
            </button>
          </Tooltip>
        )}
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

      <AssignmentHistory conv={conv} />
    </div>
  );
}

/* ---------- 会话窗口 ---------- */

function ChatPane({
  conv,
  convId,
  messages,
  msgError,
  onBack,
  onConvUpdate,
  onSent,
  onRetry,
  canSaveToKb,
  isAdmin,
  users,
  replyMode,
  onToggleInfo,
  infoShown,
}) {
  const [toggling, setToggling] = useState(false);
  const [text, setText] = useState('');
  const [kbMsg, setKbMsg] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  // 手动要来的推荐回复 {draft, seen}。服务端一般会存进会话，但起草期间我方已经发了消息时只返回不存，
  // 轮询拿到的 conv.draft 里就没有它；所以先在这里留一份，直到服务端出了更新的草稿、或者存过之后又被清掉、或者自己发了消息
  const [manual, setManual] = useState(null);
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

  const serverDraft = conv?.draft || null;
  const serverAt = serverDraft?.createdAt || '';
  const manualAt = manual?.draft?.createdAt || '';
  // 显示哪份草稿：服务端的和手动要来的，谁新显示谁；服务端存过手动那份（seen）之后又清掉了，就不再显示
  let liveDraft = serverDraft;
  if (manual) {
    if (!serverDraft) liveDraft = manual.seen ? null : manual.draft;
    else if (serverAt !== manualAt) liveDraft = serverAt > manualAt ? serverDraft : manual.draft;
  }
  useEffect(() => {
    if (!manual) return;
    if (serverDraft && serverAt === manualAt) {
      if (!manual.seen) setManual((m) => (m ? { ...m, seen: true } : m));
    } else if ((serverDraft && serverAt > manualAt) || (!serverDraft && manual.seen)) {
      setManual(null);
    }
  }, [manual, serverDraft, serverAt, manualAt]);
  const liveFileIds = Array.isArray(liveDraft?.fileIds) ? liveDraft.fileIds : [];
  // 服务端出了新草稿（createdAt 不同）就以新草稿为准；同一份草稿（轮询拿到旧数据）仍按已清掉显示
  const kept = keptFiles && (!liveDraft || liveDraft.createdAt === keptFiles.draftAt) ? keptFiles : null;
  const liveDraftAt = liveDraft?.createdAt;
  useEffect(() => {
    if (liveDraftAt !== undefined) setKeptFiles((prev) => (prev && prev.draftAt !== liveDraftAt ? null : prev));
  }, [liveDraftAt]);

  /** 自己发出消息或文件：先记住草稿里的文件建议，发出去的那个文件从里面去掉；手动要来的推荐也作废 */
  const handleSent = (msg) => {
    setManual(null);
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
      if (conv.botPaused) setManual(null); // 恢复机器人会清掉草稿
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

  /** 手动要一条推荐回复（「推荐回复」「换一条」）：同步等 AI 起草完，结果显示在输入框上方，不会自动发出 */
  const requestSuggest = async () => {
    if (!conv || suggesting) return;
    setSuggesting(true);
    try {
      const res = await api.suggestReply(conv.id);
      if (!aliveRef.current) return;
      const d = res?.draft;
      if (d && (d.text?.trim() || d.fileIds?.length)) {
        setManual({ draft: { ...d, kind: d.kind || 'suggest' }, seen: false });
        setKeptFiles(null);
      } else {
        toast.error('AI 这次没写出推荐回复，请再试一次');
      }
    } catch (e) {
      if (e?.status !== 401) toast.error(suggestErrorText(e, isAdmin));
    } finally {
      if (aliveRef.current) setSuggesting(false);
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
  // 会话里一条客户消息都没有时，服务端会回 no_customer_message，按钮先置灰
  const noCustomerMsg = Array.isArray(messages) && !messages.some((m) => m.direction === 'in');

  return (
    <section className="inbox__chat" aria-label={`和 ${name} 的会话`}>
      <div className={`chat-head${isAdmin && conv ? ' chat-head--assign' : ''}`}>
        <button type="button" className="btn btn--ghost btn--icon chat-head__back" onClick={onBack} aria-label="返回会话列表">
          <ArrowLeft />
        </button>
        <Avatar name={conv?.contactName || conv?.contactNumber || convId} />
        <div className="chat-head__info">
          <div className="chat-head__name">{name}</div>
          <div className="chat-head__sub">
            {conv?.contactNumber && conv.contactName && <span className="num">{conv.contactNumber}</span>}
            {conv?.accountName && <span className="chat-head__acct">经 {conv.accountName}</span>}
            {conv && !isAdmin && <AssigneeText assignee={conv.assignee} />}
            {conv && <ConvState conv={conv} showActive replyMode={replyMode} />}
          </div>
        </div>
        {conv && (
          <div className="chat-head__actions">
            {isAdmin && <AssigneeSelect conv={conv} users={users} onAssigned={onConvUpdate} />}
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
            draft={liveDraft}
            kept={kept}
            onFill={fillDraft}
            onSendFiles={sendDraftFiles}
            sendingFiles={sendingFiles}
            onDismiss={() => setKeptFiles(null)}
            onRegenerate={requestSuggest}
            regenerating={suggesting}
          />
          <Composer
            conv={conv}
            text={text}
            setText={setText}
            onSent={handleSent}
            inputRef={inputRef}
            showSuggest={!(!kept && liveDraft?.text?.trim())}
            onSuggest={requestSuggest}
            suggesting={suggesting}
            suggestBlocked={noCustomerMsg ? '客户还没发过消息' : ''}
          />
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
  const { user: me, isAdmin } = useAuth();
  // 按负责人筛选只有 admin 有；agent 只看得到分给自己的会话，不带这个参数
  const assigneeFilter = isAdmin ? params.get('assignee') || '' : '';
  // 「全部 / 待回复」：纯前端按最后一条消息是不是客户发的筛，不重新请求
  const view = params.get('view') === 'waiting' ? 'waiting' : '';
  const { accounts } = useAccounts();
  const wide = useMediaQuery('(min-width: 1280px)');
  const [infoPinned, setInfoPinned] = useState(true); // ≥1280 时右栏是否显示
  const [infoDrawer, setInfoDrawer] = useState(false); // 更窄时用抽屉

  const [convs, setConvs] = useState(null);
  const [convError, setConvError] = useState(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [messages, setMessages] = useState(null);
  const [msgError, setMsgError] = useState(null);
  const [users, setUsers] = useState(null); // 负责人选项（admin）
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const filterRef = useRef(null);
  filterRef.current = { account: accountFilter, assignee: assigneeFilter };

  const loadConvs = useCallback(async () => {
    const want = filterRef.current;
    try {
      const list = await api.listConversations(
        { accountId: want.account || undefined, assignee: want.assignee || undefined },
        { silent: true },
      );
      // 筛选已切换，丢弃旧结果
      if (filterRef.current.account !== want.account || filterRef.current.assignee !== want.assignee) return;
      setConvs(list || []);
      if (!want.account && !want.assignee) setPendingCount(list || []);
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
  }, [loadConvs, accountFilter, assigneeFilter]);

  // 成员列表只有 admin 能读，agent 不请求
  useEffect(() => {
    if (!isAdmin) return;
    api
      .listUsers({ silent: true })
      .then((list) => setUsers(Array.isArray(list) ? list : []))
      .catch(() => setUsers([]));
  }, [isAdmin]);

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
  const onAssigneeFilter = (v) => setParams(withParams({ assignee: v, chat: null }), { replace: true });
  // 切换「待回复」不关掉当前会话：回复完它会从待回复里消失，右边照样留着
  const onView = (v) => setParams(withParams({ view: v }), { replace: true });

  // 当前会话改了负责人后可能不在这个筛选里了（比如在「未分配」里分给了别人），右边继续用最后拿到的数据
  const heldRef = useRef(null);
  const found = convs?.find((c) => c.id === selectedId) || null;
  if (found) heldRef.current = found;
  else if (heldRef.current?.id !== selectedId) heldRef.current = null;
  const conv = found || heldRef.current;
  const noConnected = Array.isArray(accounts) && !accounts.some(isConnected);
  const pending = (convs || []).filter((c) => c.needsHuman).length;

  const onConvUpdate = (next) => {
    if (heldRef.current?.id === next.id) heldRef.current = { ...heldRef.current, ...next };
    setConvs((prev) => (prev || []).map((c) => (c.id === next.id ? { ...c, ...next } : c)));
  };

  /** 批量分配完：先把改成功的会话本地改掉，再重新拉列表 */
  const onBulkAssigned = (ids, assignee) => {
    const done = new Set(ids);
    if (heldRef.current && done.has(heldRef.current.id)) heldRef.current = { ...heldRef.current, assignee };
    setConvs((prev) => (prev || []).map((c) => (done.has(c.id) ? { ...c, assignee } : c)));
    loadConvs();
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
          (isAdmin || accounts?.length > 0) && (
            <>
              {isAdmin && (
                <Select
                  size="sm"
                  className="select--auto"
                  value={assigneeFilter}
                  onChange={onAssigneeFilter}
                  options={assigneeFilterOptions(users, me)}
                  placeholder="负责人"
                  placement="bottom-end"
                  aria-label="按负责人筛选"
                />
              )}
              {accounts?.length > 0 && (
                <Select
                  size="sm"
                  className="select--auto"
                  value={accountFilter}
                  onChange={onFilter}
                  options={accountOptions}
                  placement="bottom-end"
                  aria-label="按号筛选"
                />
              )}
            </>
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
            assigneeFilter={assigneeFilter}
            view={view}
            onView={onView}
            isAdmin={isAdmin}
            users={users}
            onBulkAssigned={onBulkAssigned}
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
              isAdmin={isAdmin}
              users={users}
              replyMode={conv ? replyModeOf(accounts?.find((a) => a.id === conv.accountId)) : null}
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
