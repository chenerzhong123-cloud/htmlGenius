// bridge/test/bridge-install.test.mjs — v0.9 §8.1 安装核心测试:全部 tmpdir,不碰真实 Chrome 目录。
// 覆盖:单 origin/0700/受控标记、幂等注册、V0.8.2 迁移、origin mismatch 拒绝覆盖、foreign manifest 拒绝、
//       卸载不误删第三方 host(含 legacy 无标记但被 manifest 引用)、受管布局 materialize/verify、原子写。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOST_NAME, LAUNCHER_MARKER, PROTOCOL_VERSION,
  validateExtensionId, nodeEngineOk, buildManifest, buildLauncherSource, launcherHasMarker,
  ensureHostRegistration, removeHostFiles, inspectExistingManifest, uninstallManaged,
  materializeBridge, verifyManagedVersion, versionDirFor, managedRoot, writeFileAtomic
} from "../bridge-install.mjs";

const ID_A = "abcdefghijklmnopabcdefghijklmnop"; // 32 × [a-p]
const ID_B = "ponmlkjihgfedcbaponmlkjihgfedcba"; // 另一个合法 ID

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "hg-bi-")); }
function launcherSrc(version = "0.9.0") {
  return buildLauncherSource({ nodePath: "/usr/local/bin/node", hostPath: "/abs/host.mjs", version });
}

// ———————————————————————— 基础规则 ————————————————————————

test("validateExtensionId:合法/非法", () => {
  assert.equal(validateExtensionId(ID_A), ID_A);
  for (const bad of ["", "short", "chrome-extension://abc/", "../x", "ABCDEFABCDEFABCDEFABCDEFABCDEFAB".toLowerCase().replace(/a/g, "z")]) {
    assert.throws(() => validateExtensionId(bad), (e) => e.code === "INVALID_EXTENSION_ID");
  }
});

test("nodeEngineOk:^20.19.0 || >=22.12.0", () => {
  assert.equal(nodeEngineOk("20.19.0"), true);
  assert.equal(nodeEngineOk("20.18.9"), false);
  assert.equal(nodeEngineOk("21.0.0"), false);
  assert.equal(nodeEngineOk("22.12.0"), true);
  assert.equal(nodeEngineOk("22.11.9"), false);
  assert.equal(nodeEngineOk("24.0.0"), true);
});

test("buildManifest:单 origin、stdio、绝对 launcher", () => {
  const m = buildManifest({ extensionId: ID_A, launcherPath: "/tmp/l.sh" });
  assert.equal(m.name, HOST_NAME);
  assert.deepEqual(m.allowed_origins, ["chrome-extension://" + ID_A + "/"]);
  assert.throws(() => buildManifest({ extensionId: ID_A, launcherPath: "rel" }), (e) => e.code === "PATH_NOT_ABSOLUTE");
});

test("buildLauncherSource:shebang + 受控标记 + 协议版本;单引号路径拒绝", () => {
  const src = launcherSrc();
  assert.match(src, /^#!\/bin\/sh\n/);
  assert.ok(src.split("\n")[1].startsWith(LAUNCHER_MARKER), "第二行是受控标记");
  assert.match(src, /protocol=1/);
  assert.match(src, /exec '\/usr\/local\/bin\/node' '\/abs\/host\.mjs' "\$@"/);
  assert.ok(launcherHasMarker(src));
  assert.throws(() => buildLauncherSource({ nodePath: "/usr/local/bin/node", hostPath: "/a'b/host.mjs" }), (e) => e.code === "UNSAFE_PATH");
  assert.equal(launcherHasMarker("#!/bin/sh\nexec node x"), false);
});

// ———————————————————————— 注册:幂等 / 迁移 / origin 硬边界 ————————————————————————

test("ensureHostRegistration:首装 changed:true,同内容再装 changed:false(幂等);权限 0700/0644", () => {
  const dir = tmp();
  try {
    const r1 = ensureHostRegistration({ hostsDir: dir, extensionId: ID_A, launcherSource: launcherSrc() });
    assert.equal(r1.changed, true);
    assert.equal(fs.statSync(r1.launcherPath).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r1.manifestPath).mode & 0o777, 0o644);
    const manifest = JSON.parse(fs.readFileSync(r1.manifestPath, "utf8"));
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://" + ID_A + "/"]);
    const r2 = ensureHostRegistration({ hostsDir: dir, extensionId: ID_A, launcherSource: launcherSrc() });
    assert.equal(r2.changed, false, "同版本同 ID 同内容 → changed:false");
    // 内容变化(launcher 版本升)→ 再写
    const r3 = ensureHostRegistration({ hostsDir: dir, extensionId: ID_A, launcherSource: launcherSrc("0.9.1") });
    assert.equal(r3.changed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("V0.8.2 迁移:legacy 无标记 launcher + 同 ID → 可直接替换为受控 launcher", () => {
  const dir = tmp();
  try {
    // 模拟 v0.8.2 安装:launcher 无标记,manifest 引用它
    const launcherPath = path.join(dir, HOST_NAME + ".launcher.sh");
    const manifestPath = path.join(dir, HOST_NAME + ".json");
    fs.writeFileSync(launcherPath, "#!/bin/sh\nexec '/old/node' '/old/host.mjs' \"$@\"\n", { mode: 0o700 });
    fs.writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME, path: launcherPath, type: "stdio", allowed_origins: ["chrome-extension://" + ID_A + "/"] }, null, 2) + "\n");
    const ins = inspectExistingManifest({ hostsDir: dir, extensionId: ID_A });
    assert.equal(ins.state, "ours_match");
    const r = ensureHostRegistration({ hostsDir: dir, extensionId: ID_A, launcherSource: launcherSrc() });
    assert.equal(r.changed, true);
    assert.ok(launcherHasMarker(fs.readFileSync(launcherPath, "utf8")), "迁移后 launcher 带受控标记");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("origin 硬边界:同 host 名但不同 extension ID → ours_mismatch(上层拒绝覆盖)", () => {
  const dir = tmp();
  try {
    ensureHostRegistration({ hostsDir: dir, extensionId: ID_A, launcherSource: launcherSrc() });
    const ins = inspectExistingManifest({ hostsDir: dir, extensionId: ID_B });
    assert.equal(ins.state, "ours_mismatch");
    // 未覆盖:manifest 仍是 ID_A
    const m = JSON.parse(fs.readFileSync(path.join(dir, HOST_NAME + ".json"), "utf8"));
    assert.deepEqual(m.allowed_origins, ["chrome-extension://" + ID_A + "/"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("foreign manifest(同名非本 host)→ foreign,不得覆盖", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, HOST_NAME + ".json"), JSON.stringify({ name: "com.other.host", path: "/x", type: "stdio", allowed_origins: ["*"] }));
    const ins = inspectExistingManifest({ hostsDir: dir, extensionId: ID_A });
    assert.equal(ins.state, "foreign");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ———————————————————————— 卸载:只删自家文件 ————————————————————————

test("removeHostFiles:受控安装整体移除;第三方 host(无标记、manifest 名不符)不被误删", () => {
  const dir = tmp();
  try {
    ensureHostRegistration({ hostsDir: dir, extensionId: ID_A, launcherSource: launcherSrc() });
    // 第三方 host 文件(同名目录下的其它 host 不受影响;这里用不同名验证选择逻辑的保守性)
    const thirdManifest = path.join(dir, "com.third.host.json");
    fs.writeFileSync(thirdManifest, JSON.stringify({ name: "com.third.host", path: "/t.sh", type: "stdio", allowed_origins: ["*"] }));
    fs.writeFileSync(path.join(dir, "com.third.host.sh"), "#!/bin/sh\nexec node t\n");
    const { removed } = removeHostFiles({ hostsDir: dir });
    assert.equal(removed.length, 2, "移除 manifest + launcher");
    assert.ok(fs.existsSync(thirdManifest), "第三方 manifest 保留");
    assert.ok(fs.existsSync(path.join(dir, "com.third.host.sh")), "第三方 launcher 保留");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("removeHostFiles:legacy v0.8.2 launcher(无标记但被 manifest 引用)也能移除", () => {
  const dir = tmp();
  try {
    const launcherPath = path.join(dir, HOST_NAME + ".launcher.sh");
    fs.writeFileSync(launcherPath, "#!/bin/sh\nexec '/old/node' '/old/host.mjs' \"$@\"\n", { mode: 0o700 });
    fs.writeFileSync(path.join(dir, HOST_NAME + ".json"), JSON.stringify({ name: HOST_NAME, path: launcherPath, type: "stdio", allowed_origins: ["chrome-extension://" + ID_A + "/"] }, null, 2));
    const { removed } = removeHostFiles({ hostsDir: dir });
    assert.equal(removed.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("removeHostFiles:同名但无标记且 manifest 不可解析 → 保守保留", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, HOST_NAME + ".launcher.sh"), "#!/bin/sh\nexec node mystery\n");
    fs.writeFileSync(path.join(dir, HOST_NAME + ".json"), "{ not json");
    const { removed } = removeHostFiles({ hostsDir: dir });
    assert.equal(removed.length, 0, "不可判定归属 → 不删");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ———————————————————————— 受管布局 ————————————————————————

function fakeBridgeSrc() {
  const src = tmp();
  fs.writeFileSync(path.join(src, "host.mjs"), "// host\n");
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "htmlgenius-local-bridge", version: "0.9.0" }));
  fs.mkdirSync(path.join(src, "test"));
  fs.writeFileSync(path.join(src, "test", "x.test.mjs"), "// test\n");
  return src;
}

test("materializeBridge:物化到受管目录(排 test/)+ managed-install.json + 0700;verify 通过", () => {
  const home = tmp();
  const src = fakeBridgeSrc();
  try {
    const target = versionDirFor({ home, version: "0.9.0" });
    materializeBridge({ sourceBridgeDir: src, targetDir: target, version: "0.9.0" });
    assert.ok(fs.existsSync(path.join(target, "host.mjs")));
    assert.ok(fs.existsSync(path.join(target, "managed-install.json")));
    assert.ok(!fs.existsSync(path.join(target, "test")), "test/ 不物化");
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    const v = verifyManagedVersion({ home, version: "0.9.0" });
    assert.equal(v.ok, true);
    assert.equal(v.version, "0.9.0");
    // managedRoot 在 ~/.htmlgenius/bridge 下
    assert.ok(target.startsWith(managedRoot(home)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test("materializeBridge:有依赖但缺 node_modules → SETUP_DEPS_MISSING,不留半成品", () => {
  const home = tmp();
  const src = tmp();
  try {
    fs.writeFileSync(path.join(src, "host.mjs"), "// host\n");
    fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "b", version: "0.9.0", dependencies: { "@github/copilot-sdk": "1.0.7" } }));
    const target = versionDirFor({ home, version: "0.9.0" });
    assert.throws(() => materializeBridge({ sourceBridgeDir: src, targetDir: target, version: "0.9.0" }), (e) => e.code === "SETUP_DEPS_MISSING");
    assert.ok(!fs.existsSync(target), "失败不留目标目录");
    assert.ok(!fs.existsSync(target + ".staging-" + process.pid), "失败清理 staging");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test("materializeBridge:升级时替换旧版本目录(切换后旧目录删除)", () => {
  const home = tmp();
  const src = fakeBridgeSrc();
  try {
    const target = versionDirFor({ home, version: "0.9.0" });
    materializeBridge({ sourceBridgeDir: src, targetDir: target, version: "0.9.0" });
    fs.writeFileSync(path.join(target, "stale.txt"), "old");
    materializeBridge({ sourceBridgeDir: src, targetDir: target, version: "0.9.0" });
    assert.ok(!fs.existsSync(path.join(target, "stale.txt")), "旧内容被替换");
    assert.ok(fs.existsSync(path.join(target, "host.mjs")));
    const leftovers = fs.readdirSync(path.dirname(target)).filter((n) => n.includes(".old-") || n.includes(".staging-"));
    assert.deepEqual(leftovers, [], "无残留临时目录");
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test("verifyManagedVersion:缺 host.mjs / 缺 managed-install.json → BRIDGE_FILES_CORRUPT", () => {
  const home = tmp();
  try {
    const target = versionDirFor({ home, version: "0.9.0" });
    fs.mkdirSync(target, { recursive: true });
    assert.equal(verifyManagedVersion({ home, version: "0.9.0" }).code, "BRIDGE_FILES_CORRUPT");
    fs.writeFileSync(path.join(target, "host.mjs"), "//");
    fs.writeFileSync(path.join(target, "package.json"), "{}");
    assert.equal(verifyManagedVersion({ home, version: "0.9.0" }).code, "BRIDGE_FILES_CORRUPT");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("versionDirFor:非法版本号拒绝(路径穿越防御)", () => {
  assert.throws(() => versionDirFor({ home: "/h", version: "../evil" }), (e) => e.code === "BAD_VERSION");
  assert.throws(() => versionDirFor({ home: "/h", version: "a/b" }), (e) => e.code === "BAD_VERSION");
});

test("uninstallManaged:移除 host 文件 + 受管根目录;工作区证据目录名不同,不受影响", () => {
  const home = tmp();
  const hostsDir = tmp();
  try {
    ensureHostRegistration({ hostsDir, extensionId: ID_A, launcherSource: launcherSrc() });
    materializeBridge({ sourceBridgeDir: fakeBridgeSrc(), targetDir: versionDirFor({ home, version: "0.9.0" }), version: "0.9.0" });
    const r = uninstallManaged({ home, hostsDir });
    assert.equal(r.removedManaged, true);
    assert.ok(!fs.existsSync(managedRoot(home)));
    assert.ok(!fs.existsSync(path.join(hostsDir, HOST_NAME + ".json")));
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostsDir, { recursive: true, force: true }); }
});

test("writeFileAtomic:写入成功且不留临时文件", () => {
  const dir = tmp();
  try {
    const target = path.join(dir, "f.json");
    writeFileAtomic(target, '{"a":1}', 0o600);
    assert.equal(fs.readFileSync(target, "utf8"), '{"a":1}');
    assert.deepEqual(fs.readdirSync(dir), ["f.json"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
