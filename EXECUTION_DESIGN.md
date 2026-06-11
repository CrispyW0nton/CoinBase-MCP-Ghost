# EXECUTION_DESIGN.md — Coinbase MCP Ghost

> **Status: DESIGN ONLY.** Nothing in this document is wired to a real click in
> this pass. `coinbase_place_order` has `dryRun` **hardcoded `true`** and never
> touches `Page.dispatchMouseEvent`, `Input.dispatchMouseEvent`,
> `chrome_click`, or any `Runtime.evaluate` against the order form
> (Hard Constraints #2, #5). This file specifies the sequence we *would*
> perform in a future LIVE pass, the policy that would generate each call, and
> the kill-switch flow.

---

## 1. Safety model recap

| Mode | place_order behavior | DOM interaction |
|---|---|---|
| `OBSERVE_ONLY` (default) | Rejects **everything**. | None. |
| `PAPER` | Logs a `simulatedFill` at the live best bid/ask. | None. |
| `LIVE` | **Not wired this pass.** Reserved. | Would click the order form. |

LIVE arming requires **three** independent factors (see `src/config.js`
`liveModeArmed()`), and the third is deliberately recorded-but-stubbed:

1. `config.mode === "LIVE"` (config flag), **and**
2. `process.env.CMCP_ALLOW_LIVE === "I_UNDERSTAND_THE_RISK"` (env var), **and**
3. an explicit `coinbase_confirm_live` tool call. It records the phrase
   `CONFIRM_LIVE_STUB_ONLY` for audit, but still returns `armed:false`; real
   submission remains disconnected.

> **Taleb (foreword to Ammous, _The Bitcoin Standard_; _Antifragile_).**
> Downside from an erroneous live order is unbounded relative to the upside of
> convenience. We therefore make the *default* require zero thought to be safe
> and make *acting* require three deliberate, hard-to-fat-finger steps.
> **Kahneman (_Thinking, Fast and Slow_, Ch. 26, loss aversion / Ch. 4).**
> Operators anchor on the happy path; a multi-factor gate forces System 2
> engagement before any irreversible action.

---

## 2. The DOM sequence we WOULD perform in LIVE mode

All selectors below come from `recon/<symbol>-<ts>/dom-map.json`, chosen by the
stability ranking (data-testid > role+name > class fragment > textContent).
Each step would be preceded by a `coinbase_attach` `signedIn === true` check and
a fresh `coinbase_portfolio_snapshot` + live quote from `coinbase_market_stream`.
After Pass 3, that quote must also be checked for provenance:
`source:"ws"` and `hasSequence:true` are required before any future LIVE design
can treat gap detection or microstructure signals as reliable. DOM fallback is
observation-only and degraded.

> **Harris, _Trading and Exchanges_, Ch. 4 & Ch. 6.** Market orders pay the
> spread for immediacy; limit orders provide liquidity and risk non-execution.
> The `type` choice is an execution-cost decision, made *before* we touch the
> DOM, by the strategy layer.

| # | Action | Locator (from dom-map) | Notes / screenshot |
|---|---|---|---|
| 1 | Select side (Buy/Sell) | `orderPanel.buySellToggle` | `screenshots/step-1-side.png` |
| 2 | Select order type (Market/Limit/Stop-Limit) | `orderPanel.orderTypeSelector` | `screenshots/step-2-type.png` |
| 3 | Select quote currency (USD vs BTC) | `orderPanel.quoteCurrencyToggle` | market buys typically size in USD (quoteSize) |
| 4 | Enter amount | `orderPanel.amountInput` | decimal string only (decimal.js); never a JS Number |
| 5 | (Limit only) Enter limit price | limit-price input near `amountInput` | `screenshots/step-5-limit.png` |
| 6 | Click **Preview Order** | — | **NOT clicked in this pass.** |
| 7 | Verify preview matches our request (side, size, px, fees) | preview modal | abort on any mismatch |
| 8 | Click **Place Order** | `orderPanel.placeOrderButton` | **NOT clicked in this pass.** |
| 9 | Confirm fill via `user` WS channel + `coinbase_portfolio_snapshot` diff | — | reconcile clientOrderId |

Step 7 (preview reconciliation) is mandatory: we re-parse the preview modal and
assert it equals the request we generated. **López de Prado, _AFML_, Ch. 1 & the
"backtest overfitting" warnings:** never trust an unverified execution path; a
preview-vs-intent diff is a cheap, decisive sanity check.

---

## 3. The policy that would generate each call

### 3.1 Signal and sizing — imbalance, IC, Kelly

> **Chan, _Algorithmic Trading: Winning Strategies and Their Rationale_, Ch. 8
> ("Money and Risk Management"); and Chan, _Quantitative Trading_.** Position
> size = `f* × equity`, where `f*` is the (fractional) Kelly fraction derived
> from the strategy's estimated edge and variance. We will cap at a fraction of
> full Kelly (commonly ½ or ¼ Kelly) because full Kelly is too volatile when
> the edge is estimated with error.

```
f_full   = mean_excess_return / variance_of_return      // Chan Ch.8
f_used   = kellyFraction * f_full                        // kellyFraction in (0,1]
notional = min(f_used * equityUsd, config.maxNotionalUsd)
```

`config.maxNotionalUsd` is the hard ceiling that the risk gate enforces *after*
sizing — defense in depth. In this pass it is `0`, so even PAPER fills above $0
are rejected until an operator raises it deliberately.

> **Grinold & Kahn, _Active Portfolio Management_ (the Fundamental Law of Active
> Management, IR ≈ IC·√breadth).** Sizing should scale with the *information
> coefficient* of the signal and the *breadth* of independent bets — not with
> conviction-of-the-moment.

Pass 2 computes an order-book depth imbalance signal:

```
imbalance = (sum_top10_bid_size - sum_top10_ask_size)
            / (sum_top10_bid_size + sum_top10_ask_size)
```

The PAPER ledger records simulated outcomes and exposes advisory half-Kelly:

```
f_full = measured_mean_edge / measured_variance
f_used = max(0, f_full / 2)
```

This is advisory only and never auto-acts. **Lopez de Prado, AFML**, motivates
requiring measured PAPER outcomes before trusting the signal; **Kahneman**
motivates shrinking action toward inaction when evidence is thin.

Pass 3 added data provenance to every event and derived value. If the signal is
fed by DOM fallback (`source:"dom"`, `hasSequence:false`), the PAPER ledger may
record it for audit, but half-Kelly sizing refuses the sample. This follows
Harris on market microstructure observation quality, Kleppmann on sequenced
stream reliability, Lopez de Prado on low-quality samples, and Kahneman on
operator overconfidence.

Pass 4 adds offline IC research only. `coinbase_backtest` and `npm run backtest`
read existing journal JSONL, replay the same imbalance signal causally, and
write `research/IC_REPORT_<UTC>.md`. The report is advisory research, not an
execution input: it cannot arm `LIVE`, cannot change `placeOrder`, and cannot
override Kelly's refusal of degraded/non-WS inputs. A DOM-sourced or
missing-provenance IC result must remain labeled low-confidence even when the
number is positive.

Pass 5 adds a dataset gate before research can even issue IC statistics.
`coinbase_dataset_status` requires 2,000 paired observations, 2,000 effective
independent observations after autocorrelation discounting, 600 chronological
test observations, and 0 legacy/missing-provenance rows. Below that,
`coinbase_backtest` refuses the verdict and suppresses IC/t-stat/Sharpe fields.
This follows Grinold-Kahn's breadth framing: raw DOM sample count is not
independent breadth, and more low-confidence DOM data does not upgrade feed
quality. The long recorder and its manifests are observation infrastructure
only; they do not change the LIVE ladder or sizing refusal rules.

Stage 0 audits may recommend a clean-window `startDate` after the last legacy
or missing-provenance journal row. That date is a research-window filter only:
it keeps old audit rows visible while preventing them from contaminating future
readiness checks. It does not upgrade DOM source quality or unlock Stage A
until the quantity and provenance gates are both met.

### 3.2 Market vs. limit selection

> **Harris, Ch. 6–7.** Use a **limit** order when the spread is wide relative to
> our alpha or when we are providing liquidity; use a **market** (or marketable
> limit / IOC) when immediacy dominates (signal decays fast). The
> `level2`/`ticker` feed tapped in Step 4 gives the live spread that drives this
> branch.

### 3.3 Risk overlay

> **Taleb.** Hard stops on notional, a global kill switch, and refusal-by-default
> protect against tail events that the sizing model does not price.

---

## 4. Kill-switch flow

```
                 ┌─────────────────────────────────────────────┐
   any tool ───▶ │ loadConfig(): killSwitch?  mode?  maxNotional │
                 └───────────────┬─────────────────────────────┘
                                 │ killSwitch === true  ──▶  REJECT (no fill, even simulated)
                                 │ mode === OBSERVE_ONLY ──▶  REJECT
                                 │ mode === LIVE         ──▶  REJECT (not wired this pass)
                                 │ mode === PAPER        ──▶  size & risk-gate ──▶ simulatedFill (journal only)
```

Operator actions:

- **Engage kill switch:** set `"killSwitch": true` in `config/default.json`
  (it ships `true`). Takes effect on the next tool call — no restart-critical
  state. Every order path checks it first.
- **Disengage (PAPER only):** set `killSwitch:false` **and** `mode:"PAPER"` and
  a non-zero `maxNotionalUsd`. Even then, no real DOM click occurs.
- **LIVE:** intentionally cannot be armed in this pass.

> **Newman, _Building Microservices_, Ch. 11–12 (resilience, circuit breakers).**
> The kill switch is a manual circuit breaker at the single choke point
> (`placeOrder`), so one config flag halts all execution regardless of caller.

---

## 5. What we explicitly did NOT do

- No click on Preview/Place Order.
- No `Input.dispatchMouseEvent` / `Page.dispatchMouseEvent` against the form.
- No `Runtime.evaluate` that mutates the order form.
- No credentials, JWT, HMAC, cookies, REST, or SDK.

Pass 2 implemented `coinbase_confirm_live` as a stub, preview reconciliation as
a pure diff, and the PAPER P&L ledger. Future LIVE work still requires a fresh
review before connecting any DOM submission path. Pass 3 did not add execution
features; it established that the current Chrome/Coinbase build did not expose
capturable sequenced WS frames over CDP, so DOM-sourced numbers remain degraded.
