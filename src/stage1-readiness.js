import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { datasetStatus } from "./replay.js";
import { stage1ApprovalStatus } from "./stage1-approval.js";
import { inspectRawFrameArchive } from "./stage1-frame-evidence.js";
import {
  deriveStage1ArchiveEvidence,
  stage1ManifestIntegrityReasons
} from "./stage1-manifest-audit.js";

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
    const rawFrameArchive = await inspectRawFrameArchive({ manifestFile: file, manifest });
    const derivedFromArchive = await deriveStage1ArchiveEvidence({ manifestFile: file, manifest, symbol });
    const archiveIntegrityReasons = stage1ManifestIntegrityReasons({
      manifest,
      rawFrameArchive,
      derivedFromArchive
    });
    manifests.push({
      file: path.relative(process.cwd(), file),
      status: manifest.status || null,
      symbol: manifest.symbol || null,
      source: manifest.source || null,
      dataQuality: manifest.dataQuality || null,
      offlineOnly: manifest.offlineOnly === true,
      networkTouched: manifest.networkTouched === true,
      keyedClientImplemented: manifest.keyedClientImplemented === true,
      liveWsFlowObserved: manifest.liveWsFlowObserved === true,
      frames: manifest.counts?.frames ?? manifest.framesInput ?? 0,
      gaps: Array.isArray(manifest.gaps) ? manifest.gaps.length : 0,
      parseErrors: manifest.counts?.parseErrors ?? null,
      unsequenced: manifest.counts?.unsequenced ?? null,
      duplicateOrReplay: manifest.counts?.duplicateOrReplay ?? null,
      outOfOrder: manifest.counts?.outOfOrder ?? null,
      appendedWritten: manifest.appended?.written ?? manifest.journalStats?.written ?? null,
      journalRejected: manifest.counts?.journalRejected ?? manifest.journalStats?.rejected ?? null,
      frameEvidence: manifest.frameEvidence || null,
      rawFrameArchive,
      derivedFromArchive,
      archiveIntegrity: {
        pass: archiveIntegrityReasons.length === 0,
        reasons: archiveIntegrityReasons
      },
      provenance: manifest.provenance || null,
      evidence: manifest.evidence || null,
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
  const assessments = manifests.manifests.map(validateStage1LiveManifestEvidence);
  const live = assessments.filter(item => item.pass).map(item => item.manifest);
  const candidateFailures = assessments
    .filter(item => item.candidate && !item.pass)
    .flatMap(item => item.reasons.map(reason => `${item.manifest.file}: ${reason}`));
  const reasons = live.length ? [] : [
    "no completed live keyed WS Stage 1 manifest observed",
    ...candidateFailures
  ];
  return {
    verdict: live.length ? "PASS" : "NOT-READY",
    pass: live.length > 0,
    reasons: [...new Set(reasons)],
    matchingManifests: live
  };
}

function validateStage1LiveManifestEvidence(manifest) {
  const candidate = manifest.status === "complete" ||
    manifest.networkTouched ||
    manifest.keyedClientImplemented ||
    manifest.liveWsFlowObserved;
  const reasons = [];

  if (manifest.status !== "complete") reasons.push("manifest status is not complete");
  if (manifest.source !== "ws") reasons.push("manifest source is not ws");
  if (manifest.dataQuality !== "sequenced/high-confidence") reasons.push("manifest dataQuality is not sequenced/high-confidence");
  if (manifest.offlineOnly !== false) reasons.push("manifest offlineOnly is not false");
  if (manifest.networkTouched !== true) reasons.push("manifest networkTouched is not true");
  if (manifest.keyedClientImplemented !== true) reasons.push("manifest keyedClientImplemented is not true");
  if (manifest.liveWsFlowObserved !== true) reasons.push("manifest liveWsFlowObserved is not true");
  if (manifest.frames <= 0) reasons.push("manifest has no input frames");
  if (manifest.appendedWritten <= 0) reasons.push("manifest has no written journal rows");
  if (manifest.gaps !== 0) reasons.push(`manifest gaps ${manifest.gaps} > 0`);
  for (const [key, label] of [
    ["parseErrors", "parse errors"],
    ["unsequenced", "unsequenced frames"],
    ["duplicateOrReplay", "duplicate/replayed frames"],
    ["outOfOrder", "out-of-order frames"],
    ["journalRejected", "journal rejections"]
  ]) {
    const value = manifest[key];
    if (value !== 0) reasons.push(`manifest ${label} ${value ?? "unknown"} is not 0`);
  }

  const frameEvidence = manifest.frameEvidence;
  if (!frameEvidence || typeof frameEvidence !== "object") {
    reasons.push("manifest frameEvidence is missing");
  } else {
    if (!Number.isFinite(frameEvidence.sequenceRange?.first) || !Number.isFinite(frameEvidence.sequenceRange?.last)) {
      reasons.push("manifest frameEvidence sequenceRange is incomplete");
    } else if (frameEvidence.sequenceRange.last < frameEvidence.sequenceRange.first) {
      reasons.push("manifest frameEvidence sequenceRange is inverted");
    }
    if ((frameEvidence.channels?.heartbeats ?? 0) <= 0) {
      reasons.push("manifest frameEvidence has no heartbeat frames");
    }
    if (typeof frameEvidence.rawFrameSha256 !== "string" || !/^[a-f0-9]{64}$/.test(frameEvidence.rawFrameSha256)) {
      reasons.push("manifest frameEvidence rawFrameSha256 is missing or invalid");
    }
    if (!Number.isFinite(frameEvidence.heartbeatCounterRange?.first) || !Number.isFinite(frameEvidence.heartbeatCounterRange?.last)) {
      reasons.push("manifest frameEvidence heartbeatCounterRange is incomplete");
    } else if (frameEvidence.heartbeatCounterRange.last < frameEvidence.heartbeatCounterRange.first) {
      reasons.push("manifest frameEvidence heartbeatCounterRange is inverted");
    }
  }

  if (manifest.rawFrameArchive?.verified !== true) {
    reasons.push(`manifest raw frame archive is not verified: ${manifest.rawFrameArchive?.reason || "unknown"}`);
  }
  if (manifest.archiveIntegrity?.pass !== true) {
    const integrityReasons = manifest.archiveIntegrity?.reasons?.length
      ? manifest.archiveIntegrity.reasons
      : ["unknown archive integrity failure"];
    for (const reason of integrityReasons) {
      reasons.push(`manifest archive integrity failed: ${reason}`);
    }
  }

  const provenance = manifest.provenance;
  if (!provenance || typeof provenance !== "object") {
    reasons.push("manifest provenance is missing");
  } else {
    if (provenance.totalEvents <= 0) reasons.push("manifest provenance has no events");
    if (provenance.pctClean !== 100) reasons.push(`manifest provenance pctClean ${provenance.pctClean ?? "unknown"} is not 100`);
  }

  const preflight = manifest.evidence?.preflight;
  if (!preflight || typeof preflight !== "object") {
    reasons.push("manifest preflight evidence is missing");
  } else {
    if (preflight.preflight?.pass !== true) reasons.push("manifest preflight did not pass");
    if (preflight.approval?.approved !== true) reasons.push("manifest preflight approval is not approved");
    if (preflight.credentials?.pass !== true) reasons.push("manifest preflight credentials did not pass");
    if (preflight.subscriptionPlan?.validation?.pass !== true) reasons.push("manifest preflight subscription plan did not pass");
    if (preflight.offlineOnly !== true) reasons.push("manifest preflight offlineOnly is not true");
    if (preflight.networkTouched !== false) reasons.push("manifest preflight networkTouched is not false");
    if (preflight.keyedClientImplemented !== false) reasons.push("manifest preflight keyedClientImplemented is not false");
    if (preflight.jwtGenerated !== false) reasons.push("manifest preflight jwtGenerated is not false");
    if (preflight.safety?.noCredentialValuesReturned !== true) reasons.push("manifest preflight does not assert secret-free output");
    const productIds = preflight.subscriptionPlan?.productIds;
    if (!Array.isArray(productIds) || !productIds.includes(manifest.symbol)) {
      reasons.push(`manifest preflight productIds do not include ${manifest.symbol}`);
    }
    const channels = preflight.subscriptionPlan?.channels;
    if (!Array.isArray(channels) || !channels.includes("heartbeats")) {
      reasons.push("manifest preflight subscription plan does not include heartbeats");
    }
    if (!Array.isArray(channels) || !channels.includes("level2")) {
      reasons.push("manifest preflight subscription plan does not include level2");
    }
  }

  return {
    candidate,
    pass: reasons.length === 0,
    reasons,
    manifest
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
