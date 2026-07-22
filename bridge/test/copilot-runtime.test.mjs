// bridge/test/copilot-runtime.test.mjs — v0.8.2 §9 Runtime/probe + 安全策略测试。
// 全部用 fake SDK 注入(dynamic import 替身),不走真实账号/网络;CLI 发现用真实 fs + tmpdir。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeSdk, makeMissingSdkLoader } from "./fake-copilot-sdk.mjs";
import {
  COPILOT_PROVIDER, COPILOT_RUNTIMES, RUNTIME_LABELS, COPILOT_ERRORS,
  PLAN_TIMEOUT_MS, CANDIDATE_TIMEOUT_MS,
  discoverLocalCopilotCli, readCopilotCliVersion, probeCopilot,
  buildCopilotClientOptions, createPreToolPolicy, runCopilotSession,
  buildAvailableTools, buildExcludedTools, assertRuntimeConsistency,
  READ_TOOLS, WRITE_TOOLS, DENIED_BUILTIN_TOOLS
} from "../copilot-runtime.mjs";

// —— probe 形状/安全断言辅助 ——
function assertProbeSafety(res, forbiddenStrings = []) {
  assert.equal(res.id, COPILOT_PROVIDER);
  assert.equal(res.label, "GitHub Copilot");
  assert.deepEqual(res.capabilities, ["candidate", "plan"]);
  const json = JSON.stringify(res);
  // §7:输出绝不含路径/token/session/login/stderr 键
  for (const key of ["path", "cliPath", "token", "session", "login", "stderr", "host"]) {
    assert.doesNotMatch(json, new RegExp('"' + key + '"\\s*:'), "probe 输出不应含敏感键: " + key);
  }
  for (const s of forbiddenStrings) assert.ok(!json.includes(s), "probe 输出泄露: " + s);
  if (res.runtime_label) assert.ok(res.runtime_label.length <= 64);
  if (res.version) assert.ok(res.version.length <= 64);
}

const NO_CALLS = ["client.createSession", "session.sendAndWait", "session.on"];

function assertProbeDidNotCreateSession(calls) {
  for (const name of NO_CALLS) {
    assert.ok(!calls.some((c) => c.name === name), "probe 不得调用 " + name);
  }
  // 被禁 API 在 fake 里根本不存在,被调用会直接 TypeError;这里再显式断言记录里没有相关意图
  for (const banned of ["listSessions", "resumeSession", "getLastSessionId", "getEvents", "getForegroundSessionId"]) {
    assert.ok(!calls.some((c) => c.name.includes(banned)), "probe 不得调用 " + banned);
  }
}

// —— probe:SDK managed runtime ——

test("probe: bundled runtime 已登录 → ready + runtime 可见,不建 session,输出无敏感信息", async () => {
  const sdk = makeFakeSdk({ bundled: { auth: { isAuthenticated: true }, status: { version: "1.0.73", protocolVersion: 1 } } });
  const res = await probeCopilot({
    sdkLoader: async () => sdk,
    env: { PATH: "", HOME: "/nonexistent-home" },
    fsImpl: { lstatSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, accessSync: () => {}, constants: fs.constants }
  });
  assert.equal(res.status, "ready");
  assert.equal(res.runtime, COPILOT_RUNTIMES.BUNDLED_SDK_CLI);
  assert.equal(res.runtime_label, RUNTIME_LABELS.bundled_sdk_cli);
  assert.equal(res.version, "1.0.73");
  assertProbeDidNotCreateSession(sdk.__calls);
  assertProbeSafety(res);
});

test("probe: bundled 未登录 → auth_required(runtime 仍上报)", async () => {
  const sdk = makeFakeSdk({ bundled: { auth: { isAuthenticated: false, statusMessage: "Not signed in" } } });
  const res = await probeCopilot({
    sdkLoader: async () => sdk,
    env: { PATH: "", HOME: "/nonexistent-home" },
    fsImpl: { lstatSync: () => { throw new Error("nope"); }, accessSync: () => {}, constants: fs.constants }
  });
  assert.equal(res.status, "auth_required");
  assert.equal(res.runtime, COPILOT_RUNTIMES.BUNDLED_SDK_CLI);
  assertProbeSafety(res);
});

test("probe: SDK 模块缺失且无本地 CLI → not_installed", async () => {
  const res = await probeCopilot({
    sdkLoader: makeMissingSdkLoader(),
    env: { PATH: "", HOME: "/nonexistent-home" },
    fsImpl: { lstatSync: () => { throw new Error("nope"); }, accessSync: () => {}, constants: fs.constants }
  });
  assert.equal(res.status, "not_installed");
  assert.equal(res.runtime, undefined);
  assertProbeSafety(res);
});

// —— probe:本地 CLI 路径 ——

// 构造一个「有本地 copilot CLI」的环境:真实 tmpdir 文件 + fake fs 视图。
function makeLocalCliEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-cli-"));
  const cliPath = path.join(tmp, "copilot");
  fs.writeFileSync(cliPath, "#!/bin/sh\necho copilot 9.9.9\n", { mode: 0o755 });
  const fakeFs = {
    lstatSync: (p) => (p === cliPath ? fs.lstatSync(p) : (() => { throw new Error("ENOENT"); })()),
    accessSync: (p, m) => (p === cliPath ? fs.accessSync(p, m) : (() => { throw new Error("ENOENT"); })()),
    constants: fs.constants
  };
  return { tmp, cliPath, fakeFs };
}

test("probe: 本地 CLI + SDK health 通过 → local_cli ready;路径不出现在输出;只构造一个 client", async () => {
  const { tmp, cliPath, fakeFs } = makeLocalCliEnv();
  try {
    const sdk = makeFakeSdk({ local: { auth: { isAuthenticated: true }, status: { version: "9.9.9", protocolVersion: 1 } } });
    const res = await probeCopilot({
      sdkLoader: async () => sdk,
      execFileImpl: (f, args, opts, cb) => cb(null, "copilot version 9.9.9\n", ""),
      env: { PATH: tmp, HOME: "/nonexistent-home" },
      fsImpl: fakeFs
    });
    assert.equal(res.status, "ready");
    assert.equal(res.runtime, COPILOT_RUNTIMES.LOCAL_CLI);
    assert.equal(res.runtime_label, RUNTIME_LABELS.local_cli);
    // SDK 以 stdio + 该二进制路径连接
    const forStdio = sdk.__calls.filter((c) => c.name === "RuntimeConnection.forStdio");
    assert.equal(forStdio.length, 1);
    assert.equal(forStdio[0].arg.path, cliPath);
    // 只构造了一个 client(本地成功就不再尝试 bundled)
    assert.equal(sdk.__calls.filter((c) => c.name === "client.construct").length, 1);
    assertProbeDidNotCreateSession(sdk.__calls);
    assertProbeSafety(res, [cliPath, tmp]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("probe: 本地 CLI 无法被 SDK 启动(不兼容)→ 自动转 bundled;bundled 成功则 ready bundled_sdk_cli", async () => {
  const { tmp, cliPath, fakeFs } = makeLocalCliEnv();
  try {
    const sdk = makeFakeSdk({
      local: { startError: new Error("protocol version mismatch") },
      bundled: { auth: { isAuthenticated: true }, status: { version: "1.0.73", protocolVersion: 1 } }
    });
    const res = await probeCopilot({
      sdkLoader: async () => sdk,
      execFileImpl: (f, args, opts, cb) => cb(null, "copilot version 0.1.0-ancient\n", ""),
      env: { PATH: tmp, HOME: "/nonexistent-home" },
      fsImpl: fakeFs
    });
    assert.equal(res.status, "ready");
    assert.equal(res.runtime, COPILOT_RUNTIMES.BUNDLED_SDK_CLI);
    // 两次构造:先 local(带 connection)后 bundled(无 connection)
    const constructs = sdk.__calls.filter((c) => c.name === "client.construct");
    assert.equal(constructs.length, 2);
    assert.equal(constructs[0].arg.kind, "local");
    assert.equal(constructs[1].arg.kind, "bundled");
    assertProbeSafety(res, [cliPath]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("probe: 本地不兼容 + bundled 也起不来 → incompatible", async () => {
  const { tmp, fakeFs } = makeLocalCliEnv();
  try {
    const sdk = makeFakeSdk({
      local: { startError: new Error("incompatible") },
      bundled: { startError: new Error("runtime binary missing") }
    });
    const res = await probeCopilot({
      sdkLoader: async () => sdk,
      execFileImpl: (f, args, opts, cb) => cb(null, "v\n", ""),
      env: { PATH: tmp, HOME: "/nonexistent-home" },
      fsImpl: fakeFs
    });
    assert.equal(res.status, "incompatible");
    assertProbeSafety(res);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("probe: 无本地 CLI + bundled 起不来 → not_installed", async () => {
  const sdk = makeFakeSdk({ bundled: { startError: new Error("spawn ENOENT") } });
  const res = await probeCopilot({
    sdkLoader: async () => sdk,
    env: { PATH: "", HOME: "/nonexistent-home" },
    fsImpl: { lstatSync: () => { throw new Error("nope"); }, accessSync: () => {}, constants: fs.constants }
  });
  assert.equal(res.status, "not_installed");
});

test("probe: 意外异常不外抛 → status error(不影响其它 provider 的并发 probe)", async () => {
  const res = await probeCopilot({
    sdkLoader: async () => { throw new Error("boom unexpected"); },
    env: { PATH: "", HOME: "/x" },
    fsImpl: { lstatSync: () => { throw new Error("no"); }, accessSync: () => {}, constants: fs.constants }
  });
  assert.equal(res.status, "error");
});

// —— 本地 CLI 发现 ——

test("discoverLocalCopilotCli: 拒绝 symlink / 目录 / 不可执行;只返回合法普通文件", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-discover-"));
  try {
    const dirA = path.join(tmp, "a"), dirB = path.join(tmp, "b"), dirC = path.join(tmp, "c"), dirD = path.join(tmp, "d");
    fs.mkdirSync(dirA); fs.mkdirSync(dirB); fs.mkdirSync(dirC); fs.mkdirSync(dirD);
    // a: symlink(应拒绝)
    const realBin = path.join(tmp, "real-copilot");
    fs.writeFileSync(realBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(realBin, path.join(dirA, "copilot"));
    // b: 目录(应拒绝)
    fs.mkdirSync(path.join(dirB, "copilot"));
    // c: 不可执行文件(应拒绝)
    fs.writeFileSync(path.join(dirC, "copilot"), "data", { mode: 0o644 });
    // d: 合法可执行普通文件
    const good = path.join(dirD, "copilot");
    fs.writeFileSync(good, "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(discoverLocalCopilotCli({ env: { PATH: [dirA, dirB, dirC, dirD].join(":"), HOME: tmp }, platform: "darwin" }), good);
    // 只有 symlink 时 → null
    assert.equal(discoverLocalCopilotCli({ env: { PATH: dirA, HOME: tmp }, platform: "darwin" }), null);
    // 非 darwin → null
    assert.equal(discoverLocalCopilotCli({ env: { PATH: dirD, HOME: tmp }, platform: "linux" }), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("readCopilotCliVersion: 正常/超长截断/出错/超时 → 字符串 | ≤64 | null", async () => {
  assert.equal(await readCopilotCliVersion("/x/copilot", { execFileImpl: (f, a, o, cb) => cb(null, "copilot version 9.8.7\n", "") }), "copilot version 9.8.7");
  const long = "x".repeat(500);
  const v = await readCopilotCliVersion("/x/copilot", { execFileImpl: (f, a, o, cb) => cb(null, long, "") });
  assert.ok(v.length <= 64);
  assert.equal(await readCopilotCliVersion("/x/copilot", { execFileImpl: (f, a, o, cb) => cb(new Error("spawn failed"), "", "") }), null);
  // 超时:execFile 语义是回调 error(killed);同时验证我们传了 timeout 选项
  let seenOpts = null;
  await readCopilotCliVersion("/x/copilot", { execFileImpl: (f, a, o, cb) => { seenOpts = o; cb(Object.assign(new Error("SIGTERM"), { killed: true }), "", ""); } });
  assert.equal(seenOpts.timeout, 10_000);
});

// —— 客户端配置 ——

test("buildCopilotClientOptions: empty 模式 + workspace cwd + local 带 connection / bundled 不带", () => {
  const sdk = makeFakeSdk();
  const local = buildCopilotClientOptions({ sdk, runtime: COPILOT_RUNTIMES.LOCAL_CLI, cliPath: "/opt/homebrew/bin/copilot", cwd: "/ws/run1", baseDirectory: "/ws/run1/.copilot-home" });
  assert.equal(local.mode, "empty");
  assert.equal(local.workingDirectory, "/ws/run1");
  assert.equal(local.baseDirectory, "/ws/run1/.copilot-home");
  assert.equal(local.connection.kind, "stdio");
  assert.equal(local.connection.path, "/opt/homebrew/bin/copilot");
  const bundled = buildCopilotClientOptions({ sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, cwd: "/ws/run2", baseDirectory: "/ws/run2/.copilot-home" });
  assert.equal(bundled.connection, undefined);
  // local 缺 cliPath → CLI_NOT_FOUND
  assert.throws(() => buildCopilotClientOptions({ sdk, runtime: COPILOT_RUNTIMES.LOCAL_CLI, cliPath: null, cwd: "/w", baseDirectory: "/w/.c" }), (e) => e.code === COPILOT_ERRORS.CLI_NOT_FOUND);
});

test("工具清单:危险工具全部在 excluded,且不在 available;available 只含读写类", () => {
  const avail = buildAvailableTools();
  const excl = buildExcludedTools();
  for (const t of DENIED_BUILTIN_TOOLS) {
    assert.ok(excl.includes("builtin:" + t), "excluded 应含 " + t);
    assert.ok(!avail.includes("builtin:" + t), "available 不得含 " + t);
  }
  for (const t of [...READ_TOOLS, ...WRITE_TOOLS]) assert.ok(avail.includes("builtin:" + t));
  // §5.2 明确点名的必须排除
  for (const must of ["task", "bash", "web_fetch"]) assert.ok(excl.includes("builtin:" + must));
});

// —— pre-tool-use 策略 ——

test("pre-tool 策略:读工具+workspace 内路径 allow;越界/写非输出/危险工具 deny(审计不带路径)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-policy-"));
  try {
    fs.writeFileSync(path.join(tmp, "source.html"), "<html></html>");
    fs.mkdirSync(path.join(tmp, "output"));
    const denials = [];
    const { handler, stats } = createPreToolPolicy({
      workspaceDir: tmp,
      writableFiles: [path.join(tmp, "candidate.html")],
      recordDenial: (toolName, category) => denials.push({ toolName, category })
    });
    // allow
    assert.equal(handler({ toolName: "view", toolArgs: { path: path.join(tmp, "source.html") } }).permissionDecision, "allow");
    assert.equal(handler({ toolName: "view", toolArgs: { path: "source.html" } }).permissionDecision, "allow"); // 相对路径按 workspace 解析
    assert.equal(handler({ toolName: "write", toolArgs: { path: "candidate.html", content: "x" } }).permissionDecision, "allow");
    // deny: 越界读
    assert.equal(handler({ toolName: "view", toolArgs: { path: "../../etc/passwd" } }).permissionDecision, "deny");
    assert.equal(handler({ toolName: "view", toolArgs: { path: "/etc/passwd" } }).permissionDecision, "deny");
    // deny: 写非允许输出
    assert.equal(handler({ toolName: "write", toolArgs: { path: "evil.html" } }).permissionDecision, "deny");
    assert.equal(handler({ toolName: "edit", toolArgs: { path: "source.html" } }).permissionDecision, "deny"); // source 只读
    // deny: 危险工具
    for (const t of ["bash", "read_bash", "shell", "web_fetch", "task", "read_agent", "exit_plan_mode", "ask_user", "skill"]) {
      assert.equal(handler({ toolName: t, toolArgs: {} }).permissionDecision, "deny", t + " 应 deny");
    }
    // deny: 写工具无可识别路径参数
    assert.equal(handler({ toolName: "write", toolArgs: { content: "x" } }).permissionDecision, "deny");
    // 审计事件:只有工具名+类别,不含 workspace 路径
    assert.ok(stats.denials >= 8);
    const auditJson = JSON.stringify(denials);
    assert.ok(!auditJson.includes(tmp), "审计事件不得含路径");
    assert.ok(denials.every((d) => d.toolName && d.category));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("pre-tool 策略:符号链接逃逸 workspace → deny", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-symlink-"));
  try {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-outside-"));
    fs.writeFileSync(path.join(outside, "secret.html"), "s");
    fs.symlinkSync(outside, path.join(tmp, "escape"));
    const { handler } = createPreToolPolicy({ workspaceDir: tmp, writableFiles: [] });
    assert.equal(handler({ toolName: "view", toolArgs: { path: path.join(tmp, "escape", "secret.html") } }).permissionDecision, "deny");
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// —— 受控 session 执行 ——

test("runCopilotSession: 成功路径 — createSession 带 allowlist+hooks,sendAndWait 带超时,事后 disconnect+stop", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-run-"));
  try {
    const events = [];
    const sdk = makeFakeSdk({
      session: {
        writer: ({ cwd, emit }) => {
          emit({ type: "tool.execution_start", data: { toolName: "write" } });
          fs.writeFileSync(path.join(cwd, "candidate.html"), "<html>new</html>");
        }
      }
    });
    const r = await runCopilotSession({
      sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null,
      cwd: tmp, baseDirectory: path.join(tmp, ".copilot-home"),
      prompt: "make the candidate", timeoutMs: CANDIDATE_TIMEOUT_MS,
      writableFiles: [path.join(tmp, "candidate.html")], runKind: "candidate",
      onEvent: (e) => events.push(e)
    });
    assert.equal(r.denialCount, 0);
    const cs = sdk.__calls.find((c) => c.name === "client.createSession");
    assert.ok(cs, "应 createSession");
    assert.ok(cs.arg.config.availableTools.includes("builtin:write"));
    assert.ok(cs.arg.config.excludedTools.includes("builtin:bash"));
    assert.equal(typeof cs.arg.config.hooks.onPreToolUse, "function");
    assert.equal(cs.arg.config.clientName, "htmlgenius-bridge");
    const sw = sdk.__calls.find((c) => c.name === "session.sendAndWait");
    assert.equal(sw.arg.prompt, "make the candidate");
    assert.equal(sw.arg.timeoutMs, CANDIDATE_TIMEOUT_MS);
    // 清理由齐:disconnect + stop
    assert.ok(sdk.__calls.some((c) => c.name === "session.disconnect"));
    assert.ok(sdk.__calls.some((c) => c.name === "client.stop"));
    // 事件脱敏:有工具名,无 prompt 以外的泄露
    assert.ok(events.some((e) => e.kind === "tool" && e.name === "write"));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("runCopilotSession: 超时 → abort + disconnect + stop,抛 COPILOT_TIMEOUT;plan kind → COPILOT_PLAN_TIMEOUT", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-to-"));
  try {
    const sdk = makeFakeSdk({ session: { sendAndWaitError: new Error("Timed out waiting for session idle") } });
    await assert.rejects(() => runCopilotSession({
      sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, cwd: tmp, baseDirectory: tmp,
      prompt: "p", timeoutMs: PLAN_TIMEOUT_MS, writableFiles: [], runKind: "plan"
    }), (e) => e.code === COPILOT_ERRORS.PLAN_TIMEOUT);
    assert.ok(sdk.__calls.some((c) => c.name === "session.abort"), "超时应先 abort");
    assert.ok(sdk.__calls.some((c) => c.name === "session.disconnect"));
    assert.ok(sdk.__calls.some((c) => c.name === "client.stop"));

    const sdk2 = makeFakeSdk({ session: { sendAndWaitError: new Error("Timed out") } });
    await assert.rejects(() => runCopilotSession({
      sdk: sdk2, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, cwd: tmp, baseDirectory: tmp,
      prompt: "p", timeoutMs: CANDIDATE_TIMEOUT_MS, writableFiles: [], runKind: "candidate"
    }), (e) => e.code === COPILOT_ERRORS.TIMEOUT);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("runCopilotSession: 其它失败 → COPILOT_RUN_FAILED,消息不含路径;清理仍执行", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-fail-"));
  try {
    const secret = "/Users/someone/very/private/path";
    const sdk = makeFakeSdk({ session: { sendAndWaitError: new Error("model error at " + secret) } });
    let caught = null;
    try {
      await runCopilotSession({
        sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, cwd: tmp, baseDirectory: tmp,
        prompt: "p", timeoutMs: CANDIDATE_TIMEOUT_MS, writableFiles: [], runKind: "candidate"
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, COPILOT_ERRORS.RUN_FAILED);
    assert.ok(!caught.message.includes(secret), "错误消息不得泄露路径");
    assert.ok(sdk.__calls.some((c) => c.name === "session.disconnect"));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("assertRuntimeConsistency: plan 与 candidate runtime 不一致 → COPILOT_RUNTIME_CHANGED", () => {
  assert.throws(() => assertRuntimeConsistency(COPILOT_RUNTIMES.LOCAL_CLI, COPILOT_RUNTIMES.BUNDLED_SDK_CLI), (e) => e.code === COPILOT_ERRORS.RUNTIME_CHANGED);
  assertRuntimeConsistency(COPILOT_RUNTIMES.LOCAL_CLI, COPILOT_RUNTIMES.LOCAL_CLI); // 不抛
  assertRuntimeConsistency(null, COPILOT_RUNTIMES.BUNDLED_SDK_CLI); // 无约束不抛
});
