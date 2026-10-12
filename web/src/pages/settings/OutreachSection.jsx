import { useState } from 'react';
import { toast } from '../../ui/toastBus.js';
import { fieldProps } from '../../ui/common.jsx';
import { Advanced, SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { OUTREACH_DEFAULTS, withOutreachDefaults } from '../outreach/shared.jsx';
import { FieldError, ResetButton, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

/**
 * F11 主动外联：settings.outreach 的全部字段。每个号每天的上限放在外面；间隔和发送时段收进「高级设置」（DESIGN 第 6 节）。
 * 后端还没有 outreach 字段时显示 SPEC 默认值（30、90、240、09:00、20:00），保存时整块写入。
 */

const FIELDS = {
  'outreach.dailyCapPerAccount': 'dailyCapPerAccount',
  'outreach.minIntervalSeconds': 'minIntervalSeconds',
  'outreach.maxIntervalSeconds': 'maxIntervalSeconds',
  'outreach.windowStart': 'windowStart',
  'outreach.windowEnd': 'windowEnd',
};
const LABELS = {
  dailyCapPerAccount: '每个号每天最多发',
  minIntervalSeconds: '最短间隔（秒）',
  maxIntervalSeconds: '最长间隔（秒）',
  windowStart: '发送时段开始',
  windowEnd: '发送时段结束',
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function toDraft(o) {
  const v = withOutreachDefaults(o);
  return {
    dailyCapPerAccount: String(v.dailyCapPerAccount),
    minIntervalSeconds: String(v.minIntervalSeconds),
    maxIntervalSeconds: String(v.maxIntervalSeconds),
    windowStart: String(v.windowStart),
    windowEnd: String(v.windowEnd),
  };
}

const DEFAULT_DRAFT = toDraft(OUTREACH_DEFAULTS);

const isInt = (s) => /^\d+$/.test(String(s).trim());

function validate(d) {
  const e = {};
  const cap = Number(d.dailyCapPerAccount);
  if (!isInt(d.dailyCapPerAccount) || cap < 1 || cap > 10000) e.dailyCapPerAccount = '请填 1–10000 之间的整数';
  const min = Number(d.minIntervalSeconds);
  const max = Number(d.maxIntervalSeconds);
  if (!isInt(d.minIntervalSeconds) || min < 1 || min > 86400) e.minIntervalSeconds = '请填 1–86400 之间的整数';
  if (!isInt(d.maxIntervalSeconds) || max < 1 || max > 86400) e.maxIntervalSeconds = '请填 1–86400 之间的整数';
  else if (!e.minIntervalSeconds && min > max) e.maxIntervalSeconds = '不能小于最短间隔';
  if (!HHMM.test(d.windowStart.trim())) e.windowStart = '格式是 HH:MM，例如 09:00';
  if (!HHMM.test(d.windowEnd.trim())) e.windowEnd = '格式是 HH:MM，例如 20:00';
  return e;
}

export default function OutreachSection({ settings, onSaved }) {
  const [draft, setDraft, base] = useSliceDraft(settings.outreach, toDraft);
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
        outreach: {
          dailyCapPerAccount: Number(draft.dailyCapPerAccount),
          minIntervalSeconds: Number(draft.minIntervalSeconds),
          maxIntervalSeconds: Number(draft.maxIntervalSeconds),
          windowStart: draft.windowStart.trim(),
          windowEnd: draft.windowEnd.trim(),
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
    setDraft({ ...DEFAULT_DRAFT });
  };

  const numInput = (k, id, label) => (
    <input
      {...fieldProps(id, errOf(k))}
      className="input num settings-outreach__num"
      type="number"
      inputMode="numeric"
      min={1}
      step={1}
      aria-label={label}
      value={draft[k]}
      onChange={(e) => set(k, e.target.value)}
    />
  );

  const timeInput = (k, id, label) => (
    <input
      {...fieldProps(id, errOf(k))}
      className="input num settings-outreach__time"
      inputMode="numeric"
      maxLength={5}
      placeholder={OUTREACH_DEFAULTS[k]}
      aria-label={label}
      value={draft[k]}
      onChange={(e) => set(k, e.target.value)}
    />
  );

  return (
    <div ref={formRef}>
      <SettingsSection as="form" title="主动外联" onSubmit={onSubmit} actions={<ResetButton onClick={restoreDefaults} />}>
        <SettingsRow
          label="每个号每天最多发"
          htmlFor="or-cap"
          hint="所有外联任务合计。到了上限当天就不再发，第二天接着发。"
        >
          <div className="settings-outreach__inline">
            {numInput('dailyCapPerAccount', 'or-cap')}
            <span className="muted">条</span>
          </div>
          <FieldError id="or-cap">{errOf('dailyCapPerAccount')}</FieldError>
        </SettingsRow>

        <Advanced>
          <SettingsRow label="发送间隔（秒）" htmlFor="or-min" hint="同一个号每发一条，在这个范围里随机等一会儿再发下一条。">
            <div className="settings-outreach__inline">
              {numInput('minIntervalSeconds', 'or-min', '最短间隔（秒）')}
              <span className="muted">至</span>
              {numInput('maxIntervalSeconds', 'or-max', '最长间隔（秒）')}
            </div>
            {errOf('minIntervalSeconds') ? (
              <FieldError id="or-min">{errOf('minIntervalSeconds')}</FieldError>
            ) : (
              <FieldError id="or-max">{errOf('maxIntervalSeconds')}</FieldError>
            )}
          </SettingsRow>
          <SettingsRow label="发送时段" htmlFor="or-start" hint="按收件人当地时间，用号码的国家码判断时区。">
            <div className="settings-outreach__inline">
              {timeInput('windowStart', 'or-start', '发送时段开始')}
              <span className="muted">至</span>
              {timeInput('windowEnd', 'or-end', '发送时段结束')}
            </div>
            {errOf('windowStart') ? (
              <FieldError id="or-start">{errOf('windowStart')}</FieldError>
            ) : (
              <FieldError id="or-end">{errOf('windowEnd')}</FieldError>
            )}
          </SettingsRow>
        </Advanced>

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>
    </div>
  );
}
