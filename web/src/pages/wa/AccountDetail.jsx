import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal, useConfirm } from '../../ui/Modal.jsx';
import { ErrorState, Field, PageHeader, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { SettingsLayout, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { StatusDot } from '../../ui/StatusDot.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { invalidateAccounts, patchAccountCache } from '../../lib/accounts.js';
import { waState } from '../../lib/labels.js';
import ConnectSection from './account/ConnectSection.jsx';
import ReplySection, { NotifySection } from './account/ReplySection.jsx';

function RenameModal({ account, open, onClose, onSaved }) {
  const [name, setName] = useState(account.name || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setName(account.name || '');
  }, [open, account.name]);

  const save = async (e) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.putAccount(account.id, { name: name.trim() });
      onSaved(res && res.id ? res : { ...account, name: name.trim() });
      toast.success('已保存');
    } catch {
      // 已提示
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="修改号码名称"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={busy || !name.trim()}>
            {busy && <Spinner />}
            保存
          </button>
        </>
      }
    >
      <form onSubmit={save} noValidate>
        <Field label="名称" htmlFor="acc-rename">
          <input
            id="acc-rename"
            className="input"
            value={name}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </form>
    </Modal>
  );
}

/** 「删除号码」分组（admin） */
function DeleteGroup({ onDelete, deleting }) {
  return (
    <SettingsSection title="删除号码">
      <SettingsRow inline label="删除号码" hint="会话与客户线索保留。变更接入方式需删除后重新添加。">
        <button type="button" className="btn btn--danger" onClick={onDelete} disabled={deleting}>
          {deleting ? <Spinner /> : <Trash2 />}
          删除号码
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}

/** /whatsapp/numbers/:accountId/<分组> —— 号详情：连接、回复、通知、删除号码 */
export default function AccountDetail() {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin } = useAuth();
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccount(await api.getAccount(accountId, { silent: true }));
    } catch (e) {
      setError(e);
    }
  }, [accountId]);

  useEffect(() => {
    setAccount(null);
    load();
  }, [load]);

  // 全局设置只有 admin 能读：用来显示全局 persona 和判断是否配了发信方式
  useEffect(() => {
    if (!isAdmin) return;
    api
      .getSettings({ silent: true })
      .then(setGlobalSettings)
      .catch(() => {});
  }, [isAdmin]);

  const base = `/whatsapp/numbers/${encodeURIComponent(accountId)}`;
  const nav = [
    { to: `${base}/connect`, label: '连接' },
    { to: `${base}/reply`, label: '回复' },
    { to: `${base}/notify`, label: '通知' },
    isAdmin && { to: `${base}/delete`, label: '删除号码', danger: true },
  ].filter(Boolean);
  const listCrumb = { label: '号码', to: '/whatsapp/numbers' };

  if (error) {
    const known = error.status === 404 || error.status === 403;
    return (
      <div className="page numbers-detail">
        <PageHeader crumbs={[listCrumb, { label: '号码详情' }]} />
        <ErrorState
          title={error.status === 404 ? '号码不存在或已删除' : error.status === 403 ? '无权限查看该号码' : '加载失败'}
          error={known ? null : error}
          onRetry={known ? undefined : load}
        />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="page numbers-detail">
        <PageHeader crumbs={[listCrumb, { label: '加载中…' }]} />
        <SettingsLayout nav={nav}>
          <SkeletonRows rows={5} />
        </SettingsLayout>
      </div>
    );
  }

  const st = waState(account.status?.state);

  const remove = async () => {
    const ok = await confirm({
      title: `删除号码「${account.name}」？`,
      message: `删除后该号码停止收发消息${
        account.channel === 'waha' ? '，扫码登录将退出' : ''
      }，且无法恢复。会话与客户线索保留，所属号码显示为「（已删除）」，并从所有成员的负责范围中移除。`,
      confirmText: '删除号码',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.deleteAccount(account.id);
      invalidateAccounts();
      toast.success('号码已删除，会话记录已保留');
      navigate('/whatsapp/numbers', { replace: true });
    } catch {
      setDeleting(false);
    }
  };

  const toConnect = <Navigate to={`${base}/connect`} replace />;

  return (
    <div className="page numbers-detail">
      <PageHeader
        crumbs={[listCrumb, { label: account.name || '未命名号码' }]}
        actions={
          <>
            <StatusDot tone={st.tone} pulse={st.pulse}>
              {st.label}
            </StatusDot>
            {isAdmin && (
              <Tooltip content="修改名称">
                <button type="button" className="btn btn--ghost btn--icon" onClick={() => setRenaming(true)} aria-label="修改名称">
                  <Pencil />
                </button>
              </Tooltip>
            )}
          </>
        }
      />

      <SettingsLayout nav={nav}>
        <Routes>
          <Route index element={toConnect} />
          <Route path="connect" element={<ConnectSection account={account} setAccount={setAccount} isAdmin={isAdmin} />} />
          <Route
            path="reply"
            element={<ReplySection account={account} setAccount={setAccount} globalSettings={globalSettings} isAdmin={isAdmin} />}
          />
          <Route
            path="notify"
            element={<NotifySection account={account} setAccount={setAccount} globalSettings={globalSettings} isAdmin={isAdmin} />}
          />
          {isAdmin && <Route path="delete" element={<DeleteGroup onDelete={remove} deleting={deleting} />} />}
          <Route path="*" element={toConnect} />
        </Routes>
      </SettingsLayout>

      {isAdmin && (
        <RenameModal
          account={account}
          open={renaming}
          onClose={() => setRenaming(false)}
          onSaved={(a) => {
            setAccount((prev) => ({ ...prev, ...a }));
            patchAccountCache(a);
            setRenaming(false);
          }}
        />
      )}
    </div>
  );
}
