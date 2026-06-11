import fs from "node:fs/promises";
import path from "node:path";
import { validateJournalProvenance } from "./journal.js";
import { stableJsonDigest } from "./stage1-frame-evidence.js";

export async function inspectStage1ManifestJournal({ manifest }) {
  const journalPath = manifest.journalPath || manifest.journalStats?.path;
  if (!journalPath || typeof journalPath !== "string") {
    return {
      present: false,
      path: null,
      rows: 0,
      invalid: 0,
      symbolRows: 0,
      cleanWsRows: 0,
      appendWindow: {
        present: false,
        verified: false,
        reason: "journal append evidence missing"
      },
      reason: "journal path missing"
    };
  }
  const resolved = path.resolve(process.cwd(), journalPath);
  const evidence = {
    present: true,
    path: path.relative(process.cwd(), resolved),
    rows: 0,
    invalid: 0,
    symbolRows: 0,
    cleanWsRows: 0,
    appendWindow: {
      present: false,
      verified: false,
      reason: "journal append evidence missing"
    },
    reason: null
  };
  try {
    const text = await fs.readFile(resolved, "utf8");
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      evidence.rows++;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        evidence.invalid++;
        events.push(null);
        continue;
      }
      events.push(event);
      if (event.symbol !== manifest.symbol) continue;
      evidence.symbolRows++;
      const provenance = validateJournalProvenance(event);
      if (provenance.ok &&
          event.source === "ws" &&
          event.confidence === "high" &&
          event.hasSequence === true &&
          event.degraded === false) {
        evidence.cleanWsRows++;
      }
    }
    evidence.appendWindow = verifyStage1JournalAppendWindow({ manifest, events, journalPath: resolved });
    return evidence;
  } catch (err) {
    return {
      ...evidence,
      present: false,
      reason: `journal unreadable: ${err.message}`
    };
  }
}

export function verifyStage1JournalAppendWindow({ manifest, events, journalPath }) {
  const append = manifest.journalAppendEvidence;
  if (!append || typeof append !== "object") {
    return {
      present: false,
      verified: false,
      reason: "journal append evidence missing"
    };
  }
  const startLine = Number(append.startLine);
  const endLine = Number(append.endLine);
  const rows = Number(append.rows);
  const expectedSha = append.sha256;
  const appendPath = typeof append.path === "string"
    ? path.resolve(process.cwd(), append.path)
    : null;
  const reasons = [];
  if (appendPath !== journalPath) reasons.push("journal append path does not match manifest journalPath");
  if (!Number.isSafeInteger(startLine) || startLine < 1) reasons.push("journal append startLine is invalid");
  if (!Number.isSafeInteger(endLine) || endLine < startLine - 1) reasons.push("journal append endLine is invalid");
  if (!Number.isSafeInteger(rows) || rows < 0) reasons.push("journal append row count is invalid");
  if (typeof expectedSha !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    reasons.push("journal append sha256 is missing or invalid");
  }
  const windowEvents = reasons.length ? [] : events.slice(startLine - 1, endLine);
  const actualSha = stableJsonDigest(windowEvents);
  if (!reasons.length && windowEvents.length !== rows) {
    reasons.push("journal append window row count does not match evidence");
  }
  if (!reasons.length && actualSha !== expectedSha) {
    reasons.push("journal append window digest does not match evidence");
  }
  return {
    present: true,
    verified: reasons.length === 0,
    pathMatches: appendPath === journalPath,
    startLine,
    endLine,
    rows: windowEvents.length,
    expectedRows: rows,
    sha256: actualSha,
    expectedSha,
    reason: reasons.length ? reasons.join("; ") : null
  };
}
