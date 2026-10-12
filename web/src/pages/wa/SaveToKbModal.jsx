import { useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Modal } from '../../ui/Modal.jsx';
import { Select } from '../../ui/Select.jsx';
import { ErrorState, Field, Spinner, fieldProps } from '../../ui/common.jsx';
import { clearEntryCache } from '../../lib/entryCache.js';
import { ENTRY_TYPES } from '../../lib/labels.js';
import { parseTags } from '../../lib/format.js';

/** kb-draft 的返回可能是 {type,title,content,tags}，也可能包了一层 {entry:{…}} 或 {draft:{…}}，都接 */
function unwrapDraft(res) {
  const d = res?.entry || res?.draft || res || {};
  return {
    type: ENTRY_TYPES.some((t) => t.value === d.type) ? d.type : 'faq',
    title: d.title || '',
    content: d.content || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
  };
}

/**
 * F2b 人工回复一键存进知识库（admin）：
 * 1. POST /api/wa/conversations/:id/messages/:messageId/kb-draft → 改写好的条目（不落库）
 * 2. 弹窗里可编辑，确认后 POST /api/kb/entries，origin=conversation，
 *    sourceRefs=[{sourceId:null, sourceName:"会话：<客户名或号码>", quote:<人工回复前 200 字>}]
 */
export function SaveToKbModal({ conv, convId, message, question, onClose }) {
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ type: 'faq', title: '', content: '' });
  const [tagText, setTagText] = useState('');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  const load = async () => {
    if (!message) return;
    setState('loading');
    setError(null);
    try {
      const d = unwrapDraft(await api.kbDraft(convId, message.id));
      setForm({ type: d.type, title: d.title, content: d.content });
      setTagText(d.tags.join('，'));
      setTouched(false);
      setState('ready');
    } catch (e) {
      setError(e);
      setState('error');
    }
  };

  useEffect(() => {
    if (message) load();
    else setState('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const titleErr = touched && !form.title.trim() ? '请填写标题' : null;
  const contentErr = touched && !form.content.trim() ? '请填写内容' : null;
  const who = conv?.contactName || conv?.contactNumber || '客户';

  const save = async () => {
    setTouched(true);
    if (!form.title.trim() || !form.content.trim() || saving) return;
    setSaving(true);
    try {
      await api.createEntry({
        type: form.type,
        title: form.title.trim(),
        content: form.content.trim(),
        tags: parseTags(tagText),
        status: 'active',
        origin: 'conversation',
        sourceRefs: [{ sourceId: null, sourceName: `会话：${who}`, quote: String(message.text || '').slice(0, 200) }],
      });
      clearEntryCache();
      toast.success('已存进知识库，机器人之后能回答类似问题了');
      onClose();
    } catch {
      // 已提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!message}
      onClose={onClose}
      title="存进知识库"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={saving || state !== 'ready'}>
            {saving ? <Spinner /> : <Save />}
            保存为条目
          </button>
        </>
      }
    >
      {message && (
        <dl className="kv kb-save__src">
          {question && (
            <>
              <dt>客户问</dt>
              <dd className="pre-wrap">{question}</dd>
            </>
          )}
          <dt>人工答</dt>
          <dd className="pre-wrap">{message.text}</dd>
        </dl>
      )}

      {state === 'loading' && (
        <div className="hstack muted kb-save__wait" aria-live="polite">
          <Spinner /> 正在改写成通用的知识条目，并去掉客户个人信息…
        </div>
      )}
      {state === 'error' && <ErrorState compact title="改写失败" error={error} onRetry={load} />}
      {state === 'ready' && (
        <form
          className="form-grid kb-save__form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p className="field__hint field--full">已改写成通用说法并去掉了客户个人信息，保存前请再检查一遍。</p>
          <Field label="类型" htmlFor="kbs-type">
            <Select id="kbs-type" value={form.type} onChange={(v) => set('type', v)} options={ENTRY_TYPES} />
          </Field>
          <Field label="标签" htmlFor="kbs-tags" hint="用逗号分隔">
            <input id="kbs-tags" className="input" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </Field>
          <Field label="标题" htmlFor="kbs-title" className="field--full" error={titleErr}>
            <input {...fieldProps('kbs-title', titleErr)} className="input" value={form.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="内容" htmlFor="kbs-content" className="field--full" error={contentErr}>
            <textarea
              {...fieldProps('kbs-content', contentErr)}
              className="textarea"
              rows={7}
              value={form.content}
              onChange={(e) => set('content', e.target.value)}
            />
          </Field>
          <div className="field--full">
            <button type="button" className="btn btn--link btn--muted btn--sm" onClick={load}>
              <RefreshCw />
              重新改写
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
