import { useEffect, useRef, useState } from 'react';

/**
 * 拖文件到页面任意位置上传（文件页两个标签、知识库的「条目」「整理」共用）。
 * 文件拖进窗口时返回 true（显示"松开上传"），松开时把文件交给 onFiles。
 * 有对话框或抽屉开着（含确认框）、或 enabled=false 时不接文件，但仍拦住浏览器默认的"打开文件"。
 */
export function useWindowFileDrop(enabled, onFiles) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ enabled, onFiles });
  latest.current = { enabled, onFiles };

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const active = () => latest.current.enabled && !document.querySelector('.modal-layer, .drawer-layer');
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      if (active()) setDragging(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = active() ? 'copy' : 'none';
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (active()) latest.current.onFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    if (!enabled) setDragging(false);
  }, [enabled]);

  return dragging && enabled;
}
