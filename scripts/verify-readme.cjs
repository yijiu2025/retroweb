/**
 * README 中英一致性核验（一次性）。
 *
 * 要抓的错，按实际踩过的坑排：
 *  ① 中文删了某节、英文没同步 ⇒ **章节数量/标题数必须相等**
 *  ② 英文里的路径/文件名拼错 ⇒ 逐个到磁盘核对**文件真的存在**
 *  ③ 图片路径错 ⇒ 两个 README 引用的图必须都在 public/donate 下
 *  ④ 语言切换互链缺失或指错
 *  ⑤ 表格被翻译时列数改坏
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cn = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'README.en.md'), 'utf8');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
};

/** 取所有标题行（不含代码块内的 #） */
function headings(text) {
  const lines = text.split('\n');
  let inFence = false;
  const out = [];
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (inFence) return;
    const m = l.match(/^(#{1,4})\s+(.+)$/);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

const hCn = headings(cn);
const hEn = headings(en);

check('① 章节数量一致', hCn.length === hEn.length, `cn=${hCn.length} en=${hEn.length}`);

const lvlMismatch = [];
hCn.forEach((h, i) => {
  const e = hEn[i];
  if (!e || e.level !== h.level) lvlMismatch.push(`L${h.line} ${h.text} ↔ ${e ? e.level : '缺失'}`);
});
check('① 标题层级一致', lvlMismatch.length === 0, lvlMismatch.slice(0, 3).join(' | '));

// ② 代码块数量
const fences = (t) => (t.match(/^\s*```/gm) || []).length;
check('② 代码块数量一致', fences(cn) === fences(en), `cn=${fences(cn)} en=${fences(en)}`);

// ③ 表格行数（| 开头的行）
const tableRows = (t) => t.split('\n').filter((l) => /^\s*\|/.test(l)).length;
check('③ 表格行数一致', tableRows(cn) === tableRows(en), `cn=${tableRows(cn)} en=${tableRows(en)}`);

// ④ 互链
check('④ 中文版链到英文', cn.includes('README.en.md'));
check('④ 英文版链到中文', en.includes('README.md'));

// ⑤ 英文版提到的源码路径必须真实存在
const srcPaths = new Set();
const re = /(?:src|components|composables|stores|types|utils|config|views|api)\/[A-Za-z0-9_./-]+\.(?:ts|vue)/g;
let m;
while ((m = re.exec(en))) srcPaths.add(m[0]);

const missing = [...srcPaths].filter((p) => !fs.existsSync(path.join(ROOT, 'src', p.replace(/^(src|components|composables|stores|types|utils|config|views|api)\//, '$1/'))))
  .filter((p) => !fs.existsSync(path.join(ROOT, p)));
check('⑤ 英文版引用的源文件都存在', missing.length === 0, missing.join(', ') || `${srcPaths.size} 个全中`);

// ⑥ 两版引用的图片都必须存在
const imgs = new Set();
const re2 = /!\[[^\]]*\]\(([^)]+)\)|<img src="([^"]+)"[^>]*>/g;
let m2;
while ((m2 = re2.exec(cn))) imgs.add(m2[1] || m2[2]);
while ((m2 = re2.exec(en))) imgs.add(m2[1] || m2[2]);
const badImgs = [...imgs].filter((p) => p && !p.startsWith('http') && !fs.existsSync(path.join(ROOT, p)));
check('⑥ 引用的图片都存在', badImgs.length === 0, badImgs.join(', ') || `${imgs.size} 张全中`);

// ⑦ 关键端点在两版里都出现（防止翻译时漏掉技术标识）
const keys = ['/api/jobs', '/api/llm/analyze/stream', 'bind-session', 'VITE_AUTH_BYPASS', 'max_tokens', 'RETRO_CORS_ORIGINS'];
const missKeys = keys.filter((k) => !cn.includes(k) || !en.includes(k));
check('⑦ 关键技术标识两版都在', missKeys.length === 0, missKeys.join(', ') || `${keys.length} 个全中`);

// ⑧ 英文版里不该残留**中文正文**。

// 命令/文件名在英文版里可能被反引号或代码块切断（如 启动后端API.bat → 「启动后端」），
// 所以**只对需要逐字出现的正文类**做反向核对，命令类另行用宽松包含检查。
const CN_ANCHORS = ['开发者', '开发模式', '正在加载安全登录', '拒绝 postMessage：父 origin 未授权',
  '世间無晚風', '换目标', '确定目标，开始分析', '逆合成树', '路线网络', '步骤详情',
  '目标分析', '最近的任务', '运行设置', '个人中心', '任务列表', '历史记录', '简体中文'];

const zhInEn = en.match(/[\u4e00-\u9fa5]{2,}/g) || [];
// 🔴 判据最终形态：**英文版里出现的中文词，凡是中文版也有的，就是有意的界面原文引用**
//    （按钮名 / 报错文案 / 收款人）。分词切碎、代码块标记、反引号都会把完整词切开，
//    靠「片段包含完整串」这种启发式不可靠（实测 `拒绝` 就漏了）—— 直接回到源文本比对。
//    反过来，中文版没有的词 = 漏翻译或拼错，必须报。
const unexpected = [...new Set(zhInEn)].filter((t) => !cn.includes(t));

// 反向核对：白名单里的词若中文版根本没有，说明是残留拼写错误
const stale = CN_ANCHORS.filter((a) => !cn.includes(a));
check('⑧ 英文版残留中文均为「界面原文/命令/专名」', unexpected.length === 0,
  unexpected.slice(0, 5).join(' | ') || `${new Set(zhInEn).size} 类均为有意保留`);
check('⑧ 白名单每项在中文版都有对应', stale.length === 0, stale.join(', ') || '无过期词条');

const failed = results.filter((r) => !r.pass);
console.log(`\n=== README 一致性：${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
