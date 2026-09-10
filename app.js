/* 全市场异动雷达：数据接入、异动评分与页面交互 */
const state = {
  markets: [],
  selected: null,
  source: 'all',
  countdown: 30,
  loading: false,
  timer: null,
  demoMode: false
};

const $ = (selector) => document.querySelector(selector);
const els = {
  systemStatus: $('#systemStatus'), countdown: $('#countdown'), refreshButton: $('#refreshButton'), scanTime: $('#scanTime'),
  radarCount: $('#radarCount'), marketCount: $('#marketCount'), alertCount: $('#alertCount'), riseCount: $('#riseCount'), fallCount: $('#fallCount'),
  gateStatus: $('#gateStatus'), hyperStatus: $('#hyperStatus'), radarPoints: $('#radarPoints'), marketTable: $('#marketTable'), emptyState: $('#emptyState'),
  buyBar: $('#buyBar'), sellBar: $('#sellBar'), buyPercent: $('#buyPercent'), sellPercent: $('#sellPercent'), marketSummary: $('#marketSummary'),
  scoreFilter: $('#scoreFilter'), directionFilter: $('#directionFilter'), searchInput: $('#searchInput'), briefContent: $('#briefContent'), briefLevel: $('#briefLevel'), toast: $('#toast')
};

const DEMO_MARKETS = [
  { symbol: 'ZORA', source: 'Gate.io', price: 0.09142, change: 18.64, volume: 28400000, activity: 96, direction: 'rise', score: 92 },
  { symbol: 'HYPE', source: 'Hyperliquid', price: 46.82, change: 11.28, volume: 189000000, activity: 89, direction: 'rise', score: 87 },
  { symbol: 'PUMP', source: 'Gate.io', price: 0.00418, change: -9.72, volume: 41800000, activity: 91, direction: 'fall', score: 84 },
  { symbol: 'PENGU', source: 'Hyperliquid', price: 0.02175, change: 8.91, volume: 76000000, activity: 79, direction: 'rise', score: 78 },
  { symbol: 'SUI', source: 'Gate.io', price: 3.162, change: -6.42, volume: 223000000, activity: 74, direction: 'fall', score: 73 },
  { symbol: 'FARTCOIN', source: 'Gate.io', price: 0.8421, change: 7.33, volume: 33400000, activity: 68, direction: 'rise', score: 70 },
  { symbol: 'BTC', source: 'Hyperliquid', price: 112842, change: 2.41, volume: 1240000000, activity: 63, direction: 'rise', score: 61 },
  { symbol: 'ETH', source: 'Gate.io', price: 4368.7, change: -3.28, volume: 856000000, activity: 58, direction: 'fall', score: 57 },
  { symbol: 'SOL', source: 'Hyperliquid', price: 224.13, change: 4.88, volume: 512000000, activity: 55, direction: 'rise', score: 55 },
  { symbol: 'DOGE', source: 'Gate.io', price: 0.2146, change: -4.02, volume: 179000000, activity: 48, direction: 'fall', score: 49 }
];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function formatPrice(value) {
  if (!Number.isFinite(value)) return '--';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}
function formatVolume(value) {
  if (!Number.isFinite(value)) return '--';
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove('show'), 2600);
}
function setConnection(status, mode) {
  els.systemStatus.textContent = status;
  const dot = document.querySelector('.live-dot');
  dot.className = `live-dot ${mode || ''}`;
}

async function fetchJson(url, options, timeout = 8000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { window.clearTimeout(timer); }
}

async function fetchGateMarkets() {
  const data = await fetchJson('https://api.gateio.ws/api/v4/spot/tickers');
  return data.filter((item) => item.currency_pair.endsWith('_USDT') && Number(item.quote_volume) > 10000).map((item) => {
    const change = Number(item.change_percentage) || 0;
    const volume = Number(item.quote_volume) || 0;
    return { symbol: item.currency_pair.replace('_USDT', ''), source: 'Gate.io', price: Number(item.last), change, volume, direction: change >= 0 ? 'rise' : 'fall', rawActivity: volume };
  });
}

async function fetchHyperliquidMarkets() {
  const result = await fetchJson('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
  const meta = result[0]?.universe || [];
  const contexts = result[1] || [];
  return meta.map((asset, index) => {
    const ctx = contexts[index] || {};
    const mark = Number(ctx.markPx || ctx.oraclePx || 0);
    const dayNotional = Number(ctx.dayNtlVlm || 0);
    const prevDayPx = Number(ctx.prevDayPx || 0);
    const change = prevDayPx > 0 ? ((mark / prevDayPx) - 1) * 100 : 0;
    return { symbol: asset.name, source: 'Hyperliquid', price: mark, change, volume: dayNotional, direction: change >= 0 ? 'rise' : 'fall', rawActivity: dayNotional };
  }).filter((item) => item.price > 0 && item.volume > 0);
}

function scoreMarkets(markets) {
  const volumes = markets.map((item) => item.rawActivity || item.volume).sort((a, b) => a - b);
  const percentile = (value) => {
    if (!volumes.length) return 0;
    const rank = volumes.findIndex((entry) => entry >= value);
    return Math.round(((rank < 0 ? volumes.length - 1 : rank) / Math.max(volumes.length - 1, 1)) * 100);
  };
  return markets.map((item) => {
    const activity = percentile(item.rawActivity || item.volume);
    const moveScore = Math.min(Math.abs(item.change) * 5.3, 82);
    const directionBonus = Math.abs(item.change) >= 2 ? 8 : 2;
    return { ...item, activity, score: Math.min(99, Math.round(moveScore * .62 + activity * .3 + directionBonus)), direction: item.change >= 0 ? 'rise' : 'fall' };
  }).sort((a, b) => b.score - a.score);
}

async function loadMarkets() {
  if (state.loading) return;
  state.loading = true; els.refreshButton.disabled = true; setConnection('正在拉取行情', '');
  els.gateStatus.textContent = '连接中'; els.hyperStatus.textContent = '连接中';
  try {
    const [gateResult, hyperResult] = await Promise.allSettled([fetchGateMarkets(), fetchHyperliquidMarkets()]);
    const liveMarkets = [...(gateResult.status === 'fulfilled' ? gateResult.value : []), ...(hyperResult.status === 'fulfilled' ? hyperResult.value : [])];
    if (liveMarkets.length < 5) throw new Error('公开接口返回不足');
    state.markets = scoreMarkets(liveMarkets); state.demoMode = false;
    els.gateStatus.textContent = gateResult.status === 'fulfilled' ? '已连接' : '暂不可用'; els.hyperStatus.textContent = hyperResult.status === 'fulfilled' ? '已连接' : '暂不可用';
    setConnection('实时监控中', 'online');
  } catch (error) {
    state.markets = scoreMarkets(DEMO_MARKETS.map((item) => ({ ...item, rawActivity: item.volume })));
    state.demoMode = true; els.gateStatus.textContent = '演示数据'; els.hyperStatus.textContent = '演示数据'; setConnection('演示模式', 'warning');
    toast('部分公开接口暂不可达，已切换演示数据，页面功能仍可体验');
  } finally {
    state.loading = false; els.refreshButton.disabled = false; state.countdown = 30; render();
  }
}

function getFilteredMarkets() {
  const minScore = Number(els.scoreFilter.value);
  const direction = els.directionFilter.value;
  const query = els.searchInput.value.trim().toUpperCase();
  return state.markets.filter((item) => (state.source === 'all' || item.source === state.source) && item.score >= minScore && (direction === 'all' || item.direction === direction) && (!query || item.symbol.includes(query)));
}
function renderTable() {
  const markets = getFilteredMarkets(); els.emptyState.hidden = markets.length > 0;
  if (!markets.length) { els.marketTable.innerHTML = ''; return; }
  els.marketTable.innerHTML = markets.slice(0, 30).map((item, index) => {
    const changeClass = item.change >= 0 ? 'rise' : 'fall';
    const sign = item.change >= 0 ? '+' : '';
    return `<tr data-symbol="${escapeHtml(item.symbol)}" class="${state.selected?.symbol === item.symbol ? 'selected' : ''}">
      <td class="rank">${String(index + 1).padStart(2, '0')}</td>
      <td><div class="asset-cell"><span class="asset-icon">${escapeHtml(item.symbol.slice(0, 3))}</span><span class="asset-name"><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.source)}</small></span></div></td>
      <td>${formatPrice(item.price)}</td><td class="${changeClass}">${sign}${item.change.toFixed(2)}%</td><td>${formatVolume(item.volume)}</td>
      <td><div class="score-wrap"><span>${item.activity}%</span><span class="score-bar"><i style="width:${item.activity}%"></i></span></div></td>
      <td><span class="direction-pill ${item.direction}">${item.direction === 'rise' ? '主动买盘' : '主动卖盘'}</span></td>
      <td><div class="score-wrap"><strong>${item.score}</strong><span class="score-bar"><i style="width:${item.score}%"></i></span></div></td></tr>`;
  }).join('');
  els.marketTable.querySelectorAll('tr[data-symbol]').forEach((row) => row.addEventListener('click', () => { state.selected = state.markets.find((item) => item.symbol === row.dataset.symbol); render(); }));
}
function renderRadar(markets) {
  const targets = markets.slice(0, 14); els.radarPoints.innerHTML = targets.map((item, index) => {
    const angle = (index * 137.5 + 18) * Math.PI / 180; const radius = 15 + (index * 11) % 32;
    const left = 50 + Math.cos(angle) * radius; const top = 50 + Math.sin(angle) * radius;
    return `<span class="radar-point ${item.direction === 'fall' ? 'fall' : item.score > 80 ? 'hot' : ''}" style="left:${left}%;top:${top}%" title="${escapeHtml(item.symbol)}"></span>`;
  }).join(''); els.radarCount.textContent = targets.length;
}
function renderBrief(item) {
  if (!item) { els.briefLevel.textContent = '等待数据'; els.briefContent.innerHTML = '<div class="brief-placeholder"><div class="pulse-orb"></div><h3>雷达正在扫描</h3><p>完成首轮扫描后，系统会选择异动强度最高的币种生成简报。</p></div>'; return; }
  const isRise = item.direction === 'rise'; const changeClass = isRise ? 'rise' : 'fall'; const directionText = isRise ? '买盘偏强' : '卖压偏强';
  els.briefLevel.textContent = item.score >= 80 ? '高关注' : '中关注'; els.briefLevel.className = `risk-tag ${item.score >= 80 ? 'high' : 'medium'}`;
  els.briefContent.innerHTML = `<div class="brief-hero"><div class="brief-symbol"><h3>${escapeHtml(item.symbol)}</h3><span class="${changeClass}">${directionText}</span></div><div class="brief-price">${formatPrice(item.price)} <span class="${changeClass}">${isRise ? '+' : ''}${item.change.toFixed(2)}%</span></div><div class="brief-grid"><div><small>异动强度</small><b>${item.score}/100</b></div><div><small>成交活跃度</small><b>${item.activity}% 分位</b></div><div><small>24h 成交额</small><b>${formatVolume(item.volume)}</b></div><div><small>数据平台</small><b>${escapeHtml(item.source)}</b></div></div></div><div class="brief-section"><h4>智能摘要</h4><p>${escapeHtml(item.symbol)} 当前价格${isRise ? '向上' : '向下'}偏移，24h 变动为 <b class="${changeClass}">${isRise ? '+' : ''}${item.change.toFixed(2)}%</b>。成交活跃度处于样本的 ${item.activity} 分位，系统将其归类为<strong>${item.score >= 80 ? '显著异动' : '可观察异动'}</strong>。</p></div><div class="brief-section"><h4>证据链</h4><div class="evidence-list"><div class="evidence"><b>01</b><span>价格偏移贡献：${Math.abs(item.change).toFixed(2)}% 的方向性变化。</span></div><div class="evidence"><b>02</b><span>成交活跃贡献：成交额横截面分位 ${item.activity}%，需要结合历史基线复核。</span></div><div class="evidence"><b>03</b><span>风险提示：公开行情快照无法确认真实主动成交，谨防低流动性或短时脉冲。</span></div></div></div>`;
}
function render() {
  const filtered = getFilteredMarkets(); const all = state.markets;
  const rise = all.filter((item) => item.change >= 5).length; const fall = all.filter((item) => item.change <= -5).length; const alerts = all.filter((item) => item.score >= 60).length;
  els.marketCount.textContent = all.length.toLocaleString(); els.alertCount.textContent = alerts.toLocaleString(); els.riseCount.textContent = rise.toLocaleString(); els.fallCount.textContent = fall.toLocaleString();
  const positive = all.filter((item) => item.direction === 'rise').length; const buy = all.length ? Math.round(positive / all.length * 100) : 50;
  els.buyBar.style.width = `${buy}%`; els.sellBar.style.width = `${100 - buy}%`; els.buyPercent.textContent = `${buy}%`; els.sellPercent.textContent = `${100 - buy}%`;
  els.marketSummary.textContent = state.demoMode ? '当前为演示数据。点击“立即扫描”可重新尝试接入公开行情。' : `当前监测 ${all.length.toLocaleString()} 个市场，其中 ${alerts} 个达到显著异动阈值；榜单按综合强度排序。`;
  els.scanTime.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${state.demoMode ? ' · 演示' : ''}`;
  renderRadar(all); renderTable(); renderBrief(state.selected || filtered[0] || all[0]);
}
function tick() { state.countdown -= 1; els.countdown.textContent = `${Math.max(state.countdown, 0)}s`; if (state.countdown <= 0) loadMarkets(); }

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active')); tab.classList.add('active'); state.source = tab.dataset.source; render(); }));
els.scoreFilter.addEventListener('change', render); els.directionFilter.addEventListener('change', render); els.searchInput.addEventListener('input', render); els.refreshButton.addEventListener('click', loadMarkets);
state.timer = window.setInterval(tick, 1000); loadMarkets();
