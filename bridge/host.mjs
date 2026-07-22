#!/usr/bin/env node
// bridge/host.mjs — Chrome Native Messaging host 入口(v0.7.1,Claude Code provider)。
// stdin/stdout = native 4 字节帧;所有日志只写 stderr(stdout 只允许 native 帧)。
// claude_handoff_start 的实际编排见 host-runner.mjs(source 校验 → task bundle → claude -p/--resume → 完成事件)。
// host 名 com.htmlgenius.local_bridge 是 provider-neutral 的:后续 Codex adapter 复用同一 host,不新建。
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { NativeFrameDecoder, writeMessage } from "./native-protocol.mjs";
import { executeHandoff, executeCandidateRun, executePlanRun } from "./host-runner.mjs";
import { executeCodexCandidateRun, executeCodexPlanRun } from "./codex-adapter.mjs";
import { executeCopilotCandidateRun, executeCopilotPlanRun } from "./copilot-adapter.mjs";
import { probeProviders } from "./provider-probe.mjs";
import {
  PROTOCOL_VERSION, defaultHostsDir, validateExtensionId, inspectExistingManifest,
  ensureHostRegistration, buildLauncherSource
} from "./bridge-install.mjs";
import { buildHealth } from "./bridge-health.mjs";

function log(...args) {
  process.stderr.write("[htmlgenius-bridge] " + args.map(String).join(" ") + "\n");
}

// —— v0.9 §4.1:host 侧 health/repair(host 在运行即 bridge ready;origin 由 Chrome 路由已验证)——
function hostBridgeDir() { return path.dirname(new URL(import.meta.url).pathname); }
function hostBridgeVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(hostBridgeDir(), "package.json"), "utf8")).version || "0.0.0"; }
  catch (_) { return "0.0.0"; }
}
function isManagedInstall() {
  try { return fs.existsSync(path.join(hostBridgeDir(), "managed-install.json")); } catch (_) { return false; }
}
// hosts 目录:默认 Chrome 用户级目录;env 覆盖仅供测试(内部注入,非公开接口)。
function hostsDirForHost() { return process.env.HTMLGENIUS_HOSTS_DIR || defaultHostsDir(); }

async function hostHealth(msg) {
  const extId = msg && msg.extension && msg.extension.id;
  const platform = { os: process.platform === "darwin" ? "macos" : process.platform, arch: process.arch, supported: process.platform === "darwin" };
  let providers = [];
  try { providers = (await probeProviders(["claude_code_cli", "codex_app_server", "github_copilot"])).providers || []; }
  catch (_) { providers = [{ id: "claude_code_cli", status: "error", capabilities: [] }, { id: "codex_app_server", status: "error", capabilities: [] }, { id: "github_copilot", status: "error", capabilities: [] }]; }
  // 消息能送达即说明 Chrome 已按 allowed_origins 放行;仅在 ID 形态合法时报 origin_ok
  const browserStatus = (typeof extId === "string" && /^[a-p]{32}$/.test(extId)) ? "origin_ok" : "unknown";
  return buildHealth({
    bridgeStatus: "ready", bridgeVersion: hostBridgeVersion(), managedInstall: isManagedInstall(),
    protocolVersion: PROTOCOL_VERSION, platform, browserStatus, providerProbes: providers
  });
}

// repair allow-list(§4.1):仅重写它自身的 launcher + manifest(指向本 host 目录)+ 重探。
// 不安装 Node/Agent、不跑包管理器、不开 shell、不写项目目录。未经明确确认拒绝。
async function hostRepair(msg) {
  const confirmed = Array.isArray(msg && msg.confirmed_actions) ? msg.confirmed_actions : [];
  if (!confirmed.includes("repair_native_host")) {
    const e = new Error("repair requires confirmed_actions to include repair_native_host");
    e.code = "REPAIR_NOT_CONFIRMED"; throw e;
  }
  const extId = msg && msg.extension && msg.extension.id;
  validateExtensionId(extId); // 非法 → INVALID_EXTENSION_ID
  const hostsDir = hostsDirForHost();
  const ins = inspectExistingManifest({ hostsDir, extensionId: extId });
  if (ins.state === "ours_mismatch" || ins.state === "foreign") {
    const e = new Error("existing host registration belongs to another extension; refusing to overwrite");
    e.code = "EXTENSION_ORIGIN_MISMATCH"; throw e;
  }
  const dir = hostBridgeDir();
  const launcherSource = buildLauncherSource({ nodePath: process.execPath, hostPath: path.join(dir, "host.mjs"), version: hostBridgeVersion() });
  ensureHostRegistration({ hostsDir, extensionId: extId, launcherSource });
  return await hostHealth(msg);
}

// 分发一条来自 extension 的消息。返回值作为立即回帧;handoff/plan 不返回立即帧,改由 emit 持续发事件。
function dispatch(msg) {
  msg = msg || {};
  if (msg.type === "ping") return Promise.resolve({ type: "pong" });
  if (msg.type === "provider_probe") {
    // v0.8.1 §5.1/§7:只读 provider 探测。立即回 provider_probe_result(单次往返;background 侧 30s 缓存)。
    // v0.8.2:默认三 provider(claude / codex / github_copilot)。
    const providers = Array.isArray(msg.providers) ? msg.providers : ["claude_code_cli", "codex_app_server", "github_copilot"];
    return probeProviders(providers).then(
      (r) => ({ type: "provider_probe_result", providers: r.providers }),
      (e) => ({ type: "provider_probe_result", providers: [], error: (e && e.message) || "probe failed" })
    );
  }
  if (msg.type === "bridge_health") {
    // v0.9 §4.1:只读 health。立即回 bridge_health_result(§3.4 脱敏契约)。旧 host 无此分支 → unknown_message,
    // extension 侧据此判定「连接组件需要更新」。
    return hostHealth(msg).then(
      (health) => ({ type: "bridge_health_result", health }),
      (e) => ({ type: "bridge_failed", code: (e && e.code) || "HOST_HEALTH_ERROR", message: (e && e.message) || "health check failed" })
    );
  }
  if (msg.type === "bridge_repair") {
    // v0.9 §4.1:allow-list 修复(confirmed_actions 必含 repair_native_host);只重写自身注册文件,随后回 health。
    return hostRepair(msg).then(
      (health) => ({ type: "bridge_health_result", health }),
      (e) => ({ type: "bridge_failed", code: (e && e.code) || "HOST_REPAIR_ERROR", message: (e && e.message) || "repair failed" })
    );
  }
  if (msg.type === "copilot_handoff_start") {
    // v0.8.2 §6.1:GitHub Copilot 独立分支,绝不落到 claude 默认分支。run_kind 必须显式 plan|candidate。
    const emit = (payload) => {
      try { writeMessage(process.stdout, payload); }
      catch (e) { log("emit failed:", e && e.message); }
    };
    const runKind = msg.run_kind;
    (async () => {
      try {
        if (runKind === "plan") await executeCopilotPlanRun(msg, { emit });
        else if (runKind === "candidate") await executeCopilotCandidateRun(msg, { emit });
        else emit({ type: "bridge_failed", run_id: msg.run_id, code: "BAD_RUN_KIND", message: "copilot run_kind must be plan|candidate" });
      } catch (e) {
        log("copilot-" + (runKind || "?") + " crashed:", (e && e.stack) || e);
        emit({ type: "bridge_failed", run_id: msg.run_id, code: "HOST_CRASH", message: (e && e.message) || "host crash" });
      }
    })();
    return Promise.resolve(null);
  }
  if (msg.type === "claude_handoff_start" || msg.type === "codex_handoff_start") {
    const emit = (payload) => {
      try { writeMessage(process.stdout, payload); }
      catch (e) { log("emit failed:", e && e.message); }
    };
    const isCodex = msg.type === "codex_handoff_start";
    const runKind = msg.run_kind;
    (async () => {
      try {
        if (isCodex) {
          if (runKind === "plan") await executeCodexPlanRun(msg, { emit });
          else await executeCodexCandidateRun(msg, { emit }); // candidate + 旧 handoff
        } else {
          if (runKind === "plan") await executePlanRun(msg, { emit });
          else if (runKind === "candidate") await executeCandidateRun(msg, { emit });
          else await executeHandoff(msg, { emit });
        }
      } catch (e) {
        const label = isCodex ? (runKind === "plan" ? "codex-plan" : "codex") : (runKind === "plan" ? "plan" : runKind === "candidate" ? "candidate" : "handoff");
        log(label + " crashed:", (e && e.stack) || e);
        emit({ type: "bridge_failed", run_id: msg.run_id, code: "HOST_CRASH", message: (e && e.message) || "host crash" });
      }
    })();
    return Promise.resolve(null);
  }
  return Promise.resolve({ type: "bridge_failed", code: "unknown_message", message: "host received unknown message type: " + (msg.type || "(none)") });
}

const decoder = new NativeFrameDecoder();
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (const msg of decoder.messages()) {
      let reply;
      try { reply = await dispatch(msg); }
      catch (e) {
        log("dispatch error:", e && e.message);
        reply = { type: "bridge_failed", code: (e && e.code) || "host_error", message: (e && e.message) || "host dispatch error" };
      }
      if (reply) {
        try { writeMessage(process.stdout, reply); }
        catch (e) { log("write failed:", e && e.message); }
      }
    }
  } finally { pumping = false; }
}

process.stdin.on("data", (chunk) => { decoder.feed(chunk); pump(); });
process.stdin.on("end", () => { log("stdin ended, exiting"); process.exit(0); });
process.stdin.on("error", (e) => { log("stdin error:", e && e.message); process.exit(1); });
process.on("uncaughtException", (e) => { log("uncaughtException:", (e && e.stack) || e); });
process.on("exit", (code) => { log("host exit code=" + code); });

log("host started, node=" + process.version);
