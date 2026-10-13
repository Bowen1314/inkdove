import { useRef, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { fmtFull } from '../lib/format.js';
import { closeUpdateModal, imageTagOf, useUpdateState } from '../lib/update.js';
import { Callout, CopyButton, Spinner } from './common.jsx';
import { Modal, useConfirm } from './Modal.jsx';

const COMMANDS = 'docker compose pull\ndocker compose up -d';
/** 更新助手接手后多久问一次版本号、等多久算太久 */
const POLL_MS = 3000;
const GIVE_UP_MS = 5 * 60_000;

/** 手动更新的命令（docker-compose.yml 所在目录执行），带复制按钮 */
export function UpdateCommands({ lead }) {
  return (
    <div className="update-cmd">
      <div className="update-cmd__head">
        <span className="muted">{lead}</span>
        <CopyButton text={COMMANDS} label="复制命令" />
      </div>
      <pre className="code-box">{COMMANDS}</pre>
    </div>
  );
}

/** 不能一键更新时，说明原因并给出命令；能一键更新时返回 null */
function manualLead(s) {
  const dir = '在服务器上 docker-compose.yml 所在的目录执行：';
  if (s.pinned) {
    return `镜像标签钉在了 ${imageTagOf(s.image)}，一键更新升不上去。先把 .env 里的 INKDOVE_IMAGE_TAG 改成 ${s.latest.version}（或删掉这一行，用 latest），再${dir}`;
  }
  if (!s.updater?.configured) return `没有装更新助手，${dir}`;
  if (s.updater.reachable === false) return `连不上更新助手（compose 里的 updater 服务没在运行？），${dir}`;
  return null;
}

/**
 * 新版本弹窗（只有 admin，挂在 Layout 里，侧栏和设置页都能打开）。
 * 能一键更新时：二次确认 → POST /api/update/apply → 每 3 秒问一次 /api/health，版本号变了就刷新页面；
 * 5 分钟还没变就提示去服务器上看，并给出手动命令。关掉弹窗不影响等待。
 */
export function UpdateModal() {
  const { status: s, modalOpen } = useUpdateState();
  const confirm = useConfirm();
  // idle | applying（等接口返回）| waiting（等新版本起来）| slow（等了 5 分钟还没好）
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const [backup, setBackup] = useState('');
  const started = useRef({ at: 0, from: '' });

  const waiting = phase === 'waiting' || phase === 'slow';
  usePolling(
    async () => {
      try {
        const h = await api.health({ silent: true });
        if (h?.version && h.version !== started.current.from) {
          window.location.reload();
          return;
        }
      } catch {
        // 重启期间连不上是正常的
      }
      if (Date.now() - started.current.at > GIVE_UP_MS) setPhase('slow');
    },
    POLL_MS,
    waiting,
  );

  const latest = s?.latest;
  if (!s || !latest || (!s.available && !waiting)) return null;
  const lead = manualLead(s);

  const startWaiting = () => {
    started.current = { at: Date.now(), from: s.current };
    setPhase('waiting');
  };

  const apply = async () => {
    const ok = await confirm({
      title: `更新到 v${latest.version}`,
      message: '会先备份数据库，再下载新版本并重启。更新期间约 1 分钟无法访问后台，WhatsApp 连接不受影响。',
      confirmText: '立即更新',
    });
    if (!ok) return;
    setError(null);
    setPhase('applying');
    try {
      const r = await api.applyUpdate({ silent: true });
      setBackup(r?.backup || '');
      startWaiting();
    } catch (e) {
      // 别的管理员已经点了更新：一起等
      if (e.code === 'update_in_progress') return startWaiting();
      setPhase('idle');
      setError(e.message || '更新失败');
    }
  };

  const body = waiting ? (
    <div className="update-modal">
      <div className="update-modal__progress" role="status">
        <Spinner size={20} />
        <div>
          <div className="update-modal__progress-title">正在更新到 v{latest.version}…</div>
          <div className="muted">
            {backup ? `更新前的数据库已备份到 data/${backup}。` : ''}新版本启动后页面会自动刷新。
          </div>
        </div>
      </div>
      {phase === 'slow' && (
        <>
          <Callout tone="warning">
            过了 5 分钟还没更新好。请到服务器上用 docker compose logs updater 看看更新助手的日志，或者手动更新。
          </Callout>
          <UpdateCommands lead="在服务器上 docker-compose.yml 所在的目录执行：" />
        </>
      )}
    </div>
  ) : (
    <div className="update-modal">
      <dl className="kv">
        <dt>当前版本</dt>
        <dd className="num">v{s.current}</dd>
        <dt>新版本</dt>
        <dd className="num">v{latest.version}</dd>
        <dt>发布时间</dt>
        <dd>{fmtFull(latest.publishedAt) || '—'}</dd>
      </dl>
      <div>
        <div className="update-modal__notes-head">
          <h3>更新说明</h3>
          <a className="btn btn--link btn--sm" href={latest.url} target="_blank" rel="noopener noreferrer">
            GitHub Release
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
        {/* 纯文本显示，不当 HTML / Markdown 渲染 */}
        <div className="update-modal__notes" tabIndex={0} aria-label="更新说明">
          {latest.notes.trim() || '这个版本没有写更新说明。'}
        </div>
      </div>
      {lead && <UpdateCommands lead={lead} />}
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  );

  return (
    <Modal
      open={modalOpen}
      onClose={closeUpdateModal}
      title={`有新版本 v${latest.version}`}
      footer={
        <>
          <button type="button" className="btn" onClick={closeUpdateModal}>
            关闭
          </button>
          {!lead && !waiting && (
            <button type="button" className="btn btn--primary" onClick={apply} disabled={phase === 'applying'}>
              {phase === 'applying' ? <Spinner /> : <Download />}
              立即更新
            </button>
          )}
        </>
      }
    >
      {body}
    </Modal>
  );
}
