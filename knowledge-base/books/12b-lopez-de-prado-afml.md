# López de Prado — *Advances in Financial Machine Learning*

**Why it matters here:** the anti-overfitting conscience of the signal layer.

## Ch.1 — Financial ML as a process
- ML is a research *pipeline*, not a single model; most retail "strategies"
  fail from process errors.

## Ch.2 — Financial Data Structures *(critical)*
- Bar types (time/tick/volume/dollar bars); raw-data integrity determines
  everything downstream. → Our normalized, decimal-precise journal is the clean
  substrate; build dollar/volume bars from it, not naive time bars.

## Ch.3 — Labeling (triple-barrier, meta-labeling)
- Label outcomes with profit-take/stop/time barriers; meta-label to size bets.
- **MCP rule:** sizing (Kelly) should be gated by a meta-label probability.

## Ch.4 — Sample Weights
- Overlapping outcomes violate IID; weight by uniqueness.

## Ch.5 — Fractional Differentiation
- Make series stationary while preserving memory.

## Ch.6–9 — Ensembles & Cross-Validation
- **Purged K-Fold + embargo** to prevent leakage in time series (never plain
  K-fold). Combinatorial purged CV for robust backtests.

## Ch.10–16 — Bet sizing, backtesting, overfitting
- **Backtest overfitting is the central danger.** Use the **Deflated/Probabilistic
  Sharpe Ratio**; count trials; expect the best in-sample to disappoint live.
- **MCP rules:** reject strategies failing deflated-Sharpe; never deploy a
  strategy selected by repeatedly re-running backtests until one "works."

> Cross-ref `08-jansen...md`, `03-chan...md`, `DECISION_CHECKLIST.md` §C.
