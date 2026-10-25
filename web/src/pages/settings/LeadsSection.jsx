import { useState } from 'react';
import { toast } from '../../ui/toastBus.js';
import { Switch } from '../../ui/common.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { ResetButton, putSlice, sameDraft, useSliceDraft } from './shared.jsx';

/** SPEC-phase2 F6：全局 leads.enabled 默认为 true */
const DEFAULTS = { enabled: true };

const toDraft = (l) => ({ enabled: l?.enabled !== false });

/** F6 客户线索：自动提取开关。和其他分组一样改完点保存栏保存。 */
export default function LeadsSection({ settings, onSaved }) {
  const [draft, setDraft, base] = useSliceDraft(settings.leads, toDraft);
  const [saving, setSaving] = useState(false);
  const dirty = !sameDraft(base, draft);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const r = await putSlice({ leads: { enabled: draft.enabled } }, { labels: { enabled: '自动提取客户线索' } });
    setSaving(false);
    if (!r.res) return;
    onSaved(r.res);
    toast.success('已保存');
  };

  return (
    <SettingsSection
      as="form"
      title="客户线索"
      onSubmit={onSubmit}
      actions={<ResetButton onClick={() => setDraft({ ...DEFAULTS })} />}
    >
      <SettingsRow
        inline
        label="自动提取客户线索"
        htmlFor="ld-enabled"
        hint="客户停止发送消息 10 分钟后，提取姓名、公司、国家、意向产品、数量和阶段，写入「客户」页。产生模型调用费用。"
      >
        <Switch
          id="ld-enabled"
          checked={draft.enabled}
          onChange={(v) => setDraft({ enabled: v })}
          label="自动提取客户线索"
        />
      </SettingsRow>

      <SaveBar dirty={dirty} saving={saving} onDiscard={() => setDraft(base)} />
    </SettingsSection>
  );
}
