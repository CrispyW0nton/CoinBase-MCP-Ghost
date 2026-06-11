import { dec, Decimal } from "./schema.js";

export const SOURCES = Object.freeze({ WS: "ws", SSE: "sse", POLL: "poll", DOM: "dom", UNKNOWN: "unknown" });

export function decimalMapSet(map, px, sz) {
  if (!px || !sz) return;
  const qty = dec(sz);
  const price = dec(px);
  if (!qty || !price) return;
  const key = price.toString();
  if (qty.isZero()) map.delete(key);
  else map.set(key, qty);
}

export function confidenceFor({ source, hasSequence }) {
  return source === SOURCES.WS && hasSequence === true ? "high" : "low";
}

export function degradedReasonFor({ source, hasSequence }) {
  if (source !== SOURCES.WS) return `${source} source is not exchange-sequenced`;
  if (hasSequence !== true) return "missing sequence_num";
  return null;
}

export class OrderBookImbalanceSignal {
  constructor({ levels = 10 } = {}) {
    this.levels = levels;
    this.bid = new Map();
    this.ask = new Map();
    this.lastSignal = null;
  }

  updateL2(evt) {
    if (!evt || !["bid", "ask"].includes(evt.side)) return;
    decimalMapSet(this[evt.side], evt.px, evt.sz);
  }

  depth(side, levels = this.levels) {
    const entries = [...this[side].entries()].map(([px, sz]) => ({ px: dec(px), sz }));
    entries.sort((a, b) => side === "bid" ? b.px.comparedTo(a.px) : a.px.comparedTo(b.px));
    return entries.slice(0, levels).reduce((sum, level) => sum.plus(level.sz), new Decimal(0));
  }

  top(side) {
    const entries = [...this[side].entries()].map(([px, sz]) => ({ px: dec(px), sz }));
    entries.sort((a, b) => side === "bid" ? b.px.comparedTo(a.px) : a.px.comparedTo(b.px));
    return entries[0] ?? null;
  }

  mid() {
    const bid = this.top("bid");
    const ask = this.top("ask");
    if (!bid || !ask) return null;
    return bid.px.plus(ask.px).div(2);
  }

  createSignal({ ts, symbol, seq, source = SOURCES.WS, ageMs = 0, hasSequence = seq !== null } = {}) {
    const bidDepth = this.depth("bid");
    const askDepth = this.depth("ask");
    const total = bidDepth.plus(askDepth);
    if (total.isZero()) return null;
    const resolvedSource = source ?? SOURCES.UNKNOWN;
    const resolvedHasSequence = hasSequence === true;
    const confidence = confidenceFor({ source: resolvedSource, hasSequence: resolvedHasSequence });
    const signal = {
      type: "imbalanceSignal",
      ts: ts ?? Date.now(),
      symbol,
      name: "l2_depth_imbalance",
      value: bidDepth.minus(askDepth).div(total),
      bidDepth,
      askDepth,
      levels: this.levels,
      seq: seq ?? null,
      source: resolvedSource,
      ageMs,
      hasSequence: resolvedHasSequence,
      confidence,
      degraded: confidence !== "high",
      degradedReason: degradedReasonFor({ source: resolvedSource, hasSequence: resolvedHasSequence })
    };
    this.lastSignal = signal;
    return signal;
  }
}
