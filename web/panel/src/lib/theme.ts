import { computed, ref, watch } from 'vue';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'mpanel.theme';

function initialMode(): ThemeMode {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  }
  return 'dark';
}

const mode = ref<ThemeMode>(initialMode());

function applyDocument(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.style.colorScheme = mode;
}

applyDocument(mode.value);

watch(mode, (next) => {
  applyDocument(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
});

export function useTheme() {
  return {
    mode,
    isDark: computed(() => mode.value === 'dark'),
    toggle(): void {
      mode.value = mode.value === 'dark' ? 'light' : 'dark';
    },
  };
}
