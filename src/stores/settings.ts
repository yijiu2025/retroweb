/** 全局偏好（主题、侧栏开合、右面板开合、路线网络栏开合、询价供应商），持久化到 localStorage */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { DEFAULT_SUPPLIER_ID, isSupplierId } from '@/utils/suppliers';

const THEME_KEY = 'retroweb_theme';
const SIDEBAR_KEY = 'retroweb_sidebar_collapsed';
const ASIDE_KEY = 'retroweb_aside_collapsed';
const DISCLAIMER_KEY = 'retroweb_hide_disclaimer';
const SCHEMES_KEY = 'retroweb_schemes_collapsed';
const SUPPLIER_KEY = 'retroweb_supplier';
const SUPPLIER_CAS_KEY = 'retroweb_supplier_prefer_cas';

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

/**
 * 读一个字符串偏好。
 *
 * 🔴 `valid` 不是可有可无的装饰：供应商 id 会**随清单增删**，而 localStorage 里的值
 *    是上一次会话写下的。不校验的话，删掉/改名后的 id 会让右面板的下拉显示空白
 *    （`el-select` 找不到对应 option），用户看到的是一格空白而不是"没选"。
 *    校验不过就落回默认值 —— 老值被静默丢弃，不影响使用。
 */
function readText(key: string, fallback: string, valid: (v: string) => boolean): string {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && valid(saved)) return saved;
  } catch {
    /* ignore */
  }
  return fallback;
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

const useSettingsStore = defineStore('settings', () => {
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
  /**
   * 查价默认用哪家供应商（`utils/suppliers.ts` 里的 id）。
   *
   * 为什么是全局偏好而不是任务参数：同一个人问价，习惯用的还是那一两家，
   * 逐任务重设等于每开一个任务都要重选一遍。卡片上的询价入口仍可当场改选别家
   * （改选**不**动这个默认值 —— 那是"这次换一家看看"，不是"以后都换"）。
   */
  const supplierId = ref(readText(SUPPLIER_KEY, DEFAULT_SUPPLIER_ID, isSupplierId));
  /**
   * 查价时优先用 CAS 号（而非 SMILES）。
   *
   * 默认**开**：试剂商的目录本来就按 CAS / 货号建索引，CAS 能直接搜到；
   * SMILES 在它们那儿只是一串没人认识的字符（详见 utils/suppliers.ts 文件头）。
   * 只对 `prefers:'cas'` 的平台有效 —— 结构式检索平台本来就不吃 CAS。
   */
  const supplierPreferCas = ref(readFlag(SUPPLIER_CAS_KEY, true));

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
  watch(supplierId, (v) => {
    try {
      localStorage.setItem(SUPPLIER_KEY, v);
    } catch {
      /* ignore */
    }
  });
  watch(supplierPreferCas, (v) => writeFlag(SUPPLIER_CAS_KEY, v));

  apply();

  return {
    isDark,
    sidebarCollapsed,
    asideCollapsed,
    hideDisclaimer,
    schemesCollapsed,
    supplierId,
    supplierPreferCas,
    toggle,
    setDark,
    apply
  };
});

export { useSettingsStore };
