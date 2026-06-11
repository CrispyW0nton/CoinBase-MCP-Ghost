# Playbook 02 — Market-Data Tap

Stage status: **Stage 1 - Real Sequenced Data Feed**. Gate status:
**awaiting explicit human approval** for a keyed Coinbase Advanced Trade
WebSocket data-feed client. Run `coinbase_stage1_credentials_status` or
`npm run stage1:approval` before any keyed-feed work. Do not build or run the
keyed client until the approval phrase is present.

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
8. Once the clean-window status is READY, carry that exact `startDate` into
   Stage A commands. Do not run the dirty full journal by accident, and do not
   treat DOM quantity as WS quality.
9. `coinbase_backtest` or `npm run backtest -- --symbol BTC-USD` — offline
   replay only. Measure Spearman IC chronologically (train/test), report
   breadth/autocorrelation and deflated-Sharpe controls only after the dataset
   gate passes. Keep every DOM/degraded result labeled **low-confidence /
   DOM-sourced**. A small in-sample win is not an edge claim (Grinold-Kahn,
   Lopez de Prado, Kahneman, Taleb).
10. `coinbase_stage_a` or `npm run stage-a -- --startDate <clean-window>` —
    terminal gate. If OOS IC/t-stat, deflated Sharpe, realistic
    fee/spread/slippage costs, or walk-forward persistence fail, document
    **no durable edge, do not risk money** and stop before PAPER/live work.
11. Stage 1 may begin only after the explicit credential decision. Scope is
    market data only: Advanced Trade WebSocket capture, real depth,
    `source:"ws"` provenance, `hasSequence:true`, `sequence_num` gap detection,
    append-only journal rows, and Stage-0 readiness checks on WS-quality data.
    It does not authorize orders, REST trading, stops, or LIVE arming.
12. `coinbase_stage1_subscription_plan` or
    `npm run stage1:subscription-plan -- --productIds BTC-USD --channels level2,ticker,market_trades`
    — offline subscribe-message contract for the future approved connector.
    Require the market-data endpoint, one channel per message, heartbeats for
    liveness, and no user/futures channels. This tool never generates JWTs,
    reads credentials, or opens a socket.
13. `coinbase_stage1_credentials_validate` may run only after the exact Stage 1
    approval phrase is present. It checks proposed key-name and PEM private-key
    shapes offline, prints no values, and does not authorize sockets, JWTs,
    orders, stops, REST trading, or LIVE arming.
14. `coinbase_stage1_feed_preflight` may run after approval to combine
    credential-shape validation with the market-data subscription contract. It
    records a secret-free `generatedAt` timestamp and is still offline: no
    socket, no JWT generation, no orders, and no returned credential values.
15. `coinbase_stage1_feed_audit` or
    `npm run stage1:feed-audit -- --frames <jsonl>` — offline acceptance
    harness for supplied WS frame payloads. Require zero parse errors, zero
    unsequenced frames, zero gaps, zero duplicate/replayed sequence numbers,
    100% clean `source:"ws"` provenance, and real L2 depth before the
    WS-quality gate passes. Require heartbeat frames with monotonic
    `heartbeat_counter` evidence for liveness. Then require Stage-0 quantity
    and breadth thresholds on the normalized WS events before any Stage 2 signal
    research can begin. Level2 payloads may arrive as `level2` or the official
    receive-channel example `l2_data`; both must normalize to L2 depth.
16. `coinbase_stage1_ingest_frames` or
    `npm run stage1:ingest -- --frames <jsonl>` — offline journal writer for
    supplied frames that already pass the WS-quality gate. It refuses dirty or
    gapped windows by default, writes strict-provenance JSONL rows, and emits a
    manifest with `frameEvidence` channel counts, sequence range, and heartbeat
    counter range plus a deterministic raw-frame SHA-256 digest and
    `raw-frames.jsonl` archive. Do not treat ingested fixtures as live Stage 1
    evidence unless the frames came from the approved keyed Advanced Trade WS
    client.
17. `coinbase_stage1_manifest_audit` or `npm run stage1:manifest-audit` —
    offline integrity check for Stage 1 manifests and raw-frame archives. It
    re-derives counts, gap counts, frame evidence, and provenance from
    `raw-frames.jsonl`, and must pass before any future archive-backed live
    manifest is trusted.
18. `coinbase_stage1_readiness` or `npm run stage1:readiness` — full Stage 1
    gate reporter. It must pass before Stage 2 starts: explicit approval,
    WS-only/high-confidence journal rows, zero gap events, Stage-0 readiness on
    WS-quality data, and a completed live keyed WS manifest. Fixture-only
    ingests are useful tests but are not live-feed evidence. Live manifests must
    carry frame evidence: nonzero frames and journal writes, zero parse,
    unsequenced, duplicate/replayed, out-of-order, and rejected rows, heartbeat
    evidence, sequence range, raw-frame SHA-256 digest with matching archive,
    readable journal evidence containing enough clean WS rows for the manifest's
    claimed appended rows, verified `journalAppendEvidence` line bounds/digest
    for the exact rows written,
    archive-derived counts/evidence/provenance that match the manifest summary,
    100% clean provenance, and a secret-free passed `coinbase_stage1_feed_preflight`
    snapshot whose `generatedAt` is no later than the manifest start and whose
    subscription plan includes the manifest symbol, heartbeats, and `level2`.
    Reject any manifest marked `evidence.testOnly:true` as live evidence.
19. Future approved keyed WS code should feed frames into
    `recordStage1FrameSource` so live capture uses the same audit, ingest,
    manifest, and readiness path as fixtures. Never set live evidence flags
    unless the frames came from the approved keyed Advanced Trade WS rail.
20. Future keyed WS code must call `requireStage1KeyedWsApproval` before
    reading credential material or opening a socket. Approval authorizes market
    data only; it never authorizes REST trading, orders, stops, LIVE arming, or
    credential logging.
21. Review `research/STAGE1_OFFICIAL_DOCS_REVIEW.md` before any implementation
    pass. Re-check the current official Coinbase docs and resolve the documented
    JWT sample discrepancy before adding JavaScript signing or subscription
    code.
22. `createStage1KeyedWsFrameSource` is the current fail-closed placeholder for
    that future connector. It must keep throwing
    `STAGE1_KEYED_WS_CLIENT_NOT_IMPLEMENTED` until human approval and a fresh
    official Coinbase docs review happen in the implementation pass.
