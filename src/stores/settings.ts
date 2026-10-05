/** 全局偏好（主题、侧栏开合、右面板开合），持久化到 localStorage */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const THEME_KEY = 'retroweb_theme';
const SIDEBAR_KEY = 'retroweb_sidebar_collapsed';
const ASIDE_KEY = 'retroweb_aside_collapsed';

/** 读一个布尔偏好：只有明确存过 '1' / '0' 才认，否则用调用方给的默认值 */
function readFlag(key: string, fallback = false): boolean {
  try {
    const saved = localStorage.getItem(key);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

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
  /** 左侧导航栏是否收起（收起后只剩图标条） */
  const sidebarCollapsed = ref(readFlag(SIDEBAR_KEY, false));
  /** 右侧辅助面板是否收起（收起后整条不占宽度） */
  const asideCollapsed = ref(readFlag(ASIDE_KEY, false));

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

  // 开合状态落盘：刷新后保持用户上次的版式选择，不用每次重新收起
  watch(sidebarCollapsed, (v) => writeFlag(SIDEBAR_KEY, v));
  watch(asideCollapsed, (v) => writeFlag(ASIDE_KEY, v));

  apply();

  return { isDark, sidebarCollapsed, asideCollapsed, toggle, setDark, apply };
});
