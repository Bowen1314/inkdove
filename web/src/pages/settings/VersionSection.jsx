import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { fmtFull } from '../../lib/format.js';
import { SOURCE_REPO_URL, loadUpdateStatus, openUpdateModal, setUpdateStatus, useUpdateState } from '../../lib/update.js';
import { ErrorState, SkeletonRows, Spinner } from '../../ui/common.jsx';
import { SettingsRow, SettingsSection } from '../../ui/Settings.jsx';

/** 检查结果：成功绿点（有新版本蓝点），失败红点加原因 */
function resultOf(s) {
  if (s.error) return { tone: 'danger', text: `检查失败：${s.error}` };
  if (s.available) return { tone: 'info', text: `有新版本 v${s.latest.version}` };
  return { tone: 'success', text: '已经是最新版本' };
}

/** 版本：当前版本、上次检查时间、「检查更新」。有新版本时点开 Layout 里的更新弹窗 */
export default function VersionSection() {
  const { status: s } = useUpdateState();
  const [loadError, setLoadError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');

  const load = () => {
    setLoadError(null);
    loadUpdateStatus().catch(setLoadError);
  };
  useEffect(load, []);

  const check = async () => {
    setChecking(true);
    setCheckError('');
    try {
      setUpdateStatus(await api.checkUpdate({ silent: true }));
    } catch (e) {
      setCheckError(e.message || '检查失败');
    } finally {
      setChecking(false);
    }
  };

  let content;
  if (!s && loadError) content = <ErrorState compact error={loadError} onRetry={load} />;
  else if (!s) content = <SkeletonRows rows={2} />;
  else {
    const result = checkError ? { tone: 'danger', text: checkError } : s.checkedAt || s.error ? resultOf(s) : null;
    content = (
      <>
        <SettingsRow label="当前版本">
          <div className="settings-page__test">
            <span className="num">v{s.current}</span>
            {s.available && (
              <button type="button" className="btn btn--sm" onClick={openUpdateModal}>
                查看新版本 v{s.latest.version}
              </button>
            )}
          </div>
          <div className="settings-page__note">
            <a className="btn btn--link btn--muted btn--sm" href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer">
              源代码 · AGPL-3.0
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </SettingsRow>
        <SettingsRow label="上次检查">
          <div className="settings-page__test">
            {s.checkEnabled ? (
              <span>{s.checkedAt ? fmtFull(s.checkedAt) : '还没检查过'}</span>
            ) : (
              <span className="muted">已关闭检查（INKDOVE_UPDATE_CHECK=0）</span>
            )}
            {s.checkEnabled && (
              <button type="button" className="btn btn--sm" onClick={check} disabled={checking}>
                {checking ? <Spinner /> : <RefreshCw />}
                {checking ? '正在检查…' : '检查更新'}
              </button>
            )}
          </div>
          {result && (
            <div className={`test-result status status--${result.tone} settings-page__result`} role="status">
              <span className="status__dot" aria-hidden="true" />
              <span>{result.text}</span>
            </div>
          )}
        </SettingsRow>
      </>
    );
  }

  return <SettingsSection title="版本">{content}</SettingsSection>;
}
