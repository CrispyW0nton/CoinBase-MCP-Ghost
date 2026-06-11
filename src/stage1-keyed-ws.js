import { requireStage1KeyedWsApproval } from "./stage1-approval.js";

export const STAGE1_KEYED_WS_NOT_IMPLEMENTED = "STAGE1_KEYED_WS_CLIENT_NOT_IMPLEMENTED";

export function createStage1KeyedWsFrameSource({
  env = process.env,
  productIds = ["BTC-USD"],
  channels = ["level2", "market_trades", "ticker"],
  purpose = "keyed Coinbase Advanced Trade WS data feed"
} = {}) {
  const approval = requireStage1KeyedWsApproval({ env, purpose });
  const err = new Error(
    "Stage 1 keyed Coinbase Advanced Trade WS client is not implemented yet. " +
    "Approval has been checked, but no credential material was read and no socket was opened."
  );
  err.code = STAGE1_KEYED_WS_NOT_IMPLEMENTED;
  err.stage = "Stage 1 - Real Sequenced Data Feed";
  err.approvalChecked = true;
  err.approved = approval.approval.approved;
  err.credentialMaterialRead = false;
  err.networkTouched = false;
  err.keyedClientImplemented = false;
  err.liveTradingEnabled = false;
  err.productIds = productIds;
  err.channels = channels;
  err.allowedScope = approval.allowedScope;
  err.forbiddenScope = approval.forbiddenScope;
  throw err;
}
