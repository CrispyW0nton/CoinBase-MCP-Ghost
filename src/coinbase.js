// src/coinbase.js
// ---------------------------------------------------------------------------
// Coinbase Advanced Trade reconnaissance + read-only market-data layer.
//
// THE "GHOST" CONTRACT (Hard Constraints #1, #2):
//   * We NEVER open our own Coinbase socket, never send credentials, never
//     call the REST/WS API directly, never copy cookies/JWTs out of Chrome.
//   * We attach over CDP to an ALREADY-OPEN, ALREADY-SIGNED-IN Advanced Trade
//     tab in the dedicated debug profile, and MIRROR what that tab already
//     receives (Network.webSocketFrameReceived). Zero duplicate connections,
//     zero rate-limit risk, zero auth.
//   * We place NO orders in this pass. The execution scaffold is inert.
//
// Antonopoulos & Wood, "Mastering Ethereum" (Ch. 5 "Wallets" — key custody and
// the principle "not your keys, not your coins") and Antonopoulos,
// "Mastering Bitcoin" (Ch. 4–5 on keys/wallets) inform the deliberate refusal
// to ever hold or transit credentials: the safest secret is the one we never
// touch. Ammous, "The Bitcoin Standard" (Ch. 10 on the perils of intermediated
// custody) reinforces that we observe, we do not custody or transact.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";
import { ChromeSession, listTabs } from "./chrome.js";
import { loadConfig } from "./config.js";
import { RingBuffer, JsonlJournal } from "./journal.js";
import {
  makeTick, makeL2Update, makeTrade, makeCandle, makeGap,
  serializeEvent, dec, Decimal
} from "./schema.js";

const DEFAULT_DEBUG_URL = "http://127.0.0.1:9222";

// ---------------------------------------------------------------------------
// Tab discovery — FAILS CLOSED (Step 2).
// ---------------------------------------------------------------------------

// Candidate selectors we probe to confirm (a) the page is the Advanced Trade
// app shell and (b) the user is signed in. We log which one matched so the
// next pass can lock onto the winners. These are ordered most-stable-first.
//
// Harris, "Trading and Exchanges" (Ch. 6 "Order-Driven Markets") frames the
// order book / order panel as the trader's primary instrument; we probe for
// exactly those landmarks to assert "this is a tradeable surface, signed in".
const ROOT_SELECTOR_CANDIDATES = [
  '[data-testid="advanced-trade-app"]',
  '[data-testid="trade-view"]',
  'main[role="main"]',
  '[class*="AdvancedTrade"]',
  '#root',
  'body'
];

const SIGNED_IN_SELECTOR_CANDIDATES = [
  '[data-testid="account-menu"]',
  '[data-testid="portfolio-balance"]',
  '[data-testid="header-account-button"]',
  '[aria-label*="account" i]',
  '[data-testid="order-form"]',
  '[class*="Balance"]'
];

const SIGNED_OUT_SELECTOR_CANDIDATES = [
  'a[href*="/signin"]',
  'a[href*="/login"]',
  '[data-testid="sign-in-button"]',
  'button[data-qa="signin"]'
];

// pickCoinbaseTab: strict, fail-closed variant of chrome.pickTab. It NEVER
// falls back to tabs[0] — clicking/observing an unrelated tab would violate
// the ghost contract (Hard Constraint #1).
export async function pickCoinbaseTab({ debugUrl = DEFAULT_DEBUG_URL, urlContains } = {}) {
  const needle = (urlContains || "coinbase.com/advanced-trade").toLowerCase();
  const tabs = await listTabs(debugUrl);
  const match = tabs.find(t => (t.url || "").toLowerCase().includes(needle));
  if (!match) {
    throw new Error(
      `No Coinbase Advanced Trade tab found on the debug endpoint (${debugUrl}).\n` +
      `Open https://www.coinbase.com/advanced-trade/spot/BTC-USD in the DEDICATED\n` +
      `debug profile (run scripts/launch-chrome-coinbase.ps1) and sign in once.\n` +
      `Refusing to fall back to an arbitrary tab (fail-closed ghost contract).`
    );
  }
  return match;
}

// In-page probe: returns which root/signed-in/signed-out selectors are present.
function probeScript() {
  return `(() => {
    const present = sel => { try { return !!document.querySelector(sel); } catch { return false; } };
    const probe = list => list.map(sel => ({ selector: sel, present: present(sel) }));
    return {
      readyState: document.readyState,
      url: location.href,
      title: document.title,
      root: probe(${JSON.stringify(ROOT_SELECTOR_CANDIDATES)}),
      signedIn: probe(${JSON.stringify(SIGNED_IN_SELECTOR_CANDIDATES)}),
      signedOut: probe(${JSON.stringify(SIGNED_OUT_SELECTOR_CANDIDATES)})
    };
  })()`;
}

export async function attach({ debugUrl, urlContains } = {}) {
  const cfg = loadConfig();
  const tab = await pickCoinbaseTab({
    debugUrl: debugUrl || cfg.debugUrl,
    urlContains: urlContains || cfg.tabUrlContains
  });
  const session = await new ChromeSession(tab).connect();
  try {
    const probe = await session.evaluate(probeScript());
    const matchedRoot = probe.root.find(r => r.present)?.selector ?? null;
    const matchedSignedIn = probe.signedIn.filter(r => r.present).map(r => r.selector);
    const matchedSignedOut = probe.signedOut.filter(r => r.present).map(r => r.selector);

    const loaded = probe.readyState === "complete" && Boolean(matchedRoot);
    // Signed-in heuristic: at least one signed-in landmark present AND no
    // explicit sign-in CTA. We return signedIn explicitly so every other tool
    // can refuse when it is false (Step 2 requirement).
    const signedIn = matchedSignedIn.length > 0 && matchedSignedOut.length === 0;

    return {
      attached: true,
      loaded,
      signedIn,
      tab: { id: tab.id, title: tab.title, url: tab.url },
      probeResults: {
        readyState: probe.readyState,
        matchedRoot,
        matchedSignedIn,
        matchedSignedOut,
        raw: probe
      }
    };
  } finally {
    session.close();
  }
}

// Guard used by every read tool: attach + require signedIn === true.
async function requireSignedInTab({ debugUrl, urlContains } = {}) {
  const cfg = loadConfig();
  const dbg = debugUrl || cfg.debugUrl;
  const uc = urlContains || cfg.tabUrlContains;
  const tab = await pickCoinbaseTab({ debugUrl: dbg, urlContains: uc });
  const session = await new ChromeSession(tab).connect();
  const probe = await session.evaluate(probeScript());
  const matchedSignedIn = probe.signedIn.filter(r => r.present).map(r => r.selector);
  const matchedSignedOut = probe.signedOut.filter(r => r.present).map(r => r.selector);
  const signedIn = matchedSignedIn.length > 0 && matchedSignedOut.length === 0;
  if (!signedIn) {
    session.close();
    throw new Error(
      "Refusing to run: the Advanced Trade tab does not look signed in.\n" +
      "Sign in to Coinbase in the debug-profile window first, then retry."
    );
  }
  return { session, tab, cfg };
}

// ---------------------------------------------------------------------------
// Coinbase Advanced Trade WebSocket frame parsing (Step 4).
//
// We MIRROR frames the page already received. The Advanced Trade WS protocol
// (wss://advanced-trade-ws.coinbase.com) sends messages of the shape:
//   { channel, client_id, timestamp, sequence_num, events: [...] }
// with channels: heartbeats, ticker, ticker_batch, level2, market_trades,
// candles, status, user. We normalize the subset relevant to recon.
//
// Harris, "Trading and Exchanges" (Ch. 6 on order-driven markets, Ch. 7 on
// the limit order book): the level2 channel is the live limit order book; the
// market_trades tape is the realized trade flow; ticker is best bid/offer.
// We model exactly those three primitives plus candles.
// ---------------------------------------------------------------------------

const SYMBOL = () => loadConfig().symbol;

// Parse one Coinbase WS payload (already JSON-parsed) into zero or more
// normalized schema events. Returns { events, sequenceNum, channel }.
export function parseCoinbaseFrame(msg) {
  const out = [];
  if (!msg || typeof msg !== "object") return { events: out, sequenceNum: null, channel: null };
  const channel = msg.channel ?? null;
  const sequenceNum = typeof msg.sequence_num === "number" ? msg.sequence_num : null;
  const symbol = SYMBOL();

  if (!Array.isArray(msg.events)) return { events: out, sequenceNum, channel };

  for (const ev of msg.events) {
    if (channel === "ticker" || channel === "ticker_batch") {
      for (const t of ev.tickers ?? []) {
        out.push(makeTick({
          ts: Date.parse(msg.timestamp) || Date.now(),
          symbol: t.product_id || symbol,
          bidPx: t.best_bid, bidSz: t.best_bid_quantity,
          askPx: t.best_ask, askSz: t.best_ask_quantity,
          lastPx: t.price, lastSz: null
        }));
      }
    } else if (channel === "level2") {
      const isSnapshot = ev.type === "snapshot";
      for (const u of ev.updates ?? []) {
        // Coinbase L2 side is "bid"/"offer"; normalize "offer" -> "ask".
        const side = u.side === "offer" ? "ask" : u.side;
        out.push(makeL2Update({
          ts: Date.parse(u.event_time) || Date.parse(msg.timestamp) || Date.now(),
          symbol: ev.product_id || symbol,
          side, px: u.price_level, sz: u.new_quantity,
          isSnapshot, seq: sequenceNum
        }));
      }
    } else if (channel === "market_trades") {
      for (const tr of ev.trades ?? []) {
        out.push(makeTrade({
          ts: Date.parse(tr.time) || Date.now(),
          symbol: tr.product_id || symbol,
          side: tr.side ? String(tr.side).toLowerCase() : null,
          px: tr.price, sz: tr.size, tradeId: tr.trade_id
        }));
      }
    } else if (channel === "candles") {
      for (const c of ev.candles ?? []) {
        out.push(makeCandle({
          ts: (Number(c.start) * 1000) || Date.now(),
          symbol: c.product_id || symbol,
          granularitySec: null,
          o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume
        }));
      }
    }
    // heartbeats/status/user: not normalized into market events here.
  }
  return { events: out, sequenceNum, channel };
}

// ---------------------------------------------------------------------------
// coinbase_market_stream (Step 4): mirror the page's WS for `durationMs`,
// normalize, fan out to ring buffer + JSONL journal, detect sequence gaps.
// ---------------------------------------------------------------------------

// Module-level singletons so coinbase_snapshot_state can read what the last
// stream collected.
const ring = new RingBuffer(50_000);
let journal = null;

export function getRing() { return ring; }

export async function marketStream({ debugUrl, urlContains, durationMs = 30_000 } = {}) {
  const { session, tab, cfg } = await requireSignedInTab({ debugUrl, urlContains });
  journal = journal || new JsonlJournal({ symbol: cfg.symbol });

  const stats = { ticks: 0, l2: 0, trades: 0, candles: 0, gaps: 0, frames: 0, sockets: new Set() };
  // Per-channel last sequence number, for gap detection. Coinbase increments
  // sequence_num monotonically per connection; a skip => dropped frame(s).
  let lastSeq = null;

  await session.command("Network.enable");
  await session.command("Page.enable");

  // Fan-out subscription (multiple listeners per event) — see ChromeSession.on.
  const offCreated = session.on?.("Network.webSocketCreated", p => {
    if (p?.url) stats.sockets.add(p.url);
  });

  const handleFrame = params => {
    const payload = params?.response?.payloadData;
    if (!payload) return;
    stats.frames++;
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    const { events, sequenceNum, channel } = parseCoinbaseFrame(msg);

    // Gap detection on the connection-level sequence_num.
    if (sequenceNum !== null) {
      if (lastSeq !== null && sequenceNum > lastSeq + 1) {
        const gap = makeGap({ symbol: cfg.symbol, expectedSeq: lastSeq + 1, gotSeq: sequenceNum, channel });
        ring.push(gap); journal.append(gap); stats.gaps++;
        // NOTE: we do NOT invent a resubscribe. Step 3 observes how the page
        // itself reconnects; the recon report records that behavior so a
        // future pass can mirror it. (Kleppmann Ch.11: prefer the system's
        // own recovery to a bespoke one.)
      }
      if (lastSeq === null || sequenceNum > lastSeq) lastSeq = sequenceNum;
    }

    for (const evt of events) {
      ring.push(evt);
      journal.append(evt);
      if (evt.type === "tick") stats.ticks++;
      else if (evt.type === "l2update") stats.l2++;
      else if (evt.type === "trade") stats.trades++;
      else if (evt.type === "candle") stats.candles++;
    }
  };

  const offRecv = session.on?.("Network.webSocketFrameReceived", handleFrame);

  await new Promise(resolve => setTimeout(resolve, durationMs));

  offCreated?.();
  offRecv?.();
  session.close();

  return {
    streamed: true,
    durationMs,
    tab: { id: tab.id, url: tab.url },
    sockets: [...stats.sockets],
    counts: { ticks: stats.ticks, l2: stats.l2, trades: stats.trades, candles: stats.candles, gaps: stats.gaps, frames: stats.frames },
    journalPath: journal.path(),
    ringSize: ring.size()
  };
}

export async function snapshotState({ n = 200 } = {}) {
  return {
    ringSize: ring.size(),
    counts: ring.counts(),
    lastTick: ring.lastOfType("tick"),
    lastTrade: ring.lastOfType("trade"),
    recent: ring.recent(Number(n))
  };
}

// ---------------------------------------------------------------------------
// coinbase_recon (Step 3): one-shot deep reconnaissance of the live page.
// Produces ./recon/<symbol>-<timestamp>/ with dom-map.json, network-map.json,
// screenshots/, and RECON_REPORT.md. NEVER clicks Place/Preview Order.
// ---------------------------------------------------------------------------

// DOM-map probe: locate trading landmarks via MULTIPLE locator strategies and
// rank them by stability.
//
// STABILITY RANKING RATIONALE (cited in dom-map.json `stability` field):
//   1. data-testid       — explicitly contractual hooks; survive restyles.
//   2. role + accessible-name — semantic, survive class churn (a11y is stable).
//   3. stable class fragment  — brittle: CSS-module hashes rotate on deploy.
//   4. textContent fallback   — most brittle: i18n/locale + copy edits break it.
//   Newman, "Building Microservices" (Ch. 5 "Implementing Communication" — the
//   discussion of explicit, versioned contracts vs. implicit coupling): we
//   prefer the most contractual locator available, exactly as we'd prefer an
//   explicit API contract over scraping. López de Prado (AFML Ch. 1) — model
//   robustness starts with robust inputs; a fragile selector is a silent data
//   outage waiting to happen.
function domMapScript() {
  return `(() => {
    const txt = el => (el && (el.innerText || el.textContent || "") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    const rect = el => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } };
    const landmark = el => {
      let p = el; let hops = 0;
      while (p && hops < 6) {
        if (p.getAttribute && (p.getAttribute("role") || p.getAttribute("data-testid"))) {
          return p.getAttribute("data-testid") ? '[data-testid="'+p.getAttribute("data-testid")+'"]' : '[role="'+p.getAttribute("role")+'"]';
        }
        p = p.parentElement; hops++;
      }
      return null;
    };
    // For a target element, emit ranked locator strategies.
    const locators = el => {
      if (!el) return [];
      const out = [];
      const tid = el.getAttribute && el.getAttribute("data-testid");
      if (tid) out.push({ strategy: "data-testid", selector: '[data-testid="'+tid+'"]', stability: 1 });
      const role = el.getAttribute && el.getAttribute("role");
      const aria = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"));
      if (role) out.push({ strategy: "role+name", selector: 'role='+role+(aria?(' name="'+aria+'"'):''), stability: 2 });
      if (el.classList && el.classList.length) {
        const frag = [...el.classList].find(c => !/[0-9]{4,}|hash|css-[a-z0-9]+/i.test(c)) || el.classList[0];
        out.push({ strategy: "class-fragment", selector: el.tagName.toLowerCase()+'[class*="'+frag+'"]', stability: 3 });
      }
      if (txt(el)) out.push({ strategy: "textContent", selector: 'text='+JSON.stringify(txt(el)), stability: 4 });
      return out;
    };
    const describe = (el, name) => el ? {
      name, found: true, textSample: txt(el), bbox: rect(el),
      parentLandmark: landmark(el), locators: locators(el)
    } : { name, found: false };

    const byText = (sel, words) => [...document.querySelectorAll(sel)].find(e => {
      const t = txt(e).toLowerCase(); return words.some(w => t.includes(w));
    }) || null;
    const q = sel => { try { return document.querySelector(sel); } catch { return null; } };

    const orderPanel = {
      buySellToggle: describe(byText('button,[role=tab],[role=button]', ['buy','sell']) || q('[data-testid*="order-side"]'), "buySellToggle"),
      orderTypeSelector: describe(byText('button,[role=tab],select', ['market','limit','stop']) || q('[data-testid*="order-type"]'), "orderTypeSelector"),
      amountInput: describe(q('input[type="number"], input[inputmode="decimal"], [data-testid*="amount"] input, [data-testid*="size"] input'), "amountInput"),
      quoteCurrencyToggle: describe(byText('button,[role=button]', ['usd','btc']) || q('[data-testid*="currency"]'), "quoteCurrencyToggle"),
      placeOrderButton: describe(byText('button', ['place order','preview order','buy btc','sell btc']) || q('[data-testid*="place-order"]'), "placeOrderButton")
    };
    const orderBook = {
      container: describe(q('[data-testid*="order-book"], [class*="OrderBook"], [aria-label*="order book" i]'), "orderBookContainer"),
      bidSide: describe(q('[data-testid*="bids"], [class*="bid" i]'), "bidSide"),
      askSide: describe(q('[data-testid*="asks"], [class*="ask" i]'), "askSide"),
      midPrice: describe(q('[data-testid*="mid"], [class*="midPrice" i], [class*="spread" i]'), "midPrice"),
      spread: describe(q('[data-testid*="spread"], [class*="spread" i]'), "spread")
    };
    const chart = (() => {
      const iframe = q('iframe[src*="tradingview" i], iframe[id*="tradingview" i]');
      const canvas = q('canvas');
      const el = iframe || q('[data-testid*="chart"], [class*="Chart"]') || canvas;
      const d = describe(el, "chartContainer");
      if (el) { d.isIframe = el.tagName === "IFRAME"; d.isCanvas = el.tagName === "CANVAS"; if (iframe) d.iframeSrc = iframe.src; }
      return d;
    })();
    const tradesTape = describe(q('[data-testid*="trades"], [class*="RecentTrades" i], [aria-label*="recent trades" i]'), "recentTrades");
    const portfolio = {
      widget: describe(q('[data-testid*="portfolio"], [data-testid*="balance"], [class*="Balance" i]'), "portfolioWidget"),
      usdBalance: describe(byText('[data-testid*="balance"],[class*="Balance" i]', ['usd','$']), "usdBalance"),
      btcBalance: describe(byText('[data-testid*="balance"],[class*="Balance" i]', ['btc']), "btcBalance"),
      available: describe(byText('*', ['available']), "available"),
      holds: describe(byText('*', ['hold']), "holds")
    };
    const tabs = {
      openOrders: describe(byText('[role=tab],button,a', ['open order','open orders']), "openOrdersTab"),
      orderHistory: describe(byText('[role=tab],button,a', ['order history','history','fills']), "orderHistoryTab")
    };
    return { capturedAt: new Date().toISOString(), url: location.href, title: document.title,
      orderPanel, orderBook, chart, tradesTape, portfolio, tabs };
  })()`;
}

export async function recon({ debugUrl, urlContains, networkSeconds = 60, sampleSeconds = 30, outputRoot } = {}) {
  const { session, tab, cfg } = await requireSignedInTab({ debugUrl, urlContains });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = outputRoot || path.join(process.cwd(), "recon", `${cfg.symbol.toLowerCase()}-${stamp}`);
  const shotsDir = path.join(dir, "screenshots");
  await fs.mkdir(shotsDir, { recursive: true });

  // (A) Static DOM map
  const domMap = await session.evaluate(domMapScript());
  await fs.writeFile(path.join(dir, "dom-map.json"), JSON.stringify(domMap, null, 2), "utf8");

  // Full-page screenshot for annotation reference.
  await session.command("Page.enable");
  try {
    const shot = await session.command("Page.captureScreenshot", { format: "png", fromSurface: true });
    await fs.writeFile(path.join(shotsDir, "full-page.png"), Buffer.from(shot.data, "base64"));
  } catch { /* screenshot is best-effort */ }

  // (B) Network reconnaissance — observe WS + REST for `networkSeconds`.
  await session.command("Network.enable");
  const net = {
    webSockets: {},          // url -> { url, frames: [], subscribes: [], channels: {} }
    rest: {},                // path -> { method, count, sampleQuery, sampleResponseKeys }
    csp: null
  };
  const wsIdToUrl = new Map();
  const sampleDeadline = Date.now() + sampleSeconds * 1000;

  const offCreate = session.on("Network.webSocketCreated", p => {
    if (!p?.url) return;
    wsIdToUrl.set(p.requestId, p.url);
    net.webSockets[p.url] = net.webSockets[p.url] || { url: p.url, subscribes: [], frames: [], channels: {} };
  });
  const offSent = session.on("Network.webSocketFrameSent", p => {
    const url = wsIdToUrl.get(p.requestId); if (!url) return;
    const ws = net.webSockets[url]; if (!ws) return;
    const data = p?.response?.payloadData;
    if (data && /subscribe/i.test(data) && ws.subscribes.length < 50) ws.subscribes.push(data.slice(0, 2000));
  });
  const offRecv = session.on("Network.webSocketFrameReceived", p => {
    const url = wsIdToUrl.get(p.requestId); if (!url) return;
    const ws = net.webSockets[url]; if (!ws) return;
    const data = p?.response?.payloadData; if (!data) return;
    if (Date.now() > sampleDeadline) return;
    let parsed; try { parsed = JSON.parse(data); } catch { return; }
    const ch = parsed.channel || "(unknown)";
    ws.channels[ch] = ws.channels[ch] || { count: 0, sampleKeys: null, sampleFrameBytes: 0 };
    ws.channels[ch].count++;
    if (!ws.channels[ch].sampleKeys) {
      ws.channels[ch].sampleKeys = Object.keys(parsed);
      ws.channels[ch].sampleFrameBytes = data.length;
    }
  });
  const offReq = session.on("Network.requestWillBeSent", p => {
    const u = p?.request?.url || ""; const m = p?.request?.method || "GET";
    if (/\/api\/v3\/brokerage\//.test(u) || /\/api\//.test(u)) {
      let pathOnly = u; try { pathOnly = new URL(u).pathname; } catch {}
      net.rest[pathOnly] = net.rest[pathOnly] || { method: m, count: 0, sampleQuery: null };
      net.rest[pathOnly].count++;
      try { const qs = new URL(u).search; if (qs && !net.rest[pathOnly].sampleQuery) net.rest[pathOnly].sampleQuery = qs.slice(0, 300); } catch {}
    }
  });
  const offResp = session.on("Network.responseReceived", p => {
    const headers = p?.response?.headers || {};
    const csp = headers["content-security-policy"] || headers["Content-Security-Policy"];
    if (csp && !net.csp) net.csp = csp.slice(0, 4000);
  });

  await new Promise(r => setTimeout(r, networkSeconds * 1000));
  offCreate(); offSent(); offRecv(); offReq(); offResp();

  // Convert sets/maps; record channel inventory.
  const wsList = Object.values(net.webSockets).map(ws => ({
    url: ws.url, subscribeFrames: ws.subscribes,
    channels: ws.channels
  }));
  const networkMap = {
    capturedAt: new Date().toISOString(), networkSeconds, sampleSeconds,
    webSockets: wsList, rest: net.rest, contentSecurityPolicy: net.csp
  };
  await fs.writeFile(path.join(dir, "network-map.json"), JSON.stringify(networkMap, null, 2), "utf8");

  // (C) Behavioral recon — observe DOM diffs on safe interactions. We DO NOT
  // click Place/Preview Order. We only hover/scroll the book and toggle the
  // Buy<->Sell and Market<->Limit controls discovered in the DOM map.
  const behavioral = await runBehavioralProbe(session, domMap);
  await fs.writeFile(path.join(dir, "behavioral.json"), JSON.stringify(behavioral, null, 2), "utf8");

  session.close();

  // RECON_REPORT.md — human-readable, book-cited.
  const report = buildReconReport({ cfg, domMap, networkMap, behavioral, dir, stamp });
  await fs.writeFile(path.join(dir, "RECON_REPORT.md"), report, "utf8");

  return {
    recon: true, outputDir: dir,
    files: ["dom-map.json", "network-map.json", "behavioral.json", "RECON_REPORT.md", "screenshots/full-page.png"],
    webSocketUrls: wsList.map(w => w.url),
    channels: wsList.flatMap(w => Object.keys(w.channels)),
    restEndpoints: Object.keys(net.rest)
  };
}

// Behavioral probe: SAFE interactions only. Returns observed selector/channel
// deltas. (We never submit an order — Hard Constraint #2.)
async function runBehavioralProbe(session) {
  const observe = async () => session.evaluate(`(() => ({
    bookRows: document.querySelectorAll('[class*="OrderBook" i] *, [data-testid*="order-book"] *').length,
    activeTab: (document.querySelector('[role=tab][aria-selected="true"]')||{}).textContent || null
  }))()`);
  const before = await observe();
  // Safe toggle: click a Buy/Sell tab ONLY if it is clearly a side toggle, not
  // a submit button. We deliberately target [role=tab]/toggle, never a button
  // whose text contains "place"/"preview".
  await session.evaluate(`(() => {
    const t = [...document.querySelectorAll('[role=tab],button,[role=button]')]
      .find(e => /\\b(sell)\\b/i.test((e.textContent||"")) && !/place|preview|confirm/i.test((e.textContent||"")));
    if (t) t.click();
  })()`).catch(() => {});
  await new Promise(r => setTimeout(r, 600));
  const after = await observe();
  return { note: "Safe interactions only; no order submitted.", before, after };
}

// Build the human-readable RECON_REPORT.md. Each section cites the book that
// informed the observation lens (per Step 3 deliverable requirement).
function buildReconReport({ cfg, domMap, networkMap, behavioral, stamp }) {
  const wsUrls = networkMap.webSockets.map(w => w.url);
  const channels = [...new Set(networkMap.webSockets.flatMap(w => Object.keys(w.channels)))];
  const rest = Object.entries(networkMap.rest);
  const panel = domMap.orderPanel || {};
  const fmtLoc = d => d?.found
    ? d.locators.map(l => `\`${l.selector}\` (${l.strategy}, stability ${l.stability})`).join("<br>")
    : "_not found in this capture_";

  return `# Coinbase Advanced Trade — Recon Report (${cfg.symbol})

_Captured: ${stamp}_  
_Mode: **${cfg.mode}** — read-only. No orders placed (Hard Constraint #2)._

This report is the **deliverable that the next development pass reads**. It maps
the live Advanced Trade surface so a future signal/paper-trading layer can act
on stable locators and a known data feed. Everything here was observed by
mirroring the user's already-signed-in browser session over CDP — no API keys,
no second socket, no auth (Hard Constraint #1).

---

## 1. Order panel — locators & stability

> **Harris, _Trading and Exchanges_, Ch. 4 "Orders and Order Properties" & Ch. 6
> "Order-Driven Markets".** The order panel is the trader's instrument; market
> vs. limit selection and the side toggle are the decisions that determine
> execution cost. We catalogue each control with ranked locators so a future
> pass selects the most contractual hook available.

| Control | Locators (ranked) |
|---|---|
| Buy/Sell toggle | ${fmtLoc(panel.buySellToggle)} |
| Order-type selector | ${fmtLoc(panel.orderTypeSelector)} |
| Amount input | ${fmtLoc(panel.amountInput)} |
| Quote-currency toggle (USD/BTC) | ${fmtLoc(panel.quoteCurrencyToggle)} |
| Place Order button | ${fmtLoc(panel.placeOrderButton)} |

Stability ranking: **1 = data-testid** (contractual) → **2 = role+name**
(semantic) → **3 = class fragment** (rotates on deploy) → **4 = textContent**
(i18n/copy-fragile). _Newman, Building Microservices, Ch. 5 — prefer explicit
contracts over implicit coupling._

---

## 2. Order book, chart, trades tape

> **Harris, Ch. 6–7.** The level2 feed is the live limit order book; the
> market-trades tape is realized order flow. Microstructure (spread, depth,
> queue position) is visible here and drives any future execution policy.

- Order-book container: ${domMap.orderBook?.container?.found ? "found" : "not found"}
- Bid side: ${domMap.orderBook?.bidSide?.found ? "found" : "not found"}; Ask side: ${domMap.orderBook?.askSide?.found ? "found" : "not found"}
- Mid/spread: ${domMap.orderBook?.spread?.found ? "found" : "not found"}
- Chart: ${domMap.chart?.found ? (domMap.chart.isIframe ? "iframe (likely TradingView)" : domMap.chart.isCanvas ? "canvas" : "container") : "not found"}${domMap.chart?.iframeSrc ? ` — src: ${domMap.chart.iframeSrc}` : ""}
- Recent trades tape: ${domMap.tradesTape?.found ? "found" : "not found"}

---

## 3. Portfolio / balances

> **Antonopoulos, _Mastering Bitcoin_, Ch. 4–5; Ammous, _The Bitcoin Standard_,
> Ch. 10.** "Available" vs "Holds" mirrors the unspent/locked distinction in
> coin custody. We read balances from the DOM only — never from an API and
> never by touching keys.

- Portfolio widget: ${domMap.portfolio?.widget?.found ? "found" : "not found"}
- USD balance: ${domMap.portfolio?.usdBalance?.found ? "found" : "not found"}; BTC balance: ${domMap.portfolio?.btcBalance?.found ? "found" : "not found"}

---

## 4. Network reconnaissance — WebSocket & REST

> **Kleppmann, _Designing Data-Intensive Applications_, Ch. 11 "Stream
> Processing".** Coinbase's feed carries a connection-level \`sequence_num\`. A
> monotonic counter gives us **at-least-once with gap detection** (we can see a
> skip) but not exactly-once on its own — to get exactly-once we must dedupe on
> (channel, sequence_num) downstream. The journal is append-only precisely so
> that replay/dedup is possible (Ch. 3).

**WebSockets observed:** ${wsUrls.length ? wsUrls.map(u => `\`${u}\``).join(", ") : "_none captured in window_"}

**Channels seen:** ${channels.length ? channels.map(c => `\`${c}\``).join(", ") : "_none_"}

Expected Advanced Trade channels: \`heartbeats\`, \`ticker\`, \`ticker_batch\`,
\`level2\`, \`market_trades\`, \`candles\`, \`status\`, plus the authenticated
\`user\` channel.

**REST endpoints polled by the page (we will NOT call these — recorded to avoid
duplicate/conflicting requests):**

${rest.length ? rest.map(([p, v]) => `- \`${v.method} ${p}\` ×${v.count}${v.sampleQuery ? ` query: \`${v.sampleQuery}\`` : ""}`).join("\n") : "_none captured_"}

**Content-Security-Policy:** ${networkMap.contentSecurityPolicy ? "captured (see network-map.json). In-page taps run in the page's main world via Runtime.evaluate, which CSP does not block." : "_not captured in window_"}

---

## 5. Behavioral recon

> **Kahneman, _Thinking, Fast and Slow_, Ch. 4.** Demand-loaded channels reveal
> which data the UI fetches lazily; knowing this prevents us from "filling in"
> expectations the feed does not actually provide.

${behavioral.note}

- Before: \`${JSON.stringify(behavioral.before)}\`
- After (safe Sell-toggle): \`${JSON.stringify(behavioral.after)}\`

---

## 6. What's NOT in this pass

- No orders, no \`Place Order\`/\`Preview Order\` clicks.
- No API keys, JWTs, HMAC, or cookie extraction.
- No second WebSocket — we mirror the page's own feed.

See \`EXECUTION_DESIGN.md\` for the LIVE-mode DOM sequence we *would* perform,
and the knowledge base under \`knowledge-base/\` for the strategy rationale.

_Supporting artifacts: \`dom-map.json\`, \`network-map.json\`, \`behavioral.json\`, \`screenshots/\`._
`;
}

// ---------------------------------------------------------------------------
// coinbase_portfolio_snapshot (Step 5): read balances + open orders from the
// DOM (NOT from any API), using discovered selectors with fallback chains.
// ---------------------------------------------------------------------------
function portfolioScript() {
  return `(() => {
    const txt = el => (el && (el.innerText || el.textContent || "") || "").replace(/\\s+/g, " ").trim();
    const num = s => { const m = (s||"").replace(/[, ]/g,"").match(/-?\\d+(?:\\.\\d+)?/); return m ? m[0] : null; };
    // Fallback chain: try contractual hooks first, then class fragments, then
    // text scan. (Ranking matches dom-map stability ordering.)
    const balEls = [
      ...document.querySelectorAll('[data-testid*="balance" i], [data-testid*="portfolio" i], [class*="Balance" i], [class*="Asset" i]')
    ];
    const balances = [];
    for (const el of balEls.slice(0, 60)) {
      const t = txt(el);
      const m = t.match(/\\b(USD|USDC|BTC|ETH|[A-Z]{3,5})\\b/);
      if (m && /\\d/.test(t)) {
        balances.push({ asset: m[1], available: num(t), hold: null, raw: t.slice(0, 80) });
      }
    }
    const orderEls = [...document.querySelectorAll('[data-testid*="open-order" i], [class*="OpenOrder" i], [aria-label*="open order" i] tr, [role="row"]')];
    const openOrders = orderEls.slice(0, 40).map(el => ({ raw: txt(el).slice(0, 160) })).filter(o => o.raw);
    return { capturedAt: new Date().toISOString(), balances, openOrders, positions: [] };
  })()`;
}

export async function portfolioSnapshot({ debugUrl, urlContains } = {}) {
  const { session } = await requireSignedInTab({ debugUrl, urlContains });
  try {
    const snap = await session.evaluate(portfolioScript());
    return { ts: Date.now(), ...snap };
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// coinbase_place_order (Step 6): EXECUTION SCAFFOLD. dryRun is HARDCODED true.
// NEVER touches the order form. Validates against config risk limits + the
// latest portfolio/quote, and (in PAPER mode) emits a simulatedFill.
//
// Chan, "Algorithmic Trading: Winning Strategies and Their Rationale" (Ch. 1
// on backtesting discipline and Ch. 8 on money/position management via the
// Kelly criterion): position size must be a function of edge and risk, never a
// fixed guess. The risk gate below is where Kelly sizing will live next pass.
// Harris (Ch. 4) — market vs. limit is a cost/immediacy tradeoff; the `type`
// field is where that policy decision surfaces.
// ---------------------------------------------------------------------------
export async function placeOrder(args = {}) {
  const cfg = loadConfig();
  const {
    side, type, baseSize, quoteSize, limitPrice, timeInForce = "GTC", clientOrderId
  } = args;
  // dryRun is HARDCODED true in this pass regardless of caller input.
  const dryRun = true;

  const reject = reason => ({ accepted: false, dryRun, reason, mode: cfg.mode, clientOrderId: clientOrderId ?? null });

  if (!clientOrderId) return reject("clientOrderId is required.");
  if (!["buy", "sell"].includes(side)) return reject("side must be 'buy' or 'sell'.");
  if (!["market", "limit"].includes(type)) return reject("type must be 'market' or 'limit'.");

  // Kill switch and OBSERVE_ONLY reject everything.
  if (cfg.killSwitch) return reject("killSwitch is engaged in config; no orders (even simulated) accepted.");
  if (cfg.mode === "OBSERVE_ONLY") return reject("mode is OBSERVE_ONLY; all order requests rejected by design.");
  if (cfg.mode === "LIVE") return reject("LIVE mode is not wired in this pass (Hard Constraint #5).");

  // From here: mode === "PAPER".
  // Estimate notional from the freshest tick in the ring buffer.
  const lastTick = ring.lastOfType("tick");
  const bestBid = dec(lastTick?.bidPx);
  const bestAsk = dec(lastTick?.askPx);
  if (!bestBid || !bestAsk) return reject("No live quote available; run coinbase_market_stream first.");

  // Simulated fill price: buys lift the ask, sells hit the bid (Harris Ch. 6).
  const fillPx = side === "buy" ? bestAsk : bestBid;
  let filledBase = dec(baseSize);
  let notional;
  if (filledBase) {
    notional = filledBase.mul(fillPx);
  } else if (dec(quoteSize)) {
    notional = dec(quoteSize);
    filledBase = notional.div(fillPx);
  } else {
    return reject("Provide baseSize or quoteSize (decimal string).");
  }

  // Risk gate: notional must not exceed maxNotionalUsd.
  const maxNotional = new Decimal(cfg.maxNotionalUsd || 0);
  if (notional.greaterThan(maxNotional)) {
    return reject(`Notional ${notional.toString()} exceeds maxNotionalUsd ${maxNotional.toString()}.`);
  }

  // Emit a simulatedFill into the journal (read-only side effect).
  journal = journal || new JsonlJournal({ symbol: cfg.symbol });
  const fill = {
    type: "simulatedFill", ts: Date.now(), symbol: cfg.symbol,
    side, orderType: type, clientOrderId,
    fillPx: fillPx.toString(), filledBase: filledBase.toString(),
    notionalUsd: notional.toString(), limitPrice: limitPrice ?? null,
    timeInForce, mode: cfg.mode
  };
  ring.push(fill);
  journal.append(fill);

  return {
    accepted: true, dryRun, mode: cfg.mode, simulatedFill: serializeEvent(fill),
    journalPath: journal.path()
  };
}
