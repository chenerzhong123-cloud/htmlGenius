#!/usr/bin/env node
// bridge/host.mjs — Chrome Native Messaging host 入口。
// stdin/stdout = native 4-byte 帧;所有日志只写 stderr(stdout 只允许 native 帧)。
// start_run 的实际编排见 host-runner.mjs(prepareRun → app-server → finalizeRun)。
import process from "node:process";
import { NativeFrameDecoder, writeMessage } from "./native-protocol.mjs";
import { executeStartRun } from "./host-runner.mjs";
import { AppServerClient, probeSchema } from "./app-server-client.mjs";

function log(...args) {
  process.stderr.write("[htmlgenius-bridge] " + args.map(String).join(" ") + "\n");
}

// §3 兼容性自检:首次 start_run 前跑一次 generate-json-schema + schema 校验,缓存结果。
// 自动测试直接测 executeStartRun(注入 fake spawnClient),不走本 dispatch,故真实 codex 依赖不影响测试。
let _compatVerified = false;
let _compatFailedMsg = null;
async function ensureCompatible(emit, runId) {
  if (_compatVerified) return true;
  if (_compatFailedMsg) { emit({ type: "bridge_failed", run_id: runId, code: "CODEX_INCOMPATIBLE", message: _compatFailedMsg }); return false; }
  try {
    probeSchema({}); // 跑 `codex app-server generate-json-schema` + 校验必需方法/事件
    _compatVerified = true;
    return true;
  } catch (e) {
    _compatFailedMsg = (e && e.message) || "codex app-server incompatible or not installed";
    log("compat check failed:", _compatFailedMsg);
    emit({ type: "bridge_failed", run_id: runId, code: "CODEX_INCOMPATIBLE", message: _compatFailedMsg });
    return false;
  }
}

// 分发一条来自 extension 的消息。返回值作为立即回帧;start_run 不返回立即帧,改由 emit 持续发事件。
function dispatch(msg) {
  msg = msg || {};
  if (msg.type === "ping") return Promise.resolve({ type: "pong" });
  if (msg.type === "start_run") {
    const emit = (payload) => {
      try { writeMessage(process.stdout, payload); }
      catch (e) { log("emit failed:", e && e.message); }
    };
    (async () => {
      if (!(await ensureCompatible(emit, msg.request_id))) return;
      try {
        await executeStartRun(msg, { spawnClient: () => new AppServerClient({}), emit });
      } catch (e) {
        log("run crashed:", e && e.message);
        emit({ type: "bridge_failed", run_id: msg.request_id, code: "HOST_CRASH", message: (e && e.message) || "host crash" });
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
process.on("uncaughtException", (e) => { log("uncaughtException:", e && e.stack || e); });
process.on("exit", (code) => { log("host exit code=" + code); });

log("host started, node=" + process.version);
