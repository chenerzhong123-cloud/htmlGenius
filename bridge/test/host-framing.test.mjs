// bridge/test/host-framing.test.mjs — host.mjs 帧收发端到端(真实子进程;§10 Step1 验证 Chrome 帧)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMessage, NativeFrameDecoder } from "../native-protocol.mjs";

const hostPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "host.mjs");

function runHost(inputs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"] });
    const dec = new NativeFrameDecoder();
    const out = [];
    child.stdout.on("data", (c) => { dec.feed(c); for (const m of dec.messages()) out.push(m); });
    const stderr = [];
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out, stderr: Buffer.concat(stderr).toString("utf8") }));
    for (const buf of inputs) child.stdin.write(buf);
    child.stdin.end();
  });
}

test("host: ping -> pong(真实 native 帧往返)", async () => {
  const { code, out } = await runHost([encodeMessage({ type: "ping" })]);
  assert.equal(code, 0);
  assert.deepEqual(out, [{ type: "pong" }]);
});

test("host: 未知消息 -> bridge_failed(unknown_message),不崩溃", async () => {
  const { out } = await runHost([encodeMessage({ type: "totally_unknown" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "bridge_failed");
  assert.equal(out[0].code, "unknown_message");
});

test("host: stdout 不混入日志(stderr 才有 host started)", async () => {
  const { out, stderr } = await runHost([encodeMessage({ type: "ping" })]);
  assert.deepEqual(out, [{ type: "pong" }], "stdout 只有 native 帧");
  assert.match(stderr, /host started/, "日志在 stderr");
});
