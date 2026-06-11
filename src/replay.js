// src/replay.js
// ---------------------------------------------------------------------------
// Offline, deterministic replay/backtest over append-only journal JSONL.
//
// This file deliberately has no Chrome/CDP/Coinbase network dependency. It
// reuses the live OrderBookImbalanceSignal path causally: event t updates only
// state available at t, then any forward return is attached after the pass for
// measurement. Grinold-Kahn motivates IC/breadth; Lopez de Prado motivates
// chronological test splits, walk-forward discipline, and deflated Sharpe;
// Kahneman and Taleb are the guardrails against over-reading small, fat-tailed
// samples.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dec, Decimal, serializeEvent } from "./schema.js";
import { OrderBookImbalanceSignal, SOURCES } from "./signal.js";

const DEFAULT_SYMBOL = "BTC-USD";
export const MIN_EFFECTIVE_BREADTH = 2000;
export const MIN_TEST_OBSERVATIONS = 600;
export const MIN_PAIRED_OBSERVATIONS = 2000;
const VALID_SOURCES = new Set(["ws", "sse", "poll", "dom"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

function toIso(ts) {
  if (ts === null || ts === undefined) return null;
  const ms = normalizeTimestamp(ts);
  return ms === null ? null : new Date(ms).toISOString();
}

function normalizeTimestamp(ts) {
  if (ts === null || ts === undefined || ts === "") return null;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string" && /^\d+(?:\.\d+)?$/.test(ts)) {
    const n = Number(ts);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateRangeMs({ startDate, endDate } = {}) {
  const start = startDate ? Date.parse(startDate) : null;
  let end = endDate ? Date.parse(endDate) : null;
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) end += 86_399_999;
  return {
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null
  };
}

async function walkJsonl(dir) {
  if (!fsSync.existsSync(dir)) return [];
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkJsonl(p));
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}

function provenance(raw) {
  const sourceRaw = raw.source ?? raw.provenance?.source;
  const ageRaw = raw.ageMs ?? raw.provenance?.ageMs;
  const hasSequenceRaw = raw.hasSequence ?? raw.provenance?.hasSequence;
  const confidenceRaw = raw.confidence ?? raw.provenance?.confidence;
  const degradedRaw = raw.degraded ?? raw.provenance?.degraded;
  const source = VALID_SOURCES.has(sourceRaw) ? sourceRaw : SOURCES.UNKNOWN;
  const hasSequence = typeof hasSequenceRaw === "boolean"
    ? hasSequenceRaw
    : (raw.seq !== null && raw.seq !== undefined);
  const confidence = VALID_CONFIDENCE.has(confidenceRaw)
    ? confidenceRaw
    : (source === SOURCES.WS && hasSequence ? "high" : "low");
  const degraded = typeof degradedRaw === "boolean" ? degradedRaw : (confidence !== "high");
  const missing = [];
  if (!VALID_SOURCES.has(sourceRaw)) missing.push("source");
  if (!Number.isFinite(Number(ageRaw))) missing.push("ageMs");
  if (typeof hasSequenceRaw !== "boolean") missing.push("hasSequence");
  if (!VALID_CONFIDENCE.has(confidenceRaw)) missing.push("confidence");
  if (typeof degradedRaw !== "boolean") missing.push("degraded");
  if (degraded === true && !(raw.degradedReason ?? raw.provenance?.degradedReason)) missing.push("degradedReason");
  return {
    source,
    ageMs: Number.isFinite(Number(ageRaw)) ? Number(ageRaw) : null,
    hasSequence,
    confidence,
    degraded,
    degradedReason: raw.degradedReason ?? raw.provenance?.degradedReason ?? (degraded ? `${source} source is not exchange-sequenced or lacks provenance` : null),
    provenanceComplete: missing.length === 0,
    missingProvenanceFields: missing
  };
}

function normalizeEvent(raw, order) {
  if (!raw || typeof raw !== "object") return null;
  const ts = normalizeTimestamp(raw.ts ?? raw.timestamp ?? raw.time);
  if (ts === null) return null;
  const base = {
    ...raw,
    ts,
    symbol: raw.symbol ?? DEFAULT_SYMBOL,
    _order: order,
    ...provenance(raw)
  };
  if (base.type === "l2update") {
    return {
      ...base,
      side: raw.side === "offer" ? "ask" : raw.side,
      px: dec(raw.px ?? raw.price),
      sz: dec(raw.sz ?? raw.size),
      isSnapshot: Boolean(raw.isSnapshot),
      seq: raw.seq ?? null
    };
  }
  if (base.type === "tick") {
    return {
      ...base,
      bidPx: dec(raw.bidPx),
      bidSz: dec(raw.bidSz),
      askPx: dec(raw.askPx),
      askSz: dec(raw.askSz),
      lastPx: dec(raw.lastPx),
      lastSz: dec(raw.lastSz)
    };
  }
  if (base.type === "trade") {
    return { ...base, px: dec(raw.px), sz: dec(raw.sz) };
  }
  return base;
}

export async function loadJournalEvents({
  symbol = DEFAULT_SYMBOL,
  journalDir = "journal",
  files,
  startDate,
  endDate
} = {}) {
  const root = process.cwd();
  const selectedFiles = files?.length
    ? files.map(f => path.resolve(root, f))
    : await walkJsonl(path.resolve(root, journalDir, symbol));
  const { start, end } = dateRangeMs({ startDate, endDate });
  const events = [];
  let order = 0;
  const inventory = emptyInventory();

  for (const file of selectedFiles.sort()) {
    const rel = path.relative(root, file);
    const perFile = emptyFileInventory(rel);
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        perFile.invalid++;
        inventory.invalid++;
        continue;
      }
      const evt = normalizeEvent(raw, order++);
      if (!evt) {
        perFile.invalid++;
        inventory.invalid++;
        continue;
      }
      if (evt.symbol !== symbol) continue;
      if (start !== null && evt.ts < start) continue;
      if (end !== null && evt.ts > end) continue;
      events.push(evt);
      addInventory(perFile, evt);
      addInventory(inventory, evt);
    }
    inventory.files.push(perFile);
  }

  events.sort((a, b) => a.ts - b.ts || a._order - b._order);
  finalizeInventory(inventory);
  for (const file of inventory.files) finalizeInventory(file);
  return { events, inventory };
}

function emptyInventory() {
  return {
    files: [],
    events: 0,
    invalid: 0,
    byType: {},
    bySource: {},
    byConfidence: {},
    degraded: { true: 0, false: 0 },
    minTs: null,
    maxTs: null,
    pctDom: 0,
    pctDegraded: 0,
    pctCleanProvenance: 0,
    missingProvenance: 0,
    legacyUnusable: 0
  };
}

function emptyFileInventory(file) {
  return {
    file,
    events: 0,
    invalid: 0,
    byType: {},
    bySource: {},
    byConfidence: {},
    degraded: { true: 0, false: 0 },
    minTs: null,
    maxTs: null,
    pctCleanProvenance: 0,
    missingProvenance: 0,
    legacyUnusable: 0
  };
}

function addInventory(inv, evt) {
  inv.events++;
  inv.byType[evt.type] = (inv.byType[evt.type] || 0) + 1;
  inv.bySource[evt.source] = (inv.bySource[evt.source] || 0) + 1;
  inv.byConfidence[evt.confidence] = (inv.byConfidence[evt.confidence] || 0) + 1;
  inv.degraded[evt.degraded === true ? "true" : "false"]++;
  if (evt.provenanceComplete !== true) inv.missingProvenance++;
  if (evt.source === SOURCES.UNKNOWN || evt.provenanceComplete !== true) inv.legacyUnusable++;
  inv.minTs = inv.minTs === null || evt.ts < inv.minTs ? evt.ts : inv.minTs;
  inv.maxTs = inv.maxTs === null || evt.ts > inv.maxTs ? evt.ts : inv.maxTs;
}

function finalizeInventory(inv) {
  inv.minTsIso = toIso(inv.minTs);
  inv.maxTsIso = toIso(inv.maxTs);
  inv.pctDom = inv.events ? pct(inv.bySource.dom || 0, inv.events) : 0;
  inv.pctDegraded = inv.events ? pct(inv.degraded.true || 0, inv.events) : 0;
  inv.pctCleanProvenance = inv.events ? pct(inv.events - inv.missingProvenance, inv.events) : 0;
  inv.dataQualityCeiling = dataQualityCeiling(inv);
}

function dataQualityCeiling(inv) {
  const low = inv.byConfidence.low || 0;
  const unknown = inv.bySource.unknown || 0;
  const degraded = inv.degraded.true || 0;
  if (inv.events === 0) return "no usable journal events";
  if (unknown + inv.missingProvenance > 0) return "missing-provenance legacy data";
  if (low + degraded > 0) return "low-confidence / DOM-sourced";
  return "sequenced/high-confidence";
}

function pct(part, total) {
  return Number(((part / total) * 100).toFixed(2));
}

function serializeObservation(obs) {
  return {
    ts: obs.ts,
    tsIso: toIso(obs.ts),
    symbol: obs.symbol,
    signal: obs.signal.toString(),
    bidDepth: obs.bidDepth.toString(),
    askDepth: obs.askDepth.toString(),
    mid: obs.mid ? obs.mid.toString() : null,
    forwardTs: obs.forwardTs,
    forwardTsIso: toIso(obs.forwardTs),
    forwardReturn: obs.forwardReturn ? obs.forwardReturn.toString() : null,
    source: obs.source,
    ageMs: obs.ageMs,
    hasSequence: obs.hasSequence,
    confidence: obs.confidence,
    degraded: obs.degraded,
    degradedReason: obs.degradedReason
  };
}

export function replayEvents(events, {
  symbol = DEFAULT_SYMBOL,
  horizonSeconds = null,
  horizonObservations = 1,
  depthLevels = 10,
  trainFraction = 0.7,
  trials = 1
} = {}) {
  const engine = new OrderBookImbalanceSignal({ levels: depthLevels });
  const ordered = events
    .filter(evt => !symbol || evt.symbol === symbol)
    .slice()
    .sort((a, b) => a.ts - b.ts || (a._order ?? 0) - (b._order ?? 0));
  const priceSeries = [];
  const observations = [];

  for (const evt of ordered) {
    let mid = null;
    if (evt.type === "l2update") {
      engine.updateL2(evt);
      mid = engine.mid();
      if (mid) priceSeries.push({ ts: evt.ts, mid, order: evt._order ?? priceSeries.length });
      const signal = engine.createSignal({
        ts: evt.ts,
        symbol: evt.symbol,
        seq: evt.seq,
        source: evt.source,
        ageMs: evt.ageMs,
        hasSequence: evt.hasSequence
      });
      if (signal) {
        observations.push({
          ts: signal.ts,
          symbol: signal.symbol,
          signal: signal.value,
          bidDepth: signal.bidDepth,
          askDepth: signal.askDepth,
          mid,
          priceIndex: priceSeries.length - 1,
          source: signal.source,
          ageMs: signal.ageMs,
          hasSequence: signal.hasSequence,
          confidence: signal.confidence,
          degraded: signal.degraded,
          degradedReason: signal.degradedReason
        });
      }
    } else if (evt.type === "tick") {
      mid = tickMid(evt);
      if (mid) priceSeries.push({ ts: evt.ts, mid, order: evt._order ?? priceSeries.length });
    } else if (evt.type === "trade" && evt.px) {
      priceSeries.push({ ts: evt.ts, mid: evt.px, order: evt._order ?? priceSeries.length });
    }
  }

  attachForwardReturns(observations, priceSeries, { horizonSeconds, horizonObservations });
  const paired = observations.filter(obs => obs.mid && obs.forwardReturn);
  const metrics = computeMetrics(paired, { trainFraction, trials });
  return {
    symbol,
    params: { horizonSeconds, horizonObservations, depthLevels, trainFraction, trials },
    eventCount: ordered.length,
    priceObservations: priceSeries.length,
    signalObservations: observations.length,
    pairedObservations: paired.length,
    observations: observations.map(serializeObservation),
    metrics
  };
}

function suppressedMetricSet(observations) {
  return {
    observations,
    ic: null,
    standardError: null,
    tStat: null,
    breadth: null,
    lag1Autocorr: null,
    autocorrelationFlag: null,
    strategySharpePerObservation: null,
    skewness: null,
    kurtosis: null,
    deflatedSharpe: null,
    probabilityFalsePositive: null,
    parameterTrials: null,
    suppressed: true
  };
}

function tickMid(evt) {
  if (evt.bidPx && evt.askPx) return evt.bidPx.plus(evt.askPx).div(2);
  return evt.lastPx ?? evt.bidPx ?? evt.askPx ?? null;
}

function attachForwardReturns(observations, priceSeries, { horizonSeconds, horizonObservations }) {
  for (const obs of observations) {
    if (!obs.mid || obs.priceIndex < 0) continue;
    let target = null;
    if (horizonSeconds !== null && horizonSeconds !== undefined) {
      const targetTs = obs.ts + Number(horizonSeconds) * 1000;
      target = priceSeries.find((item, idx) => idx > obs.priceIndex && item.ts >= targetTs) ?? null;
    } else if (horizonObservations !== null && horizonObservations !== undefined) {
      target = priceSeries[obs.priceIndex + Number(horizonObservations)] ?? null;
    }
    if (!target || obs.mid.isZero()) continue;
    obs.forwardTs = target.ts;
    obs.forwardReturn = target.mid.minus(obs.mid).div(obs.mid);
  }
}

function computeMetrics(paired, { trainFraction, trials }) {
  const rows = paired.map(obs => ({
    signal: Number(obs.signal.toString()),
    forwardReturn: Number(obs.forwardReturn.toString()),
    strategyReturn: Number(obs.signal.gte(0) ? obs.forwardReturn.toString() : obs.forwardReturn.negated().toString())
  })).filter(row => Number.isFinite(row.signal) && Number.isFinite(row.forwardReturn));
  const split = Math.max(0, Math.min(rows.length, Math.floor(rows.length * trainFraction)));
  const all = metricSet(rows, trials);
  const train = metricSet(rows.slice(0, split), trials);
  const test = metricSet(rows.slice(split), trials);
  return {
    units: "IC, Sharpe, t-stat, skew, kurtosis, and p(false positive) use float aggregates; prices/returns were Decimal until aggregation.",
    all,
    train,
    test,
    splitIndex: split,
    verdict: verdict({ total: all, test, rows, trials })
  };
}

function metricSet(rows, trials) {
  const n = rows.length;
  const signals = rows.map(r => r.signal);
  const returns = rows.map(r => r.forwardReturn);
  const strategy = rows.map(r => r.strategyReturn);
  const ic = spearman(signals, returns);
  const se = n > 2 && Number.isFinite(ic) ? Math.sqrt(Math.max(0, (1 - ic * ic) / (n - 2))) : null;
  const tStat = se && se > 0 ? ic / se : null;
  const lag1 = autocorr(strategy, 1);
  const effectiveBreadth = n > 2 && lag1 > 0 ? Math.max(1, Math.min(n, n * ((1 - lag1) / (1 + lag1)))) : n;
  const sr = sharpe(strategy);
  const skewness = skew(strategy);
  const kurt = kurtosis(strategy);
  const deflated = deflateSharpe({ sharpe: sr, skewness, kurtosis: kurt, trials });
  return {
    observations: n,
    ic: finiteOrNull(ic),
    standardError: finiteOrNull(se),
    tStat: finiteOrNull(tStat),
    breadth: finiteOrNull(effectiveBreadth),
    lag1Autocorr: finiteOrNull(lag1),
    autocorrelationFlag: n > 2 && Math.abs(lag1) > 0.2,
    strategySharpePerObservation: finiteOrNull(sr),
    skewness: finiteOrNull(skewness),
    kurtosis: finiteOrNull(kurt),
    deflatedSharpe: finiteOrNull(deflated.deflatedSharpe),
    probabilityFalsePositive: finiteOrNull(deflated.probabilityFalsePositive),
    parameterTrials: trials
  };
}

function verdict({ total, test, rows }) {
  if (rows.length < MIN_PAIRED_OBSERVATIONS || test.observations < MIN_TEST_OBSERVATIONS) {
    return {
      label: "Inconclusive - insufficient data",
      reason: `Need at least ${MIN_PAIRED_OBSERVATIONS} paired observations with ${MIN_TEST_OBSERVATIONS} out-of-sample; got ${rows.length} paired and ${test.observations} test.`
    };
  }
  if (!Number.isFinite(test.tStat) || Math.abs(test.tStat) < 2) {
    return {
      label: "No edge",
      reason: "Out-of-sample IC t-stat does not clear a basic |t| >= 2 threshold."
    };
  }
  if (test.ic > 0 && test.tStat >= 2 && test.probabilityFalsePositive <= 0.05) {
    return {
      label: "Edge detected (out-of-sample)",
      reason: "Out-of-sample IC is positive, statistically distinguishable in this sample, and deflated Sharpe false-positive probability is <= 5%."
    };
  }
  if (total.ic !== null && test.ic !== null && Math.sign(total.ic) !== Math.sign(test.ic)) {
    return {
      label: "No edge",
      reason: "In-sample and out-of-sample IC disagree in sign."
    };
  }
  return {
    label: "Inconclusive - weak out-of-sample evidence",
    reason: "Out-of-sample signal is not strong enough after deflated-Sharpe and multiple-testing controls."
  };
}

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const out = Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) out[sorted[k].index] = rank;
    i = j;
  }
  return out;
}

function spearman(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  return pearson(ranks(a), ranks(b));
}

function pearson(a, b) {
  const n = a.length;
  if (n < 2) return null;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

function mean(values) {
  return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const v = values.reduce((sum, x) => sum + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

function sharpe(values) {
  const s = std(values);
  if (!s || s === 0) return null;
  return mean(values) / s * Math.sqrt(values.length);
}

function skew(values) {
  if (values.length < 3) return null;
  const m = mean(values);
  const s = std(values);
  if (!s) return 0;
  return mean(values.map(x => ((x - m) / s) ** 3));
}

function kurtosis(values) {
  if (values.length < 4) return null;
  const m = mean(values);
  const s = std(values);
  if (!s) return 0;
  return mean(values.map(x => ((x - m) / s) ** 4));
}

function autocorr(values, lag) {
  if (values.length <= lag + 1) return 0;
  return pearson(values.slice(0, -lag), values.slice(lag)) ?? 0;
}

function deflateSharpe({ sharpe, skewness, kurtosis, trials }) {
  if (!Number.isFinite(sharpe)) return { deflatedSharpe: null, probabilityFalsePositive: null };
  const trialPenalty = trials > 1 ? Math.sqrt(2 * Math.log(trials)) : 0;
  const nonNormalPenalty = Math.max(0, Math.abs(skewness ?? 0) * 0.1 + Math.max(0, (kurtosis ?? 3) - 3) * 0.05);
  const hurdle = trialPenalty + nonNormalPenalty;
  return {
    deflatedSharpe: sharpe - hurdle,
    probabilityFalsePositive: normalCdf(hurdle - sharpe)
  };
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

export async function replayBacktest(args = {}) {
  const {
    symbol = DEFAULT_SYMBOL,
    outputDir = "research",
    writeReport = true
  } = args;
  const { events, inventory } = await loadJournalEvents(args);
  const replay = replayEvents(events, args);
  const readiness = readinessFromReplay({ inventory, replay });
  applyInventoryVerdict(replay.metrics, inventory, readiness);
  const result = {
    generatedAt: new Date().toISOString(),
    symbol,
    inventory,
    readiness,
    ...replay
  };
  if (writeReport !== false) {
    result.reportPath = await writeIcReport(result, { outputDir });
  }
  return result;
}

export async function datasetStatus(args = {}) {
  const { symbol = DEFAULT_SYMBOL } = args;
  const { events, inventory } = await loadJournalEvents(args);
  const replay = replayEvents(events, args);
  const readiness = readinessFromReplay({ inventory, replay });
  return {
    generatedAt: new Date().toISOString(),
    symbol,
    inventory,
    pairedObservations: replay.pairedObservations,
    signalObservations: replay.signalObservations,
    priceObservations: replay.priceObservations,
    readiness
  };
}

function readinessFromReplay({ inventory, replay }) {
  const all = replay.metrics.all;
  const test = replay.metrics.test;
  const effectiveBreadth = all.breadth ?? 0;
  const paired = replay.pairedObservations;
  const unknown = inventory.bySource.unknown || 0;
  const provenanceReady = inventory.missingProvenance === 0 && unknown === 0;
  const quantityReady = paired >= MIN_PAIRED_OBSERVATIONS &&
    effectiveBreadth >= MIN_EFFECTIVE_BREADTH &&
    test.observations >= MIN_TEST_OBSERVATIONS;
  const reasons = [];
  if (paired < MIN_PAIRED_OBSERVATIONS) reasons.push(`paired observations ${paired} < ${MIN_PAIRED_OBSERVATIONS}`);
  if (effectiveBreadth < MIN_EFFECTIVE_BREADTH) reasons.push(`effective breadth ${effectiveBreadth} < ${MIN_EFFECTIVE_BREADTH}`);
  if (test.observations < MIN_TEST_OBSERVATIONS) reasons.push(`test observations ${test.observations} < ${MIN_TEST_OBSERVATIONS}`);
  if (!provenanceReady) reasons.push(`legacy/missing-provenance events ${inventory.legacyUnusable || inventory.missingProvenance || unknown} > 0`);
  return {
    verdict: quantityReady && provenanceReady ? "READY" : "NOT-READY",
    readyForIc: quantityReady && provenanceReady,
    readyForTradableClaim: quantityReady && provenanceReady && inventory.dataQualityCeiling === "sequenced/high-confidence",
    quantityReady,
    provenanceReady,
    quality: inventory.dataQualityCeiling,
    pairedObservations: paired,
    testObservations: test.observations,
    effectiveBreadth,
    minPairedObservations: MIN_PAIRED_OBSERVATIONS,
    minEffectiveBreadth: MIN_EFFECTIVE_BREADTH,
    minTestObservations: MIN_TEST_OBSERVATIONS,
    pctCleanProvenance: inventory.pctCleanProvenance,
    reasons
  };
}

function applyInventoryVerdict(metrics, inventory, readiness) {
  if (!readiness.readyForIc) {
    metrics.all = suppressedMetricSet(metrics.all.observations);
    metrics.train = suppressedMetricSet(metrics.train.observations);
    metrics.test = suppressedMetricSet(metrics.test.observations);
    metrics.verdict = {
      label: "Refused - insufficient data, record more",
      reason: `Backtest IC verdict withheld. Dataset is ${readiness.verdict}: ${readiness.reasons.join("; ")}.`
    };
    return;
  }
  if (inventory.dataQualityCeiling !== "sequenced/high-confidence") {
    metrics.verdict = {
      label: "Inconclusive - low-confidence data",
      reason: `Journal data quality ceiling is ${inventory.dataQualityCeiling}; more DOM data raises n but does not upgrade the source to WS quality.`
    };
  }
}

export async function writeIcReport(result, { outputDir = "research" } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `IC_REPORT_${stamp}.md`);
  await fs.writeFile(reportPath, buildReport(result), "utf8");
  return reportPath;
}

function buildReport(result) {
  const inv = result.inventory;
  const m = result.metrics;
  const files = inv.files.length
    ? inv.files.map(f => `- \`${f.file}\`: ${f.events} events, range ${f.minTsIso ?? "unknown"} to ${f.maxTsIso ?? "unknown"}, sources ${json(f.bySource)}, degraded ${pct(f.degraded.true || 0, f.events)}%`).join("\n")
    : "- No journal JSONL files found for this symbol/date filter.";
  return `# IC Report - ${result.symbol}

Generated: ${result.generatedAt}

## Data Inventory

Data-quality ceiling: **${inv.dataQualityCeiling}**. Any edge measured on source:"dom", degraded, or missing-provenance events is **low-confidence / DOM-sourced** and must not be treated as WS-quality.

${files}

- Total events: ${inv.events}
- Date range: ${inv.minTsIso ?? "unknown"} to ${inv.maxTsIso ?? "unknown"}
- Event types: ${json(inv.byType)}
- Sources: ${json(inv.bySource)} (${inv.pctDom}% explicit DOM)
- Confidence: ${json(inv.byConfidence)}
- Degraded: ${inv.pctDegraded}%
- Clean provenance: ${inv.pctCleanProvenance}%
- Legacy/unusable rows: ${inv.legacyUnusable}
- Replay signal observations: ${result.signalObservations}
- Paired signal/forward-return observations: ${result.pairedObservations}
- Dataset readiness: ${result.readiness?.verdict ?? "unknown"} (${(result.readiness?.reasons ?? []).join("; ") || "thresholds satisfied"})

## Method

The replay engine sorts JSONL events by timestamp plus original file order and feeds L2 events through the same Decimal order-book imbalance signal module used by the live stream. Signals are causal: event t can only use book state from events at or before t. Forward returns are attached after the pass from recorded mid/price observations over the configured horizon.

Parameters: \`${json(result.params)}\`

Statistical note: returns remain Decimal until aggregation; IC, t-stat, Sharpe, skew, kurtosis, and p(false positive) are float aggregates.

## Results

| Split | Obs | IC (Spearman) | SE | t-stat | Breadth | Lag1 autocorr | Sharpe | Deflated Sharpe | P(false positive) | Trials |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All | ${row(m.all)} |
| Train | ${row(m.train)} |
| Test | ${row(m.test)} |

Autocorrelation flag: all=${m.all.autocorrelationFlag}, train=${m.train.autocorrelationFlag}, test=${m.test.autocorrelationFlag}. Grinold-Kahn's IR ~= IC * sqrt(breadth) only applies when breadth is genuinely independent; this sample is flagged when lag-1 autocorrelation is material.

## Verdict

**${m.verdict.label}.** ${m.verdict.reason}

Current data is too small and/or too dirty for a meaningful conclusion. A useful next research run must collect at least ${MIN_PAIRED_OBSERVATIONS} paired observations, ${MIN_EFFECTIVE_BREADTH} effective independent observations after autocorrelation discounting, and ${MIN_TEST_OBSERVATIONS} chronological out-of-sample observations before any IC verdict is issued. For a tradable claim, the source must also be sequenced/high-confidence. With the current Chrome/Coinbase build, Pass 3 found WS TAP VIABLE: NO, so plentiful DOM-only data remains low-confidence even if the IC looks attractive.

## References

- Grinold and Kahn: IC, breadth, and the danger of treating correlated observations as independent.
- Lopez de Prado, Advances in Financial Machine Learning: chronological validation, walk-forward discipline, multiple testing, and deflated Sharpe.
- Kahneman, Thinking, Fast and Slow: overconfidence and the discipline of refusing to over-interpret a small in-sample win.
- Taleb: non-normality and fat tails in returns, which is why skew/kurtosis and false-positive controls are reported.
`;
}

function row(metric) {
  return [
    metric.observations,
    fmt(metric.ic),
    fmt(metric.standardError),
    fmt(metric.tStat),
    fmt(metric.breadth),
    fmt(metric.lag1Autocorr),
    fmt(metric.strategySharpePerObservation),
    fmt(metric.deflatedSharpe),
    fmt(metric.probabilityFalsePositive),
    metric.parameterTrials
  ].join(" | ");
}

function fmt(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

function json(value) {
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  if (args.files) args.files = String(args.files).split(",").map(s => s.trim()).filter(Boolean);
  for (const key of ["horizonSeconds", "horizonObservations", "depthLevels", "trainFraction", "trials"]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.status) {
    const status = await datasetStatus(args);
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const result = await replayBacktest(args);
  const summary = {
    symbol: result.symbol,
    events: result.inventory.events,
    dateRange: [result.inventory.minTsIso, result.inventory.maxTsIso],
    sources: result.inventory.bySource,
    degradedPct: result.inventory.pctDegraded,
    cleanProvenancePct: result.inventory.pctCleanProvenance,
    pairedObservations: result.pairedObservations,
    readiness: result.readiness,
    verdict: result.metrics.verdict,
    reportPath: result.reportPath
  };
  console.log(JSON.stringify(summary, null, 2));
}

const thisFile = pathToFileURL(fileURLToPath(import.meta.url)).href;
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === thisFile) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
