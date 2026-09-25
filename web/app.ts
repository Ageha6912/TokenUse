import * as echarts from 'echarts'
import qrcode from 'qrcode-generator'
import { gsap } from 'gsap'
import type { Snapshot, WireRecord } from '../src/core/types'
import { binCenters, densityCurve, heatSegmentShares, trimHeatRows } from './distribution'
import {
  costLabel,
  easeOutCubic,
  esc,
  fmtAxisTokens,
  fmtCost,
  fmtTime,
  fmtTokens,
  pad,
  shortPath,
  sourceLabel,
  totalTok,
  totalsSub,
} from './format'

// ---------- 局域网访问令牌：页面地址带来的 token 透传给后续 fetch / WebSocket ----------
const urlToken = new URLSearchParams(location.search).get('token') ?? ''
if (urlToken) history.replaceState(null, '', '/')

function withToken(pathname: string): string {
  if (!urlToken) return pathname
  return pathname + (pathname.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(urlToken)
}

interface Price {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  currency: 'CNY' | 'USD'
}

let snap: Snapshot | null = null
const charts: Record<string, echarts.ECharts> = {}
const filters = { source: '', project: '', model: '', range: 'all', q: '' }
let trendMode: 'day' | 'month' = 'day'
let lastTableSig = ''

const $ = (id: string) => document.getElementById(id) as HTMLElement
// 图表数据系列色板（暖金奶油底）：四色体系分散用色，避免整页单一金色
const COLORS = ['#665298', '#f0b429', '#d14e66', '#2f9e6e', '#9a8fbf', '#c98a12', '#e0798f', '#67b39a', '#5470c6', '#d9a441']
// 脊线图行高：与 style.css 的 .dist-row height 保持一致
const DIST_ROW_H = 44
const fmtCount = (n: number) => n.toLocaleString('zh-CN')

// 惰性建图：heat / dist / hourly 的容器高度随数据行数变化，首次渲染时才初始化
function ensureChart(id: string): echarts.ECharts | null {
  const el = $(id)
  if (!el.clientHeight) return null
  if (!charts[id]) charts[id] = echarts.init(el)
  return charts[id]
}

// ---------- 动效：数字滚动 + 滚动入场（均尊重系统「减少动态效果」） ----------

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

interface TweenState { from: number; to: number; started: number; raf: number }
const tweens = new WeakMap<HTMLElement, TweenState>()

// 数值变化时从上次值平滑滚到新值；首帧从 0 起滚，做出「电表启动」感
function tweenNumber(el: HTMLElement, target: number, fmt: (v: number) => string, dur = 650) {
  const prev = tweens.get(el)
  if (prev) cancelAnimationFrame(prev.raf)
  if (reduceMotion.matches || !Number.isFinite(target)) {
    tweens.set(el, { from: target, to: target, started: 0, raf: 0 })
    el.textContent = fmt(target)
    return
  }
  const from = prev ? prev.to : 0
  const state: TweenState = { from, to: target, started: performance.now(), raf: 0 }
  const step = (now: number) => {
    const p = Math.min(1, (now - state.started) / dur)
    el.textContent = fmt(from + (target - from) * easeOutCubic(p))
    if (p < 1) state.raf = requestAnimationFrame(step)
  }
  state.raf = requestAnimationFrame(step)
  tweens.set(el, state)
}

// 区块滚动入场：进入视口时上浮显现，同批次内做小步 stagger
function setupReveal() {
  const main = document.querySelector('main')
  if (!main) return
  main.classList.add('can-reveal')
  const sections = [...main.children] as HTMLElement[]
  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    sections.forEach(s => s.classList.add('in'))
    return
  }
  const io = new IntersectionObserver(entries => {
    let batch = 0
    for (const en of entries) {
      if (!en.isIntersecting) continue
      const el = en.target as HTMLElement
      el.style.animationDelay = `${Math.min(batch * 70, 280)}ms`
      el.classList.add('in')
      io.unobserve(el)
      batch++
    }
  }, { threshold: 0.08 })
  sections.forEach(s => io.observe(s))
}

// ---------- 自绘下拉组件 ----------

const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CHECK = '<svg class="chk" width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 6.5L4.8 9L10 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

interface SelectItem { value: string; label: string }
interface SelectCfg { items: SelectItem[]; value: string; onChange: (v: string) => void }

const liveSelects = new Set<CustomSelect>()

class CustomSelect {
  value: string
  readonly el: HTMLElement
  private items: SelectItem[]
  private openState = false
  private activeIndex = -1
  private menu: HTMLElement
  private label: HTMLElement

  constructor(private host: HTMLElement, private cfg: SelectCfg, private placeholder: string) {
    this.value = cfg.value
    this.items = cfg.items
    const el = document.createElement('div')
    el.className = 'cselect'
    el.innerHTML = `<button type="button" class="cselect-trigger"><span class="cselect-label"></span><span class="cselect-arrow">${CHEVRON}</span></button><div class="cselect-menu"></div>`
    this.el = el
    this.menu = el.querySelector('.cselect-menu') as HTMLElement
    this.label = el.querySelector('.cselect-label') as HTMLElement
    ;(el.querySelector('.cselect-trigger') as HTMLElement).addEventListener('click', e => {
      e.stopPropagation()
      this.toggle()
    })
    this.menu.addEventListener('click', e => {
      e.stopPropagation()
      const item = (e.target as HTMLElement).closest('.cselect-item') as HTMLElement | null
      if (item) this.pick(item.dataset.v ?? '')
    })
    el.addEventListener('keydown', e => this.onKey(e))
    host.appendChild(el)
    liveSelects.add(this)
    this.renderMenu()
    this.renderLabel()
  }

  get isOpen() {
    return this.openState
  }

  toggle() {
    this.openState ? this.close() : this.openMenu()
  }

  openMenu() {
    for (const s of liveSelects) if (s !== this) s.close()
    this.openState = true
    this.el.classList.add('open')
    const r = this.el.getBoundingClientRect()
    const menuH = Math.min(272, this.items.length * 30 + 12)
    this.el.classList.toggle('up', r.bottom + menuH + 10 > window.innerHeight && r.top - menuH - 10 > 0)
    this.activeIndex = Math.max(0, this.items.findIndex(i => i.value === this.value))
    this.paintActive()
  }

  close() {
    if (!this.openState) return
    this.openState = false
    this.el.classList.remove('open')
  }

  // 选项变化时重建菜单；当前值不在新选项里则回落到第一项（占位项）
  update(items: SelectItem[], value?: string) {
    const sig = items.map(i => i.value).join('\u0001')
    const changed = sig !== this.items.map(i => i.value).join('\u0001')
    if (changed) this.items = items
    if (value !== undefined) this.value = value
    if (!this.items.some(i => i.value === this.value)) this.value = this.items[0]?.value ?? ''
    if (changed) {
      this.renderMenu()
      this.activeIndex = Math.max(0, this.items.findIndex(i => i.value === this.value))
      if (this.openState) this.paintActive()
    }
    this.renderLabel()
  }

  private pick(v: string) {
    if (v !== this.value) {
      this.value = v
      this.renderLabel()
      this.renderMenu()
      this.cfg.onChange(v)
    }
    this.close()
  }

  private renderLabel() {
    const cur = this.items.find(i => i.value === this.value)
    this.label.textContent = cur ? cur.label : this.placeholder
    this.label.classList.toggle('ph', !cur)
  }

  private renderMenu() {
    this.menu.innerHTML = this.items
      .map(i => `<div class="cselect-item${i.value === this.value ? ' selected' : ''}" data-v="${esc(i.value)}"><span class="lbl">${esc(i.label)}</span>${CHECK}</div>`)
      .join('')
  }

  private paintActive() {
    const nodes = this.menu.querySelectorAll('.cselect-item')
    nodes.forEach((n, i) => n.classList.toggle('active', i === this.activeIndex))
  }

  private moveActive(d: number) {
    if (!this.items.length) return
    this.activeIndex = (this.activeIndex + d + this.items.length) % this.items.length
    this.paintActive()
    const n = this.menu.querySelectorAll('.cselect-item')[this.activeIndex] as HTMLElement | undefined
    n?.scrollIntoView({ block: 'nearest' })
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!this.openState) this.openMenu()
      else {
        const it = this.items[this.activeIndex]
        if (it) this.pick(it.value)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (this.openState) this.moveActive(1)
      else this.openMenu()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (this.openState) this.moveActive(-1)
      else this.openMenu()
      return
    }
    if (e.key === 'Escape') this.close()
    if (e.key === 'Tab') this.close()
  }
}

// ---------- 渲染 ----------

function renderCards() {
  if (!snap) return
  const t = snap.today
  const m = snap.month
  tweenNumber($('c-today-tok'), t.tokens, fmtTokens)
  $('c-today-sub').textContent = `输入 ${fmtTokens(t.inputTokens)} · 输出 ${fmtTokens(t.outputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens + t.cacheWriteTokens)}`
  if (t.cost == null) $('c-today-cost').textContent = '—'
  else tweenNumber($('c-today-cost'), t.cost, v => costLabel(v, t.costUnknown))
  $('c-today-cost-sub').textContent = totalsSub(t)
  if (m.cost == null) $('c-month-cost').textContent = '—'
  else tweenNumber($('c-month-cost'), m.cost, v => costLabel(v, m.costUnknown))
  const lm = snap.monthly[snap.monthly.length - 2]
  $('c-month-sub').innerHTML =
    `本月 ${m.requests} 次请求 · ${snap.projects.length} 个项目<br>上月 ${lm ? fmtTokens(lm.tokens) + ' tok / ' + fmtCost(lm.cost) : '—'}`
  tweenNumber($('c-req'), t.requests, v => String(Math.round(v)))
  $('c-src').textContent = snap.sources.map(s => `${sourceLabel(s.id)} ${s.ok ? '✓' : '✗'} ${s.records}`).join(' · ')
}

function renderSpark() {
  const tl = snap!.timeline
  charts.spark.setOption({
    grid: { left: 48, right: 10, top: 12, bottom: 22 },
    xAxis: {
      type: 'category',
      data: tl.map(p => p.minute),
      axisLabel: { interval: 9, color: '#a39e94', fontSize: 10 },
      axisLine: { lineStyle: { color: '#ddd6c7' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => fmtAxisTokens(v), color: '#a39e94', fontSize: 10, hideOverlap: true },
      splitLine: { lineStyle: { color: '#eae4d6' } },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
      formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}<br/>tokens：<b>${fmtTokens(ps[0].value)}</b>`,
    },
    series: [{
      type: 'bar',
      data: tl.map(p => p.tokens),
      itemStyle: { color: '#f0b429', opacity: 0.85, borderRadius: [2, 2, 0, 0] },
      barCategoryGap: '25%',
      animation: true, animationDuration: 380, animationEasing: 'cubicOut', animationDurationUpdate: 300, animationEasingUpdate: 'cubicOut',
    }],
  })
}

function renderDaily() {
  const day = trendMode === 'day'
  const dl = day
    ? snap!.daily.map(p => ({ label: p.date, tokens: p.tokens, cost: p.cost }))
    : snap!.monthly.map(p => ({ label: p.label, tokens: p.tokens, cost: p.cost }))
  $('trend-title').textContent = day ? '每日趋势（30 天）' : '月度趋势（近 12 个月）'
  charts.daily.setOption({
    grid: { left: 52, right: 52, top: 30, bottom: 24 },
    legend: { data: ['tokens', '成本'], textStyle: { color: '#57534c', fontSize: 11 }, top: 0, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
      valueFormatter: (v: number) => (typeof v === 'number' ? v.toLocaleString('zh-CN') : String(v)),
    },
    xAxis: {
      type: 'category',
      data: dl.map(p => p.label),
      axisLabel: { interval: day ? 4 : 0, color: '#a39e94', fontSize: 10 },
      axisLine: { lineStyle: { color: '#ddd6c7' } },
    },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (v: number) => fmtAxisTokens(v), color: '#a39e94', fontSize: 10, hideOverlap: true }, splitLine: { lineStyle: { color: '#eae4d6' } } },
      { type: 'value', axisLabel: { formatter: (v: number) => '¥' + v, color: '#a39e94', fontSize: 10 }, splitLine: { show: false } },
    ],
    series: [
      {
        name: 'tokens', type: 'bar', data: dl.map(p => p.tokens),
        itemStyle: { color: '#665298', opacity: 0.85, borderRadius: [2, 2, 0, 0] },
        barCategoryGap: '30%', animation: true, animationDuration: 380, animationEasing: 'cubicOut', animationDurationUpdate: 300, animationEasingUpdate: 'cubicOut',
      },
      {
        name: '成本', type: 'line', yAxisIndex: 1, data: dl.map(p => p.cost),
        itemStyle: { color: '#d14e66' }, lineStyle: { color: '#d14e66', width: 2 },
        symbolSize: 3, connectNulls: true, animation: true, animationDuration: 380, animationEasing: 'cubicOut', animationDurationUpdate: 300, animationEasingUpdate: 'cubicOut',
      },
    ],
  }, true)
}

function renderPie() {
  const bm = snap!.byModelMonth
  const top = bm.slice(0, 8)
  const rest = bm.slice(8)
  const data = top.map(b => ({ name: b.key, value: b.tokens }))
  if (rest.length) {
    data.push({ name: '其他', value: rest.reduce((s, b) => s + b.tokens, 0) })
  }
  const total = data.reduce((s, d) => s + d.value, 0)
  charts.pie.setOption({
    color: COLORS,
    tooltip: {
      trigger: 'item',
      backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
      formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/>${fmtTokens(p.value)}（${p.percent}%）`,
    },
    legend: {
      type: 'scroll', orient: 'vertical', right: 0, top: 'middle',
      textStyle: { color: '#57534c', fontSize: 10 }, itemWidth: 10, itemHeight: 10,
      pageIconColor: '#b07f0a', pageTextStyle: { color: '#a39e94' },
    },
    series: [{
      type: 'pie',
      radius: ['42%', '70%'],
      center: ['36%', '50%'],
      // 百分比内嵌环带、只标注 ≥8% 的扇区：外部引导线在窄面板上会互相重叠、还会压到图例（笔记本原生屏宽度）
      data: data.map(d => {
        const pct = total > 0 ? (d.value / total) * 100 : 0
        return { ...d, label: { show: pct >= 8 }, labelLine: { show: false } }
      }),
      label: { position: 'inside', color: '#fffdf8', fontSize: 10, formatter: (p: { percent: number }) => p.percent.toFixed(1) + '%' },
      itemStyle: { borderColor: '#f9f7f2', borderWidth: 1 },
      animation: true, animationDuration: 380, animationEasing: 'cubicOut', animationDurationUpdate: 300, animationEasingUpdate: 'cubicOut',
    }],
  })
}

function renderProj() {
  const bp = snap!.byProjectMonth.slice(0, 8)
  const names = bp.map(b => shortPath(b.key))
  charts.proj.setOption({
    grid: { left: 8, right: 56, top: 10, bottom: 10, containLabel: true },
    xAxis: {
      type: 'value',
      splitNumber: 4,
      axisLabel: { formatter: (v: number) => fmtAxisTokens(v), color: '#a39e94', fontSize: 10, hideOverlap: true },
      splitLine: { lineStyle: { color: '#eae4d6' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      inverse: true,
      axisLabel: {
        color: '#57534c', fontSize: 10,
        formatter: (v: string) => (v.length > 14 ? v.slice(0, 13) + '…' : v),
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
      formatter: (p: { name: string; value: number }) => `${p.name}<br/>${fmtTokens(p.value)} tok`,
    },
    series: [{
      type: 'bar',
      data: bp.map(b => b.tokens),
      itemStyle: { color: '#2f9e6e', opacity: 0.9, borderRadius: [0, 3, 3, 0] },
      barMaxWidth: 14,
      animation: true, animationDuration: 380, animationEasing: 'cubicOut', animationDurationUpdate: 300, animationEasingUpdate: 'cubicOut',
    }],
  })
}

// 上一次渲染的最新请求时间：只有真正新落地的行才做入场，旧行保持不动
let lastMaxRecentTs = 0

function renderRecent() {
  const list = snap!.recent.slice(0, 12)
  const prevMax = lastMaxRecentTs
  lastMaxRecentTs = list.reduce((m, r) => Math.max(m, r.ts), 0)
  $('recent').innerHTML =
    list
      .map(
        r => `<div class="rec${prevMax > 0 && r.ts > prevMax ? ' rec-new' : ''}">
          <span class="t mono">${fmtTime(r.ts)}</span>
          <span class="m mono" title="${esc(r.model)}">${esc(r.model)}</span>
          <span class="p" title="${esc(r.project)}">${esc(shortPath(r.project))}</span>
          <b>${fmtTokens(totalTok(r))}</b>
          <span class="c">${fmtCost(r.cost)}</span>
        </div>`,
      )
      .join('') || '<div class="empty">暂无请求</div>'
  const fresh = document.querySelectorAll('#recent .rec-new')
  if (fresh.length && !reduceMotion.matches) {
    // 完成后 kill 退役：杜绝 tween 被时钟残余重绘，且内联样式已 clearProps 清空
    const entrance = gsap.from(fresh, { y: -6, autoAlpha: 0, duration: 0.22, ease: 'power3.out', stagger: 0.04, clearProps: 'all', overwrite: true, onComplete: () => entrance.kill() })
  }
  fresh.forEach(el => el.classList.remove('rec-new'))
}

// ---------- 日活分布（日×小时热力图 + 时段占比） ----------

const HEAT_RAMP = ['#f3ecd9', '#e9d49a', '#d9b35c', '#b8860e', '#7a5a06']

function renderHeat() {
  const el = $('heat')
  const rows = trimHeatRows(snap!.hourHeatmap)
  $('heat-stats').innerHTML = heatSegmentShares(rows)
    .map(s => `<span class="heat-stat">${s.label}<b>${s.pct == null ? '—' : s.pct.toFixed(1) + '%'}</b></span>`)
    .join('')
  // 空态用兄弟节点切换，绝不清空图表容器（会连带销毁 ECharts 已挂载的 canvas）
  $('heat-empty').classList.toggle('hidden', rows.length > 0)
  el.classList.toggle('hidden', rows.length === 0)
  if (!rows.length) return
  const height = rows.length * 20 + 26
  if (el.style.height !== height + 'px') {
    el.style.height = height + 'px'
    charts.heat?.resize()
  }
  const chart = ensureChart('heat')
  if (!chart) return
  const data: [number, number, number][] = []
  let max = 0
  rows.forEach((row, y) => {
    row.hours.forEach((v, h) => {
      if (v > 0) {
        data.push([h, y, v])
        if (v > max) max = v
      }
    })
  })
  chart.setOption({
    grid: { left: 44, right: 10, top: 4, bottom: 20 },
    xAxis: {
      type: 'category', data: Array.from({ length: 24 }, (_, h) => String(h)),
      axisLabel: { color: '#a39e94', fontSize: 10, interval: 0, hideOverlap: true },
      axisLine: { lineStyle: { color: '#ddd6c7' } }, axisTick: { show: false },
      splitArea: { show: false },
    },
    yAxis: {
      // 类目轴 0 号在底部：rows 升序 → 最新日期自然落在顶部（对齐参考稿）
      type: 'category', data: rows.map(r => r.label),
      axisLabel: { color: '#a39e94', fontSize: 10 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    visualMap: {
      type: 'continuous', min: 0, max: Math.max(max, 1), show: false,
      inRange: { color: HEAT_RAMP },
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
      formatter: (p: { value: [number, number, number] }) => `${rows[p.value[1]]?.label} ${p.value[0]}时 · ${fmtTokens(p.value[2])}`,
    },
    series: [{
      type: 'heatmap', data,
      itemStyle: { borderRadius: 2, borderWidth: 2, borderColor: '#f9f7f2' },
      emphasis: { itemStyle: { borderColor: 'rgba(176, 127, 10, .55)' } },
      animation: true, animationDuration: 380, animationDurationUpdate: 300,
    }],
  })
}

// ---------- 单次请求大小分布（脊线） ----------

function renderDist() {
  const rs = snap!.reqSize
  const models = rs.models
  const rowsEl = $('dist-rows')
  const el = $('dist')
  $('dist-count').textContent = models.length ? `TOP ${models.length} 模型 · 共 ${fmtCount(rs.overall.count)} 次` : ''
  if (!models.length) {
    rowsEl.innerHTML = '<div class="empty">暂无记录</div>'
    el.classList.add('hidden')
    return
  }
  el.classList.remove('hidden')
  const maxP90 = Math.max(...models.map(m => m.p90), 1)
  rowsEl.innerHTML = models
    .map(
      m => `<div class="dist-row" title="${esc(m.model)}">
        <span class="m">${esc(m.model)}</span>
        <span class="c">${fmtCount(m.count)}</span>
        <span class="p">${fmtTokens(m.p50)}</span>
        <span class="p">${fmtTokens(m.p90)}</span>
        <span class="bar"><i class="b90" style="width:${((m.p90 / maxP90) * 100).toFixed(1)}%"></i><i class="b50" style="width:${((m.p50 / maxP90) * 100).toFixed(1)}%"></i></span>
      </div>`,
    )
    .join('')
  const height = models.length * DIST_ROW_H + 24
  if (el.style.height !== height + 'px') {
    el.style.height = height + 'px'
    charts.dist?.resize()
  }
  const chart = ensureChart('dist')
  if (!chart) return
  const centers = binCenters(rs.binLo, rs.binHi, rs.binCount)
  const N = models.length
  const series: Record<string, unknown>[] = []
  // 底行先画、顶行后画：高密度行的填充自然盖住下方行的越界尾部
  for (let i = N - 1; i >= 0; i--) {
    const m = models[i]
    // 值轴自下而上增长：显示第 i 行（0=顶）的条带 = 值域 [(N-1-i)*H, (N-i)*H]，
    // 曲线从条带底边（基线）向上隆起；配合首尾锚点，面积填充只占本行条带
    const baseline = (N - 1 - i) * DIST_ROW_H
    const dens = densityCurve(m.bins)
    const color = COLORS[i % COLORS.length]
    const markLineData: unknown[] = [
      [
        { coord: [m.p50, baseline] },
        { coord: [m.p50, baseline + DIST_ROW_H * 0.85] },
      ],
    ]
    if (i === 0 && rs.overall.p50 > 0) {
      markLineData.push([
        { coord: [rs.overall.p50, 0], lineStyle: { color: '#a39e94', width: 1, type: 'dashed', opacity: 0.8 } },
        { coord: [rs.overall.p50, N * DIST_ROW_H] },
      ])
    }
    // 首尾锚在行基线上：面积填充只占本行条带，不会灌到图表底部盖住下方行
    const band: [number, number][] = [
      [rs.binLo, baseline],
      ...centers.map((x, j) => [x, baseline + dens[j] * DIST_ROW_H * 0.88] as [number, number]),
      [rs.binHi, baseline],
    ]
    series.push({
      name: m.model,
      type: 'line',
      smooth: 0.35,
      showSymbol: false,
      data: band,
      lineStyle: { width: 1, color },
      itemStyle: { color },
      areaStyle: { color, opacity: 0.5 },
      animationDurationUpdate: 300,
      markLine: {
        silent: true, symbol: 'none', animation: false,
        label: { show: false },
        lineStyle: { color: '#443e33', width: 1.2, type: 'solid', opacity: 0.85 },
        data: markLineData,
      },
      markPoint: {
        silent: true, animation: false,
        symbol: 'circle', symbolSize: 4,
        itemStyle: { color: '#8d8677', opacity: 0.7 },
        label: { show: false },
        data: [{ coord: [m.p90, baseline + DIST_ROW_H * 0.32] }],
      },
      tooltip: {
        backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
        formatter: (p: { value: [number, number] }) => `${esc(m.model)}<br/>${fmtTokens(p.value[0])}`,
      },
    })
  }
  chart.setOption({
    grid: { left: 8, right: 14, top: 0, bottom: 24 },
    xAxis: {
      type: 'log', min: rs.binLo, max: rs.binHi,
      axisLabel: { color: '#a39e94', fontSize: 10, formatter: (v: number) => fmtAxisTokens(v) },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: { type: 'value', min: 0, max: N * DIST_ROW_H, show: false },
    series,
  })
}

// ---------- 0-24 时分布 × 模型 ----------

function renderHourly() {
  const el = $('hourly')
  const rows = snap!.hourByModel
  $('hourly-empty').classList.toggle('hidden', rows.length > 0)
  el.classList.toggle('hidden', rows.length === 0)
  if (!rows.length) return
  const chart = ensureChart('hourly')
  if (!chart) return
  chart.setOption({
    grid: { left: 46, right: 12, top: 30, bottom: 22 },
    legend: {
      type: 'scroll', top: 0, right: 0,
      textStyle: { color: '#57534c', fontSize: 10 }, itemWidth: 10, itemHeight: 8,
      pageIconColor: '#b07f0a', pageTextStyle: { color: '#a39e94' },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fffdf8', borderColor: '#e3ddd0', textStyle: { color: '#1b1917', fontSize: 11 }, extraCssText: 'box-shadow: 0 8px 24px rgba(30, 25, 15, .14);',
      valueFormatter: (v: number) => (typeof v === 'number' ? v.toLocaleString('zh-CN') : String(v)),
    },
    xAxis: {
      type: 'category', data: Array.from({ length: 24 }, (_, h) => String(h)),
      axisLabel: { color: '#a39e94', fontSize: 10, formatter: (v: string) => `${v}时`, hideOverlap: true },
      axisLine: { lineStyle: { color: '#ddd6c7' } }, axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => fmtAxisTokens(v), color: '#a39e94', fontSize: 10, hideOverlap: true },
      splitLine: { lineStyle: { color: '#eae4d6' } },
    },
    series: rows.map((r, i) => ({
      name: r.model,
      type: 'line',
      smooth: 0.5,
      showSymbol: false,
      data: r.hours,
      lineStyle: { width: 1 },
      areaStyle: { opacity: 0.4 },
      color: r.model === '其他' ? '#a39e94' : COLORS[i % COLORS.length],
      emphasis: { focus: 'series' },
      animationDuration: 380, animationDurationUpdate: 300,
    })),
  })
}

function rangeStart(): number {
  const now = new Date()
  if (filters.range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (filters.range === '7d') return now.getTime() - 7 * 86_400_000
  if (filters.range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return 0
}

function filtered(): WireRecord[] {
  if (!snap) return []
  const q = filters.q.trim().toLowerCase()
  const rs = rangeStart()
  return snap.records.filter(
    r =>
      (!filters.source || r.source === filters.source) &&
      (!filters.project || r.project === filters.project) &&
      (!filters.model || r.model === filters.model) &&
      r.ts >= rs &&
      (!q || (r.model + ' ' + r.project + ' ' + r.agent).toLowerCase().includes(q)),
  )
}

function rowHtml(r: WireRecord): string {
  return `<tr>
    <td class="mono">${fmtTime(r.ts)}</td>
    <td title="${esc(r.project)}">${esc(shortPath(r.project))}</td>
    <td>${sourceLabel(r.source)}</td>
    <td class="mono" title="${esc(r.model)}">${esc(r.model)}</td>
    <td>${esc(r.agent || '—')}</td>
    <td class="num">${fmtTokens(r.inputTokens)}</td>
    <td class="num">${fmtTokens(r.outputTokens)}</td>
    <td class="num">${r.reasoningTokens ? fmtTokens(r.reasoningTokens) : '·'}</td>
    <td class="num">${r.cacheReadTokens ? fmtTokens(r.cacheReadTokens) : '·'}</td>
    <td class="num">${r.cacheWriteTokens ? fmtTokens(r.cacheWriteTokens) : '·'}</td>
    <td class="num strong">${fmtTokens(totalTok(r))}</td>
    <td class="num cost-cell">${fmtCost(r.cost)}</td>
  </tr>`
}

function renderTable() {
  const list = filtered()
  const sig = `${snap!.updatedAt}|${filters.source}|${filters.project}|${filters.model}|${filters.range}|${filters.q}`
  if (sig === lastTableSig) return
  lastTableSig = sig
  const shown = list.slice(0, 500)
  $('detail-body').innerHTML = shown.map(rowHtml).join('') || '<tr><td colspan="12" class="empty">没有匹配的记录</td></tr>'
  $('detail-count').textContent =
    `共 ${list.length} 条` + (list.length > 500 ? '（显示前 500 条，明细缓存上限 2000 条）' : '')
}

const filterSel: Partial<Record<'source' | 'project' | 'model' | 'range', CustomSelect>> = {}

function buildFilters() {
  filterSel.source = new CustomSelect(
    $('f-source'),
    { items: [{ value: '', label: '全部来源' }, { value: 'zcode', label: 'ZCode' }, { value: 'codex', label: 'Codex' }, { value: 'opencode', label: 'OpenCode' }, { value: 'cursor', label: 'Cursor' }, { value: 'mimocode', label: 'MiMo' }], value: '', onChange: v => { filters.source = v; renderTable() } },
    '全部来源',
  )
  filterSel.range = new CustomSelect(
    $('f-range'),
    { items: [{ value: 'all', label: '全部时间' }, { value: 'today', label: '今天' }, { value: '7d', label: '近 7 天' }, { value: 'month', label: '本月' }], value: 'all', onChange: v => { filters.range = v; renderTable() } },
    '全部时间',
  )
  filterSel.project = new CustomSelect(
    $('f-project'),
    { items: [{ value: '', label: '全部项目' }], value: '', onChange: v => { filters.project = v; renderTable() } },
    '全部项目',
  )
  filterSel.model = new CustomSelect(
    $('f-model'),
    { items: [{ value: '', label: '全部模型' }], value: '', onChange: v => { filters.model = v; renderTable() } },
    '全部模型',
  )
}

let projKey = ''
let modelKey = ''

function populateFilters() {
  const pk = snap!.projects.join('\u0001')
  if (pk !== projKey) {
    projKey = pk
    filterSel.project!.update([{ value: '', label: '全部项目' }, ...snap!.projects.map(p => ({ value: p, label: shortPath(p) }))])
  }
  const mk = snap!.models.join('\u0001')
  if (mk !== modelKey) {
    modelKey = mk
    filterSel.model!.update([{ value: '', label: '全部模型' }, ...snap!.models.map(m => ({ value: m, label: m }))])
  }
}

function renderUpdated() {
  const dt = new Date(snap!.updatedAt)
  $('updated').textContent = `更新于 ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
  $('dot').classList.toggle('stale', Date.now() - snap!.updatedAt > 15_000)
}

function render() {
  if (!snap) return
  renderCards()
  populateFilters()
  renderSpark()
  renderHeat()
  renderDist()
  renderHourly()
  renderDaily()
  renderPie()
  renderProj()
  renderRecent()
  renderTable()
  renderUpdated()
}

function applySnap(s: Snapshot) {
  snap = s
  render()
}

// ---------- 数据通道 ----------

async function refresh() {
  const r = await fetch(withToken('/api/state'))
  applySnap(await r.json())
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws${urlToken ? '?token=' + encodeURIComponent(urlToken) : ''}`)
  ws.onmessage = e => {
    try {
      applySnap(JSON.parse(e.data as string))
    } catch {
      /* 忽略坏帧 */
    }
  }
  ws.onopen = () => $('dot').classList.remove('stale')
  ws.onclose = () => {
    $('dot').classList.add('stale')
    $('updated').textContent = '连接断开，重连中…'
    setTimeout(connectWs, 2000)
  }
}

// ---------- 设置抽屉 ----------

function post(url: string, body: unknown) {
  return fetch(withToken(url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function openDrawer() {
  $('drawer').classList.add('open')
  $('mask').classList.add('open')
  const st = (await (await fetch(withToken('/api/settings'))).json()) as { pollIntervalSec: number; usdCny: number; providers: Record<string, string>; defaultBilling: string }
  ;($('s-interval') as HTMLInputElement).value = String(st.pollIntervalSec)
  ;($('s-usd') as HTMLInputElement).value = String(st.usdCny)
  providerPending = { ...st.providers }
  renderProviderRows(st.providers, st.defaultBilling as 'metered' | 'plan')
  await loadPrices()
  void loadLanSection()
}

function closeDrawer() {
  $('drawer').classList.remove('open')
  $('mask').classList.remove('open')
}

let providerPending: Record<string, string> = {}

function renderProviderRows(providers: Record<string, string>, defaultBilling: 'metered' | 'plan') {
  const ids = new Set<string>([...(snap?.providers.map(p => p.id) ?? []), ...Object.keys(providers)])
  const host = $('provider-rows')
  host.innerHTML =
    [...ids]
      .sort()
      .map(id => `<div class="row"><code title="${esc(id)}">${esc(id)}</code><div class="sel-host" data-id="${esc(id)}"></div></div>`)
      .join('') || '<div class="empty">暂无数据</div>'
  host.querySelectorAll('.sel-host').forEach(h => {
    const id = (h as HTMLElement).dataset.id ?? ''
    new CustomSelect(
      h as HTMLElement,
      {
        items: [{ value: 'metered', label: '按量计费' }, { value: 'plan', label: '套餐内' }],
        value: providerPending[id] ?? defaultBilling,
        onChange: v => { providerPending[id] = v },
      },
      '计费方式',
    )
  })
}

let remoteCount = 0

function priceRowHtml(k: string, v: Price): string {
  return `<div class="row price" data-k="${esc(k)}" data-cur="${v.currency === 'USD' ? 'USD' : 'CNY'}">
    <input class="pk" value="${esc(k)}" placeholder="模型 ID" title="模型 ID（小写匹配）">
    <input class="pi" type="number" step="any" value="${v.input}" title="输入价 / 1M tok">
    <input class="po" type="number" step="any" value="${v.output}" title="输出价 / 1M tok">
    <input class="pc" type="number" step="any" value="${v.cacheRead ?? ''}" title="缓存读价（可空）">
    <div class="sel-host cur"></div>
    <button class="del" title="删除">✕</button>
  </div>`
}

function mountCurrencySelect(host: HTMLElement, cur: string) {
  new CustomSelect(
    host,
    {
      items: [{ value: 'CNY', label: 'CNY' }, { value: 'USD', label: 'USD' }],
      value: cur,
      onChange: v => {
        const row = host.closest('.row.price') as HTMLElement | null
        if (row) row.dataset.cur = v
      },
    },
    'CNY',
  )
}

function renderPriceRows(overrides: Record<string, Price>) {
  const entries = Object.entries(overrides)
  $('price-rows').innerHTML =
    entries.map(([k, v]) => priceRowHtml(k, v)).join('') ||
    '<div class="empty">暂无覆盖价格 — 点「添加模型」新增</div>'
  $('price-rows').querySelectorAll('.row.price').forEach(row => {
    const host = row.querySelector('.sel-host.cur') as HTMLElement | null
    if (host) mountCurrencySelect(host, (row as HTMLElement).dataset.cur ?? 'CNY')
  })
}

async function loadPrices() {
  const j = (await (await fetch(withToken('/api/prices'))).json()) as { overrides: Record<string, Price>; remoteCount: number }
  remoteCount = j.remoteCount
  renderPriceRows(j.overrides)
  $('remote-status').textContent = `远程价格库：${remoteCount} 条（覆盖文件优先于远程）`
}

function collectPrices(): Record<string, Price> {
  const out: Record<string, Price> = {}
  document.querySelectorAll('#price-rows .row.price').forEach(row => {
    const el = (cls: string) => row.querySelector(cls) as HTMLInputElement | HTMLSelectElement
    const k = (el('.pk') as HTMLInputElement).value.trim().toLowerCase()
    if (!k) return
    const input = parseFloat((el('.pi') as HTMLInputElement).value)
    const output = parseFloat((el('.po') as HTMLInputElement).value)
    if (!Number.isFinite(input) || !Number.isFinite(output)) return
    const cr = parseFloat((el('.pc') as HTMLInputElement).value)
    out[k] = {
      input,
      output,
      ...(Number.isFinite(cr) ? { cacheRead: cr } : {}),
      currency: (row as HTMLElement).dataset.cur === 'USD' ? 'USD' : 'CNY',
    }
  })
  return out
}

function flash(btnId: string, done: string, orig: string) {
  const b = $(btnId)
  b.textContent = done
  setTimeout(() => (b.textContent = orig), 1500)
}

// ---------- 手机访问（局域网共享；该面板仅在本机打开设置时可见） ----------

interface LanInfo {
  enabled: boolean
  port: number
  token: string
  urls: { name: string; url: string }[]
}

let lanInfo: LanInfo | null = null

function lanPrimaryUrl(): string {
  return lanInfo?.urls[0]?.url ?? ''
}

async function loadLanSection(retries = 3): Promise<void> {
  try {
    const r = await fetch(withToken('/api/lan-info'))
    lanInfo = r.ok ? ((await r.json()) as LanInfo) : null
  } catch {
    lanInfo = null
  }
  if (!lanInfo && retries > 0) {
    // 开关切换会触发服务端换绑、断开当前连接，稍候重试即可拿到新状态
    await new Promise(r => setTimeout(r, 600))
    return loadLanSection(retries - 1)
  }
  renderLanSection()
}

let lanPanelShown = false

function renderLanSection() {
  if (!lanInfo) {
    // 手机端访问时拿不到该接口（仅限本机），整段隐藏
    $('lan-section').classList.add('hidden')
    lanPanelShown = false
    return
  }
  $('lan-section').classList.remove('hidden')
  $('lan-toggle').textContent = lanInfo.enabled ? '关闭' : '开启'
  $('lan-toggle').classList.toggle('primary', !lanInfo.enabled)
  const primary = lanPrimaryUrl()
  if (lanInfo.enabled && primary) {
    $('lan-panel').classList.remove('hidden')
    // 只在「关→开」的那一刻播一次 reveal；loadLanSection 的重试轮询不重复触发
    if (!lanPanelShown) {
      lanPanelShown = true
      if (!reduceMotion.matches) {
        const reveal = gsap.from($('lan-panel'), { y: 4, autoAlpha: 0, duration: 0.24, ease: 'power2.out', clearProps: 'all', overwrite: true, onComplete: () => reveal.kill() })
      }
    }
    const qr = qrcode(0, 'M')
    qr.addData(primary)
    qr.make()
    $('lan-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
    $('lan-url').textContent = primary
    const rest = lanInfo.urls.filter(u => u.url !== primary)
    $('lan-alt').textContent = rest.length
      ? `其他网卡：${rest.map(u => u.url.replace(`?token=${lanInfo!.token}`, '?token=…')).join('；')}`
      : '手机需与电脑处于同一网络；在外面可用 Tailscale 等组网工具访问同一地址。'
  } else {
    $('lan-panel').classList.add('hidden')
    lanPanelShown = false
  }
}

async function saveLan(patch: { enabled?: boolean; token?: string }) {
  await post('/api/settings', {
    lanAccess: { enabled: patch.enabled ?? lanInfo?.enabled ?? false, token: patch.token ?? lanInfo?.token ?? '' },
  })
  await loadLanSection()
}

function bindLanEvents() {
  $('lan-toggle').addEventListener('click', () => void saveLan({ enabled: !(lanInfo?.enabled ?? false) }))
  $('lan-copy').addEventListener('click', () => {
    const url = lanPrimaryUrl()
    if (!url) return
    void navigator.clipboard?.writeText(url)
    flash('lan-copy', '已复制 ✓', '复制')
  })
  $('lan-regen').addEventListener('click', () => {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    void saveLan({ enabled: true, token: [...buf].map(b => b.toString(16).padStart(2, '0')).join('') })
  })
}

// ---------- 启动 ----------

function initCharts() {
  for (const id of ['spark', 'daily', 'pie', 'proj']) charts[id] = echarts.init($(id))
  window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()))
}

function bindEvents() {
  document.addEventListener('click', () => {
    for (const s of [...liveSelects]) {
      if (!s.el.isConnected) {
        liveSelects.delete(s)
        continue
      }
      if (s.isOpen) s.close()
    }
  })
  buildFilters()
  bindLanEvents()
  document.querySelectorAll('#trend-seg .seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      trendMode = (b as HTMLElement).dataset.mode as 'day' | 'month'
      document.querySelectorAll('#trend-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b))
      renderDaily()
    }),
  )
  $('btn-settings').addEventListener('click', () => void openDrawer())
  $('btn-close-drawer').addEventListener('click', closeDrawer)
  $('mask').addEventListener('click', closeDrawer)

  let qTimer = 0
  ;($('f-q') as HTMLInputElement).addEventListener('input', e => {
    filters.q = (e.target as HTMLInputElement).value
    clearTimeout(qTimer)
    qTimer = window.setTimeout(renderTable, 250)
  })

  $('s-save').addEventListener('click', async () => {
    await post('/api/settings', {
      pollIntervalSec: Number(($('s-interval') as HTMLInputElement).value),
      usdCny: Number(($('s-usd') as HTMLInputElement).value),
    })
    flash('s-save', '已保存 ✓', '保存设置')
  })

  $('p-save').addEventListener('click', async () => {
    await post('/api/settings', { providers: providerPending })
    flash('p-save', '已保存 ✓', '保存计费方式')
  })

  $('price-add').addEventListener('click', () => {
    $('price-rows').insertAdjacentHTML(
      'beforeend',
      priceRowHtml('', { input: 0, output: 0, currency: 'CNY' }),
    )
    const rows = $('price-rows').querySelectorAll('.row.price')
    const last = rows[rows.length - 1] as HTMLElement
    const curHost = last.querySelector('.sel-host.cur') as HTMLElement | null
    if (curHost) mountCurrencySelect(curHost, 'CNY')
    ;(last.querySelector('.pk') as HTMLInputElement).focus()
    // 入场与 .removing 退出的 170ms 严格对称；transition 置空避免与行上 CSS transition 叠加
    if (!reduceMotion.matches) {
      const entrance = gsap.from(last, { y: -4, autoAlpha: 0, duration: 0.17, ease: 'power2.out', transition: 'none', clearProps: 'all', overwrite: true, onComplete: () => entrance.kill() })
    }
  })

  $('price-rows').addEventListener('click', e => {
    const t = e.target as HTMLElement
    if (!t.classList.contains('del')) return
    const row = t.closest('.row.price') as HTMLElement | null
    if (!row) return
    row.classList.add('removing')
    setTimeout(() => row.remove(), 170)
  })

  $('price-save').addEventListener('click', async () => {
    const prices = collectPrices()
    await post('/api/prices', { prices })
    await loadPrices()
    flash('price-save', '已保存 ✓', '保存价格表')
  })

  $('remote-btn').addEventListener('click', async () => {
    $('remote-status').textContent = '正在从 LiteLLM 价格库拉取…'
    try {
      const r = await post('/api/prices/refresh-remote', {})
      const j = (await r.json()) as { ok: boolean; count?: number; error?: string }
      $('remote-status').textContent = j.ok ? `已更新 ${j.count} 条远程价格` : `失败：${j.error}`
    } catch (e) {
      $('remote-status').textContent = `失败：${(e as Error).message}`
    }
    await loadPrices()
  })
}

function initChartsSafe() {
  try {
    initCharts()
  } catch (e) {
    console.error('图表初始化失败', e)
  }
}

window.addEventListener('DOMContentLoaded', () => {
  bindEvents()
  initChartsSafe()
  setupReveal()
  void refresh().then(connectWs)
  connectWs()
  // PWA 应用壳缓存：只在非本机访问（手机端）时注册，不影响桌面场景
  if ('serviceWorker' in navigator && !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
    navigator.serviceWorker.register(withToken('/sw.js')).catch(() => {})
  }
})
