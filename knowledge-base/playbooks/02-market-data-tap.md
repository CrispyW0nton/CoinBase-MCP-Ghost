# Playbook 02 — Market-Data Tap

1. `coinbase_market_stream { durationMs }` — mirrors the page WS when CDP
   exposes frames (no 2nd socket). If Coinbase/Chrome exposes zero WS frames,
   require `domFallback:true` and treat the rendered order book as a lower-grade
   live observation source.
2. `coinbase_snapshot_state` — inspect ring buffer.
3. Verify ≥1 tick/L2/signal and **zero gaps** (Kleppmann). All prices decimal
   (Harris Ch.4). Build dollar/volume bars per **AFML Ch.2**, not naive time bars.
