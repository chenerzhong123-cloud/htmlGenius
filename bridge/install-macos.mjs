// bridge/install-macos.mjs — v0.9 起为**开发兼容入口**(薄包装):安装规则唯一实现在 bridge-install.mjs(§3.3/§7A)。
// 产品用户路径是 `htmlgenius-bridge` CLI(bin/htmlgenius-bridge.mjs,受管版本化布局);本脚本继续支持仓库内
// 就地安装(launcher 直接指向仓库 host.mjs,便于开发期改代码即生效),其 --uninstall 语义保持。
// 用法:node install-macos.mjs --extension-id <chrome-extension-id> [--hosts-dir <dir>] [--claude-path <path>] [--uninstall]
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  HOST_NAME, defaultHostsDir, validateExtensionId, nodeEngineOk,
  buildManifest, buildLauncherSource as buildLauncherSourceCore, ensureHostRegistration, removeHostFiles,
  inspectExistingManifest
} from "./bridge-install.mjs";

export { HOST_NAME, validateExtensionId, nodeEngineOk, buildManifest };
export const DEFAULT_HOSTS_DIR = defaultHostsDir();

// 兼容旧签名:claudePath → 烘焙进 launcher PATH 的附加目录(找不到 claude 只告警,非安装前提,v0.8.2 起)。
export function buildLauncherSource({ nodePath, hostPath, claudePath }) {
  return buildLauncherSourceCore({
    nodePath, hostPath,
    extraPathDirs: claudePath ? [path.dirname(claudePath)] : [],
    version: ""
  });
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

function assertNodeEngine() {
  if (!nodeEngineOk()) {
    const e = new Error("Node 20.x or 22+ required (21.x not supported; GitHub Copilot needs 20.19+/22.12+), got " + process.versions.node);
    e.code = "NODE_TOO_OLD"; throw e;
  }
}

// Claude CLI 可选(§4.2):找到则烘焙 PATH,找不到只告警。
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

// 开发态就地安装:launcher 指向仓库 host.mjs(不经受管目录)。origin 硬边界与原子写由共享核心保证。
export async function install({ extensionId, hostsDir, claudePath, bridgeDir }) {
  assertNodeEngine();
  validateExtensionId(extensionId);
  const dir = bridgeDir || path.dirname(new URL(import.meta.url).pathname);
  if (!path.isAbsolute(dir)) { const e = new Error("bridge dir must be absolute"); e.code = "PATH_NOT_ABSOLUTE"; throw e; }
  const hostPath = path.join(dir, "host.mjs");
  try { fs.accessSync(hostPath, fs.constants.R_OK); } catch (_) { const e = new Error("host.mjs not found in bridge dir: " + dir); e.code = "HOST_MISSING"; throw e; }
  const resolvedClaude = resolveClaudeOptional(claudePath);

  const outDir = hostsDir || defaultHostsDir();
  // origin 硬边界(§6.3):已存在但 extension ID 不匹配 → 拒绝覆盖
  const existing = inspectExistingManifest({ hostsDir: outDir, extensionId });
  if (existing.state === "ours_mismatch") {
    const e = new Error("existing HTML Genius host is registered for a different extension; refusing to overwrite");
    e.code = "EXTENSION_ORIGIN_MISMATCH"; throw e;
  }
  if (existing.state === "foreign") {
    const e = new Error("an unrelated host manifest occupies the HTML Genius host name; refusing to overwrite");
    e.code = "MANIFEST_FOREIGN"; throw e;
  }

  const launcherSource = buildLauncherSource({
    nodePath: process.execPath, hostPath,
    claudePath: resolvedClaude
  });
  const r = ensureHostRegistration({ hostsDir: outDir, extensionId, launcherSource });
  return {
    ok: true,
    changed: r.changed,
    hostsDir: outDir,
    launcherPath: r.launcherPath,
    manifestPath: r.manifestPath,
    allowed_origins: ["chrome-extension://" + extensionId + "/"],
    uninstallHint: "node " + path.join(dir, "install-macos.mjs") + " --uninstall --hosts-dir \"" + outDir + "\""
  };
}

// --uninstall 语义保持:只移除本 host 写的 launcher + manifest(带受控标记或被 manifest 引用)。
export async function uninstall({ hostsDir }) {
  const outDir = hostsDir || defaultHostsDir();
  const { removed } = removeHostFiles({ hostsDir: outDir });
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
    process.stdout.write("HTML Genius Local Bridge installed (developer path; product CLI: htmlgenius-bridge):\n");
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
