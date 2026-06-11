# coinbase-mcp-ghost

A local, **read-only** Model Context Protocol (MCP) server that attaches — as a
"ghost" — to an **already-open, already-signed-in** Coinbase Advanced Trade tab
over the Chrome DevTools Protocol (CDP), and performs **market-data and
portfolio reconnaissance**. It opens no socket of its own, holds no
credentials, and places **no orders**. Pass 2 also adds an inert signal layer,
PAPER P&L ledger, preview reconciliation, and a stubbed LIVE confirmation tool.
Pass 3 adds transport diagnostics and explicit data provenance on every market
event and derived value. Pass 4 adds an **offline-only** replay/backtest path
for measuring the order-book-imbalance signal's information coefficient from
already-recorded journal JSONL. Pass 5 hardens journal provenance, adds long
DOM recording, and refuses IC verdicts until the dataset is large and clean
enough.

> Forked from `chrome-course-mcp` (a Brightspace page collector). The JSON-RPC
> stdio shell and the `ChromeSession` CDP client are reused as-is and extended.

---

## Why "ghost"

The MCP never logs in, never sees your password/2FA, never touches the Coinbase
REST API, never copies cookies/JWTs out of Chrome, and never opens a second
WebSocket. It simply **mirrors what your signed-in browser tab already
receives** (`Network.webSocketFrameReceived` over CDP). That means:

- **No auth flow** to break or leak.
- **No duplicate connection** and **no rate-limit risk** — you see exactly what
  the page sees. If Chrome does not expose WS frames for the current Coinbase
  build, `coinbase_market_stream` marks `domFallback:true` and samples the
  live-changing rendered order book instead; still no Coinbase API, SDK, or
  socket is opened by this MCP. DOM fallback events are explicitly
  `source:"dom"`, `hasSequence:false`, `confidence:"low"`, and `degraded:true`.
- **Fail-closed:** if no Advanced Trade tab is open in the dedicated debug
  profile, every tool refuses to run rather than acting on an unrelated tab.

---

## Prerequisites

- **Node ≥ 20**
- **Windows host** with **Google Chrome**
- A Coinbase account you can sign in to

Install deps:

```powershell
npm install
```

---

## One-time Coinbase login flow (dedicated debug profile)

The MCP only ever attaches to a **dedicated** Chrome profile launched with the
DevTools port open — never your everyday profile.

```powershell
# Launches Chrome on --remote-debugging-port=9222 with a dedicated profile
# (%LOCALAPPDATA%\CoinbaseMCPProfile) and opens Coinbase.
powershell -ExecutionPolicy Bypass -File scripts\launch-chrome-coinbase.ps1
```

1. Open either `https://www.coinbase.com/advanced-portfolio` or
   `https://www.coinbase.com/advanced-trade/spot/BTC-USD`.
2. **Log in to Coinbase in this window once** (complete any 2FA).
3. Close the window normally when you're done — the profile **persists the
   session**, so next launch you're usually still signed in.

Leave this window open while you use the MCP.

---

## MCP client config (Codex / Claude / any MCP host)

```jsonc
{
  "mcpServers": {
    "coinbase-mcp-ghost": {
      "command": "node",
      "args": ["./src/index.js"],
      "cwd": "C:\\path\\to\\CoinBase-MCP-Ghost"
      // or, if installed globally / linked:
      // "command": "coinbase-mcp"
    }
  }
}
```

> This mirrors the old `chrome-course-mcp` block but with the new bin/path.

---

## Tools

**Generic Chrome primitives (kept):** `chrome_launch`, `chrome_open_tab`,
`chrome_tabs`, `chrome_navigate`, `chrome_snapshot`, `chrome_click`,
`chrome_type`, `chrome_select`, `chrome_press`, `chrome_screenshot`,
`chrome_eval`, `chrome_extract_media`.

**Coinbase recon/data tools (new, read-only):**

| Tool | What it does |
|---|---|
| `coinbase_attach` | Fail-closed attach to the Advanced Trade tab; returns `{ attached, signedIn, tab, probeResults }`. Other Coinbase tools refuse when `signedIn === false`. |
| `coinbase_diagnose_transport` | Passive WS/SSE/poll/WebTransport diagnostic. Attaches before same-tab navigation, checks page and worker targets, and writes a `WS TAP VIABLE` verdict. |
| `coinbase_backtest` | **Offline only.** Replays journal JSONL through the same causal imbalance signal layer, computes train/test Spearman IC, breadth, deflated-Sharpe controls, and writes `research/IC_REPORT_<UTC>.md`. No Chrome, REST, SDK, sockets, credentials, or clicks. |
| `coinbase_dataset_status` | **Offline only.** Reports journal inventory, paired observations, clean provenance percentage, effective breadth, and READY / NOT-READY for IC research. |
| `coinbase_data_audit` | **Offline only.** Writes a Stage 0 audit report covering readiness, legacy/unusable rows, recording manifests, and journal quarantine counts. |
| `coinbase_record` | Long OBSERVE recorder. Samples the live DOM order book/trades tape, writes fully-provenanced events, reconnects on transient tab/session failures, and writes `recordings/<symbol>-<UTC>/manifest.json`. No clicks, REST, SDK, sockets, or orders. |
| `coinbase_recon` | One-shot deep recon → `recon/<symbol>-<ts>/` (`dom-map.json`, `network-map.json`, `behavioral.json`, `screenshots/`, `RECON_REPORT.md`). Never submits an order. |
| `coinbase_market_stream` | Prefers sequenced WS frames when available. If unavailable, uses loud DOM fallback only, with degraded provenance and no sequence-gap claims. |
| `coinbase_snapshot_state` | Reads the in-memory ring buffer (counts, last tick/trade, recent N events). |
| `coinbase_portfolio_snapshot` | Reads balances + open orders from the DOM (not an API). |
| `coinbase_place_order` | **Execution scaffold.** `dryRun` hardcoded `true`. Validates against risk limits; OBSERVE_ONLY rejects all, PAPER logs a simulated fill. **Never clicks the order form.** |
| `coinbase_paper_ledger` | Reads the PAPER position/P&L ledger and advisory half-Kelly sizing output. |
| `coinbase_confirm_live` | Stubbed third LIVE factor; records the phrase but never arms live submission. |
| `coinbase_reconcile_preview_intent` | Pure intended-order vs preview-shaped diff. No clicking, no DOM interaction. |

---

## Safety model

Config lives in `config/default.json` (env vars `CMCP_*` override):

```jsonc
{ "mode": "OBSERVE_ONLY", "symbol": "BTC-USD",
  "debugUrl": "http://127.0.0.1:9222",
  "tabUrlContains": ["coinbase.com/advanced-trade", "coinbase.com/advanced-portfolio"],
  "maxNotionalUsd": 0, "killSwitch": true }
```

| Mode | Behavior |
|---|---|
| `OBSERVE_ONLY` (default) | Read-only recon/data. `place_order` rejects everything. |
| `PAPER` | `place_order` logs a `simulatedFill` at the live best bid/ask. Still no DOM click. |
| `LIVE` | **Not wired.** Requires config flag + env var + `coinbase_confirm_live`, but the confirmation remains stubbed and cannot arm real submission. |

The **kill switch** (`killSwitch: true`, default) is a manual circuit breaker
checked first on every order path. `maxNotionalUsd: 0` means even simulated
fills above $0 are rejected until you deliberately raise it.

See **`EXECUTION_DESIGN.md`** for the full execution design and kill-switch flow,
and **`knowledge-base/`** for the strategy rationale distilled from the
reference library.

---

## Offline IC research

Check whether the journal is ready before running a backtest:

```powershell
npm run dataset -- --symbol BTC-USD --horizonObservations 1
npm run audit -- --symbol BTC-USD --horizonObservations 1
```

The current readiness gate requires:

- at least **2,000 paired observations**,
- at least **2,000 effective independent observations** after lag-1
  autocorrelation discounting,
- at least **600 chronological test observations**,
- **0 legacy/missing-provenance rows** in the selected dataset.

This follows Grinold-Kahn's breadth discipline: raw event count is not the same
as independent observations, and autocorrelation can make n look larger than it
is. More DOM data can satisfy the quantity gate, but it remains
**low-confidence / DOM-sourced** unless the feed quality improves.

Run the backtest without attaching to Chrome:

```powershell
npm run backtest -- --symbol BTC-USD --horizonObservations 1
```

This reads `journal/<symbol>/*.jsonl`, sorts events deterministically, replays
only causal book state through the shared imbalance signal, and measures the
rank correlation between the signal and forward recorded mid/price returns.
The report includes chronological train/test IC, standard errors, t-stats,
breadth/autocorrelation flags, deflated Sharpe, and the number of parameter
trials counted. If the dataset is NOT-READY, `coinbase_backtest` withholds IC,
t-stat, and Sharpe fields and returns `Refused - insufficient data, record
more`.

Migration note: the existing `journal/BTC-USD/2026-06-10.jsonl` contains 356
legacy rows with missing/unknown provenance. They are not retroactively fixed;
dataset status marks them legacy/unusable. Keep them for audit if desired, but
filter or discard them for future research.

`npm run audit` writes `research/DATA_AUDIT_<UTC>.md` with the Stage 0 gate
state, journal inventory, recording manifests, quarantine reasons, and the
legacy/unusable-row migration note. When old legacy rows exist, the report also
prints a recommended clean-window `startDate`; use that date for future
`dataset`, `audit`, and eventually `backtest` commands so legacy audit rows stay
visible but excluded from research readiness.

Latest committed Stage 0 audit: the full journal remains NOT-READY because it
keeps 356 legacy rows visible, but the clean research window starting
`2026-06-10T20:54:21.206Z` is READY on quantity/provenance. Stage A work must
use that explicit clean `startDate`; DOM quality remains low-confidence.

---

## Long OBSERVE Recording

Start from an already-signed-in Advanced Trade/Portfolio tab, then run the MCP
tool or CLI:

```jsonc
{
  "durationMs": 3600000,
  "sampleIntervalMs": 1000,
  "healthIntervalMs": 30000
}
```

```powershell
npm run record -- --durationMs 3600000 --sampleIntervalMs 1000 --healthIntervalMs 30000
```

For a first useful research dataset, record until `npm run dataset` reports
READY. With a 1-second DOM sampler, that likely means several hours rather
than minutes because duplicated or autocorrelated observations are discounted.
Each run writes a manifest under `recordings/` with start/end time, counts,
provenance breakdown, disconnects, health heartbeats, journal stats, and any
quarantined provenance failures. `durationMs` measures the sampling window after
the recorder has attached/navigated to the trade view.

---

## Verify

```powershell
npm run check   # syntax-checks every source + test file
npm run smoke   # offline core invariants only by default
npm run dataset -- --symbol BTC-USD --horizonObservations 1
npm run audit -- --symbol BTC-USD --horizonObservations 1
npm run backtest -- --symbol BTC-USD --horizonObservations 1
```

For an explicit live diagnostic smoke, opt in with `CMCP_LIVE_SMOKE=1`. That
suite asserts: `coinbase_attach` → `signedIn === true`;
`coinbase_market_stream` 30s → live tick/L2/signal data and 0 gaps;
`coinbase_portfolio_snapshot` balances parse; `coinbase_place_order` (dryRun)
returns a structured response (+ a journal line in PAPER mode).

Pass 2 live recon is in `recon/btc-usd-2026-06-10T20-48-37-731Z/`. In that run,
CDP exposed no Coinbase WS frames, while the rendered BTC-USD order book changed
live; the network map records that explicitly.

Pass 3 transport diagnostic is in `recon/btc-usd-2026-06-10T21-26-02-366Z/`.
Verdict: **WS TAP VIABLE: NO** for this Chrome/Coinbase build. Early attach
before navigation captured no WebSocket, EventSource message, or WebTransport
frames on page or worker targets; it did observe Coinbase brokerage
REST/`text/event-stream` endpoints. Because those stream bodies are not exposed
as sequenced exchange frames through CDP here, downstream signals remain
degraded when sourced from DOM fallback.

---

## What's NOT in this pass

- **No trading.** No `Place Order` / `Preview Order` click anywhere.
- **No credentials / auth.** No API keys, JWTs, HMAC, or cookie extraction.
- **No Coinbase SDK or REST client** dependency.
- **No second WebSocket.** We mirror the page's own feed.

Design references live in `knowledge-base/`: Harris for order-book
microstructure, Grinold-Kahn and Chan for IC/Kelly sizing, Lopez de Prado for
overfitting discipline, Kahneman for operator bias guardrails, and Kleppmann for
append-only stream handling.
