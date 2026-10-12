import { PageHeader } from '../ui/common.jsx';
import { ComingSoon } from '../ui/ComingSoon.jsx';

/**
 * 客户线索（F6）。占位：下一段补完。
 * 路由注册为 /leads/*，可以在这里加 /leads/:id 或用查询参数打开抽屉，不用改 App.jsx。
 */
export default function Leads() {
  return (
    <div className="page">
      <PageHeader title="客户" />
      <div className="page-body">
        <ComingSoon desc="客户线索表正在开发中。" />
      </div>
    </div>
  );
}
