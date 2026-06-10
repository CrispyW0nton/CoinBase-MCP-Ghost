# Newman — *Building Microservices* (2nd ed.)

**Why it matters here:** the architecture discipline for a resilient
data-streaming/order system. Directly informs the fan-out event model
(`ChromeSession.on`), the kill-switch-as-circuit-breaker, and journaling.

---

## Ch.1 — What Are Microservices?
- Independently releasable services modelled around a business domain.
- **MCP usage:** keep "market data", "portfolio", and "execution" as separable
  concerns even within this single process — they are separate tools/modules
  (`marketStream`, `portfolioSnapshot`, `placeOrder`) so one can fail without
  the others.

## Ch.2 — How to Model Microservices
- Domain-Driven boundaries; high cohesion, low coupling; **information hiding**.
- **MCP usage:** the normalized schema hides Coinbase's wire format from
  consumers; downstream signal code depends on Tick/L2Update/Trade, not on
  Coinbase JSON.

## Ch.3 — Communication Styles
- Sync request/response vs async event-driven.
- **MCP usage:** the market feed is **event-driven fan-out** — the CDP socket
  is the producer, and gap-detector/normalizer/sinks are independent consumers
  (implemented via `ChromeSession.on()` listener registry).

## Ch.4 — Implementing Communication
- Explicit, versioned contracts beat implicit coupling.
- **MCP usage:** this is the rationale for the **selector stability ranking**
  (`data-testid` > role+name > class > text) in `coinbase_recon`: prefer the
  most contractual hook, exactly as you'd prefer a versioned API.

## Ch.5 — Workflow (Sagas)
- Multi-step flows use sagas + **compensating transactions**, not distributed
  transactions.
- **MCP usage (future LIVE):** a place-order flow that succeeds on submit but
  fails on confirmation must compensate (cancel) — designed into
  `EXECUTION_DESIGN.md` step 9.

## Ch.6 — Build (CI/CD)
- `npm run check` is our minimal build gate; extend per added module.

## Ch.7 — Deployment
- Independent deployability; isolated execution so a market surge in one
  consumer can't starve another.

## Resilience (Ch.11–12 themes)
- **Bulkheads, timeouts, retries (only for transient errors), circuit breakers.**
- **MCP rules:**
  - The **kill switch** is a manual circuit breaker at the single `placeOrder`
    choke point.
  - Listener errors are swallowed so one bad consumer can't kill the CDP socket
    (`#onMessage` try/catch around fan-out).
  - **Correlation IDs:** `clientOrderId` ties a (future) order back to the
    market event that triggered it, for end-to-end tracing.
- **Observability:** append-only journal = log aggregation prerequisite;
  `pino` is available for structured logging.

> Cross-ref `09-kleppmann-ddia.md` (stream/storage), `EXECUTION_DESIGN.md`.
