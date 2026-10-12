import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Compass, ShieldOff } from 'lucide-react';
import { api, setUnauthorizedHandler } from './api/client.js';
import { ToastHost } from './ui/Toast.jsx';
import { ConfirmProvider } from './ui/Modal.jsx';
import { ErrorState, EmptyState, Spinner } from './ui/common.jsx';
import { Layout } from './Layout.jsx';
import { AuthContext, useAuth } from './lib/auth.jsx';
import { BrandingProvider } from './lib/branding.jsx';
import { invalidateAccounts } from './lib/accounts.js';
import { clearEntryCache } from './lib/entryCache.js';
import Login from './pages/Login.jsx';
import InvitePage from './pages/Invite.jsx';
import Overview from './pages/Overview.jsx';
import Dashboard from './pages/Dashboard.jsx';
import KnowledgePage from './pages/kb/KnowledgePage.jsx';
import FilesPage from './pages/Files.jsx';
import WhatsAppPage, { WhatsAppIndex } from './pages/wa/WhatsAppPage.jsx';
import Outreach from './pages/Outreach.jsx';
import Leads from './pages/Leads.jsx';
import MembersPage from './pages/Members.jsx';
import SettingsPage from './pages/settings/SettingsPage.jsx';

/** 登录守卫：GET /api/auth/me → {user}，把 user 放进 AuthContext */
function RequireAuth({ children }) {
  const [state, setState] = useState('checking'); // checking | ok | error
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);

  const check = () => {
    setState('checking');
    api
      .me()
      .then((res) => {
        setUser(res?.user || null);
        setState('ok');
      })
      .catch((e) => {
        // 401 已由全局处理器跳转登录页
        if (e.status !== 401) {
          setError(e);
          setState('error');
        }
      });
  };

  useEffect(check, []);

  const ctx = useMemo(() => ({ user, setUser }), [user]);

  if (state === 'checking') {
    return (
      <div className="boot">
        <Spinner size={22} />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="boot">
        <ErrorState title="暂时无法打开后台" error={error} onRetry={check} />
      </div>
    );
  }
  return <AuthContext.Provider value={ctx}>{children}</AuthContext.Provider>;
}

/** 只有 admin 能进的页面。导航里已经隐藏，这里兜住直接输网址的情况。 */
function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  if (isAdmin) return children;
  return (
    <div className="page">
      <EmptyState
        fill
        icon={ShieldOff}
        title="没有权限"
        desc="这个页面只有管理员能使用。需要的话请联系管理员。"
        action={
          <Link className="btn btn--primary" to="/">
            返回概览
          </Link>
        }
      />
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState
        fill
        icon={Compass}
        title="页面不存在"
        desc="链接可能已失效，回到概览页继续操作。"
        action={
          <Link className="btn btn--primary" to="/">
            返回概览
          </Link>
        }
      />
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearEntryCache();
      invalidateAccounts();
      const here = window.location.pathname + window.location.search;
      if (window.location.pathname !== '/login' && !window.location.pathname.startsWith('/invite/')) {
        navigate('/login', { replace: true, state: { from: here } });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // 路由切换时回到顶部
  useEffect(() => {
    document.querySelector('.main')?.scrollTo?.(0, 0);
  }, [location.pathname]);

  return (
    <BrandingProvider>
      <ConfirmProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<Overview />} />
            <Route
              path="dashboard"
              element={
                <AdminOnly>
                  <Dashboard />
                </AdminOnly>
              }
            />
            <Route path="kb" element={<Navigate to="/kb/entries" replace />} />
            <Route path="kb/sources" element={<Navigate to="/files/sources" replace />} />
            <Route path="kb/:tab" element={<KnowledgePage />} />
            <Route path="files" element={<FilesPage />} />
            <Route path="files/:tab" element={<FilesPage />} />
            <Route path="whatsapp" element={<WhatsAppIndex />} />
            <Route path="whatsapp/connect" element={<Navigate to="/whatsapp/numbers" replace />} />
            <Route path="whatsapp/reply" element={<Navigate to="/whatsapp/numbers" replace />} />
            <Route path="whatsapp/numbers" element={<WhatsAppPage tab="numbers" />} />
            <Route path="whatsapp/numbers/:accountId/*" element={<WhatsAppPage tab="account" />} />
            <Route path="whatsapp/chats" element={<WhatsAppPage tab="chats" />} />
            <Route path="outreach/*" element={<Outreach />} />
            <Route path="leads/*" element={<Leads />} />
            <Route
              path="members"
              element={
                <AdminOnly>
                  <MembersPage />
                </AdminOnly>
              }
            />
            <Route
              path="settings/*"
              element={
                <AdminOnly>
                  <SettingsPage />
                </AdminOnly>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
        <ToastHost />
      </ConfirmProvider>
    </BrandingProvider>
  );
}
