import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import {
  BarChart3,
  BookOpen,
  ChevronsUpDown,
  Contact,
  FolderOpen,
  Home,
  KeyRound,
  LogOut,
  Megaphone,
  Menu as MenuIcon,
  MessagesSquare,
  ScrollText,
  Settings,
  Smartphone,
  UserRoundPen,
  Users,
} from 'lucide-react';
import { api } from './api/client.js';
import { clearEntryCache } from './lib/entryCache.js';
import { invalidateAccounts } from './lib/accounts.js';
import { useAuth } from './lib/auth.jsx';
import { useBranding } from './lib/branding.jsx';
import { roleLabel } from './lib/labels.js';
import { setPendingCount, usePendingCount } from './lib/inboxCount.js';
import { loadUpdateStatus, openUpdateModal, scheduleText, useUpdateState } from './lib/update.js';
import { usePolling } from './hooks/usePolling.js';
import { ChangePasswordModal } from './ui/ChangePasswordModal.jsx';
import { ProfileModal } from './ui/ProfileModal.jsx';
import { Avatar } from './ui/Avatar.jsx';
import { BrandMark } from './ui/BrandMark.jsx';
import { Menu, Tooltip } from './ui/Popover.jsx';
import { StatusDot } from './ui/StatusDot.jsx';
import { UpdateModal } from './ui/UpdateModal.jsx';
import { useDialogFocus } from './ui/overlay.js';

/** 导航分组见 DESIGN.md 第 3 节；adminOnly 的项对业务员直接不渲染 */
const NAV = [
  {
    items: [
      { to: '/', label: '概览', icon: Home, end: true },
      { to: '/whatsapp/chats', label: '会话', icon: MessagesSquare, badge: 'pending' },
      { to: '/outreach', label: '外联', icon: Megaphone },
      { to: '/leads', label: '客户', icon: Contact },
    ],
  },
  {
    label: '内容',
    items: [
      { to: '/kb', label: '知识库', icon: BookOpen },
      { to: '/files', label: '文件', icon: FolderOpen },
    ],
  },
  {
    label: '管理',
    items: [
      { to: '/whatsapp/numbers', label: '号码', icon: Smartphone },
      { to: '/dashboard', label: '看板', icon: BarChart3, adminOnly: true },
      { to: '/members', label: '成员', icon: Users, adminOnly: true },
      { to: '/audit', label: '操作日志', icon: ScrollText, adminOnly: true },
      { to: '/settings', label: '设置', icon: Settings, adminOnly: true },
    ],
  },
];

function SidebarContent({ isAdmin, user, company, mock, onLogout, onChangePassword, onEditProfile, onOpenUpdate }) {
  const pending = usePendingCount();
  const { status: update } = useUpdateState();
  const { displayTitle } = useBranding();
  const name = user?.name || user?.email || '未命名用户';
  return (
    <>
      <div className="sidebar__brand">
        <BrandMark />
        <div style={{ minWidth: 0 }}>
          <div className="sidebar__brand-name ellipsis">{displayTitle}</div>
          <div className="sidebar__brand-sub ellipsis">{company || '智能客服后台'}</div>
        </div>
      </div>

      <nav className="sidebar__nav" aria-label="主导航">
        {NAV.map((group, gi) => {
          const items = group.items.filter((n) => !n.adminOnly || isAdmin);
          if (items.length === 0) return null;
          return (
            <div key={gi} className="vstack" style={{ gap: 1 }}>
              {group.label && <div className="sidebar__group-label">{group.label}</div>}
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
                  <n.icon aria-hidden="true" />
                  <span>{n.label}</span>
                  {n.badge === 'pending' && pending > 0 && (
                    <span className="nav-item__count nav-item__count--alert" aria-label={`${pending} 个待处理`}>
                      {pending}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      <div className="sidebar__foot">
        {isAdmin && update?.schedule ? (
          <button type="button" className="sidebar__note sidebar__note--wrap" onClick={onOpenUpdate}>
            <StatusDot tone="info" pulse={!!update.schedule.startedAt} />
            <span>{scheduleText(update.schedule)}</span>
          </button>
        ) : (
          isAdmin &&
          update?.available && (
            <button type="button" className="sidebar__note" onClick={onOpenUpdate}>
              <StatusDot tone="info" />
              有新版本 v{update.latest.version}
            </button>
          )
        )}
        {mock && (
          <Tooltip content="不会调用真实的 AI 模型，整理结果和回复内容都是模拟的。正式使用前请联系部署人员关闭演示模式。">
            <button type="button" className="sidebar__note">
              <StatusDot tone="warning" />
              演示模式
            </button>
          </Tooltip>
        )}
        <Menu
          placement="top-start"
          minWidth={200}
          trigger={
            <button type="button" className="user-chip">
              <Avatar name={name} size="sm" />
              <span className="user-chip__text">
                <span className="user-chip__name">{name}</span>
                <span className="user-chip__role">{roleLabel(user?.role) === name && user?.email ? user.email : roleLabel(user?.role)}</span>
              </span>
              <ChevronsUpDown aria-hidden="true" />
            </button>
          }
          items={[
            user?.email && { heading: user.email },
            { label: '我的资料', icon: UserRoundPen, onClick: onEditProfile },
            { label: '修改密码', icon: KeyRound, onClick: onChangePassword },
            'sep',
            { label: '退出登录', icon: LogOut, onClick: onLogout },
          ]}
        />
      </div>
    </>
  );
}

/** 窄屏时从左边滑出的导航 */
function MobileNav({ open, onClose, children }) {
  const ref = useDialogFocus(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="drawer-layer">
      <div className="backdrop" onMouseDown={onClose} />
      <aside className="drawer drawer--left sidebar" role="dialog" aria-modal="true" aria-label="导航" ref={ref} tabIndex={-1}>
        {children}
      </aside>
    </div>,
    document.body,
  );
}

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, isAdmin } = useAuth();
  const { displayTitle } = useBranding();
  const [pwdOpen, setPwdOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [mock, setMock] = useState(false);
  const [company, setCompany] = useState('');

  useEffect(() => {
    api
      .health({ silent: true })
      .then((h) => setMock(!!h?.mock))
      .catch(() => {});
    api
      .getProfile({ silent: true })
      .then((p) => setCompany(p?.companyName || ''))
      .catch(() => {});
  }, []);

  // 侧栏的待处理数：会话页在时由会话页更新，这里 30 秒补一次
  usePolling(
    async () => {
      if (pathname.startsWith('/whatsapp/chats')) return;
      setPendingCount(await api.listConversations({}, { silent: true }));
    },
    30000,
    true,
    { immediate: true },
  );

  // 管理员：有没有新版本（服务端每 6 小时查一次 GitHub，这里只读它缓存的结果），1 小时补一次；
  // 有预约更新时每分钟一次，到点开始更新、更新完的结果能及时显示
  const { status: updateStatus } = useUpdateState();
  usePolling(loadUpdateStatus, updateStatus?.schedule ? 60_000 : 3600_000, isAdmin, { immediate: true });

  useEffect(() => setNavOpen(false), [pathname]);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // 退出失败也回登录页
    }
    clearEntryCache();
    invalidateAccounts();
    navigate('/login', { replace: true });
  };

  const sidebarProps = {
    isAdmin,
    user,
    company,
    mock,
    onLogout: logout,
    onChangePassword: () => setPwdOpen(true),
    onEditProfile: () => setProfileOpen(true),
    onOpenUpdate: () => {
      setNavOpen(false);
      openUpdateModal();
    },
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <SidebarContent {...sidebarProps} />
      </aside>

      <div className="shell__main">
        <header className="mobilebar">
          <button type="button" className="btn btn--ghost btn--icon" onClick={() => setNavOpen(true)} aria-label="打开导航">
            <MenuIcon />
          </button>
          <BrandMark />
          <span className="mobilebar__title">{displayTitle}</span>
        </header>
        <main className="main">
          <Outlet />
        </main>
      </div>

      <MobileNav open={navOpen} onClose={() => setNavOpen(false)}>
        <SidebarContent {...sidebarProps} />
      </MobileNav>
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      {isAdmin && <UpdateModal />}
    </div>
  );
}
