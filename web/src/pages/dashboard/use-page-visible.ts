import { useEffect, useState } from 'react';

function currentlyVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/**
 * 页面可见性：标签页隐藏时暂停/降频轮询。
 * TanStack Query 的 refetchInterval 直接使用该值（false = 暂停）。
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(currentlyVisible);

  useEffect(() => {
    const onChange = (): void => setVisible(currentlyVisible());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
