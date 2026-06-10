# Playbook 01 — OBSERVE_ONLY Recon

1. Launch Chrome: `scripts/launch-chrome-coinbase.ps1`, sign in once.
2. `coinbase_attach` → require `signedIn === true` (else stop).
3. `coinbase_recon` → reads `recon/<symbol>-<ts>/`.
4. Interpret with **Harris Ch.4–7** (order book), **Kleppmann Ch.11** (feed
   integrity), **Newman Ch.4** (selector stability). Do not act on a feed with
   unresolved gaps. No orders, no Preview/Place clicks.
