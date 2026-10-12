import { Tooltip } from './Popover.jsx';
import { fmtDay, fmtFull, fmtHm } from '../lib/format.js';

/** 表格里的时间（DESIGN 第 8 节）：今天显示 10:42，往前显示 昨天 / 10月3日 / 2025年10月3日，悬停看完整时间 */
export function TimeText({ iso }) {
  const full = fmtFull(iso);
  if (!full) return <span className="muted">—</span>;
  const day = fmtDay(iso);
  return (
    <Tooltip content={full}>
      <span className="nowrap num">{day === '今天' ? fmtHm(iso) : day}</span>
    </Tooltip>
  );
}
