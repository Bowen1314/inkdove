import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Ban, BellRing, ChevronDown, ChevronUp, FileText, RotateCcw, SendHorizontal } from 'lucide-react';
import { api } from '../../api/client.js';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { EntryRefs } from '../../ui/EntryRefs.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { EmptyState, Spinner } from '../../ui/common.jsx';
import { ASK_DECISION } from '../../lib/labels.js';

const SAMPLES = ['你们的营业时间是？', '最低起订量是多少？', '我要找人工客服', '帮我写一段 Python 代码'];

/** 兼容旧返回（confident/handoff）推出 decision */
function decisionOf(res) {
  if (res?.decision && ASK_DECISION[res.decision]) return res.decision;
  if (res?.handoff || res?.confident === false) return 'handoff';
  return 'replied';
}

/**
 * 测试对话的状态放在知识库页上：切换标签、面板在侧栏和抽屉之间切换时对话不丢。
 * turns: {id, role:'customer'|'bot', text, meta?, failed?}
 */
export function useTestChat() {
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const busyRef = useRef(false);
  const seqRef = useRef(0);

  /** 发出一条客户消息；空消息或上一条还在等回复时不发 */
  const send = async (raw) => {
    const message = String(raw ?? '').trim();
    if (!message || busyRef.current) return;
    // history 格式 {role, text}；不带发送失败的消息，也不带未回复时的空 reply（真实场景下不会发给客户）
    const history = turnsRef.current.filter((t) => !t.failed && t.text).map((t) => ({ role: t.role, text: t.text }));
    const id = ++seqRef.current;
    setTurns((prev) => [...prev, { id, role: 'customer', text: message }]);
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.ask(message, history);
      setTurns((prev) => [...prev, { id: ++seqRef.current, role: 'bot', text: res?.reply || '', meta: res || {} }]);
    } catch {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, failed: true } : t)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const retry = (turn) => {
    const rest = turnsRef.current.filter((t) => t.id !== turn.id);
    turnsRef.current = rest;
    setTurns(rest);
    send(turn.text);
  };

  const clear = () => setTurns([]);

  return { turns, busy, send, retry, clear };
}

/** 面板头部的"清空对话"图标按钮 */
export function TestChatClear({ chat }) {
  if (chat.turns.length === 0) return null;
  return (
    <Tooltip content="清空对话">
      <button type="button" className="btn btn--ghost btn--icon" onClick={chat.clear} aria-label="清空对话" disabled={chat.busy}>
        <RotateCcw />
      </button>
    </Tooltip>
  );
}

function BotTurn({ turn }) {
  const [open, setOpen] = useState(false);
  const m = turn.meta || {};
  const ids = m.usedEntryIds || [];
  const decision = decisionOf(m);
  const d = ASK_DECISION[decision];
  const replied = decision === 'replied';
  const files = Array.isArray(m.sendFileIds) ? m.sendFileIds : [];
  const fileNames = Array.isArray(m.sendFiles) ? m.sendFiles.map((f) => f?.name).filter(Boolean) : [];

  return (
    <div className="kb-test__turn kb-test__turn--bot">
      {replied ? (
        <div className="kb-test__bubble">{turn.text || <span className="muted">（空回复）</span>}</div>
      ) : (
        <div className="kb-test__bubble kb-test__bubble--decision">
          <div className="kb-test__decision">
            {decision === 'offtopic' ? <Ban aria-hidden="true" /> : <BellRing aria-hidden="true" />}
            <span>{decision === 'offtopic' ? '离题：不回复，也不通知' : '拿不准：不会回复客户，会通知你'}</span>
          </div>
          <div className="kb-test__reason">
            <span className="muted">原因</span>
            <span>{m.reason || '未提供'}</span>
          </div>
        </div>
      )}
      {files.length > 0 && (
        <div className="kb-test__files">
          <FileText aria-hidden="true" />
          <span>将发送文件：{fileNames.length ? fileNames.join('、') : `${files.length} 个`}</span>
        </div>
      )}
      <div className="kb-test__meta">
        <StatusDot tone={d.tone} size="sm" tinted={decision === 'handoff' || decision === 'blocked'}>
          {d.label}
        </StatusDot>
        {typeof m.latencyMs === 'number' && <span className="num">{(m.latencyMs / 1000).toFixed(1)} 秒</span>}
        {(ids.length > 0 || replied) && (
          <button type="button" className="kb-test__link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            依据 {ids.length} 条知识
            {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
        )}
      </div>
      {replied && m.reason && <div className="kb-test__note">{m.reason}</div>}
      {open && (
        <div className="kb-test__refs">
          <EntryRefs ids={ids} />
        </div>
      )}
    </div>
  );
}

/** 测试对话的消息区和输入框。外层（侧栏或抽屉）负责标题和关闭。输入框的内容留在这里，打字时不重绘整个知识库页。 */
export default function TestChat({ chat, autoFocus = false }) {
  const { turns, busy, send, retry } = chat;
  const [input, setInput] = useState('');
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  // 自动增高，最多 6 行
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 12)}px`;
  }, [input]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (!input.trim() || busy) return;
    setInput('');
    send(input);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="kb-test">
      <div className="kb-test__list" ref={listRef} aria-live="polite">
        {turns.length === 0 ? (
          <EmptyState
            compact
            fill
            title="扮演客户提问"
            desc="不会发到 WhatsApp，只用于检查知识库是否够用。试试这些问题："
            action={
              <div className="kb-test__samples">
                {SAMPLES.map((s) => (
                  <button key={s} type="button" className="btn btn--sm" onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            }
          />
        ) : (
          turns.map((t) =>
            t.role === 'bot' ? (
              <BotTurn key={t.id} turn={t} />
            ) : (
              <div key={t.id} className={`kb-test__turn kb-test__turn--customer${t.failed ? ' is-failed' : ''}`}>
                <div className="kb-test__bubble">{t.text}</div>
                {t.failed && (
                  <div className="kb-test__meta">
                    <span className="text-danger">没有收到回复</span>
                    <button type="button" className="kb-test__link" onClick={() => retry(t)} disabled={busy}>
                      重试
                    </button>
                  </div>
                )}
              </div>
            ),
          )
        )}
        {busy && (
          <div className="kb-test__turn kb-test__turn--bot">
            <div className="kb-test__bubble kb-test__bubble--typing">
              <Spinner /> 正在思考…
            </div>
          </div>
        )}
      </div>

      <div className="kb-test__compose">
        <div className="kb-test__composer">
          <textarea
            ref={inputRef}
            className="kb-test__input"
            rows={1}
            placeholder="输入客户会发的消息"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="测试消息"
          />
          <div className="kb-test__bar">
            <span className="kb-test__hint">Enter 发送 · Shift+Enter 换行</span>
            <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={!input.trim() || busy}>
              {busy ? <Spinner /> : <SendHorizontal />}
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
