import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MoreHorizontal, RefreshCcw, Sparkles } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { useConfirm } from '../../ui/Modal.jsx';
import { Spinner } from '../../ui/common.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { HintIcon, Menu } from '../../ui/Popover.jsx';

/** 资料的整理状态：待整理数、可用数、一句状态 */
export function distillSummary(sources) {
  const pending = (sources || []).filter((s) => s.status === 'ready' && !s.distilledAt).length;
  const readyCount = (sources || []).filter((s) => s.status === 'ready').length;
  const text =
    sources == null
      ? '蒸馏知识库'
      : pending > 0
        ? `${pending} 份资料待蒸馏`
        : readyCount > 0
          ? '资料已全部蒸馏'
          : '暂无可蒸馏的资料';
  return { pending, readyCount, text };
}

/**
 * 开始蒸馏 / 全部重建（admin）。DistillBar 和「知识库 → 整理」页头共用。
 * sources 不传时自己拉一次资料列表来算待整理数量；reload() 重新拉。
 */
export function useDistillActions(sourcesProp) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [own, setOwn] = useState(null);
  const [distilling, setDistilling] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (sourcesProp !== undefined) return undefined;
    let alive = true;
    api
      .listSources({ silent: true })
      .then((list) => alive && setOwn(list || []))
      .catch(() => alive && setOwn([]));
    return () => {
      alive = false;
    };
  }, [sourcesProp, reloadKey]);

  const sources = sourcesProp !== undefined ? sourcesProp : own;

  const start = async (distillMode) => {
    if (distillMode === 'rebuild') {
      const ok = await confirm({
        title: '全部重建知识库？',
        message:
          '将清空自动蒸馏的条目和未处理缺口并重新生成；手动添加、补充回答和来自会话的条目保留。资料较多时耗时数分钟，期间机器人仍按现有条目回复。',
        confirmText: '确定重建',
        danger: true,
      });
      if (!ok) return;
    }
    setDistilling(distillMode);
    try {
      const res = await api.startDistill({ mode: distillMode });
      toast.success(distillMode === 'rebuild' ? '已开始重建知识库' : '已开始蒸馏知识库');
      navigate(res?.jobId ? `/kb/distill?job=${encodeURIComponent(res.jobId)}` : '/kb/distill');
    } catch (e) {
      if (e.code === 'job_running') navigate('/kb/distill');
    } finally {
      setDistilling(null);
    }
  };

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { sources, distilling, start, reload, ...distillSummary(sources) };
}

/** 圆点 + 一句状态 + 说明问号 */
export function DistillStatus({ pending, text }) {
  return (
    <span className="kb-distillbar__status">
      <StatusDot tone={pending > 0 ? 'warning' : 'neutral'}>{text}</StatusDot>
      <HintIcon label="什么是蒸馏">将资料提炼为条目，并找出客户可能提问但资料中无答案的问题。</HintIcon>
    </span>
  );
}

/**
 * 整理状态条（admin），放在「文件 → 知识库资料」的表格上方。
 * 一行：圆点 + 一句状态 + 右边一个按钮（有新资料时"开始蒸馏"，旁边的更多菜单里是"全部重建"；都整理过时只有"全部重建"）。
 * showSourcesLink：显示"管理资料"链接，方便跳回文件页。
 */
export function DistillBar({ sources: sourcesProp, showSourcesLink = false }) {
  const { sources, distilling, start, pending, readyCount, text } = useDistillActions(sourcesProp);
  // 还没有任何资料时不显示，表格的空状态已经在引导上传
  if (sources && sources.length === 0) return null;

  return (
    <div className="kb-distillbar">
      <DistillStatus pending={pending} text={text} />
      <div className="kb-distillbar__actions">
        {showSourcesLink && (
          <Link to="/files/sources" className="btn btn--link btn--muted btn--sm">
            管理资料
          </Link>
        )}
        {pending > 0 ? (
          <>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => start('incremental')} disabled={!!distilling}>
              {distilling === 'incremental' ? <Spinner /> : <Sparkles />}
              开始蒸馏
            </button>
            <Menu
              minWidth={160}
              tooltip="更多蒸馏操作"
              trigger={
                <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="更多蒸馏操作" disabled={!!distilling}>
                  <MoreHorizontal />
                </button>
              }
              items={[{ label: '全部重建', icon: RefreshCcw, onClick: () => start('rebuild') }]}
            />
          </>
        ) : (
          readyCount > 0 && (
            <button type="button" className="btn btn--sm" onClick={() => start('rebuild')} disabled={!!distilling}>
              {distilling === 'rebuild' ? <Spinner /> : <RefreshCcw />}
              全部重建
            </button>
          )
        )}
      </div>
    </div>
  );
}
