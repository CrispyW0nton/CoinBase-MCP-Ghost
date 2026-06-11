# Playbook 02 — Market-Data Tap

1. `coinbase_diagnose_transport { durationMs }` — attach before navigation and
   verify whether CDP exposes WS/SSE/WebTransport frames or only REST/poll
   candidates. Record the `WS TAP VIABLE` verdict before trusting any stream.
2. `coinbase_market_stream { durationMs }` — mirrors the page WS when CDP
   exposes sequenced frames (no 2nd socket). If Coinbase/Chrome exposes zero WS
   frames, require `source:"dom"`, `domFallback:true`, `hasSequence:false`, and
   `confidence:"low"`.
3. `coinbase_snapshot_state` — inspect ring buffer and confirm provenance.
4. Verify ≥1 tick/L2/signal and **zero gaps only when `hasSequence:true`**
   (Kleppmann). All prices decimal (Harris Ch.4). Build dollar/volume bars per
   **AFML Ch.2**, not naive time bars. Kelly sizing must refuse degraded DOM
   samples (Kahneman + Lopez de Prado).
5. `coinbase_record { durationMs, sampleIntervalMs }` or
   `npm run record -- --durationMs 3600000 --sampleIntervalMs 1000` — long
   OBSERVE recording when WS TAP VIABLE is NO. It samples DOM order book/trades
   tape only, writes fully-provenanced `source:"dom"` events, quarantines
   malformed provenance, and emits a manifest with
   health/disconnect/provenance counts. No clicks, REST, SDK, or sockets.
6. `coinbase_dataset_status` or `npm run dataset -- --symbol BTC-USD` — require
   0 legacy/missing-provenance rows, at least 2,000 paired observations, 2,000
   effective independent observations, and 600 chronological test observations
   before any IC verdict. Grinold-Kahn breadth is independent breadth, not raw
   DOM sample count.
7. `coinbase_data_audit` or `npm run audit -- --symbol BTC-USD` — write a
   Stage 0 audit report with dataset status, recording manifests, quarantine
   reasons, and legacy/unusable-row migration notes. If legacy rows exist, use
   the report's clean-window `startDate` for future dataset/audit runs. This is
   the audit loop while the Stage 0 gate is closed.
8. `coinbase_backtest` or `npm run backtest -- --symbol BTC-USD` — offline
   replay only. Measure Spearman IC chronologically (train/test), report
   breadth/autocorrelation and deflated-Sharpe controls only after the dataset
   gate passes. Keep every DOM/degraded result labeled **low-confidence /
   DOM-sourced**. A small in-sample win is not an edge claim (Grinold-Kahn,
   Lopez de Prado, Kahneman, Taleb).
