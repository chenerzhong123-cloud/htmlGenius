// bridge/test/providers/provider-fixture-contract.mjs — v0.9.1 §4:fake runtime fixture 的通用契约与共享辅助。
// fixture 是给 certification harness 的标准包装层(复用现有 fake,不重写协议模拟)。
// 硬语义:fixture 不得调用真实 executable/App Server/SDK 网络/读 $HOME;能精确制造 probe 状态与 run 结果;
//         失败场景必须失败且不产生可发布 sibling artifact。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// 所有 provider fixture 必须提供的场景(§4.1)。runtime_locked 的 provider 还必须有 runtime_changed。
export const REQUIRED_PROBE_SCENARIOS = Object.freeze(["ready", "not_installed", "auth_required", "incompatible", "probe_error"]);
export const REQUIRED_CANDIDATE_SCENARIOS = Object.freeze(["candidate_success", "candidate_missing", "candidate_out_of_scope", "source_mutated"]);
export const REQUIRED_PLAN_SCENARIOS = Object.freeze(["plan_success", "plan_invalid"]);

export const VALID_HTML = "<!doctype html><html><head><title>t</title></head><body><p>hello world</p></body></html>";
export function goodPlan() {
  return { schema_version: 1, kind: "htmlgenius_change_plan", summary: "目标摘要", plan_markdown: "1. 改 a\n2. 改 b", out_of_scope: [] };
}
export function sha256Tagged(buf) { return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex"); }
export function fakeSessionUuid() { return crypto.randomUUID(); }

// 每次 certification 一个隔离 tmp 工作区(不碰真实 HOME/项目目录)。
export function makeIsolatedWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cert-"));
  const sourcePath = path.join(dir, "report.html");
  fs.writeFileSync(sourcePath, VALID_HTML);
  return { dir, sourcePath, sourceBytes: fs.readFileSync(sourcePath) };
}
export function cleanupWorkspace(ws) {
  try { fs.rmSync(ws.dir, { recursive: true, force: true }); } catch (_) {}
}

// 标准 handoff msg(§5.2/§5.3 矩阵共用;session 永远 new)。
export function buildStandardMsg({ sourcePath, provider, runId, mode = "precise_patch" }) {
  const task = {
    schema_version: 1, kind: "htmlgenius_change_contract", mode,
    artifact: { title: "cert", url: "file://" + sourcePath, is_local: true },
    source: { root_annotation_ids: ["r1"], root_annotation_count: 1 },
    annotations: [{ id: "r1", quote: "hello", comment: "改成 goodbye", selector: { exact: "hello" }, replies: [] }],
    brief: "", preserve: [], contract: { write_scope: "target_only", locked_outside_scope: true, on_ambiguous_target: "ask_or_stop", verification: ["v"] }
  };
  return {
    run_id: runId, provider,
    source: { logical_document_id: "hgd_cert", artifact_uri: "file://" + sourcePath, base_artifact_hash: sha256Tagged(fs.readFileSync(sourcePath)) },
    session: { mode: "new" },
    task
  };
}

// 收集 executor emit 的事件流。
export function makeCollector() {
  const events = [];
  return { events, emit: (e) => { if (e) events.push(e); } };
}

// §5.4 不变量扫描:source 未被 adapter 改写(字节级);runs/plans 之外无新 HTML;事件不含敏感键。
// allowSessionKeys:Claude/Codex 的 host→background 协议合法携带 session_id/thread_id(续发旧路径依赖,
// v0.8 既有行为不可破坏);Copilot(no_session_persisted)绝不允许 —— 由调用方按 fixture.expected 决定。
export function scanInvariants({ ws, events, expectSourceMutated = false, allowSessionKeys = false }) {
  const problems = [];
  const nowBytes = fs.readFileSync(ws.sourcePath);
  if (!expectSourceMutated && !nowBytes.equals(ws.sourceBytes)) {
    problems.push("SOURCE_REWRITTEN");
  }
  // 源文件目录旁除了 .htmlgenius-bridge 与受控 sibling(reportV*.html)外不得出现新文件
  for (const name of fs.readdirSync(ws.dir)) {
    if (name === "report.html" || name === ".htmlgenius-bridge") continue;
    if (/^reportV\d+(\.\d+)*\.html$/.test(name)) continue;
    problems.push("UNEXPECTED_FILE:" + name.replace(/[^\w.-]/g, ""));
  }
  assertEventsSanitized(events, problems, { allowSessionKeys });
  return problems;
}

const SENSITIVE_EVENT_KEYS = ["path", "command", "argv", "stderr", "stdout", "token", "cookie", "prompt", "comment", "stack", "env"];
const SESSION_KEYS = ["session_id", "thread_id"];
export function assertEventsSanitized(events, problems, { allowSessionKeys = false } = {}) {
  const json = JSON.stringify(events || []);
  const keys = allowSessionKeys ? SENSITIVE_EVENT_KEYS : [...SENSITIVE_EVENT_KEYS, ...SESSION_KEYS];
  for (const k of keys) {
    if (json.includes('"' + k + '"')) problems.push("EVENT_LEAKS_KEY:" + k);
  }
}

// 通用 report/对象脱敏断言(§7):不得含敏感键或临时路径。
export function assertReportSanitized(obj, tmpPaths = []) {
  const problems = [];
  const json = JSON.stringify(obj);
  for (const k of [...SENSITIVE_EVENT_KEYS, "html", "username", "hostname"]) {
    if (json.includes('"' + k + '"')) problems.push("REPORT_LEAKS_KEY:" + k);
  }
  for (const p of tmpPaths) {
    if (p && json.includes(p)) problems.push("REPORT_LEAKS_PATH");
  }
  return problems;
}

// fixture 形状校验(§4.2 硬门;contract test 与 harness 启动时各跑一次)。
export function assertFixtureShape(fixture, descriptor) {
  const err = (m) => { throw new Error("fixture[" + (fixture && fixture.provider) + "]: " + m); };
  if (!fixture || typeof fixture !== "object") err("not an object");
  if (fixture.provider !== descriptor.id) err("provider 与 registry ID 不一致");
  const caps = (fixture.capabilities || []).slice().sort();
  const regCaps = descriptor.capabilities.slice().sort();
  if (JSON.stringify(caps) !== JSON.stringify(regCaps)) err("capabilities 与 registry 不一致");
  const scenarios = new Set(fixture.scenarios || []);
  for (const s of REQUIRED_PROBE_SCENARIOS) if (!scenarios.has(s)) err("缺 probe 场景 " + s);
  if (caps.includes("candidate")) for (const s of REQUIRED_CANDIDATE_SCENARIOS) if (!scenarios.has(s)) err("缺 candidate 场景 " + s);
  if (caps.includes("plan")) for (const s of REQUIRED_PLAN_SCENARIOS) if (!scenarios.has(s)) err("缺 plan 场景 " + s);
  if (!caps.includes("plan") && scenarios.has("plan_success")) err("未声明 plan 却提供 plan_success");
  if (descriptor.runtime_policy === "runtime_locked" && !scenarios.has("runtime_changed")) err("runtime_locked provider 必须有 runtime_changed");
  if (typeof fixture.makeProbeScenario !== "function") err("缺 makeProbeScenario");
  if (typeof fixture.makeRunScenario !== "function") err("缺 makeRunScenario");
  if (!fixture.expected || fixture.expected.candidate_filename !== "candidate.html") err("expected.candidate_filename 必须是 candidate.html");
  if (!fixture.expected || fixture.expected.plan_filename !== "output/plan.json") err("expected.plan_filename 必须是 output/plan.json");
  return true;
}
