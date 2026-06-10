# Coinbase Advanced Trade — Recon Report (BTC-USD)

_Captured: 2026-06-10T20-48-37-731Z_  
_Views captured: start=portfolio, portfolio=yes, trade=yes_  
_Mode: **OBSERVE_ONLY** — read-only. No orders placed (Hard Constraint #2)._

This report is the **deliverable that the next development pass reads**. It maps
the live Advanced Trade surface so a future signal/paper-trading layer can act
on stable locators and a known data feed. Everything here was observed by
mirroring the user's already-signed-in browser session over CDP — no API keys,
no second socket, no auth (Hard Constraint #1).

---

## 1. Order panel — locators & stability

> **Harris, _Trading and Exchanges_, Ch. 4 "Orders and Order Properties" & Ch. 6
> "Order-Driven Markets".** The order panel is the trader's instrument; market
> vs. limit selection and the side toggle are the decisions that determine
> execution cost. We catalogue each control with ranked locators so a future
> pass selects the most contractual hook available.

| Control | Locators (ranked) |
|---|---|
| Buy/Sell toggle | `role=tab` (role+name, stability 2)<br>`button[class*="flex-ff5rfy6"]` (class-fragment, stability 3)<br>`text="Buy"` (textContent, stability 4) |
| Order-type selector | _not found in this capture_ |
| Amount input | _not found in this capture_ |
| Quote-currency toggle (USD/BTC) | _not found in this capture_ |
| Place Order button | _not found in this capture_ |

Stability ranking: **1 = data-testid** (contractual) → **2 = role+name**
(semantic) → **3 = class fragment** (rotates on deploy) → **4 = textContent**
(i18n/copy-fragile). _Newman, Building Microservices, Ch. 5 — prefer explicit
contracts over implicit coupling._

---

## 2. Order book, chart, trades tape

> **Harris, Ch. 6–7.** The level2 feed is the live limit order book; the
> market-trades tape is realized order flow. Microstructure (spread, depth,
> queue position) is visible here and drives any future execution policy.

- Order-book container: found
- Bid side: not found; Ask side: not found
- Mid/spread: not found
- Chart: iframe (likely TradingView) — src: blob:https://www.coinbase.com/3528d49c-cd35-44b9-a3cd-6734a08ae55d
- Recent trades tape: not found

---

## 3. Portfolio / balances

> **Antonopoulos, _Mastering Bitcoin_, Ch. 4–5; Ammous, _The Bitcoin Standard_,
> Ch. 10.** "Available" vs "Holds" mirrors the unspent/locked distinction in
> coin custody. We read balances from the DOM only — never from an API and
> never by touching keys.

- Portfolio widget: found
- USD balance: found; BTC balance: not found

---

## 4. Network reconnaissance — WebSocket & REST

> **Kleppmann, _Designing Data-Intensive Applications_, Ch. 11 "Stream
> Processing".** Coinbase's feed carries a connection-level `sequence_num`. A
> monotonic counter gives us **at-least-once with gap detection** (we can see a
> skip) but not exactly-once on its own — to get exactly-once we must dedupe on
> (channel, sequence_num) downstream. The journal is append-only precisely so
> that replay/dedup is possible (Ch. 3).

**WebSockets observed:** _none captured in window_

**Channels seen:** _none_

Expected Advanced Trade channels: `heartbeats`, `ticker`, `ticker_batch`,
`level2`, `market_trades`, `candles`, `status`, plus the authenticated
`user` channel.

**REST endpoints polled by the page (we will NOT call these — recorded to avoid
duplicate/conflicting requests):**

- `POST /api/v3/brokerage/user_chart_config/BTC-USD` ×2
- `GET /api/v3/coinbase.killswitch.KillSwitchService/KillSwitches` ×2 query: `?q=eyJzY29wZSI6ImNvbnN1bWVyIiwicGxhdGZvcm0iOiJ3ZWIiLCJ2ZXJzaW9uIjoiNTM3Yjk1MWM0NTQxZDVjMzAwZGRlNTE3M2FkN2U2MmYwZjY0ZWIxMSJ9`
- `GET /api/v3/brokerage/products/BTC-USD/trades` ×1 query: `?limit=100&update_interval=TWO_HUNDRED_FIFTY_MS_MARKET_TRADES`

**Content-Security-Policy:** captured (see network-map.json). In-page taps run in the page's main world via Runtime.evaluate, which CSP does not block.

---

## 5. Behavioral recon

> **Kahneman, _Thinking, Fast and Slow_, Ch. 4.** Demand-loaded channels reveal
> which data the UI fetches lazily; knowing this prevents us from "filling in"
> expectations the feed does not actually provide.

Observation only; no Buy/Sell/Preview/Place controls clicked.

- Before: `{"bookRows":361,"activeTab":"Buy","url":"https://www.coinbase.com/advanced-trade/spot/BTC-USD"}`
- After (safe Sell-toggle): `{"bookRows":361,"activeTab":"Buy","url":"https://www.coinbase.com/advanced-trade/spot/BTC-USD"}`

---

## 6. What's NOT in this pass

- No orders, no `Place Order`/`Preview Order` clicks.
- No API keys, JWTs, HMAC, or cookie extraction.
- No second WebSocket — we mirror the page's own feed.

See `EXECUTION_DESIGN.md` for the LIVE-mode DOM sequence we *would* perform,
and the knowledge base under `knowledge-base/` for the strategy rationale.

_Supporting artifacts: `dom-map.json`, `network-map.json`, `behavioral.json`, `screenshots/`._
