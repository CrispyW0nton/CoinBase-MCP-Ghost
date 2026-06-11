# Changelog

## 0.17.0 - Stage 1 offline subscription plan contract

Stage 1 now has an offline subscribe-message planner for the future approved
Advanced Trade WebSocket connector.

- Added `createStage1SubscriptionPlan` and
  `coinbase_stage1_subscription_plan`.
- Added `npm run stage1:subscription-plan`.
- The planner enforces the market-data endpoint, one channel per subscribe
  message, heartbeats for liveness, market-data channels only, and rejection of
  the user endpoint/user and futures channels.
- It never reads credentials, generates JWTs, opens sockets, places orders,
  handles stops, or arms LIVE.
- Added smoke coverage for a valid heartbeat-backed plan and forbidden user
  endpoint/channel refusal.

## 0.16.0 - Stage 1 official Level2 receive alias

Stage 1 now recognizes the official Coinbase Level2 receive-channel example in
the offline parser and audit path.

- `parseCoinbaseFrame` accepts both `channel:"level2"` and `channel:"l2_data"`
  as Level2 depth payloads.
- Added smoke coverage for an official-shaped `l2_data` snapshot with sequenced
  high-confidence WS provenance.
- Updated Stage 1 docs to record the subscribe-vs-receive channel distinction.
- No credentialed client, JWT generation, credential read, socket, SDK call,
  order placement, stop handling, or LIVE arming was added.

## 0.15.0 - Stage 1 official WS docs review

Stage 1 now records the current official Coinbase Advanced Trade WebSocket
contract for the future approved keyed data-feed implementation.

- Added `research/STAGE1_OFFICIAL_DOCS_REVIEW.md` with official source links,
  endpoint/subscription details, Level2 semantics, sequence-gap handling,
  liveness requirements, and JWT implementation notes.
- Updated Stage 1 docs to require re-checking current Coinbase docs and
  resolving JWT sample discrepancies before replacing the fail-closed
  `createStage1KeyedWsFrameSource` placeholder.
- No credentialed client, JWT generation, credential read, socket, SDK call,
  order placement, stop handling, or LIVE arming was added.

## 0.14.0 - Stage 1 keyed WS entrypoint stub

Stage 1 now has an explicit fail-closed future live-feed entrypoint.

- Added `createStage1KeyedWsFrameSource`, which calls
  `requireStage1KeyedWsApproval` before doing anything else.
- Without approval it throws `STAGE1_KEYED_WS_APPROVAL_REQUIRED`.
- With approval it still throws `STAGE1_KEYED_WS_CLIENT_NOT_IMPLEMENTED`; no
  credential material is read, no socket is opened, and no client is built in
  this pass.
- Added smoke coverage for both refusal paths and secret-free errors.

## 0.13.0 - Stage 1 keyed-feed approval guard

Stage 1 now has a reusable fail-closed approval guard for any future keyed WS
entrypoint.

- Added `requireStage1KeyedWsApproval`, which throws
  `STAGE1_KEYED_WS_APPROVAL_REQUIRED` unless the exact approval phrase is
  present.
- The guard returns a narrow allowed scope after approval and keeps forbidden
  scope explicit: no REST trading, orders, stops, LIVE arming, DOM execution,
  credential logging, or kill-switch bypass.
- Added smoke coverage for fail-closed behavior, approved behavior, and
  secret-free error output.

## 0.12.0 - Stage 1 recorder core contract

Stage 1 now has a reusable recorder core for future live frame sources.

- Added `recordStage1FrameSource`, an async-iterable recorder that feeds any
  supplied frame source through the same Stage 1 audit/ingest path.
- Refactored Stage 1 manifests to carry explicit evidence flags:
  `offlineOnly`, `networkTouched`, `keyedClientImplemented`, and
  `liveWsFlowObserved`. Defaults remain offline/no-network/no-keyed-client.
- Added smoke coverage proving the recorder writes clean async frames through
  strict ingest, and that a simulated live manifest contract is recognized by
  readiness while still failing the full gate without approval and breadth.
- No Coinbase connector, credentials, socket, orders, stops, or LIVE arming were
  added.

## 0.11.0 - Stage 1 readiness gate reporter

Stage 1 now has a single offline readiness command that reports whether the
full data-feed gate is actually met.

- Added `coinbase_stage1_readiness` and `npm run stage1:readiness`.
- The reporter combines credential approval status, journal dataset status,
  WS-only/high-confidence/gap-free data checks, Stage-0 readiness on WS-quality
  data, and Stage 1 manifest inspection.
- Offline fixture ingests are explicitly not treated as live WS-flow evidence.
  The full Stage 1 gate requires a completed live keyed WS manifest in addition
  to enough clean sequenced journal data.
- Added smoke coverage for empty journals and fixture-only ingests.

## 0.10.0 - Stage 1 offline WS journal ingest

Stage 1 now has an offline ingest path that writes supplied clean WS frames into
the same strict-provenance journal shape the future keyed client must produce.

- Added `coinbase_stage1_ingest_frames` and `npm run stage1:ingest`.
- The ingestor loads supplied Coinbase Advanced Trade WS frame payloads,
  normalizes them through the shared Stage 1 parser, refuses dirty/gapped
  windows by default, writes clean `source:"ws"` events to JSONL, and emits a
  Stage 1 manifest under `recordings/`.
- The ingestor opens no socket, uses no credentials, validates no credential
  material, places no orders, and cannot arm LIVE.
- Added smoke coverage proving clean WS frames write strict journal rows and
  skipped sequences refuse without creating a journal.

## 0.9.0 - Stage 1 offline WS feed audit

Stage 1 now has a non-credentialed feed-quality audit surface that the future
keyed client must satisfy.

- Added `coinbase_stage1_feed_audit` and `npm run stage1:feed-audit`.
- The audit consumes supplied Coinbase Advanced Trade WS frame payloads
  offline, normalizes them through the existing parser, detects
  `sequence_num` gaps, verifies `source:"ws"` / high-confidence provenance,
  and reports Stage-0 readiness on the resulting WS-quality data.
- The audit deliberately opens no socket, validates no credentials, prints no
  secrets, places no orders, and does not implement the keyed WS client.
- Added smoke coverage for both a clean sequenced sample and a fatal skipped
  sequence. A tiny clean sample can pass WS quality while still failing the
  Stage-0 quantity gate, which keeps data quality and sample breadth separate.

## 0.8.0 - Stage 1 credentials approval gate

Stage 1 is now explicitly framed as **Real Sequenced Data Feed** work, not
execution work.

- Added `research/STAGE1_CREDENTIALS_DECISION.md` to record the human approval
  gate for any keyed Coinbase Advanced Trade WebSocket data-feed client.
- Added `coinbase_stage1_credentials_status` and `npm run stage1:approval`.
  They are offline-only status checks: no Coinbase socket, no credential
  validation, no secret printing, and no keyed client implementation.
- The required approval phrase is
  `APPROVE_STAGE1_KEYED_WS_DATA_FEED_ONLY`. It only authorizes building a
  sequenced market-data feed with `source:"ws"` provenance and `sequence_num`
  gap detection. It does not authorize REST trading, orders, stops, LIVE
  arming, DOM execution, or bypassing the kill switch.
- Added smoke coverage proving the status output uses credential presence
  booleans and does not leak provided secret material.

## 0.7.0 - Stage A terminal no-edge verdict

Stage A ran once on the Stage 0 clean window
`2026-06-10T20:54:21.206Z` and terminated the trading path for the current
imbalance signal.

- Added `coinbase_stage_a` and `npm run stage-a`, an offline-only measurement
  that refuses non-READY datasets, computes OOS IC/t-stat, deflated Sharpe /
  probability of false positive, non-overlapping walk-forward windows, and a
  conservative fee/spread/slippage survival check.
- Committed `research/STAGE_A_REPORT_2026-06-11T01-54-36-935Z.md`.
- Result: **Terminal - no durable edge, do not risk money.** OOS IC/t-stat,
  deflated Sharpe, realistic costs, and walk-forward persistence all failed.
- Stage B/C/D/E must not begin for this signal. This is a successful negative
  research outcome, consistent with Kahneman/Taleb guardrails against forcing a
  positive result.

## 0.6.0 - Pass 5 data-integrity recording gate

Pass 5 makes future IC research possible by fixing the recording pipeline
rather than trying to prove an edge.

### Provenance integrity

- Added strict journal provenance validation. Events missing `source`, `ageMs`,
  `hasSequence`, `confidence`, `degraded`, or required `degradedReason` are
  rejected from the main journal and written to `journal/_quarantine/` with a
  reason.
- Threaded journal rejection counters through market streaming and recording
  results.
- Root cause for old unknown rows: legacy Pass 2 journal entries were written
  before provenance fields were added. They are now reported as
  legacy/unusable; the code does not retro-fabricate provenance.
- Added smoke coverage for 0% unknown provenance on emitted batches and journal
  rejection/quarantine of malformed events.

### Recording

- Added `coinbase_record`, a long OBSERVE recorder that samples the DOM order
  book/trades tape, writes fully-provenanced DOM events/signals, handles
  reconnects, and writes `recordings/<symbol>-<UTC>/manifest.json` with
  health, counts, provenance breakdown, disconnects, and journal stats.
- Added `npm run record` as a CLI wrapper around the same no-click recorder for
  long Stage 0 sessions without an MCP client.
- Fixed recorder timing so `durationMs` measures sampling time after the first
  successful attach/navigation, not pre-attach startup time.
- Added `recordings/` to `.gitignore` as runtime output.

### Dataset readiness

- Added `coinbase_dataset_status` and `npm run dataset`.
- Added `coinbase_data_audit` and `npm run audit` to write Stage 0 audit
  reports covering readiness, recording manifests, quarantine counts, and
  legacy/unusable journal rows.
- Audit reports now compute a recommended clean research window after the last
  legacy/missing-provenance row so old audit data can stay on disk without
  contaminating future readiness checks.
- A 60-second OBSERVE-only recording produced a clean-window READY audit
  (`startDate=2026-06-10T20:54:21.206Z`, 2,926 paired observations, 100% clean
  provenance, 0 journal rejects). This opens the next iteration to Stage A only
  when using that explicit clean window; DOM quality remains low-confidence.
- Backtests now require 2,000 paired observations, 2,000 effective independent
  observations after autocorrelation discounting, 600 chronological test
  observations, and 0 legacy/missing-provenance rows before issuing IC metrics.
- Below the threshold, `coinbase_backtest` suppresses IC/t-stat/Sharpe and
  returns `Refused - insufficient data, record more`.

## 0.5.0 - Pass 4 offline IC replay research

Pass 4 adds a pure offline research harness for the existing order-book
imbalance signal. It does not attach to Chrome, open sockets, call Coinbase
REST/SDKs, click the UI, or alter the inert LIVE ladder.

### Added

- `src/signal.js`: shared Decimal order-book-imbalance signal module used by
  both live streaming and replay.
- `src/replay.js`: deterministic journal replay over JSONL files, chronological
  train/test IC metrics, breadth/autocorrelation flags, and approximate
  deflated-Sharpe false-positive controls.
- `coinbase_backtest` MCP tool and `npm run backtest` CLI entry.
- `research/IC_REPORT_<UTC>.md` output with data inventory, source/degraded
  percentages, result table, and plain-English verdict.
- Smoke assertions for deterministic replay, causal/no-lookahead signal
  generation, and low-confidence labeling for DOM-sourced reports.

### Verdict discipline

- Results from `source:"dom"`, degraded, or missing-provenance journal records
  are labeled **low-confidence / DOM-sourced** everywhere.
- The current local journal volume is not enough for a meaningful edge claim.
  The correct verdict is inconclusive until substantially more independent,
  preferably sequenced/high-confidence observations are recorded.
- No signal tuning or live sizing was added. Kelly/live paths remain guarded
  and refuse degraded/non-WS inputs.

## 0.4.0 — Pass 3 transport diagnostic + provenance

Pass 3 answered the data-integrity question raised by Pass 2: can Coinbase's
real-time market data be ghosted as sequenced WebSocket frames over CDP in this
local Chrome build?

### Verdict

- Added `coinbase_diagnose_transport`, a passive diagnostic that enables
  Network listeners before same-tab navigation, tests trade first and portfolio
  second, and observes page plus worker/shared-worker/service-worker targets.
- Real diagnostic artifact:
  `recon/btc-usd-2026-06-10T21-26-02-366Z/`.
- **WS TAP VIABLE: NO** in this run. No
  `Network.webSocketCreated`/`Network.webSocketFrameReceived`, EventSource
  message, or WebTransport events were captured after early attach/navigation.
- Observed brokerage transport candidates on the page target:
  `/api/v3/brokerage/stream/balance_summary`,
  `/api/v3/brokerage/stream/products/BTC-USD/stats`,
  `/api/v3/brokerage/products/BTC-USD/trades`, plus related product/stats
  polling. Some responses are `text/event-stream`, but CDP did not expose
  sequenced market-data messages from them.

### Data provenance

- Added `source`, `ageMs`, `hasSequence`, `confidence`, `degraded`, and
  `degradedReason` to Tick/L2Update/Trade/Candle/Gap serialization.
- WS-derived Coinbase frames are `source:"ws"` and high confidence only when a
  `sequence_num` is present.
- DOM fallback is now loud: `source:"dom"`, `hasSequence:false`,
  `confidence:"low"`, `degraded:true`.
- Gap detection is disabled for unsequenced/non-WS data. DOM snapshots can fill
  the ring/journal for observation, but cannot produce false clean gap results.
- Imbalance signals inherit source/degradation. PAPER fills record the quote
  source used. Kelly sizing refuses degraded/non-WS PAPER outcomes.

### Rationale

- Harris: rendered depth is not the same observation quality as a sequenced
  exchange feed.
- Kleppmann: gap detection needs a reliable sequence.
- Lopez de Prado and Kahneman: low-quality samples must not be promoted into
  confident sizing decisions.

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
