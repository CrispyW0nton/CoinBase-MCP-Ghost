# Jansen — *Machine Learning for Algorithmic Trading* (2nd ed.)

**Why it matters here:** the blueprint for turning the MCP's journaled feed into
predictive signals without fooling ourselves. The whole ML4T workflow rides on
data quality the MCP is responsible for.

---

## Part 1 (Ch.1–5) — Data, Alpha Factors, Portfolios
- Source point-in-time data; engineer alpha factors (momentum, value,
  volatility); optimize portfolios; measure Sharpe/Information Ratio.
- **Agent rules → MCP:**
  - *Always point-in-time, no lookahead.* → Only use journal events with
    `ts ≤ decision_time`. The append-only JSONL makes this enforceable.
  - *Keep a liquid universe to minimize slippage.* → Trade only the most liquid
    Coinbase pairs (BTC-USD first); illiquid alts magnify the spread we already
    pay.
  - Allocate via mean-variance frontier or **Hierarchical Risk Parity**.

## Part 2 (Ch.6–13) — ML Fundamentals
- Model selection & bias-variance; linear (Ridge/Lasso); time-series
  (ARIMA/GARCH for vol); tree ensembles (RF/boosting).
- **Agent rules → MCP:**
  - Standardize features to unit variance before linear models.
  - Use `TimeSeriesSplit` cross-validation (never random K-fold on time series).
  - Early-stopping in boosting to avoid learning microstructure noise.
  - Long-short the top/bottom decile of predictions.
  - GARCH vol estimates feed directly into the Kelly `s²` (Chan Ch.8).

## Part 3 (Ch.14–16) — NLP
- Sentiment/topic features from news & filings. → Out of scope for a pure
  page-mirroring MCP, but flags that any future news feed must be timestamped
  and joined point-in-time to avoid lookahead.

## Part 4 (Ch.17–22) — Deep & Reinforcement Learning
- CNN/RNN, autoencoders for factors, RL agents with ε-greedy exploration and
  execution-cost penalties.
- **Agent rule → MCP:** an RL execution agent must be penalized for trade cost
  (the spread/fees the `level2`/`ticker` feed reveals) and rewarded on NAV — i.e.
  it must price the very frictions the recon report documents.

## Ch.8 + throughout — Backtesting & Overfitting *(critical)*
- Integrate signals into a backtester (Zipline/backtrader); detect overfitting
  with the **Deflated Sharpe Ratio**.
- **Agent rules → MCP:**
  - **Reject any strategy that fails a deflated-Sharpe significance test** after
    accounting for the number of trials.
  - Optimal-stopping discipline: after screening ~37% (1/e) of candidates, take
    the next one that beats the best-so-far — don't keep mining for a luckier
    backtest.

> Pairs with `12-lopez-de-prado-afml.md` (same anti-overfitting gospel) and
> `09-kleppmann-ddia.md` (the data substrate that makes point-in-time possible).
