// bridge/bridge-install.mjs — v0.9 §3.3/§7A 共享安装核心:**安装规则唯一实现源**。
// install-macos.mjs(开发兼容路径)与 bin/htmlgenius-bridge.mjs(产品 CLI)都调用本模块,不双写 manifest/launcher 规则。
//
// 职责:extension ID 严格校验、Node engine 校验、用户 scope 校验、manifest/launcher 构建(受控标记)、
//       原子写入(临时文件→rename,失败无半写 manifest)、受管版本化布局(~/.htmlgenius/bridge/versions/<v>/)、
//       幂等 setup、V0.8.2 迁移与 origin 硬边界、只删自家文件的卸载。
//
// 安全(§6):只写用户级 HTML Genius 目录与 Chrome host manifest;单 extension origin,无 wildcard;
//           origin 不匹配拒绝覆盖;launcher 带受控标记,卸载不盲删第三方 host;不含 shell 拼接。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const HOST_NAME = "com.htmlgenius.local_bridge";
// launcher 受控标记:卸载/迁移只认带此标记(或被本 manifest 引用)的 launcher,绝不盲删第三方 host 文件。
export const LAUNCHER_MARKER = "# htmlgenius-managed-bridge";
// bridge ↔ extension 协议版本(v0.9 起统一;health/host/background 共用)。
export const PROTOCOL_VERSION = 1;
// 用户级受管根目录(相对 $HOME):~/.htmlgenius/bridge/versions/<version>/
export const MANAGED_SUBDIR = path.join(".htmlgenius", "bridge");

export function defaultHostsDir() {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
}
export function managedRoot(home = os.homedir()) {
  return path.join(home, MANAGED_SUBDIR);
}
export function versionDirFor({ home = os.homedir(), version }) {
  if (typeof version !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
    const e = new Error("invalid bridge version"); e.code = "BAD_VERSION"; throw e;
  }
  return path.join(managedRoot(home), "versions", version);
}

// Chrome 扩展 ID:32 个小写字母 a-p(延续 V0.8.2 严格校验)。
export function validateExtensionId(id) {
  if (typeof id !== "string" || !/^[a-p]{32}$/.test(id)) {
    const err = new Error("invalid chrome extension id");
    err.code = "INVALID_EXTENSION_ID";
    throw err;
  }
  return id;
}

// Node ^20.19.0 || >=22.12.0(@github/copilot-sdk engines;不能简化为 Node 20+)。
export function nodeEngineOk(version = process.versions.node) {
  const [maj, min] = String(version).split(".").map((n) => Number(n));
  if (!Number.isInteger(maj)) return false;
  if (maj === 20) return min >= 19;
  if (maj === 21) return false;
  return maj > 22 || min >= 12;
}

// §3.2:setup/repair 只接受 --scope user;拒绝 root(不做 system-wide 安装)。
export function assertUserScope() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const e = new Error("root/system-wide scope is not supported; run as a normal user with --scope user");
    e.code = "ROOT_SCOPE_UNSUPPORTED"; throw e;
  }
}

export function assertMacOS(platform = process.platform) {
  if (platform !== "darwin") {
    const e = new Error("HTML Genius Local Bridge currently supports macOS only");
    e.code = "OS_UNSUPPORTED"; throw e;
  }
}

// 单 origin host manifest(硬边界:只允许传入的那一个扩展,无 wildcard)。
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

// 常见 CLI 安装目录(GUI Chrome 的 PATH 极简,launcher 需要 prepend;home 运行时解析)。
export const COMMON_PATH_DIRS = [
  "~/.local/bin", "~/.npm-global/bin", "~/.cargo/bin", "~/.copilot/bin",
  "/opt/homebrew/bin", "/usr/local/bin"
];

function resolveHomeDir(d, home) {
  if (d === "~") return home;
  if (d.startsWith("~/")) return path.join(home, d.slice(2));
  return d;
}

// launcher 源码:受控标记行 + PATH prepend + exec 绝对 node + 绝对 host.mjs。无 shell 拼接;路径含单引号即拒。
export function buildLauncherSource({ nodePath, hostPath, extraPathDirs = [], home = process.env.HOME || "", version = "" }) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(hostPath)) {
    const err = new Error("node/host paths must be absolute"); err.code = "PATH_NOT_ABSOLUTE"; throw err;
  }
  if (nodePath.includes("'") || hostPath.includes("'")) {
    const err = new Error("path contains single quote; refusing to write shell launcher"); err.code = "UNSAFE_PATH"; throw err;
  }
  const dirs = [path.dirname(nodePath)];
  for (const d of extraPathDirs || []) {
    if (!d) continue;
    const r = resolveHomeDir(d, home);
    if (r && r !== "/" && !dirs.includes(r)) dirs.push(r);
  }
  for (const d of COMMON_PATH_DIRS) {
    const r = resolveHomeDir(d, home);
    if (r && r !== "/" && !dirs.includes(r)) dirs.push(r);
  }
  const safePath = dirs.filter((d) => !/['"$\n]/.test(d)).join(":");
  const marker = LAUNCHER_MARKER + (version ? " v" + version : "") + " protocol=" + PROTOCOL_VERSION;
  return "#!/bin/sh\n" + marker + "\nexport PATH=\"" + safePath + ":$PATH\"\nexec '" + nodePath + "' '" + hostPath + "' \"$@\"\n";
}

export function launcherHasMarker(src) {
  return typeof src === "string" && src.includes(LAUNCHER_MARKER);
}

// 原子写:临时文件 → chmod → rename。任何失败不留半写目标文件。
let _tmpSeq = 0;
export function writeFileAtomic(targetPath, content, mode) {
  const tmp = targetPath + ".hg-tmp-" + process.pid + "-" + (_tmpSeq++);
  let written = false;
  try {
    fs.writeFileSync(tmp, content, { mode });
    written = true;
    try { fs.chmodSync(tmp, mode); } catch (_) {}
    fs.renameSync(tmp, targetPath);
  } finally {
    if (written) { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
}

// ———————————————————————— 受管布局:materialize + verify ————————————————————————

// 把 bridge 运行时(源码 + node_modules)物化到受管版本目录。排除测试与系统杂物。
// 先写 staging,校验通过再切换;失败清理 staging,不碰既有安装。
export function materializeBridge({ sourceBridgeDir, targetDir, version }) {
  if (!path.isAbsolute(sourceBridgeDir) || !path.isAbsolute(targetDir)) {
    const e = new Error("bridge/target dir must be absolute"); e.code = "PATH_NOT_ABSOLUTE"; throw e;
  }
  const staging = targetDir + ".staging-" + process.pid;
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
  try {
    fs.cpSync(sourceBridgeDir, staging, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (base === "test" || base === ".DS_Store") return false;
        return true;
      }
    });
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    const err = new Error("failed to materialize bridge files"); err.code = "SETUP_PREPARE_FAILED"; throw err;
  }
  // 校验:host.mjs / package.json 必须存在;有依赖声明则 node_modules 必须就位(否则提示 npm install,不猜命令)
  const hostOk = isReadableFile(path.join(staging, "host.mjs"));
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(staging, "package.json"), "utf8")); } catch (_) {}
  if (!hostOk || !pkg) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    const e = new Error("bridge source is incomplete (host.mjs / package.json missing)"); e.code = "BRIDGE_FILES_CORRUPT"; throw e;
  }
  if (pkg.dependencies && Object.keys(pkg.dependencies).length && !isDir(path.join(staging, "node_modules"))) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    const e = new Error("bridge dependencies are not installed; run `npm install` in the bridge directory first"); e.code = "SETUP_DEPS_MISSING"; throw e;
  }
  // 受管标记文件(供 doctor/repair 识别受管安装;不含任何用户数据)
  fs.writeFileSync(path.join(staging, "managed-install.json"),
    JSON.stringify({ managed_by: "htmlgenius-bridge", version: String(version || pkg.version || ""), protocol_version: PROTOCOL_VERSION }, null, 2) + "\n",
    { mode: 0o600 });

  // 切换:旧版本目录先挪开,切换成功后删除;失败则还原
  const backup = targetDir + ".old-" + process.pid;
  const hadOld = isDir(targetDir);
  try {
    if (hadOld) fs.renameSync(targetDir, backup);
    fs.renameSync(staging, targetDir);
  } catch (e) {
    try { if (hadOld && !isDir(targetDir)) fs.renameSync(backup, targetDir); } catch (_) {}
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    const err = new Error("failed to switch managed bridge directory"); err.code = "SETUP_PREPARE_FAILED"; throw err;
  }
  if (hadOld) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) {} }
  try { fs.chmodSync(targetDir, 0o700); } catch (_) {}
  return { version: String(version || pkg.version || "") };
}

// 校验某受管版本目录是否完整可用。返回 { ok, version?, code? }。
export function verifyManagedVersion({ home, version }) {
  let dir;
  try { dir = versionDirFor({ home, version }); } catch (e) { return { ok: false, code: "BAD_VERSION" }; }
  if (!isReadableFile(path.join(dir, "host.mjs"))) return { ok: false, code: "BRIDGE_FILES_CORRUPT" };
  try { JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }
  catch (_) { return { ok: false, code: "BRIDGE_FILES_CORRUPT" }; }
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, "managed-install.json"), "utf8")); } catch (_) {}
  if (!marker || marker.managed_by !== "htmlgenius-bridge") return { ok: false, code: "BRIDGE_FILES_CORRUPT" };
  return { ok: true, version: marker.version || version };
}

function isReadableFile(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// ———————————————————————— origin 硬边界(迁移/覆盖保护)————————————————————————

// 若 hostsDir 已存在同名 manifest:校验 origin。不匹配 → EXTENSION_ORIGIN_MISMATCH(拒绝覆盖);
// 名称冲突但非本 host → MANIFEST_FOREIGN。返回 { state: "none"|"ours_match"|"ours_mismatch"|"foreign" }。
export function inspectExistingManifest({ hostsDir, extensionId }) {
  const mp = path.join(hostsDir, HOST_NAME + ".json");
  let raw;
  try { raw = fs.readFileSync(mp, "utf8"); } catch (_) { return { state: "none", manifestPath: mp }; }
  let m = null;
  try { m = JSON.parse(raw); } catch (_) { m = null; }
  if (!m || m.name !== HOST_NAME) return { state: "foreign", manifestPath: mp };
  const expected = "chrome-extension://" + extensionId + "/";
  const origins = Array.isArray(m.allowed_origins) ? m.allowed_origins : [];
  if (origins.length === 1 && origins[0] === expected) return { state: "ours_match", manifestPath: mp, manifest: m };
  return { state: "ours_mismatch", manifestPath: mp, manifest: m };
}

// ———————————————————————— 注册文件写入 / 移除 ————————————————————————

export function hostFilePaths(hostsDir) {
  return {
    manifestPath: path.join(hostsDir, HOST_NAME + ".json"),
    launcherPath: path.join(hostsDir, HOST_NAME + ".launcher.sh")
  };
}

// 幂等写入 launcher + manifest(原子);内容一致则不写。返回 { changed }。
export function ensureHostRegistration({ hostsDir, extensionId, launcherSource }) {
  const { manifestPath, launcherPath } = hostFilePaths(hostsDir);
  const launcherExpected = launcherSource;
  const manifestExpected = JSON.stringify(buildManifest({ extensionId, launcherPath }), null, 2) + "\n";
  let sameLauncher = false, sameManifest = false;
  try { sameLauncher = fs.readFileSync(launcherPath, "utf8") === launcherExpected; } catch (_) {}
  try { sameManifest = fs.readFileSync(manifestPath, "utf8") === manifestExpected; } catch (_) {}
  if (sameLauncher && sameManifest) return { changed: false, manifestPath, launcherPath };
  fs.mkdirSync(hostsDir, { recursive: true });
  writeFileAtomic(launcherPath, launcherExpected, 0o700);
  writeFileAtomic(manifestPath, manifestExpected, 0o644);
  return { changed: true, manifestPath, launcherPath };
}

// 只移除本工具拥有的 host 文件:manifest 需 name 匹配;launcher 需带受控标记或被本 manifest 引用。
// 绝不按文件名盲删第三方 host(§3.3)。返回 { removed: [] }。
export function removeHostFiles({ hostsDir }) {
  const { manifestPath, launcherPath } = hostFilePaths(hostsDir);
  const removed = [];
  let manifestOurs = false;
  let referencedLauncher = null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (m && m.name === HOST_NAME) {
      manifestOurs = true;
      if (typeof m.path === "string") referencedLauncher = m.path;
    }
  } catch (_) { /* manifest 缺失或不可解析 → 不动它 */ }
  // launcher:受控标记 或 被我方 manifest 引用
  try {
    const src = fs.readFileSync(launcherPath, "utf8");
    const referenced = !!referencedLauncher && path.resolve(referencedLauncher) === path.resolve(launcherPath);
    if (launcherHasMarker(src) || referenced) {
      fs.unlinkSync(launcherPath);
      removed.push(launcherPath);
    }
  } catch (_) {}
  if (manifestOurs) {
    try { fs.unlinkSync(manifestPath); removed.push(manifestPath); } catch (_) {}
  }
  return { removed };
}

// 卸载:移除受管 host 文件 + 受管 bridge 目录;不删工作区审计证据(.htmlgenius-bridge 在源文件旁,与此无关),不删任何 Agent。
export function uninstallManaged({ home = os.homedir(), hostsDir = defaultHostsDir() }) {
  const { removed } = removeHostFiles({ hostsDir });
  let removedManaged = false;
  const root = managedRoot(home);
  try {
    if (isDir(root)) { fs.rmSync(root, { recursive: true, force: true }); removedManaged = true; }
  } catch (_) {}
  return { removed, removedManaged };
}
