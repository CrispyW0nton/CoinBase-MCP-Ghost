import { fileURLToPath } from "node:url";

export const STAGE1_APPROVAL_ENV = "CMCP_STAGE1_WS_APPROVAL";
export const STAGE1_APPROVAL_PHRASE = "APPROVE_STAGE1_KEYED_WS_DATA_FEED_ONLY";

export const STAGE1_CREDENTIAL_ENVS = [
  "CMCP_COINBASE_ADVANCED_TRADE_KEY_NAME",
  "CMCP_COINBASE_ADVANCED_TRADE_PRIVATE_KEY"
];

export function stage1ApprovalStatus(env = process.env) {
  const approvalValue = env[STAGE1_APPROVAL_ENV] || "";
  const approved = approvalValue === STAGE1_APPROVAL_PHRASE;
  const credentialMaterialPresent = Object.fromEntries(
    STAGE1_CREDENTIAL_ENVS.map(name => [name, Boolean(env[name])])
  );

  return {
    stage: "Stage 1 - Real Sequenced Data Feed",
    gate: approved ? "APPROVED_TO_BUILD_KEYED_WS_DATA_FEED" : "AWAITING_EXPLICIT_HUMAN_APPROVAL",
    approved,
    safeToBuildKeyedWs: approved,
    approvalEnv: STAGE1_APPROVAL_ENV,
    requiredApprovalPhrase: STAGE1_APPROVAL_PHRASE,
    credentialEnvNames: STAGE1_CREDENTIAL_ENVS,
    credentialMaterialPresent,
    secretsPrinted: false,
    networkTouched: false,
    keyedClientImplemented: false,
    liveTradingEnabled: false,
    notes: [
      "This status check is offline-only and never opens a Coinbase socket.",
      "Credential values are never printed or validated here.",
      "Approval covers a data-feed client only: sequenced Advanced Trade WebSocket capture with source:\"ws\" provenance and gap detection.",
      "It does not approve REST trading, order placement, stop management, DOM execution, or LIVE arming."
    ]
  };
}

export function requireStage1KeyedWsApproval({ env = process.env, purpose = "keyed_ws_data_feed" } = {}) {
  const status = stage1ApprovalStatus(env);
  if (status.approved) {
    return {
      ok: true,
      purpose,
      approval: status,
      allowedScope: [
        "Coinbase Advanced Trade WebSocket market-data feed",
        "sequenced frame capture",
        "source:\"ws\" provenance",
        "sequence_num gap detection",
        "append-only journal output",
        "Stage-0 readiness measurement on WS-quality data"
      ],
      forbiddenScope: [
        "REST trading",
        "order placement",
        "stop-loss placement",
        "LIVE arming",
        "DOM execution",
        "credential logging",
        "kill-switch bypass"
      ]
    };
  }

  const err = new Error(
    `Stage 1 keyed WS approval is required for ${purpose}. ` +
    `Set ${status.approvalEnv} to ${status.requiredApprovalPhrase}.`
  );
  err.code = "STAGE1_KEYED_WS_APPROVAL_REQUIRED";
  err.stage = status.stage;
  err.purpose = purpose;
  err.approvalEnv = status.approvalEnv;
  err.requiredApprovalPhrase = status.requiredApprovalPhrase;
  err.approved = false;
  err.secretsPrinted = false;
  err.networkTouched = false;
  err.liveTradingEnabled = false;
  throw err;
}

export function assertNoStage1Secrets(status) {
  const serialized = JSON.stringify(status);
  for (const name of STAGE1_CREDENTIAL_ENVS) {
    const value = process.env[name];
    if (value && serialized.includes(value)) {
      throw new Error(`Stage 1 status leaked secret value for ${name}`);
    }
  }
  return true;
}

async function main() {
  const status = stage1ApprovalStatus();
  assertNoStage1Secrets(status);
  console.log(JSON.stringify(status, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
