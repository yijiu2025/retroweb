/**
 * 项目元信息 —— **关于本项目的一切静态文案**。
 *
 * 🔴 为什么要单独一个文件：GitHub 地址、项目介绍、打赏码这些会同时出现在
 *    「运行设置」弹窗、「个人中心」页面和 README 三处。原先打算各写一份，
 *    但那意味着改一次仓库地址要改三个地方、漏一处就自相矛盾（用户看到的
 *    两个二维码指向不同收款人这种事，最伤信任）。故收敛成单一来源。
 *
 * 打赏码图片本身放在 `public/donate/`（Vite 原样拷贝，不进产物哈希）。
 * ⚠️ `donate` 是「自愿支持」，不是任何功能的前置条件 —— 界面上不暗示
 *    「不给钱就不能用」，也别把它做成弹窗或遮罩。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */

/** 仓库地址（GitHub） */
const REPO_URL = 'https://github.com/yijiu2025/retroweb';

/** 一句话介绍（用于标题旁与折叠态） */
const REPO_TAGLINE = '一行一化合物 · 多次一步交互式逆合成';

/** 项目详细介绍（设置/个人中心里展开显示）。
 *  🔴 **不能用 Markdown 语法**（`**加粗**`）：Vue 模板直接插值渲染，不解析 Markdown，
 *     用户会看到一串星号（实测截图才发现）。要强调就用分段 + 组件样式。 */
const REPO_INTRO = [
  'RetroWeb 是一套开箱即用的逆合成路线工作台：输入一个目标产物，模型逐步给出前体拆分路线，你可以逐步干预、编辑、比较，并把走通的路线存成多个方案对照。',
  '后端算法基于 RDKit 与 Retro* 类搜索模型，支持两种调用形态——浏览器内 RDKit 本地解析（CDXML 除外）与后端 Python 服务解析；也支持一步预测与「自动往下拆到底」的整段搜索两种交互。前端为 Vue 3 + TypeScript，可离线部署，也可经 Node 中转把任务与端点配置按用户落库。'
];

/** 功能要点（设置/个人中心里以标签列出） */
const REPO_FEATURES = [
  '逐步可干预的逆合成拆分',
  'Retro* 整段搜索（预算可控）',
  '多路线方案对照与复用',
  'LLM 工艺分析与自由追问',
  'CAS / 分子式 / 分子量一键复制',
  '浏览器内 RDKit 本地解析',
  '任务本地或按用户落库',
  '暗色 / 手机窄屏适配'
];

/** 打赏渠道。图片放 public/donate/，路径以 / 开头（Vite 会原样拷贝） */
const DONATE_CHANNELS = [
  {
    key: 'wechat',
    label: '微信',
    hint: '扫码向作者转账',
    image: '/donate/wechat.png'
  },
  {
    key: 'alipay',
    label: '支付宝',
    hint: '扫码向作者转账',
    image: '/donate/alipay.png'
  }
];

/** 收款方署名（展示在二维码下方，如实告知钱转给谁） */
const DONATE_OWNER = '世间無晚風(*功)';

/** 用途说明：钱用来做什么，明确写出来。
 *  🔴 措辞要**贴合实际部署形态** —— 本项目是本地部署（模型与推理都在用户自己机器上），
 *    写成"服务器开销"会让人误以为有托管服务，反而困惑。 */
const DONATE_NOTE = '自愿支持，不影响任何功能使用。本项目本地部署，模型与推理都在你自己的机器上。';

export { REPO_URL, REPO_TAGLINE, REPO_INTRO, REPO_FEATURES, DONATE_CHANNELS, DONATE_OWNER, DONATE_NOTE };
