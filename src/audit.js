// src/audit.js
// ---------------------------------------------------------------------------
// Stage 0 data audit: no Chrome, no Coinbase network, no trading.
//
// The goal is operational honesty before any IC measurement: summarize journal
// readiness, recording manifests, provenance quarantine, and legacy/unusable
// rows. Grinold-Kahn's breadth framing informs the readiness gate; Lopez de
// Prado and Kahneman motivate refusing research conclusions from dirty or
// undersized samples; Taleb motivates treating missing provenance as a hard
// tail-risk input, not a nuisance field.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { datasetStatus } from "./replay.js";

async function walk(dir, predicate = () => true) {
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
  } catch (err) {
    return { parseError: err.message };
  }
}

async function inspectRecordings({ recordingsDir = "recordings" } = {}) {
  const files = await walk(path.resolve(process.cwd(), recordingsDir), p => path.basename(p) === "manifest.json");
  const manifests = [];
  for (const file of files) {
    const manifest = await readJson(file);
    manifests.push({
      file: path.relative(process.cwd(), file),
      status: manifest.status ?? null,
      recording: manifest.recording === true,
      symbol: manifest.symbol ?? null,
      startedAt: manifest.startedAt ?? null,
      endedAt: manifest.endedAt ?? null,
      samples: manifest.counts?.samples ?? 0,
      events: eventCount(manifest.counts),
      journalRejected: manifest.counts?.journalRejected ?? manifest.journalStats?.rejected ?? 0,
      disconnects: Array.isArray(manifest.disconnects) ? manifest.disconnects.length : 0,
      source: manifest.source ?? null,
      dataQuality: manifest.dataQuality ?? null,
      provenance: manifest.provenance ?? null
    });
  }
  return {
    recordingsDir,
    manifests,
    count: manifests.length,
    active: manifests.filter(m => m.recording).length,
    totalEvents: manifests.reduce((sum, m) => sum + m.events, 0),
    totalRejected: manifests.reduce((sum, m) => sum + m.journalRejected, 0),
    totalDisconnects: manifests.reduce((sum, m) => sum + m.disconnects, 0)
  };
}

function eventCount(counts = {}) {
  return (counts.ticks || 0) + (counts.l2 || 0) + (counts.trades || 0) + (counts.candles || 0) + (counts.signals || 0);
}

async function inspectQuarantine({ journalDir = "journal", quarantineDir } = {}) {
  const dir = path.resolve(process.cwd(), quarantineDir || path.join(journalDir, "_quarantine"));
  const files = await walk(dir, p => p.endsWith(".jsonl"));
  const byReason = {};
  let lines = 0;
  let invalid = 0;
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines++;
      try {
        const row = JSON.parse(line);
        const reason = row.reason || "unknown";
        byReason[reason] = (byReason[reason] || 0) + 1;
      } catch {
        invalid++;
      }
    }
  }
  return {
    quarantineDir: path.relative(process.cwd(), dir) || ".",
    files: files.map(file => path.relative(process.cwd(), file)),
    rows: lines,
    invalid,
    byReason
  };
}

export async function dataAudit(args = {}) {
  const generatedAt = new Date().toISOString();
  const status = await datasetStatus(args);
  const recordings = await inspectRecordings(args);
  const quarantine = await inspectQuarantine(args);
  const legacyRows = status.inventory.legacyUnusable || 0;
  const cleanRows = Math.max(0, status.inventory.events - legacyRows);
  const audit = {
    generatedAt,
    stage: "Stage 0 - Data Sufficiency",
    gate: status.readiness.verdict,
    symbol: status.symbol,
    dataset: status,
    recordings,
    quarantine,
    migration: {
      totalRows: status.inventory.events,
      cleanRows,
      legacyUnusableRows: legacyRows,
      note: legacyRows > 0
        ? "Do not retro-fabricate provenance. Treat legacy/missing-provenance rows as audit-only and exclude them from research windows."
        : "No legacy/missing-provenance rows in the selected dataset."
    }
  };
  if (args.writeReport !== false) {
    audit.reportPath = await writeAuditReport(audit, args);
  }
  return audit;
}

export async function writeAuditReport(audit, { outputDir = "research" } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = audit.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(outputDir, `DATA_AUDIT_${stamp}.md`);
  await fs.writeFile(reportPath, buildReport(audit), "utf8");
  return reportPath;
}

function buildReport(audit) {
  const status = audit.dataset;
  const inv = status.inventory;
  const ready = status.readiness;
  const manifests = audit.recordings.manifests.length
    ? audit.recordings.manifests.map(m => `- \`${m.file}\`: status=${m.status ?? "unknown"}, events=${m.events}, rejected=${m.journalRejected}, disconnects=${m.disconnects}, quality=${m.dataQuality ?? "unknown"}`).join("\n")
    : "- No recording manifests found.";
  const quarantine = audit.quarantine.rows
    ? Object.entries(audit.quarantine.byReason).map(([reason, count]) => `- ${count} x ${reason}`).join("\n")
    : "- No quarantined rows found.";
  return `# Stage 0 Data Audit - ${audit.symbol}

Generated: ${audit.generatedAt}

## Gate

Stage: **${audit.stage}**  
Dataset status: **${audit.gate}**

Reasons:
${ready.reasons.length ? ready.reasons.map(reason => `- ${reason}`).join("\n") : "- All Stage 0 readiness thresholds satisfied."}

## Journal Inventory

- Events: ${inv.events}
- Paired observations: ${status.pairedObservations}
- Effective breadth: ${ready.effectiveBreadth}
- Test observations: ${ready.testObservations}
- Clean provenance: ${inv.pctCleanProvenance}%
- Legacy/unusable rows: ${inv.legacyUnusable}
- Source breakdown: \`${JSON.stringify(inv.bySource)}\`
- Confidence breakdown: \`${JSON.stringify(inv.byConfidence)}\`
- Data-quality ceiling: **${inv.dataQualityCeiling}**

Migration note: ${audit.migration.note}

## Recording Manifests

${manifests}

Totals: manifests=${audit.recordings.count}, active=${audit.recordings.active}, events=${audit.recordings.totalEvents}, rejected=${audit.recordings.totalRejected}, disconnects=${audit.recordings.totalDisconnects}

## Quarantine

Directory: \`${audit.quarantine.quarantineDir}\`  
Rows: ${audit.quarantine.rows}

${quarantine}

## Stage 0 Policy

Do not run Stage A edge measurement until dataset status is READY: ${ready.minPairedObservations} paired observations, ${ready.minEffectiveBreadth} effective independent observations after autocorrelation discounting, ${ready.minTestObservations} chronological test observations, and 0 legacy/missing-provenance rows. DOM data remains low-confidence even when plentiful.
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
  for (const key of ["horizonSeconds", "horizonObservations", "depthLevels", "trainFraction"]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  return args;
}

async function main() {
  const audit = await dataAudit(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    stage: audit.stage,
    gate: audit.gate,
    symbol: audit.symbol,
    events: audit.dataset.inventory.events,
    pairedObservations: audit.dataset.pairedObservations,
    cleanProvenancePct: audit.dataset.inventory.pctCleanProvenance,
    legacyUnusableRows: audit.dataset.inventory.legacyUnusable,
    recordingManifests: audit.recordings.count,
    quarantinedRows: audit.quarantine.rows,
    reportPath: audit.reportPath
  }, null, 2));
}

const thisFile = pathToFileURL(fileURLToPath(import.meta.url)).href;
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === thisFile) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
