import { useState } from 'react';
import { toast } from '../../ui/toastBus.js';
import { Switch, fieldProps } from '../../ui/common.jsx';
import { Advanced, SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, ResetButton, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/** SPEC-phase2「新的全局 GET /api/settings」里的默认值 */
const DEFAULTS = { persona: '', debounceSeconds: '4', maxBotRepliesPerChatPerHour: '20', humanize: true };

const FIELDS = {
  'reply.persona': 'persona',
  'reply.debounceSeconds': 'debounceSeconds',
  'reply.maxBotRepliesPerChatPerHour': 'maxBotRepliesPerChatPerHour',
  'reply.humanize': 'humanize',
};
const LABELS = {
  persona: '默认 persona',
  debounceSeconds: '合并等待时间',
  maxBotRepliesPerChatPerHour: '每会话每小时自动回复上限',
  humanize: '拟人化回复',
};

function toDraft(r) {
  return {
    persona: r?.persona || '',
    debounceSeconds: String(r?.debounceSeconds ?? 4),
    maxBotRepliesPerChatPerHour: String(r?.maxBotRepliesPerChatPerHour ?? 20),
    humanize: r?.humanize !== false,
  };
}

function validate(d) {
  const e = {};
  const deb = Number(d.debounceSeconds);
  if (d.debounceSeconds.trim() === '' || !Number.isFinite(deb) || deb < 0 || deb > 120) e.debounceSeconds = '请输入 0–120 的数字';
  const max = Number(d.maxBotRepliesPerChatPerHour);
  if (!Number.isInteger(max) || max < 1 || max > 1000) e.maxBotRepliesPerChatPerHour = '请输入 1–1000 的整数';
  return e;
}

/** 全局回复：默认 persona、防抖、每会话每小时上限、F1 回复像真人 */
export default function ReplySettingsSection({ settings, onSaved }) {
  const [draft, setDraft, base] = useSliceDraft(settings.reply, toDraft);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState(null); // {field, text}
  const [formRef, reveal] = useRevealInvalid();

  const dirty = !sameDraft(base, draft);
  const errs = validate(draft);
  const errOf = (k) => (touched && errs[k]) || (serverErr?.field === k ? serverErr.text : '');
  const set = (k, v) => {
    if (serverErr?.field === k) setServerErr(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setTouched(true);
    const first = Object.keys(errs)[0];
    if (first) {
      toast.error(`${LABELS[first]}：${errs[first]}`);
      reveal();
      return;
    }
    setSaving(true);
    setServerErr(null);
    const r = await putSlice(
      {
        reply: {
          persona: draft.persona.trim(),
          debounceSeconds: Number(draft.debounceSeconds),
          maxBotRepliesPerChatPerHour: Number(draft.maxBotRepliesPerChatPerHour),
          humanize: draft.humanize,
        },
      },
      { fields: FIELDS, labels: LABELS },
    );
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        setServerErr(r.fieldError);
        reveal();
      }
      return;
    }
    onSaved(r.res);
    setTouched(false);
    toast.success('已保存');
  };

  const discard = () => {
    setDraft(base);
    setTouched(false);
    setServerErr(null);
  };

  const restoreDefaults = () => {
    setServerErr(null);
    setDraft({ ...DEFAULTS });
  };

  return (
    <div ref={formRef}>
      <SettingsSection as="form" title="回复" onSubmit={onSubmit} actions={<ResetButton onClick={restoreDefaults} />}>
        <SettingsRow
          label="默认 persona（语气和身份）"
          htmlFor="rs-persona"
          hint="对所有号码生效；号码详情中单独设置了 persona 的以号码设置为准。仅影响语气和称呼，不改变仅依据知识库回答的规则。"
        >
          <textarea
            {...fieldProps('rs-persona', errOf('persona'))}
            className="textarea"
            rows={3}
            placeholder="示例：你是 XX 公司的客服小王，语气热情专业。"
            value={draft.persona}
            onChange={(e) => set('persona', e.target.value)}
          />
          <FieldError id="rs-persona">{errOf('persona')}</FieldError>
        </SettingsRow>

        <SettingsRow
          inline
          label="拟人化回复"
          htmlFor="rs-humanize"
          hint="先标记已读并显示正在输入，按字数延迟数秒后发送。仅对自动回复的消息生效；转人工的消息保持未读。"
        >
          <Switch id="rs-humanize" checked={draft.humanize} onChange={(v) => set('humanize', v)} label="拟人化回复" />
        </SettingsRow>

        <Advanced>
          <SettingsRow
            label="合并等待时间（秒）"
            htmlFor="rs-deb"
            hint="客户连续发送多条消息时，在此时长内无新消息后合并回复。"
          >
            <input
              {...fieldProps('rs-deb', errOf('debounceSeconds'))}
              className="input num"
              style={{ maxWidth: 160 }}
              type="number"
              inputMode="decimal"
              min={0}
              max={120}
              value={draft.debounceSeconds}
              onChange={(e) => set('debounceSeconds', e.target.value)}
            />
            <FieldError id="rs-deb">{errOf('debounceSeconds')}</FieldError>
          </SettingsRow>
          <SettingsRow
            label="每会话每小时自动回复上限"
            htmlFor="rs-max"
            hint="超出后该会话转人工并暂停自动回复，防止与其他机器人循环对话。"
          >
            <input
              {...fieldProps('rs-max', errOf('maxBotRepliesPerChatPerHour'))}
              className="input num"
              style={{ maxWidth: 160 }}
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              value={draft.maxBotRepliesPerChatPerHour}
              onChange={(e) => set('maxBotRepliesPerChatPerHour', e.target.value)}
            />
            <FieldError id="rs-max">{errOf('maxBotRepliesPerChatPerHour')}</FieldError>
          </SettingsRow>
        </Advanced>

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>
    </div>
  );
}
