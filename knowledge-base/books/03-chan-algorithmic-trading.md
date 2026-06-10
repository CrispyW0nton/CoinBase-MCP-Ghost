# Chan — *Algorithmic Trading: Winning Strategies and Their Rationale*

**Why it matters here:** this is the spine of the (future) signal + sizing
layer. Every order the MCP would ever generate must trace to a strategy whose
edge and risk are quantified per this book.

---

## Ch.1 — Backtesting and Automated Execution
**Lessons → MCP usage**
- *Same code for backtest and live eliminates look-ahead bias.* → The MCP's
  normalized schema (`src/schema.js`) and append-only journal
  (`src/journal.js`) are the single source of truth: a future backtester reads
  the same JSONL the live tap writes. No separate "research" data path.
- *Pitfalls: look-ahead, data-snooping, survivorship, splits/dividends,
  primary vs consolidated prices.* → For Coinbase spot crypto there are no
  splits/dividends, but **consolidated-vs-primary price** maps to *which
  venue's* book we mirror: we only trust the tab's own Coinbase feed, never a
  blended third-party price.
- *Transaction costs are crucial; a backtest without them is meaningless.* →
  The risk gate in `placeOrder` must subtract Coinbase taker/maker fees before
  declaring an edge. (Next pass.)
- *Paper-trade, then live at minimal leverage.* → This is exactly the
  OBSERVE_ONLY → PAPER → (future) LIVE ladder in `src/config.js`.

## Ch.2 — Basics of Mean Reversion
- Stationarity (ADF test), Hurst exponent `H < 0.5`, half-life of mean
  reversion sets the look-back window. → A mean-reversion signal on BTC-USD
  must compute half-life from the journaled mid-price series and size positions
  **negatively proportional to the Z-score** of deviation.

## Ch.3 — Implementing Mean Reversion
- Bollinger Bands, scaling-in, Kalman filter for dynamic hedge ratio/mean. →
  Enter at `entryZscore` (e.g. 1.0), exit at `exitZscore` (≈0). Scaling-in
  reduces market impact — relevant because Coinbase market orders pay the spread.

## Ch.4 — Mean Reversion of Stocks/ETFs
- Buy-on-gap, index arbitrage, cross-sectional MR. → Crypto analogue:
  cross-sectional mean reversion across the majors the tab can show
  (BTC/ETH/etc.). Requires multi-symbol recon first.

## Ch.5 — Mean Reversion of Currencies/Futures
- Roll returns, backwardation/contango. → Mostly N/A for Coinbase **spot**, but
  flags that any future perp/derivative support changes the carry model.

## Ch.6–7 — Momentum (interday/intraday)
- Time-series momentum: buy if 12-month return positive, hold ~1 month; size
  with Kelly. Intraday: opening-gap momentum, PEAD, order-book imbalance. →
  **Order-book imbalance** is directly observable from the `level2` feed we tap;
  it is the most MCP-native momentum signal and the natural next-pass target.

## Ch.8 — Risk Management *(critical — sizing lives here)*
- **Kelly (single):** `f* = m / s²` (m = mean excess return, s² = variance).
- **Kelly (portfolio):** `F = C⁻¹ M` (C = covariance matrix, M = mean excess
  returns vector).
- **Over-leverage is ruin:** overestimating `m` or underestimating `s²` inflates
  `f*` toward bankruptcy. Therefore use **½-Kelly** (or ¼).
- **Drawdown control:** maximize `g(f) = E[log(1 + fR)]`; or use **CPPI** — put
  fraction `D` of equity in the trading subaccount, apply leverage `f` there,
  hold `1−D` in cash to floor the drawdown.
- **Stops:** for mean-reversion, set stops *wider* than the worst backtested
  intraday drawdown so they fire only on regime shifts.

**MCP rule:** `placeOrder` computes `notional = min(½·f*·equity, maxNotionalUsd)`.
In this pass `maxNotionalUsd = 0`, so the gate rejects everything — by design.

> See also `12-lopez-de-prado-afml.md` (overfitting), `05-grinold-kahn.md`
> (IR/breadth), `15-kahneman` (don't fudge `m` upward).
