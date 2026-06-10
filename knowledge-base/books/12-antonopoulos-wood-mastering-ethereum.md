# Antonopoulos & Wood — *Mastering Ethereum*

**Why it matters here:** custody/security reality for ETH and ERC-20 assets the
MCP may observe on Coinbase, and the "not your keys" discipline that justifies
the read-only, no-credentials design.

---

## Ch.1–3 — What is Ethereum / Basics / Clients
- Ethereum = deterministic, practically-unbounded state machine + EVM.

## Ch.4 — Cryptography
- Ownership = private key → address → signature. **The MCP never holds or
  transits any private key** (Hard Constraint #1).

## Ch.5 — Wallets
- Deterministic (HD, BIP-32/44) vs nondeterministic wallets.
- **MCP rule:** custody is the user's, on Coinbase; we observe balances via the
  DOM only.

## Ch.6 — Transactions
- Signed messages from EOAs: nonce (replay protection), gas price/limit,
  recipient, value, data.

## Ch.7–8 — Smart Contracts (Solidity/Vyper)
- Immutable deterministic programs.

## Ch.9 — Smart Contract Security *(critical)*
- **Reentrancy** (The DAO), arithmetic overflow, unchecked return values.
  Use checks-effects-interactions.
- **MCP usage:** tokens whose contracts carry these risks deserve a tail-risk
  haircut (ties to Harvey Ch.VII, Taleb).

## Ch.10 — Tokens
- ERC-20 (fungible), ERC-721 (NFT).

## Ch.11–12 — Oracles & DApps
- Oracle dependence is an attack surface (price-feed manipulation).

## Ch.13–14 — EVM & Consensus
- Stack machine, gas-metered (halting-problem safe), ~140 opcodes.

### Operational security rules (for the human, surfaced by the agent)
1. Never send ERC-20 to an ether-only exchange address (permanent loss).
2. Use EIP-55 checksummed addresses.
3. Test small before large transfers.
4. Use bookmarks (avoid phishing search results).
5. **Never share private keys / seed phrases** — exchanges only need a public
   address.
6. Mind nonce ordering on stuck withdrawals.

> The MCP enforces #5 by construction: it has no key-handling code path at all.
> Cross-ref `11-antonopoulos-mastering-bitcoin.md`, `14-harvey-defi...md`.
