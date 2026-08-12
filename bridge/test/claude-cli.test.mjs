// bridge/test/claude-cli.test.mjs — claude-cli adapter 测试(spec §11.3/11.4/11.5/11.6)。
// 真实 spawn 测试用 test/fake-claude-bin/claude(临时加到 PATH 最前),验证真实子进程路径与 argv 注入安全。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHandoffArgv, buildClaudeArgv, isSessionUuid, parseHandoffResult, parsePatchResult, parseStreamLine,
  checkAuth, runHandoff, resumeHandoff, classifyClaudeFailure
} from "../claude-cli.mjs";

const FAKE_BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-claude-bin");
const TMP_BASE = process.env.TMPDIR || os.tmpdir();
const modeFile = path.join(TMP_BASE, "fake-claude.mode." + process.pid);
const argvLog = path.join(TMP_BASE, "fake-claude.argv." + process.pid);

function setFakeMode(mode) { fs.writeFileSync(modeFile, mode); }
function readArgvCalls() {
  // 日志格式:每次调用 = 若干 NUL 结尾的 argv 元素 + "END\0" 收尾
  if (!fs.existsSync(argvLog)) return [];
  const parts = fs.readFileSync(argvLog).toString("utf8").split("\0"); // NUL 不出现在 UTF-8 多字节序列中
  const calls = [];
  let cur = [];
  for (const p of parts) {
    if (p === "END") { if (cur.length) calls.push(cur); cur = []; }
    else if (p.length || cur.length) cur.push(p);
  }
  if (cur.length) calls.push(cur);
  return calls;
}
function resetFake() {
  try { fs.unlinkSync(argvLog); } catch (_) {}
  setFakeMode("ok");
}

// —— 固定 argv 断言(纯函数层)——
test("buildHandoffArgv:固定安全 argv,prompt 是最后一个元素", () => {
  const argv = buildHandoffArgv({ promptText: "PROMPT_HERE" });
  assert.equal(argv[0], "-p");
  assert.ok(argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json");
  assert.ok(argv.includes("--safe-mode"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.ok(argv.includes("--allowed-tools") && argv[argv.indexOf("--allowed-tools") + 1] === "Read,Glob,Grep");
  const di = argv.indexOf("--disallowed-tools");
  for (const banned of ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "mcp__*"]) {
    assert.ok(argv.slice(di + 1).includes(banned), "disallowed 含 " + banned);
  }
  assert.ok(argv.includes("--permission-mode") && argv[argv.indexOf("--permission-mode") + 1] === "dontAsk");
  assert.equal(argv[argv.length - 1], "PROMPT_HERE", "prompt 必须是最后一个 argv 元素");
  // 没有 --dangerously-skip-permissions / bypassPermissions / --add-dir
  assert.ok(!argv.some((a) => /dangerously|bypassPermissions|--add-dir/.test(a)));
});

test("buildHandoffArgv:resume 只接受合法 UUID,否则拒绝(绝不回退 -c/picker)", () => {
  const argv = buildHandoffArgv({ promptText: "P", resumeSessionId: "11111111-2222-3333-4444-555555555555" });
  const ri = argv.indexOf("--resume");
  assert.ok(ri > 0 && argv[ri + 1] === "11111111-2222-3333-4444-555555555555");
  assert.equal(argv[argv.length - 1], "P");
  // null = 不 resume(new 模式),合法;其余非法值必须拒绝
  for (const bad of ["latest", "../x", "", "1234", "-c"]) {
    assert.throws(() => buildHandoffArgv({ promptText: "P", resumeSessionId: bad }),
      (e) => e.code === "CLAUDE_SESSION_UNAVAILABLE");
  }
  assert.throws(() => buildHandoffArgv({ promptText: "" }), (e) => e.code === "BAD_PROMPT");
});

test("isSessionUuid / parseHandoffResult 校验", () => {
  assert.ok(isSessionUuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
  assert.ok(!isSessionUuid("nope") && !isSessionUuid(null) && !isSessionUuid("123"));
  const r = parseHandoffResult('{"type":"result","session_id":"11111111-2222-3333-4444-555555555555"}');
  assert.equal(r.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.throws(() => parseHandoffResult(""), (e) => e.code === "CLAUDE_INVALID_RESULT");
  assert.throws(() => parseHandoffResult("not json"), (e) => e.code === "CLAUDE_INVALID_RESULT");
  assert.throws(() => parseHandoffResult('{"session_id":"bad"}'), (e) => e.code === "CLAUDE_INVALID_RESULT");
  assert.throws(() => parseHandoffResult('[1,2]'), (e) => e.code === "CLAUDE_INVALID_RESULT");
});

test("buildClaudeArgv(patch):只读工具(禁 Write)+ maxTurns 12,prompt 末元素", () => {
  const argv = buildClaudeArgv({ promptText: "PATCH_PROMPT", runKind: "patch" });
  assert.equal(argv[argv.indexOf("--allowed-tools") + 1], "Read,Glob,Grep", "patch 不放行 Write");
  const di = argv.indexOf("--disallowed-tools");
  assert.ok(argv.slice(di + 1).includes("Write"), "patch disallowed 含 Write");
  // 12(原 8 太紧:「无需修改」判定实测也耗 6+ 轮,耗尽 → exit 1 error_max_turns → 任务失败)
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "12");
  assert.equal(argv[argv.length - 1], "PATCH_PROMPT");
});

test("parsePatchResult:取 session_id + result 文本;缺 result/坏 session 抛 CLAUDE_INVALID_RESULT", () => {
  const ok = parsePatchResult('{"type":"result","session_id":"11111111-2222-3333-4444-555555555555","result":"{\\"schema_version\\":1,\\"edits\\":[]}","is_error":false}');
  assert.equal(ok.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(ok.resultText, '{"schema_version":1,"edits":[]}');
  assert.equal(ok.isError, false);
  assert.throws(() => parsePatchResult('{"session_id":"11111111-2222-3333-4444-555555555555"}'), (e) => e.code === "CLAUDE_INVALID_RESULT"); // 无 result 文本
  assert.throws(() => parsePatchResult('{"session_id":"bad","result":"x"}'), (e) => e.code === "CLAUDE_INVALID_RESULT");
  assert.throws(() => parsePatchResult("not json"), (e) => e.code === "CLAUDE_INVALID_RESULT");
});

test("classifyClaudeFailure:exit 0 → null;error_max_turns → CLAUDE_MAX_TURNS;其余非 0 → CLAUDE_RUN_FAILED(带可读细节)", () => {
  assert.equal(classifyClaudeFailure({ code: 0, stdout: "{}", stderr: "" }), null);
  // 真实形态(实测复现):exit 1 + stdout is_error/subtype,stderr 为空
  const mt = classifyClaudeFailure({
    code: 1, stdout: '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":9,"result":null}', stderr: ""
  });
  assert.equal(mt.code, "CLAUDE_MAX_TURNS");
  assert.ok(mt.message.length > 10, "CLAUDE_MAX_TURNS 消息必须对用户可读,非空错误");
  // 普通失败:stderr 有内容 → 消息带 stderr
  const rf = classifyClaudeFailure({ code: 3, stdout: "", stderr: "claude: simulated failure" });
  assert.equal(rf.code, "CLAUDE_RUN_FAILED");
  assert.ok(rf.message.includes("simulated failure"), "细节优先取 stderr");
  // 普通失败:stderr 为空 → 回退 stdout 摘录,绝不产出「claude exited 1: 」这种空消息
  const rf2 = classifyClaudeFailure({ code: 1, stdout: "weird non-json output", stderr: "" });
  assert.equal(rf2.code, "CLAUDE_RUN_FAILED");
  assert.ok(rf2.message.includes("weird non-json output"), "stderr 为空时回退 stdout 摘录");
  const rf3 = classifyClaudeFailure({ code: 1, stdout: "", stderr: "" });
  assert.equal(rf3.code, "CLAUDE_RUN_FAILED");
  assert.ok(rf3.message.includes("(no stderr/stdout)"), "两者皆空也要有占位,不留空消息");
});

// —— 真实 spawn 测试(fake claude 可执行文件)——
test("spawn: new run 成功 → session UUID;argv 含 -p --output-format json", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  resetFake();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws-"));
  const r = await runHandoff({ cwd, promptText: "ack this task" });
  assert.equal(r.sessionId, "11111111-2222-3333-4444-555555555555");
  const call = readArgvCalls().find((a) => a[0] === "-p");
  assert.ok(call, "fake claude 收到 -p 调用");
  assert.ok(call.includes("--output-format") && call.includes("json"));
  assert.equal(call[call.length - 1], "ack this task");
});

test("spawn: continue 用 --resume <uuid>(同一 cwd 由调用方保证)", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  resetFake();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws2-"));
  const uuid = "99999999-8888-7777-6666-555555555555";
  const r = await resumeHandoff({ cwd, promptText: "follow up", resumeSessionId: uuid });
  assert.equal(r.sessionId, "11111111-2222-3333-4444-555555555555");
  const call = readArgvCalls().find((a) => a[0] === "-p");
  const ri = call.indexOf("--resume");
  assert.ok(ri > 0 && call[ri + 1] === uuid, "--resume 后只跟保存的 UUID");
  assert.ok(!call.includes("-c"), "绝不使用 -c");
});

test("spawn: argv 注入安全 —— 引号/换行/;/\\$() 只是单个 argv 元素,不被 shell 解释", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  resetFake();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws3-"));
  const injection = 'task"; rm -rf /tmp/pwned; echo "$(whoami)" `\nid`\nmore';
  await runHandoff({ cwd, promptText: injection });
  const call = readArgvCalls().find((a) => a[0] === "-p");
  assert.equal(call[call.length - 1], injection, "注入串原样作为【一个】argv 元素");
  // 注入串没有把 argv 拆成更多元素(元素总数与良性 prompt 一致)
  setFakeMode("ok");
  try { fs.unlinkSync(argvLog); } catch (_) {}
  await runHandoff({ cwd, promptText: "benign prompt" });
  const call2 = readArgvCalls().find((a) => a[0] === "-p");
  assert.equal(call.length, call2.length, "注入不改变 argv 元素数量");
  assert.ok(!fs.existsSync("/tmp/pwned"));
});

test("spawn: auth 失败 → CLAUDE_NOT_LOGGED_IN", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  resetFake();
  setFakeMode("auth-fail");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws4-"));
  await assert.rejects(() => checkAuth({ cwd }), (e) => e.code === "CLAUDE_NOT_LOGGED_IN");
});

test("spawn: stdout 非 JSON / 无 UUID → CLAUDE_INVALID_RESULT(不写 session)", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws5-"));
  setFakeMode("bad-json");
  await assert.rejects(() => runHandoff({ cwd, promptText: "p" }), (e) => e.code === "CLAUDE_INVALID_RESULT");
  setFakeMode("no-uuid");
  await assert.rejects(() => runHandoff({ cwd, promptText: "p" }), (e) => e.code === "CLAUDE_INVALID_RESULT");
});

test("spawn: 非 0 退出 → CLAUDE_RUN_FAILED;resume 非 0 → CLAUDE_SESSION_UNAVAILABLE", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws6-"));
  setFakeMode("fail");
  await assert.rejects(() => runHandoff({ cwd, promptText: "p" }), (e) => e.code === "CLAUDE_RUN_FAILED");
  await assert.rejects(() => resumeHandoff({ cwd, promptText: "p", resumeSessionId: "11111111-2222-3333-4444-555555555555" }),
    (e) => e.code === "CLAUDE_SESSION_UNAVAILABLE");
});

test("spawn: 轮次耗尽(exit 1 + error_max_turns JSON)→ CLAUDE_MAX_TURNS(不再报空消息的 CLAUDE_RUN_FAILED)", async () => {
  // 回归:14:22 真实失败 —— Claude 耗尽 max-turns 时 CLI exit 1、stderr 为空、stdout 是 error_max_turns result;
  // 旧逻辑只报「claude exited 1: 」,用户无法排障。
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws6b-"));
  setFakeMode("max-turns");
  await assert.rejects(() => runHandoff({ cwd, promptText: "p" }), (e) => e.code === "CLAUDE_MAX_TURNS" && e.message.length > 10);
});

test("spawn: timeout → CLAUDE_TIMEOUT(fake sleep 30s,超时 500ms)", async () => {
  process.env.PATH = FAKE_BIN_DIR + path.delimiter + process.env.PATH;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws7-"));
  setFakeMode("slow");
  await assert.rejects(() => runHandoff({ cwd, promptText: "p", timeoutMs: 500 }), (e) => e.code === "CLAUDE_TIMEOUT");
});

test("spawn: claude 不在 PATH → CLAUDE_NOT_INSTALLED", async () => {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-empty-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin; // 只剩空目录(which/sh 等用绝对路径不受影响;spawn 找不到 claude)
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cli-ws8-"));
    await assert.rejects(() => runHandoff({ cwd, promptText: "p" }), (e) => e.code === "CLAUDE_NOT_INSTALLED");
  } finally {
    process.env.PATH = savedPath;
  }
});


// === Claude Code 流式(stream-json)===

test("buildClaudeArgv(stream):output-format=stream-json + 带 --verbose", () => {
  const argv = buildClaudeArgv({ promptText: "P", runKind: "candidate", stream: true });
  assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  assert.ok(argv.includes("--verbose"));
});

test("buildClaudeArgv(默认非流式):仍是 json、无 verbose", () => {
  const argv = buildClaudeArgv({ promptText: "P", runKind: "candidate" });
  assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
  assert.ok(!argv.includes("--verbose"));
});

test("parseStreamLine:assistant 文本→delta、tool_use→command、tool_result→info;result→返回 obj", () => {
  const out = [];
  const onStream = (ev) => out.push(ev);
  // assistant:文本 + 工具调用
  assert.equal(parseStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Read" }] } }), onStream), null);
  assert.deepEqual(out.shift(), { kind: "delta", text: "hi" });
  assert.deepEqual(out.shift(), { kind: "command", text: "🔧 Read", starting: true });
  // tool_result → info(截断)
  parseStreamLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "FILE_CONTENTS" }] } }), onStream);
  assert.deepEqual(out.shift(), { kind: "info", text: "↩ FILE_CONTENTS" });
  // result → 返回该 obj(用于取 session_id)
  const resObj = { type: "result", session_id: "12345678-1234-1234-1234-123456789012", is_error: false };
  assert.deepEqual(parseStreamLine(JSON.stringify(resObj), onStream), resObj);
  // 非 JSON / 非 result → null
  assert.equal(parseStreamLine("not-json", onStream), null);
});
