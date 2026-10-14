import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../../api/client.js';
import { ErrorState, PageHeader, SkeletonRows } from '../../ui/common.jsx';
import { SettingsLayout } from '../../ui/Settings.jsx';
import LlmSection from './LlmSection.jsx';
import EmbeddingSection from './EmbeddingSection.jsx';
import RerankSection from './RerankSection.jsx';
import ReplySettingsSection from './ReplySettingsSection.jsx';
import SuggestSection from './SuggestSection.jsx';
import TranslationSection from './TranslationSection.jsx';
import MediaSection from './MediaSection.jsx';
import LeadsSection from './LeadsSection.jsx';
import EmailSection from './EmailSection.jsx';
import BrandSection from './BrandSection.jsx';
import OutreachSection from './OutreachSection.jsx';
import BlockwordsSection from './BlockwordsSection.jsx';
import PricingSection from './PricingSection.jsx';
import ProxySection from './ProxySection.jsx';
import VersionSection from './VersionSection.jsx';

/** 分组子导航，每组一个子路由。「品牌」「版本」放最后。 */
const NAV = [
  { to: '/settings/llm', label: 'AI 模型' },
  { to: '/settings/embedding', label: '向量检索和重排' },
  { to: '/settings/reply', label: '回复' },
  { to: '/settings/suggest', label: '推荐回复' },
  { to: '/settings/translation', label: '翻译' },
  { to: '/settings/media', label: '语音和图片' },
  { to: '/settings/leads', label: '客户线索' },
  { to: '/settings/email', label: '发信方式' },
  { to: '/settings/outreach', label: '主动外联' },
  { to: '/settings/blockwords', label: '屏蔽词' },
  { to: '/settings/pricing', label: '模型单价' },
  { to: '/settings/proxy', label: '代理' },
  { to: '/settings/brand', label: '品牌' },
  { to: '/settings/version', label: '版本' },
];

const GROUPS = ['llm', 'embedding', 'reply', 'suggest', 'translation', 'media', 'leads', 'email', 'outreach', 'blockwords', 'pricing', 'proxy', 'brand', 'version'];

/** /settings 进来时去第一组；兼容旧的锚点写法 /settings#email */
function SettingsIndex() {
  const { hash } = useLocation();
  const group = hash.replace(/^#/, '');
  return <Navigate to={`/settings/${GROUPS.includes(group) ? group : 'llm'}`} replace />;
}

/**
 * /settings/*（admin）。每组各自保存：PUT /api/settings 只带自己那一块，返回完整设置后统一更新。
 * 新分组的写法：在这个目录新建 XxxSection.jsx，接收 {settings, onSaved}，
 * 草稿用 shared.jsx 的 useSliceDraft，外层用 ui/Settings.jsx 的 SettingsSection + SettingsRow + SaveBar，
 * 再在 NAV 和下面的 <Routes> 里各加一项。
 */
export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  const refreshHealth = useCallback(() => {
    api
      .health({ silent: true })
      .then(setHealth)
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSettings(await api.getSettings({ silent: true }));
    } catch (e) {
      setError(e);
    }
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    load();
  }, [load]);

  // PUT 返回完整设置；万一只回了一部分，就和现有的合并
  const onSaved = useCallback((res) => {
    if (res && typeof res === 'object') setSettings((prev) => ({ ...(prev || {}), ...res }));
  }, []);

  let content;
  if (error) {
    content = <ErrorState error={error} onRetry={load} />;
  } else if (!settings) {
    content = <SkeletonRows rows={5} />;
  } else {
    const props = { settings, onSaved };
    content = (
      <Routes>
        <Route index element={<SettingsIndex />} />
        <Route path="llm" element={<LlmSection {...props} health={health} refreshHealth={refreshHealth} />} />
        <Route
          path="embedding"
          element={
            <>
              <EmbeddingSection {...props} />
              <RerankSection {...props} />
            </>
          }
        />
        <Route path="reply" element={<ReplySettingsSection {...props} />} />
        <Route path="suggest" element={<SuggestSection {...props} />} />
        <Route path="translation" element={<TranslationSection {...props} />} />
        <Route path="media" element={<MediaSection {...props} />} />
        <Route path="leads" element={<LeadsSection {...props} />} />
        <Route path="email" element={<EmailSection {...props} />} />
        <Route path="outreach" element={<OutreachSection {...props} />} />
        <Route path="blockwords" element={<BlockwordsSection {...props} />} />
        <Route path="pricing" element={<PricingSection {...props} />} />
        <Route path="proxy" element={<ProxySection {...props} />} />
        <Route path="brand" element={<BrandSection {...props} />} />
        <Route path="version" element={<VersionSection />} />
        <Route path="*" element={<Navigate to="/settings/llm" replace />} />
      </Routes>
    );
  }

  return (
    <div className="page">
      <PageHeader title="设置" />
      <SettingsLayout nav={NAV}>{content}</SettingsLayout>
    </div>
  );
}
