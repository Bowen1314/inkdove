import path from 'node:path';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { decodeText, normalizeText } from '../util.js';

/** 扩展名 → 规范类型 */
const EXT_KIND = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.pptx': 'pptx',
  '.csv': 'csv',
  '.txt': 'txt',
  '.md': 'md',
  '.markdown': 'md',
  '.html': 'html',
  '.htm': 'html',
};

const MIME_KIND = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
};

export const KIND_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
};

/**
 * @param {string} filename
 * @param {string} [mime]
 * @returns {string|null}
 */
export function detectKind(filename, mime) {
  const ext = path.extname(filename || '').toLowerCase();
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_KIND[m] || null;
}

/** HTML → {title, text}（去掉脚本、样式、导航等） */
export function htmlToText(html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  $('script, style, noscript, template, svg, iframe, nav, footer, header form, [aria-hidden="true"]').remove();
  const blocks = 'p, div, section, article, li, tr, h1, h2, h3, h4, h5, h6, br, dt, dd, blockquote, pre, td, th, table';
  $(blocks).each((_, el) => {
    $(el).append('\n');
  });
  const root = $('body').length ? $('body') : $.root();
  const text = root
    .text()
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text: normalizeText(text) };
}

async function parsePdf(buf) {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function parseXlsx(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    if (csv.trim()) parts.push(`## ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

export const UNSUPPORTED_MESSAGE = '不支持的文件类型（支持 pdf、docx、xlsx、xls、pptx、csv、txt、md、html）';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return XML_ENTITIES[e.toLowerCase()] ?? '';
  });
}

/** pptx：按页序取每页（和备注）里的 <a:t> 文字 */
async function parsePptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slideNo = (name) => Number(/(\d+)\.xml$/.exec(name)?.[1] || 0);
  const pick = (re) =>
    Object.keys(zip.files)
      .filter((n) => re.test(n))
      .sort((a, b) => slideNo(a) - slideNo(b));
  const textOf = async (name) => {
    const xml = await zip.file(name).async('string');
    return xml
      .split(/<\/a:p>/)
      .map((p) => [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join(''))
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  };
  const parts = [];
  for (const name of pick(/^ppt\/slides\/slide\d+\.xml$/)) {
    const t = await textOf(name);
    if (t) parts.push(`## 第 ${slideNo(name)} 页\n${t}`);
  }
  for (const name of pick(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)) {
    const t = await textOf(name);
    if (t) parts.push(`## 备注 ${slideNo(name)}\n${t}`);
  }
  return parts.join('\n\n');
}

/**
 * 解析文件为纯文本。失败抛错（中文信息）。
 * @param {Buffer} buf
 * @param {string} kind
 */
export async function parseBuffer(buf, kind) {
  let text;
  switch (kind) {
    case 'pdf':
      text = await parsePdf(buf);
      break;
    case 'docx':
      text = (await mammoth.extractRawText({ buffer: buf })).value;
      break;
    case 'xlsx':
    case 'xls':
      text = parseXlsx(buf);
      break;
    case 'pptx':
      text = await parsePptx(buf);
      break;
    case 'csv':
    case 'txt':
    case 'md':
      text = decodeText(buf);
      break;
    case 'html':
      text = htmlToText(decodeText(buf)).text;
      break;
    default:
      throw new Error(UNSUPPORTED_MESSAGE);
  }
  text = normalizeText(text);
  if (!text) throw new Error(kind === 'pdf' ? '没有提取到文字（可能是扫描版 PDF）' : '没有提取到文字');
  return text;
}
