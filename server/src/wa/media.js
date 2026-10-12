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
