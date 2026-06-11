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
Offline fixture ingests remain test evidence only.

`recordStage1FrameSource` is the reusable recorder core the future approved
client should call. It accepts an async iterable of WS frame payloads and routes
them through the same audit, strict journal ingest, manifest, and readiness
contract used by fixtures.

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

1. Verify current official Coinbase Advanced Trade WebSocket/auth docs.
2. Keep secrets in environment variables or the operator's secret manager only.
3. Print only credential presence booleans, never values.
4. Mark every event with complete provenance: `source:"ws"`, `ageMs`,
   `hasSequence:true`, `confidence:"high"`, and `degraded:false`.
5. Detect `sequence_num` gaps and fail Stage 0 readiness unless the selected
   window is gap-clean.
6. Pass `coinbase_stage1_feed_audit`: zero parse errors, zero unsequenced
   frames, zero gaps, 100% clean WS provenance, and real L2 depth updates.
7. Use `coinbase_stage1_ingest_frames` or the same underlying ingest path to
   append only clean sequenced events to JSONL with a manifest.
8. Pass `coinbase_stage1_readiness` before Stage 2 starts.
9. Route future live keyed frame payloads through `recordStage1FrameSource`;
   set live manifest evidence flags only when the approved keyed WS rail was
   actually used.
10. Preserve no-lookahead replay: chronological ingest, walk-forward evaluation,
   deflated Sharpe, and realistic costs before any execution research.
11. Leave LIVE trading disconnected until later risk, kill-switch, and human
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
