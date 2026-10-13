import { useLayoutEffect, useRef, useState } from 'react';
import { CalendarClock, Download, ExternalLink } from 'lucide-react';
import { api } from '../api/client.js';
import { usePolling } from '../hooks/usePolling.js';
import { fmtFull } from '../lib/format.js';
import {
  cancelUpdateSchedule,
  closeUpdateModal,
  dateToPick,
  defaultPick,
  imageTagOf,
  loadUpdateStatus,
  pickToDate,
  scheduleText,
  scheduleTimeOk,
  setUpdateModalView,
  setUpdateStatus,
  useUpdateState,
} from '../lib/update.js';
import { Callout, CopyButton, Spinner } from './common.jsx';
import { Modal, useConfirm } from './Modal.jsx';
import { StatusDot } from './StatusDot.jsx';
import { toast } from './toastBus.js';
import { ScheduleFields } from './UpdateSchedule.jsx';

const COMMANDS = 'docker compose pull\ndocker compose up -d';
/** 更新助手接手后多久问一次版本号、等多久算太久 */
const POLL_MS = 3000;
const GIVE_UP_MS = 5 * 60_000;
const BAD_TIME = '要选 1 分钟之后、7 天之内的时间';

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
function manualLead(s, target) {
  const dir = '在服务器上 docker-compose.yml 所在的目录执行：';
  if (s.pinned) {
    return `镜像标签钉在了 ${imageTagOf(s.image)}，一键更新升不上去。先把 .env 里的 INKDOVE_IMAGE_TAG 改成 ${target}（或删掉这一行，用 latest），再${dir}`;
  }
  if (!s.updater?.configured) return `没有装更新助手，${dir}`;
  if (s.updater.reachable === false) return `连不上更新助手（compose 里的 updater 服务没在运行？），${dir}`;
  return null;
}

/**
 * 新版本弹窗（只有 admin，挂在 Layout 里，侧栏和设置页都能打开）。
 * 能一键更新时：
 * - 「立即更新」：二次确认 → POST /api/update/apply → 每 3 秒问一次 /api/health，版本号变了就刷新页面；
 *   5 分钟还没变就提示去服务器上看，并给出手动命令。关掉弹窗不影响等待。已有的预约作废。
 * - 「预约更新」：选一个时间（按浏览器时区）→ POST /api/update/schedule，到点服务端自己更新，只管这一次。
 *   已预约时显示「已预约 … 更新到 v…」，可以改时间、取消预约，也还能立即更新。
 *   到点后服务端开始更新（schedule.startedAt）时，和立即更新一样等新版本起来再刷新页面。
 */
export function UpdateModal() {
  const { status: s, modalOpen, modalView } = useUpdateState();
  const confirm = useConfirm();
  // idle | applying（等接口返回）| waiting（等新版本起来）| slow（等了 5 分钟还没好）
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const [backup, setBackup] = useState('');
  const started = useRef({ at: 0, from: '' });
  // 预约：选的时间、时间不对的提示、正在提交（schedule | cancel）
  const [pick, setPick] = useState(defaultPick);
  // 选的「第几天」从哪天算：打开选时间时定下来，显示的日期和提交都按它换算（弹窗开着跨过零点也不会晚一天）
  const [pickBase, setPickBase] = useState(() => new Date());
  const [pickError, setPickError] = useState('');
  const [busy, setBusy] = useState('');

  const schedule = s?.schedule || null;
  const scheduleRunning = !!schedule?.startedAt;
  const waiting = phase === 'waiting' || phase === 'slow';
  const target = s?.latest?.version || schedule?.targetVersion || '';
  const lead = s && target ? manualLead(s, target) : null;
  const picking = modalView === 'schedule' && !lead && !waiting && !scheduleRunning;

  // 打开选时间时：改时间从原来的时间开始，新预约默认明天凌晨 3 点。
  // 用 layout effect：在画出来之前换好，不会先闪一下上次打开时的日子
  useLayoutEffect(() => {
    if (!modalOpen || !picking) return;
    const base = new Date();
    setPickBase(base);
    setPick((schedule && dateToPick(schedule.at, base)) || defaultPick());
    setPickError('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, picking]);

  usePolling(
    async () => {
      const from = started.current.from || s?.current;
      try {
        const h = await api.health({ silent: true });
        if (h?.version && from && h.version !== from) {
          window.location.reload();
          return;
        }
      } catch {
        // 重启期间连不上是正常的
      }
      if (waiting && Date.now() - started.current.at > GIVE_UP_MS) setPhase('slow');
    },
    POLL_MS,
    waiting || scheduleRunning,
  );

  if (!s || !target || !(s.available || schedule || waiting)) return null;
  const canUpdate = !lead;

  const startWaiting = () => {
    started.current = { at: Date.now(), from: s.current };
    setPhase('waiting');
  };

  const apply = async () => {
    const ok = await confirm({
      title: `更新到 v${target}`,
      message: `会先备份数据库，再下载新版本并重启。更新期间约 1 分钟无法访问后台，WhatsApp 连接不受影响。${
        schedule ? '\n已有的预约会作废。' : ''
      }`,
      confirmText: '立即更新',
    });
    if (!ok) return;
    setError(null);
    setPhase('applying');
    try {
      const r = await api.applyUpdate({ silent: true });
      setBackup(r?.backup || '');
      startWaiting();
      // 预约已作废：侧栏和设置页跟着变
      loadUpdateStatus().catch(() => {});
    } catch (e) {
      // 别的管理员已经点了更新：一起等
      if (e.code === 'update_in_progress') return startWaiting();
      setPhase('idle');
      setError(e.message || '更新失败');
    }
  };

  const submitSchedule = async () => {
    const at = pickToDate(pick, pickBase);
    if (!scheduleTimeOk(at)) {
      setPickError(BAD_TIME);
      return;
    }
    setBusy('schedule');
    setPickError('');
    setError(null);
    try {
      const r = await api.scheduleUpdate(at.toISOString(), { silent: true });
      setUpdateStatus(r);
      setUpdateModalView('info');
      toast.success(scheduleText(r.schedule));
    } catch (e) {
      if (e.code === 'bad_time') setPickError(e.message || BAD_TIME);
      else setError(e.message || '预约失败');
    } finally {
      setBusy('');
    }
  };

  const cancelSchedule = async () => {
    setBusy('cancel');
    try {
      await cancelUpdateSchedule();
      toast.success('已取消预约');
    } catch {
      // 已弹提示
    } finally {
      setBusy('');
    }
  };

  let body;
  let footer;
  if (waiting || scheduleRunning) {
    body = (
      <div className="update-modal">
        <div className="update-modal__progress" role="status">
          <Spinner size={20} />
          <div>
            <div className="update-modal__progress-title">
              {waiting ? `正在更新到 v${target}…` : `正在按预约更新到 v${schedule.to || target}…`}
            </div>
            <div className="muted">
              {waiting && backup ? `更新前的数据库已备份到 data/${backup}。` : ''}新版本启动后页面会自动刷新。
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
    );
    footer = (
      <button type="button" className="btn" onClick={closeUpdateModal}>
        关闭
      </button>
    );
  } else if (picking) {
    body = (
      <div className="update-modal">
        <div>选一个时间，到时间自动更新到 v{target}，只更新这一次。</div>
        <ScheduleFields
          base={pickBase}
          pick={pick}
          onChange={(p) => {
            setPick(p);
            setPickError('');
          }}
          error={pickError}
        />
        <div className="update-modal__hint">
          到时间会先备份数据库，再下载新版本并重启，期间约 1 分钟无法访问后台。到时间服务器没在运行的话，超过 1 小时就不再更新。
        </div>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={() => setUpdateModalView('info')} disabled={busy === 'schedule'}>
          返回
        </button>
        <button type="button" className="btn btn--primary" onClick={submitSchedule} disabled={busy === 'schedule'}>
          {busy === 'schedule' ? <Spinner /> : <CalendarClock />}
          {schedule ? '保存' : '确定预约'}
        </button>
      </>
    );
  } else {
    const latest = s.latest;
    body = (
      <div className="update-modal">
        {schedule && (
          <div className="update-modal__schedule">
            <div className="update-modal__schedule-text">
              <StatusDot tone="info" wrap>
                {scheduleText(schedule)}
              </StatusDot>
              <div className="update-modal__hint">
                {schedule.scheduledBy?.email ? `${schedule.scheduledBy.email} 预约的，` : ''}时间按这台电脑的时区显示
              </div>
            </div>
            <div className="update-actions">
              {canUpdate && (
                <button type="button" className="btn btn--sm" onClick={() => setUpdateModalView('schedule')}>
                  改时间
                </button>
              )}
              <button type="button" className="btn btn--sm" onClick={cancelSchedule} disabled={busy === 'cancel'}>
                {busy === 'cancel' && <Spinner />}
                取消预约
              </button>
            </div>
          </div>
        )}
        <dl className="kv">
          <dt>当前版本</dt>
          <dd className="num">v{s.current}</dd>
          <dt>新版本</dt>
          <dd className="num">v{target}</dd>
          {latest && (
            <>
              <dt>发布时间</dt>
              <dd>{fmtFull(latest.publishedAt) || '—'}</dd>
            </>
          )}
        </dl>
        {latest && (
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
        )}
        {lead && <UpdateCommands lead={lead} />}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={closeUpdateModal}>
          关闭
        </button>
        {canUpdate && !schedule && (
          <button type="button" className="btn" onClick={() => setUpdateModalView('schedule')} disabled={phase === 'applying'}>
            <CalendarClock />
            预约更新
          </button>
        )}
        {canUpdate && (
          <button type="button" className="btn btn--primary" onClick={apply} disabled={phase === 'applying'}>
            {phase === 'applying' ? <Spinner /> : <Download />}
            立即更新
          </button>
        )}
      </>
    );
  }

  return (
    <Modal
      open={modalOpen}
      onClose={closeUpdateModal}
      title={picking ? `预约更新到 v${target}` : `有新版本 v${target}`}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
