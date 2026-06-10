# Taleb — *The Black Swan / Antifragile / Fooled by Randomness*

**Why it matters here:** the tail-risk and asymmetry doctrine that justifies the
fail-closed defaults. Taleb wrote the foreword to *The Bitcoin Standard*.

## Black swans & fat tails
- Rare, high-impact events dominate P&L in markets with fat tails (crypto
  especially). Variance/Gaussian assumptions understate ruin risk.
- **MCP rule:** never size as if returns were Gaussian without a haircut;
  half/quarter-Kelly exists precisely because the tail is fatter than the model.

## Asymmetry & antifragility
- Prefer payoffs with bounded downside / unbounded upside; avoid the reverse.
- **MCP rule:** a wrong *live* order has unbounded downside vs trivial upside ⇒
  **default to inaction** (OBSERVE_ONLY, killSwitch on, maxNotionalUsd 0). LIVE
  requires three deliberate factors.

## Fooled by randomness
- Survivorship and luck masquerade as skill; a good backtest may be noise.
- **MCP rule:** treat impressive backtests with suspicion (reinforces AFML /
  Jansen deflated-Sharpe).

## Via negativa / barbell
- Robustness comes from removing fragilities; barbell = mostly safe + small
  convex bets.
- **MCP rule:** keep the core in the hardest asset (BTC; Ammous) and risk only a
  small, capped fraction on active bets.

> Cross-ref `13-ammous...md`, `03-chan...md`, `DECISION_CHECKLIST.md` §C/§D.
