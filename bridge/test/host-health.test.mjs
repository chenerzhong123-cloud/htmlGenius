// bridge/test/host-health.test.mjs — v0.9 §4.1/§8.1 host bridge_health / bridge_repair 端到端(真实子进程 + native 帧)。
// repair 经 env 注入 tmp hosts-dir(内部测试接口),不碰真实 Chrome 目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMessage, NativeFrameDecoder } from "../native-protocol.mjs";
import { HOST_NAME, LAUNCHER_MARKER } from "../bridge-install.mjs";

const hostPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "host.mjs");
const ID_A = "abcdefghijklmnopabcdefghijklmnop";
const ID_B = "ponmlkjihgfedcbaponmlkjihgfedcba";

// 与 Chrome 一致:保持 stdin 打开(host 在 port 存活期间持续应答;bridge_health 的 provider probe 是异步的,
// 若立即 end stdin,host 会在应答前因 stdin 'end' 退出)。收到 waitFor 帧后主动关闭。
function runHost(inputs, env = {}, waitFor = 1, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const dec = new NativeFrameDecoder();
    const out = [];
    const stderr = [];
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch (_) {}
      try { child.kill(); } catch (_) {}
      resolve({ code, out, stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on("data", (c) => { dec.feed(c); for (const m of dec.messages()) { out.push(m); if (out.length >= waitFor) finish(null); } });
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("error", reject);
    child.on("exit", (code) => finish(code));
    for (const buf of inputs) child.stdin.write(buf);
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hg-host-h-"));

test("bridge_health:回 bridge_health_result;bridge ready + 协议版本 + 三 provider + origin_ok;stdout 单帧", async () => {
  const { out } = await runHost([encodeMessage({ type: "bridge_health", protocol_version: 1, extension: { id: ID_A, version: "0.9.0" } })]);
  assert.equal(out.length, 1, "stdout 只有一帧");
  const r = out[0];
  assert.equal(r.type, "bridge_health_result");
  assert.equal(r.health.schema_version, 1);
  assert.equal(r.health.bridge.status, "ready");
  assert.equal(r.health.bridge.protocol_version, 1);
  assert.equal(r.health.browser.status, "origin_ok");
  assert.equal(r.health.providers.length, 3);
  const ids = r.health.providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ["claude_code_cli", "codex_app_server", "github_copilot"]);
  // 脱敏:health 里不含路径/会话类键
  const json = JSON.stringify(r.health);
  for (const bad of ['"path"', '"stderr"', '"token"', '"session_id"', '"thread_id"']) assert.ok(!json.includes(bad), "不含 " + bad);
});

test("bridge_health:缺 extension.id → browser.status unknown(仍应答)", async () => {
  const { out } = await runHost([encodeMessage({ type: "bridge_health", protocol_version: 1 })]);
  assert.equal(out[0].type, "bridge_health_result");
  assert.equal(out[0].health.browser.status, "unknown");
});

test("bridge_repair:未经确认(confirmed_actions 缺失)→ REPAIR_NOT_CONFIRMED,不写任何文件", async () => {
  const hostsDir = tmp();
  try {
    const { out } = await runHost([encodeMessage({ type: "bridge_repair", protocol_version: 1, extension: { id: ID_A } })], { HTMLGENIUS_HOSTS_DIR: hostsDir });
    assert.equal(out[0].type, "bridge_failed");
    assert.equal(out[0].code, "REPAIR_NOT_CONFIRMED");
    assert.deepEqual(fs.readdirSync(hostsDir), [], "未确认不落任何文件");
  } finally { fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("bridge_repair:确认后只重写自身 launcher+manifest(受控标记 + 单 origin),回 health ready", async () => {
  const hostsDir = tmp();
  try {
    const { out } = await runHost([encodeMessage({
      type: "bridge_repair", protocol_version: 1, extension: { id: ID_A }, confirmed_actions: ["repair_native_host"]
    })], { HTMLGENIUS_HOSTS_DIR: hostsDir });
    assert.equal(out[0].type, "bridge_health_result", "修复后回 health");
    assert.equal(out[0].health.bridge.status, "ready");
    const manifest = JSON.parse(fs.readFileSync(path.join(hostsDir, HOST_NAME + ".json"), "utf8"));
    assert.equal(manifest.name, HOST_NAME);
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://" + ID_A + "/"]);
    const launcher = fs.readFileSync(path.join(hostsDir, HOST_NAME + ".launcher.sh"), "utf8");
    assert.ok(launcher.includes(LAUNCHER_MARKER));
    assert.equal(fs.statSync(path.join(hostsDir, HOST_NAME + ".launcher.sh")).mode & 0o777, 0o700);
  } finally { fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("bridge_repair:已注册其它 extension ID → EXTENSION_ORIGIN_MISMATCH,不覆盖", async () => {
  const hostsDir = tmp();
  try {
    fs.writeFileSync(path.join(hostsDir, HOST_NAME + ".json"), JSON.stringify({
      name: HOST_NAME, path: path.join(hostsDir, HOST_NAME + ".launcher.sh"), type: "stdio",
      allowed_origins: ["chrome-extension://" + ID_A + "/"]
    }, null, 2));
    const { out } = await runHost([encodeMessage({
      type: "bridge_repair", protocol_version: 1, extension: { id: ID_B }, confirmed_actions: ["repair_native_host"]
    })], { HTMLGENIUS_HOSTS_DIR: hostsDir });
    assert.equal(out[0].type, "bridge_failed");
    assert.equal(out[0].code, "EXTENSION_ORIGIN_MISMATCH");
    const manifest = JSON.parse(fs.readFileSync(path.join(hostsDir, HOST_NAME + ".json"), "utf8"));
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://" + ID_A + "/"], "原 origin 未被覆盖");
  } finally { fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("bridge_repair:非法 extension id → INVALID_EXTENSION_ID", async () => {
  const hostsDir = tmp();
  try {
    const { out } = await runHost([encodeMessage({
      type: "bridge_repair", protocol_version: 1, extension: { id: "nope" }, confirmed_actions: ["repair_native_host"]
    })], { HTMLGENIUS_HOSTS_DIR: hostsDir });
    assert.equal(out[0].code, "INVALID_EXTENSION_ID");
  } finally { fs.rmSync(hostsDir, { recursive: true, force: true }); }
});
