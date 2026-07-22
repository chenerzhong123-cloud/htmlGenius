// bridge/test/providers/codex-app-server.fixture.mjs — v0.9.1 §4:Codex App Server fake runtime fixture。
// 包装 codex-adapter 的 { client, runtime, schemaDir } 注入点与 probeCodex 的注入点;
// 不启动真实 Codex App、不触网络、不读 $HOME。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeCodexCandidateRun, executeCodexPlanRun } from "../../codex-adapter.mjs";
import { probeCodex } from "../../provider-probe.mjs";
import {
  CODEX_APP_NOT_FOUND, CODEX_AUTH_REQUIRED
} from "../../codex-app-server-client.mjs";
import { VALID_HTML, goodPlan } from "./provider-fixture-contract.mjs";

// verifySchema 要求的最小合法 schema(与 codex-adapter.test 同形)。
function makeSchemaDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cert-sch-"));
  fs.writeFileSync(path.join(d, "ClientRequest.json"), JSON.stringify({
    initialize: {}, "thread/start": {}, "thread/resume": {},
    "turn/start": { sandboxPolicy: { type: "workspaceWrite" }, approvalPolicy: "never", cwd: "x" }
  }));
  return d;
}

function clientFor(scenario, context) {
  const writeCandidate = (cwd) => fs.writeFileSync(path.join(cwd, "candidate.html"), VALID_HTML.replace("hello world", "codex edit"));
  const writePlan = (cwd) => {
    fs.mkdirSync(path.join(cwd, "output"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "output", "plan.json"), JSON.stringify(goodPlan()));
  };
  const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
  switch (scenario) {
    case "candidate_success":
      return { runCandidate: async ({ workspaceCwd }) => { writeCandidate(workspaceCwd); return { threadId: "thr_fake_cert" }; }, close: async () => {} };
    case "candidate_missing":
      return { runCandidate: async () => ({ threadId: "thr_fake_cert" }), close: async () => {} };
    case "candidate_out_of_scope":
      return { runCandidate: async ({ workspaceCwd }) => {
        fs.writeFileSync(path.join(workspaceCwd, "candidate.html"), "# not html");
        fs.writeFileSync(path.join(workspaceCwd, "stray.txt"), "stray");
        return { threadId: "thr_fake_cert" };
      }, close: async () => {} };
    case "source_mutated":
      return { runCandidate: async ({ workspaceCwd }) => { writeCandidate(workspaceCwd); fs.appendFileSync(context.sourcePath, "<!--mut-->"); return { threadId: "thr_fake_cert" }; }, close: async () => {} };
    case "plan_success":
      return { runPlan: async ({ workspaceCwd }) => { writePlan(workspaceCwd); return { threadId: "thr_fake_cert" }; }, close: async () => {} };
    case "plan_invalid":
      return { runPlan: async ({ workspaceCwd }) => { fs.mkdirSync(path.join(workspaceCwd, "output"), { recursive: true }); fs.writeFileSync(path.join(workspaceCwd, "output", "plan.json"), "{ bad"); return { threadId: "thr_fake_cert" }; }, close: async () => {} };
    case "auth_required":
      return { runCandidate: async () => fail(CODEX_AUTH_REQUIRED, "codex auth required"), runPlan: async () => fail(CODEX_AUTH_REQUIRED, "codex auth required"), close: async () => {} };
    case "runtime_changed":
      return { runCandidate: async () => fail("CODEX_TURN_FAILED", "not applicable"), close: async () => {} };
    default:
      throw new Error("codex fixture: unknown run scenario " + scenario);
  }
}

export const fixture = {
  provider: "codex_app_server",
  capabilities: ["candidate", "plan"],
  scenarios: [
    "ready", "not_installed", "auth_required", "incompatible", "probe_error",
    "candidate_success", "candidate_missing", "candidate_out_of_scope", "source_mutated",
    "plan_success", "plan_invalid"
  ],
  probeExpectations: {
    ready: ["ready"], not_installed: ["not_found", "not_installed"], auth_required: ["auth_required"],
    incompatible: ["incompatible"], probe_error: ["error"]
  },
  makeProbeScenario(name) {
    const discover = () => ({ runtimePath: "/fake/codex-runtime", version: "1.0.0-fake" });
    const schemaOk = async (rt, sd) => {
      fs.writeFileSync(path.join(sd, "ClientRequest.json"), JSON.stringify({
        initialize: {}, "thread/start": {}, "thread/resume": {},
        "turn/start": { sandboxPolicy: { type: "workspaceWrite" }, approvalPolicy: "never", cwd: "x" }
      }));
    };
    const handshakeOk = async () => {};
    switch (name) {
      case "ready": return { invoke: () => probeCodex({ codexDiscover: discover, generateSchema: schemaOk, codexHandshake: handshakeOk }) };
      case "not_installed": return { invoke: () => probeCodex({ codexDiscover: () => { const e = new Error("app not found"); e.code = CODEX_APP_NOT_FOUND; throw e; } }) };
      case "auth_required": return { invoke: () => probeCodex({ codexDiscover: discover, generateSchema: schemaOk, codexHandshake: async () => { const e = new Error("auth"); e.code = CODEX_AUTH_REQUIRED; throw e; } }) };
      case "incompatible": return { invoke: () => probeCodex({ codexDiscover: discover, generateSchema: async () => { throw new Error("schema gen failed"); } }) };
      case "probe_error": return { invoke: () => probeCodex({ codexDiscover: () => { throw new Error("boom"); } }) };
      default: throw new Error("codex fixture: unknown probe scenario " + name);
    }
  },
  makeRunScenario(name, context) {
    const client = clientFor(name, context);
    const schemaDir = context.schemaDir || (context.schemaDir = makeSchemaDir());
    const opts = { client, runtime: { runtimePath: "/fake/codex-runtime" }, schemaDir };
    return {
      invokeCandidate: ({ msg, emit }) => executeCodexCandidateRun(msg, { emit, ...opts }),
      invokePlan: ({ msg, emit }) => executeCodexPlanRun(msg, { emit, ...opts })
    };
  },
  cleanup(context) {
    if (context && context.schemaDir) { try { fs.rmSync(context.schemaDir, { recursive: true, force: true }); } catch (_) {} }
  },
  expected: { no_session_persisted: false, candidate_filename: "candidate.html", plan_filename: "output/plan.json" }
};
