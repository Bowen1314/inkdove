import { useState } from 'react';
import { toast } from '../../ui/toastBus.js';
import { fieldProps } from '../../ui/common.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, ResetButton, putSlice, sameDraft, useSliceDraft } from './shared.jsx';

/** 公司话术最多 4000 字（和服务端 suggest.companyPrompt 的上限一致） */
export const MAX_COMPANY_PROMPT = 4000;

const DEFAULTS = { companyPrompt: '' };
const FIELDS = { 'suggest.companyPrompt': 'companyPrompt' };
const LABELS = { companyPrompt: '公司话术' };

const PLACEHOLDER = `例如：
- 英文客户开头用 Dear + 名字，结尾署名「XX Trading Team」
- 语气专业、简洁，一段话不超过 3 句，不用表情
- 常用说法：Thanks for your inquiry / We will get back to you shortly`;

const toDraft = (s) => ({ companyPrompt: s?.companyPrompt || '' });

/** 推荐回复：公司话术（管理员写，所有人在会话页手动要的推荐回复都会带上） */
export default function SuggestSection({ settings, onSaved }) {
  const [draft, setDraft, base] = useSliceDraft(settings.suggest, toDraft);
  const [saving, setSaving] = useState(false);
  const [serverErr, setServerErr] = useState('');
  const dirty = !sameDraft(base, draft);
  const len = draft.companyPrompt.length;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setServerErr('');
    const r = await putSlice({ suggest: { companyPrompt: draft.companyPrompt.trim() } }, { fields: FIELDS, labels: LABELS });
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) setServerErr(r.fieldError.text);
      return;
    }
    onSaved(r.res);
    toast.success('已保存');
  };

  return (
    <SettingsSection
      as="form"
      title="推荐回复"
      onSubmit={onSubmit}
      actions={<ResetButton onClick={() => setDraft({ ...DEFAULTS })} disabled={sameDraft(draft, DEFAULTS)} />}
    >
      <SettingsRow
        label="公司话术"
        htmlFor="sg-company"
        hint="在会话页点「推荐回复」时，AI 按这里的要求起草：称呼、署名、语气、常用说法。每个人还可以在「我的话术」里加自己的习惯。"
        help="优先级：起草规则 > 公司话术 > 个人习惯，冲突时以前者为准。话术只管怎么说，不能让 AI 编造价格、交期和承诺；需要人拍板的地方 AI 仍会写成【待你确认：…】。"
      >
        <textarea
          {...fieldProps('sg-company', serverErr)}
          className="textarea"
          rows={8}
          maxLength={MAX_COMPANY_PROMPT}
          placeholder={PLACEHOLDER}
          value={draft.companyPrompt}
          onChange={(e) => {
            setServerErr('');
            setDraft({ companyPrompt: e.target.value });
          }}
        />
        <FieldError id="sg-company">{serverErr}</FieldError>
        <div className="settings-page__count num">
          {len} / {MAX_COMPANY_PROMPT}
        </div>
      </SettingsRow>

      <SaveBar dirty={dirty} saving={saving} onDiscard={() => setDraft(base)} />
    </SettingsSection>
  );
}
