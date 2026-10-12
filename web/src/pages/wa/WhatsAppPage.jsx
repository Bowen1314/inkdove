import { Navigate, useLocation } from 'react-router-dom';
import NumbersTab from './NumbersTab.jsx';
import AccountDetail from './AccountDetail.jsx';
import ChatsTab from './ChatsTab.jsx';

/**
 * /whatsapp 入口。通知里的链接是 /whatsapp?chat=<encodeURIComponent(conversationId)>，
 * conversationId 形如 <accountId>:<chatId>。带 chat 参数时打开「会话」并选中，否则也进「会话」。
 */
export function WhatsAppIndex() {
  const { search } = useLocation();
  const chat = new URLSearchParams(search).get('chat');
  if (chat) return <Navigate to={`/whatsapp/chats?${new URLSearchParams({ chat }).toString()}`} replace />;
  return <Navigate to="/whatsapp/chats" replace />;
}

/**
 * 「会话」和「号码」在导航里是两个独立的项（DESIGN.md 第 3 节），路由沿用 /whatsapp/*。
 * tab: chats（会话）| numbers（号码列表）| account（某个号的详情，子路由 connect/reply/notify/delete）
 * 号码列表和详情各自渲染整页（含页面头部）。
 */
export default function WhatsAppPage({ tab }) {
  if (tab === 'chats') return <ChatsTab />;
  if (tab === 'account') return <AccountDetail />;
  return <NumbersTab />;
}
