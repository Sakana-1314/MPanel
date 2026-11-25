import { computed, onActivated, onDeactivated, ref } from 'vue';
import { useDocumentVisibility } from '@vueuse/core';

/**
 * 页面是否处于前台：当前工作台标签激活且浏览器窗口可见。
 * KeepAlive 缓存的隐藏标签仍保持挂载，轮询/WS 必须据此暂停。
 */
export function usePageActive() {
  const activated = ref(true);
  const visibility = useDocumentVisibility();
  onActivated(() => {
    activated.value = true;
  });
  onDeactivated(() => {
    activated.value = false;
  });
  return computed(() => activated.value && visibility.value === 'visible');
}
