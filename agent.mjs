#!/usr/bin/env node
/* ==============================================================================
 * 全市场异动雷达智能体 · 命令行入口（agent.mjs）
 * ==============================================================================
 * 四条数据通道，结论全部由本项目自己的评分引擎（app.js 里的 scoreMarkets）给出：
 *
 *   默认      多平台实时对照（Gate.io + Hyperliquid，与网页版完全同口径）
 *   --live    币安官方公开行情接口 data-api.binance.vision 全市场现货快照
 *   --skill   官方技能 binance 驱动的官方 CLI（binance-cli）取同一份官方公开行情；
 *             未安装 CLI 时如实回退到 --live 并在输出里说明
 *   --official 币安官方开源数据仓库 data.binance.vision 的历史归档（合约 K 线 + 合约指标）
 *             逐币拼装快照，T+1，多送一个"持仓量"维度
 *
 * 引擎复用方式：从 app.js 源码里按函数边界原样提取评分与取数函数（不含页面渲染部分），
 * 每个提取片段都会断言"逐字节存在于 app.js 原文"——网页与命令行用的是同一段代码。
 *
 * 铁律：
 *   · stdout 在 --json 模式下只输出纯 JSON，一切进度与说明走 stderr；
 *   · 绝不伪造数据：取不到就报错退出，命令行不提供演示数据降级（网页版的演示数据
 *     有明确标注，命令行一旦掺入反而说不清）。
 * ============================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'quanshichang-yidong-agent/1.0 (binance official public data)';

const DATA_API = 'https://data-api.binance.vision';
const DATA_REPO = 'https://data.binance.vision';

/* ------------------------------------------------------------------ 工具 */

let QUIET = false;
function say(msg = '') { if (!QUIET) process.stderr.write(msg + '\n'); }
function progressInline(msg) { if (!QUIET) process.stderr.write(msg); }

function jsonParseLoose(text) {
  try { return JSON.parse(text); } catch { /* 继续尝试截取 */ }
  const s = text.indexOf('[') >= 0 ? Math.min(...[text.indexOf('['), text.indexOf('{')].filter((x) => x >= 0)) : text.indexOf('{');
  if (s > 0) return JSON.parse(text.slice(s));
  throw new Error('输出不是合法 JSON');
}

/* ------------------------------------------------- 引擎提取（源码级复用 app.js） */

/** 从源码里按大括号配对提取一个完整函数（这六个函数都不含会干扰配对的语法） */
function extractFunction(src, name) {
  // ⚠️ 先试 async 前缀再试普通声明：如果直接搜 "function name("，
  // 它是 "async function name(" 的子串，会把 async 关键字切丢，await 就非法了
  let marker = `async function ${name}(`;
  let start = src.indexOf(marker);
  if (start < 0) { marker = `function ${name}(`; start = src.indexOf(marker); }
  if (start < 0) throw new Error(`app.js 里找不到函数 ${name}()`);
  let i = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`函数 ${name}() 大括号不配对，提取失败`);
  return src.slice(start, end);
}

/**
 * 加载网页引擎：提取 fetchJson / fetchGateMarkets / fetchHyperliquidMarkets /
 * scoreMarkets / formatPrice / formatVolume 六个函数原样求值。
 * 断言：每个提取片段必须逐字节存在于 app.js 原文 —— 证明用的是网页同一段代码、一字未改。
 */
function loadWebEngine() {
  const appJsPath = path.join(ROOT, 'app.js');
  const src = fs.readFileSync(appJsPath, 'utf8');
  const names = ['fetchJson', 'fetchGateMarkets', 'fetchHyperliquidMarkets', 'scoreMarkets', 'formatPrice', 'formatVolume'];
  const parts = names.map((n) => extractFunction(src, n));
  for (const p of parts) {
    if (!src.includes(p)) throw new Error('提取片段与 app.js 原文不一致（引擎可能被改动过），拒绝运行');
  }
  // fetchJson 内部引用 window.setTimeout —— Node 里让 window 指向全局即可，无需改 app.js
  globalThis.window = globalThis;
  const factory = new Function(parts.join('\n') + `\nreturn { ${names.join(', ')} };`);
  return factory();
}

const WEB = loadWebEngine();
const scoreMarkets = WEB.scoreMarkets;
const fmtPrice = WEB.formatPrice;
const fmtVol = WEB.formatVolume;

/* ------------------------------------------------------------- 默认通道取数 */

/** 与网页版 loadMarkets 同一套：Gate + Hyperliquid，两边各自成败互不影响 */
async function collectGlobal() {
  const [gate, hyper] = await Promise.allSettled([WEB.fetchGateMarkets(), WEB.fetchHyperliquidMarkets()]);
  const list = [
    ...(gate.status === 'fulfilled' ? gate.value : []),
    ...(hyper.status === 'fulfilled' ? hyper.value : []),
  ];
  if (list.length < 5) throw new Error('两个公开行情接口都没能取回数据（网页版此时会切换演示数据，命令行不做演示降级，如实报错）');
  return {
    rows: list,
    via: 'multi-platform',
    label: '多平台实时对照（与网页版同口径）',
    notes: [
      `Gate.io ${gate.status === 'fulfilled' ? '取到 ' + gate.value.length + ' 个' : '未取到'}，Hyperliquid ${hyper.status === 'fulfilled' ? '取到 ' + hyper.value.length + ' 个' : '未取到'}`,
    ],
  };
}

/* ------------------------------------------------------------- --live 通道 */

/** 官方公开行情：一次请求拿全市场现货快照，装进引擎认的形状后交给同一个评分函数 */
async function collectLive() {
  const url = `${DATA_API}/api/v3/ticker/24hr`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`官方公开行情返回 HTTP ${res.status}`);
  const data = await res.json();
  const rows = data
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({
      symbol: t.symbol.replace(/USDT$/, ''),
      source: '币安官方公开行情',
      price: Number(t.lastPrice),
      change: Number(t.priceChangePercent) || 0,
      volume: Number(t.quoteVolume) || 0,
      rawActivity: Number(t.quoteVolume) || 0,
    }))
    .filter((r) => r.price > 0 && r.volume > 10000);
  if (rows.length < 5) throw new Error('官方公开行情取回的交易对不足');
  return { rows, via: 'official-rest', label: '币安官方公开行情（现货全市场快照）', notes: [`原始返回 ${data.length} 个交易对，按 USDT 计价 + 24h 成交额 > $10,000 过滤后 ${rows.length} 个`] };
}

/* ------------------------------------------------------------- --skill 通道 */

/** 官方 CLI 位置：优先环境变量，其次 PATH */
function binanceCliBin() {
  if (process.env.BINANCE_CLI_PATH && fs.existsSync(process.env.BINANCE_CLI_PATH)) {
    return process.env.BINANCE_CLI_PATH;
  }
  return 'binance-cli'; // 交给 spawnSync 去找；找不到会报 ENOENT，走如实回退
}

function cliGetJson(url) {
  const exe = binanceCliBin();
  const r = spawnSync(exe, ['request', 'GET', url], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, // 全市场快照约 3.5 MB，默认 1MB 会爆
    timeout: 90_000,
  });
  if (r.error) throw new Error(`官方 CLI 不可用（${r.error.code || r.error.message}）`);
  if (r.status !== 0) throw new Error(`官方 CLI 退出码 ${r.status}：${String(r.stderr || '').slice(0, 200)}`);
  return jsonParseLoose(String(r.stdout || ''));
}

async function collectSkill() {
  const url = `${DATA_API}/api/v3/ticker/24hr`;
  try {
    const data = cliGetJson(url);
    const rows = data
      .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
      .map((t) => ({
        symbol: t.symbol.replace(/USDT$/, ''),
        source: '币安官方公开行情',
        price: Number(t.lastPrice),
        change: Number(t.priceChangePercent) || 0,
        volume: Number(t.quoteVolume) || 0,
        rawActivity: Number(t.quoteVolume) || 0,
      }))
      .filter((r) => r.price > 0 && r.volume > 10000);
    if (rows.length < 5) throw new Error('官方 CLI 取回的交易对不足');
    return {
      rows, via: 'binance-cli', label: '官方技能 binance + 官方 CLI（同一份官方公开行情）',
      notes: [`请求由官方 CLI 发起：binance-cli request GET <官方公开行情地址>`],
    };
  } catch (err) {
    say(`  [如实回退] 官方 CLI 本次没能取到数（${String(err.message).slice(0, 120)}）`);
    say('  [如实回退] 改走官方公开行情接口（同一份数据的另一个官方入口）。');
    say('  [如实回退] 官方 CLI 安装（Windows 版在 v2.0.0）：');
    say('             https://github.com/binance/binance-cli/releases/download/v2.0.0/binance-cli-x86_64-pc-windows-gnu.zip');
    const out = await collectLive();
    out.requestedSource = 'skill';
    out.label = '官方公开行情（官方 CLI 未装成，已如实回退）';
    out.notes.push('本次并非经官方 CLI 调用，已如实标注。');
    return out;
  }
}

/* ---------------------------------------------------------- --official 通道 */

function ymd(d) { return d.toISOString().slice(0, 10); }

function archiveKlinesUrl(market, pair, interval, date) {
  return `${DATA_REPO}/data/${market}/daily/klines/${pair}/${interval}/${pair}-${interval}-${date}.zip`;
}
function archiveMetricsUrl(pair, date) {
  return `${DATA_REPO}/data/futures/um/daily/metrics/${pair}/${pair}-metrics-${date}.zip`;
}

/** 下载 ZIP 并解出 CSV 文本；404/403 → null（归档未发布），其它错误如实抛出 */
async function fetchZipText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`归档下载失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return unzipFirstEntry(buf);
}

/** Node 没有内置解压：按本地文件头解第一个条目（官方归档每个 ZIP 只放一个 CSV） */
function unzipFirstEntry(buf) {
  const sig = buf.indexOf('PK\x03\x04');
  if (sig < 0) throw new Error('不是合法的 ZIP 文件');
  const method = buf.readUInt16LE(sig + 8);
  const csize = buf.readUInt32LE(sig + 18);
  const nameLen = buf.readUInt16LE(sig + 26);
  const extraLen = buf.readUInt16LE(sig + 28);
  const dataStart = sig + 30 + nameLen + extraLen;
  if (method === 0) return buf.slice(dataStart, dataStart + (csize || buf.length - dataStart)).toString('utf8');
  let raw = buf.slice(dataStart, csize ? dataStart + csize : undefined);
  if (!csize) {
    const cd = buf.indexOf('PK\x01\x02', dataStart);
    if (cd > dataStart) raw = buf.slice(dataStart, cd);
  }
  return zlib.inflateRawSync(raw).toString('utf8');
}

/** 官方文件名日期带横线；时间戳精度不一（毫秒/微秒），按量级自适应 */
function normTs(x) { let v = Number(x); while (v > 1e14) v = Math.floor(v / 1000); return v; }

function parseKlinesCsv(text, headerExpected) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const c = line.split(',');
    if (!/^\d+(\.\d+)?$/.test(c[0])) continue; // 首列不是数字 → 表头，跳过（对带/不带表头都稳）
    rows.push({ t: normTs(c[0]), open: Number(c[1]), close: Number(c[4]), quoteVolume: Number(c[7]) });
  }
  return rows;
}

function parseMetricsCsv(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const c = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}/.test(c[0]) && !/^\d+$/.test(c[0])) continue;
    // 表头：create_time, symbol, sum_open_interest(币本位), sum_open_interest_value(美元值), ...
    // ⚠️ 美元值在第 3 列（索引 3），第 2 列是币本位数量 —— 用错会差几个数量级（实测踩过）
    rows.push({ oiUsd: c[3] !== undefined && c[3] !== '' ? Number(c[3]) : null });
  }
  return rows;
}

async function exists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false; // 与"不存在"同路径处理，但外层会对 0 命中如实报错
  }
}

/** 官方存在"面值币"代码（PEPE 实际是 1000PEPEUSDT），逐个试倍数前缀 */
function faceValueCandidates(base) { return [`${base}USDT`, `1000${base}USDT`, `10000${base}USDT`]; }

/** 官方归档 T+1：找一个各币种都大概率已发布的锚点日期（用 BTCUSDT 探测） */
async function findAnchorDate() {
  const today = new Date();
  for (let i = 1; i <= 5; i++) {
    const d = new Date(today.getTime() - i * 86400_000);
    if (await exists(archiveKlinesUrl('futures/um', 'BTCUSDT', '1h', ymd(d)))) return ymd(d);
  }
  throw new Error('官方开源数据仓库最近 5 天都没有已发布的合约 1h K 线归档（网络或仓库问题），如实报错');
}

async function collectOfficial(args) {
  const anchor = await findAnchorDate();
  const prev = ymd(new Date(new Date(anchor + 'T00:00:00Z').getTime() - 86400_000));
  say(`  官方归档已发布到 ${anchor}（T+1），涨跌基准优先取 ${prev} 收盘`);

  // 币种宇宙动态取：Hyperliquid 合约名单（不硬编码，币种上新能自动跟上）
  const metaRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ type: 'meta' }),
  });
  if (!metaRes.ok) throw new Error(`取合约币种名单失败 HTTP ${metaRes.status}（宇宙名单依赖该接口）`);
  const meta = await metaRes.json();
  let universe = (meta?.universe || []).map((a) => a.name).filter(Boolean);
  if (args.coins) {
    const want = args.coins.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    universe = universe.filter((n) => want.includes(n));
    if (!universe.length) throw new Error(`--coins 指定的币种在合约名单里一个都没找到`);
  }
  if (args.maxCoins && universe.length > args.maxCoins) universe = universe.slice(0, args.maxCoins);
  say(`  币种宇宙：${meta?.universe?.length || '?'} 个合约中取 ${universe.length} 个（名单来自公开合约接口，动态获取）`);

  const missing = [];
  const rows = [];
  let idx = 0;
  const concurrency = Math.max(1, Math.min(32, args.concurrency));

  async function worker() {
    while (idx < universe.length) {
      const base = universe[idx++];
      let pair = null;
      for (const cand of faceValueCandidates(base)) {
        if (await exists(archiveKlinesUrl('futures/um', cand, '1h', anchor))) { pair = cand; break; }
      }
      if (!pair) { missing.push(base); continue; }
      try {
        const curText = await fetchZipText(archiveKlinesUrl('futures/um', pair, '1h', anchor));
        if (!curText) { missing.push(base); continue; }
        const cur = parseKlinesCsv(curText);
        if (!cur.length) { missing.push(base); continue; }
        const last = cur[cur.length - 1];
        let change = null; let baseline = 'same-day-open';
        const prevText = await fetchZipText(archiveKlinesUrl('futures/um', pair, '1h', prev));
        if (prevText) {
          const pr = parseKlinesCsv(prevText);
          if (pr.length && pr[pr.length - 1].close > 0) {
            change = (last.close / pr[pr.length - 1].close - 1) * 100;
            baseline = 'prev-day-close';
          }
        }
        if (change === null && cur[0].open > 0) change = (last.close / cur[0].open - 1) * 100;
        const dayVol = cur.reduce((s, r) => s + (Number.isFinite(r.quoteVolume) ? r.quoteVolume : 0), 0);
        let oiUsd = null;
        const mText = await fetchZipText(archiveMetricsUrl(pair, anchor));
        if (mText) {
          const m = parseMetricsCsv(mText);
          for (let i = m.length - 1; i >= 0; i--) { if (Number.isFinite(m[i].oiUsd)) { oiUsd = m[i].oiUsd; break; } }
        }
        rows.push({
          symbol: base, source: '币安官方开源数据仓库', officialPair: pair,
          price: last.close, change: Number(change.toFixed(4)),
          volume: dayVol, rawActivity: dayVol, oiUsd, baseline,
        });
      } catch (e) {
        missing.push(base);
        say(`    [跳过] ${base}：${String(e.message).slice(0, 80)}`);
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // 护栏只管"全量扫描"：显式 --coins 指定少量币种是用户知情的选择，不拦，
  // 但样本 <5 时横截面分位基本失去意义，要在 honesty 里如实说明
  const tinySample = args.coins && rows.length < 5;
  if (!rows.length) throw new Error('官方归档里一个币种都没拼出来，如实报错');
  if (rows.length < 5 && !args.coins) {
    throw new Error(`官方归档里只拼出 ${rows.length} 个币种的数据，不足以做横截面评分（缺失 ${missing.length} 个），如实报错`);
  }
  return {
    rows, via: 'official-archive', label: `币安官方开源数据仓库（合约 K 线 + 合约指标，截至 ${anchor} 收盘）`,
    archive: { anchor, prev, missingCount: missing.length, missingPreview: missing.slice(0, 8) },
    notes: [
      `归档是 T+1：价格与涨跌是截至 ${anchor} 收盘的口径，不是此刻的实时价`,
      `涨跌基准：以 ${prev} 收盘价为准（个别新币改用当日开盘价，字段 baseline 已标注）`,
      missing.length ? `有 ${missing.length} 个币种在官方归档里没有文件（含面值币三种前缀都试过），如实跳过` : null,
      `持仓量来自官方合约指标文件（5 分钟粒度），个别币种缺失时 oiUsd 为空`,
      tinySample ? `本次 --coins 只指定了 ${rows.length} 个币种：样本过小，活跃度分位与评分只在样本内相对比较，参考意义有限` : null,
    ].filter(Boolean),
  };
}

/* --------------------------------------------------------------- 结论组装 */

function buildPayload(meta, args) {
  const scored = scoreMarkets(meta.rows); // 引擎原样评分与排序，一行未改
  const stats = {
    marketCount: scored.length,
    alerts: scored.filter((r) => r.score >= 60).length,
    rises: scored.filter((r) => r.change >= 5).length,
    falls: scored.filter((r) => r.change <= -5).length,
    buyPercent: scored.length ? Math.round((scored.filter((r) => r.direction === 'rise').length / scored.length) * 100) : 50,
  };
  stats.sellPercent = 100 - stats.buyPercent;

  const filtered = scored
    .filter((r) => r.score >= args.minScore)
    .filter((r) => args.direction === 'all' || r.direction === args.direction)
    .slice(0, args.top);

  const head = scored[0] || null;
  const brief = head ? {
    symbol: head.symbol, source: head.source, price: head.price, change: head.change,
    score: head.score, activity: head.activity,
    level: head.score >= 80 ? '高关注' : '中关注',
    directionText: head.direction === 'rise' ? '买盘偏强（价格方向）' : '卖压偏强（价格方向）',
    text: `${head.symbol} 当前价格${head.direction === 'rise' ? '向上' : '向下'}偏移，24h 变动 ${head.change >= 0 ? '+' : ''}${head.change.toFixed(2)}%。成交活跃度处于样本的 ${head.activity} 分位，归类为${head.score >= 80 ? '显著异动' : '可观察异动'}。`,
  } : null;

  const honesty = [
    '评分与活跃度分位由本项目自研引擎（app.js 的 scoreMarkets，与网页版同一段代码）计算；数据由对应通道提供。',
    'direction / "买盘方向" 字段是【价格涨跌方向】口径：涨=买盘方向、跌=卖盘方向。公开行情快照无法确认真实主动成交流向，网页简报中也如此声明。',
    'activity 是同一批样本内的成交额横截面分位：样本不同（通道/过滤不同）分位就不同，跨通道不可直接比较。',
    '综合异动强度是自研评分，用于排序观察，不构成投资建议。',
  ];
  if (meta.requestedSource) honesty.push(`本次请求的是 ${meta.requestedSource} 通道，但官方 CLI 不可用，已如实回退并标注（via=${meta.via}）。`);
  for (const n of meta.notes || []) honesty.push(n);

  return {
    source: meta.requestedSource || meta.source,
    via: meta.via,
    dataSource: meta.label,
    generatedAt: new Date().toISOString(),
    stats,
    headline: brief,
    top: filtered.map((r) => ({
      symbol: r.symbol, source: r.source, price: r.price,
      change: Number(r.change.toFixed(4)), volume: r.volume,
      activity: r.activity, score: r.score, direction: r.direction,
      ...(r.oiUsd !== undefined ? { oiUsd: r.oiUsd } : {}),
      ...(r.baseline ? { baseline: r.baseline } : {}),
    })),
    archive: meta.archive || null,
    honesty,
  };
}

/* ------------------------------------------------------------ 人类可读输出 */

function printReport(p) {
  const line = '─'.repeat(66);
  say('');
  say(`  ${line}`);
  say(`   全市场异动雷达 · 当班快报     ${p.generatedAt.replace('T', ' ').slice(0, 19)} UTC`);
  say(`  ${line}`);
  say(`   数据通道：${p.dataSource}`);
  say(`   通道标识：source=${p.source}  via=${p.via}`);
  say(`   监测市场 ${p.stats.marketCount} 个 · 显著异动（≥60 分）${p.stats.alerts} 个`);
  say(`   急涨（≥+5%）${p.stats.rises} · 急跌（≤-5%）${p.stats.falls} · 买盘方向 ${p.stats.buyPercent}% / 卖盘方向 ${p.stats.sellPercent}%`);
  if (p.headline) {
    const h = p.headline;
    say('');
    say(`  ▶ 头条异动：${h.symbol}（${h.source}）`);
    say(`      现价 ${fmtPrice(h.price)}　24h ${h.change >= 0 ? '+' : ''}${h.change.toFixed(2)}%　异动强度 ${h.score}/100（${h.level}）`);
    say(`      活跃度分位 ${h.activity}%　${h.directionText}`);
    say(`      快报：${h.text}`);
  }
  if (p.top.length) {
    say('');
    say(`  ▶ 异动榜单（前 ${p.top.length}）`);
    say('      排名  币种            涨跌幅      强度  分位  方向  来源');
    p.top.forEach((r, i) => {
      const sym = String(r.symbol).slice(0, 12).padEnd(12);
      const chg = `${r.change >= 0 ? '+' : ''}${r.change.toFixed(2)}%`.padStart(8);
      const dir = r.direction === 'rise' ? '涨' : '跌';
      const src = String(r.source).replace('币安官方', '官方').slice(0, 10);
      say(`      ${String(i + 1).padStart(2, '0')}    ${sym}  ${chg}   ${String(r.score).padStart(3)}  ${String(r.activity).padStart(3)}%  ${dir}    ${src}`);
    });
  }
  say('');
  say('  ▶ 口径与诚实说明');
  for (const h of p.honesty) say(`      · ${h}`);
  say('');
}

/* ---------------------------------------------------------------- 参数解析 */

function parseArgs(argv) {
  const args = {
    source: null, top: 10, minScore: 0, direction: 'all',
    concurrency: 8, coins: null, maxCoins: null, json: false, help: false,
  };
  // ⚠️ 旗标 → 字段名要显式映射：直接 slice(2).replace(/-/g,'') 会把
  // --max-coins 存成 maxcoins、--min-score 存成 minscore，与读取处对不上（实测踩过）
  const FLAGS = {
    '--top': 'top', '--min-score': 'minScore', '--direction': 'direction',
    '--concurrency': 'concurrency', '--coins': 'coins', '--max-coins': 'maxCoins',
  };
  const positional = [];
  let explicitChannel = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS[a]) { args[FLAGS[a]] = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0 && FLAGS[a.slice(0, eq)]) { args[FLAGS[a.slice(0, eq)]] = a.slice(eq + 1); continue; }
      if (a === '--json') args.json = true;
      else if (a === '--help' || a === '-h') args.help = true;
      else if (a === '--live') explicitChannel = 'live';
      else if (a === '--skill') explicitChannel = 'skill';
      else if (a === '--official') explicitChannel = 'official';
      else if (a === '--global') explicitChannel = 'global';
      else throw new Error(`不认识的参数：${a}（用 --help 查看用法）`);
      continue;
    }
    positional.push(a);
  }
  args.top = Math.max(1, Math.min(50, Number(args.top) || 10));
  args.minScore = Math.max(0, Math.min(99, Number(args.minScore) || 0));
  args.concurrency = Math.max(1, Math.min(32, Number(args.concurrency) || 8));
  if (args.maxCoins !== null) args.maxCoins = Math.max(1, Number(args.maxCoins) || 0) || null;
  if (!['all', 'rise', 'fall'].includes(args.direction)) throw new Error('--direction 只支持 all / rise / fall');
  args.explicitChannel = explicitChannel;
  args.intent = positional.join(' ').trim();
  return args;
}

function channelFromIntent(text) {
  const t = text.toLowerCase();
  if (/官方技能|官方\s*cli|binance-cli|skill/.test(t)) return 'skill';
  if (/官方开源|开源数据|归档|历史数据|t\+1/.test(t)) return 'official';
  if (/官方公开行情|币安官方|现货快照|live/.test(t)) return 'live';
  if (/多平台|对照|两个平台|gate|hyperliquid|网页/.test(t)) return 'global';
  return null;
}

const HELP = `
全市场异动雷达智能体 · 命令行入口（四通道）

用法
  node agent.mjs "看看现在哪些币异动最大"        # 自然语言入口（只识别通道，不猜币种）
  node agent.mjs                                # 默认：多平台实时对照（与网页版同口径）
  node agent.mjs --live                         # 官方公开行情 全市场现货快照
  node agent.mjs --skill                        # 官方技能 binance + 官方 CLI
  node agent.mjs --official --max-coins 60      # 官方开源数据仓库（T+1，含持仓量维度）

常用参数
  --top N          榜单条数（默认 10，最大 50）
  --min-score N    只看 ≥N 分的异动（默认 0）
  --direction d    all / rise / fall（默认 all）
  --coins A,B      --official 只扫指定币种
  --max-coins N    --official 限制币种数（默认扫全部合约名单）
  --concurrency N  官方归档并发数（默认 8，最大 32）
  --json           stdout 只输出纯 JSON，进度与说明走 stderr

说明
  · 评分引擎与网页版是同一段代码（app.js 的 scoreMarkets，源码级提取、逐字节一致）。
  · 命令行不提供演示数据降级：取不到数就如实报错退出。
  · 不构成投资建议。
`.trim();

/* ------------------------------------------------------------------- 入口 */

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { say(`参数错误：${e.message}`); say(HELP); return 2; }
  if (args.help) { say(HELP); return 0; }
  QUIET = args.json;

  let source = args.explicitChannel;
  if (!source && args.intent) {
    const guessed = channelFromIntent(args.intent);
    if (guessed) { source = guessed; say(`（自然语言识别到通道意图 → ${guessed}）`); }
    // 识别不出就不吭声，沿用默认通道 —— 绝不拿一句话乱猜
  } else if (source && args.intent && channelFromIntent(args.intent)) {
    say('（已显式指定数据通道，忽略自然语言里的通道意图）');
  }

  say(`全市场异动雷达 · 通道：${source || 'global（默认，多平台实时对照）'}`);
  let meta;
  if (source === 'live') { meta = { source: 'live', ...(await collectLive()) }; }
  else if (source === 'skill') { meta = { source: 'skill', ...(await collectSkill()) }; }
  else if (source === 'official') { meta = { source: 'official', ...(await collectOfficial(args)) }; }
  else { meta = { source: 'global', ...(await collectGlobal()) }; }

  const payload = buildPayload(meta, args);
  if (args.json) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); return 0; }
  printReport(payload);
  return 0;
}

process.exit(await main().catch((err) => {
  process.stderr.write(`\n[失败] ${err && err.stack ? err.stack : err}\n`);
  return 1;
}));
