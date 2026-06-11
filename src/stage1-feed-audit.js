import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCoinbaseFrame } from "./coinbase.js";
import { validateJournalProvenance } from "./journal.js";
import { makeGap, serializeEvent } from "./schema.js";
import { rawFrameDigest } from "./stage1-frame-evidence.js";
import {
  replayEvents,
  MIN_EFFECTIVE_BREADTH,
  MIN_PAIRED_OBSERVATIONS,
  MIN_TEST_OBSERVATIONS
} from "./replay.js";

const DEFAULT_SYMBOL = "BTC-USD";

export async function stage1FeedAudit(args = {}) {
  const {
    symbol = DEFAULT_SYMBOL,
    frames,
    frameFile,
    outputDir = "research",
    writeReport = false
  } = args;
  const rawFrames = Array.isArray(frames) ? frames : await loadStage1FrameFile(frameFile);
  const parsed = parseStage1Frames({ rawFrames, symbol });
  const replay = replayEvents(parsed.events.filter(evt => evt.type !== "gap"), args);
  const stage0Readiness = stage0ReadinessFromReplay({ replay, stats: parsed.stats, provenance: parsed.provenance });
  const wsQualityGate = wsQualityVerdict({ stats: parsed.stats, provenance: parsed.provenance, counts: parsed.counts });
  const pctClean = parsed.provenance.totalEvents
    ? Number((parsed.provenance.cleanEvents / parsed.provenance.totalEvents * 100).toFixed(6))
    : 0;
  const result = {
    generatedAt: new Date().toISOString(),
    stage: "Stage 1 - Real Sequenced Data Feed",
    offlineOnly: true,
    networkTouched: false,
    keyedClientImplemented: false,
    liveTradingEnabled: false,
    symbol,
    frameFile: frameFile || null,
    frames: parsed.stats,
    counts: parsed.counts,
    frameEvidence: parsed.frameEvidence,
    provenance: {
      ...parsed.provenance,
      pctClean
    },
    gapEvents: parsed.gapEvents,
    wsQualityGate,
    stage0Readiness,
    replay: {
      eventCount: replay.eventCount,
      priceObservations: replay.priceObservations,
      signalObservations: replay.signalObservations,
      pairedObservations: replay.pairedObservations,
      effectiveBreadth: replay.metrics.all.breadth ?? 0,
      testObservations: replay.metrics.test.observations
    }
  };
  if (writeReport === true) {
    result.reportPath = await writeStage1FeedAuditReport(result, { outputDir });
  }
  return result;
}

export function parseStage1Frames({ rawFrames = [], symbol = DEFAULT_SYMBOL } = {}) {
  const stats = {
    total: rawFrames.length,
    parsed: 0,
    parseErrors: 0,
    unsequenced: 0,
    duplicateOrReplay: 0,
    outOfOrder: 0,
    gaps: 0,
    heartbeatFrames: 0,
    heartbeatCounterMissing: 0,
    heartbeatCounterGaps: 0,
    heartbeatCounterOutOfOrder: 0
  };
  const events = [];
  const gapEvents = [];
  const counts = { ticks: 0, l2: 0, trades: 0, candles: 0, heartbeats: 0, gaps: 0 };
  const frameEvidence = {
    channels: {},
    sequenceRange: { first: null, last: null },
    heartbeatCounterRange: { first: null, last: null },
    rawFrameSha256: rawFrameDigest(rawFrames)
  };
  const provenance = {
    totalEvents: 0,
    cleanEvents: 0,
    bySource: {},
    byConfidence: {},
    degraded: { true: 0, false: 0 },
    rejected: 0,
    rejectedReasons: {}
  };
  let lastSeq = null;
  let lastHeartbeatCounter = null;

  for (const raw of rawFrames) {
    let msg;
    try {
      msg = coerceFrame(raw);
      stats.parsed++;
    } catch {
      stats.parseErrors++;
      continue;
    }

    const frameChannel = String(msg.channel || "(missing)");
    frameEvidence.channels[frameChannel] = (frameEvidence.channels[frameChannel] || 0) + 1;

    if (msg.channel === "heartbeats") {
      stats.heartbeatFrames++;
      counts.heartbeats++;
      const counter = heartbeatCounter(msg);
      if (counter === null) {
        stats.heartbeatCounterMissing++;
      } else {
        if (lastHeartbeatCounter !== null && counter > lastHeartbeatCounter + 1) {
          stats.heartbeatCounterGaps += counter - lastHeartbeatCounter - 1;
        } else if (lastHeartbeatCounter !== null && counter <= lastHeartbeatCounter) {
          stats.heartbeatCounterOutOfOrder++;
        }
        if (lastHeartbeatCounter === null || counter > lastHeartbeatCounter) {
          lastHeartbeatCounter = counter;
        }
        if (frameEvidence.heartbeatCounterRange.first === null) {
          frameEvidence.heartbeatCounterRange.first = counter;
        }
        if (frameEvidence.heartbeatCounterRange.last === null || counter > frameEvidence.heartbeatCounterRange.last) {
          frameEvidence.heartbeatCounterRange.last = counter;
        }
      }
    }

    const { events: parsedEvents, sequenceNum, channel } = parseCoinbaseFrame(msg);
    if (sequenceNum === null) {
      stats.unsequenced++;
    } else {
      if (lastSeq !== null && sequenceNum > lastSeq + 1) {
        const gap = makeGap({ symbol, expectedSeq: lastSeq + 1, gotSeq: sequenceNum, channel });
        const serialized = serializeEvent(gap);
        gapEvents.push(serialized);
        events.push(gap);
        stats.gaps++;
        counts.gaps++;
        countProvenance(provenance, serialized);
      } else if (lastSeq !== null && sequenceNum === lastSeq) {
        stats.duplicateOrReplay++;
      } else if (lastSeq !== null && sequenceNum < lastSeq) {
        stats.outOfOrder++;
      }
      if (lastSeq === null || sequenceNum > lastSeq) lastSeq = sequenceNum;
      if (frameEvidence.sequenceRange.first === null) {
        frameEvidence.sequenceRange.first = sequenceNum;
      }
      if (frameEvidence.sequenceRange.last === null || sequenceNum > frameEvidence.sequenceRange.last) {
        frameEvidence.sequenceRange.last = sequenceNum;
      }
    }

    for (const evt of parsedEvents) {
      events.push(evt);
      if (evt.type === "tick") counts.ticks++;
      else if (evt.type === "l2update") counts.l2++;
      else if (evt.type === "trade") counts.trades++;
      else if (evt.type === "candle") counts.candles++;
      countProvenance(provenance, serializeEvent(evt));
    }
  }

  return {
    events,
    serializedEvents: events.map(serializeEvent),
    gapEvents,
    stats,
    counts,
    frameEvidence,
    provenance
  };
}

export async function loadStage1FrameFile(frameFile) {
  if (!frameFile) return [];
  const text = await fs.readFile(path.resolve(process.cwd(), frameFile), "utf8");
  return text.split(/\r?\n/).filter(Boolean);
}

function coerceFrame(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  const payload = raw?.response?.payloadData ?? raw?.payloadData ?? raw?.frame?.response?.payloadData;
  if (typeof payload === "string") return JSON.parse(payload);
  if (raw && typeof raw === "object") return raw;
  throw new Error("unsupported frame input");
}

function countProvenance(bucket, evt) {
  bucket.totalEvents++;
  bucket.bySource[evt.source] = (bucket.bySource[evt.source] || 0) + 1;
  bucket.byConfidence[evt.confidence] = (bucket.byConfidence[evt.confidence] || 0) + 1;
  bucket.degraded[evt.degraded === true ? "true" : "false"]++;
  const validation = validateJournalProvenance(evt);
  const wsClean = evt.source === "ws" &&
    evt.hasSequence === true &&
    evt.confidence === "high" &&
    evt.degraded === false &&
    validation.ok;
  if (wsClean) {
    bucket.cleanEvents++;
  } else {
    bucket.rejected++;
    bucket.rejectedReasons[validation.reason || "not clean sequenced ws"] =
      (bucket.rejectedReasons[validation.reason || "not clean sequenced ws"] || 0) + 1;
  }
}

function wsQualityVerdict({ stats, provenance, counts }) {
  const reasons = [];
  if (stats.total === 0) reasons.push("no WS frames supplied");
  if (stats.parseErrors > 0) reasons.push(`parse errors ${stats.parseErrors} > 0`);
  if (stats.unsequenced > 0) reasons.push(`unsequenced frames ${stats.unsequenced} > 0`);
  if (stats.gaps > 0) reasons.push(`sequence gaps ${stats.gaps} > 0`);
  if (stats.duplicateOrReplay > 0) reasons.push(`duplicate/replayed frames ${stats.duplicateOrReplay} > 0`);
  if (stats.outOfOrder > 0) reasons.push(`out-of-order frames ${stats.outOfOrder} > 0`);
  if (stats.heartbeatFrames === 0) reasons.push("no heartbeat frames supplied for liveness evidence");
  if (stats.heartbeatCounterMissing > 0) reasons.push(`heartbeat frames missing counters ${stats.heartbeatCounterMissing} > 0`);
  if (stats.heartbeatCounterGaps > 0) reasons.push(`heartbeat counter gaps ${stats.heartbeatCounterGaps} > 0`);
  if (stats.heartbeatCounterOutOfOrder > 0) reasons.push(`heartbeat counters out of order ${stats.heartbeatCounterOutOfOrder} > 0`);
  if (provenance.totalEvents === 0) reasons.push("no normalized market events emitted");
  if (provenance.totalEvents !== provenance.cleanEvents) {
    reasons.push(`clean WS provenance ${provenance.cleanEvents}/${provenance.totalEvents}`);
  }
  if (counts.l2 === 0) reasons.push("no level2 depth updates emitted");
  return {
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    pass: reasons.length === 0,
    reasons
  };
}

function stage0ReadinessFromReplay({ replay, stats, provenance }) {
  const paired = replay.pairedObservations;
  const effectiveBreadth = replay.metrics.all.breadth ?? 0;
  const testObservations = replay.metrics.test.observations;
  const reasons = [];
  if (paired < MIN_PAIRED_OBSERVATIONS) reasons.push(`paired observations ${paired} < ${MIN_PAIRED_OBSERVATIONS}`);
  if (effectiveBreadth < MIN_EFFECTIVE_BREADTH) reasons.push(`effective breadth ${effectiveBreadth} < ${MIN_EFFECTIVE_BREADTH}`);
  if (testObservations < MIN_TEST_OBSERVATIONS) reasons.push(`test observations ${testObservations} < ${MIN_TEST_OBSERVATIONS}`);
  if (stats.gaps > 0) reasons.push(`sequence gaps ${stats.gaps} > 0`);
  if (stats.unsequenced > 0) reasons.push(`unsequenced frames ${stats.unsequenced} > 0`);
  if (stats.duplicateOrReplay > 0) reasons.push(`duplicate/replayed frames ${stats.duplicateOrReplay} > 0`);
  if (stats.heartbeatFrames === 0) reasons.push("no heartbeat frames supplied for liveness evidence");
  if (stats.heartbeatCounterMissing > 0) reasons.push(`heartbeat frames missing counters ${stats.heartbeatCounterMissing} > 0`);
  if (stats.heartbeatCounterGaps > 0) reasons.push(`heartbeat counter gaps ${stats.heartbeatCounterGaps} > 0`);
  if (stats.heartbeatCounterOutOfOrder > 0) reasons.push(`heartbeat counters out of order ${stats.heartbeatCounterOutOfOrder} > 0`);
  if (provenance.totalEvents !== provenance.cleanEvents) {
    reasons.push(`unclean provenance events ${provenance.totalEvents - provenance.cleanEvents} > 0`);
  }
  const ready = reasons.length === 0;
  return {
    verdict: ready ? "READY" : "NOT-READY",
    ready,
    quality: "sequenced/high-confidence",
    pairedObservations: paired,
    effectiveBreadth,
    testObservations,
    minPairedObservations: MIN_PAIRED_OBSERVATIONS,
    minEffectiveBreadth: MIN_EFFECTIVE_BREADTH,
    minTestObservations: MIN_TEST_OBSERVATIONS,
    reasons
  };
}

async function writeStage1FeedAuditReport(result, { outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `STAGE1_FEED_AUDIT_${stamp}.md`);
  const lines = [
    `# Stage 1 Feed Audit - ${result.symbol}`,
    "",
    `Generated: ${result.generatedAt}`,
    "",
    `WS quality gate: **${result.wsQualityGate.verdict}**`,
    `Stage-0 readiness on WS data: **${result.stage0Readiness.verdict}**`,
    "",
    "## Counts",
    "",
    `- Frames: ${result.frames.total}`,
    `- Parse errors: ${result.frames.parseErrors}`,
    `- Unsequenced frames: ${result.frames.unsequenced}`,
    `- Sequence gaps: ${result.frames.gaps}`,
    `- Duplicate/replayed frames: ${result.frames.duplicateOrReplay}`,
    `- Heartbeat frames: ${result.frames.heartbeatFrames}`,
    `- Heartbeat counter gaps: ${result.frames.heartbeatCounterGaps}`,
    `- Sequence range: ${rangeText(result.frameEvidence?.sequenceRange)}`,
    `- Heartbeat counter range: ${rangeText(result.frameEvidence?.heartbeatCounterRange)}`,
    `- Raw frame SHA-256: ${result.frameEvidence?.rawFrameSha256 || "n/a"}`,
    `- L2 updates: ${result.counts.l2}`,
    `- Ticks: ${result.counts.ticks}`,
    `- Trades: ${result.counts.trades}`,
    `- Clean provenance: ${result.provenance.cleanEvents}/${result.provenance.totalEvents} (${result.provenance.pctClean}%)`,
    "",
    "## Readiness Reasons",
    "",
    ...(result.stage0Readiness.reasons.length ? result.stage0Readiness.reasons.map(reason => `- ${reason}`) : ["- Thresholds satisfied."]),
    "",
    "## Safety",
    "",
    "- Offline-only audit.",
    "- No Coinbase socket opened.",
    "- No credentials validated or printed.",
    "- No order path, stops, or LIVE arming."
  ];
  await fs.writeFile(reportPath, lines.join("\n") + "\n", "utf8");
  return reportPath;
}

function rangeText(range) {
  if (!range || range.first === null || range.last === null) return "n/a";
  return `${range.first}..${range.last}`;
}

function heartbeatCounter(msg) {
  if (!Array.isArray(msg?.events)) return null;
  for (const event of msg.events) {
    const raw = event?.heartbeat_counter;
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
  }
  return null;
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
  if (args.writeReport !== undefined) args.writeReport = args.writeReport !== "false";
  for (const key of ["horizonSeconds", "horizonObservations", "depthLevels", "trainFraction", "trials"]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  return args;
}

async function main() {
  const result = await stage1FeedAudit(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
