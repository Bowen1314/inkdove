import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

/** 源代码地址（AGPL-3.0 第 13 条：让通过网络使用的人能拿到源代码）。二次开发时改成自己的仓库 */
export const SOURCE_REPO_URL = 'https://github.com/Bowen1314/inkdove';

// 在线更新的状态（GET /api/update，只有 admin）：侧栏的「有新版本」、设置页「版本」和更新弹窗共用一份。
let state = { status: null, modalOpen: false };
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

export const openUpdateModal = () => set({ modalOpen: true });
export const closeUpdateModal = () => set({ modalOpen: false });

/** → {status, modalOpen} */
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
