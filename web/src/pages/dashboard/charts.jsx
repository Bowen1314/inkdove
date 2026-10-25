import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Tooltip } from '../../ui/Popover.jsx';
import { DECISION_LABELS } from '../../lib/labels.js';
import { fmtNum, fmtPct } from '../../lib/format.js';

/**
 * 看板的图表。不引图表库：每日趋势和时段热力图手写 SVG，按容器的实际像素宽度绘制（不靠 viewBox 缩放，窄屏文字不会变小）；
 * 排行、转人工原因、漏斗是"标签 + 细条 + 数字"的横向条形，用 HTML 画，长文字能省略、窄屏不挤。
 * 颜色只用 token：回复结果按 DESIGN 第 2 节（replied 绿、handoff 琥珀、blocked 红、offtopic 灰），其余用 --primary，亮暗主题自动跟随。
 */

/** 处理结果的固定配色，趋势图堆叠顺序从下到上 */
export const DECISION_SERIES = [
  { key: 'replied', label: DECISION_LABELS.replied, color: 'var(--success-dot)' },
  { key: 'handoff', label: DECISION_LABELS.handoff, color: 'var(--warning-dot)' },
  { key: 'blocked', label: DECISION_LABELS.blocked, color: 'var(--danger-dot)' },
  { key: 'offtopic', label: DECISION_LABELS.offtopic, color: 'var(--neutral-dot)' },
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 容器的像素宽度（ResizeObserver）。首帧前用 layout effect 量一次，避免先按 0 宽画一遍 */
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.clientWidth);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect?.width || 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** y 轴的刻度：0 到不小于 max 的整齐数，约 4 格，步长是 1、2、5 × 10^n 的整数 */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1, 2, 3, 4];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return ticks;
}

/** "2026-10-03" → {short:'10/3', long:'10月3日'}。直接切字符串，不走 new Date（会按 UTC 解析，东半球差一天） */
export function dateParts(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!m) return { short: String(date || ''), long: String(date || '') };
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return { short: `${mo}/${d}`, long: `${mo}月${d}日` };
}

/** 图例：圆点 + 名称 + 合计 */
export function Legend({ items }) {
  return (
    <ul className="dash-legend">
      {items.map((s) => (
        <li key={s.key} className="dash-legend__item">
          <span className="dash-legend__dot" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
          {s.value != null && <span className="dash-legend__value num">{s.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Tooltip 里的多行内容：标题 + 每行 圆点 名称 数字 */
function TipBody({ title, rows, foot }) {
  return (
    <div className="dash-tip">
      <div className="dash-tip__title">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="dash-tip__row">
          {r.color && <span className="dash-legend__dot" style={{ background: r.color }} aria-hidden="true" />}
          <span className="dash-tip__label">{r.label}</span>
          <span className="num">{r.value}</span>
        </div>
      ))}
      {foot && <div className="dash-tip__foot">{foot}</div>}
    </div>
  );
}

/**
 * 每日趋势：按处理结果堆叠的柱状图。data: [{date, replied, handoff, blocked, offtopic}]
 * 每一天是一个可聚焦的 <g>，悬停或键盘聚焦显示当天明细。series 换掉堆叠的几项（推荐回复的趋势用），label 是整张图的读屏名称
 */
export function TrendChart({ data, series = DECISION_SERIES, label: chartLabel = '每日处理结果' }) {
  const [ref, width] = useWidth();
  const rows = data.map((d) => {
    const vals = Object.fromEntries(series.map((s) => [s.key, num(d[s.key])]));
    const total = series.reduce((n, s) => n + vals[s.key], 0);
    return { date: d.date, ...dateParts(d.date), vals, total };
  });
  const max = Math.max(0, ...rows.map((r) => r.total));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];

  const H = 200;
  const padTop = 8;
  const padBottom = 24;
  const padLeft = 12 + String(fmtNum(top)).length * 7;
  const innerW = Math.max(0, width - padLeft);
  const innerH = H - padTop - padBottom;
  const n = rows.length || 1;
  const band = innerW / n;
  const barW = Math.max(2, Math.min(band * 0.62, 36));
  const y = (v) => padTop + innerH - (v / top) * innerH;
  // x 轴标签按可用宽度隔几天标一个，大约 44px 一个
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 44))));

  return (
    <div ref={ref} className="dash-chart">
      {width > 0 && (
        <svg width={width} height={H} className="dash-chart__svg" role="group" aria-label={chartLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padLeft} x2={width} y1={y(t)} y2={y(t)} className={t === 0 ? 'dash-chart__axis' : 'dash-chart__grid'} />
              <text x={padLeft - 8} y={y(t)} dy="0.32em" textAnchor="end" className="dash-chart__tick">
                {fmtNum(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const x0 = padLeft + i * band;
            const bx = x0 + (band - barW) / 2;
            let acc = 0;
            const label = `${r.long}：${series.map((s) => `${s.label} ${r.vals[s.key]}`).join('，')}`;
            return (
              <Tooltip
                key={r.date || i}
                content={
                  <TipBody
                    title={r.long}
                    rows={series.map((s) => ({ label: s.label, value: fmtNum(r.vals[s.key]), color: s.color }))}
                    foot={`合计 ${fmtNum(r.total)}`}
                  />
                }
              >
                <g className="dash-trend__band" tabIndex={0} role="img" aria-label={label}>
                  <rect x={x0} y={padTop} width={band} height={innerH} className="dash-trend__hit" />
                  {series.map((s) => {
                    const v = r.vals[s.key];
                    if (!v) return null;
                    const y1 = y(acc + v);
                    const h = y(acc) - y1;
                    acc += v;
                    return <rect key={s.key} x={bx} y={y1} width={barW} height={Math.max(0, h)} fill={s.color} />;
                  })}
                </g>
              </Tooltip>
            );
          })}
          {rows.map((r, i) =>
            i % every === 0 ? (
              <text
                key={`x-${r.date || i}`}
                x={padLeft + i * band + band / 2}
                y={H - 6}
                textAnchor="middle"
                className="dash-chart__tick"
              >
                {r.short}
              </text>
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const pad2 = (h) => String(h).padStart(2, '0');

/** heatmap 规范成 7 行 × 24 列的数字，缺的补 0 */
export function normalizeHeatmap(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  return Array.from({ length: 7 }, (_, d) => {
    const row = Array.isArray(rows[d]) ? rows[d] : [];
    return Array.from({ length: 24 }, (_, h) => num(row[h]));
  });
}

/**
 * 时段热力图：7 行（周一在第 0 行）× 24 列，统计入站消息。
 * 0 用 --bg-muted；有值的用 --primary，透明度按最大值线性取。悬停显示"周三 14:00–15:00 · N 条"。
 */
export function Heatmap({ grid }) {
  const [ref, width] = useWidth();
  const max = Math.max(0, ...grid.flat());
  const labelW = 36;
  const gap = 2;
  const cellW = Math.max(4, (width - labelW) / 24);
  const cellH = Math.min(Math.max(cellW, 14), 26);
  const axisH = 20;
  const H = 7 * cellH + axisH;
  // 小时标签：放得下就每 3 小时一个，不然每 6 小时
  const hourStep = cellW * 3 >= 40 ? 3 : 6;

  let busiest = null;
  grid.forEach((row, d) =>
    row.forEach((v, h) => {
      if (v > 0 && (!busiest || v > busiest.v)) busiest = { d, h, v };
    }),
  );
  const summary = busiest
    ? `时段热力图，消息最多的时段为${WEEKDAYS[busiest.d]} ${pad2(busiest.h)}:00，${busiest.v} 条客户消息`
    : '时段热力图';

  return (
    <div ref={ref} className="dash-chart">
      {width > 0 && (
        <svg width={width} height={H} className="dash-chart__svg" role="img" aria-label={summary}>
          {WEEKDAYS.map((w, d) => (
            <text key={w} x={0} y={d * cellH + cellH / 2} dy="0.32em" className="dash-chart__tick">
              {w}
            </text>
          ))}
          {grid.map((row, d) =>
            row.map((v, h) => (
              <Tooltip key={`${d}-${h}`} content={`${WEEKDAYS[d]} ${pad2(h)}:00–${pad2(h + 1 === 24 ? 0 : h + 1)}:00 · ${fmtNum(v)} 条`}>
                <rect
                  x={labelW + h * cellW + gap / 2}
                  y={d * cellH + gap / 2}
                  width={Math.max(1, cellW - gap)}
                  height={Math.max(1, cellH - gap)}
                  rx={2}
                  className={v > 0 ? 'dash-heat__cell' : 'dash-heat__cell dash-heat__cell--zero'}
                  fillOpacity={v > 0 ? 0.15 + 0.85 * (v / max) : undefined}
                />
              </Tooltip>
            )),
          )}
          {Array.from({ length: 24 / hourStep }, (_, i) => i * hourStep).map((h) => (
            <text key={h} x={labelW + h * cellW} y={H - 4} className="dash-chart__tick">
              {pad2(h)}:00
            </text>
          ))}
        </svg>
      )}
      <div className="dash-heat__legend" aria-hidden="true">
        <span>少</span>
        <span className="dash-heat__swatch dash-heat__swatch--zero" />
        {[0.25, 0.5, 0.75, 1].map((o) => (
          <span key={o} className="dash-heat__swatch" style={{ opacity: 0.15 + 0.85 * o }} />
        ))}
        <span>多</span>
        {max > 0 && <span className="dash-heat__max num">最多 {fmtNum(max)} 条 / 小时</span>}
      </div>
    </div>
  );
}

/**
 * 横向条形排行：每项一行"标签 …… 数字"，下面一条细条（按本组最大值）。
 * items: [{key, label, count, to?, tone?: 'warning'|'danger'|'success', note?}]；
 * 标签太长时省略，悬停 title 看全文。
 */
export function RankList({ items, label, unit = '' }) {
  const max = Math.max(0, ...items.map((it) => num(it.count)));
  return (
    <ol className="dash-rank" aria-label={label}>
      {items.map((it) => {
        const c = num(it.count);
        const text = String(it.label ?? '—');
        return (
          <li key={it.key} className="dash-rank__item">
            <div className="dash-rank__head">
              {it.to ? (
                <Link to={it.to} className="dash-rank__label dash-rank__label--link" title={text}>
                  {text}
                </Link>
              ) : (
                <span className="dash-rank__label" title={text}>
                  {text}
                </span>
              )}
              {it.note && <span className="dash-rank__note">{it.note}</span>}
              <span className="dash-rank__count num">
                {fmtNum(c)}
                {unit && <small>{unit}</small>}
              </span>
            </div>
            <div className="progress dash-rank__bar" aria-hidden="true">
              <div
                className={`progress__bar${it.tone ? ` progress__bar--${it.tone}` : ''}`}
                style={{ width: max > 0 ? `${Math.max(c > 0 ? 2 : 0, (c / max) * 100)}%` : 0 }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 漏斗：询价 → 要样品 → 议价 → 有下单意向。条长按第一阶段的人数，右边是"较上一阶段"的转化率。
 * steps: [{stage, label, reached}]（已按阶段顺序）
 */
export function Funnel({ steps }) {
  const first = num(steps[0]?.reached);
  return (
    <ol className="dash-funnel" aria-label="客户漏斗">
      {steps.map((s, i) => {
        const v = num(s.reached);
        const prev = i > 0 ? num(steps[i - 1].reached) : null;
        const rate = prev ? v / prev : null;
        return (
          <li key={s.stage} className="dash-funnel__row">
            <span className="dash-funnel__label">{s.label}</span>
            <div className="dash-funnel__track" aria-hidden="true">
              <div className="dash-funnel__fill" style={{ width: first > 0 ? `${Math.max(v > 0 ? 2 : 0, (v / first) * 100)}%` : 0 }} />
            </div>
            <span className="dash-funnel__num num">{fmtNum(v)}</span>
            <span className="dash-funnel__rate num">
              {i === 0 ? '' : rate == null ? '—' : fmtPct(rate)}
              {i > 0 && <span className="sr-only">（较上一阶段）</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
