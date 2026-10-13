import { Fragment, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { hitSegments, notifyBlockwordAck, onBlockwordAck } from '../lib/blockwords.js';
import { fmtFull } from '../lib/format.js';
import { blockwordResult, blockwordSourceLabel, blockwordWho, conductLabel } from '../lib/labels.js';
import { Spinner } from './common.jsx';
import { Modal } from './Modal.jsx';
import { StatusDot } from './StatusDot.jsx';
import { toast } from './toastBus.js';

/** 原文，命中的地方标红（ranges 是服务端给的 [开始, 结束)） */
export function BlockwordText({ text, ranges }) {
  return (
    <div className="blockword-text">
      {hitSegments(text, ranges).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="blockword-mark">
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </div>
  );
}

/** 命中的词，一个一个列出来 */
export function BlockwordWords({ words }) {
  return (
    <span className="blockword-words">
      {(words || []).map((w) => (
        <span key={w} className="tag tag--danger">
          {w}
        </span>
      ))}
    </span>
  );
}

/** 号和会话（外联任务没有会话，写任务名） */
export function blockwordWhere(h) {
  const parts = [h.accountName || '', h.contactName || (h.campaignName ? `外联任务「${h.campaignName}」` : '')].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

// 点了右上角关闭（或 Esc、点遮罩）的提醒：这个标签页里先不弹，刷新页面（或换个标签页打开）后还会弹，直到有人点「知道了」
const hidden = new Set();

/**
 * 屏蔽词提醒（只给管理员，Layout 里挂一个）：每 5 秒取一次还没处理的命中，有就弹窗，一次显示一条（最早的）。
 * 「知道了」记成已处理，别的管理员就不再弹；「打开会话」先记成已处理再跳到会话。登录后进来先取一次，没处理的照样弹。
 * AI 发言检查发现的严重问题也走这里（轻微的服务端不给，只在设置页的记录里）：写问题和说明，不写屏蔽词，多一个「误报」。
 */
export function BlockwordAlerts() {
  const navigate = useNavigate();
  const [data, setData] = useState(null); // {total, items}
  const [, setHiddenTick] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setData(await api.getBlockwordAlerts({ silent: true }));
  }, []);

  usePolling(load, 5000, true, { immediate: true });
  // 设置页的命中记录里点了「知道了」：马上重新取，不等下一轮
  useEffect(() => onBlockwordAck(() => load().catch(() => {})), [load]);

  const items = (data?.items || []).filter((h) => !hidden.has(h.id));
  const hit = items[0];
  if (!hit) return null;
  const more = Math.max(0, (data.total || 0) - 1);
  const result = blockwordResult(hit);
  const isAi = hit.detector === 'ai';

  /** 「知道了」（falsePositive 时是「误报」，同时算处理了）；thenOpen：处理完打开会话 */
  const ack = async (thenOpen, falsePositive = false) => {
    if (busy) return;
    setBusy(true);
    try {
      if (falsePositive) await api.falsePositiveBlockwordHit(hit.id, { silent: true });
      else await api.ackBlockwordHit(hit.id, { silent: true });
    } catch (e) {
      // 记录已经不在了（404）也当作处理过；别的错误提示一下，弹窗留着
      if (e?.status !== 404) {
        toast.error(e?.message || '操作失败，请重试');
        setBusy(false);
        return;
      }
    }
    setData((d) => (d ? { total: Math.max(0, d.total - 1), items: d.items.filter((x) => x.id !== hit.id) } : d));
    setBusy(false);
    notifyBlockwordAck();
    if (thenOpen) navigate(`/whatsapp/chats?chat=${encodeURIComponent(hit.conversationId)}`);
  };

  const close = () => {
    hidden.add(hit.id);
    setHiddenTick((n) => n + 1);
  };

  return (
    <Modal
      open
      title={isAi ? 'AI 发言检查：发现严重问题' : '发现屏蔽词'}
      onClose={close}
      width={560}
      footer={
        <>
          {more > 0 && <span className="blockword-alert__more muted">还有 {more} 条</span>}
          {isAi && (
            <button type="button" className="btn" onClick={() => ack(false, true)} disabled={busy}>
              误报
            </button>
          )}
          {hit.conversationId && (
            <button type="button" className="btn" onClick={() => ack(true)} disabled={busy}>
              打开会话
            </button>
          )}
          <button type="button" className="btn btn--primary" onClick={() => ack(false)} disabled={busy}>
            {busy && <Spinner />}
            知道了
          </button>
        </>
      }
    >
      <dl className="blockword-alert">
        <dt>谁</dt>
        <dd>
          {blockwordWho(hit)}
          <span className="muted"> · {blockwordSourceLabel(hit.source)}</span>
        </dd>
        <dt>号和会话</dt>
        <dd>{blockwordWhere(hit)}</dd>
        <dt>时间</dt>
        <dd className="num">{fmtFull(hit.ts)}</dd>
        {isAi ? (
          <>
            <dt>问题</dt>
            <dd>{conductLabel(hit)}</dd>
            <dt>说明</dt>
            <dd>{hit.reason || '—'}</dd>
          </>
        ) : (
          <>
            <dt>屏蔽词</dt>
            <dd>
              <BlockwordWords words={hit.words} />
            </dd>
          </>
        )}
        <dt>结果</dt>
        <dd>
          <StatusDot tone={result.tone} wrap>
            {result.label}
          </StatusDot>
        </dd>
      </dl>
      <BlockwordText text={hit.text} ranges={hit.ranges} />
    </Modal>
  );
}
