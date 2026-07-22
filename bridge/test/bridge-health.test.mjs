// bridge/test/bridge-health.test.mjs — v0.9 §3.4 health 纯逻辑:reason_code/remediation 映射、overall 派生、脱敏。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REASON, providerHealthEntry, buildHealth, installRequiredHealth, sanitizeHealth, isValidRemediation
} from "../bridge-health.mjs";

test("providerHealthEntry:三家 not_installed/auth_required/incompatible → 正确 reason_code + remediation kind", () => {
  const claudeNA = providerHealthEntry({ id: "claude_code_cli", status: "not_installed", capabilities: [] });
  assert.equal(claudeNA.reason_code, REASON.CLAUDE_NOT_INSTALLED);
  assert.equal(claudeNA.remediation.kind, "manual_update");

  const claudeAuth = providerHealthEntry({ id: "claude_code_cli", status: "auth_required", capabilities: [] });
  assert.equal(claudeAuth.reason_code, REASON.CLAUDE_AUTH_REQUIRED);
  assert.equal(claudeAuth.remediation.kind, "agent_login");

  const codexNA = providerHealthEntry({ id: "codex_app_server", status: "not_installed", capabilities: [] });
  assert.equal(codexNA.reason_code, REASON.CODEX_APP_NOT_FOUND);
  const codexUntrusted = providerHealthEntry({ id: "codex_app_server", status: "untrusted", capabilities: [] });
  assert.equal(codexUntrusted.status, "error"); // untrusted 不在 health 合法枚举 → error

  const copilotNA = providerHealthEntry({ id: "github_copilot", status: "not_installed", capabilities: [] });
  assert.equal(copilotNA.reason_code, REASON.COPILOT_RUNTIME_NOT_FOUND);
  assert.equal(copilotNA.remediation.kind, "terminal_setup");
  const copilotAuth = providerHealthEntry({ id: "github_copilot", status: "auth_required", capabilities: [] });
  assert.equal(copilotAuth.reason_code, REASON.COPILOT_AUTH_REQUIRED);
  const copilotBad = providerHealthEntry({ id: "github_copilot", status: "incompatible", capabilities: [] });
  assert.equal(copilotBad.reason_code, REASON.COPILOT_RUNTIME_INCOMPATIBLE);
});

test("providerHealthEntry:ready → 无 reason_code;异常输入 → error + PROVIDER_PROBE_FAILED", () => {
  const ready = providerHealthEntry({ id: "claude_code_cli", status: "ready", capabilities: ["candidate", "plan"], version: "1.2.3" });
  assert.equal(ready.status, "ready");
  assert.equal(ready.reason_code, null);
  assert.deepEqual(ready.capabilities, ["candidate", "plan"]);
  assert.equal(ready.version, undefined, "version 不透传到 health provider 条目之外(仅 label 用)");

  const broken = providerHealthEntry(null);
  assert.equal(broken.status, "error");
  assert.equal(broken.reason_code, REASON.PROVIDER_PROBE_FAILED);
  const weird = providerHealthEntry({ id: "claude_code_cli", status: "????" });
  assert.equal(weird.status, "error");
});

test("buildHealth:overall 派生矩阵", () => {
  const plat = { os: "macos", arch: "arm64", supported: true };
  // bridge ready + 有 ready provider → ready
  let h = buildHealth({ bridgeStatus: "ready", bridgeVersion: "0.9.0", managedInstall: true, protocolVersion: 1, platform: plat, browserStatus: "origin_ok", providerProbes: [{ id: "codex_app_server", status: "ready", capabilities: ["candidate"] }] });
  assert.equal(h.overall, "ready");
  assert.ok(h.actions.includes("check") && h.actions.includes("repair"));
  // bridge ready + 无 ready provider → action_required
  h = buildHealth({ bridgeStatus: "ready", bridgeVersion: "0.9.0", managedInstall: true, protocolVersion: 1, platform: plat, browserStatus: "origin_ok", providerProbes: [{ id: "claude_code_cli", status: "auth_required", capabilities: [] }] });
  assert.equal(h.overall, "action_required");
  // bridge install_required → action_required + 安装类 actions
  h = buildHealth({ bridgeStatus: "install_required", bridgeVersion: null, managedInstall: false, protocolVersion: 1, platform: plat, browserStatus: "manifest_missing", providerProbes: [], reasonCode: REASON.BRIDGE_NOT_INSTALLED });
  assert.equal(h.overall, "action_required");
  assert.ok(h.actions.includes("copy_setup_prompt"));
  assert.ok(h.actions.includes("copy_terminal_command"));
  assert.ok(h.actions.includes("copy_diagnostics"));
  // 平台不支持 → unsupported
  h = buildHealth({ bridgeStatus: "install_required", bridgeVersion: null, managedInstall: false, protocolVersion: 1, platform: { os: "win32", arch: "x64", supported: false }, browserStatus: "unknown", providerProbes: [] });
  assert.equal(h.overall, "unsupported");
});

test("sanitizeHealth:递归剥离 path/stderr/token/session 等键(即便上游误传)", () => {
  const dirty = {
    schema_version: 1, overall: "ready",
    bridge: { status: "ready", path: "/Users/x/.htmlgenius", stderr: "boom", token: "t", session_id: "s", thread: {} },
    providers: [{ id: "claude_code_cli", status: "ready", login: "me@x", credentials: ["c"] }]
  };
  const clean = sanitizeHealth(dirty);
  const json = JSON.stringify(clean);
  for (const bad of ["path", "stderr", "token", "session_id", "thread", "login", "credentials", "/Users"]) {
    assert.ok(!json.includes('"' + bad + '"'), "不应含键 " + bad);
  }
  assert.equal(clean.bridge.status, "ready");
  assert.equal(clean.providers[0].id, "claude_code_cli");
});

test("installRequiredHealth:§5.4 兜底形态(host 不存在时的复制诊断)", () => {
  const h = installRequiredHealth({ extensionVersion: "0.9.0" });
  assert.equal(h.schema_version, 1);
  assert.equal(h.overall, "action_required");
  assert.equal(h.bridge.status, "install_required");
  assert.equal(h.reason_code, REASON.BRIDGE_NOT_INSTALLED);
  assert.equal(h.extension_version, "0.9.0");
  assert.deepEqual(h.providers, []);
});

test("isValidRemediation:kind 白名单", () => {
  assert.equal(isValidRemediation(null), true);
  assert.equal(isValidRemediation({ kind: "agent_login", label_key: "x" }), true);
  assert.equal(isValidRemediation({ kind: "run_shell", label_key: "x" }), false);
});
