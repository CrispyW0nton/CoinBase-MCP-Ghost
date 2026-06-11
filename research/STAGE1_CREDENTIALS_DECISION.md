# Stage 1 Credentials Decision - Advanced Trade WS Data Feed

Status: **AWAITING EXPLICIT HUMAN APPROVAL**

Current stage: **Stage 1 - Real Sequenced Data Feed**

Gate status: **closed**. The keyed Coinbase Advanced Trade WebSocket client is
not implemented in this repository yet.

## Why this decision exists

Stage A produced a terminal no-edge verdict for the DOM imbalance signal. The
next valid research step is not execution; it is better data. Stage 1 may build
a Coinbase Advanced Trade WebSocket data feed only after a human explicitly
approves credential handling.

This is a deliberate change from the original ghost-only constraint. It must be
reviewed before any code holds or transits Advanced Trade API credential
material.

## Approval phrase

To approve building the keyed Stage 1 data-feed client, set:

```powershell
$env:CMCP_STAGE1_WS_APPROVAL = "APPROVE_STAGE1_KEYED_WS_DATA_FEED_ONLY"
```

or state the exact phrase to Codex in the next iteration:

```text
APPROVE_STAGE1_KEYED_WS_DATA_FEED_ONLY
```

The repository includes `npm run stage1:approval` and the MCP tool
`coinbase_stage1_credentials_status` to report this gate. They are offline-only
and never print secret values.

The repository also includes `npm run stage1:feed-audit` and the MCP tool
`coinbase_stage1_feed_audit`. They do not connect to Coinbase. They audit
supplied WS frame payloads offline so the future keyed feed has a concrete
acceptance contract before credentialed code exists.

`npm run stage1:ingest` and `coinbase_stage1_ingest_frames` add the matching
offline journal writer. They refuse dirty/gapped supplied frames by default and
write strict `source:"ws"` journal rows plus a manifest only after the
WS-quality gate passes. They still do not prove live WS flow until the frames
come from the approved keyed client.

`npm run stage1:readiness` and `coinbase_stage1_readiness` are the full Stage 1
gate reporter. They require approval, clean WS-only journal data, no gap events,
Stage-0 readiness on WS-quality data, and a completed live keyed WS manifest.
Offline fixture ingests remain test evidence only. Any future archive-backed
live manifest must satisfy the same raw-frame archive re-derivation inside
`coinbase_stage1_readiness` that `npm run stage1:manifest-audit` reports:
frame counts, frame evidence, and provenance must reproduce from
`raw-frames.jsonl`. Its preflight evidence must also include a subscription
plan for the manifest symbol with heartbeats and `level2`.

`npm run stage1:subscription-plan` and `coinbase_stage1_subscription_plan` are
the offline subscribe-message contract for the future approved client. They
validate the market endpoint, one channel per subscribe message, heartbeats for
liveness, market-data channels only, and rejection of user/futures channels.
They never generate JWTs, read credential material, or open a socket.

`coinbase_stage1_credentials_validate` is the post-approval offline
credential-shape validator. It refuses until `requireStage1KeyedWsApproval`
passes, then reads the proposed env vars only to check key-name and PEM
private-key shape. It returns booleans/status only and never prints credential
values, lengths, fingerprints, or PEM text. It does not generate JWTs, open a
socket, or implement the keyed client.

`coinbase_stage1_feed_preflight` is the post-approval offline preflight for the
future keyed feed. It composes credential-shape validation with the
subscription-plan contract and returns one preflight verdict. It still does not
generate JWTs, open sockets, place orders, or return credential values.

`recordStage1FrameSource` is the reusable recorder core the future approved
client should call. It accepts an async iterable of WS frame payloads and routes
them through the same audit, strict journal ingest, manifest, and readiness
contract used by fixtures.

`requireStage1KeyedWsApproval` is the mandatory guard for any future keyed feed
entrypoint. It must pass before credential material is read or a Coinbase WS
socket is opened. Approval remains scoped to market data only.

`createStage1KeyedWsFrameSource` is present as a fail-closed placeholder. It
checks approval first, then throws `STAGE1_KEYED_WS_CLIENT_NOT_IMPLEMENTED` so
this repository has a named future integration point without implementing the
credentialed client early.

## Proposed credential env names

These names are placeholders for the next implementation pass and are not used
by any Coinbase client yet:

```powershell
$env:CMCP_COINBASE_ADVANCED_TRADE_KEY_NAME = "<api key resource/name>"
$env:CMCP_COINBASE_ADVANCED_TRADE_PRIVATE_KEY = "<private key material>"
```

Before implementation, the pass must verify current Coinbase Advanced Trade API
documentation and adjust names/auth handling if Coinbase's official contract
differs.

The non-credentialed official WebSocket contract review is recorded in
`research/STAGE1_OFFICIAL_DOCS_REVIEW.md`. It documents endpoints,
subscription shape, Level2 semantics, sequence handling, heartbeat/liveness
requirements, and open JWT-signing questions. It did not add credentialed code
or open any Coinbase connection.

## Scope approved by the phrase

The phrase approves only:

- a Coinbase Advanced Trade WebSocket data feed client,
- sequenced market-data capture,
- `source:"ws"` provenance on every event,
- `sequence_num` gap detection,
- append-only journal output,
- Stage-0-style readiness checks on WS-quality data.

It does not approve:

- REST trading,
- order placement,
- stop-loss or take-profit management,
- LIVE arming,
- DOM clicking,
- credential logging,
- storing secrets in git,
- bypassing the kill switch.

## Required implementation gates after approval

1. Verify current official Coinbase Advanced Trade WebSocket/auth docs and
   update `research/STAGE1_OFFICIAL_DOCS_REVIEW.md` if the contract changed.
2. Keep secrets in environment variables or the operator's secret manager only.
3. Print only credential presence booleans, never values.
4. Run `coinbase_stage1_credentials_validate` after approval and before any
   socket/JWT work; it must pass without printing values.
5. Run `coinbase_stage1_feed_preflight` after approval; it must pass before a
   future implementation pass generates JWTs or opens the market-data socket.
6. Build subscription messages through the Stage 1 subscription-plan contract:
   market endpoint only, one channel per message, heartbeats included, no
   user/futures channels, and no REST trading endpoint.
7. Mark every event with complete provenance: `source:"ws"`, `ageMs`,
   `hasSequence:true`, `confidence:"high"`, and `degraded:false`.
8. Detect `sequence_num` gaps and fail Stage 0 readiness unless the selected
   window is gap-clean.
9. Pass `coinbase_stage1_feed_audit`: zero parse errors, zero unsequenced
   frames, zero gaps, zero duplicate/replayed sequence numbers,
   heartbeat/liveness evidence with monotonic counters, 100% clean WS
   provenance, and real L2 depth updates.
10. Use `coinbase_stage1_ingest_frames` or the same underlying ingest path to
   append only clean sequenced events to JSONL with a manifest that records
   channel inventory, sequence range, heartbeat-counter range, and a raw-frame
   SHA-256 digest. Preserve the matching raw frames in `raw-frames.jsonl`.
11. Pass `coinbase_stage1_manifest_audit`, including re-derived frame counts,
    frame evidence, and provenance, for archive-backed evidence.
12. Pass `coinbase_stage1_readiness` before Stage 2 starts.
13. Route future live keyed frame payloads through `recordStage1FrameSource`;
   set live manifest evidence flags only when the approved keyed WS rail was
   actually used. The manifest must also include nonzero frames and journal
   writes, zero parse/unsequenced/duplicate/out-of-order frames, zero journal
   rejects, heartbeat evidence, a valid sequence range, raw-frame SHA-256
   digest with matching archive, and 100% clean provenance. It must preserve a
   secret-free passed `coinbase_stage1_feed_preflight` snapshot as evidence.
14. Call `requireStage1KeyedWsApproval` before reading credential material or
    opening any Coinbase WS socket.
15. Replace the fail-closed `createStage1KeyedWsFrameSource` placeholder only
    after approval and official Coinbase docs review, including an explicit
    resolution of the JWT issuer/audience sample discrepancy before signing.
16. Preserve no-lookahead replay: chronological ingest, walk-forward evaluation,
   deflated Sharpe, and realistic costs before any execution research.
17. Leave LIVE trading disconnected until later risk, kill-switch, and human
   approval gates are passed.

## Knowledge-base rationale

- Kleppmann, DDIA: sequenced streams and replayable logs are reliability
  primitives.
- Harris, Trading and Exchanges: depth and spread data quality determines what
  can be inferred about microstructure.
- Lopez de Prado, AFML: no-lookahead, walk-forward validation, and deflated
  Sharpe are mandatory before accepting research results.
- Taleb and Kahneman: default to refusal when downside is large and operator
  confidence can outrun evidence.
