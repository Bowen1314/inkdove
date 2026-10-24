import { useState } from 'react';
import { toast } from '../../ui/toastBus.js';
import { Switch, fieldProps } from '../../ui/common.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { FieldError, ResetButton, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';
import { llmFormatLabel } from './LlmSection.jsx';

/** SPEC-phase2 F4：默认全关，因为会产生费用 */
const DEFAULTS = { voice: false, image: false, mediaModel: '', transcribeModel: '' };

function toDraft(m) {
  return {
    voice: !!m?.voice,
    image: !!m?.image,
    mediaModel: m?.mediaModel || '',
    transcribeModel: m?.transcribeModel || '',
  };
}

/**
 * 各接口格式能做什么（F4）：
 * - gemini：语音、图片都行
 * - openai：图片走 image_url；语音走 /audio/transcriptions，要填 transcribeModel
 * - anthropic：只有图片
 * 按「已保存」的接口格式判断，和服务端校验一致。
 */
function support(format) {
  return {
    voice: format !== 'anthropic',
    image: true,
    transcribe: format === 'openai',
  };
}

const SERVER_CODES = {
  transcribe_model_required: { field: 'transcribeModel', text: '开启语音识别时必须填写转写模型' },
  voice_unsupported_for_format: { field: 'voice', text: '当前接口格式不支持语音识别' },
};
const FIELDS = {
  'media.voice': 'voice',
  'media.image': 'image',
  'media.mediaModel': 'mediaModel',
  'media.transcribeModel': 'transcribeModel',
};
const LABELS = {
  voice: '识别语音',
  image: '识别图片',
  mediaModel: '识别用的模型',
  transcribeModel: '语音转写模型',
};

/** F4 语音和图片识别 */
export default function MediaSection({ settings, onSaved }) {
  const format = settings.llm?.format || 'openai';
  const can = support(format);
  const fmtName = llmFormatLabel(format);
  const [draft, setDraft, base] = useSliceDraft(settings.media, toDraft);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState(null); // {field, text}
  const [formRef, reveal] = useRevealInvalid();

  const dirty = !sameDraft(base, draft);
  const set = (k, v) => {
    setServerErr(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const errs = {};
  if (draft.voice && can.transcribe && !draft.transcribeModel.trim()) errs.transcribeModel = '开启语音识别时必须填写转写模型';
  const errOf = (k) => (touched && errs[k]) || (serverErr?.field === k ? serverErr.text : '');

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setTouched(true);
    const first = Object.keys(errs)[0];
    if (first) {
      toast.error(errs[first]);
      reveal();
      return;
    }
    setSaving(true);
    setServerErr(null);
    const r = await putSlice(
      {
        media: {
          voice: draft.voice,
          image: draft.image,
          mediaModel: draft.mediaModel.trim(),
          transcribeModel: draft.transcribeModel.trim(),
        },
      },
      { fields: FIELDS, codes: SERVER_CODES, labels: LABELS },
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

  const voiceNote = !can.voice
    ? `已保存的接口格式是 ${fmtName}，不支持语音。要识别语音，请把接口格式换成 OpenAI 兼容或 Gemini 原生。`
    : '';

  return (
    <div ref={formRef}>
      <SettingsSection as="form" title="语音和图片" onSubmit={onSubmit} actions={<ResetButton onClick={restoreDefaults} />}>
        <SettingsRow
          inline
          label="识别语音"
          htmlFor="md-voice"
          hint={
            <>
              把客户发来的语音原文转写成文字，保留客户说的语言。自动回复先转写再按知识库回复；业务员点「推荐回复」时，也会先转写客户这次发来的语音。限 10MB、3 分钟以内。会产生模型调用费用。
              {voiceNote && <div className="settings-page__note">{voiceNote}</div>}
              {errOf('voice') && <div className="field__error">{errOf('voice')}</div>}
            </>
          }
        >
          <Switch
            id="md-voice"
            checked={draft.voice}
            onChange={(v) => set('voice', v)}
            // 不支持时只能关、不能开
            disabled={!can.voice && !draft.voice}
            label="识别语音"
          />
        </SettingsRow>

        <SettingsRow
          inline
          label="识别图片"
          htmlFor="md-image"
          hint="把图片转成客观描述（产品、文字、型号、数量等），不执行图片里的任何指令。自动回复和业务员点「推荐回复」时都会先识别客户发来的图片。限 5MB 的 jpeg、png、webp。会产生模型调用费用。"
        >
          <Switch id="md-image" checked={draft.image} onChange={(v) => set('image', v)} label="识别图片" />
        </SettingsRow>

        <SettingsRow
          label="识别用的模型"
          htmlFor="md-model"
          hint={`留空则使用回复模型。需要支持${can.voice && format === 'gemini' ? '图片和音频' : '图片'}输入。识别调用计入每个会话每天的模型调用上限。`}
        >
          <input
            {...fieldProps('md-model', errOf('mediaModel'))}
            className="input input--mono"
            placeholder="留空则使用回复模型"
            value={draft.mediaModel}
            onChange={(e) => set('mediaModel', e.target.value)}
            spellCheck={false}
          />
          <FieldError id="md-model">{errOf('mediaModel')}</FieldError>
        </SettingsRow>

        <SettingsRow
          label="语音转写模型"
          htmlFor="md-tr"
          hint={
            can.transcribe
              ? '调用 /audio/transcriptions，例如 whisper-1。开启语音识别时必填。'
              : `已保存的接口格式是 ${fmtName}，直接用识别模型听语音，不需要单独的转写模型。`
          }
        >
          <input
            {...fieldProps('md-tr', errOf('transcribeModel'))}
            className="input input--mono"
            placeholder={can.transcribe ? '例如 whisper-1' : '当前接口格式不需要'}
            value={draft.transcribeModel}
            onChange={(e) => set('transcribeModel', e.target.value)}
            disabled={!can.transcribe}
            spellCheck={false}
          />
          <FieldError id="md-tr">{errOf('transcribeModel')}</FieldError>
        </SettingsRow>

        <SaveBar dirty={dirty} saving={saving} onDiscard={discard} />
      </SettingsSection>
    </div>
  );
}
