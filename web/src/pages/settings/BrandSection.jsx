import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { toast } from '../../ui/toastBus.js';
import { Spinner, fieldProps } from '../../ui/common.jsx';
import { BrandMark } from '../../ui/BrandMark.jsx';
import { SaveBar, SettingsRow, SettingsSection } from '../../ui/Settings.jsx';
import { DEFAULT_TITLE, useBranding } from '../../lib/branding.jsx';
import { FieldError, ResetButton, putSlice, sameDraft, useRevealInvalid, useSliceDraft } from './shared.jsx';

const MAX_TITLE = 40;
const MAX_LOGO = 512 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
// 有的系统选 .svg 时 file.type 是空的，按扩展名兜底
const LOGO_EXT = /\.(png|jpe?g|webp|svg)$/i;

const FIELDS = { 'branding.title': 'title' };
const LABELS = { title: '网站名称' };

const toDraft = (title) => ({ title: title || '' });

/** 上传前在前端先查一遍，不合格不发请求 → 错误文字或 '' */
function checkLogo(file) {
  const typeOk = LOGO_TYPES.includes(file.type) || (!file.type && LOGO_EXT.test(file.name));
  if (!typeOk) return '只支持 PNG、JPG、WebP 或 SVG 图片';
  if (file.size > MAX_LOGO) return '图片超过 512 KB，请压缩后再上传';
  return '';
}

/**
 * 品牌：网站名称走保存栏（PUT /api/settings {branding:{title}}）；
 * Logo 上传、移除立即生效，不进草稿。改完都通知全站刷新品牌。
 */
export default function BrandSection({ settings, onSaved }) {
  // 后端还没上线时没有 settings.branding，按默认值显示
  const branding = settings.branding || {};
  const brand = useBranding();
  // 草稿只跟名称走：上传 Logo 后拿到的新设置不会冲掉没保存的名称
  const [draft, setDraft, base] = useSliceDraft(branding.title ?? '', toDraft);
  const [saving, setSaving] = useState(false);
  const [titleErr, setTitleErr] = useState('');
  const [logoBusy, setLogoBusy] = useState(null); // 'upload' | 'remove'
  const [logoErr, setLogoErr] = useState('');
  const fileRef = useRef(null);
  const [formRef, reveal] = useRevealInvalid();

  const dirty = !sameDraft(base, draft);
  const logoSet = !!branding.logoSet;
  const logoUrl = logoSet ? branding.logoUrl || brand.logoUrl : null;

  const setTitle = (title) => {
    setTitleErr('');
    setDraft({ title });
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setTitleErr('');
    const r = await putSlice({ branding: { title: draft.title.trim() } }, { fields: FIELDS, labels: LABELS });
    setSaving(false);
    if (!r.res) {
      if (r.fieldError) {
        setTitleErr(r.fieldError.text);
        reveal();
      }
      return;
    }
    onSaved(r.res);
    brand.refresh();
    toast.success('已保存');
  };

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    // 清空，下次选同一个文件也能触发
    e.target.value = '';
    if (!file) return;
    const err = checkLogo(file);
    setLogoErr(err);
    if (err) return;
    setLogoBusy('upload');
    try {
      onSaved(await api.uploadBrandLogo(file));
      brand.refresh();
      toast.success('Logo 已更新');
    } catch (error) {
      // 已弹 Toast；原因同时写在字段下面
      if (error?.status !== 401) setLogoErr(error?.message || '上传失败');
    } finally {
      setLogoBusy(null);
    }
  };

  const removeLogo = async () => {
    setLogoErr('');
    setLogoBusy('remove');
    try {
      onSaved(await api.deleteBrandLogo());
      brand.refresh();
      toast.success('Logo 已移除');
    } catch {
      // 已提示
    } finally {
      setLogoBusy(null);
    }
  };

  return (
    <div ref={formRef}>
      <SettingsSection as="form" title="品牌" onSubmit={onSubmit} actions={<ResetButton onClick={() => setTitle('')} />}>
        <SettingsRow
          label="网站名称"
          htmlFor="brand-title"
          hint={`显示在侧边栏、登录页和浏览器标签上。留空使用默认名称 ${DEFAULT_TITLE}。`}
        >
          <input
            {...fieldProps('brand-title', titleErr)}
            className="input"
            placeholder={DEFAULT_TITLE}
            maxLength={MAX_TITLE}
            value={draft.title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <FieldError id="brand-title">{titleErr}</FieldError>
        </SettingsRow>

        <SettingsRow label="Logo" hint="PNG、JPG、WebP 或 SVG，不超过 512 KB，建议用正方形图片。也会用作浏览器标签图标。">
          <div className="settings-page__logo">
            <BrandMark logoUrl={logoUrl} className="settings-page__logo-preview" />
            <button
              type="button"
              className="btn"
              onClick={() => fileRef.current?.click()}
              disabled={!!logoBusy}
              aria-describedby={logoErr ? 'brand-logo-err' : undefined}
            >
              {logoBusy === 'upload' ? <Spinner /> : <Upload />}
              {logoBusy === 'upload' ? '上传中…' : '上传图片'}
            </button>
            {logoSet && (
              <button type="button" className="btn btn--ghost btn--danger" onClick={removeLogo} disabled={!!logoBusy}>
                {logoBusy === 'remove' ? '移除中…' : '移除'}
              </button>
            )}
            <input ref={fileRef} type="file" accept={LOGO_TYPES.join(',')} hidden onChange={onPick} />
          </div>
          <FieldError id="brand-logo">{logoErr}</FieldError>
        </SettingsRow>

        <SaveBar
          dirty={dirty}
          saving={saving}
          onDiscard={() => {
            setDraft(base);
            setTitleErr('');
          }}
        />
      </SettingsSection>
    </div>
  );
}
