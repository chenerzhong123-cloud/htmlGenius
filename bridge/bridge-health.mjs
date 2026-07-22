// bridge/bridge-health.mjs — v0.9 §3.4 Health 契约:C CLI doctor 与 Native Host 共用的**纯逻辑**层(不混 UI)。
// 输出脱敏诊断:reason_code 是唯一机器字段;remediation 只含 kind + label_key;
// 绝不含 path/command/stderr/token/cookie/session/thread/schema/完整版本原文(§2.4/§6.5)。
import { PROTOCOL_VERSION } from "./bridge-install.mjs";

export const HEALTH_SCHEMA_VERSION = 1;
export { PROTOCOL_VERSION as BRIDGE_PROTOCOL_VERSION };

// §3.4 必需 reason_code(可按需新增,但底层 stderr 永不透传)
export const REASON = {
  OS_UNSUPPORTED: "OS_UNSUPPORTED",
  NODE_UNSUPPORTED: "NODE_UNSUPPORTED",
  BRIDGE_NOT_INSTALLED: "BRIDGE_NOT_INSTALLED",
  BRIDGE_FILES_CORRUPT: "BRIDGE_FILES_CORRUPT",
  NATIVE_HOST_MANIFEST_MISSING: "NATIVE_HOST_MANIFEST_MISSING",
  EXTENSION_ORIGIN_MISMATCH: "EXTENSION_ORIGIN_MISMATCH",
  MANIFEST_FOREIGN: "MANIFEST_FOREIGN",
  BRIDGE_PROTOCOL_TOO_OLD: "BRIDGE_PROTOCOL_TOO_OLD",
  BRIDGE_PROTOCOL_TOO_NEW: "BRIDGE_PROTOCOL_TOO_NEW",
  ROOT_SCOPE_UNSUPPORTED: "ROOT_SCOPE_UNSUPPORTED",
  SETUP_DEPS_MISSING: "SETUP_DEPS_MISSING",
  REPAIR_NOT_CONFIRMED: "REPAIR_NOT_CONFIRMED",
  CLAUDE_NOT_INSTALLED: "CLAUDE_NOT_INSTALLED",
  CLAUDE_AUTH_REQUIRED: "CLAUDE_AUTH_REQUIRED",
  CODEX_APP_NOT_FOUND: "CODEX_APP_NOT_FOUND",
  CODEX_APP_UNTRUSTED: "CODEX_APP_UNTRUSTED",
  CODEX_APP_INCOMPATIBLE: "CODEX_APP_INCOMPATIBLE",
  CODEX_AUTH_REQUIRED: "CODEX_AUTH_REQUIRED",
  COPILOT_RUNTIME_NOT_FOUND: "COPILOT_RUNTIME_NOT_FOUND",
  COPILOT_AUTH_REQUIRED: "COPILOT_AUTH_REQUIRED",
  COPILOT_RUNTIME_INCOMPATIBLE: "COPILOT_RUNTIME_INCOMPATIBLE",
  PROVIDER_POLICY_BLOCKED: "PROVIDER_POLICY_BLOCKED",
  PROVIDER_PROBE_FAILED: "PROVIDER_PROBE_FAILED"
};

const VALID_PROVIDER_STATUS = { ready: 1, not_installed: 1, auth_required: 1, incompatible: 1, blocked: 1, error: 1, unsupported: 1 };
const VALID_REMEDIATION_KIND = { agent_login: 1, manual_update: 1, terminal_setup: 1, none: 1 };
const VALID_ACTIONS = { check: 1, repair: 1, copy_setup_prompt: 1, copy_terminal_command: 1, copy_diagnostics: 1 };

// provider probe 结果(§ provider-probe.mjs)→ health provider 条目(§3.4)。独立失败域:输入异常 → error 条目。
export function providerHealthEntry(probe) {
  const id = probe && typeof probe.id === "string" ? probe.id : "unknown";
  const base = { id, status: "error", capabilities: [], reason_code: REASON.PROVIDER_PROBE_FAILED, remediation: { kind: "none", label_key: "health.remediation.none" } };
  if (!probe || typeof probe !== "object") return base;
  const caps = Array.isArray(probe.capabilities) ? probe.capabilities.filter((c) => c === "candidate" || c === "plan") : [];
  const status = VALID_PROVIDER_STATUS[probe.status] ? probe.status : "error";
  const entry = { id, status, capabilities: caps, reason_code: null, remediation: null };

  const remediation = (kind, labelKey) => ({ kind, label_key: labelKey });
  if (id === "claude_code_cli") {
    if (status === "not_installed") { entry.reason_code = REASON.CLAUDE_NOT_INSTALLED; entry.remediation = remediation("manual_update", "health.remediation.installClaude"); }
    else if (status === "auth_required") { entry.reason_code = REASON.CLAUDE_AUTH_REQUIRED; entry.remediation = remediation("agent_login", "health.remediation.loginClaude"); }
    else if (status === "incompatible") { entry.reason_code = REASON.CLAUDE_NOT_INSTALLED; entry.remediation = remediation("manual_update", "health.remediation.updateClaude"); }
    else if (status === "error") { entry.reason_code = REASON.PROVIDER_PROBE_FAILED; entry.remediation = remediation("none", "health.remediation.none"); }
  } else if (id === "codex_app_server") {
    if (status === "not_installed") { entry.reason_code = REASON.CODEX_APP_NOT_FOUND; entry.remediation = remediation("manual_update", "health.remediation.installCodex"); }
    else if (status === "auth_required") { entry.reason_code = REASON.CODEX_AUTH_REQUIRED; entry.remediation = remediation("agent_login", "health.remediation.loginCodex"); }
    else if (status === "incompatible") { entry.reason_code = REASON.CODEX_APP_INCOMPATIBLE; entry.remediation = remediation("manual_update", "health.remediation.updateCodex"); }
    else if (status === "error") { entry.reason_code = REASON.PROVIDER_PROBE_FAILED; entry.remediation = remediation("none", "health.remediation.none"); }
  } else if (id === "github_copilot") {
    if (status === "not_installed") { entry.reason_code = REASON.COPILOT_RUNTIME_NOT_FOUND; entry.remediation = remediation("terminal_setup", "health.remediation.installCopilot"); }
    else if (status === "auth_required") { entry.reason_code = REASON.COPILOT_AUTH_REQUIRED; entry.remediation = remediation("agent_login", "health.remediation.loginCopilot"); }
    else if (status === "incompatible") { entry.reason_code = REASON.COPILOT_RUNTIME_INCOMPATIBLE; entry.remediation = remediation("manual_update", "health.remediation.updateCopilot"); }
    else if (status === "error") { entry.reason_code = REASON.PROVIDER_PROBE_FAILED; entry.remediation = remediation("none", "health.remediation.none"); }
  }
  // blocked / unsupported 保留 status,reason_code 由调用方按场景给(默认 null)
  if (status === "error" && !entry.reason_code) entry.reason_code = REASON.PROVIDER_PROBE_FAILED;
  return entry;
}

// 组装完整 health 对象(§3.4 形状)。overall 由 bridge/platform/providers 派生。
export function buildHealth({ bridgeStatus, bridgeVersion, managedInstall, protocolVersion, platform, browserStatus, providerProbes, reasonCode = null, extensionVersion = null, overallOverride = null }) {
  const providers = (Array.isArray(providerProbes) ? providerProbes : []).map(providerHealthEntry);
  const os = platform && platform.os === "macos" && platform.supported !== false;
  let overall = "error";
  if (overallOverride === "unsupported") overall = "unsupported";
  else if (!os) overall = "unsupported";
  else if (bridgeStatus === "ready") overall = providers.some((p) => p.status === "ready") ? "ready" : "action_required";
  else if (bridgeStatus === "install_required" || bridgeStatus === "repair_required" || bridgeStatus === "protocol_incompatible") overall = "action_required";

  const actions = [];
  if (bridgeStatus === "ready") actions.push("check", "repair");
  if (bridgeStatus === "install_required") actions.push("copy_setup_prompt", "copy_terminal_command");
  if (bridgeStatus === "repair_required" || bridgeStatus === "protocol_incompatible") actions.push("copy_setup_prompt", "copy_terminal_command");
  actions.push("copy_diagnostics");

  const health = {
    schema_version: HEALTH_SCHEMA_VERSION,
    overall,
    bridge: {
      status: bridgeStatus,
      version: typeof bridgeVersion === "string" ? bridgeVersion.slice(0, 32) : null,
      protocol_version: Number.isInteger(protocolVersion) ? protocolVersion : PROTOCOL_VERSION,
      managed_install: !!managedInstall
    },
    platform: {
      os: (platform && platform.os) || "unknown",
      arch: (platform && typeof platform.arch === "string") ? platform.arch.slice(0, 16) : "unknown",
      supported: !!os
    },
    browser: { status: browserStatus || "unknown" },
    providers,
    actions: actions.filter((a, i) => VALID_ACTIONS[a] && actions.indexOf(a) === i)
  };
  if (reasonCode) health.reason_code = reasonCode;
  if (typeof extensionVersion === "string") health.extension_version = extensionVersion.slice(0, 32);
  return sanitizeHealth(health);
}

// Native Host 不存在时的最小 health(§5.4「复制诊断」兜底形态)。
export function installRequiredHealth({ extensionVersion = null, reasonCode = REASON.BRIDGE_NOT_INSTALLED } = {}) {
  const h = {
    schema_version: HEALTH_SCHEMA_VERSION,
    overall: "action_required",
    bridge: { status: "install_required", version: null, protocol_version: PROTOCOL_VERSION, managed_install: false },
    browser: { status: "manifest_missing" },
    providers: [],
    actions: ["copy_setup_prompt", "copy_terminal_command", "copy_diagnostics"],
    reason_code: reasonCode
  };
  if (typeof extensionVersion === "string") h.extension_version = extensionVersion.slice(0, 32);
  return h;
}

// 纵深防御:递归剥离任何可能泄露系统细节的键(即便上游误传入)。
const BLOCKED_KEYS = { path: 1, paths: 1, command: 1, commands: 1, argv: 1, stderr: 1, stdout: 1, token: 1, tokens: 1, cookie: 1, cookies: 1, session: 1, session_id: 1, sessionId: 1, thread: 1, thread_id: 1, threadId: 1, schema: 1, stack: 1, env: 1, home: 1, host: 1, login: 1, credential: 1, credentials: 1 };
export function sanitizeHealth(value) {
  if (Array.isArray(value)) return value.map(sanitizeHealth);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      const lk = k.toLowerCase();
      if (BLOCKED_KEYS[lk] || BLOCKED_KEYS[k]) continue;
      out[k] = sanitizeHealth(value[k]);
    }
    return out;
  }
  return value;
}

// remediation kind 白名单校验(UI 侧也按 kind 分发,不读文本)
export function isValidRemediation(r) {
  return !r || !!(r && typeof r.kind === "string" && VALID_REMEDIATION_KIND[r.kind]);
}
