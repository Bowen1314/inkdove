import { PageHeader } from '../ui/common.jsx';
import { ComingSoon } from '../ui/ComingSoon.jsx';

/**
 * 主动外联（F11）。占位：下一段补完。
 * 路由注册为 /outreach/*，可以在这里用嵌套 <Routes> 加 /outreach/:id 等子页面，不用改 App.jsx。
 */
export default function Outreach() {
  return (
    <div className="page">
      <PageHeader title="外联" />
      <div className="page-body">
        <ComingSoon desc="主动外联正在开发中。" />
      </div>
    </div>
  );
}
