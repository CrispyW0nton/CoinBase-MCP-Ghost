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
