#!/usr/bin/env node
// bridge/verify/real-smoke.mjs — v0.9.1 §8:L3 Real Smoke(默认拒绝,显式 opt-in)。
// fake certification 证明协议未被破坏;真实 smoke 证明真实 Agent 版本/认证/权益仍可用。
//
// 运行门(缺一即退出非 0,且不连接任何 provider):
//   HTMLGENIUS_ALLOW_REAL_SMOKE=1
//   HTMLGENIUS_SMOKE_WORKSPACE=<绝对路径,新建空目录;拒绝项目根/HOME/Desktop/Documents/repo 内路径>
// 用法:
//   node verify/real-smoke.mjs                       # Bridge/provider smoke(所有 registry provider,未就绪 → blocked)
//   node verify/real-smoke.mjs --provider <id>       # 仅某 provider(registry ID)
//
// 诚实标注:成功不自动提升 provider 为正式支持;失败报 blocked/failed + 稳定 reason code;
// provider 原始 stderr 绝不进 report(只写临时调试文件且默认删除)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listProviderIds, getProviderDescriptor } from "../provider-registry.mjs";
import { probeProviders } from "../provider-probe.mjs";
import { executeCandidateRun } from "../host-runner.mjs";
import { executeCodexCandidateRun } from "../codex-adapter.mjs";
import { executeCopilotCandidateRun } from "../copilot-adapter.mjs";
import { buildStandardMsg, makeCollector, sha256Tagged, VALID_HTML } from "../test/providers/provider-fixture-contract.mjs";
import { sanitizeVerificationReport, makeReportSkeleton, finalizeReport } from "./report-sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function bridgeVersion() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || "0.0.0"; }
  catch (_) { return "0.0.0"; }
}

// §8.2:双环境门 + workspace 隔离校验。任一不满足 → { ok:false, code }。
export function checkGate(env = process.env) {
  if (env.HTMLGENIUS_ALLOW_REAL_SMOKE !== "1") {
    return { ok: false, code: "SMOKE_NOT_ALLOWED", message: "refusing to run: set HTMLGENIUS_ALLOW_REAL_SMOKE=1 to opt in explicitly" };
  }
  const ws = env.HTMLGENIUS_SMOKE_WORKSPACE;
  if (!ws || !path.isAbsolute(ws)) {
    return { ok: false, code: "SMOKE_WORKSPACE_INVALID", message: "HTMLGENIUS_SMOKE_WORKSPACE must be an absolute path" };
  }
  const resolved = path.resolve(ws);
  const home = os.homedir();
  const prohibited = [REPO_ROOT, process.cwd(), home, path.join(home, "Desktop"), path.join(home, "Documents")];
  for (const p of prohibited) {
    if (!p) continue;
    if (resolved === path.resolve(p) || resolved.startsWith(path.resolve(p) + path.sep)) {
      return { ok: false, code: "SMOKE_WORKSPACE_FORBIDDEN", message: "workspace must not be inside project root / HOME / Desktop / Documents" };
    }
  }
  // 新建目录:不存在则建;存在则必须为空
  try {
    if (fs.existsSync(resolved)) {
      if (fs.readdirSync(resolved).length > 0) return { ok: false, code: "SMOKE_WORKSPACE_NOT_EMPTY", message: "workspace exists and is not empty; use a fresh directory" };
    } else {
      fs.mkdirSync(resolved, { recursive: true });
    }
  } catch (e) {
    return { ok: false, code: "SMOKE_WORKSPACE_INVALID", message: "cannot create workspace directory" };
  }
  return { ok: true, workspace: resolved };
}

// §8.3(2):Chrome Native Messaging smoke 的 runner 骨架 + 明确人工门。
// 不声称无人值守 E2E —— 输出结构化步骤,真实点击确认由人在专用测试用户完成。
export function chromeNativeSmokePlan() {
  return {
    status: "manual_gate",
    note: "Chrome Native Host 发现依赖真实浏览器 profile 与系统权限,不可在通用 CI 可靠伪造;以下为人工步骤。",
    steps: [
      "使用专用 macOS 测试用户(非日常账户),安装 Chrome 并加载固定扩展 ID 的 unpacked extension/",
      "以 htmlgenius-bridge CLI 执行 setup --scope user --extension-id <测试ID>(受管安装)",
      "打开本地单文件 HTML,触发 Side Panel 契约页,确认 Connection Center 显示「已连接」或逐项状态",
      "人工确认:发送 candidate → 候选生成、原文件未动;host stderr 无异常",
      "完成后 uninstall --scope user 清理测试用户注册"
    ],
    unattended_e2e_claimed: false
  };
}

function executorFor(id) {
  if (id === "claude_code_cli") return (msg, emit) => executeCandidateRun(msg, { emit });
  if (id === "codex_app_server") return (msg, emit) => executeCodexCandidateRun(msg, { emit });
  if (id === "github_copilot") return (msg, emit) => executeCopilotCandidateRun(msg, { emit });
  return null;
}

// 单 provider 真实 candidate 闭环。provider 未就绪 → blocked(不算 failed)。
async function smokeProvider(id, workspace, probeById) {
  const checks = [];
  const add = (cid, result, reason_code = null) => checks.push({ id: cid, result, reason_code });
  const probe = probeById[id];
  if (!probe || probe.status !== "ready") {
    add("smoke.candidate", "blocked", (probe && probe.reason_code) || "PROVIDER_NOT_READY");
    return checks;
  }
  // 固定无敏感 fixture
  const sourcePath = path.join(workspace, "smoke-" + id + ".html");
  fs.writeFileSync(sourcePath, VALID_HTML);
  const before = fs.readFileSync(sourcePath);
  const msg = buildStandardMsg({ sourcePath, provider: id, runId: "hgr_smoke" + id.replace(/[^a-z0-9]/gi, "").slice(0, 8) + "01" });
  const col = makeCollector();
  try {
    await executorFor(id)(msg, col.emit);
  } catch (e) {
    // 异常细节不进 report(§7.2);只记稳定码
    add("smoke.candidate", "failed", "RUN_EXCEPTION");
    cleanupFixture(workspace, id);
    return checks;
  }
  const ready = col.events.find((e) => e.type === "candidate-ready");
  const failedEv = col.events.find((e) => e.type === "bridge_failed");
  const after = fs.readFileSync(sourcePath);
  if (!ready) {
    add("smoke.candidate", "failed", (failedEv && failedEv.code) || "NO_CANDIDATE_READY");
  } else {
    if (!after.equals(before)) add("smoke.source_unchanged", "failed", "SOURCE_REWRITTEN");
    else add("smoke.source_unchanged", "passed");
    const siblings = fs.readdirSync(workspace).filter((n) => n.startsWith("smoke-" + id + "V") && n.endsWith(".html"));
    if (siblings.length !== 1) add("smoke.sibling_published", "failed", "SIBLING_COUNT_" + siblings.length);
    else add("smoke.sibling_published", "passed");
    add("smoke.candidate", "passed");
  }
  cleanupFixture(workspace, id);
  return checks;
}

function cleanupFixture(workspace, id) {
  try {
    for (const n of fs.readdirSync(workspace)) {
      if (n.startsWith("smoke-" + id)) fs.rmSync(path.join(workspace, n), { recursive: true, force: true });
      if (n === ".htmlgenius-bridge") fs.rmSync(path.join(workspace, n), { recursive: true, force: true });
    }
  } catch (_) {}
}

export async function main(argv) {
  const args = argv || process.argv.slice(2);
  const gate = checkGate();
  if (!gate.ok) {
    process.stderr.write(gate.message + " [" + gate.code + "]\n");
    return 2;
  }
  const pIdx = args.indexOf("--provider");
  let ids;
  if (pIdx > -1) {
    const id = args[pIdx + 1];
    if (!getProviderDescriptor(id)) { process.stderr.write("unknown provider: " + id + "\n"); return 64; }
    ids = [id];
  } else {
    ids = listProviderIds();
  }

  const report = makeReportSkeleton({ kind: "real_smoke", bridgeVersion: bridgeVersion(), startedAt: new Date().toISOString() });
  // 真实 probe(独立失败域)→ 带 reason_code 的 map
  const probeResult = await probeProviders(ids).catch(() => ({ providers: ids.map((id) => ({ id, status: "error", capabilities: [] })) }));
  const probeById = {};
  for (const p of probeResult.providers || []) {
    const { providerHealthEntry } = await import("../bridge-health.mjs");
    const h = providerHealthEntry(p);
    probeById[p.id] = { status: p.status, reason_code: h.reason_code };
  }

  for (const id of ids) {
    let checks;
    try { checks = await smokeProvider(id, gate.workspace, probeById); }
    catch (e) { checks = [{ id: "smoke.crash", result: "failed", reason_code: "SMOKE_CRASH" }]; }
    report.providers.push({
      id,
      result: checks.some((c) => c.result === "failed") ? "failed" : (checks.some((c) => c.result === "blocked") ? "blocked" : "passed"),
      capabilities: (getProviderDescriptor(id) || { capabilities: [] }).capabilities.slice(),
      checks
    });
  }
  // Chrome manual gate(骨架,不执行)
  report.chrome_native_messaging = chromeNativeSmokePlan();
  finalizeReport(report);
  // blocked 不算通过也不算失败:overall 单独表述
  if (report.result === "passed" && report.providers.some((p) => p.result === "blocked")) report.result = "blocked";

  const clean = sanitizeVerificationReport(report);
  const rIdx = args.indexOf("--report");
  if (rIdx > -1) {
    const outPath = args[rIdx + 1];
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(clean, null, 2) + "\n");
  }
  process.stdout.write("real smoke: " + clean.result + " — " + clean.summary.passed + " passed / " + clean.summary.failed + " failed / " + clean.summary.skipped + " skipped\n");
  for (const p of clean.providers) {
    process.stdout.write("  " + p.id + ": " + p.result + "\n");
    for (const c of p.checks) process.stdout.write("    [" + c.result + "] " + c.id + (c.reason_code ? " (" + c.reason_code + ")" : "") + "\n");
  }
  process.stdout.write("chrome native messaging: manual_gate(未声称无人值守 E2E)\n");
  process.stdout.write("注意:真实 smoke 通过不自动提升 provider 为正式支持;发布前仍需人工确认版本与账号环境。\n");
  return report.result === "failed" ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("real-smoke.mjs")) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write("real-smoke crashed: " + (e && e.message) + "\n"); process.exit(3); });
}
