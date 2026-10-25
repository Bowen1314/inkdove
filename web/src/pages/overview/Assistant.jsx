import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, History, MessagesSquare, RotateCcw, SendHorizontal, SquarePen, Trash2, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtFull, fmtShortTime } from '../../lib/format.js';
import { Callout, EmptyState, Spinner } from '../../ui/common.jsx';
import { useConfirm } from '../../ui/Modal.jsx';
import { Popover, Tooltip } from '../../ui/Popover.jsx';
import { EntryChip, FileChip } from '../../ui/RefPreview.jsx';
import { EntryPeek } from '../../ui/EntryRefs.jsx';
import { Markdown } from './markdown.jsx';

// 概览页上的 AI 助手：问系统里的数据（今天的数字、待处理的客户、线索、知识库和产品资料……），只查不改。
// 提问后服务端在后台查，这里每秒轮询那条消息，显示「正在查：…」的进度，答完显示 Markdown 回答，
// 回答里提到的会话、知识条目、文件是可点的小标签。对话只有本人看得到；当前打开的对话记在这个标签页里，刷新后接着显示。

const SAMPLES = ['今天有多少新客户', '还有哪些客户待处理', '我们 P600 的交期和起订量是多少'];
const POLL_MS = 1000;
const POLL_MAX_MS = 10_000;
const CURRENT_KEY = 'inkdove.assistant.chat';

const chatLink = (id) => `/whatsapp/chats?${new URLSearchParams({ chat: id })}`;

function remember(id) {
  try {
    if (id) sessionStorage.setItem(CURRENT_KEY, id);
    else sessionStorage.removeItem(CURRENT_KEY);
  } catch {
    /* 存不了就算了，只是刷新后不接着显示 */
  }
}
function remembered() {
  try {
    return sessionStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

/** 提问、重试失败时显示的话 */
function askErrorText(err, isAdmin) {
  if (err?.code === 'llm_not_configured') return isAdmin ? '未配置 AI 模型，助手不可用' : '管理员未配置 AI 模型，助手暂不可用';
  return err?.message || '提问失败，请重试';
}

/** 回答里的一个引用：会话跳到会话页，条目和文件悬停（手机上点一下）看预览 */
function RefChip({ r, onPeek }) {
  if (r.kind === 'conversation') {
    if (!r.available) {
      return (
        <span className="ref-chip is-muted">
          <MessagesSquare aria-hidden="true" />
          <span className="ref-chip__name">无权限查看的会话</span>
        </span>
      );
    }
    return (
      <Link to={chatLink(r.id)} className="ref-chip">
        <MessagesSquare aria-hidden="true" />
        <span className="ref-chip__name">{r.name}</span>
        {r.accountName && <span className="ref-chip__meta">{r.accountName}</span>}
      </Link>
    );
  }
  if (r.kind === 'entry') return <EntryChip id={r.id} entry={r.entry ?? null} onOpenFull={onPeek} />;
  if (r.kind === 'file') return <FileChip file={r.file ?? null} />;
  return null;
}

/** 查询进度：每一步一行，还没有步骤时「正在思考…」，步骤都查完了「正在整理回答…」 */
function Steps({ steps, running }) {
  const pending = running && steps.every((s) => s.status !== 'running');
  return (
    <ul className="ov-assistant__steps">
      {steps.map((s, k) => (
        <li key={k} className={`ov-assistant__step is-${s.status}`}>
          {s.status === 'running' ? <Spinner /> : s.status === 'error' ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
          <span>
            {s.label}
            {s.status === 'error' && <span className="sr-only">（未查到）</span>}
          </span>
        </li>
      ))}
      {pending && (
        <li className="ov-assistant__step is-running">
          <Spinner />
          <span>{steps.length ? '整理回答中…' : '思考中…'}</span>
        </li>
      )}
    </ul>
  );
}

function Turn({ m, canRetry, retrying, onRetry, onPeek, isAdmin }) {
  const refs = new Map((m.refs || []).map((r) => [r.key, r]));
  const renderRef = (key) => {
    const r = refs.get(key);
    return r ? (
      <span className="ov-md__ref">
        <RefChip r={r} onPeek={onPeek} />
      </span>
    ) : null;
  };
  const showSettings = isAdmin && ['tools_unsupported', 'llm_error'].includes(m.errorCode);
  return (
    <li className="ov-assistant__turn">
      <div className="ov-assistant__q" title={fmtFull(m.createdAt)}>
        {m.question}
      </div>
      <div className="ov-assistant__a">
        {m.status === 'done' && <Markdown text={m.answer} renderRef={renderRef} />}
        {m.status === 'running' && <Steps steps={m.steps || []} running />}
        {m.status === 'failed' && (
          <>
            {m.steps?.length > 0 && <Steps steps={m.steps} running={false} />}
            <Callout
              tone="danger"
              action={
                (showSettings || canRetry) && (
                  <div className="ov-assistant__error-actions">
                    {showSettings && (
                      <Link to="/settings" className="btn btn--link">
                        前往设置
                      </Link>
                    )}
                    {canRetry && (
                      <button type="button" className="btn btn--sm" onClick={onRetry} disabled={retrying}>
                        {retrying ? <Spinner /> : <RotateCcw />}
                        重试
                      </button>
                    )}
                  </div>
                )
              }
            >
              {m.error || '回答失败，请重试'}
            </Callout>
          </>
        )}
      </div>
    </li>
  );
}

/** 「最近的对话」：点标题打开，右边的按钮删除 */
function HistoryButton({ chats, currentId, onOpen, onDelete }) {
  return (
    <Popover
      label="最近的对话"
      placement="bottom-end"
      tooltip="最近的对话"
      trigger={
        <button type="button" className="btn btn--ghost btn--icon" aria-label="最近的对话">
          <History />
        </button>
      }
    >
      {(close) =>
        chats === null ? (
          <div className="hstack muted text-sm">
            <Spinner /> 加载中…
          </div>
        ) : chats.length === 0 ? (
          <div className="muted text-sm">暂无对话</div>
        ) : (
          <ul className="ov-assistant__history">
            {chats.map((c) => (
              <li key={c.id} className={`ov-assistant__history-item${c.id === currentId ? ' is-current' : ''}`}>
                <button
                  type="button"
                  className="ov-assistant__history-open"
                  aria-current={c.id === currentId ? 'true' : undefined}
                  onClick={() => {
                    close();
                    onOpen(c.id);
                  }}
                >
                  <span className="ellipsis">{c.title}</span>
                  <span className="muted text-sm nowrap" title={fmtFull(c.updatedAt)}>
                    {fmtShortTime(c.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  aria-label={`删除对话：${c.title}`}
                  onClick={() => {
                    close();
                    onDelete(c);
                  }}
                >
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
        )
      }
    </Popover>
  );
}

export default function Assistant() {
  const { isAdmin } = useAuth();
  const confirm = useConfirm();
  const [chats, setChats] = useState(null);
  const [usage, setUsage] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingChat, setLoadingChat] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [askError, setAskError] = useState(null);
  const [peek, setPeek] = useState(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const openSeq = useRef(0);

  const refreshList = useCallback(async () => {
    try {
      const r = await api.assistantChats({ silent: true });
      setChats(r.chats || []);
      setUsage(r.usage || null);
    } catch {
      setChats((c) => c || []);
    }
  }, []);

  const startNew = useCallback(() => {
    openSeq.current++;
    setLoadingChat(false);
    setChatId(null);
    setMessages([]);
    setChatError(null);
    setAskError(null);
    remember(null);
  }, []);

  const openChat = useCallback(
    async (id) => {
      const seq = ++openSeq.current;
      setChatId(id);
      setMessages([]);
      setChatError(null);
      setAskError(null);
      setLoadingChat(true);
      remember(id);
      try {
        const r = await api.assistantChat(id, { silent: true });
        if (seq === openSeq.current) setMessages(r.messages || []);
      } catch (e) {
        if (seq !== openSeq.current) return;
        if (e?.status === 404) startNew();
        else setChatError(e);
      } finally {
        if (seq === openSeq.current) setLoadingChat(false);
      }
    },
    [startNew],
  );

  useEffect(() => {
    refreshList();
    const id = remembered();
    if (id) openChat(id);
  }, [refreshList, openChat]);

  const replaceMessage = useCallback((m) => setMessages((list) => list.map((x) => (x.id === m.id ? m : x))), []);

  // 轮询还在查的那条（同一个人同时只有一个问题在查）
  const runningId = messages.find((m) => m.status === 'running')?.id || null;
  useEffect(() => {
    if (!chatId || !runningId) return undefined;
    let alive = true;
    let timer;
    let delay = POLL_MS;
    const tick = async () => {
      try {
        const m = await api.assistantMessage(chatId, runningId, { silent: true });
        if (!alive) return;
        replaceMessage(m);
        delay = POLL_MS;
        if (m.status !== 'running') {
          refreshList();
          return;
        }
      } catch (e) {
        if (!alive) return;
        if (e?.status === 404) return;
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [chatId, runningId, replaceMessage, refreshList]);

  // 有新问题、进度或回答时滚到底
  const last = messages[messages.length - 1];
  const scrollKey = `${messages.length}:${last?.status}:${last?.steps?.length || 0}`;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollKey]);

  // 输入框自动增高，最多 6 行
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 12)}px`;
  }, [input]);

  const busy = sending || !!runningId;

  const ask = async (raw) => {
    const question = String(raw ?? '').trim();
    if (!question || busy) return;
    setSending(true);
    setAskError(null);
    try {
      const r = await api.assistantAsk({ question, chatId }, { silent: true });
      if (r.chat.id === chatId) setMessages((list) => [...list, r.message]);
      else {
        openSeq.current++;
        setLoadingChat(false);
        setChatError(null);
        setChatId(r.chat.id);
        setMessages([r.message]);
        remember(r.chat.id);
      }
      setInput('');
      refreshList();
    } catch (e) {
      setAskError(e);
    } finally {
      setSending(false);
    }
  };

  const retry = async () => {
    if (!chatId || busy) return;
    setRetrying(true);
    setAskError(null);
    try {
      replaceMessage(await api.assistantRetry(chatId, { silent: true }));
      refreshList();
    } catch (e) {
      setAskError(e);
    } finally {
      setRetrying(false);
    }
  };

  const removeChat = async (c) => {
    const ok = await confirm({ title: '删除该对话？', message: `「${c.title}」删除后无法恢复。`, danger: true, confirmText: '删除' });
    if (!ok) return;
    try {
      await api.assistantDeleteChat(c.id);
    } catch {
      return;
    }
    if (c.id === chatId) startNew();
    refreshList();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(input);
    }
  };

  const left = usage ? Math.max(0, usage.limit - usage.used) : null;
  const lastId = last?.id;

  let body;
  if (loadingChat) {
    body = (
      <div className="ov-assistant__state muted">
        <Spinner /> 加载中…
      </div>
    );
  } else if (chatError) {
    body = (
      <div className="ov-assistant__state">
        <span className="text-danger">对话加载失败：{chatError.message}</span>
        <button type="button" className="btn btn--sm" onClick={() => openChat(chatId)}>
          <RotateCcw /> 重新加载
        </button>
      </div>
    );
  } else if (!messages.length) {
    body = (
      <EmptyState
        compact
        title="查询系统数据"
        desc="支持查询会话、客户、线索、知识库和产品资料；只读，不修改数据、不发送消息。"
        action={
          <div className="ov-assistant__samples">
            {SAMPLES.map((s) => (
              <button key={s} type="button" className="btn btn--sm" onClick={() => ask(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        }
      />
    );
  } else {
    body = (
      <ol className="ov-assistant__turns" aria-live="polite">
        {messages.map((m) => (
          <Turn
            key={m.id}
            m={m}
            isAdmin={isAdmin}
            canRetry={m.id === lastId && !runningId && !sending}
            retrying={retrying}
            onRetry={retry}
            onPeek={setPeek}
          />
        ))}
      </ol>
    );
  }

  return (
    <section className="card card--flush span-12 ov-assistant" aria-labelledby="ov-assistant-title">
      <div className="card__head">
        <h2 className="card__title" id="ov-assistant-title">
          AI 助手
        </h2>
        <div className="ov-assistant__actions">
          <Tooltip content="新对话">
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              aria-label="新对话"
              onClick={() => {
                startNew();
                inputRef.current?.focus();
              }}
              disabled={!chatId && !messages.length}
            >
              <SquarePen />
            </button>
          </Tooltip>
          <HistoryButton chats={chats} currentId={chatId} onOpen={openChat} onDelete={removeChat} />
        </div>
      </div>

      <div className="ov-assistant__body" ref={listRef}>
        {body}
      </div>

      <div className="ov-assistant__compose">
        {askError && (
          <Callout
            tone="danger"
            action={
              isAdmin &&
              askError.code === 'llm_not_configured' && (
                <Link to="/settings" className="btn btn--link">
                  前往设置
                </Link>
              )
            }
          >
            {askErrorText(askError, isAdmin)}
          </Callout>
        )}
        <div className="ov-assistant__composer">
          <textarea
            ref={inputRef}
            className="ov-assistant__input"
            rows={1}
            maxLength={2000}
            placeholder="输入问题，例如：本周哪些客户询问了报价？"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="向 AI 助手提问"
          />
          <div className="ov-assistant__bar">
            <span className="ov-assistant__hint">
              Enter 发送 · Shift+Enter 换行
              {left !== null && (
                <>
                  {' · '}
                  <span className={left === 0 ? 'text-danger' : undefined}>今日剩余 {left} 次</span>
                </>
              )}
            </span>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => ask(input)} disabled={!input.trim() || busy}>
              {busy ? <Spinner /> : <SendHorizontal />}
              发送
            </button>
          </div>
        </div>
      </div>

      <EntryPeek entryId={peek} onClose={() => setPeek(null)} />
    </section>
  );
}
