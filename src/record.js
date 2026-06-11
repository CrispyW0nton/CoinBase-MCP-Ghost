// src/record.js
// ---------------------------------------------------------------------------
// CLI wrapper for Stage 0 long OBSERVE recording.
//
// This intentionally calls the same no-click DOM recorder exposed as
// `coinbase_record`. It does not add a Coinbase REST/SDK client, credentials,
// sockets, or any execution path. It exists so Stage 0 can accumulate auditable
// data without requiring an MCP client.
// ---------------------------------------------------------------------------

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { record } from "./coinbase.js";

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
  for (const key of ["durationMs", "sampleIntervalMs", "healthIntervalMs"]) {
    if (args[key] !== undefined && args[key] !== true) args[key] = Number(args[key]);
  }
  if (typeof args.urlContains === "string" && args.urlContains.includes(",")) {
    args.urlContains = args.urlContains.split(",").map(s => s.trim()).filter(Boolean);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await record(args);
  console.log(JSON.stringify({
    recorded: result.recorded,
    manifestPath: result.manifestPath,
    journalPath: result.journalPath,
    counts: result.counts,
    provenance: result.provenance,
    disconnects: result.disconnects.length,
    journalStats: result.journalStats
  }, null, 2));
}

const thisFile = pathToFileURL(fileURLToPath(import.meta.url)).href;
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === thisFile) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
