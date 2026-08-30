import * as echarts from 'echarts'
import type { Snapshot, Totals, WireRecord } from '../src/core/types'

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
let lastTableSig = ''

const $ = (id: string) => document.getElementById(id) as HTMLElement
const pad = (n: number) => String(n).padStart(2, '0')
const COLORS = ['#22d3ee', '#34d399', '#a78bfa', '#f59e0b', '#f472b6', '#60a5fa', '#f87171', '#4ade80', '#fb923c', '#38bdf8']

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function fmtTokens(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString('zh-CN')
}

function fmtCost(c: number | null | undefined): string {
  return c == null ? '—' : '¥' + c.toFixed(2)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p || '—'
}

const totalTok = (r: Pick<WireRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>) =>
  r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens

function totalsSub(t: Totals): string {
  const parts: string[] = []
  if (t.planCost != null) parts.push(`套餐内 ¥${t.planCost.toFixed(2)}`)
  if (t.meteredCost != null) parts.push(`按量 ¥${t.meteredCost.toFixed(2)}`)
  if (t.costUnknown) parts.push(`${t.costUnknown} 条未定价`)
  return parts.join(' · ') || '—'
}

function costLabel(c: number | null, unknown?: number): string {
  return c == null ? '—' : '¥' + c.toFixed(2) + (unknown ? '+' : '')
}

// ---------- 渲染 ----------

function renderCards() {
  if (!snap) return
  const t = snap.today
  const m = snap.month
  $('c-today-tok').textContent = fmtTokens(t.tokens)
  $('c-today-sub').textContent = `输入 ${fmtTokens(t.inputTokens)} · 输出 ${fmtTokens(t.outputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens + t.cacheWriteTokens)}`
  $('c-today-cost').textContent = costLabel(t.cost, t.costUnknown)
  $('c-today-cost-sub').textContent = totalsSub(t)
  $('c-month-cost').textContent = costLabel(m.cost, m.costUnknown)
  $('c-month-sub').textContent = `本月 ${fmtTokens(m.tokens)} tok · ${m.requests} 次请求 · ${snap.projects.length} 个项目`
  $('c-req').textContent = String(t.requests)
  $('c-src').textContent = snap.sources.map(s => `${s.id === 'zcode' ? 'ZCode' : 'Codex'} ${s.ok ? '✓' : '✗'} ${s.records}`).join(' · ')
}

function renderSpark() {
  const tl = snap!.timeline
  charts.spark.setOption({
    grid: { left: 48, right: 10, top: 12, bottom: 22 },
    xAxis: {
      type: 'category',
      data: tl.map(p => p.minute),
      axisLabel: { interval: 9, color: '#64748b', fontSize: 10 },
      axisLine: { lineStyle: { color: '#1e2a44' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (v: number) => fmtTokens(v), color: '#64748b', fontSize: 10 },
      splitLine: { lineStyle: { color: '#16203a' } },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#16203a', borderColor: '#1e2a44', textStyle: { color: '#e2e8f0', fontSize: 11 },
      formatter: (ps: { name: string; value: number }[]) => `${ps[0].name}<br/>tokens：<b>${fmtTokens(ps[0].value)}</b>`,
    },
    series: [{
      type: 'bar',
      data: tl.map(p => p.tokens),
      itemStyle: { color: '#22d3ee', opacity: 0.85, borderRadius: [2, 2, 0, 0] },
      barCategoryGap: '25%',
      animation: false,
    }],
  })
}

function renderDaily() {
  const dl = snap!.daily
  charts.daily.setOption({
    grid: { left: 52, right: 52, top: 30, bottom: 24 },
    legend: { data: ['tokens', '成本'], textStyle: { color: '#94a3b8', fontSize: 11 }, top: 0, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#16203a', borderColor: '#1e2a44', textStyle: { color: '#e2e8f0', fontSize: 11 },
      valueFormatter: (v: number) => (typeof v === 'number' ? v.toLocaleString('zh-CN') : String(v)),
    },
    xAxis: {
      type: 'category',
      data: dl.map(p => p.date),
      axisLabel: { interval: 4, color: '#64748b', fontSize: 10 },
      axisLine: { lineStyle: { color: '#1e2a44' } },
    },
    yAxis: [
      { type: 'value', axisLabel: { formatter: (v: number) => fmtTokens(v), color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: '#16203a' } } },
      { type: 'value', axisLabel: { formatter: (v: number) => '¥' + v, color: '#64748b', fontSize: 10 }, splitLine: { show: false } },
    ],
    series: [
      {
        name: 'tokens', type: 'bar', data: dl.map(p => p.tokens),
        itemStyle: { color: '#38bdf8', opacity: 0.8, borderRadius: [2, 2, 0, 0] },
        barCategoryGap: '30%', animation: false,
      },
      {
        name: '成本', type: 'line', yAxisIndex: 1, data: dl.map(p => p.cost),
        itemStyle: { color: '#fbbf24' }, lineStyle: { color: '#fbbf24', width: 2 },
        symbolSize: 3, connectNulls: true, animation: false,
      },
    ],
  })
}

function renderPie() {
  const bm = snap!.byModelMonth
  const top = bm.slice(0, 8)
  const rest = bm.slice(8)
  const data = top.map(b => ({ name: b.key, value: b.tokens }))
  if (rest.length) {
    data.push({ name: '其他', value: rest.reduce((s, b) => s + b.tokens, 0) })
  }
  charts.pie.setOption({
    color: COLORS,
    tooltip: {
      trigger: 'item',
      backgroundColor: '#16203a', borderColor: '#1e2a44', textStyle: { color: '#e2e8f0', fontSize: 11 },
      formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/>${fmtTokens(p.value)}（${p.percent}%）`,
    },
    legend: {
      type: 'scroll', orient: 'vertical', right: 0, top: 'middle',
      textStyle: { color: '#94a3b8', fontSize: 10 }, itemWidth: 10, itemHeight: 10,
      pageIconColor: '#22d3ee', pageTextStyle: { color: '#64748b' },
    },
    series: [{
      type: 'pie',
      radius: ['42%', '70%'],
      center: ['36%', '50%'],
      data,
      label: { color: '#94a3b8', fontSize: 10, formatter: '{d}%' },
      itemStyle: { borderColor: '#111a2c', borderWidth: 1 },
      animation: false,
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
      axisLabel: { formatter: (v: number) => fmtTokens(v), color: '#64748b', fontSize: 10 },
      splitLine: { lineStyle: { color: '#16203a' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      inverse: true,
      axisLabel: {
        color: '#94a3b8', fontSize: 10,
        formatter: (v: string) => (v.length > 14 ? v.slice(0, 13) + '…' : v),
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#16203a', borderColor: '#1e2a44', textStyle: { color: '#e2e8f0', fontSize: 11 },
      formatter: (p: { name: string; value: number }) => `${p.name}<br/>${fmtTokens(p.value)} tok`,
    },
    series: [{
      type: 'bar',
      data: bp.map(b => b.tokens),
      itemStyle: { color: '#34d399', opacity: 0.85, borderRadius: [0, 3, 3, 0] },
      barMaxWidth: 14,
      animation: false,
    }],
  })
}

function renderRecent() {
  const list = snap!.recent.slice(0, 12)
  $('recent').innerHTML =
    list
      .map(
        r => `<div class="rec">
          <span class="t mono">${fmtTime(r.ts)}</span>
          <span class="m mono" title="${esc(r.model)}">${esc(r.model)}</span>
          <span class="p" title="${esc(r.project)}">${esc(shortPath(r.project))}</span>
          <b>${fmtTokens(totalTok(r))}</b>
          <span class="c">${fmtCost(r.cost)}</span>
        </div>`,
      )
      .join('') || '<div class="empty">暂无请求</div>'
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
    <td>${r.source === 'zcode' ? 'ZCode' : r.source === 'codex' ? 'Codex' : esc(r.source)}</td>
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

function populateFilters() {
  const fill = (sel: HTMLSelectElement, values: string[], labeler: (v: string) => string) => {
    const cur = sel.value
    sel.innerHTML =
      `<option value="">${sel.id === 'f-project' ? '全部项目' : '全部模型'}</option>` +
      values.map(v => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(labeler(v))}</option>`).join('')
  }
  fill($('f-project') as HTMLSelectElement, snap!.projects, shortPath)
  fill($('f-model') as HTMLSelectElement, snap!.models, v => v)
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
  const r = await fetch('/api/state')
  applySnap(await r.json())
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)
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
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function openDrawer() {
  $('drawer').classList.remove('hidden')
  $('mask').classList.remove('hidden')
  const st = (await (await fetch('/api/settings')).json()) as { pollIntervalSec: number; usdCny: number; providers: Record<string, string>; defaultBilling: string }
  ;($('s-interval') as HTMLInputElement).value = String(st.pollIntervalSec)
  ;($('s-usd') as HTMLInputElement).value = String(st.usdCny)
  renderProviderRows(st.providers, st.defaultBilling as 'metered' | 'plan')
  await loadPrices()
}

function closeDrawer() {
  $('drawer').classList.add('hidden')
  $('mask').classList.add('hidden')
}

function renderProviderRows(providers: Record<string, string>, defaultBilling: 'metered' | 'plan') {
  const ids = new Set<string>([...(snap?.providers.map(p => p.id) ?? []), ...Object.keys(providers)])
  $('provider-rows').innerHTML =
    [...ids]
      .sort()
      .map(id => {
        const val = providers[id] ?? defaultBilling
        return `<div class="row"><code title="${esc(id)}">${esc(id)}</code>
          <select data-id="${esc(id)}">
            <option value="metered"${val === 'metered' ? ' selected' : ''}>按量计费</option>
            <option value="plan"${val === 'plan' ? ' selected' : ''}>套餐内</option>
          </select></div>`
      })
      .join('') || '<div class="empty">暂无数据</div>'
}

let remoteCount = 0

function priceRowHtml(k: string, v: Price): string {
  return `<div class="row price" data-k="${esc(k)}">
    <input class="pk" value="${esc(k)}" placeholder="模型 ID" title="模型 ID（小写匹配）">
    <input class="pi" type="number" step="any" value="${v.input}" title="输入价 / 1M tok">
    <input class="po" type="number" step="any" value="${v.output}" title="输出价 / 1M tok">
    <input class="pc" type="number" step="any" value="${v.cacheRead ?? ''}" title="缓存读价（可空）">
    <select class="pu">
      <option value="CNY"${v.currency === 'CNY' ? ' selected' : ''}>CNY</option>
      <option value="USD"${v.currency === 'USD' ? ' selected' : ''}>USD</option>
    </select>
    <button class="del" title="删除">✕</button>
  </div>`
}

function renderPriceRows(overrides: Record<string, Price>) {
  const entries = Object.entries(overrides)
  $('price-rows').innerHTML =
    entries.map(([k, v]) => priceRowHtml(k, v)).join('') ||
    '<div class="empty">暂无覆盖价格 — 点「添加模型」新增</div>'
}

async function loadPrices() {
  const j = (await (await fetch('/api/prices')).json()) as { overrides: Record<string, Price>; remoteCount: number }
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
      currency: (el('.pu') as HTMLSelectElement).value === 'USD' ? 'USD' : 'CNY',
    }
  })
  return out
}

function flash(btnId: string, done: string, orig: string) {
  const b = $(btnId)
  b.textContent = done
  setTimeout(() => (b.textContent = orig), 1500)
}

// ---------- 启动 ----------

function initCharts() {
  for (const id of ['spark', 'daily', 'pie', 'proj']) charts[id] = echarts.init($(id))
  window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()))
}

function bindEvents() {
  $('btn-settings').addEventListener('click', () => void openDrawer())
  $('btn-close-drawer').addEventListener('click', closeDrawer)
  $('mask').addEventListener('click', closeDrawer)

  ;($('f-source') as HTMLSelectElement).addEventListener('change', e => {
    filters.source = (e.target as HTMLSelectElement).value
    renderTable()
  })
  ;($('f-project') as HTMLSelectElement).addEventListener('change', e => {
    filters.project = (e.target as HTMLSelectElement).value
    renderTable()
  })
  ;($('f-model') as HTMLSelectElement).addEventListener('change', e => {
    filters.model = (e.target as HTMLSelectElement).value
    renderTable()
  })
  ;($('f-range') as HTMLSelectElement).addEventListener('change', e => {
    filters.range = (e.target as HTMLSelectElement).value
    renderTable()
  })
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
    const prov: Record<string, string> = {}
    document.querySelectorAll('#provider-rows select').forEach(s => {
      const sel = s as HTMLSelectElement
      if (sel.dataset.id) prov[sel.dataset.id] = sel.value
    })
    await post('/api/settings', { providers: prov })
    flash('p-save', '已保存 ✓', '保存计费方式')
  })

  $('price-add').addEventListener('click', () => {
    $('price-rows').insertAdjacentHTML(
      'beforeend',
      priceRowHtml('', { input: 0, output: 0, currency: 'CNY' }),
    )
    const rows = $('price-rows').querySelectorAll('.row.price')
    const last = rows[rows.length - 1] as HTMLElement
    ;(last.querySelector('.pk') as HTMLInputElement).focus()
  })

  $('price-rows').addEventListener('click', e => {
    const t = e.target as HTMLElement
    if (t.classList.contains('del')) t.closest('.row.price')?.remove()
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
  void refresh().then(connectWs)
  connectWs()
})
