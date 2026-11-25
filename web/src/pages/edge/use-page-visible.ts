import { useEffect, useState } from 'react';

function currentlyVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/** 作业轮询在标签页隐藏时暂停（refetchInterval=false）。 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(currentlyVisible);

  useEffect(() => {
    const onChange = (): void => setVisible(currentlyVisible());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
