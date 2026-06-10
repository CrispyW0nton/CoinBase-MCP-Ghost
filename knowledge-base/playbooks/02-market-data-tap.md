# Playbook 02 — Market-Data Tap

1. `coinbase_market_stream { durationMs }` — mirrors the page WS (no 2nd socket).
2. `coinbase_snapshot_state` — inspect ring buffer.
3. Verify ≥1 tick/L2/trade and **zero gaps** (Kleppmann). All prices decimal
   (Harris Ch.4). Build dollar/volume bars per **AFML Ch.2**, not naive time bars.
