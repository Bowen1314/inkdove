import { Fragment, useMemo } from 'react';

// 助手回答用的 Markdown，只认一小部分：段落和换行、无序和有序列表、表格、代码块、行内代码、粗体、斜体。
// 全部生成 React 元素，不用 dangerouslySetInnerHTML：回答里的 HTML 标签按原文显示，不会执行。
// 链接只显示文字、不生成 <a>（回答可能带着客户消息里的链接，不让人顺手点开）；标题按一行粗体显示。
// [[c1]]、[[e2]]、[[f3]] 这类引用标记交给 renderRef(key) 换成小标签，返回 null 就去掉。

/** 行内：`代码`、**粗体**、[[c1]]（也认 [[c1, e2]]）、[文字](地址)、*斜体* */
const INLINE =
  /(`[^`\n]+`)|(\*\*(?=\S)[^\n]+?\*\*)|(\[\[\s*[cef]\d{1,4}(?:\s*[,，、]\s*[cef]\d{1,4})*\s*\]\])|(\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))*)\))|(\*(?=\S)[^*\n]+?\*)/g;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function listItem(line) {
  const o = line.match(ORDERED);
  if (o) return { ordered: true, start: Number(o[1]), text: o[2] };
  const b = line.match(BULLET);
  if (b) return { ordered: false, text: b[1] };
  return null;
}

const isTableRow = (line) => line.includes('|') && line.trim() !== '';
const isTableStart = (lines, i) => isTableRow(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || !!listItem(line) || isTableStart(lines, i);
}

/**
 * 文字 → 块：{type:'p', lines} | {type:'heading', text} | {type:'ul'|'ol', items, start?} | {type:'table', head, rows} | {type:'code', text} | {type:'hr'}
 * @param {string} src
 */
export function parseBlocks(src) {
  const lines = String(src || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows: rows.map((r) => head.map((_, k) => r[k] ?? '')) });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', text: heading[1] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    const first = listItem(line);
    if (first) {
      const items = [];
      while (i < lines.length) {
        const cur = listItem(lines[i]);
        if (cur && cur.ordered === first.ordered) {
          items.push(cur.text);
          i++;
        } else if (!cur && /^\s{2,}\S/.test(lines[i])) {
          // 缩进的续行接在上一项后面
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push(first.ordered ? { type: 'ol', items, start: first.start } : { type: 'ul', items });
      continue;
    }
    const para = [line.replace(/^\s{0,3}>\s?/, '')];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
    blocks.push({ type: 'p', lines: para });
  }
  return blocks;
}

/** 一行文字里的行内格式 → React 节点数组 */
function inline(text, ctx, depth = 0) {
  const out = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `i${ctx.seq++}`;
    const nest = (s) => (depth < 3 ? inline(s, ctx, depth + 1) : s);
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{nest(m[2].slice(2, -2))}</strong>);
    else if (m[3]) {
      const keys = m[3].replace(/[[\]\s]/g, '').split(/[,，、]/);
      out.push(<Fragment key={key}>{keys.map((k) => <Fragment key={k}>{ctx.renderRef(k)}</Fragment>)}</Fragment>);
    }
    else if (m[4]) out.push(<Fragment key={key}>{nest(m[5])}</Fragment>);
    else if (m[7]) out.push(<em key={key}>{nest(m[7].slice(1, -1))}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 多行文字：行内格式，行和行之间换行 */
function lines(text, ctx) {
  return String(text)
    .split('\n')
    .map((l, k) => (
      <Fragment key={`l${k}`}>
        {k > 0 && <br />}
        {inline(l, ctx)}
      </Fragment>
    ));
}

function renderBlock(b, k, ctx) {
  switch (b.type) {
    case 'heading':
      return (
        <p key={k} className="ov-md__heading">
          {inline(b.text, ctx)}
        </p>
      );
    case 'hr':
      return <hr key={k} />;
    case 'code':
      return (
        <pre key={k} className="ov-md__code">
          <code>{b.text}</code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={k}>
          {b.items.map((it, j) => (
            <li key={j}>{lines(it, ctx)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={k} start={b.start !== 1 ? b.start : undefined}>
          {b.items.map((it, j) => (
            <li key={j}>{lines(it, ctx)}</li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <div key={k} className="ov-md__table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} scope="col">
                    {inline(c, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, n) => (
                    <td key={n}>{inline(c, ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p key={k}>{lines(b.lines.join('\n'), ctx)}</p>;
  }
}

const noRef = () => null;

/** 显示一段 Markdown。renderRef(key) 把 [[c1]] 这类标记换成元素，不给就去掉 */
export function Markdown({ text, renderRef = noRef, className = '' }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const ctx = { seq: 0, renderRef };
  return <div className={`ov-md${className ? ` ${className}` : ''}`}>{blocks.map((b, k) => renderBlock(b, k, ctx))}</div>;
}
