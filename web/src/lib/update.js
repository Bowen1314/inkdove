import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { fmtDateTime } from './format.js';

/** 源代码地址（AGPL-3.0 第 13 条：让通过网络使用的人能拿到源代码）。二次开发时改成自己的仓库 */
export const SOURCE_REPO_URL = 'https://github.com/Bowen1314/inkdove';

// 在线更新的状态（GET /api/update，只有 admin）：侧栏的「有新版本」、设置页「版本」和更新弹窗共用一份。
// modalView：弹窗显示新版本说明（info）还是选预约时间（schedule）
let state = { status: null, modalOpen: false, modalView: 'info' };
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
}

export function setUpdateStatus(status) {
  set({ status });
}

/** 重新读一遍（服务端只给缓存的结果，不会去查 GitHub）。出错时不弹提示，交给调用方 */
export async function loadUpdateStatus() {
  const status = await api.getUpdate({ silent: true });
  set({ status });
  return status;
}

/** 打开更新弹窗；view='schedule' 时直接到选预约时间（设置页的「改时间」）。也可以直接当 onClick 用 */
export const openUpdateModal = (view) => set({ modalOpen: true, modalView: view === 'schedule' ? 'schedule' : 'info' });
export const closeUpdateModal = () => set({ modalOpen: false, modalView: 'info' });
export const setUpdateModalView = (modalView) => set({ modalView });

/** 取消预约，更新共用的状态。出错时已弹提示，再抛出 */
export async function cancelUpdateSchedule() {
  const status = await api.cancelUpdateSchedule();
  set({ status });
  return status;
}

/** → {status, modalOpen, modalView} */
export function useUpdateState() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => listeners.delete(setS);
  }, []);
  return s;
}

/** compose 里的镜像标签：ghcr.io/x/y:0.2.0 → 0.2.0 */
export function imageTagOf(image) {
  const m = /:([^:/@]+)$/.exec(image || '');
  return m ? m[1] : 'latest';
}

// ============ 预约更新 ============

/** 能选的日子：今天和之后 7 天；分钟按 5 分钟一档 */
export const SCHEDULE_DAYS = 8;
export const SCHEDULE_MINUTE_STEP = 5;
/** 和服务端一样：1 分钟之后、7 天之内 */
const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 7 * 86400_000;

/** 侧栏、设置页、弹窗共用的一句话：「已预约 10月14日 03:00 更新到 v0.4.0」（按浏览器时区）；没有预约返回 '' */
export function scheduleText(schedule) {
  if (!schedule) return '';
  if (schedule.startedAt) return `正在按预约更新到 v${schedule.to || schedule.targetVersion}`;
  return `已预约 ${fmtDateTime(schedule.at)} 更新到 v${schedule.targetVersion}`;
}

/** 最近一次预约执行的结果 → {tone, text}；没有返回 null */
export function scheduleResultOf(r) {
  if (!r) return null;
  const head = `${fmtDateTime(r.at)} 的预约更新`;
  if (r.outcome === 'success') {
    return { tone: 'success', text: r.from ? `${head}：已从 v${r.from} 更新到 v${r.to}` : `${head}：已经是 v${r.to}，不用再更新` };
  }
  if (r.outcome === 'missed') {
    return { tone: 'warning', text: `${head}：错过了预约时间（那时服务没在运行），没有更新` };
  }
  return { tone: 'danger', text: `${head}失败：${r.error || '原因不明'}` };
}

/** 选的时间 {day（0 是今天）, hour, minute} → Date（按浏览器时区） */
export function pickToDate({ day, hour, minute }, now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, minute, 0, 0);
}

/** ISO 时间 → {day, hour, minute}（按浏览器时区）；不在能选的范围里时返回 null */
export function dateToPick(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // 夏令时那天差 1 小时，四舍五入
  const day = Math.round((that.getTime() - today.getTime()) / 86400_000);
  if (day < 0 || day >= SCHEDULE_DAYS) return null;
  return { day, hour: d.getHours(), minute: d.getMinutes() };
}

/** 默认：明天凌晨 3 点 */
export const defaultPick = () => ({ day: 1, hour: 3, minute: 0 });

/** 能不能预约在这个时间 */
export function scheduleTimeOk(date, now = Date.now()) {
  const ahead = date.getTime() - now;
  return ahead >= MIN_AHEAD_MS && ahead <= MAX_AHEAD_MS;
}
