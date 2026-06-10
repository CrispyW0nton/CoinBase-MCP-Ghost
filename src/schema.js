// src/schema.js
// ---------------------------------------------------------------------------
// Unified internal market-data schema for the Coinbase MCP Ghost.
//
// DESIGN DECISION — prices/sizes are Decimal (decimal.js), never JS Number.
//   Harris, "Trading and Exchanges" (Ch. 4 "Orders and Order Properties" and
//   the discussion of price granularity / minimum price variation): exchange
//   prices live on a discrete tick grid. IEEE-754 binary floats cannot
//   represent decimal tick sizes (e.g. 0.01) exactly, so naive Number math
//   silently corrupts spreads and P&L. We therefore keep every monetary value
//   as a decimal.js Decimal internally and serialize as a *string* on the
//   wire / in the journal. López de Prado ("Advances in Financial Machine
//   Learning", Ch. 2 on financial data structures) makes the same point: the
//   integrity of the raw series determines the validity of everything built on
//   top of it. Garbage decimals in => garbage signals out.
// ---------------------------------------------------------------------------

import Decimal from "decimal.js";

// Coerce any incoming numeric-ish value to a Decimal, tolerating strings,
// numbers, and nullish. Returns null for unparseable input so callers can
// decide whether a missing field is fatal.
export function dec(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return new Decimal(value);
  } catch {
    return null;
  }
}

// Serialize a Decimal (or null) to a string for transport/journaling.
function ser(value) {
  return value === null || value === undefined ? null : value.toString();
}

function provenance({ source = "ws", ageMs = 0, hasSequence = false, confidence, degradedReason } = {}) {
  const degraded = source !== "ws" || hasSequence !== true;
  return {
    source,
    ageMs: ageMs ?? 0,
    hasSequence: Boolean(hasSequence),
    confidence: confidence ?? (degraded ? "low" : "high"),
    degraded,
    degradedReason: degradedReason ?? (degraded ? "unsequenced data source" : null)
  };
}

export function makeTick({ ts, symbol, bidPx, bidSz, askPx, askSz, lastPx, lastSz, source, ageMs, hasSequence, confidence, degradedReason }) {
  return {
    type: "tick",
    ts: ts ?? Date.now(),
    symbol,
    bidPx: dec(bidPx),
    bidSz: dec(bidSz),
    askPx: dec(askPx),
    askSz: dec(askSz),
    lastPx: dec(lastPx),
    lastSz: dec(lastSz),
    ...provenance({ source, ageMs, hasSequence, confidence, degradedReason })
  };
}

export function makeL2Update({ ts, symbol, side, px, sz, isSnapshot = false, seq = null, source, ageMs, hasSequence, confidence, degradedReason }) {
  return {
    type: "l2update",
    ts: ts ?? Date.now(),
    symbol,
    side, // "bid" | "ask"
    px: dec(px),
    sz: dec(sz),
    isSnapshot: Boolean(isSnapshot),
    seq,
    ...provenance({ source, ageMs, hasSequence: hasSequence ?? seq !== null, confidence, degradedReason })
  };
}

export function makeTrade({ ts, symbol, side, px, sz, tradeId, source, ageMs, hasSequence, confidence, degradedReason }) {
  return {
    type: "trade",
    ts: ts ?? Date.now(),
    symbol,
    side, // "buy" | "sell" (aggressor side)
    px: dec(px),
    sz: dec(sz),
    tradeId: tradeId ?? null,
    ...provenance({ source, ageMs, hasSequence, confidence, degradedReason })
  };
}

export function makeCandle({ ts, symbol, granularitySec, o, h, l, c, v, source, ageMs, hasSequence, confidence, degradedReason }) {
  return {
    type: "candle",
    ts: ts ?? Date.now(),
    symbol,
    granularitySec: granularitySec ?? null,
    o: dec(o),
    h: dec(h),
    l: dec(l),
    c: dec(c),
    v: dec(v),
    ...provenance({ source, ageMs, hasSequence, confidence, degradedReason })
  };
}

export function makeGap({ ts, symbol, expectedSeq, gotSeq, channel, source = "ws" }) {
  return {
    type: "gap",
    ts: ts ?? Date.now(),
    symbol,
    expectedSeq,
    gotSeq,
    channel: channel ?? null,
    ...provenance({ source, hasSequence: true, confidence: "high" })
  };
}

// Convert any schema event (with Decimal fields) into a plain JSON-safe object
// where Decimals become strings. Used for the JSONL journal and tool output.
export function serializeEvent(evt) {
  const out = { type: evt.type, ts: evt.ts, symbol: evt.symbol };
  out.source = evt.source ?? null;
  out.ageMs = evt.ageMs ?? null;
  out.hasSequence = evt.hasSequence ?? null;
  out.confidence = evt.confidence ?? null;
  out.degraded = evt.degraded ?? null;
  out.degradedReason = evt.degradedReason ?? null;
  switch (evt.type) {
    case "tick":
      out.bidPx = ser(evt.bidPx);
      out.bidSz = ser(evt.bidSz);
      out.askPx = ser(evt.askPx);
      out.askSz = ser(evt.askSz);
      out.lastPx = ser(evt.lastPx);
      out.lastSz = ser(evt.lastSz);
      break;
    case "l2update":
      out.side = evt.side;
      out.px = ser(evt.px);
      out.sz = ser(evt.sz);
      out.isSnapshot = evt.isSnapshot;
      out.seq = evt.seq;
      break;
    case "trade":
      out.side = evt.side;
      out.px = ser(evt.px);
      out.sz = ser(evt.sz);
      out.tradeId = evt.tradeId;
      break;
    case "candle":
      out.granularitySec = evt.granularitySec;
      out.o = ser(evt.o);
      out.h = ser(evt.h);
      out.l = ser(evt.l);
      out.c = ser(evt.c);
      out.v = ser(evt.v);
      break;
    case "gap":
      out.expectedSeq = evt.expectedSeq;
      out.gotSeq = evt.gotSeq;
      out.channel = evt.channel;
      break;
    case "imbalanceSignal":
      out.name = evt.name;
      out.value = ser(evt.value);
      out.bidDepth = ser(evt.bidDepth);
      out.askDepth = ser(evt.askDepth);
      out.levels = evt.levels;
      out.seq = evt.seq;
      break;
    case "simulatedFill":
      // produced by the execution scaffold (src/coinbase.js)
      return { ...evt };
    default:
      return { ...evt };
  }
  return out;
}

export { Decimal };
