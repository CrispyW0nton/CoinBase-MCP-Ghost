import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStage1Frames } from "./stage1-feed-audit.js";
import { inspectRawFrameArchive, readRawFrameArchive, stableJson } from "./stage1-frame-evidence.js";

const DEFAULT_SYMBOL = "BTC-USD";

export async function stage1ManifestAudit({
  symbol = DEFAULT_SYMBOL,
  recordingsDir = "recordings"
} = {}) {
  const root = path.resolve(process.cwd(), recordingsDir);
  const files = await walk(root, file => path.basename(file) === "manifest.json");
  const manifests = [];

  for (const file of files) {
    const manifest = await readJson(file);
    if (!manifest) continue;
    if (manifest.stage !== "Stage 1 - Real Sequenced Data Feed") continue;
    if (manifest.symbol !== symbol) continue;
    const rawFrameArchive = await inspectRawFrameArchive({ manifestFile: file, manifest });
    const derivedFromArchive = await deriveFromRawFrameArchive({ manifestFile: file, manifest, symbol });
    const reasons = manifestIntegrityReasons({ manifest, rawFrameArchive, derivedFromArchive });
    manifests.push({
      file: path.relative(process.cwd(), file),
      status: manifest.status || null,
      source: manifest.source || null,
      dataQuality: manifest.dataQuality || null,
      frames: manifest.counts?.frames ?? manifest.framesInput ?? 0,
      frameEvidence: manifest.frameEvidence || null,
      rawFrameArchive,
      derivedFromArchive,
      archiveIntegrity: {
        pass: reasons.length === 0,
        reasons
      }
    });
  }

  const failing = manifests.filter(item => !item.archiveIntegrity.pass);
  const verdict = manifests.length === 0 ? "NO_MANIFESTS" : (failing.length ? "FAIL" : "PASS");
  return {
    generatedAt: new Date().toISOString(),
    stage: "Stage 1 - Real Sequenced Data Feed",
    symbol,
    recordingsDir,
    offlineOnly: true,
    networkTouched: false,
    keyedClientImplemented: false,
    liveTradingEnabled: false,
    verdict,
    pass: failing.length === 0,
    counts: {
      manifests: manifests.length,
      archiveVerified: manifests.filter(item => item.rawFrameArchive.verified).length,
      archiveFailed: failing.length
    },
    reasons: failing.flatMap(item => item.archiveIntegrity.reasons.map(reason => `${item.file}: ${reason}`)),
    manifests
  };
}

async function deriveFromRawFrameArchive({ manifestFile, manifest, symbol }) {
  const archive = manifest.rawFrameArchive;
  if (!archive || typeof archive !== "object" || !archive.path) return null;
  try {
    const archivePath = path.resolve(path.dirname(manifestFile), archive.path);
    const rawFrames = await readRawFrameArchive(archivePath);
    const parsed = parseStage1Frames({ rawFrames, symbol });
    return {
      frames: parsed.stats.total,
      counts: {
        ...parsed.counts,
        frames: parsed.stats.total,
        parseErrors: parsed.stats.parseErrors,
        unsequenced: parsed.stats.unsequenced,
        duplicateOrReplay: parsed.stats.duplicateOrReplay,
        outOfOrder: parsed.stats.outOfOrder
      },
      stats: {
        parseErrors: parsed.stats.parseErrors,
        unsequenced: parsed.stats.unsequenced,
        duplicateOrReplay: parsed.stats.duplicateOrReplay,
        outOfOrder: parsed.stats.outOfOrder,
        gaps: parsed.stats.gaps,
        heartbeatFrames: parsed.stats.heartbeatFrames,
        heartbeatCounterMissing: parsed.stats.heartbeatCounterMissing,
        heartbeatCounterGaps: parsed.stats.heartbeatCounterGaps,
        heartbeatCounterOutOfOrder: parsed.stats.heartbeatCounterOutOfOrder
      },
      frameEvidence: parsed.frameEvidence,
      provenance: {
        ...parsed.provenance,
        pctClean: parsed.provenance.totalEvents
          ? Number((parsed.provenance.cleanEvents / parsed.provenance.totalEvents * 100).toFixed(6))
          : 0
      }
    };
  } catch {
    return null;
  }
}

function manifestIntegrityReasons({ manifest, rawFrameArchive, derivedFromArchive }) {
  const reasons = [];
  const digest = manifest.frameEvidence?.rawFrameSha256;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    reasons.push("frameEvidence.rawFrameSha256 is missing or invalid");
  }
  if (rawFrameArchive.verified !== true) {
    reasons.push(`raw frame archive is not verified: ${rawFrameArchive.reason || "unknown"}`);
  }
  if ((manifest.counts?.frames ?? manifest.framesInput ?? 0) <= 0) {
    reasons.push("manifest has no input frames");
  }
  if (derivedFromArchive) {
    if ((manifest.counts?.frames ?? manifest.framesInput ?? 0) !== derivedFromArchive.frames) {
      reasons.push("manifest frame count does not match archive");
    }
    if ((manifest.counts?.gaps ?? 0) !== derivedFromArchive.stats.gaps ||
        (Array.isArray(manifest.gaps) ? manifest.gaps.length : 0) !== derivedFromArchive.stats.gaps) {
      reasons.push("manifest gap count does not match archive");
    }
    if (!deepEqual(manifest.frameEvidence || null, derivedFromArchive.frameEvidence)) {
      reasons.push("manifest frameEvidence does not match archive");
    }
    if (!deepEqual(normalizeManifestCounts(manifest.counts), derivedFromArchive.counts)) {
      reasons.push("manifest counts do not match archive");
    }
    if (!deepEqual(manifest.provenance || null, derivedFromArchive.provenance)) {
      reasons.push("manifest provenance does not match archive");
    }
  }
  return reasons;
}

function normalizeManifestCounts(counts = {}) {
  return {
    ticks: counts.ticks ?? 0,
    l2: counts.l2 ?? 0,
    trades: counts.trades ?? 0,
    candles: counts.candles ?? 0,
    heartbeats: counts.heartbeats ?? 0,
    gaps: counts.gaps ?? 0,
    frames: counts.frames ?? 0,
    parseErrors: counts.parseErrors ?? 0,
    unsequenced: counts.unsequenced ?? 0,
    duplicateOrReplay: counts.duplicateOrReplay ?? 0,
    outOfOrder: counts.outOfOrder ?? 0
  };
}

function deepEqual(left, right) {
  return stableJson(left) === stableJson(right);
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
  return args;
}

async function main() {
  const result = await stage1ManifestAudit(parseArgs());
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
