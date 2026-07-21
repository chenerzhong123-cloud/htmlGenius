#!/usr/bin/env node
// bridge/host.mjs — Chrome Native Messaging host 入口(v0.7.1,Claude Code provider)。
// stdin/stdout = native 4 字节帧;所有日志只写 stderr(stdout 只允许 native 帧)。
// claude_handoff_start 的实际编排见 host-runner.mjs(source 校验 → task bundle → claude -p/--resume → 完成事件)。
// host 名 com.htmlgenius.local_bridge 是 provider-neutral 的:后续 Codex adapter 复用同一 host,不新建。
import process from "node:process";
import { NativeFrameDecoder, writeMessage } from "./native-protocol.mjs";
import { executeHandoff, executeCandidateRun } from "./host-runner.mjs";
import { executeCodexCandidateRun } from "./codex-adapter.mjs";

function log(...args) {
  process.stderr.write("[htmlgenius-bridge] " + args.map(String).join(" ") + "\n");
}

// 分发一条来自 extension 的消息。返回值作为立即回帧;handoff 不返回立即帧,改由 emit 持续发事件。
function dispatch(msg) {
  msg = msg || {};
  if (msg.type === "ping") return Promise.resolve({ type: "pong" });
  if (msg.type === "claude_handoff_start" || msg.type === "codex_handoff_start") {
    const emit = (payload) => {
      try { writeMessage(process.stdout, payload); }
      catch (e) { log("emit failed:", e && e.message); }
    };
    const isCodex = msg.type === "codex_handoff_start";
    const isCandidate = msg.run_kind === "candidate";
    (async () => {
      try {
        if (isCodex) await executeCodexCandidateRun(msg, { emit });
        else if (isCandidate) await executeCandidateRun(msg, { emit });
        else await executeHandoff(msg, { emit });
      } catch (e) {
        log((isCodex ? "codex" : isCandidate ? "candidate" : "handoff") + " crashed:", (e && e.stack) || e);
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
