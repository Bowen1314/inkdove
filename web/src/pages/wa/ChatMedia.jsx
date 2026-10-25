import { useState } from 'react';
import { Download, FileText, Film, Image as ImageIcon, ImageOff, Mic, Sticker } from 'lucide-react';
import { api } from '../../api/client.js';
import { Modal } from '../../ui/Modal.jsx';
import { fmtSize } from '../../lib/format.js';
import { extOf, fileIcon, fileTypeLabel } from '../../lib/files.js';
import { MEDIA_LABEL } from '../../lib/labels.js';

// 客户发来的图片、视频、语音、文件、贴纸在消息里的样子。文件是后端收到消息后存的盘，这里按 media.stored 显示：
// ok 显示缩略图（点开看大图）、播放器或文件卡片；pending 正在保存；too_large、failed 说明没存下来。
// 旧消息、导入的历史消息没有 stored，不在这里显示，气泡里照旧是小图标加 [图片] 这样的文字。

export const MEDIA_ICON = { voice: Mic, image: ImageIcon, video: Film, document: FileText, sticker: Sticker };

// 和后端 INLINE_MIMES（server/src/wa/media.js）一致：只有这些在页面里直接显示或播放，其他做成文件卡片下载
const INLINE_MIMES = new Set([
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
const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();
const STATES = ['ok', 'pending', 'too_large', 'failed'];

/** 这条消息的媒体要不要在气泡上方单独显示（旧数据、历史消息没有 stored，不单独显示） */
export const hasMediaBlock = (media) => STATES.includes(media?.stored);

/** 没有说明文字的媒体消息，text 是 [图片] 这样的标签；媒体单独显示时不再重复这个气泡 */
export const isBareMediaLabel = (text) => /^\[[^\]\n]{1,6}\]$/.test(String(text || '').trim());

/** 存好的媒体怎么显示：image（缩略图）、video、audio，或 file（文件卡片，点了下载） */
function viewOf(media) {
  const mime = baseMime(media.mime);
  if (!INLINE_MIMES.has(mime)) return 'file';
  if ((media.type === 'image' || media.type === 'sticker') && mime.startsWith('image/')) return 'image';
  if (media.type === 'video' && mime.startsWith('video/')) return 'video';
  if (media.type === 'voice' && mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const kindLabel = (media) => MEDIA_LABEL[media.type] || '文件';

/** 文件卡片的第二行：格式 · 大小（没有文件名时格式写"视频""语音"这些） */
function metaOf(media) {
  const type = extOf(media.filename) ? fileTypeLabel(media) : kindLabel(media);
  return [type, fmtSize(media.size)].filter(Boolean).join(' · ');
}

/** 没存下来、正在存的：类型图标、名字、说明，不能点 */
function MediaNote({ icon: Icon, name, note, tone }) {
  return (
    <div className="msg__file msg__file--note">
      <Icon aria-hidden="true" />
      <span className="msg__file-body">
        <span className="msg__file-name">{name}</span>
        <span className={`msg__file-meta${tone ? ` msg__file-meta--${tone}` : ''}`}>{note}</span>
      </span>
    </div>
  );
}

/** 文件卡片：点了下载（不在白名单里的文件，或者浏览器显示 / 播放不了的） */
function MediaFileCard({ href, media, icon: Icon, name, meta }) {
  return (
    <a className="msg__file" href={href} download={media.filename || true} aria-label={`下载 ${name}`} title="点击下载">
      <Icon aria-hidden="true" />
      <span className="msg__file-body">
        <span className="msg__file-name">{name}</span>
        <span className="msg__file-meta">{meta}</span>
      </span>
      <Download className="msg__file-dl" aria-hidden="true" />
    </a>
  );
}

/**
 * 客户消息里的媒体。onLoad：图片、视频的尺寸出来后调一次（消息区贴着底部时重新滚到底）
 * @param {{convId:string, msg:{id:string, media:object}, onLoad?:() => void}} props
 */
export function MessageMedia({ convId, msg, onLoad }) {
  const media = msg.media;
  const [broken, setBroken] = useState(false); // 图片加载不出来、浏览器播放不了
  const [viewing, setViewing] = useState(false);
  const Icon = MEDIA_ICON[media.type] || FileText;
  const label = kindLabel(media);
  const name = media.filename || label;

  if (media.stored === 'pending') return <MediaNote icon={Icon} name={name} note="文件保存中…" />;
  if (media.stored === 'too_large') {
    const size = fmtSize(media.size);
    return <MediaNote icon={Icon} name={size ? `${name}（${size}）` : name} note="文件过大未保存，请在手机端查看" tone="warning" />;
  }
  if (media.stored === 'failed') {
    return <MediaNote icon={Icon} name={name} note={`下载失败${media.error ? `：${media.error}` : ''}`} tone="danger" />;
  }

  const url = api.messageMediaUrl(convId, msg.id);
  const dlUrl = api.messageMediaUrl(convId, msg.id, { download: true });
  const view = viewOf(media);

  if (broken) {
    const isImage = view === 'image';
    return (
      <MediaFileCard
        href={dlUrl}
        media={media}
        icon={isImage ? ImageOff : Icon}
        name={name}
        meta={isImage ? `${label}加载失败，点击下载` : `浏览器无法播放，请下载后${media.type === 'voice' ? '收听' : '查看'}`}
      />
    );
  }

  if (view === 'image') {
    const sticker = media.type === 'sticker';
    return (
      <>
        <button
          type="button"
          className={`msg__image${sticker ? ' msg__image--sticker' : ''}`}
          onClick={() => setViewing(true)}
          aria-label={`查看${label}大图`}
        >
          <img src={url} alt={label} loading="lazy" onLoad={onLoad} onError={() => setBroken(true)} />
        </button>
        <Modal
          open={viewing}
          width={720}
          title={name}
          onClose={() => setViewing(false)}
          footer={
            <a className="btn btn--sm" href={dlUrl} download={media.filename || true}>
              <Download />
              下载
            </a>
          }
        >
          <div className="media-viewer">
            <img className="media-viewer__img" src={url} alt={label} />
          </div>
        </Modal>
      </>
    );
  }

  // 视频、语音点播放才加载（preload="none"）：会话里媒体多时一打开就要发很多请求。
  // 没加载前拿不到时长和尺寸：视频先占一个 16:9 的位置（见 .msg__video），播放后换成实际比例，onLoad 让贴着底部的消息区重新滚到底；
  // 浏览器播放不了的也要点了播放才知道，那时再换成下载卡片
  if (view === 'video') {
    return (
      <video
        className="msg__video"
        src={url}
        controls
        preload="none"
        onLoadedMetadata={onLoad}
        onError={() => setBroken(true)}
        aria-label={name}
      />
    );
  }

  if (view === 'audio') {
    return <audio className="msg__audio" src={url} controls preload="none" onError={() => setBroken(true)} aria-label={name} />;
  }

  const FileIcon = media.type === 'document' ? fileIcon(media) : Icon;
  return <MediaFileCard href={dlUrl} media={media} icon={FileIcon} name={name} meta={metaOf(media)} />;
}
