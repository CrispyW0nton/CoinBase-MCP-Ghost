import { fileURLToPath } from "node:url";

export const STAGE1_MARKET_DATA_WS_ENDPOINT = "wss://advanced-trade-ws.coinbase.com";
export const STAGE1_USER_WS_ENDPOINT = "wss://advanced-trade-ws-user.coinbase.com";

export const STAGE1_DEFAULT_PRODUCT_IDS = ["BTC-USD"];
export const STAGE1_DEFAULT_CHANNELS = ["level2", "ticker", "market_trades"];
export const STAGE1_HEARTBEATS_CHANNEL = "heartbeats";

const MARKET_DATA_SUBSCRIPTION_CHANNELS = new Set([
  "heartbeats",
  "candles",
  "status",
  "ticker",
  "ticker_batch",
  "level2",
  "market_trades"
]);

const FORBIDDEN_STAGE1_CHANNELS = new Set([
  "user",
  "futures_balance_summary"
]);

const RECEIVE_CHANNEL_ALIASES = new Map([
  ["l2_data", "level2"]
]);

export function createStage1SubscriptionPlan(args = {}) {
  const {
    productIds = STAGE1_DEFAULT_PRODUCT_IDS,
    channels = STAGE1_DEFAULT_CHANNELS,
    includeHeartbeats = true,
    jwt = null,
    endpoint = STAGE1_MARKET_DATA_WS_ENDPOINT
  } = args;

  const normalizedProductIds = normalizeProductIds(productIds);
  const { channels: normalizedChannels, warnings } = normalizeChannels(channels);
  const requestedChannels = [...normalizedChannels];

  if (includeHeartbeats !== false && !normalizedChannels.includes(STAGE1_HEARTBEATS_CHANNEL)) {
    normalizedChannels.unshift(STAGE1_HEARTBEATS_CHANNEL);
  }

  const jwtValue = typeof jwt === "string" && jwt.trim() ? jwt.trim() : null;
  const messages = normalizedChannels.map(channel => {
    const message = { type: "subscribe", channel };
    if (channel !== STAGE1_HEARTBEATS_CHANNEL) message.product_ids = normalizedProductIds;
    if (jwtValue) message.jwt = jwtValue;
    return message;
  });

  const validation = validateStage1SubscriptionPlan({
    endpoint,
    productIds: normalizedProductIds,
    messages,
    includeHeartbeats,
    warnings
  });

  return {
    stage: "Stage 1 - Real Sequenced Data Feed",
    offlineOnly: true,
    networkTouched: false,
    keyedClientImplemented: false,
    credentialMaterialRead: false,
    jwtGenerated: false,
    liveTradingEnabled: false,
    endpoint,
    forbiddenEndpoint: STAGE1_USER_WS_ENDPOINT,
    requestedChannels,
    channels: normalizedChannels,
    productIds: normalizedProductIds,
    includeHeartbeats: includeHeartbeats !== false,
    jwtProvided: Boolean(jwtValue),
    messages,
    validation,
    safety: {
      marketDataOnly: validation.pass,
      noUserChannel: !normalizedChannels.some(channel => FORBIDDEN_STAGE1_CHANNELS.has(channel)),
      noOrders: true,
      noStops: true,
      noRestTrading: true,
      noLiveArming: true
    },
    notes: [
      "This is an offline subscription contract only; it opens no socket.",
      "JWT values may be passed through for shape validation, but this module never generates or validates JWTs.",
      "The approved implementation must regenerate short-lived WS JWTs outside this planner before sending messages.",
      "The user WebSocket endpoint and user/futures channels remain out of Stage 1 scope."
    ]
  };
}

export function validateStage1SubscriptionPlan({
  endpoint = STAGE1_MARKET_DATA_WS_ENDPOINT,
  productIds = STAGE1_DEFAULT_PRODUCT_IDS,
  messages = [],
  includeHeartbeats = true,
  warnings = []
} = {}) {
  const reasons = [];
  const seenChannels = new Set();

  if (endpoint !== STAGE1_MARKET_DATA_WS_ENDPOINT) {
    reasons.push(`endpoint must be ${STAGE1_MARKET_DATA_WS_ENDPOINT}`);
  }
  if (!Array.isArray(productIds) || productIds.length === 0) {
    reasons.push("at least one product ID is required for market-data subscriptions");
  }
  for (const productId of productIds) {
    if (typeof productId !== "string" || !/^[A-Z0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(productId)) {
      reasons.push(`invalid product ID: ${String(productId)}`);
    }
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    reasons.push("at least one subscribe message is required");
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      reasons.push("subscription message must be an object");
      continue;
    }
    if (message.type !== "subscribe") {
      reasons.push("subscription message type must be subscribe");
    }
    const channel = message.channel;
    if (typeof channel !== "string" || !channel) {
      reasons.push("subscription message channel is required");
      continue;
    }
    if (seenChannels.has(channel)) {
      reasons.push(`duplicate subscription channel: ${channel}`);
    }
    seenChannels.add(channel);
    if (FORBIDDEN_STAGE1_CHANNELS.has(channel)) {
      reasons.push(`channel ${channel} is forbidden in Stage 1`);
    } else if (!MARKET_DATA_SUBSCRIPTION_CHANNELS.has(channel)) {
      reasons.push(`unsupported market-data channel: ${channel}`);
    }
    if (Object.prototype.hasOwnProperty.call(message, "channels")) {
      reasons.push("one channel per subscription message is required; found channels array");
    }
    if (channel === STAGE1_HEARTBEATS_CHANNEL) {
      if (Object.prototype.hasOwnProperty.call(message, "product_ids")) {
        reasons.push("heartbeats subscription must not require product_ids");
      }
    } else if (!Array.isArray(message.product_ids) || message.product_ids.length === 0) {
      reasons.push(`channel ${channel} requires product_ids`);
    }
  }

  if (includeHeartbeats !== false && !seenChannels.has(STAGE1_HEARTBEATS_CHANNEL)) {
    reasons.push("heartbeats subscription is required for Stage 1 liveness");
  }

  return {
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    pass: reasons.length === 0,
    reasons,
    warnings
  };
}

function normalizeProductIds(productIds) {
  const list = Array.isArray(productIds) ? productIds : [productIds];
  return [...new Set(list.map(item => String(item || "").trim().toUpperCase()).filter(Boolean))];
}

function normalizeChannels(channels) {
  const warnings = [];
  const list = Array.isArray(channels) ? channels : [channels];
  const normalized = [];
  for (const raw of list) {
    const channel = String(raw || "").trim();
    if (!channel) continue;
    const canonical = RECEIVE_CHANNEL_ALIASES.get(channel) || channel;
    if (canonical !== channel) {
      warnings.push(`receive channel ${channel} normalized to subscription channel ${canonical}`);
    }
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  return { channels: normalized, warnings };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  if (args.productIds) args.productIds = String(args.productIds).split(",").map(item => item.trim()).filter(Boolean);
  if (args.channels) args.channels = String(args.channels).split(",").map(item => item.trim()).filter(Boolean);
  if (args.includeHeartbeats !== undefined) args.includeHeartbeats = args.includeHeartbeats !== "false";
  return args;
}

function main() {
  console.log(JSON.stringify(createStage1SubscriptionPlan(parseArgs()), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
