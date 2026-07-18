// bridge/test/install-macos.test.mjs — installer 测试(§12.2)。全部用 os.tmpdir(),不碰真实 Chrome 目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateExtensionId, buildManifest, buildLauncherSource, install, uninstall, HOST_NAME
} from "../install-macos.mjs";

const VALID_ID = "abcdefghijklmnopabcdefghijklmnop"; // 32 × [a-p]

test("validateExtensionId: 接受合法 ID", () => {
  assert.equal(validateExtensionId(VALID_ID), VALID_ID);
});

test("validateExtensionId: 拒绝空/含路径/非法字符/长度错", () => {
  for (const bad of ["", "short", "chrome-extension://abc/", "ABCDEFABCDEFABCDEFABCDEFABCDEFAB".toLowerCase().replace(/a/g,"z"), "../x"]) {
    assert.throws(() => validateExtensionId(bad), (e) => e.code === "INVALID_EXTENSION_ID", "bad id: " + bad);
  }
});

test("buildManifest: 单 origin、stdio、绝对 launcher 路径", () => {
  const m = buildManifest({ extensionId: VALID_ID, launcherPath: "/tmp/launcher.sh" });
  assert.equal(m.name, HOST_NAME);
  assert.equal(m.type, "stdio");
  assert.equal(m.path, "/tmp/launcher.sh");
  assert.deepEqual(m.allowed_origins, ["chrome-extension://" + VALID_ID + "/"]);
  assert.equal(m.allowed_origins.length, 1, "只允许单个 origin");
});

test("buildManifest: 非 launcher 非绝对路径 -> PATH_NOT_ABSOLUTE", () => {
  assert.throws(() => buildManifest({ extensionId: VALID_ID, launcherPath: "rel/path" }), (e) => e.code === "PATH_NOT_ABSOLUTE");
});

test("buildLauncherSource: exec 绝对 node + 绝对 host.mjs,有 shebang,不含 shell 注入", () => {
  const src = buildLauncherSource({ nodePath: "/usr/local/bin/node", hostPath: "/abs/bridge/host.mjs" });
  assert.match(src, /^#!\/bin\/sh\n/);
  assert.match(src, /exec '\/usr\/local\/bin\/node' '\/abs\/bridge\/host\.mjs' "\$@"/);
});

test("buildLauncherSource: 路径含单引号 -> UNSAFE_PATH", () => {
  assert.throws(() => buildLauncherSource({ nodePath: "/usr/local/bin/node", hostPath: "/ab's/host.mjs" }), (e) => e.code === "UNSAFE_PATH");
});

test("install: 在临时 hosts-dir 写出单 origin manifest + 0700 launcher;codex 用 node 本体作可执行占位", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-bridge-install-"));
  try {
    const r = await install({
      extensionId: VALID_ID,
      hostsDir: tmp,
      codexPath: process.execPath, // 任意存在且可执行的文件,满足 codex 就绪校验
      bridgeDir: path.resolve(new URL(".", import.meta.url).pathname, "..") // 真实 bridge 目录(含 host.mjs)
    });
    assert.equal(r.allowed_origins.length, 1);
    assert.equal(r.allowed_origins[0], "chrome-extension://" + VALID_ID + "/");
    assert.ok(fs.existsSync(r.manifestPath));
    assert.ok(fs.existsSync(r.launcherPath));
    const manifest = JSON.parse(fs.readFileSync(r.manifestPath, "utf8"));
    assert.equal(manifest.allowed_origins.length, 1);
    assert.equal(manifest.type, "stdio");
    const stat = fs.statSync(r.launcherPath);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o700, "launcher 应 0700");
    // 卸载
    const u = await uninstall({ hostsDir: tmp });
    assert.ok(u.removed.length >= 2);
    assert.ok(!fs.existsSync(r.manifestPath));
    assert.ok(!fs.existsSync(r.launcherPath));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

test("install: 非法 extension id -> 失败且无残留文件", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-bridge-bad-"));
  try {
    await assert.rejects(() => install({ extensionId: "not-valid-id", hostsDir: tmp, codexPath: process.execPath,
      bridgeDir: path.resolve(new URL(".", import.meta.url).pathname, "..") }),
      (e) => e.code === "INVALID_EXTENSION_ID");
    assert.deepEqual(fs.readdirSync(tmp), [], "失败后无残留");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
});

test("install: codex 不存在 -> CODEX_NOT_IN_PATH 且无残留", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-bridge-nocodex-"));
  try {
    await assert.rejects(() => install({ extensionId: VALID_ID, hostsDir: tmp, codexPath: "/definitely/not/here/codex",
      bridgeDir: path.resolve(new URL(".", import.meta.url).pathname, "..") }),
      (e) => e.code === "CODEX_NOT_IN_PATH");
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
});
