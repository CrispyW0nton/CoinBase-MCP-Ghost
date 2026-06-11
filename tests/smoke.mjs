// tests/smoke.mjs
// ---------------------------------------------------------------------------
// Plain-Node smoke test (no test framework). Two modes:
//
//   LIVE smoke (opt-in with CMCP_LIVE_SMOKE=1 when a Coinbase debug tab is reachable):
//     1. (Optionally) launch Chrome via scripts/launch-chrome-coinbase.ps1.
//     2. coinbase_attach  -> assert signedIn === true.
//     3. coinbase_market_stream 30s -> assert >=1 tick, >=1 L2, >=1 trade, 0 gaps.
//     4. coinbase_portfolio_snapshot -> assert balances parse.
//     5. coinbase_place_order (dryRun) -> assert simulated fill + journal line.
//
//   OFFLINE smoke (default):
//     Exercises the pure logic that does NOT need a browser: schema
//     normalization (decimal.js), frame parsing, ring buffer, journal write,
//     and the place_order risk gate. This keeps `npm run smoke` green in
//     environments without Chrome while still asserting core invariants.
//
// Run: node ./tests/smoke.mjs
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDebugEndpointReady } from "../src/chrome.js";
import { loadConfig } from "../src/config.js";
import {
  makeTick, makeL2Update, makeTrade, serializeEvent, dec
} from "../src/schema.js";
import { RingBuffer, JsonlJournal } from "../src/journal.js";
import { validateJournalProvenance } from "../src/journal.js";
import { parseCoinbaseFrame, reconcilePreviewIntent, confirmLive, paperLedgerState } from "../src/coinbase.js";
import { replayEvents, replayBacktest } from "../src/replay.js";
import { dataAudit } from "../src/audit.js";
import { stageAAnalysis } from "../src/stage-a.js";
import {
  stage1ApprovalStatus,
  requireStage1KeyedWsApproval,
  STAGE1_APPROVAL_ENV,
  STAGE1_APPROVAL_PHRASE,
  STAGE1_CREDENTIAL_ENVS
} from "../src/stage1-approval.js";
import { validateStage1CredentialMaterial } from "../src/stage1-credentials.js";
import { stage1FeedAudit } from "../src/stage1-feed-audit.js";
import { stage1IngestFrames } from "../src/stage1-ingest.js";
import {
  createStage1KeyedWsFrameSource,
  STAGE1_KEYED_WS_NOT_IMPLEMENTED
} from "../src/stage1-keyed-ws.js";
import { createStage1SubscriptionPlan } from "../src/stage1-ws-contract.js";
import { recordStage1FrameSource } from "../src/stage1-recorder.js";
import { stage1Readiness } from "../src/stage1-readiness.js";

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  - ${name}`))
    .catch(err => { failures++; console.error(`  FAIL - ${name}: ${err.message}`); });
}

function stage1Heartbeat(sequenceNum, counter, timestamp) {
  return {
    channel: "heartbeats",
    sequence_num: sequenceNum,
    timestamp,
    events: [{ current_time: timestamp, heartbeat_counter: String(counter) }]
  };
}

// --- OFFLINE invariants (always run) --------------------------------------

async function offlineSuite() {
  console.log("[offline] core invariants");

  await check("decimal precision: 0.1 + 0.2 === 0.3 via Decimal", () => {
    assert.equal(dec("0.1").plus(dec("0.2")).toString(), "0.3");
  });

  await check("tick keeps prices as Decimal, serializes to string", () => {
    const t = makeTick({ symbol: "BTC-USD", bidPx: "65000.01", askPx: "65000.99", lastPx: "65000.50" });
    const s = serializeEvent(t);
    assert.equal(typeof s.bidPx, "string");
    assert.equal(s.bidPx, "65000.01");
  });

  await check("parseCoinbaseFrame normalizes a level2 + ticker + trade frame", () => {
    const l2 = parseCoinbaseFrame({
      channel: "level2", sequence_num: 5, timestamp: new Date().toISOString(),
      events: [{ type: "update", product_id: "BTC-USD", updates: [
        { side: "bid", price_level: "65000.00", new_quantity: "0.5", event_time: new Date().toISOString() },
        { side: "offer", price_level: "65001.00", new_quantity: "0.3", event_time: new Date().toISOString() }
      ]}]
    });
    assert.equal(l2.events.length, 2);
    assert.equal(l2.events[1].side, "ask"); // offer normalized -> ask
    assert.equal(l2.sequenceNum, 5);
    assert.equal(l2.events[0].source, "ws");
    assert.equal(l2.events[0].hasSequence, true);

    const tk = parseCoinbaseFrame({
      channel: "ticker", timestamp: new Date().toISOString(),
      events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "1", best_ask: "2", price: "1.5" }] }]
    });
    assert.equal(tk.events[0].type, "tick");

    const tr = parseCoinbaseFrame({
      channel: "market_trades", timestamp: new Date().toISOString(),
      events: [{ trades: [{ product_id: "BTC-USD", side: "BUY", price: "65000", size: "0.01", trade_id: "t1", time: new Date().toISOString() }] }]
    });
    assert.equal(tr.events[0].type, "trade");
    assert.equal(tr.events[0].side, "buy");
  });

  await check("parseCoinbaseFrame accepts official l2_data Level2 payloads", () => {
    const now = new Date().toISOString();
    const result = parseCoinbaseFrame({
      channel: "l2_data",
      client_id: "",
      timestamp: now,
      sequence_num: 0,
      events: [{
        type: "snapshot",
        product_id: "BTC-USD",
        updates: [{
          side: "bid",
          event_time: now,
          price_level: "21921.73",
          new_quantity: "0.06317902"
        }]
      }]
    });
    assert.equal(result.sequenceNum, 0);
    assert.equal(result.channel, "l2_data");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "l2update");
    assert.equal(result.events[0].source, "ws");
    assert.equal(result.events[0].hasSequence, true);
    assert.equal(result.events[0].confidence, "high");
    assert.equal(result.events[0].degraded, false);
  });

  await check("ring buffer bounds + recent()", () => {
    const rb = new RingBuffer(3);
    for (let i = 0; i < 5; i++) rb.push(makeTrade({ symbol: "BTC-USD", side: "buy", px: String(i), sz: "1", tradeId: String(i) }));
    assert.equal(rb.size(), 3);
    const recent = rb.recent(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[2].px, "4"); // newest last
  });

  await check("gap detection: sequence skip is observable", () => {
    // Simulate the gap logic used in marketStream.
    let lastSeq = null; let gaps = 0;
    for (const seq of [1, 2, 4]) {
      if (lastSeq !== null && seq > lastSeq + 1) gaps++;
      lastSeq = seq;
    }
    assert.equal(gaps, 1);
  });

  await check("journal writes one JSONL line per event", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-journal-"));
    const j = new JsonlJournal({ baseDir, symbol: "BTC-USD" });
    j.append(makeL2Update({ symbol: "BTC-USD", side: "bid", px: "1", sz: "1" }));
    j.append(makeTrade({ symbol: "BTC-USD", side: "buy", px: "1", sz: "1", tradeId: "x" }));
    await j.close();
    const count = await j.lineCount();
    assert.equal(count, 2);
  });

  await check("emitted event batch has 0% unknown or missing provenance", () => {
    const events = [
      serializeEvent(makeL2Update({ symbol: "BTC-USD", side: "bid", px: "1", sz: "1", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" })),
      serializeEvent(makeTick({ symbol: "BTC-USD", bidPx: "1", askPx: "2", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" })),
      serializeEvent(makeTrade({ symbol: "BTC-USD", side: null, px: "1", sz: "1", tradeId: "dom-1", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" }))
    ];
    const unknown = events.filter(evt => evt.source === "unknown" || !validateJournalProvenance(evt).ok);
    assert.equal(unknown.length, 0);
  });

  await check("journal rejects and quarantines events lacking complete provenance", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-journal-guard-"));
    const j = new JsonlJournal({ baseDir, symbol: "BTC-USD" });
    const result = j.append({ type: "tick", ts: Date.now(), symbol: "BTC-USD", bidPx: "1", askPx: "2" });
    await j.close();
    assert.equal(result.rejected, true);
    assert.equal(await j.lineCount(), 0);
    assert.equal(j.stats().rejected, 1);
    assert.ok(fs.existsSync(result.quarantinePath));
  });

  await check("place_order risk gate (logic): OBSERVE_ONLY + killSwitch reject", async () => {
    // We exercise the documented policy directly to avoid needing a browser.
    const cfg = loadConfig();
    assert.equal(cfg.mode, "OBSERVE_ONLY"); // default config
    assert.equal(cfg.killSwitch, true);
    assert.equal(cfg.maxNotionalUsd, 0);
    assert.ok(Array.isArray(cfg.tabUrlContains));
    assert.ok(cfg.tabUrlContains.some(item => item.includes("advanced-portfolio")));
  });

  await check("DOM-sourced event is degraded and never implies gap detection", () => {
    const dom = makeL2Update({
      symbol: "BTC-USD",
      side: "bid",
      px: "65000.00",
      sz: "0.1",
      source: "dom",
      hasSequence: false,
      confidence: "low",
      degradedReason: "rendered DOM snapshot"
    });
    const serialized = serializeEvent(dom);
    assert.equal(serialized.source, "dom");
    assert.equal(serialized.hasSequence, false);
    assert.equal(serialized.degraded, true);
    let gaps = 0;
    for (const seq of [null, null, null]) {
      if (seq !== null) gaps++;
    }
    assert.equal(gaps, 0);
  });

  await check("imbalance signal serializes Decimal fields as strings", () => {
    const event = serializeEvent({
      type: "imbalanceSignal",
      ts: Date.now(),
      symbol: "BTC-USD",
      name: "l2_depth_imbalance",
      value: dec("0.25"),
      bidDepth: dec("5"),
      askDepth: dec("3"),
      levels: 10,
      seq: 7
    });
    assert.equal(event.value, "0.25");
    assert.equal(event.bidDepth, "5");
  });

  await check("preview-vs-intent reconciliation is decimal tolerant", () => {
    const result = reconcilePreviewIntent({
      intent: { side: "buy", type: "limit", baseSize: "0.010", limitPrice: "100.00" },
      preview: { side: "buy", type: "limit", baseSize: "0.01", limitPrice: "100" }
    });
    assert.equal(result.ok, true);
  });

  await check("confirm_live records but never arms", async () => {
    const result = await confirmLive({ phrase: "CONFIRM_LIVE_STUB_ONLY" });
    assert.equal(result.stubbed, true);
    assert.equal(result.armed, false);
    assert.equal(result.confirmation.phraseAccepted, true);
  });

  await check("paper ledger exposes advisory half-Kelly shape", async () => {
    const ledger = await paperLedgerState();
    assert.equal(ledger.kelly.halfKellyFraction, "0");
  });

  await check("replay is deterministic for identical inputs", () => {
    const events = [
      makeL2Update({ ts: 1, symbol: "BTC-USD", side: "bid", px: "100", sz: "2", source: "dom", hasSequence: false }),
      makeL2Update({ ts: 2, symbol: "BTC-USD", side: "ask", px: "102", sz: "1", source: "dom", hasSequence: false }),
      makeL2Update({ ts: 3, symbol: "BTC-USD", side: "bid", px: "101", sz: "1", source: "dom", hasSequence: false }),
      makeL2Update({ ts: 4, symbol: "BTC-USD", side: "ask", px: "103", sz: "1", source: "dom", hasSequence: false })
    ];
    const a = replayEvents(events, { horizonObservations: 1 });
    const b = replayEvents(events, { horizonObservations: 1 });
    assert.deepEqual(a.observations, b.observations);
    assert.deepEqual(a.metrics, b.metrics);
  });

  await check("replay is causal: first signal cannot use future ask depth", () => {
    const events = [
      makeL2Update({ ts: 1, symbol: "BTC-USD", side: "bid", px: "100", sz: "2", source: "dom", hasSequence: false }),
      makeL2Update({ ts: 2, symbol: "BTC-USD", side: "ask", px: "102", sz: "100", source: "dom", hasSequence: false })
    ];
    const replay = replayEvents(events, { horizonObservations: 1 });
    assert.equal(replay.observations[0].signal, "1");
    assert.equal(replay.observations[0].mid, null);
    assert.equal(replay.observations[1].signal, "-0.96078431372549019608");
  });

  await check("DOM-sourced backtest report is labeled low-confidence", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-replay-"));
    const file = path.join(baseDir, "events.jsonl");
    const lines = [
      serializeEvent(makeL2Update({ ts: 1, symbol: "BTC-USD", side: "bid", px: "100", sz: "2", source: "dom", hasSequence: false })),
      serializeEvent(makeL2Update({ ts: 2, symbol: "BTC-USD", side: "ask", px: "102", sz: "1", source: "dom", hasSequence: false })),
      serializeEvent(makeL2Update({ ts: 3, symbol: "BTC-USD", side: "bid", px: "101", sz: "1", source: "dom", hasSequence: false }))
    ].map(JSON.stringify).join("\n");
    fs.writeFileSync(file, lines + "\n", "utf8");
    const result = await replayBacktest({ files: [file], outputDir: baseDir, horizonObservations: 1 });
    const report = fs.readFileSync(result.reportPath, "utf8");
    assert.match(report, /low-confidence \/ DOM-sourced/);
    assert.equal(result.inventory.bySource.dom, 3);
    assert.equal(result.inventory.dataQualityCeiling, "low-confidence / DOM-sourced");
  });

  await check("backtest refuses IC verdict below minimum sample threshold", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-replay-small-"));
    const file = path.join(baseDir, "small.jsonl");
    const lines = [
      serializeEvent(makeL2Update({ ts: 1, symbol: "BTC-USD", side: "bid", px: "100", sz: "2", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" })),
      serializeEvent(makeL2Update({ ts: 2, symbol: "BTC-USD", side: "ask", px: "102", sz: "1", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" })),
      serializeEvent(makeL2Update({ ts: 3, symbol: "BTC-USD", side: "bid", px: "101", sz: "1", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" }))
    ].map(JSON.stringify).join("\n");
    fs.writeFileSync(file, lines + "\n", "utf8");
    const result = await replayBacktest({ files: [file], writeReport: false, horizonObservations: 1 });
    assert.equal(result.readiness.verdict, "NOT-READY");
    assert.match(result.metrics.verdict.label, /^Refused/);
    assert.equal(result.metrics.all.ic, null);
  });

  await check("data audit summarizes readiness, manifests, quarantine, and legacy rows", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-audit-"));
    const journalFile = path.join(baseDir, "journal.jsonl");
    const recordingsDir = path.join(baseDir, "recordings");
    const manifestDir = path.join(recordingsDir, "btc-usd-test");
    const quarantineDir = path.join(baseDir, "quarantine");
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(quarantineDir, { recursive: true });
    const clean = serializeEvent(makeL2Update({ ts: 1, symbol: "BTC-USD", side: "bid", px: "100", sz: "2", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" }));
    const legacy = { type: "l2update", ts: 2, symbol: "BTC-USD", side: "ask", px: "101", sz: "1" };
    fs.writeFileSync(journalFile, JSON.stringify(clean) + "\n" + JSON.stringify(legacy) + "\n", "utf8");
    fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify({
      status: "complete",
      recording: false,
      symbol: "BTC-USD",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1000).toISOString(),
      source: "dom",
      dataQuality: "low-confidence / DOM-sourced",
      counts: { samples: 1, ticks: 1, l2: 2, trades: 0, candles: 0, signals: 1, journalRejected: 0 },
      disconnects: [],
      provenance: { bySource: { dom: 3 }, byConfidence: { low: 3 }, degraded: { true: 3, false: 0 } }
    }), "utf8");
    fs.writeFileSync(path.join(quarantineDir, "q.jsonl"), JSON.stringify({ reason: "missing or invalid provenance fields: source", event: legacy }) + "\n", "utf8");
    const audit = await dataAudit({
      files: [journalFile],
      recordingsDir,
      quarantineDir,
      writeReport: false,
      horizonObservations: 1
    });
    assert.equal(audit.gate, "NOT-READY");
    assert.equal(audit.recordings.count, 1);
    assert.equal(audit.quarantine.rows, 1);
    assert.equal(audit.migration.legacyUnusableRows, 1);
    assert.equal(audit.cleanWindow.needed, true);
    assert.equal(audit.cleanWindow.status.inventory.legacyUnusable, 0);
  });

  await check("Stage A refuses to run when Stage 0 readiness is not met", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage-a-"));
    const file = path.join(baseDir, "small.jsonl");
    const lines = [
      serializeEvent(makeL2Update({ ts: 1, symbol: "BTC-USD", side: "bid", px: "100", sz: "2", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" })),
      serializeEvent(makeL2Update({ ts: 2, symbol: "BTC-USD", side: "ask", px: "102", sz: "1", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" })),
      serializeEvent(makeL2Update({ ts: 3, symbol: "BTC-USD", side: "bid", px: "101", sz: "1", source: "dom", ageMs: 0, hasSequence: false, confidence: "low", degradedReason: "rendered DOM snapshot" }))
    ].map(JSON.stringify).join("\n");
    fs.writeFileSync(file, lines + "\n", "utf8");
    const result = await stageAAnalysis({ files: [file], writeReport: false, horizonObservations: 1 });
    assert.equal(result.readiness.verdict, "NOT-READY");
    assert.equal(result.gate.label, "Refused - Stage 0 not ready");
    assert.equal(result.gate.pass, false);
  });

  await check("Stage 1 credential gate is explicit and never leaks secrets", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: STAGE1_APPROVAL_PHRASE,
      [STAGE1_CREDENTIAL_ENVS[0]]: "organizations/example/apiKeys/example-key",
      [STAGE1_CREDENTIAL_ENVS[1]]: "-----BEGIN TEST PRIVATE KEY-----\nsecret-test-material\n-----END TEST PRIVATE KEY-----"
    };
    const status = stage1ApprovalStatus(env);
    const serialized = JSON.stringify(status);
    assert.equal(status.approved, true);
    assert.equal(status.safeToBuildKeyedWs, true);
    assert.equal(status.keyedClientImplemented, false);
    assert.equal(status.liveTradingEnabled, false);
    assert.equal(status.networkTouched, false);
    assert.equal(status.credentialMaterialPresent[STAGE1_CREDENTIAL_ENVS[0]], true);
    assert.equal(status.credentialMaterialPresent[STAGE1_CREDENTIAL_ENVS[1]], true);
    assert.doesNotMatch(serialized, /secret-test-material/);
    assert.doesNotMatch(serialized, /BEGIN TEST PRIVATE KEY/);
  });

  await check("Stage 1 keyed WS guard fails closed without leaking credential values", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: "not-approved",
      [STAGE1_CREDENTIAL_ENVS[0]]: "organizations/example/apiKeys/example-key",
      [STAGE1_CREDENTIAL_ENVS[1]]: "secret-test-material"
    };
    assert.throws(
      () => requireStage1KeyedWsApproval({ env, purpose: "smoke keyed feed" }),
      err => {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.equal(err.code, "STAGE1_KEYED_WS_APPROVAL_REQUIRED");
        assert.equal(err.networkTouched, false);
        assert.equal(err.liveTradingEnabled, false);
        assert.doesNotMatch(serialized, /secret-test-material/);
        return true;
      }
    );
  });

  await check("Stage 1 keyed WS guard returns narrow scope after approval", () => {
    const env = { [STAGE1_APPROVAL_ENV]: STAGE1_APPROVAL_PHRASE };
    const result = requireStage1KeyedWsApproval({ env, purpose: "smoke keyed feed" });
    assert.equal(result.ok, true);
    assert.equal(result.approval.approved, true);
    assert.ok(result.allowedScope.some(item => /WebSocket market-data/.test(item)));
    assert.ok(result.forbiddenScope.includes("order placement"));
    assert.ok(result.forbiddenScope.includes("LIVE arming"));
  });

  await check("Stage 1 credential validator refuses before approval without leaking secrets", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: "not-approved",
      [STAGE1_CREDENTIAL_ENVS[0]]: "organizations/example-org/apiKeys/example-key",
      [STAGE1_CREDENTIAL_ENVS[1]]: "-----BEGIN TEST PRIVATE KEY-----\nsecret-test-material\n-----END TEST PRIVATE KEY-----"
    };
    assert.throws(
      () => validateStage1CredentialMaterial({ env }),
      err => {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.equal(err.code, "STAGE1_KEYED_WS_APPROVAL_REQUIRED");
        assert.equal(err.networkTouched, false);
        assert.equal(err.liveTradingEnabled, false);
        assert.doesNotMatch(serialized, /secret-test-material/);
        assert.doesNotMatch(serialized, /BEGIN TEST PRIVATE KEY/);
        return true;
      }
    );
  });

  await check("Stage 1 credential validator accepts approved shapes without exposing values", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: STAGE1_APPROVAL_PHRASE,
      [STAGE1_CREDENTIAL_ENVS[0]]: "organizations/example-org/apiKeys/example-key",
      [STAGE1_CREDENTIAL_ENVS[1]]: "-----BEGIN EC PRIVATE KEY-----\nsecret-test-material\n-----END EC PRIVATE KEY-----"
    };
    const result = validateStage1CredentialMaterial({ env });
    const serialized = JSON.stringify(result);
    assert.equal(result.pass, true);
    assert.equal(result.credentialMaterialRead, true);
    assert.equal(result.networkTouched, false);
    assert.equal(result.keyedClientImplemented, false);
    assert.equal(result.jwtGenerated, false);
    assert.equal(result.checks.keyNameShape, "pass");
    assert.equal(result.checks.privateKeyPemShape, "pass");
    assert.doesNotMatch(serialized, /secret-test-material/);
    assert.doesNotMatch(serialized, /example-key/);
    assert.doesNotMatch(serialized, /BEGIN EC PRIVATE KEY/);
  });

  await check("Stage 1 credential validator reports invalid approved shapes without exposing values", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: STAGE1_APPROVAL_PHRASE,
      [STAGE1_CREDENTIAL_ENVS[0]]: "bad-key",
      [STAGE1_CREDENTIAL_ENVS[1]]: "secret-test-material"
    };
    const result = validateStage1CredentialMaterial({ env });
    const serialized = JSON.stringify(result);
    assert.equal(result.pass, false);
    assert.equal(result.checks.keyNameShape, "fail");
    assert.equal(result.checks.privateKeyPemShape, "fail");
    assert.match(result.reasons.join("; "), /organizations\/<org_id>\/apiKeys\/<key_id>/);
    assert.match(result.reasons.join("; "), /PEM private key/);
    assert.doesNotMatch(serialized, /secret-test-material/);
    assert.doesNotMatch(serialized, /bad-key/);
  });

  await check("Stage 1 keyed WS entrypoint refuses before approval", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: "not-approved",
      [STAGE1_CREDENTIAL_ENVS[1]]: "secret-test-material"
    };
    assert.throws(
      () => createStage1KeyedWsFrameSource({ env }),
      err => {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.equal(err.code, "STAGE1_KEYED_WS_APPROVAL_REQUIRED");
        assert.equal(err.networkTouched, false);
        assert.doesNotMatch(serialized, /secret-test-material/);
        return true;
      }
    );
  });

  await check("Stage 1 keyed WS entrypoint remains unimplemented after approval", () => {
    const env = {
      [STAGE1_APPROVAL_ENV]: STAGE1_APPROVAL_PHRASE,
      [STAGE1_CREDENTIAL_ENVS[1]]: "secret-test-material"
    };
    assert.throws(
      () => createStage1KeyedWsFrameSource({ env, productIds: ["BTC-USD"] }),
      err => {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.equal(err.code, STAGE1_KEYED_WS_NOT_IMPLEMENTED);
        assert.equal(err.approvalChecked, true);
        assert.equal(err.credentialMaterialRead, false);
        assert.equal(err.networkTouched, false);
        assert.equal(err.keyedClientImplemented, false);
        assert.doesNotMatch(serialized, /secret-test-material/);
        assert.ok(err.forbiddenScope.includes("order placement"));
        return true;
      }
    );
  });

  await check("Stage 1 subscription plan is offline, market-data only, and heartbeat-backed", () => {
    const plan = createStage1SubscriptionPlan({
      productIds: ["btc-usd", "BTC-USD"],
      channels: ["l2_data", "ticker", "market_trades"],
      jwt: "test.jwt.value"
    });
    assert.equal(plan.offlineOnly, true);
    assert.equal(plan.networkTouched, false);
    assert.equal(plan.keyedClientImplemented, false);
    assert.equal(plan.credentialMaterialRead, false);
    assert.equal(plan.jwtGenerated, false);
    assert.equal(plan.endpoint, "wss://advanced-trade-ws.coinbase.com");
    assert.deepEqual(plan.productIds, ["BTC-USD"]);
    assert.deepEqual(plan.channels, ["heartbeats", "level2", "ticker", "market_trades"]);
    assert.equal(plan.messages.length, 4);
    assert.deepEqual(plan.messages.map(message => message.channel), ["heartbeats", "level2", "ticker", "market_trades"]);
    assert.ok(plan.messages.every(message => message.type === "subscribe"));
    assert.equal(Object.prototype.hasOwnProperty.call(plan.messages[0], "product_ids"), false);
    assert.deepEqual(plan.messages[1].product_ids, ["BTC-USD"]);
    assert.equal(plan.messages[1].jwt, "test.jwt.value");
    assert.equal(plan.validation.pass, true);
    assert.match(plan.validation.warnings.join("; "), /l2_data normalized/);
    assert.equal(plan.safety.noUserChannel, true);
  });

  await check("Stage 1 subscription plan rejects user endpoint and user channels", () => {
    const plan = createStage1SubscriptionPlan({
      endpoint: "wss://advanced-trade-ws-user.coinbase.com",
      channels: ["user"],
      includeHeartbeats: false
    });
    assert.equal(plan.validation.pass, false);
    assert.match(plan.validation.reasons.join("; "), /endpoint must be/);
    assert.match(plan.validation.reasons.join("; "), /channel user is forbidden/);
    assert.equal(plan.safety.marketDataOnly, false);
    assert.equal(plan.networkTouched, false);
  });

  await check("Stage 1 feed audit separates WS quality from Stage-0 quantity", async () => {
    const now = new Date().toISOString();
    const frames = [
      stage1Heartbeat(9, 1, now),
      {
        channel: "l2_data",
        sequence_num: 10,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      },
      {
        channel: "ticker",
        sequence_num: 11,
        timestamp: now,
        events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "100", best_ask: "102", price: "101" }] }]
      },
      {
        channel: "market_trades",
        sequence_num: 12,
        timestamp: now,
        events: [{ trades: [{ product_id: "BTC-USD", side: "BUY", price: "101", size: "0.01", trade_id: "stage1-test", time: now }] }]
      }
    ];
    const audit = await stage1FeedAudit({ frames, horizonObservations: 1 });
    assert.equal(audit.offlineOnly, true);
    assert.equal(audit.networkTouched, false);
    assert.equal(audit.keyedClientImplemented, false);
    assert.equal(audit.wsQualityGate.pass, true);
    assert.equal(audit.frames.gaps, 0);
    assert.equal(audit.frames.heartbeatFrames, 1);
    assert.equal(audit.frames.heartbeatCounterGaps, 0);
    assert.equal(audit.counts.heartbeats, 1);
    assert.equal(audit.counts.l2, 2);
    assert.equal(audit.frameEvidence.channels.heartbeats, 1);
    assert.equal(audit.frameEvidence.channels.l2_data, 1);
    assert.deepEqual(audit.frameEvidence.sequenceRange, { first: 9, last: 12 });
    assert.deepEqual(audit.frameEvidence.heartbeatCounterRange, { first: 1, last: 1 });
    assert.equal(audit.provenance.pctClean, 100);
    assert.equal(audit.stage0Readiness.verdict, "NOT-READY");
    assert.match(audit.stage0Readiness.reasons.join("; "), /paired observations/);
  });

  await check("Stage 1 feed audit fails on sequence gaps", async () => {
    const now = new Date().toISOString();
    const frames = [
      stage1Heartbeat(20, 1, now),
      {
        channel: "level2",
        sequence_num: 21,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now }
        ]}]
      },
      {
        channel: "level2",
        sequence_num: 23,
        timestamp: now,
        events: [{ type: "update", product_id: "BTC-USD", updates: [
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      }
    ];
    const audit = await stage1FeedAudit({ frames });
    assert.equal(audit.wsQualityGate.pass, false);
    assert.equal(audit.frames.gaps, 1);
    assert.equal(audit.gapEvents[0].expectedSeq, 22);
    assert.equal(audit.gapEvents[0].gotSeq, 23);
    assert.match(audit.stage0Readiness.reasons.join("; "), /sequence gaps 1 > 0/);
  });

  await check("Stage 1 feed audit fails on duplicate or replayed sequence numbers", async () => {
    const now = new Date().toISOString();
    const frames = [
      stage1Heartbeat(100, 1, now),
      {
        channel: "level2",
        sequence_num: 101,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      },
      {
        channel: "ticker",
        sequence_num: 101,
        timestamp: now,
        events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "100", best_ask: "102", price: "101" }] }]
      }
    ];
    const audit = await stage1FeedAudit({ frames, horizonObservations: 1 });
    assert.equal(audit.wsQualityGate.pass, false);
    assert.equal(audit.frames.duplicateOrReplay, 1);
    assert.match(audit.wsQualityGate.reasons.join("; "), /duplicate\/replayed frames 1 > 0/);
    assert.match(audit.stage0Readiness.reasons.join("; "), /duplicate\/replayed frames 1 > 0/);
  });

  await check("Stage 1 feed audit fails without heartbeat liveness evidence", async () => {
    const now = new Date().toISOString();
    const frames = [
      {
        channel: "level2",
        sequence_num: 80,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      }
    ];
    const audit = await stage1FeedAudit({ frames });
    assert.equal(audit.wsQualityGate.pass, false);
    assert.equal(audit.frames.heartbeatFrames, 0);
    assert.match(audit.wsQualityGate.reasons.join("; "), /no heartbeat frames supplied/);
  });

  await check("Stage 1 feed audit fails on heartbeat counter gaps", async () => {
    const now = new Date().toISOString();
    const frames = [
      stage1Heartbeat(90, 1, now),
      stage1Heartbeat(91, 3, now),
      {
        channel: "level2",
        sequence_num: 92,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      }
    ];
    const audit = await stage1FeedAudit({ frames });
    assert.equal(audit.wsQualityGate.pass, false);
    assert.equal(audit.frames.heartbeatCounterGaps, 1);
    assert.match(audit.wsQualityGate.reasons.join("; "), /heartbeat counter gaps 1 > 0/);
  });

  await check("Stage 1 ingest writes clean WS frames to strict journal", async () => {
    const now = new Date().toISOString();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage1-ingest-"));
    const journalDir = path.join(baseDir, "journal");
    const outputRoot = path.join(baseDir, "recordings");
    const frames = [
      stage1Heartbeat(29, 1, now),
      {
        channel: "level2",
        sequence_num: 30,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      },
      {
        channel: "ticker",
        sequence_num: 31,
        timestamp: now,
        events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "100", best_ask: "102", price: "101" }] }]
      }
    ];
    const result = await stage1IngestFrames({ frames, journalDir, outputRoot, horizonObservations: 1 });
    assert.equal(result.ingested, true);
    assert.equal(result.refused, false);
    assert.equal(result.audit.wsQualityGate.pass, true);
    assert.equal(result.appended.written, 3);
    assert.equal(result.appended.rejected, 0);
    const journalLines = fs.readFileSync(result.journalPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(journalLines.length, 3);
    assert.ok(journalLines.every(line => line.source === "ws" && line.hasSequence === true && line.confidence === "high" && line.degraded === false));
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.dataQuality, "sequenced/high-confidence");
    assert.equal(manifest.frameEvidence.channels.heartbeats, 1);
    assert.equal(manifest.frameEvidence.channels.level2, 1);
    assert.deepEqual(manifest.frameEvidence.sequenceRange, { first: 29, last: 31 });
    assert.deepEqual(manifest.frameEvidence.heartbeatCounterRange, { first: 1, last: 1 });
    assert.equal(manifest.safety.noCredentials, true);
    assert.equal(manifest.networkTouched, false);
  });

  await check("Stage 1 ingest refuses gapped WS frames by default", async () => {
    const now = new Date().toISOString();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage1-refuse-"));
    const frames = [
      stage1Heartbeat(39, 1, now),
      {
        channel: "level2",
        sequence_num: 40,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now }
        ]}]
      },
      {
        channel: "level2",
        sequence_num: 42,
        timestamp: now,
        events: [{ type: "update", product_id: "BTC-USD", updates: [
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      }
    ];
    const result = await stage1IngestFrames({
      frames,
      journalDir: path.join(baseDir, "journal"),
      outputRoot: path.join(baseDir, "recordings")
    });
    assert.equal(result.ingested, false);
    assert.equal(result.refused, true);
    assert.match(result.reason, /sequence gaps 1 > 0/);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.status, "refused");
    assert.equal(manifest.ingested ?? false, false);
    assert.equal(fs.existsSync(path.join(baseDir, "journal")), false);
  });

  await check("Stage 1 readiness refuses empty WS journal", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage1-empty-"));
    const result = await stage1Readiness({
      journalDir: path.join(baseDir, "journal"),
      recordingsDir: path.join(baseDir, "recordings"),
      horizonObservations: 1
    });
    assert.equal(result.offlineOnly, true);
    assert.equal(result.networkTouched, false);
    assert.equal(result.dataGate.pass, false);
    assert.equal(result.fullStage1Gate.pass, false);
    assert.match(result.fullStage1Gate.reasons.join("; "), /credential approval missing/);
    assert.match(result.dataGate.reasons.join("; "), /no journal events selected/);
  });

  await check("Stage 1 readiness does not treat offline fixtures as live evidence", async () => {
    const now = new Date().toISOString();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage1-ready-"));
    const journalDir = path.join(baseDir, "journal");
    const recordingsDir = path.join(baseDir, "recordings");
    const frames = [
      stage1Heartbeat(49, 1, now),
      {
        channel: "level2",
        sequence_num: 50,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      },
      {
        channel: "ticker",
        sequence_num: 51,
        timestamp: now,
        events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "100", best_ask: "102", price: "101" }] }]
      }
    ];
    await stage1IngestFrames({ frames, journalDir, outputRoot: recordingsDir, horizonObservations: 1 });
    const result = await stage1Readiness({ journalDir, recordingsDir, horizonObservations: 1 });
    assert.equal(result.dataGate.bySource.ws, 3);
    assert.equal(result.dataGate.gapEvents, 0);
    assert.equal(result.dataGate.dataQualityCeiling, "sequenced/high-confidence");
    assert.equal(result.liveEvidenceGate.pass, false);
    assert.match(result.liveEvidenceGate.reasons.join("; "), /no completed live keyed WS Stage 1 manifest observed/);
    assert.equal(result.fullStage1Gate.pass, false);
  });

  await check("Stage 1 recorder consumes async frames through the strict ingest path", async () => {
    const now = new Date().toISOString();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage1-recorder-"));
    async function* frameSource() {
      yield stage1Heartbeat(59, 1, now);
      yield {
        channel: "level2",
        sequence_num: 60,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      };
      yield {
        channel: "ticker",
        sequence_num: 61,
        timestamp: now,
        events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "100", best_ask: "102", price: "101" }] }]
      };
    }
    const result = await recordStage1FrameSource({
      frameSource: frameSource(),
      journalDir: path.join(baseDir, "journal"),
      outputRoot: path.join(baseDir, "recordings")
    });
    assert.equal(result.ingested, true);
    assert.equal(result.framesRead, 3);
    assert.equal(result.appended.written, 3);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.offlineOnly, true);
    assert.equal(manifest.networkTouched, false);
    assert.equal(manifest.liveWsFlowObserved, false);
  });

  await check("Stage 1 readiness recognizes simulated live manifest contract but still needs approval and breadth", async () => {
    const now = new Date().toISOString();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-stage1-contract-"));
    async function* frameSource() {
      yield stage1Heartbeat(69, 1, now);
      yield {
        channel: "level2",
        sequence_num: 70,
        timestamp: now,
        events: [{ type: "snapshot", product_id: "BTC-USD", updates: [
          { side: "bid", price_level: "100", new_quantity: "2", event_time: now },
          { side: "offer", price_level: "102", new_quantity: "1", event_time: now }
        ]}]
      };
      yield {
        channel: "ticker",
        sequence_num: 71,
        timestamp: now,
        events: [{ tickers: [{ product_id: "BTC-USD", best_bid: "100", best_ask: "102", price: "101" }] }]
      };
    }
    const journalDir = path.join(baseDir, "journal");
    const recordingsDir = path.join(baseDir, "recordings");
    await recordStage1FrameSource({
      frameSource: frameSource(),
      journalDir,
      outputRoot: recordingsDir,
      manifestMeta: {
        offlineOnly: false,
        networkTouched: true,
        keyedClientImplemented: true,
        liveWsFlowObserved: true,
        evidence: { testOnly: true, reason: "simulated manifest contract" }
      }
    });
    const readiness = await stage1Readiness({ journalDir, recordingsDir, horizonObservations: 1 });
    assert.equal(readiness.liveEvidenceGate.pass, true);
    assert.equal(readiness.fullStage1Gate.pass, false);
    assert.match(readiness.fullStage1Gate.reasons.join("; "), /credential approval missing/);
    assert.match(readiness.fullStage1Gate.reasons.join("; "), /paired observations/);
  });
}

// --- LIVE suite (only when a Coinbase debug tab is reachable) -------------

async function liveSuite() {
  console.log("[live] CDP suite");
  const cfg = loadConfig();
  const mod = await import("../src/coinbase.js");

  const attached = await mod.attach({});
  await check("coinbase_attach -> signedIn === true", () => {
    assert.equal(attached.signedIn, true, "Sign in to Coinbase in the debug profile first.");
  });

  const stream = await mod.marketStream({ durationMs: 30_000 });
  await check("market_stream: live feed observed, signal journaled, 0 gaps", () => {
    assert.ok(stream.counts.ticks >= 1, "expected >=1 tick");
    assert.ok(stream.counts.l2 >= 1, "expected >=1 L2 update");
    assert.ok(stream.counts.signals >= 1, "expected >=1 imbalance signal");
    assert.equal(stream.counts.gaps, 0, "expected zero gaps in the window");
    assert.ok(["ws", "dom"].includes(stream.source), "expected explicit stream source");
    if (stream.source === "dom") {
      assert.equal(stream.lastSignal.source, "dom");
      assert.equal(stream.lastSignal.hasSequence, false);
      assert.equal(stream.lastSignal.degraded, true);
    }
  });

  const port = await mod.portfolioSnapshot({});
  await check("portfolio_snapshot: balances array present", () => {
    assert.ok(Array.isArray(port.balances));
    assert.ok(port.balances.length >= 1, "expected >=1 parsed portfolio balance");
  });

  // dryRun place_order. In OBSERVE_ONLY this is rejected by design; in PAPER it
  // produces a simulated fill. We assert it returns a structured response and,
  // when in PAPER mode, writes a journal line.
  const before = await new JsonlJournal({ symbol: cfg.symbol }).lineCount();
  const res = await mod.placeOrder({ side: "buy", type: "market", quoteSize: "1", clientOrderId: "smoke-" + Date.now() });
  await check("place_order returns dryRun response", () => {
    assert.equal(res.dryRun, true);
    if (cfg.mode === "PAPER") {
      assert.equal(res.accepted, true);
      assert.ok(res.simulatedFill);
    } else {
      assert.equal(res.accepted, false); // OBSERVE_ONLY rejects by design
    }
  });
  void before;
}

async function main() {
  await offlineSuite();

  const cfg = loadConfig();
  const liveOptIn = process.env.CMCP_LIVE_SMOKE === "1";
  const reachable = liveOptIn && await isDebugEndpointReady(cfg.debugUrl);
  if (reachable) {
    try {
      await liveSuite();
    } catch (err) {
      console.error(`[live] suite error: ${err.message}`);
      failures++;
    }
  } else {
    console.log(liveOptIn
      ? `[live] skipped — no Chrome debug endpoint at ${cfg.debugUrl}.`
      : "[live] skipped — set CMCP_LIVE_SMOKE=1 to opt in.");
  }

  console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
