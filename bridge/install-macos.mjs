// bridge/install-macos.mjs — 安装/卸载 Chrome Native Messaging host(macOS)。
// 用法:node install-macos.mjs --extension-id <chrome-extension-id> [--hosts-dir <dir>] [--claude-path <path>] [--uninstall]
//   --extension-id  必填,Chrome 扩展 ID(32 位 [a-p])
//   --hosts-dir     可选,覆盖 manifest 输出目录(测试用);默认 ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
//   --claude-path   可选(v0.8.2 起非安装前提),显式 claude 可执行文件路径;找到则烘焙进 launcher PATH,找不到只告警不失败
//   --uninstall     仅移除本 host 写的 launcher + manifest
// host 名是 provider-neutral 的(com.htmlgenius.local_bridge):Claude Code / Codex / GitHub Copilot 三个 adapter 复用同一 host。
// v0.8.2 §4.2:安装只校验 Node(>=20.19.0 或 >=22.12.0,@github/copilot-sdk 要求)、host.mjs 存在、extension ID、manifest 可写;
// 用户可以只用 Copilot 或 Codex,因此不再把「找到 Claude CLI」作为安装成功条件。
// 安全(§4.3):allowed_origins 只含传入的单个 origin;launcher 用绝对 node + 绝对 host.mjs,无 shell 拼接;失败清理。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const HOST_NAME = "com.htmlgenius.local_bridge";
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
    description: "HTML Genius Local Bridge (local AI agent handoff)",
    path: launcherPath,
    type: "stdio",
    allowed_origins: ["chrome-extension://" + extensionId + "/"]
  };
}

// launcher 源码:exec 绝对 node + 绝对 host.mjs。无 shell 拼接,路径含单引号即拒(防注入)。
// 关键:从 Dock/Spotlight 启动的 Chrome 其 PATH 极简,通常不含 nvm/claude 所在目录,
// 导致 host 运行期 spawn("claude") 找不到二进制。故在 launcher 里把 node 目录、claude 目录与
// 常见安装目录 prepend 进 PATH,使 GUI 启动的 Chrome 也能找到 claude(烟测前提)。
export function buildLauncherSource({ nodePath, hostPath, claudePath }) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(hostPath)) {
    const err = new Error("node/host paths must be absolute"); err.code = "PATH_NOT_ABSOLUTE"; throw err;
  }
  if (nodePath.includes("'") || hostPath.includes("'")) {
    const err = new Error("path contains single quote; refusing to write shell launcher"); err.code = "UNSAFE_PATH"; throw err;
  }
  const home = process.env.HOME || "";
  const dirs = [path.dirname(nodePath)];
  if (claudePath) { const d = path.dirname(claudePath); if (d && !dirs.includes(d)) dirs.push(d); }
  // 常见 claude/node 安装位置(nvm 已在 dirname(nodePath);官方安装器 ~/.local/bin;brew;npm-global)
  [home + "/.local/bin", home + "/.npm-global/bin", home + "/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    .forEach((d) => { if (d && d !== "/" && !dirs.includes(d)) dirs.push(d); });
  const safePath = dirs.filter((d) => !/['"$\n]/.test(d)).join(":");
  return "#!/bin/sh\nexport PATH=\"" + safePath + ":$PATH\"\nexec '" + nodePath + "' '" + hostPath + "' \"$@\"\n";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extension-id") out.extensionId = argv[++i];
    else if (a === "--hosts-dir") out.hostsDir = argv[++i];
    else if (a === "--claude-path") out.claudePath = argv[++i];
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--bridge-dir") out.bridgeDir = argv[++i];
  }
  return out;
}

// v0.8.2 §4.2:Node 版本须满足 @github/copilot-sdk engines:^20.19.0 || >=22.12.0。不能只查 major>=20。
export function nodeEngineOk(version = process.versions.node) {
  const [maj, min] = String(version).split(".").map((n) => Number(n));
  if (!Number.isInteger(maj)) return false;
  if (maj === 20) return min >= 19;   // ^20.19.0
  if (maj === 21) return false;       // 21.x 不在范围内
  return maj > 22 || min >= 12;       // >=22.12.0(23+ 均可)
}

function assertNodeEngine() {
  if (!nodeEngineOk()) {
    const e = new Error("Node ^20.19.0 || >=22.12.0 required (@github/copilot-sdk), got " + process.versions.node);
    e.code = "NODE_TOO_OLD"; throw e;
  }
}

// v0.8.2 §4.2:Claude CLI 不再是安装前提——用户可能只用 Copilot 或 Codex。
// 找到(显式 --claude-path 或 which)则烘焙进 launcher PATH;找不到只告警,安装继续。
function resolveClaudeOptional(claudePath) {
  if (claudePath) {
    if (!path.isAbsolute(claudePath)) {
      process.stderr.write("warning: --claude-path is not absolute; ignoring it\n");
      return null;
    }
    try { fs.accessSync(claudePath, fs.constants.X_OK); return claudePath; }
    catch (_) { process.stderr.write("warning: --claude-path not executable (" + claudePath + "); continuing without it\n"); return null; }
  }
  const r = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  return r.stdout.trim();
}

export async function install({ extensionId, hostsDir, claudePath, bridgeDir }) {
  assertNodeEngine();
  validateExtensionId(extensionId);
  const dir = bridgeDir || path.dirname(new URL(import.meta.url).pathname);
  if (!path.isAbsolute(dir)) { const e = new Error("bridge dir must be absolute"); e.code = "PATH_NOT_ABSOLUTE"; throw e; }
  const hostPath = path.join(dir, "host.mjs");
  try { fs.accessSync(hostPath, fs.constants.R_OK); } catch (_) { const e = new Error("host.mjs not found in bridge dir: " + dir); e.code = "HOST_MISSING"; throw e; }
  const resolvedClaude = resolveClaudeOptional(claudePath); // 可选:找到则烘焙进 launcher PATH;找不到不阻塞安装(v0.8.2 §4.2)

  const outDir = hostsDir || DEFAULT_HOSTS_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const launcherPath = path.join(outDir, HOST_NAME + ".launcher.sh");
  const manifestPath = path.join(outDir, HOST_NAME + ".json");
  const written = [];

  try {
    const launcherSrc = buildLauncherSource({ nodePath: process.execPath, hostPath, claudePath: resolvedClaude });
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
    if (!opts.extensionId) throw new Error("usage: install-macos.mjs --extension-id <id> [--hosts-dir <dir>] [--claude-path <path>]");
    const r = await install({ extensionId: opts.extensionId, hostsDir: opts.hostsDir, claudePath: opts.claudePath, bridgeDir: opts.bridgeDir });
    process.stdout.write("HTML Genius Local Bridge installed (provider-neutral: Claude Code / Codex / GitHub Copilot):\n");
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
