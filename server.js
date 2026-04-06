const express = require('express');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── VAPID ──────────────────────────────────────────────────────────────────
let VAPID_PUBLIC, VAPID_PRIVATE;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
} else {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/vapid-keys.json'), 'utf8'));
    VAPID_PUBLIC = k.publicKey; VAPID_PRIVATE = k.privateKey;
  } catch {
    console.error('VAPID keys missing.'); process.exit(1);
  }
}
webpush.setVapidDetails('mailto:portfolio@localhost', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Subscriptions ──────────────────────────────────────────────────────────
const SUBS_FILE = path.join(__dirname, 'data/subscriptions.json');
let subscriptions = [];
try { subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch {}
function saveSubs() {
  try { fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true }); fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2)); } catch {}
}

// ── Utils ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── NASDAQ real-time quotes ────────────────────────────────────────────────
const parseNum = str => parseFloat((str || '').replace(/[$,%+]/g, ''));

async function fetchFromNasdaq(symbol, cls = 'stocks') {
  const res = await fetch(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=${cls}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`NASDAQ ${symbol} (${cls}): ${res.status}`);
  const json = await res.json();
  const p = json?.data?.primaryData;
  if (!p?.lastSalePrice) throw new Error(`No data for ${symbol}`);
  const price = parseNum(p.lastSalePrice), change = parseNum(p.netChange), pct = parseNum(p.percentageChange);
  return { symbol, regularMarketPrice: price, regularMarketChange: change, regularMarketChangePercent: pct, regularMarketPreviousClose: price - change, shortName: symbol, currency: 'USD' };
}

async function fetchSymbol(symbol) {
  try { return await fetchFromNasdaq(symbol, 'stocks'); } catch { return fetchFromNasdaq(symbol, 'etf'); }
}

async function fetchAllSymbols(list) {
  const results = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) await sleep(150);
    results.push(fetchSymbol(list[i]).catch(err => ({ symbol: list[i], error: err.message })));
  }
  return Promise.all(results);
}

// ── Yahoo Finance historical (chart 6M) ───────────────────────────────────
async function fetchHistory(symbol, attempt = 0) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 429 && attempt < 2) { await sleep((attempt + 1) * 3000); return fetchHistory(symbol, attempt + 1); }
  if (!res.ok) throw new Error(`History ${symbol}: ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`No history for ${symbol}`);
  const closes = r.indicators.quote[0].close;
  return r.timestamp.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    close: closes[i],
  })).filter(d => d.close != null);
}

// ── API: quotes ────────────────────────────────────────────────────────────
app.get('/api/quotes', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const list = symbols.replace(/[^A-Z0-9.,\-]/gi, '').toUpperCase().split(',').filter(Boolean);
  const results = await fetchAllSymbols(list);
  const success = results.filter(r => !r.error);
  const errors  = results.filter(r => r.error).map(r => `${r.symbol}: ${r.error}`);
  if (errors.length) console.warn('  Quote errors:', errors.join(' | '));
  res.json({ quoteResponse: { result: success, error: null } });
});

// ── API: history (6M chart) ────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const list = symbols.replace(/[^A-Z0-9.,\-]/gi, '').toUpperCase().split(',').filter(Boolean);
  const out = {};
  for (const sym of list) {
    try { out[sym] = await fetchHistory(sym); } catch (e) { console.warn(`History ${sym}:`, e.message); }
    if (list.indexOf(sym) < list.length - 1) await sleep(300);
  }
  res.json(out);
});

// ── API: VAPID key ─────────────────────────────────────────────────────────
app.get('/api/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

// ── API: subscribe (holdings + alerts) ────────────────────────────────────
app.post('/api/subscribe', (req, res) => {
  const { subscription, holdings, alerts } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const idx = subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  const entry = { subscription, holdings: holdings || [], alerts: alerts || [], updatedAt: new Date().toISOString() };
  if (idx >= 0) subscriptions[idx] = entry; else subscriptions.push(entry);
  saveSubs();
  res.json({ ok: true });
});

// ── API: unsubscribe ───────────────────────────────────────────────────────
app.post('/api/unsubscribe', (req, res) => {
  subscriptions = subscriptions.filter(s => s.subscription.endpoint !== req.body.endpoint);
  saveSubs(); res.json({ ok: true });
});

// ── API: update alerts for a subscription ─────────────────────────────────
app.post('/api/alerts', (req, res) => {
  const { endpoint, alerts } = req.body;
  const sub = subscriptions.find(s => s.subscription.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  sub.alerts = alerts || [];
  sub.updatedAt = new Date().toISOString();
  saveSubs();
  res.json({ ok: true });
});

// ── Keep-alive ─────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.send('ok'));
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => fetch(`${BASE_URL}/ping`).catch(() => {}), 10 * 60 * 1000);

// ── NYSE time helpers ──────────────────────────────────────────────────────
function getNYCTime() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return { hour: parseInt(get('hour')), minute: parseInt(get('minute')), weekday: get('weekday') };
}

function isNYSEOpen() {
  const { hour, minute, weekday } = getNYCTime();
  if (['Sat', 'Sun'].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ── Push helpers ───────────────────────────────────────────────────────────
async function safePush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 410) {
      subscriptions = subscriptions.filter(s => s.subscription.endpoint !== subscription.endpoint);
      saveSubs();
    }
    return false;
  }
}

async function buildPortfolioMessage(holdings) {
  const results = await fetchAllSymbols(holdings.map(h => h.symbol));
  const quotes = {};
  results.forEach(r => { if (!r.error) quotes[r.symbol] = r; });
  let totalValue = 0, totalCost = 0;
  holdings.forEach(h => {
    if (quotes[h.symbol]) totalValue += quotes[h.symbol].regularMarketPrice * h.qty;
    if (h.avgCost) totalCost += h.avgCost * h.qty;
  });
  const pnl = totalCost > 0 ? totalValue - totalCost : null;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : null;
  const s = n => n >= 0 ? '+' : '';
  const cur = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return {
    body: pnl !== null ? `${cur(totalValue)} · ${s(pnl)}${cur(pnl)} (${s(pnlPct)}${pnlPct.toFixed(1)}%)` : cur(totalValue),
    quotes,
  };
}

// ── Hourly push during NYSE hours ──────────────────────────────────────────
let lastHourKey = null;

async function checkHourlyPush() {
  if (!isNYSEOpen()) return;
  const { hour, minute } = getNYCTime();
  const key = `${new Date().toDateString()}-${hour}`;
  if (minute > 3 || lastHourKey === key) return; // only in first 3 min of each hour
  lastHourKey = key;

  const label = `${String(hour).padStart(2, '0')}:00 NY`;
  console.log(`  Hourly push at ${label}`);

  for (const sub of subscriptions) {
    if (!sub.holdings?.length) continue;
    const { body } = await buildPortfolioMessage(sub.holdings);
    await safePush(sub.subscription, { title: `📊 Portfolio · ${label}`, body });
  }
}

// ── Price alert checking ───────────────────────────────────────────────────
async function checkAlerts() {
  if (!isNYSEOpen()) return;
  const activeAlerts = subscriptions.flatMap(s => (s.alerts || []).filter(a => !a.triggered));
  if (!activeAlerts.length) return;

  const symbols = [...new Set(activeAlerts.map(a => a.symbol))];
  const results = await fetchAllSymbols(symbols);
  const quotes = {};
  results.forEach(r => { if (!r.error) quotes[r.symbol] = r; });

  let changed = false;
  for (const sub of subscriptions) {
    for (const alert of (sub.alerts || [])) {
      if (alert.triggered) continue;
      const q = quotes[alert.symbol];
      if (!q) continue;
      const price = q.regularMarketPrice;
      const hit = alert.direction === 'above' ? price >= alert.targetPrice : price <= alert.targetPrice;
      if (!hit) continue;

      alert.triggered = true; changed = true;
      const dir = alert.direction === 'above' ? '▲' : '▼';
      const fmt = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      await safePush(sub.subscription, {
        title: `🎯 ${alert.symbol} ${dir} ${fmt(alert.targetPrice)}`,
        body: `Prix actuel : ${fmt(price)}`,
      });
      console.log(`  Alert triggered: ${alert.symbol} ${dir} ${alert.targetPrice} (actual: ${price})`);
    }
  }
  if (changed) saveSubs();
}

// ── Master scheduler (every 30s) ───────────────────────────────────────────
setInterval(async () => {
  await checkHourlyPush();
  await checkAlerts();
}, 30_000);

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Portfolio PWA → ${BASE_URL}`);
  console.log('  Push horaire · heures NYSE · alertes prix\n');
});
