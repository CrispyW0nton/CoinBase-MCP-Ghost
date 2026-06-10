# Harris — *Trading and Exchanges: Market Microstructure for Practitioners*

**Why it matters here:** the definitive lens for reading the Coinbase order book
and choosing order types. This is the primary citation for the recon DOM map and
the execution scaffold.

> (Reference synthesis with chapter anchors; quotations paraphrased.)

---

## Ch.2–3 — The Trading Industry / Markets
- Who trades and why (liquidity demanders vs suppliers).
- **MCP usage:** the `market_trades` tape shows realized aggressor flow;
  `level2` shows resting liquidity suppliers.

## Ch.4 — Orders and Order Properties *(critical — decimals & types)*
- Prices live on a discrete **tick grid**; minimum price variation matters.
- **MCP rule:** represent every price/size as a **decimal**, never a float
  (`src/schema.js`). A 0.01 tick is not representable in binary float.
- Order properties (price, quantity, validity/TIF) map to our `placeOrder`
  contract fields (`limitPrice`, `baseSize/quoteSize`, `timeInForce`).

## Ch.5–6 — Order-Driven Markets / Limit Order Books
- Continuous double auction; price-time priority; queue position.
- **MCP usage:** the `level2` snapshot+updates we tap *are* the limit order
  book. Bid side / ask side / mid / spread are exactly the recon DOM-map targets.

## Ch.7 — Market vs Limit (execution cost)
- **Market orders** pay the spread for immediacy and risk slippage on thin
  books. **Limit orders** provide liquidity, may earn the spread, but risk
  non-execution.
- **MCP rule:** the `type` decision in `placeOrder` is a cost/immediacy
  trade-off driven by the *live spread* from the tap: wide spread relative to
  alpha ⇒ prefer limit; fast-decaying signal ⇒ marketable/IOC. Simulated fills
  in PAPER mode lift the ask (buys) / hit the bid (sells) accordingly.

## Ch.8–10 — Market makers, dealers, brokers
- Liquidity provision economics; adverse selection.

## Ch.14–19 — Liquidity, volatility, transaction costs
- **Effective spread**, market impact, and the cost of demanding liquidity.
- **MCP rule:** every edge estimate must net out the spread + Coinbase fees
  before sizing (feeds Chan Ch.8 Kelly inputs). Order-book **imbalance** is a
  short-horizon predictive signal observable directly from `level2`.

## Ch.20+ — Informed trading, manipulation
- Beware spoofing/layering and MEV-like games in crypto (Harvey Ch.VII).

> Cross-ref `03-chan...md` (order-book-imbalance momentum), `EXECUTION_DESIGN.md`
> (DOM sequence), `DECISION_CHECKLIST.md` §A.
