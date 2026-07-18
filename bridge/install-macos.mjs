// bridge/install-macos.mjs — 安装/卸载 Chrome Native Messaging host(macOS)。
// 用法:node install-macos.mjs --extension-id <chrome-extension-id> [--hosts-dir <dir>] [--codex-path <path>] [--uninstall]
//   --extension-id  必填,Chrome 扩展 ID(32 位 [a-p])
//   --hosts-dir     可选,覆盖 manifest 输出目录(测试用);默认 ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
//   --codex-path    可选,显式 codex 可执行文件路径;不提供则 `which codex`
//   --uninstall     仅移除本 host 写的 launcher + manifest
// 安全(§4.3):allowed_origins 只含传入的单个 origin;launcher 用绝对 node + 绝对 host.mjs,无 shell 拼接;失败清理。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const HOST_NAME = "com.htmlgenius.codex_bridge";
export const DEFAULT_HOSTS_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts"
);

// Chrome 扩展 ID:32 个小写字母 a-p。
export function validateExtensionId(id) {
  if (typeof id !== "string" || !/^[a-p]{32}$/.test(id)) {
    const err = new Error("invalid chrome extension id");
    err.code = "INVALID_EXTENSION_ID";
    throw err;
  }
  return id;
}

// 单 origin host manifest(§4.3.3)。只允许传入的那一个扩展。
export function buildManifest({ extensionId, launcherPath }) {
  validateExtensionId(extensionId);
  if (!path.isAbsolute(launcherPath)) {
    const err = new Error("launcher path must be absolute"); err.code = "PATH_NOT_ABSOLUTE"; throw err;
  }
  return {
    name: HOST_NAME,
    description: "HTML Genius Local Bridge (Codex App Server)",
    path: launcherPath,
    type: "stdio",
    allowed_origins: ["chrome-extension://" + extensionId + "/"]
  };
}

// launcher 源码:exec 绝对 node + 绝对 host.mjs。无 shell 拼接,路径含单引号即拒(防注入)。
export function buildLauncherSource({ nodePath, hostPath }) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(hostPath)) {
    const err = new Error("node/host paths must be absolute"); err.code = "PATH_NOT_ABSOLUTE"; throw err;
  }
  if (nodePath.includes("'") || hostPath.includes("'")) {
    const err = new Error("path contains single quote; refusing to write shell launcher"); err.code = "UNSAFE_PATH"; throw err;
  }
  return "#!/bin/sh\nexec '" + nodePath + "' '" + hostPath + "' \"$@\"\n";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extension-id") out.extensionId = argv[++i];
    else if (a === "--hosts-dir") out.hostsDir = argv[++i];
    else if (a === "--codex-path") out.codexPath = argv[++i];
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--bridge-dir") out.bridgeDir = argv[++i];
  }
  return out;
}

function assertNode20() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!(major >= 20)) { const e = new Error("node >= 20 required, got " + process.versions.node); e.code = "NODE_TOO_OLD"; throw e; }
}

function resolveCodex(codexPath) {
  if (codexPath) {
    if (!path.isAbsolute(codexPath)) { const e = new Error("--codex-path must be absolute"); e.code = "PATH_NOT_ABSOLUTE"; throw e; }
    try { fs.accessSync(codexPath, fs.constants.X_OK); } catch (_) { const e = new Error("codex not executable: " + codexPath); e.code = "CODEX_NOT_IN_PATH"; throw e; }
    return codexPath;
  }
  const r = spawnSync("which", ["codex"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) { const e = new Error("`codex` not found in PATH"); e.code = "CODEX_NOT_IN_PATH"; throw e; }
  return r.stdout.trim();
}

export async function install({ extensionId, hostsDir, codexPath, bridgeDir }) {
  assertNode20();
  validateExtensionId(extensionId);
  const dir = bridgeDir || path.dirname(new URL(import.meta.url).pathname);
  if (!path.isAbsolute(dir)) { const e = new Error("bridge dir must be absolute"); e.code = "PATH_NOT_ABSOLUTE"; throw e; }
  const hostPath = path.join(dir, "host.mjs");
  try { fs.accessSync(hostPath, fs.constants.R_OK); } catch (_) { const e = new Error("host.mjs not found in bridge dir: " + dir); e.code = "HOST_MISSING"; throw e; }
  resolveCodex(codexPath); // 验证 codex 就绪(不保存其路径)

  const outDir = hostsDir || DEFAULT_HOSTS_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const launcherPath = path.join(outDir, HOST_NAME + ".launcher.sh");
  const manifestPath = path.join(outDir, HOST_NAME + ".json");
  const written = [];

  try {
    const launcherSrc = buildLauncherSource({ nodePath: process.execPath, hostPath });
    fs.writeFileSync(launcherPath, launcherSrc, { mode: 0o700 });
    fs.chmodSync(launcherPath, 0o700);
    written.push(launcherPath);

    const manifest = buildManifest({ extensionId, launcherPath });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
    written.push(manifestPath);

    return {
      ok: true,
      hostsDir: outDir,
      launcherPath,
      manifestPath,
      allowed_origins: manifest.allowed_origins,
      uninstallHint: "node " + path.join(dir, "install-macos.mjs") + " --uninstall --hosts-dir \"" + outDir + "\""
    };
  } catch (e) {
    // 失败清理半写入文件(§4.3.6)
    for (const p of written) { try { fs.unlinkSync(p); } catch (_) {} }
    throw e;
  }
}

export async function uninstall({ hostsDir }) {
  const outDir = hostsDir || DEFAULT_HOSTS_DIR;
  const removed = [];
  for (const f of [HOST_NAME + ".launcher.sh", HOST_NAME + ".json"]) {
    const p = path.join(outDir, f);
    try { fs.unlinkSync(p); removed.push(p); } catch (_) {}
  }
  return { ok: true, hostsDir: outDir, removed };
}

export async function main(argv) {
  const opts = parseArgs(argv);
  try {
    if (opts.uninstall) {
      const r = await uninstall({ hostsDir: opts.hostsDir });
      process.stdout.write("uninstalled: " + (r.removed.length ? r.removed.join(", ") : "(nothing to remove)") + "\n");
      return 0;
    }
    if (!opts.extensionId) throw new Error("usage: install-macos.mjs --extension-id <id> [--hosts-dir <dir>] [--codex-path <path>]");
    const r = await install({ extensionId: opts.extensionId, hostsDir: opts.hostsDir, codexPath: opts.codexPath, bridgeDir: opts.bridgeDir });
    process.stdout.write("installed htmlGenius codex bridge host:\n");
    process.stdout.write("  manifest:     " + r.manifestPath + "\n");
    process.stdout.write("  launcher:     " + r.launcherPath + "\n");
    process.stdout.write("  allowed_origins: " + JSON.stringify(r.allowed_origins) + "\n");
    process.stdout.write("  uninstall:    " + r.uninstallHint + "\n");
    return 0;
  } catch (e) {
    process.stderr.write("install failed: " + (e && e.message) + "\n");
    return 1;
  }
}

if (import.meta.url === "file://" + process.argv[1] || process.argv[1]?.endsWith("install-macos.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
