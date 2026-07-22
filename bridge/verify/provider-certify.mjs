#!/usr/bin/env node
// bridge/verify/provider-certify.mjs — v0.9.1 §5:L2 provider certification(fake runtime,无账号/无网络/无 Chrome)。
// 读 registry → 逐 provider 载入 fixture → probe/candidate/plan/安全矩阵 → §5.4 不变量 → 脱敏 report。
// 一个 provider 崩溃不中断其他 provider;任一失败退出码 1。
// 用法:node verify/provider-certify.mjs --all | --provider <id> [--report <path>]
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listProviderIds, getProviderDescriptor } from "../provider-registry.mjs";
import { providerHealthEntry, isValidRemediation } from "../bridge-health.mjs";
import {
  REQUIRED_PROBE_SCENARIOS, REQUIRED_CANDIDATE_SCENARIOS, REQUIRED_PLAN_SCENARIOS,
  makeIsolatedWorkspace, cleanupWorkspace, buildStandardMsg, makeCollector, scanInvariants, assertReportSanitized
} from "../test/providers/provider-fixture-contract.mjs";
import { sanitizeVerificationReport, makeReportSkeleton, finalizeReport } from "./report-sanitize.mjs";
import { fixture as claudeFixture } from "../test/providers/claude-code.fixture.mjs";
import { fixture as codexFixture } from "../test/providers/codex-app-server.fixture.mjs";
import { fixture as copilotFixture } from "../test/providers/github-copilot.fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = { claude_code_cli: claudeFixture, codex_app_server: codexFixture, github_copilot: copilotFixture };
// provider workspace 子目录名(与 task-bundle/codex-adapter/copilot-adapter 的 PROVIDER_DIR_NAME 一致 = descriptor.probe)
function providerDirName(descriptor) { return descriptor.probe; }
function bridgeVersion() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || "0.0.0"; }
  catch (_) { return "0.0.0"; }
}

// ———————————————————————— candidate 矩阵 ————————————————————————

async function runCandidateCheck(fixture, descriptor, name, add) {
  const ws = makeIsolatedWorkspace();
  const context = { sourcePath: ws.sourcePath };
  const checkId = "candidate." + name;
  try {
    const runId = "hgr_cert" + name.slice(0, 12).replace(/[^a-z0-9]/gi, "") + "01";
    const msg = buildStandardMsg({ sourcePath: ws.sourcePath, provider: descriptor.id, runId });
    if (name === "injection") {
      // §5.2 安全注入:评论含 shell 特殊字符不得改变行为或写出允许路径之外
      msg.task.annotations[0].comment = "改这里 $(rm -rf /) ; `id` \"q\" 'q' & | > evil";
    }
    const scenario = (name === "injection") ? "candidate_success" : name;
    const scen = fixture.makeRunScenario(scenario, context);
    const col = makeCollector();
    await scen.invokeCandidate({ msg, emit: col.emit });
    const events = col.events;
    const ready = events.find((e) => e.type === "candidate-ready");
    const failedEv = events.find((e) => e.type === "bridge_failed");
    const siblings = fs.readdirSync(ws.dir).filter((n) => /^reportV[\d.]+\.html$/.test(n));

    let failCode = null;
    if (name === "candidate_success" || name === "injection") {
      if (!ready) failCode = "NO_CANDIDATE_READY";
      else if (siblings.length !== 1) failCode = "SIBLING_COUNT_" + siblings.length;
      else if (ready.run_id !== msg.run_id) failCode = "RUN_ID_MISMATCH";
      else if (ready.logical_document_id !== "hgd_cert") failCode = "LOGICAL_ID_MISMATCH";
      else if (typeof ready.candidate_sha256 !== "string" || !ready.candidate_sha256.startsWith("sha256:")) failCode = "BAD_CANDIDATE_SHA";
    } else if (name === "candidate_missing") {
      if (ready || siblings.length) failCode = "UNEXPECTED_PUBLISH";
      else if (!failedEv) failCode = "NO_FAILURE_EVENT";
    } else if (name === "candidate_out_of_scope") {
      const okCodes = ["CANDIDATE_INVALID_HTML", "CANDIDATE_MISSING", "COPILOT_PERMISSION_DENIED"];
      if (ready || siblings.length) failCode = "UNEXPECTED_PUBLISH";
      else if (!failedEv) failCode = "NO_FAILURE_EVENT";
      else if (!okCodes.includes(failedEv.code)) failCode = "UNEXPECTED_CODE";
    } else if (name === "source_mutated") {
      if (ready || siblings.length) failCode = "UNEXPECTED_PUBLISH";
      else if (!failedEv || failedEv.code !== "SOURCE_MUTATED_DURING_CANDIDATE") failCode = "WRONG_FAILURE_CODE";
    }
    if (failCode) { add(checkId, "failed", failCode); return; }

    // §5.4 不变量
    const problems = scanInvariants({ ws, events, expectSourceMutated: name === "source_mutated", allowSessionKeys: fixture.expected.no_session_persisted !== true });
    if (problems.length) { add(checkId, "failed", problems[0]); return; }
    add(checkId, "passed");
  } catch (e) {
    add(checkId, "failed", "RUN_CRASH");
  } finally {
    try { fixture.cleanup(context); } catch (_) {}
    cleanupWorkspace(ws);
  }
}

// ———————————————————————— plan 矩阵 ————————————————————————

function plansDirFor(ws, descriptor, runId) {
  return path.join(ws.dir, ".htmlgenius-bridge", providerDirName(descriptor), "hgd_cert", "plans", runId);
}

async function runPlanCheck(fixture, descriptor, name, add) {
  const ws = makeIsolatedWorkspace();
  const context = { sourcePath: ws.sourcePath };
  const checkId = "plan." + name;
  try {
    const runId = "hgr_certplan" + (name === "plan_success" ? "ok01" : "bad01");
    const msg = buildStandardMsg({ sourcePath: ws.sourcePath, provider: descriptor.id, runId });
    const scen = fixture.makeRunScenario(name, context);
    const col = makeCollector();
    await scen.invokePlan({ msg, emit: col.emit });
    const events = col.events;
    const ready = events.find((e) => e.type === "plan-ready");
    const failedEv = events.find((e) => e.type === "bridge_failed");
    const siblings = fs.readdirSync(ws.dir).filter((n) => /^reportV[\d.]+\.html$/.test(n));

    let failCode = null;
    if (name === "plan_success") {
      if (!ready) failCode = "NO_PLAN_READY";
      else if (typeof ready.plan_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ready.plan_sha256)) failCode = "BAD_PLAN_SHA";
      else if (ready.provider !== descriptor.id) failCode = "PROVIDER_MISMATCH";
      else if (siblings.length) failCode = "PLAN_MUST_NOT_PUBLISH_SIBLING";
      else {
        const pd = plansDirFor(ws, descriptor, runId);
        if (fs.existsSync(path.join(pd, "candidate.html"))) failCode = "PLAN_RUN_WROTE_CANDIDATE";
        else if (!fs.existsSync(path.join(pd, "output", "plan.json"))) failCode = "PLAN_JSON_MISSING";
      }
    } else if (name === "plan_invalid") {
      if (ready) failCode = "UNEXPECTED_PLAN_READY";
      else if (siblings.length) failCode = "UNEXPECTED_PUBLISH";
      else if (!failedEv) failCode = "NO_FAILURE_EVENT";
    }
    if (failCode) { add(checkId, "failed", failCode); return; }
    const problems = scanInvariants({ ws, events, expectSourceMutated: false, allowSessionKeys: fixture.expected.no_session_persisted !== true });
    if (problems.length) { add(checkId, "failed", problems[0]); return; }
    add(checkId, "passed");
  } catch (e) {
    add(checkId, "failed", "RUN_CRASH");
  } finally {
    try { fixture.cleanup(context); } catch (_) {}
    cleanupWorkspace(ws);
  }
}

// runtime_locked:Plan→Candidate 锁定,不一致 → COPILOT_RUNTIME_CHANGED(§3.2 不得静默 fallback)
async function runRuntimeChangedCheck(fixture, add) {
  const ws = makeIsolatedWorkspace();
  const context = { sourcePath: ws.sourcePath };
  try {
    const msg = buildStandardMsg({ sourcePath: ws.sourcePath, provider: fixture.provider, runId: "hgr_certruntime01" });
    msg.required_provider_runtime = "bundled_sdk_cli";
    const scen = fixture.makeRunScenario("runtime_changed", context);
    const col = makeCollector();
    await scen.invokeCandidate({ msg, emit: col.emit });
    const ready = col.events.find((e) => e.type === "candidate-ready");
    const failedEv = col.events.find((e) => e.type === "bridge_failed");
    if (ready) { add("plan.runtime_changed", "failed", "UNEXPECTED_CANDIDATE"); return; }
    if (!failedEv || failedEv.code !== "COPILOT_RUNTIME_CHANGED") { add("plan.runtime_changed", "failed", "WRONG_FAILURE_CODE"); return; }
    const siblings = fs.readdirSync(ws.dir).filter((n) => /^reportV[\d.]+\.html$/.test(n));
    if (siblings.length) { add("plan.runtime_changed", "failed", "UNEXPECTED_PUBLISH"); return; }
    add("plan.runtime_changed", "passed");
  } catch (e) {
    add("plan.runtime_changed", "failed", "RUN_CRASH");
  } finally {
    try { fixture.cleanup(context); } catch (_) {}
    cleanupWorkspace(ws);
  }
}

// ———————————————————————— 单 provider 认证 ————————————————————————

async function certifyProvider(id) {
  const descriptor = getProviderDescriptor(id);
  const fixture = FIXTURES[id];
  const checks = [];
  const add = (cid, result, reason_code = null) => checks.push({ id: cid, result, reason_code });
  try {
    // §5.1 probe/health 矩阵
    for (const name of REQUIRED_PROBE_SCENARIOS) {
      try {
        const probe = await fixture.makeProbeScenario(name).invoke();
        const expected = fixture.probeExpectations[name] || [];
        if (!expected.includes(probe.status)) { add("probe." + name, "failed", "UNEXPECTED_STATUS"); continue; }
        const health = providerHealthEntry(probe);
        if (probe.status === "ready") {
          if (health.reason_code) { add("probe." + name, "failed", "READY_HAS_REASON_CODE"); continue; }
        } else {
          if (!health.reason_code) { add("probe." + name, "failed", "MISSING_REASON_CODE"); continue; }
          if (!isValidRemediation(health.remediation)) { add("probe." + name, "failed", "BAD_REMEDIATION"); continue; }
        }
        const leaks = [...assertReportSanitized(probe), ...assertReportSanitized(health)];
        if (leaks.length) { add("probe." + name, "failed", leaks[0]); continue; }
        add("probe." + name, "passed");
      } catch (e) {
        add("probe." + name, "failed", "PROBE_CRASH");
      }
    }
    // §5.2 candidate 矩阵
    if (descriptor.capabilities.includes("candidate")) {
      for (const name of [...REQUIRED_CANDIDATE_SCENARIOS, "injection"]) {
        await runCandidateCheck(fixture, descriptor, name, add);
      }
    }
    // §5.3 plan 矩阵
    if (descriptor.capabilities.includes("plan")) {
      for (const name of REQUIRED_PLAN_SCENARIOS) await runPlanCheck(fixture, descriptor, name, add);
      if (descriptor.runtime_policy === "runtime_locked") await runRuntimeChangedCheck(fixture, add);
      else add("plan.runtime_changed", "skipped", "NOT_RUNTIME_LOCKED");
    }
  } catch (e) {
    add("provider.crash", "failed", "PROVIDER_CRASH");
  }
  return {
    id,
    result: checks.some((c) => c.result === "failed") ? "failed" : "passed",
    capabilities: descriptor.capabilities.slice(),
    checks
  };
}

// ———————————————————————— main ————————————————————————

export async function main(argv) {
  const args = argv || process.argv.slice(2);
  const all = args.includes("--all");
  const pIdx = args.indexOf("--provider");
  let ids;
  if (pIdx > -1) {
    const id = args[pIdx + 1];
    if (!getProviderDescriptor(id)) { process.stderr.write("unknown provider: " + id + "\n"); return 64; }
    ids = [id];
  } else if (all) {
    ids = listProviderIds();
  } else {
    process.stderr.write("usage: provider-certify.mjs --all | --provider <id> [--report <path>]\n");
    return 64;
  }

  const report = makeReportSkeleton({ kind: "provider_certification", bridgeVersion: bridgeVersion(), startedAt: new Date().toISOString() });
  for (const id of ids) {
    report.providers.push(await certifyProvider(id)); // 逐 provider 隔离 certifyProvider 内部已兜底
  }
  finalizeReport(report);
  const clean = sanitizeVerificationReport(report);

  const rIdx = args.indexOf("--report");
  const outPath = rIdx > -1 ? args[rIdx + 1] : path.resolve(__dirname, "..", "artifacts", "verification", "provider-certification.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(clean, null, 2) + "\n");

  process.stdout.write("provider certification: " + clean.result + " — " + clean.summary.passed + " passed / " + clean.summary.failed + " failed / " + clean.summary.skipped + " skipped\n");
  for (const p of clean.providers) {
    process.stdout.write("  " + p.id + ": " + p.result + "\n");
    for (const c of p.checks) {
      process.stdout.write("    [" + c.result + "] " + c.id + (c.reason_code ? " (" + c.reason_code + ")" : "") + "\n");
    }
  }
  process.stdout.write("report written (sanitized)\n");
  return clean.result === "passed" ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("provider-certify.mjs")) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write("certify crashed: " + (e && e.message) + "\n"); process.exit(3); });
}
