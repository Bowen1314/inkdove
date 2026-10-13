// 操作日志里的「改了哪些字段」：比较接口改动前后从库里读出来的对象（不看请求体），每个变了的字段一项
// {field, label, from?, to?, note?, secret?}。
// - 密钥类（字段说明里是 secret，或者字段名像密钥：password、secret、token、apiKey、订阅链接……）只记「已设置 / 已修改 / 已清空」，
//   不记值；以后新加的字段没写说明时也按名字兜底；
// - 长文本（kind: text）只记字数；列表（kind: list）记前几项和个数；复杂结构（kind: json）只记改了；
// - 其余的值截到 VALUE_MAX 个字；像网址的去掉账号密码、查询参数和像令牌的长路径段。

/** 普通字段的值最多记多少字 */
export const VALUE_MAX = 80;
/** 一条日志最多记多少个字段 */
export const MAX_CHANGES = 60;

/** 字段名像密钥的一律不记值 */
const SECRET_KEY_RE = /pass(word|phrase)?$|passwd|secret|token|api_?key|access_?key|key$|credential|private|cookie|authorization|subscri|sub_?(url|link)|signature/i;

/** 字段名（路径的最后一段）是不是像密钥 */
export const looksSecret = (key) => SECRET_KEY_RE.test(String(key));

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const charCount = (s) => [...String(s ?? '')].length;

/** 按字符截断，截掉的加省略号 */
export function clipText(s, n = VALUE_MAX) {
  const chars = [...String(s ?? '')];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

/**
 * 网址只留协议、主机和不像令牌的路径：去掉账号密码，查询参数和 # 后面换成 …，长度 ≥ 16 的路径段换成 …（订阅链接、带令牌的地址）。
 * 不是网址的原样返回。
 */
export function safeUrl(s) {
  const str = String(s);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(str.trim())) return str;
  try {
    const u = new URL(str.trim());
    const pathPart = u.pathname
      .split('/')
      .map((seg) => (seg.length >= 16 ? '…' : seg))
      .join('/');
    return `${u.protocol}//${u.host}${pathPart === '/' ? '' : pathPart}${u.search || u.hash ? '?…' : ''}`;
  } catch {
    return str.replace(/\/\/[^/@\s]*@/, '//…@').replace(/[?#].*$/, '?…');
  }
}

/** 一段文字里的网址都按 safeUrl 处理（错误信息里可能带着带令牌的地址） */
export const scrubUrls = (s) => String(s ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>，。；、）)]+/gi, (u) => safeUrl(u));

/** 一个普通值的显示文字 */
export function showValue(v, spec = {}) {
  if (v === undefined || v === null || v === '') return spec.empty ?? '（空）';
  if (spec.values && Object.prototype.hasOwnProperty.call(spec.values, String(v))) return spec.values[String(v)];
  if (typeof v === 'boolean') return v ? spec.on ?? '开' : spec.off ?? '关';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return clipText(safeUrl(v).replace(/\s+/g, ' ').trim(), VALUE_MAX);
  return clipText(JSON.stringify(v), VALUE_MAX);
}

/** 列表的显示文字：前几项用顿号连起来，太长时截断并写上一共几个 */
function showList(list, spec) {
  const items = (Array.isArray(list) ? list : []).map((x) => (spec.item ? spec.item(x) : showValue(x)));
  if (!items.length) return spec.empty ?? '（空）';
  const joined = items.join('、');
  return charCount(joined) <= VALUE_MAX ? joined : `${clipText(joined, VALUE_MAX - 8)} 等 ${items.length} 个`;
}

/** 密钥的变化：从空到有是已设置，从有到空是已清空，否则已修改 */
function secretNote(a, b) {
  const has = (v) => v !== undefined && v !== null && v !== '';
  if (!has(a)) return '已设置';
  if (!has(b)) return '已清空';
  return '已修改';
}

const same = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 一个字段的变化（没变返回 null）。
 * spec：{label, kind?: 'secret'|'text'|'list'|'json', values?, on?, off?, empty?, item?, count?}
 */
export function fieldChange(field, a, b, spec = {}) {
  if (same(a, b)) return null;
  const label = spec.label || field;
  const key = field.split('.').pop();
  if (spec.kind === 'secret' || (spec.kind === undefined && looksSecret(key))) {
    return { field, label, secret: true, note: secretNote(a, b) };
  }
  if (spec.kind === 'text') {
    const n1 = charCount(a);
    const n2 = charCount(b);
    const note = !n1 ? `已填写（${n2} 字）` : !n2 ? '已清空' : `已修改（${n1} 字 → ${n2} 字）`;
    return { field, label, note };
  }
  if (spec.kind === 'list' || (spec.kind === undefined && (Array.isArray(a) || Array.isArray(b)) && [a, b].every((v) => v == null || (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object'))))) {
    const la = Array.isArray(a) ? a : [];
    const lb = Array.isArray(b) ? b : [];
    const added = lb.filter((x) => !la.includes(x)).length;
    const removed = la.filter((x) => !lb.includes(x)).length;
    const parts = [added && `新增 ${added} 个`, removed && `移除 ${removed} 个`].filter(Boolean);
    return { field, label, from: showList(la, spec), to: showList(lb, spec), ...(parts.length ? { note: parts.join('，') } : {}) };
  }
  const isObj = (v) => v !== null && typeof v === 'object';
  if (spec.kind === 'json' || (spec.kind === undefined && (isObj(a) || isObj(b)))) {
    const count = spec.count ? `（${spec.count(a)} → ${spec.count(b)}）` : '';
    return { field, label, note: `已修改${count}` };
  }
  const from = showValue(a, spec);
  const to = showValue(b, spec);
  // 显示出来一样（比如网址只改了里面的密码、或者截断后看不出区别）：只记改了
  if (from === to) return { field, label, note: '已修改' };
  return { field, label, from, to };
}

/**
 * 逐个字段比较两个对象（嵌套的普通对象一层层往下比），返回变了的字段。
 * specOf(path) 给出字段说明（没有说明的按值的类型和字段名兜底，标签就是路径）；
 * skip 里的路径（及其下面的）不比较；说明里 kind 是 list / json / secret / text 的不再往下拆。
 * @param {any} a 改之前
 * @param {any} b 改之后
 * @param {{specOf?: (path:string) => any, skip?: string[], prefix?: string}} [o]
 */
export function diffObjects(a, b, { specOf = () => undefined, skip = [], prefix = '' } = {}) {
  const out = [];
  const keys = [...new Set([...Object.keys(isPlain(a) ? a : {}), ...Object.keys(isPlain(b) ? b : {})])];
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (skip.includes(path)) continue;
    const va = isPlain(a) ? a[k] : undefined;
    const vb = isPlain(b) ? b[k] : undefined;
    const spec = specOf(path);
    if (!spec?.kind && !looksSecret(k) && (isPlain(va) || isPlain(vb))) {
      out.push(...diffObjects(va, vb, { specOf, skip, prefix: path }));
      continue;
    }
    const c = fieldChange(path, va, vb, spec);
    if (c) out.push(c);
  }
  return out.slice(0, MAX_CHANGES);
}

/** 按字段表比较（只比表里列出的字段）：fields 是 [[字段, 说明]] */
export function diffFields(a, b, fields) {
  const out = [];
  for (const [field, spec] of fields) {
    const c = fieldChange(field, a?.[field], b?.[field], spec);
    if (c) out.push(c);
  }
  return out;
}
