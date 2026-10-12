// F15 / F4 测试用的文件和假 Graph API。
import http from 'node:http';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

/** 一个最小的、带 ASCII 文字的 PDF */
export function makePdf(text) {
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

/** 一个最小的 docx */
export async function makeDocx(paragraphs) {
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

/** xlsx / xls（bookType biff8） */
export function makeSheet(rows, bookType = 'xlsx') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '价目表');
  return XLSX.write(wb, { type: 'buffer', bookType });
}

/** 一个最小的 pptx：每页一段文字 */
export async function makePptx(slides) {
  const zip = new JSZip();
  slides.forEach((text, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 假的 JPEG（只有文件头，内容是给 mock 识图读的文字） */
export const fakeJpeg = (text = 'photo') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(text)]);

/** 用 FormData 上传到 /api/files */
export function filesForm(files, { addToKb } = {}) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.buffer], { type: f.type || 'application/octet-stream' }), f.name);
  if (addToKb !== undefined) form.append('addToKb', String(addToKb));
  return form;
}

/**
 * 假 Graph API：
 * - POST /{ver}/{pnid}/messages → wamid.SENT<n>
 * - POST /{ver}/{pnid}/media（multipart）→ {id:"MEDIA<n>"}，记下原始请求体
 * - GET /{ver}/{media-id} → {url, mime_type, file_size}（state.media 里登记过的）
 * - GET /download/{media-id} → 文件内容，要求 Bearer token
 */
export async function startFakeGraph({ token } = {}) {
  const state = { requests: [], uploads: [], media: new Map(), uploadCount: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const authed = !token || req.headers.authorization === `Bearer ${token}`;
    if (req.method === 'POST' && parts[2] === 'media') {
      state.uploadCount++;
      const id = `MEDIA${state.uploadCount}`;
      state.uploads.push({ id, path: u.pathname, headers: req.headers, raw: raw.toString('latin1') });
      return json(200, { id });
    }
    if (req.method === 'GET' && parts[0] === 'download') {
      if (!authed) return json(401, { error: { message: 'bad token' } });
      const m = state.media.get(parts[1]);
      if (!m) return json(404, { error: { message: 'no media' } });
      res.writeHead(200, { 'content-type': m.mime });
      return res.end(m.buffer);
    }
    if (req.method === 'GET' && parts.length === 2) {
      if (!authed) return json(401, { error: { message: 'bad token' } });
      const m = state.media.get(parts[1]);
      if (!m) return json(404, { error: { message: 'no media' } });
      return json(200, {
        messaging_product: 'whatsapp',
        url: `${base}/download/${parts[1]}`,
        mime_type: m.mime,
        file_size: m.buffer.length,
        id: parts[1],
      });
    }
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      body = raw.toString('utf8');
    }
    state.requests.push({ method: req.method, path: u.pathname, headers: req.headers, body });
    json(200, { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.SENT${state.requests.length}` }] });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    state,
    /** 发出去的消息（不含标已读） */
    sent: (type) => state.requests.filter((r) => r.body?.type && (!type || r.body.type === type)),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

/** Meta webhook：一条消息（type 和内容由 msg 给） */
let metaSeq = 0;
export function metaEvent(pnid, from, msg, name = '客户') {
  metaSeq++;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: pnid },
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [{ from, id: `wamid.IN${metaSeq}${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
            },
          },
        ],
      },
    ],
  };
}
