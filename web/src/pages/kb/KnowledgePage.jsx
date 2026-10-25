import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { MessagesSquare, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { PageHeader } from '../../ui/common.jsx';
import { Drawer } from '../../ui/Drawer.jsx';
import { Tooltip } from '../../ui/Popover.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import DistillTab from './DistillTab.jsx';
import EntriesTab, { ProfileTab } from './EntriesTab.jsx';
import GapsTab from './GapsTab.jsx';
import RedteamTab from './RedteamTab.jsx';
import TestChat, { TestChatClear, useTestChat } from './TestChat.jsx';

/**
 * 知识库。资料已搬到「文件 → 知识库资料」（F15）；admin 在「条目」「整理」也能直接上传，存的是同一处。
 * admin：条目 / 企业画像 / 缺口 / 整理 / 红线体检；agent：条目和企业画像（只读）。两种角色都能用测试对话。
 * 测试对话面板宽 420，切换标签时保持打开：≥1280 时挤窄内容、不加遮罩；更窄时是带遮罩的抽屉。
 */
export default function KnowledgePage() {
  const { tab } = useParams();
  const { isAdmin } = useAuth();
  const wide = useMediaQuery('(min-width: 1280px)');
  const [stats, setStats] = useState(null);
  const [testOpen, setTestOpen] = useState(false);
  const [slot, setSlot] = useState(null);
  const chat = useTestChat();
  const toggleRef = useRef(null);
  const mainRef = useRef(null);

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

  // 内容区自己滚动，换标签时回到顶部
  useEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
  }, [tab]);

  const tabs = isAdmin
    ? [
        { key: 'entries', to: '/kb/entries', label: '条目', count: stats?.entries },
        { key: 'profile', to: '/kb/profile', label: '企业画像' },
        { key: 'gaps', to: '/kb/gaps', label: '缺口', count: stats?.openGaps, alert: true },
        { key: 'distill', to: '/kb/distill', label: '蒸馏' },
        { key: 'redteam', to: '/kb/redteam', label: '红线体检' },
      ]
    : [
        { key: 'entries', to: '/kb/entries', label: '条目' },
        { key: 'profile', to: '/kb/profile', label: '企业画像' },
      ];

  if (!tabs.some((t) => t.key === tab)) return <Navigate to="/kb/entries" replace />;

  const docked = testOpen && wide;
  const closeTest = () => {
    setTestOpen(false);
    // 抽屉关闭时自己把焦点还回去；侧栏模式手动还给"测试对话"按钮
    if (wide) setTimeout(() => toggleRef.current?.focus(), 0);
  };

  return (
    <div className={`page page--fill kb-page${docked ? ' kb-page--docked' : ''}`}>
      <div className="kb-page__main" ref={mainRef}>
        <PageHeader
          title="知识库"
          tabs={tabs.map(({ to, label, count, alert }) => ({ to, label, count, alert }))}
          actions={
            <>
              <button
                ref={toggleRef}
                type="button"
                className="btn kb-page__test-toggle"
                aria-pressed={testOpen}
                aria-label="测试对话"
                onClick={() => (testOpen ? closeTest() : setTestOpen(true))}
              >
                <MessagesSquare />
                <span className="kb-page__test-label">测试对话</span>
              </button>
              <span ref={setSlot} className="kb-page__slot" />
            </>
          }
        />
        <div className="kb-page__body">
          {tab === 'entries' && <EntriesTab onChanged={refreshStats} readOnly={!isAdmin} actionsSlot={slot} />}
          {tab === 'profile' && <ProfileTab readOnly={!isAdmin} />}
          {tab === 'gaps' && <GapsTab onChanged={refreshStats} />}
          {tab === 'distill' && <DistillTab onChanged={refreshStats} actionsSlot={slot} />}
          {tab === 'redteam' && <RedteamTab actionsSlot={slot} />}
        </div>
      </div>

      {docked && (
        <aside
          className="kb-page__panel"
          aria-label="测试对话"
          onKeyDown={(e) => {
            // 面板里弹出的条目详情是挂在 body 上的对话框，它的 Esc 不归这里管
            if (e.key === 'Escape' && !e.defaultPrevented && e.currentTarget.contains(e.target)) closeTest();
          }}
        >
          <div className="kb-page__panel-head">
            <h2 className="kb-page__panel-title">测试对话</h2>
            <TestChatClear chat={chat} />
            <Tooltip content="关闭">
              <button type="button" className="btn btn--ghost btn--icon" onClick={closeTest} aria-label="关闭测试对话">
                <X />
              </button>
            </Tooltip>
          </div>
          <TestChat chat={chat} autoFocus />
        </aside>
      )}

      {!wide && (
        <Drawer
          open={testOpen}
          onClose={closeTest}
          title="测试对话"
          size="narrow"
          className="kb-test-drawer"
          headerExtra={<TestChatClear chat={chat} />}
        >
          <TestChat chat={chat} />
        </Drawer>
      )}
    </div>
  );
}
