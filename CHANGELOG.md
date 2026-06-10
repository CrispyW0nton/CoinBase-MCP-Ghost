# Changelog

## 0.3.0 — Pass 2 native recon + inert feature layer

Pass 2 ran against the local signed-in Coinbase Chrome tab on
`https://www.coinbase.com/advanced-portfolio` and produced a real recon folder:
`recon/btc-usd-2026-06-10T20-48-37-731Z/`.

### Added

- Portfolio/trade view support: `tabUrlContains` now accepts both
  `coinbase.com/advanced-trade` and `coinbase.com/advanced-portfolio`, with
  strict Coinbase advanced-route matching and no fallback to arbitrary tabs.
- Real two-view recon: `coinbase_recon` captures portfolio and trade DOM maps,
  real screenshots, CSP/REST observations, and a no-click behavioral report.
- L2 order-book imbalance signal from live observed market data. When CDP does
  not expose WS frames, the stream records `domFallback:true` and derives L2
  snapshots from Coinbase's live-changing rendered order book, still with no
  Coinbase API/SDK/socket opened by MCP. Harris Ch.6-7 informs the depth
  imbalance measure; Kleppmann Ch.11 informs gap/ring/journal handling.
- PAPER P&L ledger: simulated fills update running position, realized and
  unrealized P&L with decimal.js, and `coinbase_paper_ledger` exposes advisory
  half-Kelly output.
- `coinbase_confirm_live`: explicit LIVE-ladder confirmation stub. It records
  the operator phrase but never arms live submission.
- `coinbase_reconcile_preview_intent`: pure preview-vs-intent diff with no
  DOM interaction.
- Half-Kelly advisory sizing from measured PAPER outcomes. Grinold-Kahn's
  IR≈IC·sqrt(breadth), Chan's Kelly discipline, Lopez de Prado's overfitting
  warnings, Kahneman's bias guardrails, and Harris microstructure costs are
  cited in code and docs.

### Observed live behavior

- `coinbase_attach` matched the signed-in portfolio and trade views.
- The trade DOM showed a live-changing BTC-USD order book and the stream filled
  the journal/ring with DOM-derived L2/tick/signal events.
- CDP `Network.webSocketFrameReceived` exposed zero WS frames in this run; the
  real `network-map.json` records no WS endpoints/channels and one observed
  Coinbase kill-switch REST poll. This is captured as fact, not papered over.

### Safety

- Removed the prior behavioral Sell-toggle click. Recon now performs no
  Buy/Sell/Preview/Place clicks.
- `placeOrder()` remains `dryRun:true`; OBSERVE_ONLY and LIVE remain inert.

## 0.2.0 — Coinbase MCP Ghost (recon pass)

First-pass conversion from a Brightspace course-scraping MCP
(`chrome-course-mcp`) into a **Coinbase Advanced Trade reconnaissance MCP**
(`coinbase-mcp-ghost`). **No trading** in this pass — read-only observation
layer + recon report + execution scaffold (inert).

### Removed (Brightspace artifacts)

- **`extension/` directory** (entire): `background.js`, `content.js`,
  `manifest.json`, `page_embed.js`, `popup.html`, `popup.js`.
- **`scripts/` (9 files):** `build-video-catalog.ps1`,
  `capture-kaltura-cdp.mjs`, `download-captured-videos.mjs`,
  `extension-collector.mjs`, `launch-chrome-mcp.ps1`,
  `launch-person1-collector.ps1`, `organize-collected-pages-by-content-id.ps1`,
  `organize-collected-pages.ps1`, `start-gam623-collection.ps1`.
- **Tools removed from `src/tools.js`:** `chrome_save_page`,
  `chrome_download_urls`, `brightspace_collect_current`,
  `brightspace_archive_links` (and their helpers `downloadUrl`,
  `detectCourseCode`, `fileNameFromResponse`, `safeName`, `uniquePath`,
  `uniqueStrings`, plus the now-unused `Readable`/`pipeline`/`fsSync` imports).
- **`chrome_extract_media`** kept but **de-Brightspaced** (dropped the
  `looksLikeBrightspaceContent`/`brightspaceLinks` logic; now a generic
  media/document/iframe extractor).

### Kept (battle-tested shell — extended, not replaced)

- JSON-RPC 2.0 stdio MCP shell in `src/index.js` (renamed serverInfo to
  `coinbase-mcp-ghost` 0.2.0).
- `ChromeSession` in `src/chrome.js` — **extended** with a fan-out `on()`
  listener registry (multiple persistent listeners per CDP event) for the
  recon/stream tools. `pickTab`, `waitForEvent`, etc. unchanged.
- The 10 generic Chrome primitives: `chrome_launch`, `chrome_open_tab`,
  `chrome_tabs`, `chrome_navigate`, `chrome_snapshot`, `chrome_click`,
  `chrome_type`, `chrome_select`, `chrome_press`, `chrome_screenshot`,
  `chrome_eval` (+ generic `chrome_extract_media`).

### Added

- **Package:** renamed to `coinbase-mcp-ghost`, bin `coinbase-mcp`, version
  `0.2.0`. Deps added: `decimal.js`, `pino`, `dotenv`.
- **`config/default.json`:** `{ mode: "OBSERVE_ONLY", symbol: "BTC-USD",
  debugUrl, tabUrlContains, maxNotionalUsd: 0, killSwitch: true }`.
- **`scripts/launch-chrome-coinbase.ps1`:** launches Chrome on
  `--remote-debugging-port=9222` with a dedicated
  `%LOCALAPPDATA%\CoinbaseMCPProfile` and opens the BTC-USD page.
- **`src/config.js`:** layered config + 3-factor LIVE-mode gate (stubbed).
- **`src/schema.js`:** unified Tick / L2Update / Trade / Candle / gap schema;
  all prices/sizes are `decimal.js` Decimals, serialized as strings.
- **`src/journal.js`:** bounded in-memory `RingBuffer` + append-only
  `JsonlJournal` (`./journal/<symbol>/<yyyy-mm-dd>.jsonl`).
- **`src/coinbase.js`** with six tools:
  - `coinbase_attach` — fail-closed tab discovery + signed-in probe.
  - `coinbase_recon` — DOM map + network recon (WS/REST/CSP) + behavioral.
  - `coinbase_market_stream` — mirrors the page's WS, normalizes, sinks to
    ring + journal, detects sequence gaps.
  - `coinbase_snapshot_state` — reads the ring buffer.
  - `coinbase_portfolio_snapshot` — reads balances/orders from the DOM.
  - `coinbase_place_order` — execution scaffold; `dryRun` hardcoded `true`,
    never clicks the order form.
- **Docs:** rewritten `README.md`, new `EXECUTION_DESIGN.md`, recon TEMPLATE
  under `recon/btc-usd-TEMPLATE/`, and a **knowledge base** under
  `knowledge-base/` distilled from the 15 reference books.
- **Tests:** `tests/smoke.mjs` (plain Node — offline invariants always run;
  live CDP suite runs when a debug tab is reachable); `npm run check` extended
  to syntax-check every new file; `npm run smoke` added.

### Safety

- Default mode `OBSERVE_ONLY`; `killSwitch: true`; `maxNotionalUsd: 0`.
- No credentials, JWT, HMAC, cookies, REST, or SDK. Pure CDP against an
  already-open, already-signed-in tab.
- No order is placed; no Preview/Place Order click anywhere in the codebase.
