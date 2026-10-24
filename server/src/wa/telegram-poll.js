// Telegram 收消息：每个机器人一个长轮询循环（getUpdates，见 telegram.js 开头）。墨鸽主动去取，不需要公网地址。
// - 开始前 getMe 看 token 对不对、删掉 webhook（设了 webhook 时 getUpdates 返回 409）；
// - offset 存在调用方那里（kv），重启后接着取：停机期间客户发的消息（Telegram 留 24 小时）重启后照样收到；
// - 这个机器人第一次给墨鸽用（没有存过 offset）时，之前积压的不要：offset -1 只取最后一条，同时确认掉前面的，再跳过它；
// - 每条 update 处理完才确认（offset 往后挪、存盘），处理出错的照样确认，免得一条坏消息卡住后面的；
// - token 不对（401、404）停下，等 token 改了由调用方重新开始；别处也在取（409）隔一阵再试；其他错误按 2 倍退避，最长 60 秒。
import { sleep } from '../util.js';
import { isTgAuthError, isTgConflict, tgDeleteWebhook, tgGetMe, tgGetUpdates } from './telegram.js';

/**
 * @param {{
 *   apiBase: string,
 *   token: string,
 *   allowedUpdates: string[],
 *   timeoutSec?: number,
 *   retryMs?: number,
 *   loadOffset: () => number|null,
 *   saveOffset: (offset: number) => void,
 *   onReady: (me: any) => void,
 *   onOk: () => void,
 *   onError: (err: any, fatal: boolean) => void,
 *   onUpdate: (update: any) => Promise<any>,
 *   onUpdateError: (err: any) => void,
 * }} o timeoutSec：长轮询每次等多久（测试里调小）；retryMs：出错后第一次等多久再试
 * @returns {{stop: () => Promise<void>}}
 */
export function startTgPoller(o) {
  const ac = new AbortController();
  const { signal } = ac;
  const timeoutSec = o.timeoutSec ?? 50;
  const retryMs = o.retryMs ?? 2000;
  const get = (offset, t) => tgGetUpdates(o.apiBase, o.token, { offset, timeoutSec: t, allowedUpdates: o.allowedUpdates, signal });

  const loop = (async () => {
    /** @type {number|null} */
    let offset = null;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (offset === null) {
          const me = await tgGetMe(o.apiBase, o.token, { signal });
          await tgDeleteWebhook(o.apiBase, o.token);
          let saved = o.loadOffset();
          if (saved === null) {
            const last = await get(-1, 0);
            saved = last.length ? last[last.length - 1].update_id + 1 : 0;
            o.saveOffset(saved);
          }
          offset = saved;
          o.onReady(me);
        }
        const updates = await get(offset, timeoutSec);
        failures = 0;
        o.onOk();
        for (const u of Array.isArray(updates) ? updates : []) {
          if (signal.aborted) return;
          try {
            await o.onUpdate(u);
          } catch (err) {
            o.onUpdateError(err);
          }
          if (Number.isInteger(u?.update_id) && u.update_id >= offset) {
            offset = u.update_id + 1;
            o.saveOffset(offset);
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        const fatal = isTgAuthError(err);
        o.onError(err, fatal);
        if (fatal) return;
        failures++;
        const wait = isTgConflict(err)
          ? retryMs * 15
          : err?.retryAfter > 0
            ? err.retryAfter * 1000
            : Math.min(retryMs * 2 ** (failures - 1), Math.max(retryMs, 60_000));
        try {
          await sleep(wait, signal);
        } catch {
          return;
        }
      }
    }
  })();

  return {
    async stop() {
      ac.abort(new Error('stopped'));
      await loop;
    },
  };
}
