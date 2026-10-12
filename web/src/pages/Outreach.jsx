import { Navigate, Route, Routes } from 'react-router-dom';
import CampaignList from './outreach/CampaignList.jsx';
import CampaignNew from './outreach/CampaignNew.jsx';
import CampaignDetail from './outreach/CampaignDetail.jsx';

/**
 * 主动外联（F11）。路由注册为 /outreach/*：
 * /outreach 任务列表；/outreach/new 新建（三步）；/outreach/:id 任务详情。
 */
export default function Outreach() {
  return (
    <Routes>
      <Route index element={<CampaignList />} />
      <Route path="new" element={<CampaignNew />} />
      <Route path=":id" element={<CampaignDetail />} />
      <Route path="*" element={<Navigate to="/outreach" replace />} />
    </Routes>
  );
}
