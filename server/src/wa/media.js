// F4：客户发来的语音、图片的限制和小工具。

export const MEDIA_LIMITS = {
  image: { maxBytes: 5 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
  voice: { maxBytes: 10 * 1024 * 1024, maxSeconds: 180 },
};

/** "audio/ogg; codecs=opus" → "audio/ogg" */
export const baseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();

/** mime → F4 的媒体类型；不是图片或语音时返回 null */
export function mediaTypeOf(mime) {
  const m = baseMime(mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'voice';
  return null;
}

// ---- 客户发来的媒体存盘（显示用） ----

/** 单个媒体文件最大 64MB，超过的不保存 */
export const MEDIA_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** 消息里媒体的显示类型 */
export const MEDIA_KINDS = ['image', 'video', 'voice', 'document', 'sticker'];
export const MEDIA_LABELS = { image: '[图片]', video: '[视频]', voice: '[语音]', document: '[文件]', sticker: '[贴纸]' };

/** mime → 显示类型（贴纸、文件要看消息本身，见各通道的解析） */
export function mediaKindOf(mime) {
  const m = baseMime(mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'voice';
  return 'document';
}

/** 只有这些 mime 在浏览器里直接打开（inline）；其他一律当附件下载。SVG、HTML 等永远不 inline */
export const INLINE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/3gpp',
  'video/webm',
  'video/quicktime',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'audio/webm',
]);
export const isInlineMime = (mime) => INLINE_MIMES.has(baseMime(mime));

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
};

/** 客户给的原始文件名（只用来显示和下载时的文件名）：去掉控制字符和路径分隔符，最多 200 字；没有返回 null */
export function cleanFilename(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim().slice(0, 200);
  return s || null;
}

/** 下载时用的文件名：有原始文件名用原始的，没有按类型和 mime 拼一个 */
export function downloadName(media, messageId) {
  const own = cleanFilename(media?.filename);
  if (own) return own;
  const ext = MIME_EXT[baseMime(media?.mime)];
  const kind = MEDIA_KINDS.includes(media?.type) ? media.type : 'file';
  return `${kind}-${String(messageId).slice(0, 8)}${ext ? `.${ext}` : ''}`;
}

/**
 * 存在 messages.media 里的 JSON → 给前端的样子：去掉 fileKey（磁盘上的文件名不给前端）。
 * 旧数据没有 stored 时为 null（按"没存"处理）。
 */
export function publicMedia(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { type: raw.type ?? null, mime: raw.mime ?? null };
  if ('stored' in raw) {
    out.size = Number.isFinite(raw.size) ? raw.size : null;
    out.filename = raw.filename ?? null;
    out.stored = raw.stored ?? null;
    out.error = raw.error ?? null;
    // 文件提取文字的结果（只有客户发来的文件有）：{status, chars?, truncated?, error?}，文字本身另外取（…/doc-text）
    if (raw.extract && typeof raw.extract === 'object') {
      const e = raw.extract;
      out.extract = { status: e.status ?? null, chars: Number.isFinite(e.chars) ? e.chars : null, truncated: !!e.truncated, error: e.error ?? null };
    }
  }
  return out;
}

/**
 * Ogg（WhatsApp 语音是 Ogg/Opus）的时长（秒）：最后一页的 granule position ÷ 采样率。
 * Opus 的 granule 固定按 48kHz 计，并减去 OpusHead 里的 pre-skip；Vorbis 取识别头里的采样率。解析不了返回 null。
 * @param {Buffer} buf
 */
export function oggDurationSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28 || buf.toString('latin1', 0, 4) !== 'OggS') return null;
  let rate = 0;
  let preSkip = 0;
  const opus = buf.indexOf('OpusHead', 0, 'latin1');
  if (opus >= 0 && opus + 12 <= buf.length) {
    rate = 48000;
    preSkip = buf.readUInt16LE(opus + 10);
  } else {
    const vorbis = buf.indexOf('\x01vorbis', 0, 'latin1');
    if (vorbis >= 0 && vorbis + 16 <= buf.length) rate = buf.readUInt32LE(vorbis + 12);
  }
  if (!rate) return null;
  let at = buf.lastIndexOf('OggS', buf.length - 4, 'latin1');
  while (at >= 0) {
    if (at + 14 <= buf.length) {
      const granule = buf.readBigInt64LE(at + 6);
      if (granule > 0n) return Math.max(0, Number(granule) - preSkip) / rate;
    }
    at = at > 0 ? buf.lastIndexOf('OggS', at - 1, 'latin1') : -1;
  }
  return null;
}

/** WAHA 原始消息里的语音时长（GOWS：_data.Message.audioMessage.seconds；WEBJS：_data.duration），没有返回 null */
export function wahaVoiceSeconds(p) {
  const d = p?._data || {};
  const raw = d.Message?.audioMessage?.seconds ?? d.message?.audioMessage?.seconds ?? d.duration;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
