# Kahneman — *Thinking, Fast and Slow*

**Why it matters here:** the bias guardrails. The MCP's *defaults* and the
agent's *reasoning* must counteract System-1 errors. These rules are enforced in
config defaults today and in the signal layer next pass.

---

## Ch.1–3 — System 1 vs System 2
- System 1: fast, intuitive, emotional (panic sells, FOMO). System 2: slow,
  analytical.
- **MCP rule:** every would-be trade requires an explicit, pre-defined formula
  plus a confirmation/cool-down (multiple data points) — never a single
  System-1 trigger. The OBSERVE_ONLY default *is* the cool-down.

## Ch.11 — Anchoring
- Estimates drift toward whatever number was seen first (entry price, ATH).
- **MCP rule:** ignore entry price / historical peaks as a valuation basis.
  Re-anchor to the current best bid/ask from the live tap each session. (We do
  not even persist a cost basis in this pass.)

## Ch.12–13 — Availability / emotion & risk
- Recent vivid events get over-weighted.
- **MCP rule:** use long-horizon base rates (years of behavior), not the last
  few days of journal data, when judging "normal" volatility.

## Ch.17 — Regression to the mean
- Extreme performance reverts.
- **MCP rule:** don't chase assets >2σ above their moving average; check for
  oversold/overbought before assuming a trend continues. (Direct tie to Chan's
  mean-reversion Z-score.)

## Ch.19–20 — Illusion of understanding / validity
- Confident narratives beat scanty statistics in our heads, wrongly.
- **MCP rule:** in high-variance regimes, *reduce* position size to price the
  "unknown unknowns" (feeds the Kelly haircut). Prefer statistics over story.

## Ch.23 — Planning fallacy
- Plans hug best-case scenarios.
- **MCP rule:** before trusting any backtest, **halve the profit and double the
  expected max drawdown**; compare to the asset-class base rate (Outside View).

## Ch.26 — Prospect theory / loss aversion
- Losses loom ~2× larger than equal gains → traders hold losers, cut winners.
- **MCP rule:** enforce a pre-defined stop; treat a hit stop as a closed mental
  account; **never average down** a losing position unless the original thesis
  is still statistically valid. This is also why the *safe default is inaction*
  — the asymmetric pain of a wrong live order argues for OBSERVE_ONLY by default.

> Cross-ref `DECISION_CHECKLIST.md` §D, which operationalizes every bias above.
