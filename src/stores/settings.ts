/** 全局偏好（主题、侧栏开合、右面板开合、路线网络栏开合），持久化到 localStorage */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

const THEME_KEY = 'retroweb_theme';
const SIDEBAR_KEY = 'retroweb_sidebar_collapsed';
const ASIDE_KEY = 'retroweb_aside_collapsed';
const DISCLAIMER_KEY = 'retroweb_hide_disclaimer';
const SCHEMES_KEY = 'retroweb_schemes_collapsed';

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
  /**
   * 是否已关闭「模型预测可能存在幻觉」这条合规提示。
   * 关掉后不再顶在主区顶部（可在「目标分析」总览页重新打开）—— 提示是合规要求，
   * 但每次进任务都占一行、且看久了会变噪音，所以给用户一个「我知道了」的出口，而不是硬钉着。
   */
  const hideDisclaimer = ref(readFlag(DISCLAIMER_KEY, false));
  /**
   * 「路线网络」栏（`SchemeBar`）是否收起。
   *
   * 🔴 为什么默认**展开**、且必须落盘：这块栏夹在页签与画布之间，它的高度直接从
   *    画布扣。收起是"我此刻更想看画布"的临时诉求，不是长期偏好 ⇒ 默认展开；
   *    但用户既然主动收过一次，下次进来还替他展开就等于每次都白折一遍。
   *    与 `sidebarCollapsed` / `asideCollapsed` 同一套语义（落盘 + 刷新保持）。
   */
  const schemesCollapsed = ref(readFlag(SCHEMES_KEY, false));

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
  watch(hideDisclaimer, (v) => writeFlag(DISCLAIMER_KEY, v));
  watch(schemesCollapsed, (v) => writeFlag(SCHEMES_KEY, v));

  apply();

  return {
    isDark,
    sidebarCollapsed,
    asideCollapsed,
    hideDisclaimer,
    schemesCollapsed,
    toggle,
    setDark,
    apply
  };
});
