// bridge/test/providers/claude-code.fixture.mjs — v0.9.1 §4:Claude Code fake runtime fixture。
// 包装 host-runner 的 { claude } 注入点(checkAuth/runHandoff/resumeHandoff)与 probeClaude 的注入点;
// 不 spawn 真实 claude、不触网络、不读 $HOME。
import fs from "node:fs";
import path from "node:path";
import { executeCandidateRun, executePlanRun } from "../../host-runner.mjs";
import { probeClaude } from "../../provider-probe.mjs";
import { VALID_HTML, goodPlan, fakeSessionUuid } from "./provider-fixture-contract.mjs";

const NOT_LOGGED_IN = () => Object.assign(new Error("not logged in"), { code: "CLAUDE_NOT_LOGGED_IN" });
const NOT_INSTALLED = () => Object.assign(new Error("not installed"), { code: "CLAUDE_NOT_INSTALLED" });

function cliFor(scenario, context) {
  const authed = { checkAuth: async () => {} };
  const writeCandidate = (cwd) => fs.writeFileSync(path.join(cwd, "candidate.html"), VALID_HTML.replace("hello world", "goodbye world"));
  const writePlan = (cwd) => {
    fs.mkdirSync(path.join(cwd, "output"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "output", "plan.json"), JSON.stringify(goodPlan()));
  };
  switch (scenario) {
    case "candidate_success":
      return { ...authed, runHandoff: async ({ cwd }) => { writeCandidate(cwd); return { sessionId: fakeSessionUuid() }; }, resumeHandoff: async () => { throw new Error("fixture: resume not used"); } };
    case "candidate_missing":
      return { ...authed, runHandoff: async () => ({ sessionId: fakeSessionUuid() }), resumeHandoff: async () => ({ sessionId: fakeSessionUuid() }) };
    case "candidate_out_of_scope":
      // 越权:写非 HTML 到 candidate.html + 另写杂物文件 → 校验拒绝,且不发布 sibling
      return { ...authed, runHandoff: async ({ cwd }) => {
        fs.writeFileSync(path.join(cwd, "candidate.html"), "# not html at all");
        fs.writeFileSync(path.join(cwd, "stray.txt"), "stray");
        return { sessionId: fakeSessionUuid() };
      }, resumeHandoff: async () => ({ sessionId: fakeSessionUuid() }) };
    case "source_mutated":
      return { ...authed, runHandoff: async ({ cwd }) => { writeCandidate(cwd); fs.appendFileSync(context.sourcePath, "<!--mutated-->"); return { sessionId: fakeSessionUuid() }; }, resumeHandoff: async () => ({ sessionId: fakeSessionUuid() }) };
    case "plan_success":
      return { ...authed, runHandoff: async ({ cwd, runKind }) => { if (runKind === "plan") writePlan(cwd); else writeCandidate(cwd); return { sessionId: fakeSessionUuid() }; }, resumeHandoff: async () => ({ sessionId: fakeSessionUuid() }) };
    case "plan_invalid":
      return { ...authed, runHandoff: async ({ cwd }) => { fs.mkdirSync(path.join(cwd, "output"), { recursive: true }); fs.writeFileSync(path.join(cwd, "output", "plan.json"), "{ not json"); return { sessionId: fakeSessionUuid() }; }, resumeHandoff: async () => ({ sessionId: fakeSessionUuid() }) };
    case "auth_required":
      return { checkAuth: async () => { throw NOT_LOGGED_IN(); }, runHandoff: async () => { throw NOT_LOGGED_IN(); }, resumeHandoff: async () => { throw NOT_LOGGED_IN(); } };
    case "runtime_changed": // claude 非 runtime_locked;harness 不会调用,形状上提供拒绝实现
      return { checkAuth: async () => { throw new Error("not applicable"); }, runHandoff: async () => { throw new Error("not applicable"); }, resumeHandoff: async () => { throw new Error("not applicable"); } };
    default:
      throw new Error("claude fixture: unknown run scenario " + scenario);
  }
}

export const fixture = {
  provider: "claude_code_cli",
  capabilities: ["candidate", "plan"],
  scenarios: [
    "ready", "not_installed", "auth_required", "incompatible", "probe_error",
    "candidate_success", "candidate_missing", "candidate_out_of_scope", "source_mutated",
    "plan_success", "plan_invalid"
  ],
  // probe 期望状态(允许集合;provider 语义差异在 harness 记录)
  probeExpectations: {
    ready: ["ready"], not_installed: ["not_installed"], auth_required: ["auth_required"],
    incompatible: ["not_installed", "error"], probe_error: ["error"]
  },
  makeProbeScenario(name) {
    switch (name) {
      case "ready": return { invoke: () => probeClaude({ claudeVersion: () => "1.0.0-fake", claudeAuthCheck: async () => {} }) };
      case "not_installed": return { invoke: () => probeClaude({ claudeVersion: () => null, claudeAuthCheck: async () => {} }) };
      case "auth_required": return { invoke: () => probeClaude({ claudeVersion: () => "1.0.0-fake", claudeAuthCheck: async () => { throw NOT_LOGGED_IN(); } }) };
      case "incompatible": return { invoke: () => probeClaude({ claudeVersion: () => "1.0.0-fake", claudeAuthCheck: async () => { throw NOT_INSTALLED(); } }) };
      case "probe_error": return { invoke: () => probeClaude({ claudeVersion: () => "1.0.0-fake", claudeAuthCheck: async () => { throw new Error("boom"); } }) };
      default: throw new Error("claude fixture: unknown probe scenario " + name);
    }
  },
  makeRunScenario(name, context) {
    const cli = cliFor(name, context);
    return {
      invokeCandidate: ({ msg, emit }) => executeCandidateRun(msg, { emit, claude: cli }),
      invokePlan: ({ msg, emit }) => executePlanRun(msg, { emit, claude: cli })
    };
  },
  cleanup() {},
  expected: { no_session_persisted: false, candidate_filename: "candidate.html", plan_filename: "output/plan.json" }
  // 注:Claude 的 bridge_sessions 由 background 在 completion 后写(host 只回 session_id);
  // host 事件层断言「candidate-ready/plan-ready 不携带 prompt/stdout」,session 持久化边界在 background 测试覆盖。
};
