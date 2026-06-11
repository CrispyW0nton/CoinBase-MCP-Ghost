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
import { ChromeSession, fetchVersion, listTabs } from "./chrome.js";
import { loadConfig, liveModeArmed, recordLiveConfirmation, getLiveConfirmation } from "./config.js";
import { RingBuffer, JsonlJournal } from "./journal.js";
import {
  makeTick, makeL2Update, makeTrade, makeCandle, makeGap,
  serializeEvent, dec, Decimal
} from "./schema.js";
import {
  OrderBookImbalanceSignal,
  SOURCES,
  decimalMapSet,
  confidenceFor,
  degradedReasonFor
} from "./signal.js";

const DEFAULT_DEBUG_URL = "http://127.0.0.1:9222";

const ADVANCED_VIEW_RE = /https:\/\/www\.coinbase\.com\/advanced-(trade|portfolio)(?:\/|$|\?)/i;

function tabMatchesCoinbase(tab, urlContains) {
  const url = String(tab?.url || "");
  if (!ADVANCED_VIEW_RE.test(url)) return false;
  const needles = Array.isArray(urlContains) ? urlContains : [urlContains].filter(Boolean);
  if (needles.length === 0) return true;
  return needles.some(needle => url.toLowerCase().includes(String(needle).toLowerCase()));
}

function viewFromUrl(url = "") {
  if (/\/advanced-portfolio(?:\/|$|\?)/i.test(url)) return "portfolio";
  if (/\/advanced-trade(?:\/|$|\?)/i.test(url)) return "trade";
  return "unknown";
}

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
  const needles = urlContains ?? ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"];
  const tabs = await listTabs(debugUrl);
  const match = tabs.find(t => tabMatchesCoinbase(t, needles));
  if (!match) {
    throw new Error(
      `No Coinbase Advanced Trade/Portfolio tab found on the debug endpoint (${debugUrl}).\n` +
      `Open https://www.coinbase.com/advanced-portfolio or https://www.coinbase.com/advanced-trade/spot/BTC-USD in the DEDICATED\n` +
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
      advancedText: /\\b(Portfolio|Order form|Order book|Balance summary|Assets)\\b/i.test(document.body?.innerText || ""),
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
    const signedIn = (matchedSignedIn.length > 0 || probe.advancedText === true) && matchedSignedOut.length === 0;

    return {
      attached: true,
      loaded,
      signedIn,
      view: viewFromUrl(tab.url),
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
  let probe = await session.evaluate(probeScript());
  const matchedSignedIn = probe.signedIn.filter(r => r.present).map(r => r.selector);
  const matchedSignedOut = probe.signedOut.filter(r => r.present).map(r => r.selector);
  let signedIn = (matchedSignedIn.length > 0 || probe.advancedText === true) && matchedSignedOut.length === 0;
  if (!signedIn && matchedSignedOut.length === 0) {
    const deadline = Date.now() + 8_000;
    while (!signedIn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      probe = await session.evaluate(probeScript()).catch(() => probe);
      const retrySignedIn = probe.signedIn.filter(r => r.present).map(r => r.selector);
      const retrySignedOut = probe.signedOut.filter(r => r.present).map(r => r.selector);
      signedIn = (retrySignedIn.length > 0 || probe.advancedText === true) && retrySignedOut.length === 0;
    }
  }
  if (!signedIn) {
    session.close();
    throw new Error(
      "Refusing to run: the Advanced Trade tab does not look signed in.\n" +
      "Sign in to Coinbase in the debug-profile window first, then retry."
    );
  }
  return { session, tab, cfg, view: viewFromUrl(tab.url) };
}

// ---------------------------------------------------------------------------
// Pass 2 feature state: L2 imbalance signal + PAPER P&L ledger.
//
// Harris (market microstructure) motivates bid/ask depth imbalance as an
// order-book pressure signal. Grinold-Kahn's IR≈IC·sqrt(breadth) and Chan's
// Kelly sizing guidance motivate measuring realized PAPER outcomes before
// sizing; López de Prado warns against fitting an edge before the feed is
// measured out of sample.
// ---------------------------------------------------------------------------

const book = new OrderBookImbalanceSignal({ levels: 10 });
const paperLedger = {
  positionBase: new Decimal(0),
  avgCostUsd: new Decimal(0),
  realizedPnlUsd: new Decimal(0),
  unrealizedPnlUsd: new Decimal(0),
  lastMarkPx: null,
  fills: [],
  outcomes: []
};

function depth(side, levels = 10) {
  return book.depth(side, levels);
}

function maybeEmitImbalanceSignal({ ts, symbol, seq, source = SOURCES.WS, ageMs = 0, hasSequence = seq !== null }, stats) {
  const signal = book.createSignal({ ts, symbol, seq, source, ageMs, hasSequence });
  if (!signal) return null;
  ring.push(signal);
  appendJournal(signal, stats);
  return signal;
}

function markLedger(markPx) {
  const mark = dec(markPx);
  if (!mark) return;
  paperLedger.lastMarkPx = mark;
  paperLedger.unrealizedPnlUsd = paperLedger.positionBase.mul(mark.minus(paperLedger.avgCostUsd));
}

function applySimulatedFill(fill) {
  const px = dec(fill.fillPx);
  const qty = dec(fill.filledBase);
  if (!px || !qty) return;
  const signedQty = fill.side === "buy" ? qty : qty.negated();
  const before = paperLedger.positionBase;
  const after = before.plus(signedQty);

  if (fill.side === "buy") {
    const previousCost = paperLedger.avgCostUsd.mul(before);
    const newCost = previousCost.plus(qty.mul(px));
    paperLedger.positionBase = after;
    paperLedger.avgCostUsd = after.isZero() ? new Decimal(0) : newCost.div(after);
  } else {
    const closingQty = Decimal.min(qty, Decimal.max(before, new Decimal(0)));
    paperLedger.realizedPnlUsd = paperLedger.realizedPnlUsd.plus(px.minus(paperLedger.avgCostUsd).mul(closingQty));
    paperLedger.positionBase = after;
    if (after.lte(0)) paperLedger.avgCostUsd = new Decimal(0);
  }

  paperLedger.fills.push(fill);
  paperLedger.fills = paperLedger.fills.slice(-500);
  markLedger(px);

  if (book.lastSignal) {
    paperLedger.outcomes.push({
      signal: book.lastSignal.value,
      pnl: fill.side === "sell" ? px.minus(paperLedger.avgCostUsd) : new Decimal(0),
      source: book.lastSignal.source,
      degraded: book.lastSignal.degraded === true
    });
    paperLedger.outcomes = paperLedger.outcomes.slice(-500);
  }
}

function serializeDecimal(value) {
  return value === null || value === undefined ? null : value.toString();
}

function paperLedgerSnapshot() {
  return {
    mode: loadConfig().mode,
    positionBase: serializeDecimal(paperLedger.positionBase),
    avgCostUsd: serializeDecimal(paperLedger.avgCostUsd),
    realizedPnlUsd: serializeDecimal(paperLedger.realizedPnlUsd),
    unrealizedPnlUsd: serializeDecimal(paperLedger.unrealizedPnlUsd),
    lastMarkPx: serializeDecimal(paperLedger.lastMarkPx),
    fills: paperLedger.fills.map(serializeEvent),
    kelly: kellySizing()
  };
}

function kellySizing() {
  const outcomes = paperLedger.outcomes.filter(item => item.signal && item.pnl);
  const degradedInputs = outcomes.some(item => item.degraded === true || item.source !== SOURCES.WS);
  if (degradedInputs) {
    return {
      observations: outcomes.length,
      informationCoefficient: null,
      meanEdge: null,
      variance: null,
      halfKellyFraction: "0",
      refused: true,
      reason: "Kelly sizing disabled for degraded/non-WS data; see Kahneman bias guardrails and Lopez de Prado on low-quality samples."
    };
  }
  if (outcomes.length < 2) {
    return { observations: outcomes.length, informationCoefficient: null, meanEdge: null, variance: null, halfKellyFraction: "0", refused: true, reason: "insufficient measured PAPER outcomes" };
  }
  const n = new Decimal(outcomes.length);
  const meanSignal = outcomes.reduce((sum, x) => sum.plus(x.signal), new Decimal(0)).div(n);
  const meanPnl = outcomes.reduce((sum, x) => sum.plus(x.pnl), new Decimal(0)).div(n);
  let cov = new Decimal(0), varSignal = new Decimal(0), varPnl = new Decimal(0);
  for (const item of outcomes) {
    const ds = item.signal.minus(meanSignal);
    const dp = item.pnl.minus(meanPnl);
    cov = cov.plus(ds.mul(dp));
    varSignal = varSignal.plus(ds.mul(ds));
    varPnl = varPnl.plus(dp.mul(dp));
  }
  const ic = varSignal.isZero() || varPnl.isZero() ? new Decimal(0) : cov.div(varSignal.mul(varPnl).sqrt());
  const variance = varPnl.div(n);
  const fullKelly = variance.isZero() ? new Decimal(0) : meanPnl.div(variance);
  const halfKelly = Decimal.max(new Decimal(0), fullKelly.div(2));
  return {
    observations: outcomes.length,
    informationCoefficient: ic.toString(),
    meanEdge: meanPnl.toString(),
    variance: variance.toString(),
    halfKellyFraction: halfKelly.toString(),
    refused: false,
    reason: null
  };
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
  const frameTs = Date.parse(msg.timestamp) || Date.now();
  const frameAgeMs = Math.max(0, Date.now() - frameTs);
  const frameProvenance = {
    source: SOURCES.WS,
    ageMs: frameAgeMs,
    hasSequence: sequenceNum !== null,
    confidence: sequenceNum !== null ? "high" : "medium",
    degradedReason: sequenceNum === null ? "ws frame without sequence_num" : null
  };

  if (!Array.isArray(msg.events)) return { events: out, sequenceNum, channel };

  for (const ev of msg.events) {
    if (channel === "ticker" || channel === "ticker_batch") {
      for (const t of ev.tickers ?? []) {
        out.push(makeTick({
          ts: frameTs,
          symbol: t.product_id || symbol,
          bidPx: t.best_bid, bidSz: t.best_bid_quantity,
          askPx: t.best_ask, askSz: t.best_ask_quantity,
          lastPx: t.price, lastSz: null,
          ...frameProvenance
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
          isSnapshot, seq: sequenceNum,
          ...frameProvenance
        }));
      }
    } else if (channel === "market_trades") {
      for (const tr of ev.trades ?? []) {
        out.push(makeTrade({
          ts: Date.parse(tr.time) || Date.now(),
          symbol: tr.product_id || symbol,
          side: tr.side ? String(tr.side).toLowerCase() : null,
          px: tr.price, sz: tr.size, tradeId: tr.trade_id,
          ...frameProvenance
        }));
      }
    } else if (channel === "candles") {
      for (const c of ev.candles ?? []) {
        out.push(makeCandle({
          ts: (Number(c.start) * 1000) || Date.now(),
          symbol: c.product_id || symbol,
          granularitySec: null,
          o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
          ...frameProvenance
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

function appendJournal(evt, stats) {
  const result = journal?.append(evt);
  if (result?.rejected && stats) stats.journalRejected = (stats.journalRejected || 0) + 1;
  return result;
}

export async function marketStream({ debugUrl, urlContains, durationMs = 30_000 } = {}) {
  const { session, tab, cfg, view } = await requireSignedInTab({ debugUrl, urlContains });
  journal = journal || new JsonlJournal({ symbol: cfg.symbol });

  const stats = { ticks: 0, l2: 0, trades: 0, candles: 0, gaps: 0, signals: 0, frames: 0, journalRejected: 0, sockets: new Set() };
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

    // Gap detection is meaningful only on sequenced WS frames. Kleppmann's
    // stream-processing reliability model does not apply to DOM snapshots,
    // so DOM/poll/SSE without exchange sequence never emits a fake clean gap.
    if (sequenceNum !== null) {
      if (lastSeq !== null && sequenceNum > lastSeq + 1) {
        const gap = makeGap({ symbol: cfg.symbol, expectedSeq: lastSeq + 1, gotSeq: sequenceNum, channel });
        ring.push(gap); appendJournal(gap, stats); stats.gaps++;
        // NOTE: we do NOT invent a resubscribe. Step 3 observes how the page
        // itself reconnects; the recon report records that behavior so a
        // future pass can mirror it. (Kleppmann Ch.11: prefer the system's
        // own recovery to a bespoke one.)
      }
      if (lastSeq === null || sequenceNum > lastSeq) lastSeq = sequenceNum;
    }

    for (const evt of events) {
      processObservedEvent(evt, stats);
    }
  };

  const offRecv = session.on?.("Network.webSocketFrameReceived", handleFrame);

  if (view === "portfolio") {
    const loaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
    await session.command("Page.navigate", { url: `https://www.coinbase.com/advanced-trade/spot/${encodeURIComponent(cfg.symbol)}` });
    await loaded;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }

  await new Promise(resolve => setTimeout(resolve, durationMs));

  if (stats.frames === 0) {
    const fallback = await collectDomOrderBook(session, cfg.symbol);
    for (const evt of fallback.events) {
      processObservedEvent(evt, stats);
    }
    stats.domFallback = fallback.events.length > 0;
  }

  const activeUrl = await safeLocation(session);
  if (view === "portfolio") {
    const loaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
    await session.command("Page.navigate", { url: tab.url }).catch(() => {});
    await loaded;
  }

  offCreated?.();
  offRecv?.();
  session.close();

  return {
    streamed: true,
    durationMs,
    tab: { id: tab.id, url: tab.url },
    sockets: [...stats.sockets],
    startView: view,
    activeView: viewFromUrl(activeUrl),
    source: stats.frames > 0 ? SOURCES.WS : (stats.domFallback ? SOURCES.DOM : null),
    counts: { ticks: stats.ticks, l2: stats.l2, trades: stats.trades, candles: stats.candles, gaps: stats.gaps, signals: stats.signals, frames: stats.frames, journalRejected: stats.journalRejected },
    domFallback: Boolean(stats.domFallback),
    journalPath: journal.path(),
    journalStats: journal.stats(),
    ringSize: ring.size(),
    lastSignal: book.lastSignal ? serializeEvent(book.lastSignal) : null,
    paperLedger: paperLedgerSnapshot()
  };
}

export async function record({ debugUrl, urlContains, durationMs = 60 * 60 * 1000, sampleIntervalMs = 1000, healthIntervalMs = 30_000, outputRoot = "recordings" } = {}) {
  const cfg = loadConfig();
  const symbol = cfg.symbol;
  journal = journal || new JsonlJournal({ symbol });
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outputDir = path.join(outputRoot, `${symbol.toLowerCase()}-${stamp}`);
  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.mkdir(outputDir, { recursive: true });

  const stats = {
    ticks: 0, l2: 0, trades: 0, candles: 0, gaps: 0, signals: 0, frames: 0,
    journalRejected: 0, samples: 0, emptySamples: 0
  };
  const manifest = {
    recording: true,
    mode: cfg.mode,
    symbol,
    source: SOURCES.DOM,
    dataQuality: "low-confidence / DOM-sourced",
    startedAt,
    endedAt: null,
    durationMs,
    sampleIntervalMs,
    healthIntervalMs,
    outputDir,
    journalPath: journal.path(),
    counts: stats,
    provenance: { bySource: {}, byConfidence: {}, degraded: { true: 0, false: 0 } },
    disconnects: [],
    health: []
  };

  let session = null;
  let tab = null;
  let view = null;
  let nextHealth = Date.now();
  const deadline = Date.now() + Number(durationMs);

  async function connect() {
    const attached = await requireSignedInTab({ debugUrl, urlContains });
    session = attached.session;
    tab = attached.tab;
    view = attached.view;
    if (view === "portfolio") {
      const loaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
      await session.command("Page.navigate", { url: `https://www.coinbase.com/advanced-trade/spot/${encodeURIComponent(symbol)}` });
      await loaded;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }

  async function writeManifest(status = "recording") {
    manifest.status = status;
    manifest.lastHeartbeatAt = new Date().toISOString();
    manifest.journalStats = journal.stats();
    manifest.ringSize = ring.size();
    manifest.counts = { ...stats };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  try {
    await connect();
    while (Date.now() < deadline) {
      try {
        const sample = await collectDomOrderBook(session, symbol);
        stats.samples++;
        if (sample.events.length === 0) stats.emptySamples++;
        for (const evt of sample.events) {
          countProvenance(manifest.provenance, evt);
          processObservedEvent(evt, stats);
        }
      } catch (err) {
        const disconnect = { at: new Date().toISOString(), reason: err.message };
        manifest.disconnects.push(disconnect);
        session?.close?.();
        session = null;
        await writeManifest("reconnecting");
        await new Promise(resolve => setTimeout(resolve, 2_000));
        await connect();
      }

      if (Date.now() >= nextHealth) {
        manifest.health.push({
          at: new Date().toISOString(),
          samples: stats.samples,
          events: stats.ticks + stats.l2 + stats.trades + stats.candles + stats.signals,
          journalRejected: stats.journalRejected,
          ringSize: ring.size()
        });
        manifest.health = manifest.health.slice(-500);
        await writeManifest("recording");
        nextHealth = Date.now() + Number(healthIntervalMs);
      }
      await new Promise(resolve => setTimeout(resolve, Number(sampleIntervalMs)));
    }
  } finally {
    session?.close?.();
    manifest.recording = false;
    manifest.endedAt = new Date().toISOString();
    await writeManifest("complete");
  }

  return {
    recorded: true,
    manifestPath,
    journalPath: journal.path(),
    counts: stats,
    provenance: manifest.provenance,
    disconnects: manifest.disconnects,
    journalStats: journal.stats()
  };
}

function processObservedEvent(evt, stats) {
  ring.push(evt);
  appendJournal(evt, stats);
  if (evt.type === "tick") {
    stats.ticks++;
    markLedger(evt.lastPx ?? evt.bidPx ?? evt.askPx);
  } else if (evt.type === "l2update") {
    stats.l2++;
    decimalMapSet(book[evt.side], evt.px, evt.sz);
    if (maybeEmitImbalanceSignal({
      ts: evt.ts,
      symbol: evt.symbol,
      seq: evt.seq,
      source: evt.source,
      ageMs: evt.ageMs,
      hasSequence: evt.hasSequence
    }, stats)) stats.signals++;
  }
  else if (evt.type === "trade") stats.trades++;
  else if (evt.type === "candle") stats.candles++;
}

function countProvenance(bucket, evt) {
  bucket.bySource[evt.source] = (bucket.bySource[evt.source] || 0) + 1;
  bucket.byConfidence[evt.confidence] = (bucket.byConfidence[evt.confidence] || 0) + 1;
  bucket.degraded[evt.degraded === true ? "true" : "false"]++;
}

async function collectDomOrderBook(session, symbol) {
  const sample = await session.evaluate(`(() => {
    const lines = (document.body?.innerText || "").split(/\\n+/).map(s => s.trim()).filter(Boolean);
    const start = lines.findIndex(line => /^BID \\(USD\\)$/i.test(line));
    const end = lines.findIndex((line, idx) => idx > start && /Recent trades/i.test(line));
    const section = lines.slice(start >= 0 ? start : 0, end > start ? end : undefined);
    const nums = section.map(line => line.replace(/,/g, "")).filter(line => /^\\d+(?:\\.\\d+)?$/.test(line));
    const pairs = [];
    for (let i = 0; i < nums.length - 1; i += 2) {
      const price = nums[i];
      const size = nums[i + 1];
      if (Number(price) > 1000 && Number(size) >= 0 && Number(size) < 1000) pairs.push({ price, size });
    }
    const half = Math.floor(pairs.length / 2);
    const tradeStart = lines.findIndex(line => /Recent trades/i.test(line));
    const tradeNums = lines.slice(tradeStart >= 0 ? tradeStart + 1 : lines.length, tradeStart >= 0 ? tradeStart + 90 : lines.length)
      .map(line => line.replace(/,/g, ""))
      .filter(line => /^\\d+(?:\\.\\d+)?$/.test(line));
    const trades = [];
    for (let i = 0; i < tradeNums.length - 1 && trades.length < 20; i += 2) {
      const price = tradeNums[i];
      const size = tradeNums[i + 1];
      if (Number(price) > 1000 && Number(size) > 0 && Number(size) < 1000) trades.push({ price, size });
    }
    return { bids: pairs.slice(0, half), asks: pairs.slice(half), trades, capturedAt: Date.now() };
  })()`);
  const ts = sample?.capturedAt || Date.now();
  const provenance = {
    source: SOURCES.DOM,
    ageMs: 0,
    hasSequence: false,
    confidence: "low",
    degradedReason: "rendered DOM snapshot; no exchange sequence_num"
  };
  const events = [];
  for (const bid of sample?.bids?.slice(0, 25) || []) {
    events.push(makeL2Update({ ts, symbol, side: "bid", px: bid.price, sz: bid.size, isSnapshot: true, seq: null, ...provenance }));
  }
  for (const ask of sample?.asks?.slice(0, 25) || []) {
    events.push(makeL2Update({ ts, symbol, side: "ask", px: ask.price, sz: ask.size, isSnapshot: true, seq: null, ...provenance }));
  }
  if (sample?.bids?.[0] && sample?.asks?.[0]) {
    events.push(makeTick({
      ts, symbol,
      bidPx: sample.bids[0].price, bidSz: sample.bids[0].size,
      askPx: sample.asks[0].price, askSz: sample.asks[0].size,
      lastPx: null, lastSz: null,
      ...provenance
    }));
  }
  for (const trade of sample?.trades || []) {
    events.push(makeTrade({
      ts, symbol, side: null, px: trade.price, sz: trade.size,
      tradeId: `dom-${ts}-${trade.price}-${trade.size}`,
      ...provenance
    }));
  }
  return { events };
}

export async function snapshotState({ n = 200 } = {}) {
  return {
    ringSize: ring.size(),
    counts: ring.counts(),
    lastTick: ring.lastOfType("tick"),
    lastTrade: ring.lastOfType("trade"),
    lastSignal: book.lastSignal ? serializeEvent(book.lastSignal) : null,
    paperLedger: paperLedgerSnapshot(),
    recent: ring.recent(Number(n))
  };
}

async function listRawTargets(debugUrl = DEFAULT_DEBUG_URL) {
  const response = await fetch(`${debugUrl.replace(/\/+$/, "")}/json/list`);
  if (!response.ok) throw new Error(`Chrome debug endpoint returned ${response.status} ${response.statusText}`);
  return response.json();
}

function isCoinbaseTarget(target) {
  return /coinbase\.com/.test(String(target?.url || "")) || /coinbase/i.test(String(target?.title || ""));
}

function samplePayloadShape(payload) {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return {
      json: true,
      keys: Object.keys(parsed).slice(0, 20),
      channel: parsed.channel ?? null,
      sequenceNumPresent: Object.prototype.hasOwnProperty.call(parsed, "sequence_num"),
      eventsType: Array.isArray(parsed.events) ? "array" : typeof parsed.events
    };
  } catch {
    return { json: false, bytes: payload.length, prefix: payload.slice(0, 80) };
  }
}

function isTransportCandidateUrl(url = "") {
  return /advanced-trade-ws|\/api\/v3\/brokerage\/|\/stream\/|event-stream|eventsource|webtransport/i.test(url);
}

async function attachTransportRecorder(target, label, bag) {
  const session = await new ChromeSession({
    id: target.id,
    title: target.title,
    url: target.url,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl
  }).connect();
  const record = {
    label,
    target: { id: target.id, type: target.type, title: target.title, url: target.url },
    webSockets: {},
    eventSourceMessages: [],
    rest: {},
    webTransport: [],
    errors: []
  };
  bag.targets.push(record);
  const wsIdToUrl = new Map();
  const offs = [];
  const add = (method, fn) => offs.push(session.on(method, fn));

  await session.command("Network.enable").catch(error => record.errors.push({ where: "Network.enable", message: error.message }));

  add("Network.webSocketCreated", p => {
    wsIdToUrl.set(p.requestId, p.url);
    record.webSockets[p.url] = record.webSockets[p.url] || {
      url: p.url, created: 0, sent: [], received: [], errors: [], closed: 0, channels: {}
    };
    record.webSockets[p.url].created++;
  });
  add("Network.webSocketFrameSent", p => {
    const url = wsIdToUrl.get(p.requestId) || "(unknown)";
    const ws = record.webSockets[url] = record.webSockets[url] || { url, created: 0, sent: [], received: [], errors: [], closed: 0, channels: {} };
    const payload = p?.response?.payloadData || "";
    if (ws.sent.length < 20) ws.sent.push({ bytes: payload.length, shape: samplePayloadShape(payload) });
  });
  add("Network.webSocketFrameReceived", p => {
    const url = wsIdToUrl.get(p.requestId) || "(unknown)";
    const ws = record.webSockets[url] = record.webSockets[url] || { url, created: 0, sent: [], received: [], errors: [], closed: 0, channels: {} };
    const payload = p?.response?.payloadData || "";
    const shape = samplePayloadShape(payload);
    if (ws.received.length < 20) ws.received.push({ bytes: payload.length, shape });
    const channel = shape?.channel || "(unknown)";
    ws.channels[channel] = (ws.channels[channel] || 0) + 1;
  });
  add("Network.webSocketFrameError", p => {
    const url = wsIdToUrl.get(p.requestId) || "(unknown)";
    const ws = record.webSockets[url] = record.webSockets[url] || { url, created: 0, sent: [], received: [], errors: [], closed: 0, channels: {} };
    ws.errors.push({ errorMessage: p.errorMessage || null });
  });
  add("Network.webSocketClosed", p => {
    const url = wsIdToUrl.get(p.requestId) || "(unknown)";
    const ws = record.webSockets[url] = record.webSockets[url] || { url, created: 0, sent: [], received: [], errors: [], closed: 0, channels: {} };
    ws.closed++;
  });
  add("Network.eventSourceMessageReceived", p => {
    if (record.eventSourceMessages.length < 50) {
      record.eventSourceMessages.push({
        requestId: p.requestId,
        eventName: p.eventName,
        eventId: p.eventId,
        dataShape: samplePayloadShape(p.data || "")
      });
    }
  });
  add("Network.requestWillBeSent", p => {
    const u = p?.request?.url || "";
    if (!isTransportCandidateUrl(u)) return;
    let key = u;
    try { key = new URL(u).pathname; } catch {}
    record.rest[key] = record.rest[key] || { method: p?.request?.method || "GET", count: 0, sampleQuery: safeQuery(u), type: p?.type || null };
    record.rest[key].count++;
  });
  add("Network.responseReceived", p => {
    const u = p?.response?.url || "";
    if (!isTransportCandidateUrl(u)) return;
    let key = u;
    try { key = new URL(u).pathname; } catch {}
    record.rest[key] = record.rest[key] || { method: null, count: 0, sampleQuery: safeQuery(u), type: p?.type || null };
    record.rest[key].status = p?.response?.status ?? null;
    record.rest[key].mimeType = p?.response?.mimeType ?? null;
  });
  add("Network.webTransportCreated", p => record.webTransport.push({ url: p.url, timestamp: p.timestamp }));
  add("Network.webTransportConnectionEstablished", p => record.webTransport.push({ requestId: p.transportId, established: true, timestamp: p.timestamp }));
  add("Network.webTransportClosed", p => record.webTransport.push({ requestId: p.transportId, closed: true, timestamp: p.timestamp }));

  return {
    session,
    record,
    close: () => {
      for (const off of offs) off?.();
      session.close();
    }
  };
}

function safeQuery(urlValue) {
  try {
    const query = new URL(urlValue).search;
    return query ? query.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function summarizeTransport(diag) {
  const allTargets = diag.targets;
  const wsTargets = [];
  const sseTargets = [];
  const pollTargets = [];
  const webTransportTargets = [];
  for (const target of allTargets) {
    const wsEntries = Object.values(target.webSockets || {});
    const frameCount = wsEntries.reduce((sum, ws) => sum + ws.received.length, 0);
    if (wsEntries.length || frameCount) wsTargets.push({ label: target.label, target: target.target, frameCount, urls: wsEntries.map(ws => ws.url), channels: [...new Set(wsEntries.flatMap(ws => Object.keys(ws.channels || {})))] });
    if (target.eventSourceMessages?.length) sseTargets.push({ label: target.label, target: target.target, count: target.eventSourceMessages.length });
    const rest = Object.entries(target.rest || {}).filter(([url]) => isTransportCandidateUrl(url));
    if (rest.length) pollTargets.push({ label: target.label, target: target.target, endpoints: rest.map(([url, meta]) => ({ url, method: meta.method, count: meta.count, status: meta.status, mimeType: meta.mimeType })) });
    if (target.webTransport?.length) webTransportTargets.push({ label: target.label, target: target.target, events: target.webTransport });
  }
  const viableWs = wsTargets.some(item => item.frameCount > 0);
  const conditional = wsTargets.some(item => item.urls.some(url => /advanced-trade-ws|wss:|coinbase/i.test(url)));
  return {
    wsTapViable: viableWs ? "yes" : (conditional ? "conditional" : "no"),
    reason: viableWs
      ? "CDP captured WebSocket frames after early attach/navigation."
      : "No CDP WebSocket frames were captured after early attach/navigation; live data appears available through REST/polling and rendered DOM in this Chrome/Coinbase build.",
    wsTargets,
    sseTargets,
    pollTargets,
    webTransportTargets
  };
}

export async function diagnoseTransport({ debugUrl, urlContains, durationMs = 45_000, outputRoot } = {}) {
  const { session, tab, cfg, view } = await requireSignedInTab({ debugUrl, urlContains });
  const dbg = debugUrl || cfg.debugUrl;
  const originalUrl = tab.url;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = outputRoot || path.join(process.cwd(), "recon", `${cfg.symbol.toLowerCase()}-${stamp}`);
  await fs.mkdir(dir, { recursive: true });

  const diag = {
    capturedAt: new Date().toISOString(),
    durationMs,
    originalUrl,
    startView: view,
    testedFirst: "trade",
    constraints: {
      passiveOnly: true,
      noClicks: true,
      noCoinbaseApiClient: true,
      noSecondAuthenticatedSocketFromMcp: true
    },
    browser: await fetchVersion(dbg).catch(error => ({ error: error.message })),
    targetsBefore: (await listRawTargets(dbg)).filter(isCoinbaseTarget).map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
    targets: []
  };

  const recorders = [];
  try {
    const browserSession = await new ChromeSession({
      id: "browser",
      title: "browser",
      url: dbg,
      webSocketDebuggerUrl: diag.browser.webSocketDebuggerUrl
    }).connect().catch(() => null);
    if (browserSession) {
      diag.targetGetTargetsBefore = await browserSession.command("Target.getTargets")
        .then(result => (result.targetInfos || []).filter(isCoinbaseTarget).map(t => ({ id: t.targetId, type: t.type, title: t.title, url: t.url })))
        .catch(error => ({ error: error.message }));
      browserSession.close();
    }

    recorders.push(await attachTransportRecorder({
      id: tab.id,
      type: "page",
      title: tab.title,
      url: tab.url,
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl
    }, "primary-page-before-navigation", diag));

    await session.command("Page.enable");
    await session.command("Network.enable");
    const attachWorkers = async label => {
      const targets = (await listRawTargets(dbg)).filter(t => isCoinbaseTarget(t) && /worker/i.test(t.type || ""));
      for (const target of targets) {
        if (recorders.some(item => item.record.target.id === target.id)) continue;
        recorders.push(await attachTransportRecorder(target, `${label}-${target.type}`, diag).catch(error => ({
          record: { label, target: { id: target.id, type: target.type, title: target.title, url: target.url }, webSockets: {}, eventSourceMessages: [], rest: {}, webTransport: [], errors: [{ where: "attach", message: error.message }] },
          close: () => {}
        })));
      }
    };

    await attachWorkers("before-trade-nav");
    const tradeLoaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
    await session.command("Page.navigate", { url: `https://www.coinbase.com/advanced-trade/spot/${encodeURIComponent(cfg.symbol)}` });
    await tradeLoaded;
    await waitForAdvancedViewForDiagnose(session, "trade");
    await attachWorkers("after-trade-nav");
    await new Promise(resolve => setTimeout(resolve, Math.floor(durationMs * 0.65)));

    const portfolioLoaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
    await session.command("Page.navigate", { url: "https://www.coinbase.com/advanced-portfolio" });
    await portfolioLoaded;
    await waitForAdvancedViewForDiagnose(session, "portfolio");
    await attachWorkers("after-portfolio-nav");
    await new Promise(resolve => setTimeout(resolve, Math.ceil(durationMs * 0.35)));

    diag.targetsAfter = (await listRawTargets(dbg)).filter(isCoinbaseTarget).map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url }));
    const browserSessionAfter = await new ChromeSession({
      id: "browser",
      title: "browser",
      url: dbg,
      webSocketDebuggerUrl: diag.browser.webSocketDebuggerUrl
    }).connect().catch(() => null);
    if (browserSessionAfter) {
      diag.targetGetTargetsAfter = await browserSessionAfter.command("Target.getTargets")
        .then(result => (result.targetInfos || []).filter(isCoinbaseTarget).map(t => ({ id: t.targetId, type: t.type, title: t.title, url: t.url })))
        .catch(error => ({ error: error.message }));
      browserSessionAfter.close();
    }
    diag.summary = summarizeTransport(diag);
  } finally {
    for (const recorder of recorders) recorder.close?.();
    if ((await safeLocation(session)) !== originalUrl) {
      await session.command("Page.navigate", { url: originalUrl }).catch(() => {});
    }
    session.close();
  }

  const networkMap = {
    capturedAt: diag.capturedAt,
    diagnostic: true,
    transportSummary: diag.summary,
    targetsBefore: diag.targetsBefore,
    targetGetTargetsBefore: diag.targetGetTargetsBefore || [],
    targetsAfter: diag.targetsAfter || [],
    targetGetTargetsAfter: diag.targetGetTargetsAfter || [],
    targets: diag.targets
  };
  await fs.writeFile(path.join(dir, "network-map.json"), JSON.stringify(networkMap, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "transport-diagnostic.json"), JSON.stringify(diag, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "RECON_REPORT.md"), buildTransportDiagnosticReport({ cfg, diag }), "utf8");

  return {
    diagnosed: true,
    outputDir: dir,
    verdict: diag.summary.wsTapViable,
    reason: diag.summary.reason,
    testedFirst: "trade",
    wsTargets: diag.summary.wsTargets,
    sseTargets: diag.summary.sseTargets,
    pollTargets: diag.summary.pollTargets,
    webTransportTargets: diag.summary.webTransportTargets
  };
}

async function waitForAdvancedViewForDiagnose(session, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await session.evaluate(`(() => {
      const text = document.body?.innerText || "";
      return ${JSON.stringify(label)} === "trade"
        ? /Order book|BID \\(USD\\)|Recent trades/.test(text)
        : /Total balance|Cash|Crypto/.test(text);
    })()`).catch(() => false);
    if (ready) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function buildTransportDiagnosticReport({ cfg, diag }) {
  const summary = diag.summary;
  const restLines = summary.pollTargets.flatMap(item => item.endpoints.map(ep =>
    `- ${item.label} / ${item.target.type}: \`${ep.method || "?"} ${ep.url}\` x${ep.count}${ep.mimeType ? ` (${ep.mimeType})` : ""}`
  ));
  const wsLines = summary.wsTargets.flatMap(item => item.urls.map(url =>
    `- ${item.label} / ${item.target.type}: \`${url}\` frames=${item.frameCount} channels=${item.channels.join(", ") || "none"}`
  ));
  return `# Coinbase Transport Diagnostic — ${cfg.symbol}

_Captured: ${diag.capturedAt}_  
_Test order: trade first, then portfolio._  
_Mode: ${cfg.mode}; passive CDP observation only._

## WS TAP VIABLE: ${String(summary.wsTapViable).toUpperCase()}

${summary.reason}

Reproduction steps:

1. Attach to the existing Coinbase advanced page target over CDP.
2. Enable \`Network\` listeners before navigation for WebSocket, EventSource, REST/poll, and WebTransport events.
3. Navigate the same signed-in tab to \`/advanced-trade/spot/${cfg.symbol}\` and observe.
4. Enumerate Coinbase worker/shared-worker/service-worker targets and attach passive Network listeners.
5. Navigate the same tab to \`/advanced-portfolio\` and observe.

No Buy/Sell/Preview/Place controls were clicked. No Coinbase API client, SDK,
credentials, cookies, or independent Coinbase socket were used.

## WebSocket observations

${wsLines.length ? wsLines.join("\n") : "_No WebSocket frames or socket creation events were captured after early attach/navigation._"}

## SSE / EventSource

${summary.sseTargets.length ? summary.sseTargets.map(item => `- ${item.label} / ${item.target.type}: ${item.count} messages`).join("\n") : "_No EventSource messages captured._"}

## REST / polling candidates

${restLines.length ? restLines.join("\n") : "_No REST/poll candidates captured._"}

## WebTransport / QUIC

${summary.webTransportTargets.length ? JSON.stringify(summary.webTransportTargets, null, 2) : "_No WebTransport events captured._"}

## Data-quality consequence

Per Harris, rendered DOM depth is a lower-grade microstructure observation than
the exchange's sequenced feed. Per Kleppmann, gap detection requires a reliable
sequence. Per Lopez de Prado and Kahneman, downstream signals and Kelly sizing
must not treat low-quality samples as clean evidence. Therefore DOM fallback
events are labeled \`source:"dom"\`, \`hasSequence:false\`,
\`confidence:"low"\`, and derived Kelly output refuses degraded inputs.
`;
}

async function safeLocation(session) {
  try {
    return await session.evaluate("location.href");
  } catch {
    return "";
  }
}

async function waitForPortfolioRows(session) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await session.evaluate(`(() =>
      document.querySelector('[data-testid^="user-cash-table-body-row-"], [data-testid^="user-crypto-table-body-row-"]') !== null
    )()`).catch(() => false);
    if (ready) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
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
  const { session, tab, cfg, view } = await requireSignedInTab({ debugUrl, urlContains });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = outputRoot || path.join(process.cwd(), "recon", `${cfg.symbol.toLowerCase()}-${stamp}`);
  const shotsDir = path.join(dir, "screenshots");
  await fs.mkdir(shotsDir, { recursive: true });

  const originalUrl = tab.url;
  await session.command("Page.enable");

  const waitForAdvancedView = async label => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ready = await session.evaluate(`(() => {
        const text = document.body?.innerText || "";
        return ${JSON.stringify(label)} === "trade"
          ? /Order book/.test(text) && /BID \\(USD\\)/.test(text)
          : /Total balance/.test(text) && /Cash/.test(text);
      })()`).catch(() => false);
      if (ready) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  };

  const navigateAndWait = async (targetUrl, label) => {
    const loaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
    await session.command("Page.navigate", { url: targetUrl });
    await loaded;
    await waitForAdvancedView(label);
  };

  const captureView = async label => {
    const dom = await session.evaluate(domMapScript());
    try {
      const shot = await session.command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true });
      await fs.writeFile(path.join(shotsDir, `${label}.png`), Buffer.from(shot.data, "base64"));
      if (label === view) {
        await fs.writeFile(path.join(shotsDir, "full-page.png"), Buffer.from(shot.data, "base64"));
      }
    } catch { /* screenshot is best-effort */ }
    return dom;
  };

  // (A) Static DOM maps for both Advanced Portfolio and Advanced Trade views,
  // using same-tab navigation only. This may cause Coinbase's own page to open
  // its own market-data socket; we still never open a Coinbase socket from MCP.
  const domViews = {};
  domViews[view] = await captureView(view);
  if (!domViews.portfolio) {
    await navigateAndWait("https://www.coinbase.com/advanced-portfolio", "portfolio");
    domViews.portfolio = await captureView("portfolio");
  }
  if (!domViews.trade) {
    await navigateAndWait(`https://www.coinbase.com/advanced-trade/spot/${encodeURIComponent(cfg.symbol)}`, "trade");
    domViews.trade = await captureView("trade");
  }
  const domMap = {
    capturedAt: new Date().toISOString(),
    originalUrl,
    startView: view,
    activeNetworkView: "trade",
    views: domViews,
    ...(domViews.trade || domViews.portfolio)
  };
  await fs.writeFile(path.join(dir, "dom-map.json"), JSON.stringify(domMap, null, 2), "utf8");

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

  if ((await session.evaluate("location.href")) !== originalUrl) {
    await navigateAndWait(originalUrl, view).catch(() => {});
  }

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

// Behavioral probe: observation only. Earlier passes allowed harmless-looking
// side-toggle clicks, but Pass 2 forbids Buy/Sell/Preview/Place clicks outright.
async function runBehavioralProbe(session) {
  const observe = async () => session.evaluate(`(() => ({
    bookRows: document.querySelectorAll('[class*="OrderBook" i] *, [data-testid*="order-book"] *').length,
    activeTab: (document.querySelector('[role=tab][aria-selected="true"]')||{}).textContent || null,
    url: location.href
  }))()`);
  const before = await observe();
  const after = await observe();
  return { note: "Observation only; no Buy/Sell/Preview/Place controls clicked.", before, after };
}

// Build the human-readable RECON_REPORT.md. Each section cites the book that
// informed the observation lens (per Step 3 deliverable requirement).
function buildReconReport({ cfg, domMap, networkMap, behavioral, stamp }) {
  const wsUrls = networkMap.webSockets.map(w => w.url);
  const channels = [...new Set(networkMap.webSockets.flatMap(w => Object.keys(w.channels)))];
  const rest = Object.entries(networkMap.rest);
  const tradeMap = domMap.views?.trade || domMap;
  const portfolioMap = domMap.views?.portfolio || domMap;
  const panel = tradeMap.orderPanel || {};
  const fmtLoc = d => d?.found
    ? d.locators.map(l => `\`${l.selector}\` (${l.strategy}, stability ${l.stability})`).join("<br>")
    : "_not found in this capture_";

  return `# Coinbase Advanced Trade — Recon Report (${cfg.symbol})

_Captured: ${stamp}_  
_Views captured: start=${domMap.startView || "unknown"}, portfolio=${domMap.views?.portfolio ? "yes" : "no"}, trade=${domMap.views?.trade ? "yes" : "no"}_  
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

- Order-book container: ${tradeMap.orderBook?.container?.found ? "found" : "not found"}
- Bid side: ${tradeMap.orderBook?.bidSide?.found ? "found" : "not found"}; Ask side: ${tradeMap.orderBook?.askSide?.found ? "found" : "not found"}
- Mid/spread: ${tradeMap.orderBook?.spread?.found ? "found" : "not found"}
- Chart: ${tradeMap.chart?.found ? (tradeMap.chart.isIframe ? "iframe (likely TradingView)" : tradeMap.chart.isCanvas ? "canvas" : "container") : "not found"}${tradeMap.chart?.iframeSrc ? ` — src: ${tradeMap.chart.iframeSrc}` : ""}
- Recent trades tape: ${tradeMap.tradesTape?.found ? "found" : "not found"}

---

## 3. Portfolio / balances

> **Antonopoulos, _Mastering Bitcoin_, Ch. 4–5; Ammous, _The Bitcoin Standard_,
> Ch. 10.** "Available" vs "Holds" mirrors the unspent/locked distinction in
> coin custody. We read balances from the DOM only — never from an API and
> never by touching keys.

- Portfolio widget: ${portfolioMap.portfolio?.widget?.found ? "found" : "not found"}
- USD balance: ${portfolioMap.portfolio?.usdBalance?.found ? "found" : "not found"}; BTC balance: ${portfolioMap.portfolio?.btcBalance?.found ? "found" : "not found"}

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
    const money = s => { const m = (s||"").replace(/,/g,"").match(/\\$\\s*<?\\s*(-?\\d+(?:\\.\\d+)?)/); return m ? m[1] : null; };
    const rows = [...document.querySelectorAll('[data-testid^="user-cash-table-body-row-"], [data-testid^="user-crypto-table-body-row-"]')];
    const balances = rows.map(el => {
      const raw = txt(el);
      const asset = raw.match(/^([A-Z0-9]{2,10})\\b/)?.[1] || null;
      const dollars = [...raw.matchAll(/\\$\\s*<?\\s*(-?\\d+(?:\\.\\d+)?)/g)].map(m => m[1]);
      const amount = [...raw.matchAll(/\\b(\\d+\\.\\d{4,})\\b/g)].map(m => m[1]).at(-1) || null;
      return asset ? {
        asset,
        available: dollars[1] || dollars[0] || amount,
        hold: null,
        valueUsd: dollars[0] || null,
        amount,
        raw: raw.slice(0, 160),
        source: el.getAttribute("data-testid")
      } : null;
    }).filter(Boolean);
    // Fallback chain: try contractual hooks first, then class fragments, then
    // text scan. (Ranking matches dom-map stability ordering.)
    if (balances.length === 0) {
      const balEls = [
        ...document.querySelectorAll('[data-testid*="balance" i], [data-testid*="portfolio" i], [class*="Balance" i], [class*="Asset" i]')
      ];
      for (const el of balEls.slice(0, 60)) {
        const t = txt(el);
        const m = t.match(/\\b(USD|USDC|BTC|ETH|[A-Z]{3,5})\\b/);
        if (m && /\\d/.test(t)) {
          balances.push({ asset: m[1], available: num(t), hold: null, valueUsd: money(t), amount: null, raw: t.slice(0, 120), source: "fallback-scan" });
        }
      }
    }
    const orderEls = [...document.querySelectorAll('[data-testid*="open-order" i], [class*="OpenOrder" i], [aria-label*="open order" i]')];
    const openOrders = orderEls.slice(0, 40).map(el => ({ raw: txt(el).slice(0, 160) })).filter(o => o.raw);
    return { capturedAt: new Date().toISOString(), balances, openOrders, positions: balances.filter(b => b.amount).map(b => ({ asset: b.asset, amount: b.amount, valueUsd: b.valueUsd, availableUsd: b.available })) };
  })()`;
}

export async function portfolioSnapshot({ debugUrl, urlContains } = {}) {
  const { session, tab, view } = await requireSignedInTab({ debugUrl, urlContains });
  try {
    if (view !== "portfolio") {
      await session.command("Page.enable");
      const loaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
      await session.command("Page.navigate", { url: "https://www.coinbase.com/advanced-portfolio" });
      await loaded;
    }
    await waitForPortfolioRows(session);
    const snap = await session.evaluate(portfolioScript());
    return { ts: Date.now(), ...snap };
  } finally {
    if (view !== "portfolio") {
      const loaded = session.waitForEvent("Page.loadEventFired", 30_000).catch(() => null);
      await session.command("Page.navigate", { url: tab.url }).catch(() => {});
      await loaded;
    }
    session.close();
  }
}

export async function paperLedgerState() {
  return paperLedgerSnapshot();
}

export async function confirmLive({ phrase } = {}) {
  const confirmation = recordLiveConfirmation({ phrase });
  const cfg = loadConfig({ force: true });
  return {
    confirmed: false,
    armed: liveModeArmed(cfg),
    stubbed: true,
    confirmation,
    liveConfirmation: getLiveConfirmation(),
    reason: "Confirmation was recorded, but Pass 2 keeps LIVE submission disconnected."
  };
}

export function reconcilePreviewIntent({ intent = {}, preview = {} } = {}) {
  const fields = ["side", "type", "baseSize", "quoteSize", "limitPrice", "timeInForce", "symbol"];
  const diffs = [];
  for (const field of fields) {
    const intended = intent[field] ?? null;
    const shown = preview[field] ?? null;
    const intendedDec = ["baseSize", "quoteSize", "limitPrice"].includes(field) ? dec(intended) : null;
    const shownDec = ["baseSize", "quoteSize", "limitPrice"].includes(field) ? dec(shown) : null;
    const equal = intendedDec && shownDec ? intendedDec.eq(shownDec) : String(intended ?? "") === String(shown ?? "");
    if (!equal) diffs.push({ field, intended: intended === null ? null : String(intended), preview: shown === null ? null : String(shown) });
  }
  return {
    ok: diffs.length === 0,
    diffs,
    note: "Pure preview-vs-intent reconciliation only; no DOM interaction, no Preview Order click."
  };
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
  if (cfg.mode === "LIVE") {
    return reject(liveModeArmed(cfg)
      ? "LIVE mode arming is stubbed and the real submission path remains disconnected."
      : "LIVE mode is not armed; confirmation is stubbed and no real submission path is connected.");
  }

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
    timeInForce, mode: cfg.mode,
    source: lastTick?.source ?? null,
    ageMs: lastTick?.ageMs ?? 0,
    hasSequence: lastTick?.hasSequence === true,
    confidence: lastTick?.confidence ?? "low",
    degraded: lastTick?.degraded !== false,
    degradedReason: lastTick?.degradedReason ?? "fill priced from unverified market source"
  };
  ring.push(fill);
  journal.append(fill);
  applySimulatedFill(fill);

  return {
    accepted: true, dryRun, mode: cfg.mode, simulatedFill: serializeEvent(fill),
    paperLedger: paperLedgerSnapshot(),
    journalPath: journal.path()
  };
}
