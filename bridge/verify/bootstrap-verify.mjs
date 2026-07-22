#!/usr/bin/env node
// bridge/verify/bootstrap-verify.mjs — v0.9.1 §6:L1 Bootstrap / Native Host 自动验证。
// 在 mkdtemp 临时 HOME 与临时 hosts dir 下跑完整产品级验收序列(真实 CLI 子进程 + 真实 Native 帧),
// 绝不碰 ~/Library 或真实用户目录。不是真实 Chrome E2E —— 它验证 Chrome 真正依赖的
// manifest/launcher/Native framing 边界。失败退出非 0;report 经 §7 脱敏。
// 用法:node verify/bootstrap-verify.mjs [--report <path>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeMessage, NativeFrameDecoder } from "../native-protocol.mjs";
import { HOST_NAME, LAUNCHER_MARKER } from "../bridge-install.mjs";
import { sanitizeVerificationReport, makeReportSkeleton, finalizeReport } from "./report-sanitize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "bin", "htmlgenius-bridge.mjs");
const HOST = path.resolve(__dirname, "..", "host.mjs");
const ID_A = "abcdefghijklmnopabcdefghijklmnop";
const ID_B = "ponmlkjihgfedcbaponmlkjihgfedcba";

function bridgeVersion() {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version || "0.0.0"; }
  catch (_) { return "0.0.0"; }
}
function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 3) : 0, stdout: stdout || "", stderr: stderr || "" }));
  });
}
function oneJson(stdout) {
  const t = (stdout || "").trim();
  if (!t) throw new Error("empty stdout");
  return JSON.parse(t); // 混入进度/日志即失败(§3.2 stdout 唯一 JSON)
}
function runHostFrames(inputs, env, waitFor = 1, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const dec = new NativeFrameDecoder();
    const out = [];
    const stderr = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); try { child.stdin.end(); } catch (_) {} try { child.kill(); } catch (_) {} resolve({ out, stderr: Buffer.concat(stderr).toString("utf8") }); };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on("data", (c) => { dec.feed(c); for (const m of dec.messages()) { out.push(m); if (out.length >= waitFor) finish(); } });
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("error", reject);
    child.on("exit", () => finish());
    for (const buf of inputs) child.stdin.write(buf);
  });
}

export async function main(argv) {
  const args = argv || process.argv.slice(2);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hg-boot-home-"));
  const hostsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-boot-hosts-"));
  const env = { HTMLGENIUS_BRIDGE_HOME: home, HTMLGENIUS_HOSTS_DIR: hostsDir, HTMLGENIUS_TEST_SKIP_PROVIDER_PROBE: "1" };
  const report = makeReportSkeleton({ kind: "bootstrap", bridgeVersion: bridgeVersion(), startedAt: new Date().toISOString() });
  const checks = [];
  const add = (id, result, reason_code = null) => checks.push({ id, result, reason_code });
  const manifestPath = path.join(hostsDir, HOST_NAME + ".json");
  const launcherPath = path.join(hostsDir, HOST_NAME + ".launcher.sh");

  try {
    // 1. doctor 未安装 → BRIDGE_NOT_INSTALLED,且不在 HOME 下创建任何目录
    {
      const r = await runCli(["doctor", "--json", "--extension-id", ID_A], env);
      const j = oneJson(r.stdout);
      const noSideEffect = !fs.existsSync(path.join(home, ".htmlgenius")) && fs.readdirSync(home).length === 0;
      const ok = r.code === 1 && j.reason_code === "BRIDGE_NOT_INSTALLED" && j.bridge.status === "install_required" && noSideEffect;
      add("doctor.not_installed_no_side_effect", ok ? "passed" : "failed", ok ? null : "code=" + r.code + ",reason=" + j.reason_code + ",sideEffect=" + !noSideEffect);
    }
    // 2. setup → changed:true
    {
      const r = await runCli(["setup", "--json", "--scope", "user", "--extension-id", ID_A], env);
      const j = oneJson(r.stdout);
      const ok = r.code === 0 && j.ok === true && j.changed === true;
      add("setup.first_changed_true", ok ? "passed" : "failed", ok ? null : "code=" + r.code);
    }
    // 3. 幂等 setup → changed:false;manifest 单 origin;launcher 0700 且不指向 npx cache
    {
      const r = await runCli(["setup", "--json", "--scope", "user", "--extension-id", ID_A], env);
      const j = oneJson(r.stdout);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const launcher = fs.readFileSync(launcherPath, "utf8");
      const mode = fs.statSync(launcherPath).mode & 0o777;
      const ok = r.code === 0 && j.changed === false
        && manifest.allowed_origins.length === 1 && manifest.allowed_origins[0] === "chrome-extension://" + ID_A + "/"
        && launcher.includes(LAUNCHER_MARKER) && mode === 0o700 && !launcher.includes("npx");
      add("setup.idempotent_single_origin_0700_no_npx", ok ? "passed" : "failed", ok ? null : "code=" + r.code);
    }
    // 4. doctor → bridge ready / origin_ok
    {
      const r = await runCli(["doctor", "--json", "--extension-id", ID_A], env);
      const j = oneJson(r.stdout);
      const ok = j.bridge.status === "ready" && j.browser.status === "origin_ok";
      add("doctor.ready_origin_ok", ok ? "passed" : "failed", ok ? null : "bridge=" + j.bridge.status + ",browser=" + j.browser.status);
    }
    // 5. 换 extension ID B → EXTENSION_ORIGIN_MISMATCH,原 manifest 不动
    {
      const r = await runCli(["setup", "--json", "--scope", "user", "--extension-id", ID_B], env);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const ok = r.code !== 0 && /EXTENSION_ORIGIN_MISMATCH/.test(r.stderr)
        && manifest.allowed_origins[0] === "chrome-extension://" + ID_A + "/";
      add("setup.origin_mismatch_refused", ok ? "passed" : "failed", ok ? null : "code=" + r.code);
    }
    // 6. 破坏受管 bridge 文件 → doctor repair_required(BRIDGE_FILES_CORRUPT / NATIVE_HOST_MANIFEST_MISSING)
    {
      // 删除 manifest(注册文件缺失)
      fs.unlinkSync(manifestPath);
      const r = await runCli(["doctor", "--json", "--extension-id", ID_A], env);
      const j = oneJson(r.stdout);
      const ok = j.bridge.status === "repair_required" && (j.reason_code === "NATIVE_HOST_MANIFEST_MISSING" || j.reason_code === "BRIDGE_FILES_CORRUPT");
      add("doctor.corruption_detected", ok ? "passed" : "failed", ok ? null : "status=" + j.bridge.status + ",reason=" + j.reason_code);
    }
    // 7. repair → 仅恢复 HTML Genius 受管文件 → ready/origin_ok
    //    (退出码 1 = overall action_required:验证环境无登录 provider,属正确语义;以 health 字段判定修复成功)
    {
      const r = await runCli(["repair", "--json", "--scope", "user", "--extension-id", ID_A], env);
      const j = oneJson(r.stdout);
      const ok = (r.code === 0 || r.code === 1) && j.bridge.status === "ready" && j.browser.status === "origin_ok" && fs.existsSync(manifestPath);
      add("repair.restores_managed_files", ok ? "passed" : "failed", ok ? null : "code=" + r.code + ",bridge=" + j.bridge.status);
    }
    // 8. host 子进程真实 Native 帧:bridge_health / 允许的 repair / 未确认的 repair;stdout 只有合法帧
    {
      const h1 = await runHostFrames([encodeMessage({ type: "bridge_health", protocol_version: 1, extension: { id: ID_A, version: "0.9.1" } })], env);
      const health = h1.out[0];
      const okHealth = health && health.type === "bridge_health_result" && health.health && health.health.bridge.status === "ready";
      add("native.bridge_health_frame", okHealth ? "passed" : "failed", okHealth ? null : "BAD_FRAME");

      const h2 = await runHostFrames([encodeMessage({ type: "bridge_repair", protocol_version: 1, extension: { id: ID_A }, confirmed_actions: ["repair_native_host"] })], env);
      const rep = h2.out[0];
      const okRepair = rep && rep.type === "bridge_health_result" && rep.health && rep.health.bridge.status === "ready";
      add("native.bridge_repair_allowed", okRepair ? "passed" : "failed", okRepair ? null : "BAD_FRAME");

      const h3 = await runHostFrames([encodeMessage({ type: "bridge_repair", protocol_version: 1, extension: { id: ID_A } })], env);
      const denied = h3.out[0];
      const okDenied = denied && denied.type === "bridge_failed" && denied.code === "REPAIR_NOT_CONFIRMED";
      add("native.bridge_repair_unconfirmed_denied", okDenied ? "passed" : "failed", okDenied ? null : "code=" + (denied && denied.code));

      // stdout 纪律:每个响应都是合法帧对象(无裸日志)
      const allFrames = [...h1.out, ...h2.out, ...h3.out].every((m) => m && typeof m.type === "string");
      add("native.stdout_discipline", allFrames ? "passed" : "failed", allFrames ? null : "NON_FRAME_STDOUT");
    }
    // 9. uninstall → 只删受控标记文件;保留第三方 host 与 workspace 审计证据
    {
      // 假第三方 host + 假审计证据目录
      const thirdManifest = path.join(hostsDir, "com.third.host.json");
      fs.writeFileSync(thirdManifest, JSON.stringify({ name: "com.third.host", path: "/t.sh", type: "stdio", allowed_origins: ["*"] }));
      const auditDir = path.join(home, "audit-evidence");
      fs.mkdirSync(auditDir, { recursive: true });
      fs.writeFileSync(path.join(auditDir, "task-x.json"), "{}");
      const r = await runCli(["uninstall", "--json", "--scope", "user"], env);
      const j = oneJson(r.stdout);
      const ok = r.code === 0 && j.ok === true
        && !fs.existsSync(manifestPath) && !fs.existsSync(launcherPath)
        && fs.existsSync(thirdManifest) && fs.existsSync(auditDir);
      add("uninstall.only_managed_removed", ok ? "passed" : "failed", ok ? null : "code=" + r.code);
    }
    // 10. report/stdout 脱敏扫描:不得含 temp 路径 / 真实 HOME / 敏感键
    {
      const leaks = [];
      const json = JSON.stringify(sanitizeVerificationReport({ checks }));
      for (const p of [home, hostsDir, os.homedir()]) {
        if (p && json.includes(p)) leaks.push("LEAKS_PATH");
      }
      for (const k of ["stderr", "stdout", "token", "cookie", "stack", "command"]) {
        if (json.includes('"' + k + '"')) leaks.push("LEAKS_KEY:" + k);
      }
      add("report.sanitized", leaks.length ? "failed" : "passed", leaks.length ? leaks[0] : null);
    }
  } catch (e) {
    add("bootstrap.crash", "failed", "SEQUENCE_CRASH");
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(hostsDir, { recursive: true, force: true }); } catch (_) {}
  }

  report.providers = [{ id: "bootstrap", result: checks.some((c) => c.result === "failed") ? "failed" : "passed", capabilities: [], checks }];
  finalizeReport(report);
  const clean = sanitizeVerificationReport(report);
  const rIdx = args.indexOf("--report");
  const outPath = rIdx > -1 ? args[rIdx + 1] : path.resolve(__dirname, "..", "artifacts", "verification", "bootstrap-verification.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(clean, null, 2) + "\n");

  process.stdout.write("bootstrap verification: " + clean.result + " — " + clean.summary.passed + " passed / " + clean.summary.failed + " failed\n");
  for (const c of checks) process.stdout.write("  [" + c.result + "] " + c.id + (c.reason_code ? " (" + c.reason_code + ")" : "") + "\n");
  process.stdout.write("report written (sanitized)\n");
  return clean.result === "passed" ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("bootstrap-verify.mjs")) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write("bootstrap-verify crashed: " + (e && e.message) + "\n"); process.exit(3); });
}
