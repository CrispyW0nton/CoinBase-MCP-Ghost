# Antonopoulos — *Mastering Bitcoin*

**Why it matters here:** custody/security truth for BTC and the "not your keys"
discipline behind the read-only, no-credentials design.

## Ch.1–3 — How Bitcoin works / clients
- Decentralized ledger; transactions move value via UTXOs.

## Ch.4 — Keys, Addresses
- Private key → public key → address; signatures prove ownership.
- **MCP rule:** the MCP holds **no keys** and never derives or transmits one.

## Ch.5 — Wallets (HD, BIP-32/39/44)
- Seed phrase = master secret; back it up offline; never digitize/share.

## Ch.6 — Transactions
- Inputs/outputs, fees, **"Available" vs locked** funds — mirrors the
  Coinbase "Available vs Holds" the portfolio reader surfaces.

## Ch.7–9 — Advanced scripts, network, blockchain
- Multisig, script conditions; confirmations and finality.

## Ch.10–12 — Mining, consensus, security
- Proof-of-work; difficulty; the security model that backs the asset.

### Operational rules (agent surfaces to the human)
1. Self-custody for long-term holds; exchange custody carries counterparty risk.
2. Test small transfers; verify addresses.
3. Never share seed/private keys.

> The MCP enforces #3 structurally — no key-handling path exists.
> Cross-ref `12-antonopoulos-wood-mastering-ethereum.md`, `13-ammous...md`.
