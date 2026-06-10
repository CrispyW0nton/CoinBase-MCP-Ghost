# coinbase-mcp-ghost

A local, **read-only** Model Context Protocol (MCP) server that attaches — as a
"ghost" — to an **already-open, already-signed-in** Coinbase Advanced Trade tab
over the Chrome DevTools Protocol (CDP), and performs **market-data and
portfolio reconnaissance**. It opens no socket of its own, holds no
credentials, and places **no orders**. Pass 2 also adds an inert signal layer,
PAPER P&L ledger, preview reconciliation, and a stubbed LIVE confirmation tool.

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
  socket is opened by this MCP.
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
| `coinbase_recon` | One-shot deep recon → `recon/<symbol>-<ts>/` (`dom-map.json`, `network-map.json`, `behavioral.json`, `screenshots/`, `RECON_REPORT.md`). Never submits an order. |
| `coinbase_market_stream` | Mirrors the page's WS for `durationMs`, normalizes to Tick/L2Update/Trade/Candle (decimal.js), sinks to a ring buffer + append-only JSONL journal, detects sequence gaps. |
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

## Verify

```powershell
npm run check   # syntax-checks every source + test file
npm run smoke   # offline core invariants always run;
                # the live CDP suite runs automatically if a debug tab is up
```

The live smoke suite asserts: `coinbase_attach` → `signedIn === true`;
`coinbase_market_stream` 30s → live tick/L2/signal data and 0 gaps;
`coinbase_portfolio_snapshot` balances parse; `coinbase_place_order` (dryRun)
returns a structured response (+ a journal line in PAPER mode).

Pass 2 live recon is in `recon/btc-usd-2026-06-10T20-48-37-731Z/`. In that run,
CDP exposed no Coinbase WS frames, while the rendered BTC-USD order book changed
live; the network map records that explicitly.

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
