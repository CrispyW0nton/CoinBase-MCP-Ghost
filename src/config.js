// src/config.js
// ---------------------------------------------------------------------------
// Loads the layered configuration for the Coinbase MCP Ghost.
//
// Layering (lowest -> highest precedence):
//   1. config/default.json            (committed defaults; OBSERVE_ONLY)
//   2. process.env overrides          (CMCP_MODE, CMCP_SYMBOL, ...)
//
// SAFETY MODEL (see EXECUTION_DESIGN.md):
//   mode = "OBSERVE_ONLY"  -> recon + read-only. place_order rejects everything.
//   mode = "PAPER"         -> place_order logs a simulated fill; no DOM clicks.
//   mode = "LIVE"          -> reserved. Requires config flag + env var +
//                             explicit confirmation tool call. The
//                             confirmation remains a stub and cannot arm real
//                             submission (Hard Constraint #5).
//
// "Fail closed" is the guiding principle here. Kahneman ("Thinking, Fast and
// Slow", Ch. 4 "The Associative Machine" / Ch. 26 "Prospect Theory") reminds
// us that operators over-trust defaults and under-weight tail risk; so the
// default that requires NO thought is the safest one (OBSERVE_ONLY, killSwitch
// on, maxNotionalUsd 0). Taleb ("The Black Swan" / Antifragile foreword to
// "The Bitcoin Standard") — asymmetric downside means we bias every default
// toward inaction.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config", "default.json");

export const VALID_MODES = ["OBSERVE_ONLY", "PAPER", "LIVE"];

let cached = null;
let liveConfirmation = null;

function normalizeTabUrlContains(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string" && value.trim()) return value;
  return ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"];
}

export function loadConfig({ force = false, configPath = DEFAULT_CONFIG_PATH } = {}) {
  if (cached && !force) return cached;

  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    // Missing/invalid config file -> fall back to the safest possible defaults.
    fileConfig = {};
  }

  const cfg = {
    mode: fileConfig.mode ?? "OBSERVE_ONLY",
    symbol: fileConfig.symbol ?? "BTC-USD",
    debugUrl: fileConfig.debugUrl ?? "http://127.0.0.1:9222",
    tabUrlContains: normalizeTabUrlContains(fileConfig.tabUrlContains),
    maxNotionalUsd: Number(fileConfig.maxNotionalUsd ?? 0),
    killSwitch: fileConfig.killSwitch !== false
  };

  // Environment overrides (highest precedence). Read-only knobs only.
  if (process.env.CMCP_MODE) cfg.mode = process.env.CMCP_MODE;
  if (process.env.CMCP_SYMBOL) cfg.symbol = process.env.CMCP_SYMBOL;
  if (process.env.CMCP_DEBUG_URL) cfg.debugUrl = process.env.CMCP_DEBUG_URL;
  if (process.env.CMCP_TAB_URL_CONTAINS) {
    cfg.tabUrlContains = process.env.CMCP_TAB_URL_CONTAINS.split(",").map(item => item.trim()).filter(Boolean);
  }
  if (process.env.CMCP_MAX_NOTIONAL_USD) cfg.maxNotionalUsd = Number(process.env.CMCP_MAX_NOTIONAL_USD);
  if (process.env.CMCP_KILL_SWITCH) cfg.killSwitch = process.env.CMCP_KILL_SWITCH !== "false";

  // LIVE mode requires an explicit second factor that we deliberately DO NOT
  // honor in this pass. Even if someone sets mode=LIVE in the config, we hold
  // the surface inert until the next development pass wires the confirmation
  // handshake. We keep the value so tooling can *report* the requested mode,
  // but execution paths must treat anything other than PAPER as no-trade.
  if (!VALID_MODES.includes(cfg.mode)) cfg.mode = "OBSERVE_ONLY";

  cached = Object.freeze(cfg);
  return cached;
}

// LIVE mode requires BOTH the config flag AND an env var AND an explicit
// confirmation tool call. Pass 2 records the third factor for audit, then
// intentionally refuses to arm it; López de Prado's overfitting warnings and
// Kahneman's bias guardrails both argue for proving every execution assumption
// before wiring irreversible action.
export function liveModeArmed(cfg = loadConfig()) {
  const flag = cfg.mode === "LIVE";
  const env = process.env.CMCP_ALLOW_LIVE === "I_UNDERSTAND_THE_RISK";
  const confirmation = liveConfirmation?.stubbed === true;
  return flag && env && confirmation && false;
}

export function recordLiveConfirmation({ phrase, requestedAt = new Date().toISOString() } = {}) {
  liveConfirmation = Object.freeze({
    requestedAt,
    phraseAccepted: phrase === "CONFIRM_LIVE_STUB_ONLY",
    stubbed: true,
    armed: false,
    reason: "LIVE confirmation is recorded for the safety ladder but remains stubbed; no real submission path is connected."
  });
  return liveConfirmation;
}

export function getLiveConfirmation() {
  return liveConfirmation;
}
