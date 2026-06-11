# Stage 1 Official Docs Review - Coinbase Advanced Trade WS

Reviewed: **2026-06-11**

Status: **docs reviewed; keyed client still not implemented**

This review records the current official Coinbase contract the future Stage 1
implementation must satisfy after explicit approval. No credentialed code,
socket, JWT generation, or Coinbase request was added by this review.

## Sources

- Coinbase Advanced Trade WebSocket Overview:
  https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview
- Coinbase Advanced Trade WebSocket Authentication:
  https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-authentication
- Coinbase Advanced Trade WebSocket Channels:
  https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels
- Coinbase Advanced Trade WebSockets guide:
  https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/websocket

## Implementation Contract

1. Approval remains mandatory before implementation:
   `APPROVE_STAGE1_KEYED_WS_DATA_FEED_ONLY`.
2. The market-data endpoint is
   `wss://advanced-trade-ws.coinbase.com`.
3. The user-order endpoint is
   `wss://advanced-trade-ws-user.coinbase.com`. It is out of scope for Stage 1
   market data and must not be used for trading or stop placement here.
4. Subscription messages use JSON with `type:"subscribe"`, one `channel`, a
   `product_ids` array, and optionally `jwt`.
5. Coinbase says market-data channels are mostly available without
   authentication, but this project still requires the explicit keyed-feed
   approval because the requested Stage 1 is a deliberate credential decision.
6. JWTs for WebSocket messages are short lived. Coinbase docs state they expire
   after 2 minutes and must be regenerated for WebSocket messages.
7. WebSocket JWTs differ from REST JWTs: the authentication docs say WS JWTs
   are not built with a REST method or path.
8. The required credential shape is a key name like
   `organizations/{org_id}/apiKeys/{key_id}` plus an EC private key. The
   private key is multi-line material and must never be logged or committed.
9. Level2 is the primary Stage 1 channel because Coinbase documents it as the
   channel intended to keep an order book in sync. Subscription examples use
   `channel:"level2"`; the official receive example currently shows
   `channel:"l2_data"`, so the offline parser accepts both for Level2 payloads.
10. Level2 events include `snapshot` and `update` types with `product_id` and
    `updates`; each update carries `price_level`, `new_quantity`,
    `event_time`, and `side`.
11. `new_quantity` is an absolute size at that price level, not a delta.
    Quantity `"0"` removes the price level.
12. Coinbase documents `sequence_num` as increasing by exactly one for each new
    message. A jump means dropped messages; a lower value can be out of order
    or ignorable depending on state. Stage 1 offline audit treats duplicates,
    replayed values, lower values, and jumps as not-clean feed evidence.
13. The implementation must subscribe quickly after connection. The overview
    says the server disconnects connections that do not receive a subscription
    within 5 seconds.
14. Coinbase warns that some channels close after 60-90 seconds without
    updates and suggests heartbeats alongside other subscriptions. The future
    client should include heartbeats for liveness evidence. The audit treats
    heartbeat frames and monotonic `heartbeat_counter` values as required
    evidence for the WS-quality gate.
15. The offline subscription-plan contract must keep these rules explicit:
    market-data endpoint only, one channel per subscribe message, product IDs
    on market-data channels, heartbeats for liveness, and no user/futures
    channels in Stage 1.

## Repo Mapping

- `requireStage1KeyedWsApproval` must run before credential material is read.
- `coinbase_stage1_credentials_validate` maps the documented key-name and
  private-key shapes to an offline, post-approval check. It never returns
  credential values and does not generate JWTs or open sockets.
- `coinbase_stage1_feed_preflight` composes the credential-shape check with the
  subscription-plan contract before any future approved implementation can add
  JWT generation or socket behavior.
- `createStage1KeyedWsFrameSource` is the placeholder to replace after
  approval and docs re-check.
- `coinbase_stage1_subscription_plan` plans and validates subscribe-message
  shapes offline before any future approved connector can send them.
- `recordStage1FrameSource` is the required downstream path for received
  frames so parser, audit, journal, manifest, and readiness behavior are shared
  with fixtures.
- Stage 1 manifests include `frameEvidence` channel counts, sequence range, and
  heartbeat-counter range for later review of live-capture evidence.
- `coinbase_stage1_feed_audit` must pass on any captured frame window.
- `coinbase_stage1_readiness` must pass before Stage 2 can begin.

## Open Implementation Notes

- Coinbase docs include multiple language samples for JWT generation. Before
  implementing JavaScript signing, compare the current official SDK/helper
  behavior against the JavaScript sample and resolve issuer/audience/header
  differences explicitly.
- The existing placeholder env names are compatible with the docs' key-name and
  private-key shape, but the implementation pass must keep them secret-only:
  presence booleans may be reported, values may not.
- Stage 1 is market-data only. User channel, REST order endpoints, stops, and
  live execution remain Stage 3+ concerns after signal and risk gates.
