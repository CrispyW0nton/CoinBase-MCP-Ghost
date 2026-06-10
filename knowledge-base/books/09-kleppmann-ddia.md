# Kleppmann — *Designing Data-Intensive Applications*

**Why it matters here:** the integrity model for the market-data feed. Direct
basis for the append-only journal and the gap detector.

## Ch.3 — Storage & Retrieval
- Append-only/log-structured storage is simple, durable, recoverable, order-
  preserving. → `src/journal.js` writes one JSONL line per event; replay/dedup
  is trivial.

## Ch.5 — Replication
- Leader/follower; the page's WS is our "leader"; we are a read replica that
  must tolerate lag.

## Ch.7 — Transactions
- Read-only ⇒ no write transactions; isolation concerns are minimal this pass.

## Ch.11 — Stream Processing *(critical)*
- Delivery semantics: **at-least-once** (with sequence numbers) vs exactly-once.
- Coinbase carries `sequence_num`; a skip = dropped frame.
- **MCP rules:**
  - `marketStream` detects gaps on `sequence_num` and emits a `gap` event;
    it does **not** invent a resubscribe (prefer the system's own recovery —
    observe it in recon first).
  - For **exactly-once** downstream, dedupe on `(channel, sequence_num)`.
  - Bounded ring buffer (no unbounded in-memory growth on a fast feed).

## Ch.12 — Future of Data Systems
- Treat the journal as the source of truth; derived views (signals, P&L) are
  recomputable from it.

> Cross-ref `10-newman...md`, `RECON_REPORT` §4, `DECISION_CHECKLIST.md` §A.
