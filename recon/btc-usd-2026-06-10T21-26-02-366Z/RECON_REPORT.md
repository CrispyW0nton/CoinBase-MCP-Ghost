# Coinbase Transport Diagnostic — BTC-USD

_Captured: 2026-06-10T21:26:02.370Z_  
_Test order: trade first, then portfolio._  
_Mode: OBSERVE_ONLY; passive CDP observation only._

## WS TAP VIABLE: NO

No CDP WebSocket frames were captured after early attach/navigation; live data appears available through REST/polling and rendered DOM in this Chrome/Coinbase build.

Reproduction steps:

1. Attach to the existing Coinbase advanced page target over CDP.
2. Enable `Network` listeners before navigation for WebSocket, EventSource, REST/poll, and WebTransport events.
3. Navigate the same signed-in tab to `/advanced-trade/spot/BTC-USD` and observe.
4. Enumerate Coinbase worker/shared-worker/service-worker targets and attach passive Network listeners.
5. Navigate the same tab to `/advanced-portfolio` and observe.

No Buy/Sell/Preview/Place controls were clicked. No Coinbase API client, SDK,
credentials, cookies, or independent Coinbase socket were used.

## WebSocket observations

_No WebSocket frames or socket creation events were captured after early attach/navigation._

## SSE / EventSource

_No EventSource messages captured._

## REST / polling candidates

- primary-page-before-navigation / page: `GET /api/v3/brokerage/products` x6 (application/json)
- primary-page-before-navigation / page: `GET /api/v3/brokerage/user_chart_config/BTC-USD` x5 (application/json)
- primary-page-before-navigation / page: `GET /api/v3/brokerage/stream/balance_summary` x1 (text/event-stream)
- primary-page-before-navigation / page: `GET /api/v3/brokerage/stream/products/BTC-USD/stats` x1 (text/event-stream)
- primary-page-before-navigation / page: `GET /api/v3/brokerage/products/BTC-USD/trades` x1 (text/event-stream)
- primary-page-before-navigation / page: `GET /api/v3/brokerage/products/BTC-USD/stats` x1 (application/json)

## WebTransport / QUIC

_No WebTransport events captured._

## Data-quality consequence

Per Harris, rendered DOM depth is a lower-grade microstructure observation than
the exchange's sequenced feed. Per Kleppmann, gap detection requires a reliable
sequence. Per Lopez de Prado and Kahneman, downstream signals and Kelly sizing
must not treat low-quality samples as clean evidence. Therefore DOM fallback
events are labeled `source:"dom"`, `hasSequence:false`,
`confidence:"low"`, and derived Kelly output refuses degraded inputs.
