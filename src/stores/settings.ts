/** 全局偏好（主题等），持久化到 localStorage */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const THEME_KEY = 'retroweb_theme';

function readInitial(): boolean {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
  } catch {
    /* ignore */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export const useSettingsStore = defineStore('settings', () => {
  const isDark = ref(readInitial());
  const sidebarCollapsed = ref(false);

  function apply(): void {
    const root = document.documentElement;
    root.classList.toggle('dark', isDark.value);
    root.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
  }

  function toggle(): void {
    isDark.value = !isDark.value;
  }

  function setDark(value: boolean): void {
    isDark.value = value;
  }

  watch(isDark, (v) => {
    try {
      localStorage.setItem(THEME_KEY, v ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
    apply();
  });

  apply();

  return { isDark, sidebarCollapsed, toggle, setDark, apply };
});
