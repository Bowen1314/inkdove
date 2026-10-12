import { useCallback, useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { PageHeader } from '../ui/common.jsx';
import { useAuth } from '../lib/auth.jsx';
import SourcesTab from './files/SourcesTab.jsx';
import SendableTab from './files/SendableTab.jsx';

/**
 * 文件页（F15），两个标签：
 * - /files/sources   知识库资料：原知识库页「资料」标签整块搬过来（admin）
 * - /files/sendable  产品资料（可发送）：agent 只能浏览和下载
 * 资料标签要往页头放"上传文件"，所以页头由各标签自己渲染：这里只给一个 header(actions) 函数。
 */
export default function FilesPage() {
  const { tab } = useParams();
  const { isAdmin } = useAuth();
  const [stats, setStats] = useState(null);

  const refreshStats = useCallback(() => {
    if (!isAdmin) return;
    api
      .kbStats({ silent: true })
      .then(setStats)
      .catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  const tabs = [
    isAdmin && { key: 'sources', to: '/files/sources', label: '知识库资料', count: stats?.sources },
    { key: 'sendable', to: '/files/sendable', label: '产品资料（可发送）' },
  ].filter(Boolean);

  if (!tabs.some((t) => t.key === tab)) return <Navigate to={tabs[0].to} replace />;

  const header = (actions) => <PageHeader title="文件" tabs={tabs} actions={actions} />;

  if (tab === 'sources') return <SourcesTab header={header} onChanged={refreshStats} />;

  return (
    <div className="page">
      {header()}
      <div className="files-page__body">
        <SendableTab />
      </div>
    </div>
  );
}
