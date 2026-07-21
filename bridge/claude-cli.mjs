// bridge/claude-cli.mjs — Claude Code CLI adapter(v0.7.1,spec §2/§4/§7)。
// 只用官方 CLI(claude -p / --resume / --output-format json / auth status),不引入 Claude API / Agent SDK:
// 产品边界是「复用用户本机已登录的 Claude Code」,不读取/保存任何 API key、token、Cookie。
//
// 【Claude 子进程硬约束(spec §4)】
// - 只允许 spawn("claude", argv, { cwd: workspace, shell: false });
// - extension 传来的任何内容(comment/brief/path/hash/session id)绝不能成为 command、flag、cwd 或 env;
//   生成的 prompt 只作为 argv 的【最后一个元素】传入(spawn 直传进程参数,无 shell 解释,引号/换行/;/$()
//   都只是普通字符串,不构成注入);
// - 固定 argv:只读工具白名单 + 禁写/网/MCP + --permission-mode dontAsk + --safe-mode。
//   spec §4 原列的 --no-chrome 在当前官方 cli-reference 中不存在,按「可按检测到的 CLI 版本做最小兼容
//   调整,但不得放宽安全语义」条款去掉;安全语义(禁写/禁网/禁 MCP/禁插件 hooks)不变。
import { spawn } from "node:child_process";

export const CLAUDE_BIN = "claude";
export const HANDOFF_TIMEOUT_MS = 3 * 60 * 1000;  // 3 分钟(spec §9.4)
export const AUTH_TIMEOUT_MS = 30 * 1000;
export const MAX_STDERR_BYTES = 8 * 1024;         // stderr 截断 8 KiB(spec §9.4)
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;         // stdout(result JSON)防御上限

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSessionUuid(s) { return typeof s === "string" && UUID_RE.test(String(s).trim()); }

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}
function truncate(s) {
  const t = String(s || "");
  return t.length > 400 ? t.slice(0, 400) + "…" : t;
}

// 最小环境变量白名单:claude 需要 HOME(~/.claude 登录态)与 PATH(找到 claude/node);
// 其余一律不透传 —— extension 的内容永远进不了子进程 env。
function sanitizedEnv() {
  const keep = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"];
  const env = {};
  for (const k of keep) { if (process.env[k] != null) env[k] = process.env[k]; }
  return env;
}

// —— argv 构造(纯函数,可单测断言「固定 argv」)——
// prompt 永远是 argv 最后一个元素;resumeSessionId 只接受校验过的 UUID。
// runKind: "handoff"(只读回执,v0.7.1) | "candidate"(Night Pack A:放行 Write 写 candidate.html)
//        | "plan"(v0.8.1:放行 Write 写 output/plan.json;§6.5 同 candidate 工具集,禁 Bash/Edit/网/MCP)。
export function buildClaudeArgv({ promptText, resumeSessionId, runKind }) {
  if (typeof promptText !== "string" || !promptText.length) {
    fail("BAD_PROMPT", "promptText is required");
  }
  const canWrite = runKind === "candidate" || runKind === "plan";
  const allowed = canWrite ? "Read,Glob,Grep,Write" : "Read,Glob,Grep";            // candidate/plan 放行 Write(只写约定输出文件)
  const disallowed = canWrite
    ? ["Bash", "Edit", "WebFetch", "WebSearch", "mcp__*"]                           // candidate/plan 禁 in-place Edit/网/MCP
    : ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "mcp__*"];                 // handoff 全只读
  const maxTurns = runKind === "candidate" ? "24" : runKind === "plan" ? "16" : "4"; // candidate 编辑多轮;plan 写 JSON 中等;handoff 回执少轮
  const argv = [
    "-p",
    "--output-format", "json",
    "--safe-mode",                    // 禁用户自定义 hooks/plugins/MCP/skills/本地项目定制
    "--disable-slash-commands",       // 禁 skills 与 slash commands
    "--allowed-tools", allowed,
    "--disallowed-tools", ...disallowed,
    "--permission-mode", "dontAsk",   // 非交互:不弹权限询问
    "--max-turns", maxTurns
  ];
  if (resumeSessionId != null) {
    if (!isSessionUuid(resumeSessionId)) fail("CLAUDE_SESSION_UNAVAILABLE", "resume session_id is not a valid UUID");
    argv.push("--resume", String(resumeSessionId).trim());
  }
  argv.push(promptText); // 唯一允许携带任务内容的参数位;spawn 直传,不经 shell
  return argv;
}
// 向后兼容:v0.7.1 handoff 路径沿用旧名
export function buildHandoffArgv({ promptText, resumeSessionId }) {
  return buildClaudeArgv({ promptText, resumeSessionId, runKind: "handoff" });
}

// —— 底层 spawn:shell:false + 超时 + stderr 截断 + stdout 防御上限 ——
function runClaude(argv, { cwd, timeoutMs } = {}) {
  if (typeof cwd !== "string" || !cwd.length) fail("BAD_CWD", "cwd is required");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, argv, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv(),
        windowsHide: true
      });
    } catch (e) {
      const err = new Error("failed to spawn claude: " + (e && e.message));
      err.code = (e && e.code === "ENOENT") ? "CLAUDE_NOT_INSTALLED" : "CLAUDE_SPAWN_FAILED";
      return reject(err);
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (_) {}
      const err = new Error("claude timed out after " + (timeoutMs || HANDOFF_TIMEOUT_MS) + "ms");
      err.code = "CLAUDE_TIMEOUT";
      reject(err);
    }, timeoutMs || HANDOFF_TIMEOUT_MS);

    child.stdout.on("data", (c) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout = Buffer.concat([stdout, c]);
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = Buffer.concat([stderr, c.subarray(0, Math.max(0, MAX_STDERR_BYTES - stderr.length))]);
      }
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const err = new Error("claude process error: " + (e && e.message));
      err.code = (e && e.code === "ENOENT") ? "CLAUDE_NOT_INSTALLED" : "CLAUDE_SPAWN_FAILED";
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

// —— auth 检查(spec §7 步骤5):claude auth status,exit≠0 → CLAUDE_NOT_LOGGED_IN ——
export async function checkAuth({ cwd, timeoutMs } = {}) {
  let r;
  try {
    r = await runClaude(["auth", "status"], { cwd: cwd || process.cwd(), timeoutMs: timeoutMs || AUTH_TIMEOUT_MS });
  } catch (e) {
    if (e && e.code === "CLAUDE_NOT_INSTALLED") throw e;
    fail("CLAUDE_NOT_LOGGED_IN", "claude auth status failed: " + (e && e.message));
  }
  if (r.code !== 0) {
    fail("CLAUDE_NOT_LOGGED_IN", "claude auth status exited " + r.code + ": " + truncate(r.stderr));
  }
  return true;
}

// —— result JSON 解析:`claude -p --output-format json` 输出单个 result 对象,取 session_id(UUID)——
export function parseHandoffResult(stdout) {
  const text = String(stdout || "").trim();
  if (!text) fail("CLAUDE_INVALID_RESULT", "claude produced empty stdout");
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { fail("CLAUDE_INVALID_RESULT", "claude stdout is not valid JSON"); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    fail("CLAUDE_INVALID_RESULT", "claude result is not a JSON object");
  }
  const sid = obj.session_id || (obj.result && typeof obj.result === "object" && obj.result.session_id) || null;
  if (!isSessionUuid(sid)) {
    fail("CLAUDE_INVALID_RESULT", "claude result missing a valid session_id UUID");
  }
  return { sessionId: String(sid).trim(), isError: obj.is_error === true };
}

// —— new handoff(spec §7 步骤6)——
export async function runHandoff({ cwd, promptText, timeoutMs, runKind }) {
  const argv = buildClaudeArgv({ promptText, runKind });
  const { code, stdout, stderr } = await runClaude(argv, { cwd, timeoutMs });
  if (code !== 0) {
    fail("CLAUDE_RUN_FAILED", "claude exited " + code + ": " + truncate(stderr), { exitCode: code });
  }
  return parseHandoffResult(stdout);
}

// —— continue handoff(spec §7 步骤7):只允许 --resume <已保存 UUID>;cwd 必须是该 session 的
// workspace(调用方保证)。不支持/找不到 session → CLAUDE_SESSION_UNAVAILABLE;绝不回退 -c 或 picker。——
export async function resumeHandoff({ cwd, promptText, resumeSessionId, timeoutMs, runKind }) {
  const argv = buildClaudeArgv({ promptText, resumeSessionId, runKind });
  let r;
  try {
    r = await runClaude(argv, { cwd, timeoutMs });
  } catch (e) {
    // timeout/not-installed 保持原 code 上抛,其余归为 session 不可用
    if (e && (e.code === "CLAUDE_TIMEOUT" || e.code === "CLAUDE_NOT_INSTALLED")) throw e;
    fail("CLAUDE_SESSION_UNAVAILABLE", "claude --resume failed: " + (e && e.message));
  }
  if (r.code !== 0) {
    fail("CLAUDE_SESSION_UNAVAILABLE", "claude --resume exited " + r.code + ": " + truncate(r.stderr), { exitCode: r.code });
  }
  return parseHandoffResult(r.stdout);
}
