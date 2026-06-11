// src/stage-a.js
// ---------------------------------------------------------------------------
// Stage A - honest edge measurement.
//
// Offline only: no Chrome, no Coinbase REST/SDK, no credentials, no sockets,
// no orders. This module begins only after Stage 0 readiness is READY for the
// selected clean window. It tests the existing imbalance signal once, with
// chronological OOS metrics, non-overlapping walk-forward windows, deflated
// Sharpe / false-positive controls, and conservative fee/spread/slippage costs.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Decimal } from "./schema.js";
import { datasetStatus, replayBacktest } from "./replay.js";

const DEFAULT_SYMBOL = "BTC-USD";

function toFloat(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : null;
}

function std(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, x) => sum + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
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

function pearson(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

function spearman(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  return pearson(ranks(a), ranks(b));
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

function sharpe(values) {
  const s = std(values);
  if (!s) return null;
  return mean(values) / s * Math.sqrt(values.length);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function deflateSharpe({ sharpeValue, skewness, kurt, trials }) {
  if (!Number.isFinite(sharpeValue)) return { deflatedSharpe: null, probabilityFalsePositive: null };
  const trialPenalty = trials > 1 ? Math.sqrt(2 * Math.log(trials)) : 0;
  const nonNormalPenalty = Math.max(0, Math.abs(skewness ?? 0) * 0.1 + Math.max(0, (kurt ?? 3) - 3) * 0.05);
  const hurdle = trialPenalty + nonNormalPenalty;
  return {
    deflatedSharpe: sharpeValue - hurdle,
    probabilityFalsePositive: normalCdf(hurdle - sharpeValue)
  };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function costReturn({ feeBps = 60, spreadBps = 2, slippageBps = 2 } = {}) {
  // Conservative standalone bet cost: entry fee + exit fee + full spread +
  // slippage on both sides. This is a Decimal return, not money.
  return new Decimal(feeBps).mul(2)
    .plus(new Decimal(spreadBps))
    .plus(new Decimal(slippageBps).mul(2))
    .div(10_000);
}

function observationRows(observations, cost) {
  return observations
    .filter(obs => obs.forwardReturn !== null && obs.mid !== null)
    .map(obs => {
      const signal = new Decimal(obs.signal);
      const forwardReturn = new Decimal(obs.forwardReturn);
      const gross = signal.gte(0) ? forwardReturn : forwardReturn.negated();
      const net = gross.minus(cost);
      return {
        ts: obs.ts,
        signal: toFloat(signal.toString()),
        forwardReturn: toFloat(forwardReturn.toString()),
        grossReturn: toFloat(gross.toString()),
        netReturn: toFloat(net.toString())
      };
    })
    .filter(row => Number.isFinite(row.signal) && Number.isFinite(row.forwardReturn) && Number.isFinite(row.netReturn));
}

function metricSet(rows, trials) {
  const n = rows.length;
  const ic = spearman(rows.map(r => r.signal), rows.map(r => r.forwardReturn));
  const se = n > 2 && Number.isFinite(ic) ? Math.sqrt(Math.max(0, (1 - ic * ic) / (n - 2))) : null;
  const tStat = se && se > 0 ? ic / se : null;
  const grossSharpe = sharpe(rows.map(r => r.grossReturn));
  const netReturns = rows.map(r => r.netReturn);
  const netSharpe = sharpe(netReturns);
  const sk = skew(netReturns);
  const ku = kurtosis(netReturns);
  const dsr = deflateSharpe({ sharpeValue: netSharpe, skewness: sk, kurt: ku, trials });
  return {
    observations: n,
    ic: finiteOrNull(ic),
    standardError: finiteOrNull(se),
    tStat: finiteOrNull(tStat),
    meanGrossReturn: finiteOrNull(mean(rows.map(r => r.grossReturn))),
    meanNetReturn: finiteOrNull(mean(netReturns)),
    grossSharpe: finiteOrNull(grossSharpe),
    netSharpe: finiteOrNull(netSharpe),
    skewness: finiteOrNull(sk),
    kurtosis: finiteOrNull(ku),
    deflatedSharpe: finiteOrNull(dsr.deflatedSharpe),
    probabilityFalsePositive: finiteOrNull(dsr.probabilityFalsePositive),
    parameterTrials: trials
  };
}

function splitRows(rows, trainFraction) {
  const split = Math.max(0, Math.min(rows.length, Math.floor(rows.length * trainFraction)));
  return { train: rows.slice(0, split), test: rows.slice(split), split };
}

function walkForward(rows, { windows = 5, minWindowObservations = 100, trials = 1 } = {}) {
  const count = Math.max(1, Number(windows));
  const size = Math.floor(rows.length / count);
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = i * size;
    const end = i === count - 1 ? rows.length : (i + 1) * size;
    const slice = rows.slice(start, end);
    if (slice.length < minWindowObservations) continue;
    out.push({
      window: i + 1,
      startTs: slice[0]?.ts ?? null,
      endTs: slice.at(-1)?.ts ?? null,
      ...metricSet(slice, trials)
    });
  }
  return out;
}

function gateVerdict({ readiness, inventory, test, windows }) {
  if (!readiness.readyForIc) {
    return {
      label: "Refused - Stage 0 not ready",
      terminal: false,
      pass: false,
      reasons: readiness.reasons
    };
  }
  const reasons = [];
  const positiveSignificant = test.ic > 0 && test.tStat >= 2;
  if (!positiveSignificant) reasons.push(`out-of-sample IC/t-stat gate failed: IC=${test.ic}, t=${test.tStat}`);
  const deflatedPass = test.deflatedSharpe > 0 && test.probabilityFalsePositive <= 0.05;
  if (!deflatedPass) reasons.push(`deflated Sharpe gate failed: DSR=${test.deflatedSharpe}, p(false positive)=${test.probabilityFalsePositive}`);
  const costPass = test.meanNetReturn > 0 && test.netSharpe > 0;
  if (!costPass) reasons.push(`realistic-cost gate failed: mean net return=${test.meanNetReturn}, net Sharpe=${test.netSharpe}`);
  const walkPass = windows.length >= 3 && windows.every(w => w.ic > 0 && w.meanNetReturn > 0);
  if (!walkPass) reasons.push("walk-forward persistence gate failed: each non-overlapping window must have positive IC and positive mean net return");
  if (inventory.dataQualityCeiling !== "sequenced/high-confidence") {
    reasons.push(`data quality remains ${inventory.dataQualityCeiling}; DOM quantity does not become WS-quality evidence`);
  }
  if (reasons.length) {
    return {
      label: "Terminal - no durable edge, do not risk money",
      terminal: true,
      pass: false,
      reasons
    };
  }
  return {
    label: "Stage A passed - eligible for forward PAPER validation",
    terminal: false,
    pass: true,
    reasons: []
  };
}

export async function stageAAnalysis(args = {}) {
  const {
    symbol = DEFAULT_SYMBOL,
    outputDir = "research",
    writeReport = true,
    trainFraction = 0.7,
    trials = 1,
    walkForwardWindows = 5,
    minWindowObservations = 100,
    feeBps = 60,
    spreadBps = 2,
    slippageBps = 2
  } = args;
  const generatedAt = new Date().toISOString();
  const readinessStatus = await datasetStatus(args);
  const replay = await replayBacktest({ ...args, writeReport: false });
  const cost = costReturn({ feeBps, spreadBps, slippageBps });
  const rows = observationRows(replay.observations, cost);
  const { train, test, split } = splitRows(rows, trainFraction);
  const metrics = {
    all: metricSet(rows, trials),
    train: metricSet(train, trials),
    test: metricSet(test, trials),
    splitIndex: split
  };
  const windows = walkForward(rows, { windows: walkForwardWindows, minWindowObservations, trials });
  const gate = gateVerdict({
    readiness: readinessStatus.readiness,
    inventory: replay.inventory,
    test: metrics.test,
    windows
  });
  const result = {
    generatedAt,
    stage: "Stage A - Honest Edge Measurement",
    symbol,
    params: {
      startDate: args.startDate ?? null,
      endDate: args.endDate ?? null,
      horizonSeconds: args.horizonSeconds ?? null,
      horizonObservations: args.horizonObservations ?? 1,
      trainFraction,
      trials,
      walkForwardWindows,
      minWindowObservations,
      costs: {
        feeBps,
        spreadBps,
        slippageBps,
        totalRoundTripBps: cost.mul(10_000).toString()
      }
    },
    readiness: readinessStatus.readiness,
    inventory: replay.inventory,
    pairedObservations: replay.pairedObservations,
    metrics,
    walkForward: windows,
    gate,
    note: "DOM-sourced data remains low-confidence; this report can reject an edge, but cannot upgrade feed quality."
  };
  if (writeReport !== false) result.reportPath = await writeStageAReport(result, { outputDir });
  return result;
}

export async function writeStageAReport(result, { outputDir = "research" } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `STAGE_A_REPORT_${stamp}.md`);
  await fs.writeFile(reportPath, buildReport(result), "utf8");
  return reportPath;
}

function metricRow(m) {
  return [
    m.observations,
    m.ic ?? "n/a",
    m.tStat ?? "n/a",
    m.meanGrossReturn ?? "n/a",
    m.meanNetReturn ?? "n/a",
    m.grossSharpe ?? "n/a",
    m.netSharpe ?? "n/a",
    m.deflatedSharpe ?? "n/a",
    m.probabilityFalsePositive ?? "n/a"
  ].join(" | ");
}

function buildReport(result) {
  const wf = result.walkForward.length
    ? result.walkForward.map(w => `| ${w.window} | ${w.observations} | ${w.ic} | ${w.tStat} | ${w.meanNetReturn} | ${w.netSharpe} |`).join("\n")
    : "| n/a | 0 | n/a | n/a | n/a | n/a |";
  return `# Stage A Report - ${result.symbol}

Generated: ${result.generatedAt}

## Gate

**${result.gate.label}.**

${result.gate.reasons.length ? result.gate.reasons.map(reason => `- ${reason}`).join("\n") : "- All Stage A gates passed."}

## Data

- Stage 0 readiness: ${result.readiness.verdict}
- Start date: ${result.params.startDate ?? "none"}
- Events: ${result.inventory.events}
- Paired observations: ${result.pairedObservations}
- Clean provenance: ${result.inventory.pctCleanProvenance}%
- Source breakdown: \`${JSON.stringify(result.inventory.bySource)}\`
- Data-quality ceiling: **${result.inventory.dataQualityCeiling}**

## Costs

Conservative standalone-bet cost model:

- Fee: ${result.params.costs.feeBps} bps per side
- Spread: ${result.params.costs.spreadBps} bps round trip
- Slippage: ${result.params.costs.slippageBps} bps per side
- Total modeled round-trip cost: ${result.params.costs.totalRoundTripBps} bps

These are configurable research assumptions, reported because Stage A requires the signal to survive costs rather than merely correlate before costs.

## Results

| Split | Obs | IC | t-stat | Mean gross return | Mean net return | Gross Sharpe | Net Sharpe | Deflated Sharpe | P(false positive) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All | ${metricRow(result.metrics.all)} |
| Train | ${metricRow(result.metrics.train)} |
| Test | ${metricRow(result.metrics.test)} |

## Walk-Forward

| Window | Obs | IC | t-stat | Mean net return | Net Sharpe |
|---|---:|---:|---:|---:|---:|
${wf}

## Verdict

${result.gate.terminal
  ? "**Terminal: no durable edge, do not risk money.**"
  : result.gate.pass
    ? "**Stage A passed; Stage B forward PAPER validation may begin next.**"
    : "**Stage A did not run because the prior gate was not met.**"}

This report follows Grinold-Kahn on breadth/IC, Lopez de Prado on walk-forward and deflated Sharpe, Kahneman on refusing overconfidence from an attractive in-sample number, and Taleb on fat tails/costs. DOM-sourced data remains low-confidence even when the sample is large.
`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  if (args.files) args.files = String(args.files).split(",").map(s => s.trim()).filter(Boolean);
  for (const key of [
    "horizonSeconds", "horizonObservations", "depthLevels", "trainFraction", "trials",
    "walkForwardWindows", "minWindowObservations", "feeBps", "spreadBps", "slippageBps"
  ]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  return args;
}

async function main() {
  const result = await stageAAnalysis(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    stage: result.stage,
    symbol: result.symbol,
    readiness: result.readiness,
    gate: result.gate,
    pairedObservations: result.pairedObservations,
    test: result.metrics.test,
    walkForwardWindows: result.walkForward.length,
    reportPath: result.reportPath
  }, null, 2));
}

const thisFile = pathToFileURL(fileURLToPath(import.meta.url)).href;
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === thisFile) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
