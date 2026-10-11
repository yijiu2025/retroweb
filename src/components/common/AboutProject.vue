<script setup lang="ts">
/**
 * 「关于本项目」区块 —— 项目介绍 + GitHub 仓库 + 打赏码。
 *
 * 🔴 单一组件复用：「运行设置」弹窗与「个人中心」页面展示的是同一份内容，
 *    所以文案/地址/图片全部来自 `@/config/about.ts`，本组件只负责渲染。
 *    两处各写一份必然漂移（改一次仓库地址漏改一处，界面上就自相矛盾）。
 *
 * @param compact 紧凑模式：设置弹窗里空间有限，只给一句话 + 仓库链接 + 折叠的打赏区
 */
import { ref } from 'vue';
// 🔴 图标必须**显式 import**：`unplugin-vue-components` 只扫 `.vue` 模板里
//    以 PascalCase 直接书写的标签，`<component :is="'Monitor'">` 这种字符串形式
//    它解析不到 ⇒ 渲染成空白（写完才发现的坑）。
import { Link, CoffeeCup } from '@element-plus/icons-vue';
import { REPO_URL, REPO_TAGLINE, REPO_INTRO, REPO_FEATURES, DONATE_CHANNELS, DONATE_OWNER, DONATE_NOTE, DONATE_MISSION, WECHAT_OFFICIAL } from '@/config/about';
// 🔴 复制必须走 `copyText` —— 它是全站唯一入口（utils/clipboard.ts），
//    内部已处理「非安全上下文 / 用户拒绝权限」的降级提示。
//    直接调 navigator.clipboard 在 http 访问下会静默失败，点了没反应。
import { copyText } from '@/utils/clipboard';

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

/** 打赏区是否展开：默认收起 —— 打赏是自愿行为，不该在用户没要求时占版面 */
const donateOpen = ref(false);

function copyRepo(): void {
  void copyText(REPO_URL, { okMsg: '仓库地址已复制' });
}
</script>

<template>
  <section class="about" :class="{ 'about--compact': compact }">
    <header class="about__head">
      <div class="about__titles">
        <div class="about__name">RetroWeb</div>
        <div class="about__tagline">{{ REPO_TAGLINE }}</div>
      </div>
      <el-button tag="a" :href="REPO_URL" target="_blank" rel="noopener noreferrer" type="primary" plain>
        <el-icon><Link /></el-icon>
        GitHub 仓库
      </el-button>
    </header>

    <!-- 仓库地址：给可点链接 + 可复制文本框，避免手机上长按选不全 -->
    <div class="about__repo">
      <el-input :model-value="REPO_URL" readonly class="about__repo-input">
        <template #append>
          <el-button @click="copyRepo">复制</el-button>
        </template>
      </el-input>
    </div>

    <!-- 介绍：紧凑模式只给第一段 -->
    <div v-for="(para, i) in compact ? REPO_INTRO.slice(0, 1) : REPO_INTRO" :key="i" class="about__para">
      {{ para }}
    </div>

    <ul v-if="!compact" class="about__features">
      <li v-for="f in REPO_FEATURES" :key="f" class="about__feature">{{ f }}</li>
    </ul>

    <el-divider class="about__divider" />

    <!-- 打赏：默认收起，主动展开才显示二维码 -->
    <div class="about__donate">
      <button type="button" class="about__donate-toggle" @click="donateOpen = !donateOpen">
        <span class="about__donate-label">
          <el-icon><CoffeeCup /></el-icon>
          自愿支持作者
        </span>
        <span class="about__donate-arrow" :class="{ 'is-open': donateOpen }">›</span>
      </button>

      <div v-show="donateOpen" class="about__donate-panel">
        <!-- 立场声明置顶：先说"为什么做"，再给"怎么支持"。 -->
        <blockquote class="about__mission">{{ DONATE_MISSION }}</blockquote>

        <div class="about__codes">
          <figure v-for="c in DONATE_CHANNELS" :key="c.key" class="about__code">
            <img :src="c.image" :alt="`${c.label}收款码`" loading="lazy" />
            <figcaption>
              <div class="about__code-label">{{ c.label }}</div>
              <div class="about__code-hint">{{ c.hint }}</div>
            </figcaption>
          </figure>
        </div>
        <div class="about__donate-meta">
          <div class="about__donate-owner">收款人：{{ DONATE_OWNER }}</div>
          <div class="about__donate-note">{{ DONATE_NOTE }}</div>
        </div>
      </div>
    </div>

    <!-- 公众号：与「自愿支持」平级但**不同性质** —— 关注是零门槛的关注，不是掏钱，
         所以单列一栏且不折叠（折叠起来等于把它藏起来）。 -->
    <div class="about__mp">
      <figure class="about__mp-figure">
        <img :src="WECHAT_OFFICIAL.image" :alt="`${WECHAT_OFFICIAL.name}公众号二维码`" loading="lazy" />
      </figure>
      <div class="about__mp-text">
        <div class="about__mp-title">
          关注公众号「{{ WECHAT_OFFICIAL.name }}」
        </div>
        <div class="about__mp-hint">{{ WECHAT_OFFICIAL.hint }}</div>
        <div class="about__mp-sub">微信搜索公众号名即可找到</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.about__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.about__name {
  font-size: 16px;
  font-weight: 700;
}

.about__tagline {
  font-size: 12px;
  color: var(--rw-text-3);
  margin-top: 2px;
}

/* 仓库地址输入框：等宽字体，让 URL 更好读 */
.about__repo-input :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.about__para {
  font-size: 13px;
  line-height: 1.75;
  color: var(--rw-text-2);
}

.about__features {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.about__feature {
  font-size: 12px;
  line-height: 1.6;
  color: var(--rw-text-2);
  padding: 3px 9px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
}

.about__divider {
  margin: 2px 0;
}

/* ---------- 打赏 ---------- */

.about__donate-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--rw-border);
  border-radius: 8px;
  background: transparent;
  color: var(--rw-text-2);
  font-size: 13px;
  cursor: pointer;
}

.about__donate-toggle:hover {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}

.about__donate-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 箭头只旋转，不换图标 */
.about__donate-arrow {
  display: inline-block;
  font-size: 18px;
  line-height: 1;
  transform: rotate(90deg);
  transition: transform 0.18s ease;
}

.about__donate-arrow.is-open {
  transform: rotate(-90deg);
}

.about__donate-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
}

/* 立场声明：左竖线引文块。比居中大字更克制，也不抢二维码的视觉重心。
   ⚠️ 底色必须用**两档都定义了的** token（--rw-brand-l：亮色 #eff6ff / 暗色 #14243f），
      别写死 rgba(0,0,0,.03) —— 暗色档下那层黑几乎看不见，等于没底色。 */
.about__mission {
  margin: 0;
  padding: 10px 14px;
  border-left: 2px solid var(--rw-brand);
  border-radius: 0 6px 6px 0;
  background: var(--rw-brand-l);
  font-size: 13px;
  line-height: 1.85;
  color: var(--rw-text-2);
}

.about__codes {
  /* 🔴 用 grid 而不是 flex-wrap：两列**等宽**且到窄屏自动塌成一列。
   *    flex + fixed 148px 在 390px 手机上仍能塞下两张（148×2+16=312），
   *    看着"没溢出"，实际每张只剩 148px —— **二维码会扫不出来**，
   *    而布局检查全绿、不会报任何错。所以宽度必须跟着容器走。 */
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

/* 窄屏：单列，每张二维码占到容器宽度（手机上是 200px+，可扫） */
@media (max-width: 520px) {
  .about__codes {
    grid-template-columns: minmax(0, 1fr);
    max-width: 240px;
  }
}

.about__code {
  margin: 0;
  /* ⚠️ 不写死 width —— 宽度由 grid 列决定（写死 148px 会覆盖列宽，
   *    窄屏塌成单列后仍只有 148px，扫不出来）。 */
  max-width: 220px;
  text-align: center;
}

.about__code img {
  width: 100%;
  height: auto;
  display: block;
  border: 1px solid var(--rw-border);
  border-radius: 8px;
  /* 二维码本身是黑白的，禁止被主题滤镜改变 —— 反色会导致扫不出来 */
  filter: none;
  background: #fff;
}

.about__code-label {
  font-size: 12px;
  font-weight: 600;
  margin-top: 6px;
}

.about__code-hint {
  font-size: 11px;
  color: var(--rw-text-3);
}

.about__donate-meta {
  font-size: 12px;
  color: var(--rw-text-3);
  line-height: 1.7;
}

.about__donate-owner {
  color: var(--rw-text-2);
}

/* ---------- 公众号 ---------- */

/* 横排：码在左、文字在右。零门槛的关注不该做成需要"展开才看见"的东西。 */
.about__mp {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: 8px;
}

.about__mp-figure {
  margin: 0;
  flex: none;
}

.about__mp-figure img {
  display: block;
  width: 84px;
  height: 84px;
  border-radius: 6px;
  /* 二维码必须保持黑白反白正常，否则扫不出来 */
  filter: none;
  background: #fff;
  border: 1px solid var(--rw-border);
}

.about__mp-text {
  min-width: 0;
}

.about__mp-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
}

.about__mp-hint {
  font-size: 12px;
  color: var(--rw-text-2);
  margin-top: 3px;
}

.about__mp-sub {
  font-size: 11px;
  color: var(--rw-text-3);
  margin-top: 2px;
}

/* 窄屏：改成竖排（横排在 390px 下二维码被挤到 84px 以下就不好扫了） */
@media (max-width: 520px) {
  .about__mp {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .about__mp-figure img {
    width: 132px;
    height: 132px;
  }
}
</style>
