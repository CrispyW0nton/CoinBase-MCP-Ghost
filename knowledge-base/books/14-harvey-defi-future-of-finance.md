# Harvey, Ramachandran & Santoro — *DeFi and the Future of Finance*

**Why it matters here:** context for the assets traded on Coinbase and the risks
that live *off* the centralized order book. Coinbase lists many DeFi/governance
tokens; an agent must understand what it is observing.

---

## Ch. I–II — Introduction & Origins
- DeFi = open-source financial building blocks composed with minimized friction.
- Problems it targets: centralized control, limited access, inefficiency, lack
  of interoperability, opacity.
- **MCP usage:** explains *why* many Coinbase-listed tokens exist; their value is
  protocol-usage-driven, not cash-flow-driven — valuation differs from equities.

## Ch. III–IV — Infrastructure & Primitives
- Primitives: fungible (ERC-20) & non-fungible tokens, custody, supply
  adjustment (mint/burn), incentives, swaps (AMMs, `k = x·y`), collateralized &
  flash loans, stablecoins (fiat/crypto/algorithmic), derivatives, DAOs.
- **MCP usage:** when recon shows a token pair, classify it by primitive. An
  algorithmic-stablecoin pair carries de-peg tail risk that a fiat-backed
  (USDC) pair does not — size accordingly (ties to Taleb tail rules).

## Ch. V — Problems DeFi Solves
- Lower fees, faster settlement, transparency via public ledgers.

## Ch. VI — Deep Dive (protocols)
- MakerDAO (DAI), Compound/Aave (algorithmic-rate lending), Uniswap (AMM DEX),
  dYdX (perps), Synthetix (synths), Set (token baskets), wBTC.
- **MCP usage:** the *spot* price we observe on Coinbase can decouple from
  on-chain/DEX prices; cross-venue divergence is information, not noise.

## Ch. VII — Risks *(critical for asset selection)*
- Smart-contract risk (reentrancy, exploits), governance risk, **oracle risk**,
  scaling risk, DEX risk, custodial risk, regulatory risk, impermanent loss.
- **MCP rules:**
  - Treat tokens with unaudited contracts or oracle dependencies as higher tail
    risk → smaller (or zero) size.
  - Be aware of **front-running/MEV** as a structural cost in crypto markets;
    our market-order fills can be worse than the mid for this reason.
  - Default to the most battle-tested majors (BTC, ETH) unless due diligence
    (see `Mastering Crypto Assets`) clears a token.

## Ch. VIII — Conclusions
- DeFi expands the opportunity set but multiplies risk surfaces.

> Cross-ref `06-taleb.md` (tail risk), `11-antonopoulos-mastering-bitcoin.md` &
> `12-antonopoulos-wood-mastering-ethereum.md` (custody/security).
