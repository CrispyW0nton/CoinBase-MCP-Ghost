import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRawFrameArchive } from "./stage1-frame-evidence.js";

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
    const reasons = manifestIntegrityReasons({ manifest, rawFrameArchive });
    manifests.push({
      file: path.relative(process.cwd(), file),
      status: manifest.status || null,
      source: manifest.source || null,
      dataQuality: manifest.dataQuality || null,
      frames: manifest.counts?.frames ?? manifest.framesInput ?? 0,
      frameEvidence: manifest.frameEvidence || null,
      rawFrameArchive,
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

function manifestIntegrityReasons({ manifest, rawFrameArchive }) {
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
  return reasons;
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
