// bridge/app-server-client.mjs — Codex App Server JSON-RPC 客户端。
// 协议依据(§3):stdio、行分隔 JSON-RPC。必须先 initialize 再 initialized;
//   thread/start 创建、thread/resume 续发、turn/start 发起工作单元,turn 以 turn/completed|failed|cancelled 事件结束。
// 安全(§7.2):command 固定为 `codex app-server`,不接受 extension 消息传入 command/argv/cwd/env。
//   仅 code 级构造参数可注入 command(供测试用 fake server),生产恒用默认。
//   stderr 仅收集 ≤8KiB 诊断;不回传敏感路径外的内容。
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_COMMAND = ["codex", "app-server"];
export const TURN_TIMEOUT_MS = 10 * 60 * 1000; // §7.2.6 10 分钟
export const STDERR_CAP = 8 * 1024;

// 兼容性自检(§3):检查 schema 文本是否包含必需方法/事件。返回 true 或抛 INCOMPATIBLE。
export function validateAppServerSchema(schemaText) {
  const required = ["initialize", "thread/start", "thread/resume", "turn/start", "turn/completed"];
  const missing = required.filter((m) => !String(schemaText).includes(m));
  if (missing.length) {
    const err = new Error("app-server schema missing: " + missing.join(", "));
    err.code = "INCOMPATIBLE";
    err.missing = missing;
    throw err;
  }
  return true;
}

// 运行 `codex app-server generate-json-schema --out <tmpDir>`,读取产物并校验。
// 真实 codex 路径,仅手工验收;自动测试用 validateAppServerSchema 直接覆盖。
export function probeSchema({ codexPath = "codex", tmpDir } = {}) {
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), "hg-codex-schema-"));
  const r = spawnSync(codexPath, ["app-server", "generate-json-schema", "--out", dir], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    const err = new Error("generate-json-schema failed: " + (r.stderr || (r.error && r.error.message) || "status " + r.status));
    err.code = "INCOMPATIBLE";
    try { if (!tmpDir) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
  let schemaText = "";
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) schemaText += "\n" + fs.readFileSync(path.join(dir, f), "utf8");
  } catch (e) { /* ignore */ }
  try { if (!tmpDir) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  validateAppServerSchema(schemaText);
  return { ok: true };
}

export class AppServerClient {
  // command 可注入(测试用);生产用 DEFAULT_COMMAND。cwd/env 可选。
  constructor({ command, cwd, env, onNotification, turnTimeoutMs } = {}) {
    this._command = command || DEFAULT_COMMAND;
    this._cwd = cwd || undefined;
    this._env = env || undefined;
    this._onNotification = onNotification || (() => {});
    this._turnTimeoutMs = turnTimeoutMs || TURN_TIMEOUT_MS;
    this._child = null;
    this._nextId = 1;
    this._pending = new Map();          // id -> {resolve, reject}
    this._pendingTurn = null;           // { turnId, resolve, reject, timer }
    this._stderr = "";
    this._lineBuf = "";
    this._stopped = false;
  }

  get stderr() { return this._stderr; }

  start() {
    if (this._child) return;
    const child = spawn(this._command[0], this._command.slice(1), {
      cwd: this._cwd, env: this._env, stdio: ["pipe", "pipe", "pipe"]
    });
    this._child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const add = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (this._stderr.length < STDERR_CAP) this._stderr += add.slice(0, STDERR_CAP - this._stderr.length);
    });
    child.on("exit", (code, signal) => {
      if (this._pendingTurn && !this._stopped) {
        this._failTurn("CHILD_EXIT", "app-server exited code=" + code + " signal=" + signal + (this._stderr ? " stderr: " + this._stderr.slice(0, 512) : ""));
      }
      for (const [, p] of this._pending) p.reject(Object.assign(new Error("app-server exited"), { code: "CHILD_EXIT" }));
      this._pending.clear();
    });
    child.on("error", (e) => {
      const err = Object.assign(new Error("failed to spawn app-server: " + e.message), { code: "SPAWN_FAILED" });
      for (const [, p] of this._pending) p.reject(err);
      this._pending.clear();
      if (this._pendingTurn) this._failTurn("SPAWN_FAILED", err.message);
    });
  }

  _onStdout(chunk) {
    this._lineBuf += chunk;
    let idx;
    while ((idx = this._lineBuf.indexOf("\n")) !== -1) {
      const line = this._lineBuf.slice(0, idx).trim();
      this._lineBuf = this._lineBuf.slice(idx + 1);
      if (line) {
        try { this._handle(JSON.parse(line)); }
        catch (e) { /* 忽略非 JSON 行(心跳/调试) */ }
      }
    }
  }

  _handle(msg) {
    // 1) response(有 id、有 result/error):匹配 pending request
    if (("result" in msg || "error" in msg) && msg.id != null) {
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        if (msg.error) p.reject(this._toRpcError(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
    // 2) server request(有 id、有 method):approval/user-input 等 —— v0.7 不处理,即失败
    if (msg.id != null && msg.method) {
      this._respondError(msg.id, -32601, "htmlgenius bridge does not handle server requests");
      if (this._pendingTurn) this._failTurn("AGENT_NEEDS_INPUT", "app-server sent an unhandled server request: " + msg.method);
      return;
    }
    // 3) notification(无 id、有 method):turn 终态等
    if (msg.method) {
      this._routeNotification(msg.method, msg.params || {});
      return;
    }
  }

  _routeNotification(method, params) {
    if (method === "turn/completed" && this._pendingTurn) { this._resolveTurn(params); return; }
    if (method === "turn/failed" && this._pendingTurn) { this._failTurn("TURN_FAILED", this._msg(params)); return; }
    if (method === "turn/cancelled" && this._pendingTurn) { this._failTurn("TURN_CANCELLED", this._msg(params)); return; }
    this._onNotification(method, params);
  }

  _msg(params) {
    if (!params) return "";
    if (typeof params === "string") return params;
    if (params.error && params.error.message) return params.error.message;
    if (params.message) return params.message;
    try { return JSON.stringify(params).slice(0, 400); } catch (_) { return ""; }
  }

  request(method, params) {
    const id = this._nextId++;
    const out = { jsonrpc: "2.0", id, method };
    if (params !== undefined) out.params = params;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._writeLine(out);
    });
  }

  notify(method, params) {
    const out = { jsonrpc: "2.0", method };
    if (params !== undefined) out.params = params;
    this._writeLine(out);
  }

  _writeLine(obj) {
    if (!this._child || !this._child.stdin.writable) {
      throw Object.assign(new Error("app-server stdin not writable"), { code: "NOT_CONNECTED" });
    }
    this._child.stdin.write(JSON.stringify(obj) + "\n");
  }

  _respondError(id, code, message) {
    try { this._writeLine({ jsonrpc: "2.0", id, error: { code, message } }); } catch (_) {}
  }

  _toRpcError(errObj) {
    return Object.assign(new Error((errObj && errObj.message) || "JSON-RPC error"), { code: "RPC_ERROR", rpc: errObj });
  }

  // initialize(initialized notification 跟随;§7.2.1/2)
  async initialize({ clientName = "htmlgenius-bridge", clientVersion = "0.7.0" } = {}) {
    const result = await this.request("initialize", {
      client: { name: clientName, version: clientVersion }
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  threadStart(params) { return this.request("thread/start", params); }
  threadResume(params) { return this.request("thread/resume", params); }

  // turn/start 请求返回后,等待 turn/completed|failed|cancelled 通知,或超时/server request。
  // onStarted(turnId) 在 turn 被接受时触发(host 据此发 bridge_turn_started,§6.2)。
  runTurn(params, { onStarted } = {}) {
    return (async () => {
      const startResult = await this.request("turn/start", params);
      const turnId = (startResult && (startResult.turn_id || startResult.id)) || null;
      if (typeof onStarted === "function") { try { onStarted(turnId); } catch (_) {} }
      return new Promise((resolve, reject) => {
        this._pendingTurn = { turnId, resolve, reject };
        this._turnTimer = setTimeout(() => {
          this._failTurn("TURN_TIMEOUT", "turn exceeded " + this._turnTimeoutMs + "ms");
        }, this._turnTimeoutMs);
      });
    })();
  }

  _resolveTurn(params) {
    const t = this._pendingTurn; if (!t) return;
    clearTimeout(this._turnTimer);
    this._pendingTurn = null; this._turnTimer = null;
    t.resolve(params);
  }
  _failTurn(code, message) {
    const t = this._pendingTurn; if (!t) return;
    clearTimeout(this._turnTimer);
    this._pendingTurn = null; this._turnTimer = null;
    t.reject(Object.assign(new Error(message || code), { code }));
  }

  // kill child + 清理 timer(正常/异常结束都调;§7.2.7)
  async stop() {
    this._stopped = true;
    if (this._turnTimer) clearTimeout(this._turnTimer);
    this._pendingTurn = null;
    for (const [, p] of this._pending) p.reject(Object.assign(new Error("client stopped"), { code: "STOPPED" }));
    this._pending.clear();
    const child = this._child;
    if (!child) return;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      child.once("exit", fin);
      try { child.stdin && child.stdin.end(); } catch (_) {}
      try { child.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} fin(); }, 1500);
    });
    this._child = null;
  }
}
