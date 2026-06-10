# Chan — *Quantitative Trading* (how to build your own algo business)

**Why it matters here:** the end-to-end discipline of running a small systematic
operation — complements *Algorithmic Trading* with process/infra rules.

## Finding & testing strategies
- Look for simple, explainable edges; beware data-snooping. A strategy you can't
  explain you can't trust.

## Backtesting pitfalls
- Survivorship, look-ahead, data errors; **include transaction costs**; prefer
  the same code for backtest and live (echoes *Algorithmic Trading* Ch.1).

## Execution & infrastructure
- Automate execution; minimize manual intervention (reduces System-1 error,
  Kahneman). Log everything (Newman/Kleppmann).
- **MCP usage:** the OBSERVE_ONLY→PAPER→LIVE ladder and the append-only journal
  are this discipline in code.

## Money & risk management
- **Kelly sizing**; cap leverage; control drawdown. Stop trading a strategy when
  its live performance diverges materially from backtest.

## Psychology & business
- Treat it as a business: small, survive first, scale only proven edges.

> Cross-ref `03-chan-algorithmic-trading.md` (the quantitative companion).
