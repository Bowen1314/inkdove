import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';

/**
 * 网站名称和 Logo（GET /api/branding，公开接口，登录页也要用）。
 * App 启动时拉一次；拉不到就用默认值，不弹错误。设置页改完后调 refresh()。
 */
export const DEFAULT_TITLE = 'KBWA';
const DEFAULT_DOC_TITLE = 'KBWA 智能客服后台';

// index.html 里原来的 favicon，没有自定义 Logo 时换回它。模块加载时记一次，StrictMode 重跑 effect 也不会记成 Logo
const originalIcon = typeof document !== 'undefined' ? document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null : null;

// 上次拿到的品牌存在本机，下次打开先用它，免得先闪一下默认名称。存取失败（隐私模式等）就当没有
const CACHE_KEY = 'kbwa.branding';
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return { title: typeof c?.title === 'string' ? c.title : '', logoUrl: typeof c?.logoUrl === 'string' && c.logoUrl ? c.logoUrl : null };
  } catch {
    return { title: '', logoUrl: null };
  }
}
function writeCache(brand) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(brand));
  } catch {
    // 存不了就算了
  }
}

const BrandingContext = createContext({ title: '', displayTitle: DEFAULT_TITLE, logoUrl: null, refresh: () => {} });

export function BrandingProvider({ children }) {
  const [brand, setBrand] = useState(readCache);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api.getBranding();
      if (mine !== seq.current) return;
      const next = {
        title: typeof r?.title === 'string' ? r.title.trim() : '',
        logoUrl: typeof r?.logoUrl === 'string' && r.logoUrl ? r.logoUrl : null,
      };
      setBrand(next);
      writeCache(next);
    } catch {
      // 静默：启动时就是默认值；之后刷新失败保留上一次拿到的
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 浏览器标签：没有自定义名称时保持原来的标题
  useEffect(() => {
    document.title = brand.title || DEFAULT_DOC_TITLE;
  }, [brand.title]);

  // favicon：有 Logo 用 Logo，没有就换回 index.html 原来的
  useEffect(() => {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) {
      if (!brand.logoUrl) return;
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    const href = brand.logoUrl || originalIcon;
    if (href) link.setAttribute('href', href);
    else link.remove();
  }, [brand.logoUrl]);

  const value = useMemo(
    () => ({ title: brand.title, displayTitle: brand.title || DEFAULT_TITLE, logoUrl: brand.logoUrl, refresh }),
    [brand, refresh],
  );
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** @returns {{title: string, displayTitle: string, logoUrl: string|null, refresh: () => Promise<void>}} */
export function useBranding() {
  return useContext(BrandingContext);
}
