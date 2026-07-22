// bridge/test/providers/github-copilot.fixture.mjs — v0.9.1 §4:GitHub Copilot fake runtime fixture。
// 包装 copilot-adapter 的 { selectRuntime } 注入点与 probeCopilot 的 { sdkLoader, execFileImpl, env, fsImpl } 注入点;
// 复用 fake-copilot-sdk;不启动真实 SDK runtime、不触网络、不读 $HOME。
import fs from "node:fs";
import path from "node:path";
import { executeCopilotCandidateRun, executeCopilotPlanRun } from "../../copilot-adapter.mjs";
import { probeCopilot } from "../../copilot-runtime.mjs";
import { COPILOT_RUNTIMES, COPILOT_ERRORS } from "../../copilot-runtime.mjs";
import { makeFakeSdk, makeMissingSdkLoader } from "../fake-copilot-sdk.mjs";
import { VALID_HTML, goodPlan } from "./provider-fixture-contract.mjs";

// 无本地 CLI 的 probe 环境(env PATH 空 + fsImpl 一律 ENOENT)
const NO_CLI_FS = {
  lstatSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  accessSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  constants: fs.constants
};
const NO_CLI_ENV = { PATH: "", HOME: "/nonexistent-home" };
// 「存在本地 CLI」的假 fs 视图(/fakebin/copilot 为合法普通可执行文件)
const FAKE_CLI_DIR = "/fakebin";
const fakeCliFs = {
  lstatSync: (p) => {
    if (p === path.join(FAKE_CLI_DIR, "copilot")) return { isSymbolicLink: () => false, isFile: () => true };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  accessSync: (p, m) => { if (p === path.join(FAKE_CLI_DIR, "copilot")) return undefined; throw new Error("ENOENT"); },
  constants: fs.constants
};
const fakeCliExec = (f, args, opts, cb) => cb(null, "copilot version 9.9.9-fake\n", "");

function sdkFor(scenario, context) {
  const writeCandidate = (cwd) => fs.writeFileSync(path.join(cwd, "candidate.html"), VALID_HTML.replace("hello world", "copilot edit"));
  const writePlan = (cwd) => {
    fs.mkdirSync(path.join(cwd, "output"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "output", "plan.json"), JSON.stringify(goodPlan()));
  };
  switch (scenario) {
    case "candidate_success":
      return makeFakeSdk({ session: { writer: ({ cwd }) => writeCandidate(cwd) } });
    case "candidate_missing":
      return makeFakeSdk({ session: { writer: () => {} } });
    case "candidate_out_of_scope": {
      // 尝试越权(bash + 越界写)被 pre-tool hook 拒;且未产出合法 candidate
      return makeFakeSdk({
        session: {
          writer: ({ cwd, config }) => {
            config.hooks.onPreToolUse({ toolName: "bash", toolArgs: { command: "echo x" } });
            config.hooks.onPreToolUse({ toolName: "write", toolArgs: { path: "../evil.html", content: "x" } });
            fs.writeFileSync(path.join(cwd, "stray.txt"), "stray");
          }
        }
      });
    }
    case "source_mutated":
      return makeFakeSdk({ session: { writer: ({ cwd }) => { writeCandidate(cwd); fs.appendFileSync(context.sourcePath, "<!--mut-->"); } } });
    case "plan_success":
      return makeFakeSdk({ session: { writer: ({ cwd }) => writePlan(cwd) } });
    case "plan_invalid":
      return makeFakeSdk({ session: { writer: ({ cwd }) => { fs.mkdirSync(path.join(cwd, "output"), { recursive: true }); fs.writeFileSync(path.join(cwd, "output", "plan.json"), "{ bad"); } } });
    case "auth_required":
      return makeFakeSdk({ bundled: { auth: { isAuthenticated: false } } });
    default:
      throw new Error("copilot fixture: unknown run scenario " + scenario);
  }
}

export const fixture = {
  provider: "github_copilot",
  capabilities: ["candidate", "plan"],
  scenarios: [
    "ready", "not_installed", "auth_required", "incompatible", "probe_error",
    "candidate_success", "candidate_missing", "candidate_out_of_scope", "source_mutated",
    "plan_success", "plan_invalid", "runtime_changed"
  ],
  probeExpectations: {
    ready: ["ready"], not_installed: ["not_installed"], auth_required: ["auth_required"],
    incompatible: ["incompatible"], probe_error: ["error"]
  },
  makeProbeScenario(name) {
    switch (name) {
      case "ready":
        return { invoke: () => probeCopilot({ sdkLoader: async () => makeFakeSdk({ bundled: { auth: { isAuthenticated: true }, status: { version: "1.0.7-fake", protocolVersion: 1 } } }), env: NO_CLI_ENV, fsImpl: NO_CLI_FS }) };
      case "not_installed":
        return { invoke: () => probeCopilot({ sdkLoader: makeMissingSdkLoader(), env: NO_CLI_ENV, fsImpl: NO_CLI_FS }) };
      case "auth_required":
        return { invoke: () => probeCopilot({ sdkLoader: async () => makeFakeSdk({ bundled: { auth: { isAuthenticated: false } } }), env: NO_CLI_ENV, fsImpl: NO_CLI_FS }) };
      case "incompatible":
        // 本地 CLI 存在但 SDK 起不来 + bundled 也起不来 → incompatible
        return { invoke: () => probeCopilot({
          sdkLoader: async () => makeFakeSdk({ local: { startError: new Error("protocol mismatch") }, bundled: { startError: new Error("runtime missing") } }),
          execFileImpl: fakeCliExec, env: { PATH: FAKE_CLI_DIR, HOME: "/nonexistent-home" }, fsImpl: fakeCliFs
        }) };
      case "probe_error":
        return { invoke: () => probeCopilot({ sdkLoader: async () => { throw new Error("boom"); }, env: NO_CLI_ENV, fsImpl: NO_CLI_FS }) };
      default: throw new Error("copilot fixture: unknown probe scenario " + name);
    }
  },
  makeRunScenario(name, context) {
    if (name === "runtime_changed") {
      // Plan→Candidate 锁定失败:选择器抛 COPILOT_RUNTIME_CHANGED(§3.2 不得静默切换)
      const selector = async (args) => {
        if (args && args.requiredRuntime) {
          const e = new Error("runtime gone"); e.code = COPILOT_ERRORS.RUNTIME_CHANGED; throw e;
        }
        return { sdk: sdkFor("candidate_success", context), runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, version: "1.0.7-fake" };
      };
      return {
        invokeCandidate: ({ msg, emit }) => executeCopilotCandidateRun(msg, { emit, selectRuntime: selector }),
        invokePlan: ({ msg, emit }) => executeCopilotPlanRun(msg, { emit, selectRuntime: selector })
      };
    }
    const sdk = sdkFor(name, context);
    const selector = async () => ({ sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, version: "1.0.7-fake" });
    return {
      invokeCandidate: ({ msg, emit }) => executeCopilotCandidateRun(msg, { emit, selectRuntime: selector }),
      invokePlan: ({ msg, emit }) => executeCopilotPlanRun(msg, { emit, selectRuntime: selector })
    };
  },
  cleanup() {},
  expected: { no_session_persisted: true, candidate_filename: "candidate.html", plan_filename: "output/plan.json" }
};
