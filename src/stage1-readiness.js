import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { datasetStatus } from "./replay.js";
import { stage1ApprovalStatus } from "./stage1-approval.js";

const DEFAULT_SYMBOL = "BTC-USD";

export async function stage1Readiness(args = {}) {
  const {
    symbol = DEFAULT_SYMBOL,
    recordingsDir = "recordings"
  } = args;
  const approval = stage1ApprovalStatus();
  const status = await datasetStatus(args);
  const manifests = await inspectStage1Manifests({ recordingsDir, symbol });
  const dataGate = stage1DataGate(status);
  const liveEvidenceGate = stage1LiveEvidenceGate(manifests);
  const fullGateReasons = [
    ...(approval.approved ? [] : [`credential approval missing: set ${approval.approvalEnv} to ${approval.requiredApprovalPhrase}`]),
    ...dataGate.reasons,
    ...liveEvidenceGate.reasons
  ];
  return {
    generatedAt: new Date().toISOString(),
    stage: "Stage 1 - Real Sequenced Data Feed",
    symbol,
    offlineOnly: true,
    networkTouched: false,
    keyedClientImplemented: false,
    liveTradingEnabled: false,
    approval,
    dataGate,
    liveEvidenceGate,
    fullStage1Gate: {
      verdict: fullGateReasons.length === 0 ? "PASS" : "NOT-READY",
      pass: fullGateReasons.length === 0,
      reasons: fullGateReasons
    },
    dataset: status,
    manifests
  };
}

function stage1DataGate(status) {
  const inv = status.inventory;
  const ready = status.readiness;
  const reasons = [...(ready.reasons || [])];
  const nonWs = inv.events - (inv.bySource.ws || 0);
  const nonHigh = inv.events - (inv.byConfidence.high || 0);
  const degraded = inv.degraded?.true || 0;
  const gaps = inv.byType?.gap || 0;
  if (inv.events === 0) reasons.push("no journal events selected");
  if (nonWs > 0) reasons.push(`non-WS events ${nonWs} > 0`);
  if (nonHigh > 0) reasons.push(`non-high-confidence events ${nonHigh} > 0`);
  if (degraded > 0) reasons.push(`degraded events ${degraded} > 0`);
  if (gaps > 0) reasons.push(`gap events ${gaps} > 0`);
  if (inv.dataQualityCeiling !== "sequenced/high-confidence") {
    reasons.push(`data-quality ceiling is ${inv.dataQualityCeiling}`);
  }
  if (ready.readyForTradableClaim !== true) reasons.push("Stage-0 readiness on WS-quality data is not met");
  const uniqueReasons = [...new Set(reasons)];
  return {
    verdict: uniqueReasons.length === 0 ? "PASS" : "NOT-READY",
    pass: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    events: inv.events,
    gapEvents: gaps,
    bySource: inv.bySource,
    byConfidence: inv.byConfidence,
    pctCleanProvenance: inv.pctCleanProvenance,
    dataQualityCeiling: inv.dataQualityCeiling,
    pairedObservations: status.pairedObservations,
    effectiveBreadth: ready.effectiveBreadth,
    testObservations: ready.testObservations,
    minPairedObservations: ready.minPairedObservations,
    minEffectiveBreadth: ready.minEffectiveBreadth,
    minTestObservations: ready.minTestObservations
  };
}

async function inspectStage1Manifests({ recordingsDir, symbol }) {
  const root = path.resolve(process.cwd(), recordingsDir);
  const files = await walk(root, file => path.basename(file) === "manifest.json");
  const manifests = [];
  for (const file of files) {
    const manifest = await readJson(file);
    if (!manifest) continue;
    if (manifest.stage !== "Stage 1 - Real Sequenced Data Feed") continue;
    if (manifest.symbol !== symbol) continue;
    manifests.push({
      file: path.relative(process.cwd(), file),
      status: manifest.status || null,
      source: manifest.source || null,
      dataQuality: manifest.dataQuality || null,
      offlineOnly: manifest.offlineOnly === true,
      networkTouched: manifest.networkTouched === true,
      keyedClientImplemented: manifest.keyedClientImplemented === true,
      liveWsFlowObserved: manifest.liveWsFlowObserved === true,
      frames: manifest.counts?.frames ?? manifest.framesInput ?? 0,
      gaps: Array.isArray(manifest.gaps) ? manifest.gaps.length : 0,
      journalRejected: manifest.counts?.journalRejected ?? manifest.journalStats?.rejected ?? null,
      startedAt: manifest.startedAt || null,
      endedAt: manifest.endedAt || null,
      journalPath: manifest.journalPath || null
    });
  }
  return {
    recordingsDir,
    count: manifests.length,
    manifests: manifests.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  };
}

function stage1LiveEvidenceGate(manifests) {
  const live = manifests.manifests.filter(item =>
    item.status === "complete" &&
    item.source === "ws" &&
    item.dataQuality === "sequenced/high-confidence" &&
    item.offlineOnly === false &&
    item.networkTouched === true &&
    item.keyedClientImplemented === true &&
    item.liveWsFlowObserved === true &&
    item.gaps === 0 &&
    item.journalRejected === 0
  );
  const reasons = live.length ? [] : ["no completed live keyed WS Stage 1 manifest observed"];
  return {
    verdict: live.length ? "PASS" : "NOT-READY",
    pass: live.length > 0,
    reasons,
    matchingManifests: live
  };
}

async function walk(dir, predicate) {
  if (!fsSync.existsSync(dir)) return [];
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p, predicate));
    else if (ent.isFile() && predicate(p)) out.push(p);
  }
  return out.sort();
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
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
  for (const key of ["horizonSeconds", "horizonObservations", "depthLevels", "trainFraction", "trials"]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  return args;
}

async function main() {
  const result = await stage1Readiness(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
