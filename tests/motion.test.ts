// 动效交接不变量：GSAP 迁移后的防回退检查
// （内容型断言与 theme.test.ts 同风格：读源码验证关键接线，防止后续改动悄悄丢动画/丢门控）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = process.env.TOKENUSE_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

test('web 仪表盘：GSAP 驱动实时 Feed / 价格行 / LAN 面板，且尊重减少动效', () => {
  const src = read('web/app.ts')
  assert.ok(src.includes("from 'gsap'"), 'app.ts 未引入 gsap')
  // 实时 Feed：只有真正新落地的行做入场（lastMaxRecentTs 哨兵 + rec-new 标记），旧行不动
  assert.ok(src.includes('lastMaxRecentTs'), '缺少 Feed 新行哨兵 lastMaxRecentTs')
  assert.ok(src.includes('rec-new'), '缺少 rec-new 标记')
  assert.ok(/gsap\.from\(fresh, \{ y: -6/.test(src), 'Feed 新行入场 tween 缺失')
  // 价格行：新增入场与既有 .removing 退出的 170ms 严格对称
  assert.ok(/gsap\.from\(last, \{ y: -4, autoAlpha: 0, duration: 0\.17/.test(src), '价格行入场 tween 缺失或未对齐 170ms 退出')
  // LAN 面板：只在「关→开」翻转那一刻 reveal 一次，重试轮询不得重复触发
  assert.ok(src.includes('lanPanelShown'), '缺少 LAN 面板 reveal 哨兵 lanPanelShown')
  assert.ok(src.includes("gsap.from($('lan-panel')"), 'LAN 面板 reveal tween 缺失')
  // 三处 tween 都必须挂在 reduceMotion 门控下
  const gates = src.split('reduceMotion.matches').length - 1
  assert.ok(gates >= 4, `reduceMotion 门控数量不足（现 ${gates} 处，数字滚动原有 1 + 新增动效 3）`)
})

test('悬浮窗：GSAP 开合动画，收起先折叠、后通知主进程缩窗', () => {
  const html = read('electron/floating.html')
  assert.ok(html.includes('./vendor/gsap.min.js'), '悬浮窗未引入 vendor gsap')
  assert.ok(!html.includes('@keyframes unfold'), '旧 CSS unfold 未移除，会与 GSAP 入场叠加')
  assert.ok(html.includes('fromTo(panel'), '缺少 GSAP 展开入场')
  assert.ok(html.includes('collapseWithAnimation'), '缺少收起折叠入口')
  // 时序保护：折叠播完且状态未被打破（失焦先行收起等），才允许发 setExpanded(false)
  assert.ok(
    /onComplete: \(\) => \{[\s\S]*?folding = false[\s\S]*?if \(expanded\) window\.tokenuse\.setExpanded\(false\)/.test(html),
    '收起时序保护缺失',
  )
  assert.ok(html.includes('reduceMotion'), '悬浮窗缺少减少动效门控')
})

test('landing：FAQ 手风琴 / 移动端菜单 GSAP 化，按钮补按压态', () => {
  const js = read('landing/js/main.js')
  assert.ok(js.includes('preventDefault'), 'FAQ 未拦截 details 原生瞬时开合')
  assert.ok(js.includes("height: 'auto'"), 'FAQ 缺少高度过渡到 auto')
  assert.ok(js.includes('onReverseComplete'), 'FAQ 缺少反向完成清理（动画中途掉头）')
  assert.ok(js.includes('gsap.from(links'), '移动端菜单入场缺失')
  assert.ok(js.includes('gsap.to(links'), '移动端菜单出场缺失')
  assert.ok(js.includes('clearProps'), 'GSAP 内联样式未清理，会污染桌面静态布局')
  assert.ok(js.includes('canAnimate'), '缺少 GSAP 缺位 / 减少动效的回落开关')
  const css = read('landing/css/styles.css')
  assert.ok(/\.btn:active \{/.test(css), 'landing 按钮缺少 :active 按压态')
  assert.ok(css.includes('rotate(45deg)'), 'FAQ 指示符未改为可过渡的旋转方案')
  assert.ok(!css.includes('content: "−"'), '旧 +/− 内容硬切换仍存在')
})

test('GSAP 产物随包分发：vendor 文件有效、打包清单与依赖声明齐全', () => {
  for (const p of ['landing/js/vendor/gsap.min.js', 'electron/vendor/gsap.min.js']) {
    const s = read(p)
    assert.ok(s.includes('GreenSock'), `${p} 不是有效的 gsap 构建产物`)
  }
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.build.files.includes('electron/vendor/**/*'), 'electron-builder 打包清单缺 electron/vendor，打包后悬浮窗动画会静默失效')
  assert.ok(pkg.devDependencies.gsap, 'package.json 缺少 gsap 依赖声明')
})

test('PWA 缓存版本已随 app.js 变更递增', () => {
  const sw = read('web/sw.js')
  assert.ok(sw.includes("'tokenuse-shell-v10'"), 'app.js 内容已变更，PWA 缓存版本必须递增（当前应为 v10）')
})

test('模型占比：标签内嵌环带且小扇区不标注（窄屏防重叠）', () => {
  const app = read('web/app.ts')
  // 外部引导线标签在窄面板上互相重叠、还会压到右侧图例 → 必须内嵌
  assert.ok(/label: \{ position: 'inside'/.test(app), '饼图百分比标签应内嵌环带')
  assert.ok(app.includes('labelLine: { show: false }'), '外部引导线应关闭')
  assert.ok(app.includes('label: { show: pct >= 8 }'), '小扇区（<8%）不应显示标签')
  assert.ok(app.includes('pct.toFixed(1)'), '标签百分比应保留一位小数（{d}% 两位小数过挤）')
})

test('分布三板块：容器、纯函数模块与渲染接线齐全', () => {
  // 服务端聚合：Snapshot 三字段 + store 组装
  const types = read('src/core/types.ts')
  for (const field of ['hourHeatmap', 'reqSize', 'hourByModel']) {
    assert.ok(types.includes(field), `Snapshot 缺少聚合字段 ${field}`)
  }
  const store = read('src/core/store.ts')
  for (const key of ['heatAgg', 'distAgg', 'hourModelAgg']) {
    assert.ok(store.includes(key), `store 缺少聚合器 ${key}`)
  }
  // 前端：面板容器 + 渲染函数 + 纯函数模块
  const html = read('web/index.html')
  for (const id of ['id="heat"', 'id="dist"', 'id="hourly"', 'id="heat-stats"', 'id="dist-rows"']) {
    assert.ok(html.includes(id), `index.html 缺少分布板块容器 ${id}`)
  }
  const app = read('web/app.ts')
  for (const fn of ['renderHeat', 'renderDist', 'renderHourly']) {
    assert.ok(app.includes(`function ${fn}`), `app.ts 缺少 ${fn}`)
    assert.ok(new RegExp(`^\\s+${fn}\\(\\)$`, 'm').test(app), `render() 未调用 ${fn}`)
  }
  assert.ok(app.includes("from './distribution'"), 'app.ts 未引入 distribution 纯函数模块')
  // 脊线行高与 CSS 对齐（两处必须成对改）
  assert.ok(app.includes('DIST_ROW_H = 44'), 'app.ts 脊线行高常量缺失')
  assert.ok(/\.dist-row \{\s*\n\s*height: 44px/.test(read('web/style.css')), '.dist-row 高度应与 DIST_ROW_H 一致')
})
