import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlJournal } from "./journal.js";
import {
  loadStage1FrameFile,
  parseStage1Frames,
  stage1FeedAudit
} from "./stage1-feed-audit.js";

const DEFAULT_SYMBOL = "BTC-USD";

export async function stage1IngestFrames(args = {}) {
  const {
    symbol = DEFAULT_SYMBOL,
    frames,
    frameFile,
    journalDir = "journal",
    outputRoot = "recordings",
    requireClean = true,
    manifestMeta = {}
  } = args;
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outputDir = path.join(outputRoot, `stage1-ws-${symbol.toLowerCase()}-${stamp}`);
  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.mkdir(outputDir, { recursive: true });

  const rawFrames = Array.isArray(frames) ? frames : await loadStage1FrameFile(frameFile);
  const parsed = parseStage1Frames({ rawFrames, symbol });
  const audit = await stage1FeedAudit({ ...args, frames: rawFrames, writeReport: false });
  const manifest = baseManifest({
    symbol,
    startedAt,
    frameFile,
    journalDir,
    outputDir,
    rawFrames,
    parsed,
    audit,
    manifestMeta
  });

  if (requireClean !== false && !audit.wsQualityGate.pass) {
    manifest.status = "refused";
    manifest.refused = true;
    manifest.refusalReason = `WS quality gate failed: ${audit.wsQualityGate.reasons.join("; ")}`;
    manifest.endedAt = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return {
      ingested: false,
      refused: true,
      reason: manifest.refusalReason,
      manifestPath,
      audit
    };
  }

  const journal = new JsonlJournal({ baseDir: journalDir, symbol, strictProvenance: true });
  const appendResults = [];
  for (const evt of parsed.events) {
    appendResults.push(journal.append(evt));
  }
  await journal.close();

  manifest.status = "complete";
  manifest.ingested = true;
  manifest.refused = false;
  manifest.endedAt = new Date().toISOString();
  manifest.journalPath = journal.path();
  manifest.journalStats = journal.stats();
  manifest.appended = {
    written: appendResults.filter(item => item?.written).length,
    rejected: appendResults.filter(item => item?.rejected).length
  };
  manifest.counts.journalRejected = manifest.appended.rejected;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    ingested: true,
    refused: false,
    manifestPath,
    journalPath: journal.path(),
    journalStats: journal.stats(),
    appended: manifest.appended,
    audit
  };
}

function baseManifest({ symbol, startedAt, frameFile, journalDir, outputDir, rawFrames, parsed, audit, manifestMeta = {} }) {
  return {
    stage: "Stage 1 - Real Sequenced Data Feed",
    recording: false,
    offlineOnly: manifestMeta.offlineOnly ?? true,
    networkTouched: manifestMeta.networkTouched === true,
    keyedClientImplemented: manifestMeta.keyedClientImplemented === true,
    liveWsFlowObserved: manifestMeta.liveWsFlowObserved === true,
    liveTradingEnabled: false,
    source: "ws",
    dataQuality: audit.wsQualityGate.pass ? "sequenced/high-confidence" : "failed ws-quality gate",
    symbol,
    startedAt,
    endedAt: null,
    frameFile: frameFile || null,
    framesInput: rawFrames.length,
    journalDir,
    outputDir,
    counts: {
      ...parsed.counts,
      frames: parsed.stats.total,
      parseErrors: parsed.stats.parseErrors,
      unsequenced: parsed.stats.unsequenced,
      duplicateOrReplay: parsed.stats.duplicateOrReplay,
      outOfOrder: parsed.stats.outOfOrder,
      journalRejected: 0
    },
    provenance: {
      ...parsed.provenance,
      pctClean: parsed.provenance.totalEvents
        ? Number((parsed.provenance.cleanEvents / parsed.provenance.totalEvents * 100).toFixed(6))
        : 0
    },
    gaps: parsed.gapEvents,
    wsQualityGate: audit.wsQualityGate,
    stage0Readiness: audit.stage0Readiness,
    replay: audit.replay,
    safety: {
      noCredentials: manifestMeta.keyedClientImplemented === true ? false : true,
      noNetwork: manifestMeta.networkTouched === true ? false : true,
      noOrders: true,
      noLiveArming: true
    },
    evidence: manifestMeta.evidence || null
  };
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
  if (args.frames && !args.frameFile) args.frameFile = args.frames;
  if (args.requireClean !== undefined) args.requireClean = args.requireClean !== "false";
  for (const key of ["horizonSeconds", "horizonObservations", "depthLevels", "trainFraction", "trials"]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  return args;
}

async function main() {
  const result = await stage1IngestFrames(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
