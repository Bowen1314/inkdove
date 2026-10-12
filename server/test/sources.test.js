import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { htmlToText } from '../src/sources/parse.js';
import { isBlockedIp } from '../src/sources/fetch-url.js';
import { startApp } from './helpers.js';

/** 生成一个最小的、带 ASCII 文字的 PDF */
function makePdf(text) {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** 生成一个最小的 docx */
async function makeDocx(paragraphs) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makeXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['型号', '价格'], ['A100', '199 元'], ['B200', '299 元']]), '价目表');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('资料', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.login();
  });
  after(() => t.close());

  it('上传 txt/md/csv/docx/pdf/xlsx/html 都能解析；中文文件名保留', async () => {
    const fd = new FormData();
    fd.append('files', new Blob(['营业时间：每天 9:00-18:00\n\n地址：深圳市南山区']), '公司介绍.txt');
    fd.append('files', new Blob(['# 退换货政策\n\n收货 7 天内可无理由退货。']), 'policy.md');
    fd.append('files', new Blob(['﻿产品,价格\n保温杯,59 元\n水壶,89 元\n']), '价目.csv');
    fd.append('files', new Blob([await makeDocx(['起订量 100 件', '交期 15 天'])]), 'terms.docx');
    fd.append('files', new Blob([makePdf('Warranty: 12 months for all products')]), 'warranty.pdf');
    fd.append('files', new Blob([makeXlsx()]), 'prices.xlsx');
    fd.append('files', new Blob(['<html><head><title>关于我们</title><script>evil()</script></head><body><h1>欢迎</h1><p>支持海外发货</p></body></html>']), 'about.html');
    const r = await t.req('POST', '/api/sources/upload', { body: fd });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.length, 7);
    for (const s of r.body) {
      assert.equal(s.status, 'ready', `${s.name}: ${s.error}`);
      assert.equal(s.kind, 'file');
      assert.ok(s.chars > 0);
      assert.equal(s.distilledAt, null);
      assert.deepEqual(Object.keys(s).sort(), ['chars', 'createdAt', 'distilledAt', 'error', 'id', 'kind', 'mime', 'name', 'size', 'status']);
    }
    const byName = Object.fromEntries(r.body.map((s) => [s.name, s]));
    assert.ok(byName['公司介绍.txt'], '中文文件名');
    const preview = async (name) => (await t.req('GET', `/api/sources/${byName[name].id}`)).body.preview;
    assert.match(await preview('公司介绍.txt'), /营业时间/);
    assert.match(await preview('价目.csv'), /保温杯,59 元/);
    assert.match(await preview('terms.docx'), /起订量 100 件/);
    assert.match(await preview('warranty.pdf'), /Warranty: 12 months/);
    assert.match(await preview('prices.xlsx'), /A100,199 元/);
    const html = await preview('about.html');
    assert.match(html, /支持海外发货/);
    assert.doesNotMatch(html, /evil/);
  });

  it('解析失败也建记录，status=error', async () => {
    const fd = new FormData();
    fd.append('files', new Blob(['not a pdf at all']), 'broken.pdf');
    fd.append('files', new Blob([Buffer.from([0x4d, 0x5a, 0, 1])]), 'tool.exe');
    const r = await t.req('POST', '/api/sources/upload', { body: fd });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
    for (const s of r.body) {
      assert.equal(s.status, 'error');
      assert.ok(s.error);
      assert.equal(s.chars, 0);
    }
  });

  it('粘贴文本、列表倒序、删除', async () => {
    const created = await t.req('POST', '/api/sources/text', { body: { name: '补充说明', text: '付款方式：银行转账或支付宝' } });
    assert.equal(created.body.kind, 'text');
    assert.equal(created.body.status, 'ready');
    const list = await t.req('GET', '/api/sources');
    assert.equal(list.body[0].id, created.body.id);
    const bad = await t.req('POST', '/api/sources/text', { body: { name: 'x', text: '   ' } });
    assert.equal(bad.status, 400);
    const del = await t.req('DELETE', `/api/sources/${created.body.id}`);
    assert.deepEqual(del.body, { ok: true });
    assert.equal((await t.req('GET', `/api/sources/${created.body.id}`)).status, 404);
  });

  it('网址资料：拒绝回环、内网、链路本地和非 http(s)（SSRF）', async () => {
    for (const url of [
      'http://127.0.0.1:8794/api/health',
      'http://10.1.2.3/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost:8794/',
      'http://0.0.0.0/',
    ]) {
      const r = await t.req('POST', '/api/sources/url', { body: { url, crawl: false } });
      assert.equal(r.status, 400, url);
      assert.equal(r.body.code, 'url_not_allowed', url);
    }
    for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'not a url']) {
      const r = await t.req('POST', '/api/sources/url', { body: { url } });
      assert.equal(r.status, 400, url);
      assert.equal(r.body.code, 'invalid_url', url);
    }
    // 被拒绝的网址不建记录
    const list = await t.req('GET', '/api/sources');
    assert.ok(!list.body.some((s) => s.kind === 'url'));
  });

  it('IP 分类与 HTML 提取', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
    const { title, text } = htmlToText('<title>T</title><body><nav>菜单</nav><p>第一段</p><p>第二段</p><style>.x{}</style></body>');
    assert.equal(title, 'T');
    assert.equal(text, '第一段\n第二段');
  });
});
