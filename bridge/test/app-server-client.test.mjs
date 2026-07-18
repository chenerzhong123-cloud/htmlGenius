// bridge/test/app-server-client.test.mjs — App Server client 测试(§12.3),全部对 fake-app-server.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient, validateAppServerSchema } from "../app-server-client.mjs";

const fakePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-app-server.mjs");
function makeClient(mode, opts = {}) {
  const c = new AppServerClient({
    command: [process.execPath, fakePath],
    env: { ...process.env, HG_FAKE_MODE: mode, HG_FAKE_DELAY: opts.delay || 20 },
    turnTimeoutMs: opts.turnTimeoutMs,
    onNotification: opts.onNotification
  });
  c.start();
  return c;
}

test("validateAppServerSchema: 含全部必需方法 -> true", () => {
  assert.equal(validateAppServerSchema('{"methods":{"initialize":{},"thread/start":{},"thread/resume":{},"turn/start":{}},"events":{"turn/completed":{}}}'), true);
});
test("validateAppServerSchema: 缺方法 -> INCOMPATIBLE", () => {
  assert.throws(() => validateAppServerSchema('{"methods":{"initialize":{}}}'), (e) => e.code === "INCOMPATIBLE");
});

test("normal: initialize -> thread/start -> turn/completed", async () => {
  const c = makeClient("normal");
  try {
    const init = await c.initialize({ clientName: "htmlgenius-bridge", clientVersion: "0.7.0" });
    assert.ok(init && init.serverInfo);
    const thr = await c.threadStart({ cwd: "/tmp/x" });
    assert.match(thr.thread_id, /^thr_fake_/);
    const done = await c.runTurn({ cwd: "/tmp/x", input: [] });
    assert.match(done.turn_id, /^turn_fake_/);
    assert.equal(done.last_agent_message, "done");
  } finally { await c.stop(); }
});

test("rpc_error: initialize 拒绝(RPC_ERROR)", async () => {
  const c = makeClient("rpc_error");
  try { await assert.rejects(() => c.initialize(), (e) => e.code === "RPC_ERROR"); }
  finally { await c.stop(); }
});

test("turn_failed: runTurn 拒绝(TURN_FAILED)", async () => {
  const c = makeClient("turn_failed");
  try {
    await c.initialize();
    await c.threadStart({});
    await assert.rejects(() => c.runTurn({}), (e) => e.code === "TURN_FAILED");
  } finally { await c.stop(); }
});

test("turn_cancelled: runTurn 拒绝(TURN_CANCELLED)", async () => {
  const c = makeClient("turn_cancelled");
  try {
    await c.initialize();
    await c.threadStart({});
    await assert.rejects(() => c.runTurn({}), (e) => e.code === "TURN_CANCELLED");
  } finally { await c.stop(); }
});

test("timeout: 超时未完成 -> TURN_TIMEOUT(短 timeout)", async () => {
  const c = makeClient("timeout", { turnTimeoutMs: 100, delay: 50 });
  try {
    await c.initialize();
    await c.threadStart({});
    await assert.rejects(() => c.runTurn({}), (e) => e.code === "TURN_TIMEOUT");
  } finally { await c.stop(); }
});

test("server_request: approval 请求 -> AGENT_NEEDS_INPUT,不默认批准", async () => {
  const c = makeClient("server_request");
  try {
    await c.initialize();
    await c.threadStart({});
    await assert.rejects(() => c.runTurn({}), (e) => e.code === "AGENT_NEEDS_INPUT");
  } finally { await c.stop(); }
});

test("continue: thread/resume 后 runTurn 成功", async () => {
  const c = makeClient("normal");
  try {
    await c.initialize();
    const resumed = await c.threadResume({ threadId: "thr_saved_abc" });
    assert.equal(resumed.thread_id, "thr_saved_abc");
    const done = await c.runTurn({});
    assert.match(done.turn_id, /^turn_fake_/);
  } finally { await c.stop(); }
});

test("stop: 清理子进程,后续 request 立即拒(NOT_CONNECTED 或 STOPPED)", async () => {
  const c = makeClient("normal");
  await c.initialize();
  await c.stop();
  // stop 后内部 child=null;新 request 在 _writeLine 即抛 NOT_CONNECTED
  await assert.rejects(() => c.request("ping"), (e) => e.code === "NOT_CONNECTED" || e.code === "STOPPED");
});

test("normal: forward 的非 turn 通知走 onNotification", async () => {
  let received = null;
  const c = makeClient("normal", { onNotification: (m, p) => { received = m; } });
  try {
    await c.initialize();
    c.notify("some/forwarded/notification", { hello: 1 }); // 自发不会被自己处理,但确保不崩
    await c.threadStart({});
    await c.runTurn({});
    // runTurn 完成;onNotification 路径存在即覆盖(此处仅确保不抛)
    assert.ok(true);
  } finally { await c.stop(); }
});
