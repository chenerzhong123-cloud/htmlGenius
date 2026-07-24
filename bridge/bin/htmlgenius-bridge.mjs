#!/usr/bin/env node
// bridge/bin/htmlgenius-bridge.mjs — v0.9 §3.2 受控 CLI(以 @htmlgenius/bridge 发行;`npx --yes @htmlgenius/bridge@<ver>` 即可在干净机器安装)。
// 子命令:doctor / setup / repair / uninstall / version。
// 纪律:--json 时 stdout 有且仅有一个 JSON object(进度/日志一律 stderr);退出码稳定:
//   0=ready,1=action_required,2=unsupported,3=error,64=用法错误。
// 成功 JSON 绝不含绝对路径(§3.2);--verbose 只向 stderr 多写调试信息,Side panel 永不使用。
// 测试注入(内部,非公开接口):HTMLGENIUS_BRIDGE_HOME / HTMLGENIUS_HOSTS_DIR / HTMLGENIUS_TEST_PLATFORM /
//   HTMLGENIUS_TEST_NODE_VERSION / HTMLGENIUS_TEST_SKIP_PROVIDER_PROBE。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  HOST_NAME, PROTOCOL_VERSION, validateExtensionId, nodeEngineOk, assertUserScope,
  buildLauncherSource, ensureHostRegistration, inspectExistingManifest, removeHostFiles,
  materializeBridge, verifyManagedVersion, versionDirFor, managedRoot, uninstallManaged
} from "../bridge-install.mjs";
import {
  REASON, buildHealth, installRequiredHealth
} from "../bridge-health.mjs";

const EXIT = { READY: 0, ACTION_REQUIRED: 1, UNSUPPORTED: 2, ERROR: 3, USAGE: 64 };
const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "package.json"), "utf8")).version || "0.0.0"; }
  catch (_) { return "0.0.0"; }
}

function parseFlags(argv) {
  const flags = { json: false, verbose: false, scope: null, extensionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--verbose") flags.verbose = true;
    else if (a === "--scope") flags.scope = argv[++i];
    else if (a === "--extension-id") flags.extensionId = argv[++i];
    else if (a === "--help" || a === "-h") flags.help = true;
  }
  return flags;
}

function verbose(flags, ...args) {
  if (flags.verbose) process.stderr.write("[htmlgenius-bridge] " + args.map(String).join(" ") + "\n");
}
function logErr(code, message) {
  process.stderr.write("[htmlgenius-bridge] " + code + ": " + message + "\n");
}

// 输出:--json → stdout 唯一 JSON;否则人类可读文本(stdout)。
function emit(flags, obj, humanLines) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } else {
    for (const line of humanLines || []) process.stdout.write(line + "\n");
  }
}

function envHome() { return process.env.HTMLGENIUS_BRIDGE_HOME || os.homedir(); }
function envHostsDir(defaultFn) { return process.env.HTMLGENIUS_HOSTS_DIR || defaultFn(); }
function defaultHostsDirLocal() {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
}
function platformInfo() {
  const osName = process.env.HTMLGENIUS_TEST_PLATFORM || process.platform;
  return { os: osName === "darwin" ? "macos" : osName, arch: process.arch, supported: osName === "darwin" };
}
function nodeVersion() { return process.env.HTMLGENIUS_TEST_NODE_VERSION || process.versions.node; }

// 找受管根下最新(且完整)的受管版本。返回 { version, dir } | null。
function findInstalledVersion(home) {
  const versionsRoot = path.join(managedRoot(home), "versions");
  let names = [];
  try { names = fs.readdirSync(versionsRoot); } catch (_) { return null; }
  // 简单按字符串排序取最新(语义版本在受控发布下足够)
  names.sort();
  for (let i = names.length - 1; i >= 0; i--) {
    const v = names[i];
    if (/\.staging-|\.old-/.test(v)) continue;
    const check = verifyManagedVersion({ home, version: v });
    if (check.ok) return { version: v, dir: versionDirFor({ home, version: v }) };
  }
  return null;
}

// provider 探测(复用 provider-probe.mjs;测试可跳过)。独立失败域在 probeProviders 内部已保证。
async function runProviderProbes(flags) {
  if (process.env.HTMLGENIUS_TEST_SKIP_PROVIDER_PROBE === "1") return [];
  try {
    const { probeProviders } = await import("../provider-probe.mjs");
    const r = await probeProviders(["claude_code_cli", "codex_app_server", "github_copilot"]);
    return r.providers || [];
  } catch (e) {
    verbose(flags, "provider probe failed:", e && e.message);
    return [
      { id: "claude_code_cli", status: "error", capabilities: [] },
      { id: "codex_app_server", status: "error", capabilities: [] },
      { id: "github_copilot", status: "error", capabilities: [] }
    ];
  }
}

// 组装当前机器 health(doctor/repair 共用)。
async function assembleHealth({ flags, extensionId, forceBridgeStatus = null, reasonOverride = null }) {
  const home = envHome();
  const hostsDir = envHostsDir(defaultHostsDirLocal);
  const platform = platformInfo();

  if (!platform.supported) {
    return buildHealth({
      bridgeStatus: "install_required", bridgeVersion: null, managedInstall: false, protocolVersion: PROTOCOL_VERSION,
      platform, browserStatus: "unknown", providerProbes: [], reasonCode: REASON.OS_UNSUPPORTED
    });
  }
  if (!nodeEngineOk(nodeVersion())) {
    return buildHealth({
      bridgeStatus: "install_required", bridgeVersion: null, managedInstall: false, protocolVersion: PROTOCOL_VERSION,
      platform, browserStatus: "unknown", providerProbes: [], reasonCode: REASON.NODE_UNSUPPORTED,
      overallOverride: "unsupported"
    });
  }

  const installed = findInstalledVersion(home);
  let bridgeStatus, bridgeVersion = null, managedInstall = false, reasonCode = null;
  if (forceBridgeStatus) {
    bridgeStatus = forceBridgeStatus.status; bridgeVersion = forceBridgeStatus.version || null;
    managedInstall = !!installed; reasonCode = forceBridgeStatus.reason || null;
  } else if (!installed) {
    bridgeStatus = "install_required"; reasonCode = REASON.BRIDGE_NOT_INSTALLED;
  } else {
    bridgeStatus = "ready"; bridgeVersion = installed.version; managedInstall = true;
  }

  let browserStatus = "unknown";
  if (extensionId) {
    const ins = inspectExistingManifest({ hostsDir, extensionId });
    if (ins.state === "none") {
      browserStatus = "manifest_missing";
      if (bridgeStatus === "ready") { bridgeStatus = "repair_required"; reasonCode = REASON.NATIVE_HOST_MANIFEST_MISSING; }
    } else if (ins.state === "ours_match") browserStatus = "origin_ok";
    else if (ins.state === "ours_mismatch") { browserStatus = "origin_mismatch"; reasonCode = REASON.EXTENSION_ORIGIN_MISMATCH; if (bridgeStatus === "ready") bridgeStatus = "repair_required"; }
    else { browserStatus = "origin_mismatch"; reasonCode = REASON.MANIFEST_FOREIGN; if (bridgeStatus === "ready") bridgeStatus = "repair_required"; }
  }

  const providerProbes = bridgeStatus === "install_required" && !extensionId ? [] : await runProviderProbes(flags);
  return buildHealth({
    bridgeStatus, bridgeVersion, managedInstall, protocolVersion: PROTOCOL_VERSION,
    platform, browserStatus, providerProbes, reasonCode: reasonOverride || reasonCode
  });
}

function healthToHuman(health) {
  const lines = [];
  lines.push("HTML Genius Bridge: " + health.overall);
  lines.push("  bridge: " + health.bridge.status + (health.bridge.version ? " (v" + health.bridge.version + ")" : ""));
  lines.push("  platform: " + health.platform.os + "/" + health.platform.arch + (health.platform.supported ? "" : " (unsupported)"));
  lines.push("  browser registration: " + health.browser.status);
  for (const p of health.providers) {
    lines.push("  " + p.id + ": " + p.status + (p.reason_code ? " [" + p.reason_code + "]" : ""));
  }
  if (health.reason_code) lines.push("  reason: " + health.reason_code);
  return lines;
}

function exitForHealth(health) {
  if (health.overall === "ready") return EXIT.READY;
  if (health.overall === "unsupported") return EXIT.UNSUPPORTED;
  if (health.overall === "action_required") return EXIT.ACTION_REQUIRED;
  return EXIT.ERROR;
}

// ———————————————————————— 子命令 ————————————————————————

async function cmdDoctor(flags) {
  let extensionId = null;
  if (flags.extensionId) {
    try { validateExtensionId(flags.extensionId); extensionId = flags.extensionId; }
    catch (e) { logErr("INVALID_EXTENSION_ID", "extension id must be 32 lowercase letters a-p"); return EXIT.USAGE; }
  }
  const health = await assembleHealth({ flags, extensionId });
  emit(flags, health, healthToHuman(health));
  return exitForHealth(health);
}

function requireScopeAndId(flags) {
  if (flags.scope !== "user") { logErr("BAD_SCOPE", "only --scope user is supported (no root/system-wide installs)"); return { code: EXIT.USAGE }; }
  try { assertUserScope(); } catch (e) { logErr(e.code, e.message); return { code: EXIT.ERROR }; }
  if (!flags.extensionId) { logErr("MISSING_EXTENSION_ID", "--extension-id <chrome extension id> is required"); return { code: EXIT.USAGE }; }
  try { validateExtensionId(flags.extensionId); } catch (e) { logErr(e.code, "extension id must be 32 lowercase letters a-p"); return { code: EXIT.USAGE }; }
  return { extensionId: flags.extensionId };
}

function preflight(flags) {
  const platform = platformInfo();
  if (!platform.supported) { logErr(REASON.OS_UNSUPPORTED, "HTML Genius Local Bridge currently supports macOS only"); return { code: EXIT.UNSUPPORTED }; }
  if (!nodeEngineOk(nodeVersion())) { logErr(REASON.NODE_UNSUPPORTED, "Node 20.x or 22+ is required (21.x not supported), got " + nodeVersion()); return { code: EXIT.UNSUPPORTED }; }
  return {};
}

// 受管目录自装运行时依赖(npx 发行态专用):只装 dependencies(@github/copilot-sdk,精确锁版),不装 dev、不跑审计。
// 需要本机有 npm 与网络(装 bridge 本身就需要联网取包)。失败返回通用文案——npm 原始 stderr 可能含绝对路径,
// 仅原样写到用户自己的 Terminal(stderr),绝不进入 --json 输出(§3.2 成功/错误 JSON 均不含绝对路径)。
function installManagedDeps(targetDir) {
  try {
    const res = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: targetDir, encoding: "utf8", timeout: 300000
    });
    if (res.error) return { ok: false, message: "failed to start npm to install bridge dependencies" };
    if (res.status !== 0) {
      const detail = String(res.stderr || res.stdout || "").trim();
      if (detail) { try { process.stderr.write("[htmlgenius-bridge] npm install detail:\n" + detail.slice(0, 2000) + "\n"); } catch (_) {} }
      return { ok: false, message: "npm install of bridge dependencies failed (network or npm required)" };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, message: "failed to install bridge dependencies" };
  }
}

async function cmdSetup(flags) {
  const req = requireScopeAndId(flags);
  if (req.code != null) return req.code;
  const pre = preflight(flags);
  if (pre.code != null) return pre.code;
  const { extensionId } = req;
  const home = envHome();
  const hostsDir = envHostsDir(defaultHostsDirLocal);

  // origin 硬边界:已注册但 ID 不同 → 拒绝覆盖(§3.3/§6.3)
  const ins = inspectExistingManifest({ hostsDir, extensionId });
  if (ins.state === "ours_mismatch") { logErr(REASON.EXTENSION_ORIGIN_MISMATCH, "Bridge is registered for a different extension; refusing to overwrite"); return EXIT.ERROR; }
  if (ins.state === "foreign") { logErr(REASON.MANIFEST_FOREIGN, "an unrelated host occupies the HTML Genius host name; refusing to overwrite"); return EXIT.ERROR; }

  const version = pkgVersion();
  const target = versionDirFor({ home, version });

  // 幂等:受管目录完整 + 注册内容一致 → changed:false
  const verified = verifyManagedVersion({ home, version });
  if (verified.ok) {
    const launcherSource = buildLauncherSource({ nodePath: process.execPath, hostPath: path.join(target, "host.mjs"), version });
    const reg = ensureHostRegistration({ hostsDir, extensionId, launcherSource });
    if (!reg.changed) {
      emit(flags, { ok: true, changed: false, bridge: { version, protocol_version: PROTOCOL_VERSION }, overall: "ready" },
        ["HTML Genius Bridge already installed (no changes)."]);
      return EXIT.READY;
    }
  } else {
    // 物化当前 CLI 所在 bridge 到受管目录(先 staging 校验再切换)。
    // npx 发行态:包根本身无 node_modules(依赖被 npm 提升到包外层)→ 允许物化后在受管目录自装。
    const haveDeps = fs.existsSync(path.join(BRIDGE_DIR, "node_modules"));
    let materialized = null;
    try {
      materialized = materializeBridge({ sourceBridgeDir: BRIDGE_DIR, targetDir: target, version, allowMissingDeps: !haveDeps });
    } catch (e) {
      logErr(e.code || "SETUP_PREPARE_FAILED", e.message);
      return EXIT.ERROR;
    }
    if (materialized && materialized.depsMissing) {
      verbose(flags, "deps not bundled with package; installing bridge runtime dependency in managed dir");
      const inst = installManagedDeps(target);
      if (!inst.ok) { logErr("SETUP_DEPS_INSTALL_FAILED", inst.message); return EXIT.ERROR; }
    }
  }
  const launcherSource = buildLauncherSource({ nodePath: process.execPath, hostPath: path.join(target, "host.mjs"), version });
  ensureHostRegistration({ hostsDir, extensionId, launcherSource });
  verbose(flags, "setup complete: managed dir + host registration written");
  emit(flags, { ok: true, changed: true, bridge: { version, protocol_version: PROTOCOL_VERSION }, overall: "ready" },
    ["HTML Genius Bridge installed (user scope).", "  bridge version: " + version, "  registered for the given Chrome extension."]);
  return EXIT.READY;
}

async function cmdRepair(flags) {
  const req = requireScopeAndId(flags);
  if (req.code != null) return req.code;
  const pre = preflight(flags);
  if (pre.code != null) return pre.code;
  const { extensionId } = req;
  const home = envHome();
  const hostsDir = envHostsDir(defaultHostsDirLocal);

  const installed = findInstalledVersion(home);
  if (!installed) {
    const health = installRequiredHealth({ reasonCode: REASON.BRIDGE_NOT_INSTALLED });
    emit(flags, health, ["Nothing to repair: Bridge is not installed. Run setup first."]);
    return EXIT.ACTION_REQUIRED;
  }
  const ins = inspectExistingManifest({ hostsDir, extensionId });
  if (ins.state === "ours_mismatch") { logErr(REASON.EXTENSION_ORIGIN_MISMATCH, "Bridge is registered for a different extension; refusing to overwrite"); return EXIT.ERROR; }
  if (ins.state === "foreign") { logErr(REASON.MANIFEST_FOREIGN, "an unrelated host occupies the HTML Genius host name; refusing to overwrite"); return EXIT.ERROR; }

  // allow-list 修复:只重写它自身的 launcher + manifest(指向现有受管目录),不装 Node/Agent、不跑包管理器
  const launcherSource = buildLauncherSource({ nodePath: process.execPath, hostPath: path.join(installed.dir, "host.mjs"), version: installed.version });
  ensureHostRegistration({ hostsDir, extensionId, launcherSource });
  verbose(flags, "repair complete: host registration rewritten");

  const health = await assembleHealth({ flags, extensionId });
  emit(flags, health, healthToHuman(health));
  return exitForHealth(health);
}

async function cmdUninstall(flags) {
  if (flags.scope !== "user") { logErr("BAD_SCOPE", "only --scope user is supported"); return EXIT.USAGE; }
  try { assertUserScope(); } catch (e) { logErr(e.code, e.message); return EXIT.ERROR; }
  const home = envHome();
  const hostsDir = envHostsDir(defaultHostsDirLocal);
  const { removed, removedManaged } = uninstallManaged({ home, hostsDir });
  // JSON 不含路径,只报数量
  emit(flags, { ok: true, removed_host_files: removed.length, removed_managed_bridge: removedManaged },
    ["Uninstalled HTML Genius Bridge.", "  removed host files: " + removed.length, "  removed managed bridge: " + (removedManaged ? "yes" : "no")]);
  return EXIT.READY;
}

function cmdVersion(flags) {
  const obj = { name: "htmlgenius-bridge", version: pkgVersion(), protocol_version: PROTOCOL_VERSION, host_name: HOST_NAME };
  emit(flags, obj, ["htmlgenius-bridge " + obj.version + " (protocol " + PROTOCOL_VERSION + ")"]);
  return EXIT.READY;
}

const HELP = `htmlgenius-bridge — HTML Genius Local Bridge setup tool (macOS)

Usage:
  htmlgenius-bridge doctor  --json [--extension-id <id>]
  htmlgenius-bridge setup   --json --scope user --extension-id <id>
  htmlgenius-bridge repair  --json --scope user --extension-id <id>
  htmlgenius-bridge uninstall --json --scope user
  htmlgenius-bridge version --json

Exit codes: 0 ready, 1 action required, 2 unsupported, 3 error, 64 usage error.
`;

export async function main(argv) {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  if (flags.help || !cmd) { process.stdout.write(HELP); return cmd ? EXIT.READY : EXIT.USAGE; }
  switch (cmd) {
    case "doctor": return await cmdDoctor(flags);
    case "setup": return await cmdSetup(flags);
    case "repair": return await cmdRepair(flags);
    case "uninstall": return await cmdUninstall(flags);
    case "version": return cmdVersion(flags);
    default:
      logErr("UNKNOWN_COMMAND", "unknown command: " + cmd);
      process.stderr.write(HELP);
      return EXIT.USAGE;
  }
}

const invokedAs = process.argv[1] || "";
if (invokedAs.endsWith("htmlgenius-bridge.mjs") || invokedAs.endsWith("htmlgenius-bridge")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    logErr("HOST_CRASH", (e && e.message) || "unexpected error");
    process.exit(EXIT.ERROR);
  });
}
