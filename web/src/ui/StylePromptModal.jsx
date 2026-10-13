import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../lib/auth.jsx';
import { toast } from './toastBus.js';
import { Modal } from './Modal.jsx';
import { Callout, Field, Spinner } from './common.jsx';

/** 个人话术最多 2000 字（和服务端 users.style_prompt 的上限一致） */
export const MAX_STYLE_PROMPT = 2000;

const PLACEHOLDER = `例如：
- 开头直接称呼客户名字，结尾署名 Tom
- 句子短一点，少用感叹号
- 西班牙语客户用 usted 称呼`;

/**
 * 「我的话术」：PUT /api/auth/me/style-prompt {stylePrompt}，所有角色都能改自己的。
 * 当前值来自 AuthContext 里的 user.stylePrompt（GET /api/auth/me 才带），保存后用返回的 user 更新它。
 */
export function StylePromptModal({ open, onClose }) {
  const { user, setUser } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setText(user?.stylePrompt || '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = text !== (user?.stylePrompt || '');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.putStylePrompt(text.trim());
      const next = res?.user || res;
      if (next && next.id) setUser({ ...user, ...next });
      else setUser({ ...user, stylePrompt: text.trim() });
      toast.success('我的话术已保存');
      onClose();
    } catch (err) {
      setError(err?.message || '保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="我的话术"
      width={560}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" form="style-form" className="btn btn--primary" disabled={busy || !dirty}>
            {busy ? <Spinner /> : <Save />}
            保存
          </button>
        </>
      }
    >
      <form id="style-form" className="vstack" style={{ gap: 16, alignItems: 'stretch' }} onSubmit={submit} noValidate>
        <Field
          label="我的说话习惯"
          htmlFor="style-prompt"
          aside={
            <span className="muted text-sm num">
              {text.length} / {MAX_STYLE_PROMPT}
            </span>
          }
          hint="AI 起草推荐回复时照这里的习惯写：自动起草用会话负责人的，你点「推荐回复」「换一条」时用你的。优先级：起草规则 > 公司话术 > 我的话术，冲突时以前者为准。话术只管怎么说，不能让 AI 编价格、交期和承诺，要你拍板的地方仍会写成【待你确认：…】。"
        >
          <textarea
            id="style-prompt"
            className="textarea"
            rows={7}
            maxLength={MAX_STYLE_PROMPT}
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Modal>
  );
}
