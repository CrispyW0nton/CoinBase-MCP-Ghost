import {
  STAGE1_APPROVAL_ENV,
  STAGE1_APPROVAL_PHRASE,
  STAGE1_CREDENTIAL_ENVS,
  requireStage1KeyedWsApproval
} from "./stage1-approval.js";

const KEY_NAME_RE = /^organizations\/[^/\s]+\/apiKeys\/[^/\s]+$/;
const PRIVATE_KEY_HEADER_RE = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/;
const PRIVATE_KEY_FOOTER_RE = /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/;

function credentialShapeChecks({ keyName, privateKey }) {
  const keyNamePresent = typeof keyName === "string" && keyName.trim().length > 0;
  const privateKeyPresent = typeof privateKey === "string" && privateKey.trim().length > 0;

  const privateKeyLines = privateKeyPresent
    ? privateKey.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : [];
  const hasPemHeader = privateKeyLines.length >= 3 && PRIVATE_KEY_HEADER_RE.test(privateKeyLines[0]);
  const hasPemFooter = privateKeyLines.length >= 3 && PRIVATE_KEY_FOOTER_RE.test(privateKeyLines.at(-1));
  const hasPemBody = privateKeyLines.slice(1, -1).some(line => line.length > 0);

  return {
    keyNamePresent,
    keyNameShape: keyNamePresent && KEY_NAME_RE.test(keyName.trim()) ? "pass" : "fail",
    privateKeyPresent,
    privateKeyPemShape: privateKeyPresent && hasPemHeader && hasPemFooter && hasPemBody ? "pass" : "fail"
  };
}

function validationReasons(checks) {
  const reasons = [];
  if (!checks.keyNamePresent) {
    reasons.push(`${STAGE1_CREDENTIAL_ENVS[0]} is missing`);
  } else if (checks.keyNameShape !== "pass") {
    reasons.push(`${STAGE1_CREDENTIAL_ENVS[0]} must look like organizations/<org_id>/apiKeys/<key_id>`);
  }

  if (!checks.privateKeyPresent) {
    reasons.push(`${STAGE1_CREDENTIAL_ENVS[1]} is missing`);
  } else if (checks.privateKeyPemShape !== "pass") {
    reasons.push(`${STAGE1_CREDENTIAL_ENVS[1]} must look like a non-empty PEM private key`);
  }

  return reasons;
}

export function validateStage1CredentialMaterial({
  env = process.env,
  purpose = "Stage 1 credential validation"
} = {}) {
  const approval = requireStage1KeyedWsApproval({ env, purpose });

  const keyName = env[STAGE1_CREDENTIAL_ENVS[0]] || "";
  const privateKey = env[STAGE1_CREDENTIAL_ENVS[1]] || "";
  const checks = credentialShapeChecks({ keyName, privateKey });
  const reasons = validationReasons(checks);

  return {
    stage: "Stage 1 - Real Sequenced Data Feed",
    offlineOnly: true,
    networkTouched: false,
    keyedClientImplemented: false,
    credentialMaterialRead: true,
    jwtGenerated: false,
    liveTradingEnabled: false,
    approval: {
      approved: approval.approval.approved,
      approvalEnv: STAGE1_APPROVAL_ENV,
      requiredApprovalPhrase: STAGE1_APPROVAL_PHRASE
    },
    credentialEnvNames: STAGE1_CREDENTIAL_ENVS,
    checks,
    pass: reasons.length === 0,
    reasons,
    secretsPrinted: false
  };
}
