# DECISION_CHECKLIST.md

Every decision an agent makes with `coinbase-mcp-ghost` must pass this gate.
If any answer is "no" or "unknown", **stop and default to inaction**.

## A. Data integrity (Kleppmann Ch.11; Harris Ch.4; AFML Ch.2)
- [ ] Is the market view based on data from `coinbase_market_stream` (mirrored
      from the signed-in tab), not a guess?
- [ ] Are there **zero unresolved sequence gaps** in the window used? If gaps
      exist, treat the book as stale and refuse to act.
- [ ] Are all prices/sizes handled as decimal strings (never JS Number)?

## B. Attachment & safety (Hard Constraints; Taleb; Kahneman Ch.26)
- [ ] Did `coinbase_attach` return `signedIn === true`?
- [ ] Is `mode` known? (OBSERVE_ONLY ⇒ no orders at all; PAPER ⇒ simulated only;
      LIVE ⇒ not available this pass.)
- [ ] Is the kill switch state checked? If engaged, **no order paths run**.

## C. Edge & sizing (Chan Ch.8; Grinold & Kahn; AFML)
- [ ] Is there a *quantified* edge (expected excess return + variance), not a
      narrative? (Kahneman: reject "story" over statistics.)
- [ ] Is size computed as **≤ ½-Kelly** of that edge, then capped at
      `maxNotionalUsd`?
- [ ] Does the Information Ratio justify the breadth of bets (IR ≈ IC·√breadth)?

## D. Bias guardrails (Kahneman)
- [ ] Anchoring: am I ignoring entry price / all-time-high as a valuation basis?
- [ ] Availability: am I using long-horizon base rates, not just recent vivid moves?
- [ ] Overconfidence: in high-variance regimes, did I *reduce* size?
- [ ] Loss aversion: is my stop pre-defined and respected (no averaging down a
      broken thesis)?
- [ ] Regression to the mean: am I not chasing a >2σ move?
- [ ] Planning fallacy: did I halve backtested profit and double expected
      drawdown before trusting it?

## E. Custody & asset reality (Antonopoulos; Ammous; Harvey; Finch)
- [ ] No order-path credentials, keys, JWTs, cookies, or REST/SDK touched
      anywhere.
- [ ] If this is Stage 1 market-data work, has
      `coinbase_stage1_credentials_status` reported the explicit
      `APPROVE_STAGE1_KEYED_WS_DATA_FEED_ONLY` approval phrase, and is the
      scope limited to sequenced WS data capture only?
- [ ] If evaluating supplied Stage 1 WS frames, did
      `coinbase_stage1_feed_audit` pass with zero parse errors, zero
      unsequenced frames, zero gaps, 100% clean WS provenance, and Stage-0
      readiness on WS-quality data?
- [ ] If Stage 1 frames were written to the journal, does the
      `coinbase_stage1_ingest_frames` manifest show `status:"complete"`,
      zero journal rejects, and an approved live-frame source before treating
      it as real Stage 1 evidence?
- [ ] For any non-BTC/ETH asset: did due diligence pass (tokenomics, audits,
      regulatory standing)? Default = trade only the most liquid majors.

## F. System resilience (Newman; Kleppmann)
- [ ] Is the order path isolated behind the single `placeOrder` choke point
      (the kill-switch circuit breaker)?
- [ ] Is every event journaled (append-only) for replay/audit?

> If all boxes are checked **and** the mode permits, you may proceed to the
> action that mode allows. In this pass the maximum permitted action is a
> PAPER `simulatedFill`. Otherwise: **observe only.**
