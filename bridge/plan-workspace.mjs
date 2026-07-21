// bridge/plan-workspace.mjs — v0.8.1 plan run 的工作区与受控 plan.json 协议(spec §6.2/§6.3/§6.7)。
// 与 candidate-workspace.mjs 并列:plan run 独立目录 plans/<runId>/,绝不与 candidate run 的 runs/<runId>/ 混用
// (避免 candidate.html 被错误接受为 plan 输出)。Agent 唯一允许的输出是 output/plan.json。
//
// 关键不变量(§6.2):
// - 目录 0700;source.html 是真实源的只读 snapshot(0400),Agent 不获得真实源路径;
// - 运行前后都重算真实 source hash + task hash;任一变化 → SOURCE/TASK_MUTATED_DURING_PLAN,计划废弃;
// - 只读唯一的 output/plan.json;拒绝 symlink/目录/空/超长/路径逃逸;
// - plan.json v1 schema 复用 extension/plan-validate.js 的 validatePlanSchema(host 与 background 同一真相源)。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveSourcePath, assertSafeRunId, sha256Bytes, sha256File } from "./candidate-workspace.mjs";

const require = createRequire(import.meta.url);
const { validatePlanSchema } = require("../extension/plan-validate.js");

export const PLAN_MAX_JSON_BYTES = 16 * 1024; // §6.3:plan.json 整体最大 16 KiB

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}

// 建立 plans/<runId>/(0700)+ source snapshot(0400)+ task 复制(0400)+ output/(0700)。
// 返回运行前 source/task hash 供运行后比对(spec §6.2)。
export function preparePlanRun({ sourcePath, workspaceRoot, logicalDocumentId, runId, taskJsonPath, taskMdPath }) {
  assertSafeRunId(runId);
  const realSource = resolveSourcePath(sourcePath);
  const plansRoot = path.join(workspaceRoot, "plans");
  const plansDir = path.join(plansRoot, runId);
  // 路径穿越防御:plansDir 的 realpath 必须落在 workspaceRoot/plans 下
  fs.mkdirSync(plansDir, { recursive: true });
  fs.chmodSync(plansDir, 0o700);
  const realPlans = fs.realpathSync(plansDir);
  const realPlansRoot = fs.realpathSync(plansRoot);
  if (realPlans !== realPlansRoot && !realPlans.startsWith(realPlansRoot + path.sep)) {
    try { fs.rmSync(plansDir, { recursive: true, force: true }); } catch (_) {}
    fail("PLANS_PATH_ESCAPE", "plans dir escapes workspace: " + plansDir);
  }
  const snapshotPath = path.join(plansDir, "source.html");
  const outputDir = path.join(plansDir, "output");
  const planJsonPath = path.join(outputDir, "plan.json");
  const sourceSha256Before = sha256File(realSource);
  fs.copyFileSync(realSource, snapshotPath);
  fs.chmodSync(snapshotPath, 0o400); // 只读 snapshot
  if (sha256File(snapshotPath) !== sourceSha256Before) {
    try { fs.rmSync(plansDir, { recursive: true, force: true }); } catch (_) {}
    fail("SNAPSHOT_HASH_MISMATCH", "source snapshot hash differs from source after copy");
  }
  // task bundle 复制进 plan cwd(只读)
  let taskJsonName = null, taskMdName = null, taskSha256Before = null;
  if (taskJsonPath) {
    taskJsonName = path.basename(taskJsonPath);
    const dst = path.join(plansDir, taskJsonName);
    fs.copyFileSync(taskJsonPath, dst); fs.chmodSync(dst, 0o400);
    taskSha256Before = sha256File(dst);
  }
  if (taskMdPath) {
    taskMdName = path.basename(taskMdPath);
    const dst = path.join(plansDir, taskMdName);
    fs.copyFileSync(taskMdPath, dst); fs.chmodSync(dst, 0o400);
  }
  // output/ 给 Agent 写 plan.json(0700)
  fs.mkdirSync(outputDir, { recursive: true });
  fs.chmodSync(outputDir, 0o700);
  return {
    plansDir, snapshotPath, outputDir, planJsonPath,
    sourceSha256Before, sourceByteLength: fs.statSync(realSource).size, realSource,
    taskJsonName, taskMdName, taskSha256Before
  };
}

// 运行后比对 task bundle hash(spec §6.2:task 文件运行前后 SHA 必须一致)。变化 → TASK_MUTATED_DURING_PLAN。
export function verifyTaskBundleUnchanged({ plansDir, taskJsonName, taskSha256Before }) {
  if (!taskJsonName || !taskSha256Before) return;
  const dst = path.join(plansDir, taskJsonName);
  let lst;
  try { lst = fs.lstatSync(dst); }
  catch (e) { fail("TASK_MUTATED_DURING_PLAN", "task json missing after plan run"); }
  if (!lst.isFile() || lst.isSymbolicLink()) fail("TASK_MUTATED_DURING_PLAN", "task json tampered after plan run");
  if (sha256File(dst) !== taskSha256Before) fail("TASK_MUTATED_DURING_PLAN", "task json hash changed during plan run");
}

// 校验 output/plan.json(spec §6.2/§6.3):存在/regular/非 symlink/非空/≤16KiB/路径未逃逸/合法 JSON/schema v1。
// 返回 { plan, planSha256, byteLength }。plan_sha256 用文件原始字节算(Host 不可编辑原计划的指纹)。
export function validatePlanJson(planJsonPath) {
  let lst;
  try { lst = fs.lstatSync(planJsonPath); }
  catch (e) { fail("PLAN_MISSING", "output/plan.json not produced: " + planJsonPath); }
  if (lst.isSymbolicLink()) fail("PLAN_SYMLINK", "plan.json must not be a symlink");
  if (!lst.isFile()) fail("PLAN_OUTPUT_PATH_INVALID", "plan.json must be a regular file");
  if (lst.size === 0) fail("PLAN_INVALID", "plan.json is empty");
  if (lst.size > PLAN_MAX_JSON_BYTES) fail("PLAN_TOO_LARGE", "plan.json > 16 KiB: " + lst.size);
  // 路径逃逸:realpath 必须恰为 <outputDir>/plan.json
  const real = fs.realpathSync(planJsonPath);
  const realOutput = fs.realpathSync(path.dirname(planJsonPath));
  if (real !== path.join(realOutput, "plan.json")) {
    fail("PLAN_OUTPUT_PATH_INVALID", "plan.json path escapes output dir");
  }
  const buf = fs.readFileSync(planJsonPath);
  const text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) fail("PLAN_INVALID", "plan.json must not start with a BOM");
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { fail("PLAN_INVALID", "plan.json is not valid JSON: " + (e && e.message)); }
  const v = validatePlanSchema(obj);
  if (!v.ok) fail("PLAN_INVALID", "plan.json schema rejected: " + v.field);
  return { plan: obj, planSha256: sha256Bytes(buf), byteLength: lst.size };
}

// 写 plan-manifest.json(spec §6.7):ready 与失败 status 都写;失败 manifest 不含 plan 正文。
export function writePlanManifest({ plansDir, runId, logicalDocumentId, provider, sourcePath, sourceSha256Before, sourceSha256After, taskSha256, planSha256, planByteLength, status, errorCode }) {
  const manifest = {
    schema_version: 1,
    kind: "htmlgenius_plan_manifest",
    run_id: runId,
    logical_document_id: logicalDocumentId,
    provider: provider || "claude_code_cli",
    source: { path: sourcePath, sha256_before: sourceSha256Before, sha256_after: sourceSha256After || null },
    task_sha256: taskSha256 || null,
    plan: status === "ready" ? { sha256: planSha256 || null, byte_length: planByteLength || 0 } : null,
    error_code: errorCode || null,
    created_at: new Date().toISOString(),
    status: status
  };
  const mp = path.join(plansDir, "plan-manifest.json");
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try { fs.chmodSync(mp, 0o600); } catch (_) {}
  return mp;
}

// 失败时清理 output/plan.json(不留下半成品);目录保留以写失败 manifest(spec §6.7)。
export function quarantinePlan(plansDir) {
  const pj = path.join(plansDir, "output", "plan.json");
  try { if (fs.existsSync(pj)) fs.unlinkSync(pj); } catch (_) {}
}
