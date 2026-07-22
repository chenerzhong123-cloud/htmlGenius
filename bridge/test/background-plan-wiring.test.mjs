// bridge/test/background-plan-wiring.test.mjs — 锁定 v0.8.1 background.js 的 plan/probe 接线(源码级断言)。
// background.js 依赖 chrome.*/importScripts,无法直接在 Node 跑;故仿 artifact-contract.test.mjs 用源码级断言锁住关键行为契约。
// 覆盖 spec §9:bridge-start 拒绝 continue(SESSION_MODE_NOT_ALLOWED)、plan run kind、plan-ready 分支、provider probe 入口、
//   bridge-plan-ready 广播不含 manifest_path/session/thread、approved_plan 注入、PlanValidate 调用点。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "background.js"), "utf8");

test("background importScripts 含 plan-validate.js(PlanValidate 可用)", () => {
  assert.match(bg, /importScripts\([^)]*plan-validate\.js/);
});

test("background 允许 plan run kind(ALLOWED_RUN_KINDS 含 plan)", () => {
  assert.match(bg, /ALLOWED_RUN_KINDS\s*=\s*new Set\(\[["'\s]candidate["'\s,]+["'\s]plan/);
});

test("background 对 candidate/plan 拒绝 continue → SESSION_MODE_NOT_ALLOWED(spec §5.2/§9)", () => {
  // 必须有 session_mode !== "new" 的门禁,且失败码为 SESSION_MODE_NOT_ALLOWED
  const m = bg.match(/runKind === "candidate" \|\| runKind === "plan"[^)]*\) && session_mode !== "new"/);
  assert.ok(m, "缺少 candidate/plan 的 session_mode==='new' 强制门禁");
  assert.match(bg, /SESSION_MODE_NOT_ALLOWED/);
});

test("background handleBridgeStart 解构 plan 参数(candidate 携带 plan 入口)", () => {
  assert.match(bg, /handleBridgeStart\(\{[^}]*\bplan\b/);
});

test("background candidate+plan 路径调用 PlanValidate.validatePlanConfirmation(§5.4)", () => {
  assert.match(bg, /PlanValidate\.validatePlanConfirmation/);
});

test("background onHostMessage 含 plan-ready 分支 → completePlan", () => {
  assert.match(bg, /m\.type === "plan-ready"/);
  assert.match(bg, /completePlan\(tab_id, runId, m, taskSha, logicalId, artifactUrl\)/);
});

test("background bridge-query-providers 消息入口存在(§5.1)", () => {
  assert.match(bg, /msg\.type === "bridge-query-providers"/);
  assert.match(bg, /handleQueryProviders\(\)/);
  assert.match(bg, /provider_probe/); // 发给 host 的 native 消息
});

test("background bridge-plan-ready 广播不含 manifest_path / session_id / thread_id / 路径(§5.3 不向 UI 泄露)", () => {
  // 截 bridge-plan-ready 广播块
  const start = bg.indexOf('type: "bridge-plan-ready"');
  assert.ok(start > -1, "缺 bridge-plan-ready 广播");
  const end = bg.indexOf("});", start);
  const block = bg.slice(start, end);
  assert.doesNotMatch(block, /manifest_path/);
  assert.doesNotMatch(block, /session_id/);
  assert.doesNotMatch(block, /thread_id/);
  assert.doesNotMatch(block, /_path\b/);
  // 必须带 plan_id + plan
  assert.match(block, /plan_id:/);
  assert.match(block, /plan:/);
  // v0.8.2 §1.1 回归:广播必须携带 plan_sha256(取自 planRec),否则 Side Panel 确认计划时
  // planPayload() 回传 undefined → validatePlanConfirmation 恒 PLAN_INVALID,Plan-first 闭环断裂。
  assert.match(block, /plan_sha256:\s*planRec\.plan_sha256/);
});

test("background candidate 携带 plan → startMsg 注入 approved_plan(§6.8)", () => {
  assert.match(bg, /startMsg\.approved_plan\s*=/);
  assert.match(bg, /approved_plan.*plan_id.*plan_sha256.*edited_plan_markdown/s);
});

test("background launch 成功后把 plan 标 approved + 记 candidate_run_id(§5.4)", () => {
  assert.match(bg, /updateBridgePlan\(plan\.plan_id,\s*\{\s*status:\s*"approved"[^}]*candidate_run_id:\s*runId/s);
});

test("background completePlan 建 bridge_plans 记录且存 host_source_sha256_before 作证据(不跨侧比)", () => {
  assert.match(bg, /saveBridgePlan\(planRec\)/);
  assert.match(bg, /host_source_sha256_before:\s*planReady\.source_sha256_before/);
});

test("background provider probe 缓存 30s(makeProviderProbeCache)", () => {
  assert.match(bg, /PlanValidate\.makeProviderProbeCache\(\)/);
  assert.match(bg, /_providerProbe\.get\(\)/);
  assert.match(bg, /_providerProbe\.set\(result\)/);
});

// —— v0.8.2 §6.3:GitHub Copilot provider 接线(源码级)——
test("background v0.8.2:COPILOT_PROVIDER 与 SUPPORTED_PROVIDERS 含 github_copilot", () => {
  assert.match(bg, /COPILOT_PROVIDER = "github_copilot"/);
  assert.match(bg, /SUPPORTED_PROVIDERS = new Set\(\[PROVIDER, CODEX_PROVIDER, COPILOT_PROVIDER\]\)/);
});

test("background v0.8.2:每 provider 明确 handoff type(禁 ternary 默认),copilot → copilot_handoff_start", () => {
  assert.match(bg, /HANDOFF_START_TYPES = \{/);
  assert.match(bg, /\[COPILOT_PROVIDER\]: "copilot_handoff_start"/);
  assert.match(bg, /type: HANDOFF_START_TYPES\[provider\]/);
  assert.doesNotMatch(bg, /provider === CODEX_PROVIDER \? "codex_handoff_start" : "claude_handoff_start"/);
});

test("background v0.8.2:Copilot session 字段只发 { mode }(不带 session_id/thread_id,永不续发)", () => {
  assert.match(bg, /else if \(provider === COPILOT_PROVIDER\) sessionField = \{ mode: session_mode \}/);
  assert.match(bg, /provider === COPILOT_PROVIDER\) return \{ ok: false, code: "NO_CONTINUABLE_SESSION" \}/);
});

test("background v0.8.2:copilot candidate 携带 plan → startMsg.required_provider_runtime 锁定计划 runtime", () => {
  assert.match(bg, /startMsg\.required_provider_runtime = \(confirmedPlanRec && confirmedPlanRec\.provider_runtime\) \|\| null/);
});

test("background v0.8.2:completePlan 落库 provider_runtime(枚举把关在 validator)", () => {
  assert.match(bg, /provider_runtime: planReady\.provider_runtime \|\| null/);
});

test("background v0.8.2:completeCandidate 对 Copilot 不读/不存 session_id", () => {
  assert.match(bg, /const sessionId = isCopilot \? null :/);
});

test("background v0.8.2:provider probe 三 provider(含 github_copilot),全局失败各自 error", () => {
  assert.match(bg, /providers: \[PROVIDER, CODEX_PROVIDER, COPILOT_PROVIDER\]/);
  assert.match(bg, /\{ id: COPILOT_PROVIDER, status: "error" \}/);
});
