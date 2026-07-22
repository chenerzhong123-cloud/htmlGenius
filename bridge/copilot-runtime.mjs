// bridge/copilot-runtime.mjs — v0.8.2 GitHub Copilot runtime 层。
// 职责:本地 Copilot CLI 发现(受控、拒 symlink)、@github/copilot-sdk 客户端工厂、probe(只读、不建 session)、
//       pre-tool-use 安全策略(工具 allow-list + 路径围栏)、受控 session 执行(sendAndWait + 清理)。
//
// 安全边界(v0.8.2 §5.2/§7):
// - 只允许文件读写类内置工具(view/edit/write/grep/glob 等);shell/bash/web_fetch/task/subagent/MCP/… 全部拒绝。
// - 写工具只能落指定输出(candidate run: candidate.html;plan run: output/plan.json),路径必须落在 run workspace 内。
// - CLI 绝对路径、token、stderr、session ID 永不离开 host(probe 结果只含 runtime 枚举/版本/状态)。
// - 每个 run 一个 client + 一个新 session;失败/超时先 abort 再 disconnect,最后 stop/forceStop。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COPILOT_PROVIDER = "github_copilot";
export const COPILOT_RUNTIMES = { LOCAL_CLI: "local_cli", BUNDLED_SDK_CLI: "bundled_sdk_cli" };
export const RUNTIME_LABELS = {
  [COPILOT_RUNTIMES.LOCAL_CLI]: "本地 Copilot CLI",
  [COPILOT_RUNTIMES.BUNDLED_SDK_CLI]: "SDK runtime"
};

// v0.8.2 §5.5 错误码。消息面向 UI ≤400 字符,不含路径/token/session。
export const COPILOT_ERRORS = {
  SDK_NOT_INSTALLED: "COPILOT_SDK_NOT_INSTALLED",
  CLI_NOT_FOUND: "COPILOT_CLI_NOT_FOUND",
  INCOMPATIBLE: "COPILOT_CLI_INCOMPATIBLE",
  AUTH_REQUIRED: "COPILOT_AUTH_REQUIRED",
  RUNTIME_CHANGED: "COPILOT_RUNTIME_CHANGED",
  PERMISSION_DENIED: "COPILOT_PERMISSION_DENIED",
  PLAN_FAILED: "COPILOT_PLAN_FAILED",
  PLAN_TIMEOUT: "COPILOT_PLAN_TIMEOUT",
  RUN_FAILED: "COPILOT_RUN_FAILED",
  TIMEOUT: "COPILOT_TIMEOUT"
};

export const PLAN_TIMEOUT_MS = 180_000;     // v0.8.2 §5.2:Plan 3 分钟
export const CANDIDATE_TIMEOUT_MS = 480_000; // Candidate 8 分钟
export const CLI_VERSION_TIMEOUT_MS = 10_000;
export const MAX_VERSION_LEN = 64;
export const MAX_ERROR_MSG_LEN = 400;

// —— 工具 allow-list ——
// 真实工具名经 SDK fixture / copilot-cli changelog 核实:文件类 = view/edit/write/grep/glob;
// 危险类 = bash/read_bash/write_bash/shell/web_fetch/task/read_agent/... (见 DENIED_BUILTIN_TOOLS)。
// 读工具允许读 workspace 内任意文件(source.html / task bundle / approved-plan.md)。
export const READ_TOOLS = Object.freeze([
  "view", "read_file", "read_many_files", "list_directory", "list_dir",
  "grep", "grep_search", "glob", "find_files", "search_files"
]);
// 写工具:路径必须精确等于本次 run 允许的输出文件(由 adapter 指定)。
export const WRITE_TOOLS = Object.freeze([
  "write", "write_file", "create_file", "edit", "edit_file", "str_replace",
  "str_replace_based_edit", "multi_edit", "insert_content"
]);
// 显式拒绝清单(与 allow-list 构成纵深防御;empty 模式下 denied 优先)。
export const DENIED_BUILTIN_TOOLS = Object.freeze([
  "bash", "read_bash", "write_bash", "shell", "run_shell_command", "execute_command",
  "web_fetch", "fetch", "url",
  "task", "read_agent", "write_agent", "list_agents", "send_inbox", "context_board",
  "skill", "activate_skill", "ask_user", "exit_plan_mode",
  "vote_memory", "save_memory", "update_memory", "todo_write", "update_todos"
]);

function copilotError(code, message) {
  const e = new Error(String(message || "").slice(0, MAX_ERROR_MSG_LEN));
  e.code = code;
  return e;
}

// ———————————————————————— 本地 CLI 发现(§4.3)————————————————————————

// 常见 macOS bin 目录(home 在运行时解析);与 PATH 分段合并去重后按序扫描。
export const COMMON_CLI_DIRS = [
  "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin",
  "~/.local/bin", "~/.npm-global/bin", "~/.cargo/bin", "~/.copilot/bin"
];

function resolveDir(d, home) {
  if (d === "~") return home;
  if (d.startsWith("~/")) return path.join(home, d.slice(2));
  return d;
}

// 扫描受控 PATH 分段 + 常见 bin 目录找 `copilot`。
// 拒绝:symlink(lstat 判断,防指向不受控二进制)、目录、不可执行文件。不执行未验证路径。
export function discoverLocalCopilotCli({ env = process.env, fsImpl = fs, platform = process.platform } = {}) {
  if (platform !== "darwin") return null; // host 仅 macOS
  const home = env.HOME || os.homedir() || "";
  const dirs = [];
  const seen = new Set();
  const push = (d) => {
    if (!d || typeof d !== "string") return;
    const r = resolveDir(d, home);
    if (!r || r === "/" || seen.has(r)) return;
    seen.add(r); dirs.push(r);
  };
  String(env.PATH || "").split(":").forEach(push);
  COMMON_CLI_DIRS.forEach(push);
  for (const dir of dirs) {
    const candidate = path.join(dir, "copilot");
    let st;
    try { st = fsImpl.lstatSync(candidate); } catch (_) { continue; }
    if (st.isSymbolicLink()) continue; // 拒绝 symlink
    if (!st.isFile()) continue;        // 拒绝目录等
    try { fsImpl.accessSync(candidate, fsImpl.constants ? fsImpl.constants.X_OK : 1); } catch (_) { continue; }
    return candidate;
  }
  return null;
}

// 只读取版本字符串作 probe metadata(≤64 chars);shell:false、10s 超时、stdout/stderr 限长。
export async function readCopilotCliVersion(cliPath, { execFileImpl = execFile } = {}) {
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      execFileImpl(cliPath, ["version"], { timeout: CLI_VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err || typeof stdout !== "string") return finish(null);
        const v = stdout.split("").filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim().slice(0, MAX_VERSION_LEN);
        finish(v || null);
      });
    } catch (_) { finish(null); }
  });
}

// ———————————————————————— SDK 加载与客户端工厂 ————————————————————————

export async function loadCopilotSdk({ sdkLoader } = {}) {
  const loader = sdkLoader || (() => import("@github/copilot-sdk"));
  try {
    return await loader();
  } catch (e) {
    if (e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND")) {
      throw copilotError(COPILOT_ERRORS.SDK_NOT_INSTALLED, "GitHub Copilot runtime is not installed (bridge dependency missing). Run `cd bridge && npm install`.");
    }
    throw e;
  }
}

// 每个 run 一份客户端配置(§5.1/§5.2):empty 模式(telemetry 默认关、强制 availableTools)、
// workingDirectory = run workspace、baseDirectory = workspace 内受控 COPILOT_HOME。
export function buildCopilotClientOptions({ sdk, runtime, cliPath, cwd, baseDirectory }) {
  const options = {
    mode: "empty",
    workingDirectory: cwd,
    baseDirectory,
    telemetry: { enabled: false }
  };
  if (runtime === COPILOT_RUNTIMES.LOCAL_CLI) {
    if (!cliPath) throw copilotError(COPILOT_ERRORS.CLI_NOT_FOUND, "local Copilot CLI path is required for local_cli runtime");
    options.connection = sdk.RuntimeConnection.forStdio({ path: cliPath });
  }
  return options;
}

export function buildAvailableTools() {
  return [...READ_TOOLS, ...WRITE_TOOLS].map((n) => "builtin:" + n);
}
export function buildExcludedTools() {
  return DENIED_BUILTIN_TOOLS.map((n) => "builtin:" + n);
}

// ———————————————————————— probe(§6.2:只读,不建 session)————————————————————————

function probeResult({ status, runtime = null, version = null }) {
  const out = {
    id: COPILOT_PROVIDER,
    label: "GitHub Copilot",
    status,
    capabilities: ["candidate", "plan"]
  };
  if (runtime) { out.runtime = runtime; out.runtime_label = RUNTIME_LABELS[runtime]; }
  if (version) out.version = String(version).slice(0, MAX_VERSION_LEN);
  return out; // 绝不包含 CLI 路径 / login / host / token / stderr
}

// 尝试用 SDK 启动一种 runtime 并读 auth/status。返回 { ok, runtime, authed, version } 或 { ok:false }。
// 全程不 createSession / send / listSessions。finally 里 stop。probe 与执行期 runtime 选择共用。
export async function attemptRuntimeStart({ sdk, runtime, cliPath }) {
  let client = null;
  try {
    client = new sdk.CopilotClient(
      runtime === COPILOT_RUNTIMES.LOCAL_CLI
        ? { connection: sdk.RuntimeConnection.forStdio({ path: cliPath }) }
        : {}
    );
    await client.start();
    const auth = await client.getAuthStatus();
    let version = null;
    try { const st = await client.getStatus(); if (st && st.version) version = st.version; } catch (_) { /* 版本只是 metadata */ }
    return { ok: true, runtime, authed: !!(auth && auth.isAuthenticated), version };
  } catch (_) {
    return { ok: false };
  } finally {
    if (client) { try { await client.stop(); } catch (_) { try { await client.forceStop(); } catch (_) {} } }
  }
}

// runtime 选择优先级(§3.2):本地 CLI(SDK cliPath 模式)→ 失败/缺失/不兼容 → SDK 自带 managed runtime → 都失败则不可用。
// 注意:probe 阶段的 fallback 是允许的;已启动的 run 内绝不 fallback。
export async function probeCopilot({ sdkLoader, execFileImpl, env, fsImpl } = {}) {
  try {
    let sdk;
    try { sdk = await loadCopilotSdk({ sdkLoader }); }
    catch (e) {
      if (e && e.code === COPILOT_ERRORS.SDK_NOT_INSTALLED) return probeResult({ status: "not_installed" });
      return probeResult({ status: "error" });
    }

    const cliPath = discoverLocalCopilotCli({ env, fsImpl });
    let localBroken = false;
    if (cliPath) {
      const ver = await readCopilotCliVersion(cliPath, { execFileImpl });
      if (ver === null) {
        localBroken = true; // 二进制存在但无法读取版本 → 视为不兼容,转 bundled
      } else {
        const r = await attemptRuntimeStart({ sdk, runtime: COPILOT_RUNTIMES.LOCAL_CLI, cliPath });
        if (r.ok) return probeResult({ status: r.authed ? "ready" : "auth_required", runtime: r.runtime, version: r.version || ver });
        localBroken = true; // SDK 无法与本地 CLI 建立兼容连接 → 转 bundled
      }
    }

    const r = await attemptRuntimeStart({ sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null });
    if (r.ok) return probeResult({ status: r.authed ? "ready" : "auth_required", runtime: r.runtime, version: r.version });

    return probeResult({ status: localBroken ? "incompatible" : "not_installed" });
  } catch (_) {
    return probeResult({ status: "error" });
  }
}

// ———————————————————————— 执行期 runtime 选择(§3.2)————————————————————————

// run 启动前选择 runtime。与 probe 的区别:成功返回 { sdk, runtime, cliPath, version },失败抛带码错误。
// - 无 requiredRuntime:local CLI 优先 → 不可用则 bundled(执行前 fallback 允许)。
// - 有 requiredRuntime(Plan→Candidate 一致性):只用指定 runtime;不可用 → COPILOT_RUNTIME_CHANGED,绝不静默切换。
// - 已选定 runtime 但未登录 → COPILOT_AUTH_REQUIRED。
export async function selectCopilotRuntime({ requiredRuntime = null, sdkLoader, execFileImpl, env, fsImpl } = {}) {
  const sdk = await loadCopilotSdk({ sdkLoader }); // 缺依赖 → COPILOT_SDK_NOT_INSTALLED

  const pick = async (runtime, cliPath) => attemptRuntimeStart({ sdk, runtime, cliPath });
  const guardAuth = (r) => {
    if (!r.authed) throw copilotError(COPILOT_ERRORS.AUTH_REQUIRED, "Please sign in to GitHub Copilot on this machine first.");
  };

  if (requiredRuntime) {
    if (requiredRuntime !== COPILOT_RUNTIMES.LOCAL_CLI && requiredRuntime !== COPILOT_RUNTIMES.BUNDLED_SDK_CLI) {
      throw copilotError(COPILOT_ERRORS.RUNTIME_CHANGED, "Unknown Copilot runtime in plan; please regenerate the plan.");
    }
    let cliPath = null;
    if (requiredRuntime === COPILOT_RUNTIMES.LOCAL_CLI) {
      cliPath = discoverLocalCopilotCli({ env, fsImpl });
      if (!cliPath) throw copilotError(COPILOT_ERRORS.RUNTIME_CHANGED, "The Copilot runtime that produced the plan is no longer available; please regenerate the plan.");
      const ver = await readCopilotCliVersion(cliPath, { execFileImpl });
      if (ver === null) throw copilotError(COPILOT_ERRORS.RUNTIME_CHANGED, "The Copilot runtime that produced the plan is no longer available; please regenerate the plan.");
    }
    const r = await pick(requiredRuntime, cliPath);
    if (!r.ok) throw copilotError(COPILOT_ERRORS.RUNTIME_CHANGED, "The Copilot runtime that produced the plan is no longer available; please regenerate the plan.");
    guardAuth(r);
    return { sdk, runtime: requiredRuntime, cliPath, version: r.version };
  }

  let localBroken = false;
  const cliPath = discoverLocalCopilotCli({ env, fsImpl });
  if (cliPath) {
    const ver = await readCopilotCliVersion(cliPath, { execFileImpl });
    if (ver === null) {
      localBroken = true;
    } else {
      const r = await pick(COPILOT_RUNTIMES.LOCAL_CLI, cliPath);
      if (r.ok) { guardAuth(r); return { sdk, runtime: COPILOT_RUNTIMES.LOCAL_CLI, cliPath, version: r.version || ver }; }
      localBroken = true;
    }
  }
  const r = await pick(COPILOT_RUNTIMES.BUNDLED_SDK_CLI, null);
  if (r.ok) { guardAuth(r); return { sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, version: r.version }; }
  throw copilotError(
    localBroken ? COPILOT_ERRORS.INCOMPATIBLE : COPILOT_ERRORS.SDK_NOT_INSTALLED,
    localBroken ? "Local Copilot CLI is incompatible with the locked SDK and the bundled runtime is unavailable."
                : "GitHub Copilot runtime is unavailable on this machine."
  );
}

// ———————————————————————— pre-tool-use 安全策略(§5.2)————————————————————————

// 路径围栏:value 解析后必须落在 workspaceDir 内(拒 ../ 越界与符号链接逃逸)。
// 两侧都先 realpath 规范化再比较(macOS /tmp 实为 /private/tmp 的 symlink,词法比较会误杀/误放)。
function isInsideWorkspace(workspaceDir, p, fsImpl) {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return false;
  const resolved = path.resolve(workspaceDir, p);
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + path.sep)) return false;
  let realWs;
  try { realWs = fsImpl.realpathSync(workspaceDir); } catch (_) { realWs = workspaceDir; }
  const insideReal = (real) => real === realWs || real.startsWith(realWs + path.sep);
  // 符号链接逃逸检查:对最深存在祖先做 realpath,要求仍落在规范化 workspace 内
  try {
    let cur = resolved;
    while (true) {
      let exists = true;
      try { fsImpl.lstatSync(cur); } catch (_) { exists = false; }
      if (exists) {
        let real;
        try { real = fsImpl.realpathSync(cur); } catch (_) { return false; }
        return insideReal(real);
      }
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  } catch (_) { return false; }
}

// 从 toolArgs 中提取路径类参数(key 含 path/file/dir)。
function extractPathArgs(toolArgs) {
  const out = [];
  if (toolArgs && typeof toolArgs === "object") {
    for (const [k, v] of Object.entries(toolArgs)) {
      if (/path|file|dir/i.test(k) && typeof v === "string") out.push(v);
      // 兼容数组形式(如 read_many_files 的 paths)
      if (/path|file|dir/i.test(k) && Array.isArray(v)) for (const item of v) if (typeof item === "string") out.push(item);
    }
  }
  return out;
}

// 构造 onPreToolUse handler。返回 { handler, stats }。
// - writableFiles:绝对路径数组(candidate run: [<ws>/candidate.html];plan run: [<ws>/output/plan.json])
// - recordDenial(toolName, reason):审计事件,只记工具名与拒绝类别,绝不记路径/正文。
export function createPreToolPolicy({ workspaceDir, writableFiles, fsImpl = fs, recordDenial = () => {} }) {
  const readable = new Set(READ_TOOLS);
  const writable = new Set(WRITE_TOOLS);
  const allowedOutputs = new Set((writableFiles || []).map((f) => path.resolve(workspaceDir, f)));
  const stats = { denials: 0 };

  const handler = (input) => {
    const toolName = String((input && input.toolName) || "").toLowerCase();
    const deny = (category) => {
      stats.denials += 1;
      try { recordDenial(toolName, category); } catch (_) {}
      return { permissionDecision: "deny", permissionDecisionReason: "htmlgenius: " + category };
    };

    const isRead = readable.has(toolName);
    const isWrite = writable.has(toolName);
    if (!isRead && !isWrite) return deny("tool_not_allowed");

    const paths = extractPathArgs(input && input.toolArgs);
    for (const p of paths) {
      if (!isInsideWorkspace(workspaceDir, p, fsImpl)) return deny("path_outside_workspace");
      if (isWrite) {
        const resolved = path.resolve(workspaceDir, p);
        if (!allowedOutputs.has(resolved)) return deny("write_not_allowed_output");
      }
    }
    // 写工具却没有任何可识别的路径参数 → 保守拒绝(防止未覆盖的参数形状绕过)
    if (isWrite && paths.length === 0) return deny("write_without_path");
    return { permissionDecision: "allow" };
  };

  return { handler, stats };
}

// ———————————————————————— 受控 session 执行(§5.1/§5.3/§5.4)————————————————————————

// 运行一个新 session:sendAndWait(prompt, timeoutMs) → 无论成败 disconnect + stop/forceStop。
// 返回 { denialCount, reply }。超时先 abort 再抛 COPILOT_(PLAN_)TIMEOUT;失败抛 COPILOT_(PLAN_)RUN_FAILED。
export async function runCopilotSession({
  sdk, runtime, cliPath, cwd, baseDirectory, prompt, timeoutMs, writableFiles,
  runKind = "candidate", onEvent = null, fsImpl = fs
}) {
  const timeoutCode = runKind === "plan" ? COPILOT_ERRORS.PLAN_TIMEOUT : COPILOT_ERRORS.TIMEOUT;
  const failedCode = runKind === "plan" ? COPILOT_ERRORS.PLAN_FAILED : COPILOT_ERRORS.RUN_FAILED;

  const { handler, stats } = createPreToolPolicy({
    workspaceDir: cwd,
    writableFiles,
    fsImpl,
    recordDenial: (toolName, category) => {
      if (onEvent) { try { onEvent({ kind: "tool_denied", tool: toolName, category }); } catch (_) {} }
    }
  });

  const client = new sdk.CopilotClient(buildCopilotClientOptions({ sdk, runtime, cliPath, cwd, baseDirectory }));
  let session = null;
  try {
    await client.start();
    session = await client.createSession({
      clientName: "htmlgenius-bridge",
      availableTools: buildAvailableTools(),
      excludedTools: buildExcludedTools(),
      hooks: { onPreToolUse: handler }
    });
    if (onEvent && typeof session.on === "function") {
      session.on((event) => {
        // 只转发脱敏事件:工具执行名(不带参数)、assistant 文本截断、idle。不转发 session ID/路径/token。
        try {
          const type = event && event.type;
          if (type === "tool.execution_start") onEvent({ kind: "tool", name: String((event.data && event.data.toolName) || "").slice(0, 64) });
          else if (type === "assistant.message") onEvent({ kind: "text", text: String((event.data && event.data.content) || "").slice(0, 500) });
          else if (type === "session.idle") onEvent({ kind: "idle" });
        } catch (_) {}
      });
    }
    let reply;
    try {
      reply = await session.sendAndWait({ prompt }, timeoutMs);
    } catch (e) {
      try { await session.abort(); } catch (_) {}
      const rawMsg = String((e && e.message) || e || "");
      // 原始错误只进 host 本地 stderr(排障用),绝不回传 UI:其中可能含路径/token/session 信息(§5.5)
      try { console.error("[htmlgenius-bridge] copilot " + runKind + " error:", rawMsg.slice(0, 2000)); } catch (_) {}
      if (/timeout|timed out/i.test(rawMsg)) throw copilotError(timeoutCode, "Copilot " + runKind + " timed out after " + Math.round(timeoutMs / 1000) + "s.");
      throw copilotError(failedCode, "Copilot " + runKind + " failed.");
    }
    return { denialCount: stats.denials, reply };
  } finally {
    if (session) { try { await session.disconnect(); } catch (_) {} }
    try {
      const errs = await client.stop();
      if (Array.isArray(errs) && errs.length > 0) await client.forceStop();
    } catch (_) { try { await client.forceStop(); } catch (_) {} }
  }
}

// Plan→Candidate runtime 一致性(§3.2):确认计划生成 candidate 时必须同一 runtime,否则 RUNTIME_CHANGED。
export function assertRuntimeConsistency(requiredRuntime, actualRuntime) {
  if (requiredRuntime && requiredRuntime !== actualRuntime) {
    throw copilotError(COPILOT_ERRORS.RUNTIME_CHANGED, "The Copilot runtime that produced the plan is no longer available; please regenerate the plan.");
  }
}
