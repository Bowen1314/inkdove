import { PageHeader } from '../ui/common.jsx';
import { ComingSoon } from '../ui/ComingSoon.jsx';

/** 看板（F12，admin）。占位：下一段补完。 */
export default function Dashboard() {
  return (
    <div className="page">
      <PageHeader title="看板" />
      <div className="page-body">
        <ComingSoon desc="数据看板正在开发中。" />
      </div>
    </div>
  );
}
