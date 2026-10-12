import { useState } from 'react';
import { useBranding } from '../lib/branding.jsx';

/**
 * 品牌标识：有自定义 Logo 时显示图片（无底色，圆角同原来），否则是默认的方块标识。
 * 侧栏、手机顶栏、登录和邀请页共用。size: 'md'（24）| 'lg'（32，登录页）。
 * logoUrl 传了就用它（设置页预览），不传用全站的品牌设置。图片加载失败时退回默认标识。
 */
export function BrandMark({ size = 'md', logoUrl, className = '' }) {
  const brand = useBranding();
  const src = logoUrl !== undefined ? logoUrl : brand.logoUrl;
  const [failed, setFailed] = useState(null);
  const cls = `brand-mark${size === 'lg' ? ' brand-mark--lg' : ''}${className ? ` ${className}` : ''}`;

  if (src && failed !== src) {
    return <img className={`${cls} brand-mark--image`} src={src} alt="" aria-hidden="true" onError={() => setFailed(src)} />;
  }
  return (
    <span className={cls} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <path d="M5 7h14M5 12h9M5 17h11" />
      </svg>
    </span>
  );
}
