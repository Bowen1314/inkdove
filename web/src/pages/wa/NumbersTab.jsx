import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, MoreHorizontal, Plus, Smartphone, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal, useConfirm } from '../../ui/Modal.jsx';
import { Callout, EmptyState, ErrorState, Field, fieldProps, PageHeader, Spinner } from '../../ui/common.jsx';
import { CellText, DataTable, TableToolbar } from '../../ui/DataTable.jsx';
import { Select } from '../../ui/Select.jsx';
import { Menu, Tooltip } from '../../ui/Popover.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { usePolling } from '../../hooks/usePolling.js';
import { useAuth } from '../../lib/auth.jsx';
import { invalidateAccounts, isConnected, patchAccountCache, useAccounts } from '../../lib/accounts.js';
import { CHANNEL_LABEL, isTgBotApi, REPLY_MODES, replyModeLabel, replyModeOf, waState } from '../../lib/labels.js';
import { tgApiHashError, tgApiIdError, TGUSER_WARNING } from '../../lib/tguser.js';
import { fmtDay, fmtHm } from '../../lib/format.js';

export const CHANNEL_OPTIONS = [
  {
    value: 'waha',
    title: '扫码连接',
    desc: '使用手机 WhatsApp 扫码关联，支持个人号与 WhatsApp Business 号。',
  },
  {
    value: 'meta',
    title: 'Meta 官方接口',
    desc: '适用于已开通 WhatsApp Business Platform 的企业，需在 Meta 开发者后台配置。',
  },
  {
    value: 'line',
    title: 'LINE 官方帐号',
    desc: '接入 LINE 官方帐号（Messaging API），客户添加好友后发起会话。需在 LINE Developers Console 配置。',
  },
  {
    value: 'tgbot',
    title: 'Telegram 机器人',
    desc: '客户通过 Telegram 机器人发起会话。在 @BotFather 创建机器人并填写 token，无需公网地址。',
  },
  {
    value: 'tgbiz',
    title: 'Telegram 私人号',
    desc: '以本人 Telegram 帐号回复私聊：通过 Telegram「聊天自动化」将机器人关联到该帐号。',
  },
  {
    value: 'tguser',
    title: 'Telegram 扫码登录',
    desc: '以桌面端方式扫码登录个人帐号，收发全部私聊。需 my.telegram.org 的 api_id 和 api_hash（支持自动获取）。',
  },
];

const TG_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
export const TG_TOKEN_ERROR = '格式错误：应为 @BotFather 提供的完整 token（数字:字母串）';

/** status.me.id（如 8613800138000@c.us）→ +8613800138000 */
export function phoneOf(account) {
  const id = account?.status?.me?.id;
  if (!id) return '';
  const raw = String(id).split('@')[0];
  return /^\d+$/.test(raw) ? `+${raw}` : raw;
}

/** 列表里名字下面那一行：手机号；Telegram 号没有手机号，显示机器人的用户名，扫码登录的号显示登录的帐号的用户名 */
function handleOf(account) {
  const tg = account?.status?.telegram;
  const user = tg?.botUsername || tg?.me?.username;
  return phoneOf(account) || (user ? `@${user}` : '');
}

/** DESIGN.md 第 8 节：今天 10:42，其余按日期；悬停显示完整时间 */
const pad = (n) => String(n).padStart(2, '0');
function shortTime(iso) {
  const day = fmtDay(iso);
  return day === '今天' ? fmtHm(iso) : day;
}
function fullTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 状态筛选：按连接阶段归类 */
const STATE_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'connected', label: '已连接' },
  { value: 'pending', label: '连接中' },
  { value: 'failed', label: '连接失败' },
  { value: 'off', label: '未连接' },
];
function stateGroup(account) {
  const s = account?.status?.state;
  if (isConnected(account)) return 'connected';
  if (s === 'starting' || s === 'scan_qr' || s === 'waiting' || s === 'password') return 'pending';
  if (s === 'failed') return 'failed';
  return 'off';
}

const CHANNEL_FILTERS = [
  { value: '', label: '全部接入方式' },
  { value: 'waha', label: CHANNEL_LABEL.waha },
  { value: 'meta', label: CHANNEL_LABEL.meta },
  { value: 'line', label: CHANNEL_LABEL.line },
  { value: 'tgbot', label: CHANNEL_LABEL.tgbot },
  { value: 'tgbiz', label: CHANNEL_LABEL.tgbiz },
  { value: 'tguser', label: CHANNEL_LABEL.tguser },
];

const EMPTY_LINE = { channelId: '', channelSecret: '', accessToken: '' };

function AddAccountModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('waha');
  // LINE 官方帐号的三项配置：可以先空着，添加后在号详情的「连接」里再填
  const [line, setLine] = useState(EMPTY_LINE);
  // Telegram 机器人的 token：也可以先空着，之后在「连接」里填
  const [tgToken, setTgToken] = useState('');
  // Telegram 扫码登录的 api_id、api_hash：同上
  const [tgApi, setTgApi] = useState({ apiId: '', apiHash: '' });
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setName('');
    setChannel('waha');
    setLine(EMPTY_LINE);
    setTgToken('');
    setTgApi({ apiId: '', apiHash: '' });
    setTouched(false);
  };
  const setLineField = (k, v) => setLine((l) => ({ ...l, [k]: v }));
  const lineIdError = channel === 'line' && line.channelId.trim() && !/^\d+$/.test(line.channelId.trim()) ? 'Channel ID 须为数字' : null;
  const isTg = isTgBotApi(channel);
  const tgTokenError = isTg && tgToken.trim() && !TG_TOKEN_RE.test(tgToken.trim()) ? TG_TOKEN_ERROR : null;
  const isTgUser = channel === 'tguser';
  const apiIdError = isTgUser ? tgApiIdError(tgApi.apiId) : null;
  const apiHashError = isTgUser ? tgApiHashError(tgApi.apiHash) : null;

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (e) => {
    e?.preventDefault();
    setTouched(true);
    if (!name.trim() || lineIdError || tgTokenError || apiIdError || apiHashError || busy) return;
    setBusy(true);
    try {
      let acc = await api.createAccount({ name: name.trim(), channel });
      // LINE：号建好后再存填了的配置。存失败（已提示）时号照样建好了，到号详情里改
      const linePatch = Object.fromEntries(Object.entries(line).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      if (channel === 'line' && Object.keys(linePatch).length) {
        try {
          const res = await api.putAccount(acc.id, { line: linePatch });
          if (res && res.id) acc = res;
        } catch {
          // 已提示
        }
      }
      // Telegram：同上，token 填了才存（同一个机器人已经给别的号用了时这里报错，号照样建好）
      if (isTg && tgToken.trim()) {
        try {
          const res = await api.putAccount(acc.id, { telegram: { botToken: tgToken.trim() } });
          if (res && res.id) acc = res;
        } catch {
          // 已提示
        }
      }
      const apiPatch = Object.fromEntries(Object.entries(tgApi).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      if (isTgUser && Object.keys(apiPatch).length) {
        try {
          const res = await api.putAccount(acc.id, { telegram: apiPatch });
          if (res && res.id) acc = res;
        } catch {
          // 已提示
        }
      }
      invalidateAccounts();
      toast.success('号码已添加，请完成连接');
      reset();
      onCreated(acc);
    } catch {
      // 已提示
    } finally {
      setBusy(false);
    }
  };

  // 单选组：左右方向键切换
  const onChannelKey = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = CHANNEL_OPTIONS.findIndex((o) => o.value === channel);
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = CHANNEL_OPTIONS[(i + step + CHANNEL_OPTIONS.length) % CHANNEL_OPTIONS.length];
    setChannel(next.value);
    e.currentTarget.querySelector(`[data-value="${next.value}"]`)?.focus();
  };

  const nameError = touched && !name.trim() ? '请填写名称' : null;

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加号码"
      width={640}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : <Plus />}
            添加
          </button>
        </>
      }
    >
      <form className="vstack" style={{ gap: 'var(--sp-4)' }} onSubmit={submit} noValidate>
        <Field label="名称" htmlFor="acc-name" error={nameError}>
          <input
            {...fieldProps('acc-name', nameError)}
            className="input"
            value={name}
            maxLength={40}
            placeholder="示例：售后专线"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="field">
          <div className="field__label-row">
            <span className="field__label" id="acc-channel-label">
              接入方式
            </span>
          </div>
          <div className="numbers-channel" role="radiogroup" aria-labelledby="acc-channel-label" onKeyDown={onChannelKey}>
            {CHANNEL_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                data-value={o.value}
                aria-checked={channel === o.value}
                tabIndex={channel === o.value ? 0 : -1}
                className="option-card"
                onClick={() => setChannel(o.value)}
              >
                <span className="option-card__title">{o.title}</span>
                <span className="option-card__desc">{o.desc}</span>
              </button>
            ))}
          </div>
          <div className="field__hint">添加后不可更改；变更接入方式需删除号码后重新添加。</div>
          {channel === 'waha' && <div className="field__hint">每个号码约占用 100–200MB 内存</div>}
        </div>
        {channel === 'line' && (
          <>
            <Callout tone="info">
              1. 在 LINE Developers Console 打开该官方帐号的 Messaging API channel：Basic settings 页面获取 Channel ID 与 Channel
              secret，Messaging API 页面底部签发长期 Channel access token。2. 添加后，将号码详情「连接」中的 Webhook URL 填入 Messaging
              API 页面的 Webhook URL，并开启「Use webhook」。以上三项可留空，稍后在「连接」中填写。
            </Callout>
            <Field label="Channel ID" htmlFor="acc-line-id" error={lineIdError} optional>
              <input
                {...fieldProps('acc-line-id', lineIdError)}
                className="input input--mono"
                value={line.channelId}
                inputMode="numeric"
                autoComplete="off"
                onChange={(e) => setLineField('channelId', e.target.value)}
              />
            </Field>
            <Field label="Channel secret" htmlFor="acc-line-secret" optional>
              <input
                id="acc-line-secret"
                type="password"
                className="input input--mono"
                value={line.channelSecret}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => setLineField('channelSecret', e.target.value)}
              />
            </Field>
            <Field label="Channel access token（长期）" htmlFor="acc-line-token" optional>
              <input
                id="acc-line-token"
                type="password"
                className="input input--mono"
                value={line.accessToken}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => setLineField('accessToken', e.target.value)}
              />
            </Field>
          </>
        )}
        {isTg && (
          <>
            {channel === 'tgbiz' ? (
              <Callout tone="warning">
                <strong>接入前须知：</strong>
                {'墨鸽将接收该 Telegram 帐号的全部私聊消息（「聊天自动化」中排除的聊天除外），包括亲友消息；开启自动回复时，机器人以本人身份回复。' +
                  '建议在「聊天自动化」中排除联系人、仅处理新聊天，或对该号码使用人工回复。机器人仅可回复 24 小时内发来消息的私聊。'}
              </Callout>
            ) : null}
            <Callout tone="info">
              {channel === 'tgbiz'
                ? '1. 在 Telegram 打开 @BotFather，发送 /newbot 创建该号码专用的机器人。2. 在 Bot Settings → Business Mode 中开启 Business Mode。添加后在「连接」中按步骤绑定号主，并在「聊天自动化」中添加机器人。'
                : '在 Telegram 打开 @BotFather，发送 /newbot 创建机器人，将返回的 token 填入下方。客户搜索机器人用户名即可发起会话。'}
              token 可留空，稍后在「连接」中填写。
            </Callout>
            <Field label="机器人 token" htmlFor="acc-tg-token" error={tgTokenError} optional>
              <input
                {...fieldProps('acc-tg-token', tgTokenError)}
                type="password"
                className="input input--mono"
                value={tgToken}
                placeholder="123456789:AA…"
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => setTgToken(e.target.value)}
              />
            </Field>
          </>
        )}
        {isTgUser && (
          <>
            <Callout tone="warning">
              <strong>接入前须知：</strong>
              {TGUSER_WARNING}
            </Callout>
            <Callout tone="info">
              api_id 和 api_hash 可留空，添加后在「连接」中自动获取；已有凭证可直接填入（my.telegram.org → API development tools）。
            </Callout>
            <Field label="api_id" htmlFor="acc-tg-api-id" error={apiIdError} optional>
              <input
                {...fieldProps('acc-tg-api-id', apiIdError)}
                className="input input--mono"
                value={tgApi.apiId}
                inputMode="numeric"
                placeholder="纯数字"
                autoComplete="off"
                onChange={(e) => setTgApi((v) => ({ ...v, apiId: e.target.value }))}
              />
            </Field>
            <Field label="api_hash" htmlFor="acc-tg-api-hash" error={apiHashError} optional>
              <input
                {...fieldProps('acc-tg-api-hash', apiHashError)}
                type="password"
                className="input input--mono"
                value={tgApi.apiHash}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => setTgApi((v) => ({ ...v, apiHash: e.target.value }))}
              />
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

// 号码配置导出 / 导入（admin）。文件格式见 docs/deviations.md 第 35 条，服务端还会完整校验一遍
const EXPORT_FORMAT = 'inkdove-accounts';
const EXPORT_VERSION = 1;

/** 和服务端的附件名一致：inkdove-accounts-YYYYMMDD.json（按导出时间的 UTC 日期） */
const exportFileName = (doc) => `inkdove-accounts-${String(doc.exportedAt || '').slice(0, 10).replace(/-/g, '')}.json`;

/** 本地先解析一遍，只为预览要建哪些号；格式不对直接在弹窗里提示，不上传 */
function previewImport(text) {
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (!doc || typeof doc !== 'object' || doc.format !== EXPORT_FORMAT) {
    throw new Error('非墨鸽导出的号码配置文件');
  }
  if (doc.version !== EXPORT_VERSION) {
    throw new Error(`不支持该文件版本（version: ${JSON.stringify(doc.version ?? null)}），仅支持 version ${EXPORT_VERSION}`);
  }
  if (!Array.isArray(doc.accounts)) throw new Error('文件中的 accounts 不是数组');
  return doc.accounts.map((a) => ({
    name: typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : '（未命名）',
    channel: a?.channel,
  }));
}

/** 导入弹窗：预览要新建的号 → 确认上传 → 显示新建和跳过的结果。文件和校验的错误都显示在弹窗里 */
function ImportModal({ pick, onClose, onPickAgain, onImported }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const items = pick.items || [];
  const hasWaha = items.some((a) => a.channel === 'waha');
  const hasMeta = items.some((a) => a.channel === 'meta');
  const hasLine = items.some((a) => a.channel === 'line');
  const hasTgBiz = items.some((a) => a.channel === 'tgbiz');
  const hasTgBot = items.some((a) => a.channel === 'tgbot');
  const hasTgUser = items.some((a) => a.channel === 'tguser');

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importAccounts(pick.file, { silent: true });
      setResult(res);
      if (res.created.length) toast.success(`已导入 ${res.created.length} 个号码`);
      onImported();
    } catch (err) {
      setError(err?.message || '导入失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  let body;
  let footer;
  if (result) {
    body = (
      <div className="vstack" style={{ gap: 'var(--sp-3)' }}>
        <div className="numbers-import__summary">
          已新建 {result.created.length} 个号码{result.skipped.length > 0 && `，跳过 ${result.skipped.length} 个`}
        </div>
        {result.skipped.length > 0 && (
          <ul className="numbers-import__list" aria-label="已跳过的号码">
            {result.skipped.map((s, i) => (
              <li key={i} className="numbers-import__item numbers-import__item--stack">
                <span className="numbers-import__name">{s.name}</span>
                <span className="numbers-import__reason">{s.reason}</span>
              </li>
            ))}
          </ul>
        )}
        {/* 导入时被自动调整过的号（比如没配发信方式，邮件通知被关掉了） */}
        {result.created.some((c) => c.notices?.length > 0) && (
          <ul className="numbers-import__list" aria-label="需注意的号码">
            {result.created
              .filter((c) => c.notices?.length > 0)
              .map((c) => (
                <li key={c.id} className="numbers-import__item numbers-import__item--stack">
                  <span className="numbers-import__name">{c.name}</span>
                  <span className="numbers-import__reason">{c.notices.join('；')}</span>
                </li>
              ))}
          </ul>
        )}
        {result.created.length > 0 && hasWaha && (
          <div className="field__hint">扫码接入的号码尚未连接，请在各号码的「连接」中扫码或使用配对码连接。</div>
        )}
        {result.created.length > 0 && hasTgUser && (
          <div className="field__hint">Telegram 扫码登录的号码尚未登录，请在各号码的「连接」中扫码登录。</div>
        )}
      </div>
    );
    footer = (
      <button type="button" className="btn btn--primary" onClick={onClose}>
        完成
      </button>
    );
  } else if (pick.error) {
    body = (
      <div className="vstack" style={{ gap: 'var(--sp-3)' }}>
        <Callout tone="danger">{pick.error}</Callout>
        <div className="field__hint">请选择从墨鸽「号码」页导出的 .json 文件。</div>
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={onPickAgain}>
          <Upload /> 重新选择文件
        </button>
      </>
    );
  } else if (!items.length) {
    body = <div className="muted">文件中无号码，无可导入内容。</div>;
    footer = (
      <button type="button" className="btn" onClick={onClose}>
        关闭
      </button>
    );
  } else {
    body = (
      <div className="vstack" style={{ gap: 'var(--sp-3)' }}>
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="numbers-import__summary">将新建 {items.length} 个号码</div>
        <ul className="numbers-import__list" aria-label="待新建的号码">
          {items.map((a, i) => (
            <li key={i} className="numbers-import__item">
              <span className="numbers-import__name">{a.name}</span>
              <span className="numbers-import__channel">{CHANNEL_LABEL[a.channel] || a.channel || '—'}</span>
            </li>
          ))}
        </ul>
        {hasWaha && <div className="field__hint">扫码接入的号码导入后需重新扫码或使用配对码连接。</div>}
        {hasMeta && (
          <div className="field__hint">
            Meta 号码导入后回调地址将变更，需在 Meta 开发者后台更新；phoneNumberId 与现有号码重复的将跳过。
          </div>
        )}
        {hasLine && (
          <div className="field__hint">
            LINE 官方帐号导入后 Webhook URL 将变更，需在 LINE Developers Console 更新；Channel ID 与现有号码重复的将跳过。
          </div>
        )}
        {(hasTgBot || hasTgBiz) && (
          <div className="field__hint">
            Telegram 号码导入后立即开始接收消息。同一机器人仅可在一处接收消息，请先在原墨鸽中删除或停用该号码；机器人已被其他号码使用的将跳过。
            {hasTgBiz && '私人号导入后需重新绑定号主，并在「聊天自动化」中重新添加机器人。'}
          </div>
        )}
        {hasTgUser && <div className="field__hint">Telegram 扫码登录的号码导入后需重新扫码登录：文件仅包含 api_id 和 api_hash，不含登录状态。</div>}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={close} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : <Upload />}
          导入
        </button>
      </>
    );
  }

  return (
    <Modal open onClose={close} title="导入号码配置" width={560} footer={footer}>
      {body}
    </Modal>
  );
}

const MODE_OPTIONS = REPLY_MODES.map(({ value, label }) => ({ value, label }));
const modeOrder = (a) => REPLY_MODES.findIndex((m) => m.value === replyModeOf(a));

/**
 * 回复方式列。admin：行内下拉（和原来的自动回复开关一样即时生效，以服务端返回为准）；agent：只显示文字（改号的设置是 403）。
 * 下拉的选项浮层挂在 body 上，React 事件仍会冒泡到表格行，这里拦住，免得选完就打开了号详情。
 */
function ReplyModeCell({ account, editable }) {
  const [pending, setPending] = useState(null);
  const saved = replyModeOf(account);
  if (!editable) return <span className="nowrap">{replyModeLabel(saved)}</span>;

  const change = async (next) => {
    if (next === saved || pending) return;
    setPending(next);
    try {
      const res = await api.putAccount(account.id, { replyMode: next });
      patchAccountCache(res && res.id ? res : { id: account.id, replyMode: next, autoReply: next === 'auto' });
      toast.success(`「${account.name}」的回复方式已改为「${replyModeLabel(next)}」`);
    } catch {
      // 已提示
    } finally {
      setPending(null);
    }
  };

  return (
    <span className="numbers-table__mode" onClick={(e) => e.stopPropagation()}>
      <Select
        size="sm"
        className="select--auto"
        value={pending ?? saved}
        onChange={change}
        options={MODE_OPTIONS}
        placeholder="—"
        disabled={pending !== null}
        aria-label={`「${account.name}」的回复方式`}
      />
      {pending !== null && <Spinner />}
    </span>
  );
}

export default function NumbersTab() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin } = useAuth();
  const { accounts, error, reload } = useAccounts();
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importPick, setImportPick] = useState(null); // {seq, file, items?, error?}
  const fileRef = useRef(null);
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');

  // 每 6 秒刷新连接状态；离开页面自动停止
  usePolling(() => reload(true), 6000, true);

  // 负责的业务员：成员列表只有 admin 能读
  useEffect(() => {
    if (!isAdmin) return;
    api
      .listUsers({ silent: true })
      .then((list) => setUsers(Array.isArray(list) ? list : []))
      .catch(() => setUsers([]));
  }, [isAdmin]);

  const agentsOf = useMemo(() => {
    const map = new Map();
    (users || []).forEach((u) => {
      if (u.role !== 'agent' || !Array.isArray(u.accountIds)) return;
      u.accountIds.forEach((id) => {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(u.name || u.email);
      });
    });
    return map;
  }, [users]);

  const filtered = useMemo(() => {
    if (!accounts) return null;
    const kw = q.trim().toLowerCase();
    return accounts.filter((a) => {
      if (stateFilter && stateGroup(a) !== stateFilter) return false;
      if (channelFilter && a.channel !== channelFilter) return false;
      if (!kw) return true;
      return [a.name, handleOf(a), a.status?.me?.pushName].some((s) => String(s || '').toLowerCase().includes(kw));
    });
  }, [accounts, q, stateFilter, channelFilter]);

  const onCreated = (acc) => {
    setAdding(false);
    reload(true);
    if (acc?.id) navigate(`/whatsapp/numbers/${encodeURIComponent(acc.id)}/connect`);
  };

  const columns = [
    {
      key: 'name',
      header: '名称',
      sortValue: (a) => a.name || '',
      render: (a) => (
        <CellText primary={a.name || '未命名号码'} secondary={handleOf(a) && <span className="num">{handleOf(a)}</span>} />
      ),
    },
    {
      key: 'channel',
      header: '接入方式',
      hide: 'md',
      sortValue: (a) => CHANNEL_LABEL[a.channel] || a.channel,
      render: (a) => <span className="nowrap">{CHANNEL_LABEL[a.channel] || a.channel}</span>,
    },
    {
      key: 'state',
      header: '状态',
      sortValue: (a) => waState(a.status?.state).label,
      render: (a) => {
        const st = waState(a.status?.state);
        return (
          <StatusDot tone={st.tone} pulse={st.pulse}>
            {st.label}
          </StatusDot>
        );
      },
    },
    {
      key: 'replyMode',
      header: '回复方式',
      shrink: true,
      sortValue: modeOrder,
      render: (a) => <ReplyModeCell account={a} editable={isAdmin} />,
    },
    isAdmin && {
      key: 'agents',
      header: '负责的业务员',
      hide: 'md',
      sortValue: (a) => (agentsOf.get(a.id) || []).join('、') || null,
      render: (a) => {
        const names = agentsOf.get(a.id) || [];
        if (users == null) return <span className="muted">…</span>;
        if (!names.length) return <span className="muted">—</span>;
        const text = names.join('、');
        return (
          <span className="ellipsis" title={text} style={{ display: 'block', maxWidth: 240 }}>
            {text}
          </span>
        );
      },
    },
    {
      key: 'lastAt',
      header: '最近消息时间',
      hide: 'sm',
      shrink: true,
      sortValue: (a) => (a.status?.lastWebhookAt ? new Date(a.status.lastWebhookAt).getTime() : null),
      render: (a) => {
        const iso = a.status?.lastWebhookAt;
        if (!iso) return <span className="numbers-table__time">—</span>;
        return (
          <Tooltip content={fullTime(iso)}>
            <span className="numbers-table__time">{shortTime(iso)}</span>
          </Tooltip>
        );
      },
    },
  ].filter(Boolean);

  const filtering = !!(q.trim() || stateFilter || channelFilter);
  const clearFilters = () => {
    setQ('');
    setStateFilter('');
    setChannelFilter('');
  };

  const addButton = isAdmin && (
    <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
      <Plus /> 添加号码
    </button>
  );

  const exportAll = async () => {
    const ok = await confirm({
      title: '导出号码配置',
      message: `将导出全部 ${accounts?.length ?? 0} 个号码的配置。\n文件包含 Meta token、LINE channel secret 与 access token、Telegram 机器人 token、代理密码等密钥明文，请妥善保管。`,
      confirmText: '导出',
    });
    if (!ok) return;
    setExporting(true);
    try {
      const doc = await api.exportAccounts();
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(doc);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`已导出 ${doc.accounts.length} 个号码的配置`);
    } catch {
      // 已提示
    } finally {
      setExporting(false);
    }
  };

  const pickImportFile = () => fileRef.current?.click();
  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同一个文件改完再选一次也能触发
    if (!file) return;
    const seq = Date.now();
    try {
      setImportPick({ seq, file, items: previewImport(await file.text()) });
    } catch (err) {
      setImportPick({ seq, file, error: err?.message || '读取文件失败，请重新选择' });
    }
  };

  const headerActions = isAdmin && (
    <>
      <Menu
        minWidth={160}
        tooltip="导出、导入号码配置"
        trigger={
          <button type="button" className="btn btn--ghost btn--icon" aria-label="导出、导入号码配置" disabled={exporting}>
            {exporting ? <Spinner /> : <MoreHorizontal />}
          </button>
        }
        items={[
          { label: '导出配置', icon: Download, onClick: exportAll, disabled: !accounts?.length },
          { label: '导入配置', icon: Upload, onClick: pickImportFile },
        ]}
      />
      {addButton}
    </>
  );

  let body;
  if (error && accounts == null) {
    body = <ErrorState error={error} onRetry={() => reload(true)} />;
  } else if (accounts && accounts.length === 0) {
    body = (
      <EmptyState
        fill
        icon={Smartphone}
        title={isAdmin ? '暂无号码' : '暂无已分配的号码'}
        desc={
          isAdmin
            ? '接入 WhatsApp、LINE 或 Telegram 号码后，客户消息进入「会话」，可使用推荐回复或自动回复。多个号码共用同一知识库。'
            : '请联系管理员分配号码。'
        }
        action={addButton}
      />
    );
  } else {
    body = (
      <>
        <TableToolbar search={q} onSearch={setQ} searchPlaceholder="搜索名称或号码" count={filtered ? filtered.length : null}>
          <Select
            size="sm"
            className="select--auto"
            value={stateFilter}
            onChange={setStateFilter}
            options={STATE_FILTERS}
            aria-label="按状态筛选"
          />
          <Select
            size="sm"
            className="select--auto"
            value={channelFilter}
            onChange={setChannelFilter}
            options={CHANNEL_FILTERS}
            aria-label="按接入方式筛选"
          />
        </TableToolbar>
        <DataTable
          label="号码"
          columns={columns}
          rows={filtered}
          onRowClick={(a) => navigate(`/whatsapp/numbers/${encodeURIComponent(a.id)}/connect`)}
          empty={
            <EmptyState
              compact
              title={filtering ? '无符合条件的号码' : '暂无号码'}
              action={
                filtering && (
                  <button type="button" className="btn btn--sm" onClick={clearFilters}>
                    清除筛选
                  </button>
                )
              }
            />
          }
        />
      </>
    );
  }

  return (
    <div className="page">
      <PageHeader title="号码" count={accounts?.length || null} actions={headerActions} />
      {body}
      {isAdmin && <AddAccountModal open={adding} onClose={() => setAdding(false)} onCreated={onCreated} />}
      {isAdmin && <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onImportFile} />}
      {importPick && (
        <ImportModal
          key={importPick.seq}
          pick={importPick}
          onClose={() => setImportPick(null)}
          onPickAgain={pickImportFile}
          onImported={() => {
            invalidateAccounts();
            reload(true);
          }}
        />
      )}
    </div>
  );
}
