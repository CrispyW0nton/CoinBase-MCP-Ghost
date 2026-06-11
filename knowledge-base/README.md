# Knowledge Base — MANDATORY READING FOR AGENTS

> **Read this before making ANY decision with `coinbase-mcp-ghost`.**
> This knowledge base is the *required reference layer* between an agent and the
> MCP's tools. No recon interpretation, no signal, and no (future) order may be
> generated without grounding it in the rules distilled here from the 15-book
> reference library.

This folder distils the project's reference library into **agent-actionable
rules**, organized so an agent can answer: *"Given what the MCP observes on the
Coinbase Advanced Trade page, what am I allowed to conclude and do?"*

## How an agent MUST use this KB

1. **Before recon interpretation** → read `playbooks/01-observe-only-recon.md`
   and the relevant `books/` notes (Harris for microstructure, Kleppmann for
   stream integrity).
2. **Before forming a market view** → read `playbooks/02-market-data-tap.md`,
   `books/03-chan-algorithmic-trading.md`, `books/12b-lopez-de-prado-afml.md`,
   and the bias guardrails in `books/15-kahneman-thinking-fast-and-slow.md`.
3. **Before ANY sizing or (future) order** → read
   `playbooks/04-execution-and-risk.md`, the Kelly rules in Chan, the
   Fundamental Law in Grinold & Kahn, and the tail-risk rules in Taleb.
4. **Before touching custody/asset questions** → read the Antonopoulos,
   Ammous, and security notes.

## Hard precedence rules (override any model "intuition")

| Rule | Source | Enforced where |
|---|---|---|
| Default to inaction; OBSERVE_ONLY + kill switch | Taleb; Kahneman Ch.26 | `src/config.js`, `placeOrder` |
| Never touch order-path credentials/keys; read-only execution default | Antonopoulos; Ammous Ch.10 | `src/coinbase.js`, `placeOrder` |
| Keyed WS data-feed credentials require explicit Stage 1 approval and may not authorize execution | Kleppmann; Harris; Taleb | `src/stage1-approval.js`, `src/stage1-feed-audit.js`, `research/STAGE1_CREDENTIALS_DECISION.md` |
| Prices/sizes are decimals, never floats | Harris Ch.4; AFML Ch.2 | `src/schema.js` |
| Size by edge & risk (½-Kelly), cap at maxNotional | Chan Ch.8; Grinold&Kahn | `placeOrder` risk gate |
| Treat the feed as at-least-once; dedupe on seq | Kleppmann Ch.11 | `marketStream` gap detector |
| Backtest ≠ live; deflate, fear overfitting | AFML; Jansen Ch.8; Chan Ch.1 | (next pass) |
| Bias guardrails (anchoring, loss aversion, …) | Kahneman | (signal layer) |

## Contents

- `books/` — one file per book, **organized by chapter**, each chapter mapping
  its lessons to **how this MCP should be used to invest on Coinbase**.
- `playbooks/` — cross-cutting, tool-by-tool operating procedures that cite the
  books.
- `DECISION_CHECKLIST.md` — the gate every decision must pass.

## The 15-book library

1. Burniske & Tatar — *Cryptoassets*
2. Chan — *Algorithmic Trading: Winning Strategies and Their Rationale*
3. Chan — *Quantitative Trading*
4. López de Prado — *Advances in Financial Machine Learning*
5. Grinold & Kahn — *Active Portfolio Management*
6. Taleb — *The Black Swan / Antifragile / Fooled by Randomness*
7. Harris — *Trading and Exchanges*
8. Jansen — *Machine Learning for Algorithmic Trading*
9. Kleppmann — *Designing Data-Intensive Applications*
10. Newman — *Building Microservices*
11. Antonopoulos — *Mastering Bitcoin*
12. Antonopoulos & Wood — *Mastering Ethereum*
13. Ammous — *The Bitcoin Standard*
14. Harvey, Ramachandran & Santoro — *DeFi and the Future of Finance*
15. Kahneman — *Thinking, Fast and Slow*

(Plus supplemental: Finch — *Crypto Investing 2.0*; Leinweber/Willig/Schoenfeld
— *Mastering Crypto Assets*.)
