import { EmptyState } from './common.jsx';

/** 占位：功能还没做完的页面或标签用。下一段补完时直接替换掉。 */
export function ComingSoon({ title = '即将上线', desc = '该功能正在开发中。' }) {
  return <EmptyState title={title} desc={desc} fill />;
}
