# Playbook 04 — Execution & Risk (scaffold only this pass)

1. Pass `DECISION_CHECKLIST.md` fully first.
2. Size: `notional = min(½·Kelly·equity, maxNotionalUsd)` (Chan Ch.8), scaled by
   IC·√breadth (Grinold&Kahn), haircut for tails (Taleb), debiased (Kahneman).
3. `coinbase_place_order` is `dryRun=true`: OBSERVE_ONLY rejects all; PAPER logs
   a simulated fill at best bid/ask (Harris Ch.7). No DOM click. See
   `EXECUTION_DESIGN.md` for the would-be LIVE sequence + kill-switch flow.
