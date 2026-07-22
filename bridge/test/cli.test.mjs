// bridge/test/cli.test.mjs — v0.9 §8.1 CLI 自动测试:真实 spawn bin/htmlgenius-bridge.mjs,
// 全部用 env 注入 tmp home/hosts-dir(内部测试接口),不碰真实 Chrome 目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_NAME, LAUNCHER_MARKER } from "../bridge-install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "bin", "htmlgenius-bridge.mjs");
const ID_A = "abcdefghijklmnopabcdefghijklmnop";
const ID_B = "ponmlkjihgfedcbaponmlkjihgfedcba";

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, HTMLGENIUS_TEST_SKIP_PROVIDER_PROBE: "1", ...env }
    }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function envFor(home, hostsDir) { return { HTMLGENIUS_BRIDGE_HOME: home, HTMLGENIUS_HOSTS_DIR: hostsDir }; }
function parseOneJson(stdout) {
  // §3.2:--json 时 stdout 有且仅有一个 JSON object
  const trimmed = stdout.trim();
  assert.ok(trimmed.length > 0, "stdout 不应为空");
  return JSON.parse(trimmed); // 若混入进度/日志会在此抛错
}

// ———————————————————————— version / 用法 ————————————————————————

test("version --json:单个 JSON,含版本与协议版本", async () => {
  const r = await run(["version", "--json"]);
  assert.equal(r.code, 0);
  const v = parseOneJson(r.stdout);
  assert.equal(v.name, "htmlgenius-bridge");
  assert.equal(v.protocol_version, 1);
  assert.match(v.version, /^\d+\.\d+\.\d+/);
});

test("未知命令 → 退出码 64,错误进 stderr 不污染 stdout", async () => {
  const r = await run(["frobnicate", "--json"]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /UNKNOWN_COMMAND/);
});

test("setup 缺 --scope user → 64;root scope 语义拒绝", async () => {
  const r = await run(["setup", "--json", "--extension-id", ID_A]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /BAD_SCOPE/);
});

test("setup 非法 extension id → 64 INVALID_EXTENSION_ID", async () => {
  const r = await run(["setup", "--json", "--scope", "user", "--extension-id", "not-an-id"]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /INVALID_EXTENSION_ID/);
});

// ———————————————————————— doctor ————————————————————————

test("doctor --json 未安装:action_required + BRIDGE_NOT_INSTALLED,且无副作用(不建目录)", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  fs.rmSync(home, { recursive: true, force: true }); // 先删:断言 doctor 不创建
  try {
    const r = await run(["doctor", "--json", "--extension-id", ID_A], envFor(home, hostsDir));
    assert.equal(r.code, 1, "action_required 退出码 1");
    const h = parseOneJson(r.stdout);
    assert.equal(h.schema_version, 1);
    assert.equal(h.overall, "action_required");
    assert.equal(h.bridge.status, "install_required");
    assert.equal(h.reason_code, "BRIDGE_NOT_INSTALLED");
    assert.equal(h.browser.status, "manifest_missing");
    assert.ok(h.actions.includes("copy_setup_prompt"));
    assert.ok(h.actions.includes("copy_terminal_command"));
    assert.ok(!fs.existsSync(home), "doctor 无副作用:不创建受管目录");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("doctor 输出脱敏:不含路径/用户目录字符串", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  try {
    const r = await run(["doctor", "--json", "--extension-id", ID_A], envFor(home, hostsDir));
    const out = r.stdout + r.stderr;
    assert.ok(!out.includes(home), "不含 home 路径");
    assert.ok(!out.includes(hostsDir), "不含 hosts 路径");
    assert.ok(!out.includes(os.homedir()), "不含真实用户目录");
    const h = parseOneJson(r.stdout);
    assert.equal(JSON.stringify(h).includes("/"), false, "health JSON 不含任何路径分隔符");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("doctor:OS 不支持 → unsupported + OS_UNSUPPORTED(退出码 2)", async () => {
  const r = await run(["doctor", "--json"], { HTMLGENIUS_TEST_PLATFORM: "linux" });
  assert.equal(r.code, 2);
  const h = parseOneJson(r.stdout);
  assert.equal(h.overall, "unsupported");
  assert.equal(h.reason_code, "OS_UNSUPPORTED");
  assert.equal(h.platform.supported, false);
});

test("doctor:Node 版本不足 → NODE_UNSUPPORTED(退出码 2)", async () => {
  const r = await run(["doctor", "--json"], { HTMLGENIUS_TEST_NODE_VERSION: "20.10.0" });
  assert.equal(r.code, 2);
  const h = parseOneJson(r.stdout);
  assert.equal(h.reason_code, "NODE_UNSUPPORTED");
});

// ———————————————————————— setup / 幂等 / 迁移 ————————————————————————

test("setup:首装 changed:true;再装 changed:false(幂等);manifest 单 origin;launcher 受控标记指向受管目录", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  try {
    const r1 = await run(["setup", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir));
    assert.equal(r1.code, 0, "setup 成功退出 0:" + r1.stderr);
    const j1 = parseOneJson(r1.stdout);
    assert.equal(j1.ok, true);
    assert.equal(j1.changed, true);
    assert.equal(j1.bridge.protocol_version, 1);
    assert.ok(!r1.stdout.includes(home), "成功 JSON 不含绝对路径");

    // 注册文件落盘检查(读磁盘,不读 JSON)
    const manifestPath = path.join(hostsDir, HOST_NAME + ".json");
    const launcherPath = path.join(hostsDir, HOST_NAME + ".launcher.sh");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://" + ID_A + "/"], "单 origin");
    assert.equal(manifest.type, "stdio");
    const launcher = fs.readFileSync(launcherPath, "utf8");
    assert.ok(launcher.includes(LAUNCHER_MARKER), "launcher 带受控标记");
    assert.equal(manifest.path, launcherPath, "manifest.path 指向 launcher");
    assert.ok(launcher.includes(home), "launcher exec 指向受管目录(在 home 下),不指向 npx 临时目录");
    assert.ok(!launcher.includes("npx"), "不指向 npx cache");
    assert.equal(fs.statSync(launcherPath).mode & 0o777, 0o700);

    // 幂等
    const r2 = await run(["setup", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir));
    assert.equal(r2.code, 0);
    const j2 = parseOneJson(r2.stdout);
    assert.equal(j2.changed, false, "同版本同 ID → changed:false");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("setup:已注册不同 extension ID → EXTENSION_ORIGIN_MISMATCH,拒绝覆盖", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  try {
    const r1 = await run(["setup", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir));
    assert.equal(r1.code, 0);
    const r2 = await run(["setup", "--json", "--scope", "user", "--extension-id", ID_B], envFor(home, hostsDir));
    assert.equal(r2.code, 3, "冲突 → 非 0");
    assert.match(r2.stderr, /EXTENSION_ORIGIN_MISMATCH/);
    const manifest = JSON.parse(fs.readFileSync(path.join(hostsDir, HOST_NAME + ".json"), "utf8"));
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://" + ID_A + "/"], "原 origin 未被覆盖");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("setup 后 doctor:bridge ready + origin_ok(跳过 provider probe)", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  try {
    assert.equal((await run(["setup", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir))).code, 0);
    const r = await run(["doctor", "--json", "--extension-id", ID_A], envFor(home, hostsDir));
    const h = parseOneJson(r.stdout);
    assert.equal(h.bridge.status, "ready");
    assert.equal(h.bridge.managed_install, true);
    assert.equal(h.browser.status, "origin_ok");
    // provider probe 跳过 → providers 空 → bridge 就绪但无可用 Agent = action_required(语义正确)
    assert.equal(h.overall, "action_required");
    assert.deepEqual(h.providers, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

// ———————————————————————— repair / uninstall ————————————————————————

test("repair:未安装 → action_required(BRIDGE_NOT_INSTALLED);已安装但 manifest 缺失 → 重写修复", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  try {
    const r0 = await run(["repair", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir));
    assert.equal(r0.code, 1);
    const h0 = parseOneJson(r0.stdout);
    assert.equal(h0.reason_code, "BRIDGE_NOT_INSTALLED");

    assert.equal((await run(["setup", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir))).code, 0);
    fs.unlinkSync(path.join(hostsDir, HOST_NAME + ".json")); // 模拟 manifest 丢失
    const r1 = await run(["repair", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir));
    // provider probe 跳过 → overall=action_required 属正确语义;断言修复后的字段
    const h1 = parseOneJson(r1.stdout);
    assert.equal(h1.bridge.status, "ready");
    assert.equal(h1.browser.status, "origin_ok");
    assert.ok(fs.existsSync(path.join(hostsDir, HOST_NAME + ".json")), "manifest 已重写");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("uninstall --scope user:移除 host 文件 + 受管目录;第三方 host 不受影响", async () => {
  const home = mkTmp("hg-cli-home-");
  const hostsDir = mkTmp("hg-cli-hosts-");
  try {
    assert.equal((await run(["setup", "--json", "--scope", "user", "--extension-id", ID_A], envFor(home, hostsDir))).code, 0);
    fs.writeFileSync(path.join(hostsDir, "com.third.host.json"), JSON.stringify({ name: "com.third.host", path: "/x", type: "stdio", allowed_origins: ["*"] }));
    const r = await run(["uninstall", "--json", "--scope", "user"], envFor(home, hostsDir));
    assert.equal(r.code, 0);
    const j = parseOneJson(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.removed_host_files, 2);
    assert.equal(j.removed_managed_bridge, true);
    assert.ok(!r.stdout.includes(home), "JSON 不含路径");
    assert.ok(!fs.existsSync(path.join(hostsDir, HOST_NAME + ".json")));
    assert.ok(fs.existsSync(path.join(hostsDir, "com.third.host.json")), "第三方 host 保留");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});
