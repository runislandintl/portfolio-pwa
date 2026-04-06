const express = require('express');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── VAPID : env vars (prod) ou fichier local (dev) ─────────────────────────
let VAPID_PUBLIC, VAPID_PRIVATE;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
} else {
  try {
    const keys = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/vapid-keys.json'), 'utf8'));
    VAPID_PUBLIC  = keys.publicKey;
    VAPID_PRIVATE = keys.privateKey;
  } catch {
    console.error('VAPID keys missing. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars.');
    process.exit(1);
  }
}

webpush.setVapidDetails('mailto:portfolio@localhost', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Subscriptions : en mémoire (persist dans data/ si dispo) ──────────────
const SUBS_FILE = path.join(__dirname, 'data/subscriptions.json');
let subscriptions = [];

try {
  subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  console.log(`  Loaded ${subscriptions.length} subscription(s) from disk`);
} catch {}

function saveSubs() {
  try {
    fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch {} // ephemeral filesystem on Render free tier — no-op
}

// ── NASDAQ price API ───────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const parsePrice = str => parseFloat((str || '').replace(/[$,%+]/g, ''));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFromNasdaq(symbol, assetClass = 'stocks') {
  const url = `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=${assetClass}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`NASDAQ ${symbol} (${assetClass}): ${res.status}`);
  const json = await res.json();
  const primary = json?.data?.primaryData;
  if (!primary?.lastSalePrice) throw new Error(`No data for ${symbol}`);
  const price  = parsePrice(primary.lastSalePrice);
  const change = parsePrice(primary.netChange);
  const chgPct = parsePrice(primary.percentageChange);
  return {
    symbol,
    regularMarketPrice:         price,
    regularMarketChange:        change,
    regularMarketChangePercent: chgPct,
    regularMarketPreviousClose: price - change,
    shortName: symbol,
    currency:  'USD',
  };
}

async function fetchSymbol(symbol) {
  try { return await fetchFromNasdaq(symbol, 'stocks'); }
  catch { return await fetchFromNasdaq(symbol, 'etf'); }
}

async function fetchAllSymbols(list) {
  const results = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) await sleep(150);
    results.push(fetchSymbol(list[i]).catch(err => ({ symbol: list[i], error: err.message })));
  }
  return Promise.all(results);
}

// ── API: quotes ────────────────────────────────────────────────────────────
app.get('/api/quotes', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const list = symbols.replace(/[^A-Z0-9.,\-]/gi, '').toUpperCase().split(',').filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'invalid symbols' });
  const results = await fetchAllSymbols(list);
  const success = results.filter(r => !r.error);
  const errors  = results.filter(r => r.error).map(r => `${r.symbol}: ${r.error}`);
  if (errors.length) console.warn('  Quote errors:', errors.join(' | '));
  res.json({ quoteResponse: { result: success, error: null } });
});

// ── API: VAPID public key ──────────────────────────────────────────────────
app.get('/api/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

// ── API: subscribe ─────────────────────────────────────────────────────────
app.post('/api/subscribe', (req, res) => {
  const { subscription, holdings } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const idx = subscriptions.findIndex(s => s.subscription.endpoint === subscription.endpoint);
  const entry = { subscription, holdings: holdings || [], updatedAt: new Date().toISOString() };
  if (idx >= 0) subscriptions[idx] = entry; else subscriptions.push(entry);
  saveSubs();
  res.json({ ok: true });
});

// ── API: unsubscribe ───────────────────────────────────────────────────────
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.subscription.endpoint !== endpoint);
  saveSubs();
  res.json({ ok: true });
});

// ── Keep-alive (ping auto pour éviter le sleep Render free tier) ───────────
app.get('/ping', (req, res) => res.send('ok'));

const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(`${BASE_URL}/ping`).catch(() => {});
}, 10 * 60 * 1000); // toutes les 10 minutes

// ── Push quotidien à 14h30 NY ─────────────────────────────────────────────
function getNYCTime() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return { hour: parseInt(get('hour')), minute: parseInt(get('minute')), weekday: get('weekday') };
}

let lastPushDate = null;

async function checkAndSendDailyPush() {
  const { hour, minute, weekday } = getNYCTime();
  const today = new Date().toDateString();
  if (['Sat', 'Sun'].includes(weekday)) return;
  if (hour !== 14 || minute !== 30) return;
  if (lastPushDate === today) return;
  lastPushDate = today;

  if (!subscriptions.length) return;
  console.log(`  Sending daily push to ${subscriptions.length} subscriber(s)…`);

  for (const { subscription, holdings } of subscriptions) {
    if (!holdings?.length) continue;
    try {
      const results = await fetchAllSymbols(holdings.map(h => h.symbol));
      const quotes = {};
      results.forEach(r => { if (!r.error) quotes[r.symbol] = r; });

      let totalValue = 0, totalCost = 0;
      holdings.forEach(h => {
        if (quotes[h.symbol]) totalValue += quotes[h.symbol].regularMarketPrice * h.qty;
        if (h.avgCost) totalCost += h.avgCost * h.qty;
      });

      const pnl    = totalCost > 0 ? totalValue - totalCost : null;
      const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : null;
      const s      = n => n >= 0 ? '+' : '';
      const cur    = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
      const body   = pnl !== null
        ? `${cur(totalValue)} · ${s(pnl)}${cur(pnl)} (${s(pnlPct)}${pnlPct.toFixed(1)}%)`
        : cur(totalValue);

      await webpush.sendNotification(subscription, JSON.stringify({ title: '📊 Portfolio · 14h30 NY', body }));
    } catch (err) {
      if (err.statusCode === 410) {
        subscriptions = subscriptions.filter(s => s.subscription.endpoint !== subscription.endpoint);
        saveSubs();
      }
    }
  }
}

setInterval(checkAndSendDailyPush, 30_000);

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Portfolio PWA → ${BASE_URL}`);
  console.log('  Push notifs à 14h30 NY · jours ouvrés\n');
});
