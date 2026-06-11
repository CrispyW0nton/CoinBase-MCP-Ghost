import { validateStage1CredentialMaterial } from "./stage1-credentials.js";
import { createStage1SubscriptionPlan } from "./stage1-ws-contract.js";

export function stage1FeedPreflight({
  env = process.env,
  productIds,
  channels,
  includeHeartbeats,
  purpose = "Stage 1 keyed WS feed preflight"
} = {}) {
  const credentials = validateStage1CredentialMaterial({ env, purpose });
  const subscriptionPlan = createStage1SubscriptionPlan({
    productIds,
    channels,
    includeHeartbeats
  });

  const reasons = [
    ...credentials.reasons,
    ...subscriptionPlan.validation.reasons
  ];
  const warnings = [
    ...subscriptionPlan.validation.warnings
  ];

  return {
    generatedAt: new Date().toISOString(),
    stage: "Stage 1 - Real Sequenced Data Feed",
    offlineOnly: true,
    networkTouched: false,
    keyedClientImplemented: false,
    credentialMaterialRead: credentials.credentialMaterialRead,
    jwtGenerated: false,
    liveTradingEnabled: false,
    approval: credentials.approval,
    credentials: {
      pass: credentials.pass,
      checks: credentials.checks,
      credentialEnvNames: credentials.credentialEnvNames,
      secretsPrinted: credentials.secretsPrinted
    },
    subscriptionPlan,
    preflight: {
      pass: credentials.pass && subscriptionPlan.validation.pass,
      reasons,
      warnings,
      safeToGenerateJwtInFutureClient: credentials.pass && subscriptionPlan.validation.pass,
      safeToOpenSocketInThisFunction: false
    },
    nextRequiredActions: [
      "Re-check current Coinbase Advanced Trade WebSocket/auth docs before implementation.",
      "Generate short-lived WebSocket JWTs only in the approved keyed client implementation pass.",
      "Open the market-data WebSocket only from the approved keyed client, never from this offline preflight.",
      "Route every received frame through recordStage1FrameSource and the Stage 1 audit/ingest/readiness path."
    ],
    safety: {
      noSocketOpened: true,
      noJwtGenerated: true,
      noOrders: true,
      noStops: true,
      noRestTrading: true,
      noLiveArming: true,
      noCredentialValuesReturned: true
    }
  };
}
