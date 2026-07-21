// bridge/test/plan-workspace.test.mjs — v0.8.1 plan workspace 协议(spec §6.2/§6.3/§9 Bridge)。
// 覆盖:preparePlanRun(snapshot+task+output)、validatePlanJson 全失败模式、verifyTaskBundleUnchanged、writePlanManifest。
// plan run 绝不创建 candidate sibling / candidate.html(物理隔离)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  preparePlanRun, validatePlanJson, verifyTaskBundleUnchanged, writePlanManifest, quarantinePlan, PLAN_MAX_JSON_BYTES
} from "../plan-workspace.mjs";
import { sha256File } from "../candidate-workspace.mjs";

function mkSrc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-pw-"));
  const src = path.join(dir, "report.html");
  fs.writeFileSync(src, "<!doctype html><html><body>hello</body></html>");
  return { dir, src };
}
function mkWorkspace(src) {
  const ws = path.join(path.dirname(src), ".htmlgenius-bridge", "claude", "hgd_pw");
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}
function mkTaskFiles(ws) {
  const json = path.join(ws, "task-hgr_pw0123456789.json");
  const md = path.join(ws, "task-hgr_pw0123456789.md");
  fs.writeFileSync(json, '{"schema_version":1}', { mode: 0o600 });
  fs.writeFileSync(md, "# task", { mode: 0o600 });
  return { json, md };
}
function goodPlanJson() {
  return { schema_version: 1, kind: "htmlgenius_change_plan", summary: "目标", plan_markdown: "1. 改 a", out_of_scope: [] };
}

test("preparePlanRun:建 plans/<runId>/ + source snapshot(0400)+ output/(0700)+ task 复制;返回 source/task hash", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  assert.ok(fs.existsSync(prep.plansDir), "plans/<runId>/ 创建");
  assert.ok(fs.existsSync(path.join(prep.plansDir, "source.html")), "source snapshot");
  assert.ok(fs.existsSync(path.join(prep.plansDir, "output")), "output/ 创建");
  assert.ok(fs.existsSync(path.join(prep.plansDir, "task-hgr_pw0123456789.json")), "task json 复制");
  assert.equal(prep.sourceSha256Before, sha256File(src));
  assert.equal(prep.taskSha256Before, sha256File(path.join(prep.plansDir, "task-hgr_pw0123456789.json")));
  // snapshot 只读 0400
  const mode = (fs.statSync(path.join(prep.plansDir, "source.html")).mode & 0o777);
  assert.equal(mode, 0o400);
});

test("preparePlanRun:plan 目录里绝不预建 candidate.html(与 candidate 工作区物理隔离)", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  assert.ok(!fs.existsSync(path.join(prep.plansDir, "candidate.html")), "plan 目录无 candidate.html");
});

test("validatePlanJson:合法 → {plan, planSha256}", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  fs.writeFileSync(prep.planJsonPath, JSON.stringify(goodPlanJson()));
  const r = validatePlanJson(prep.planJsonPath);
  assert.deepEqual(r.plan.summary, "目标");
  assert.match(r.planSha256, /^sha256:[0-9a-f]{64}$/);
});

test("validatePlanJson:缺失 → PLAN_MISSING", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  // 不写 plan.json
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_MISSING");
});

test("validatePlanJson:symlink → PLAN_SYMLINK", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  const elsewhere = path.join(prep.plansDir, "evil.json");
  fs.writeFileSync(elsewhere, JSON.stringify(goodPlanJson()));
  fs.symlinkSync(elsewhere, prep.planJsonPath);
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_SYMLINK");
});

test("validatePlanJson:空文件 → PLAN_INVALID;非 JSON → PLAN_INVALID;BOM → PLAN_INVALID", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  fs.writeFileSync(prep.planJsonPath, "");
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_INVALID");
  fs.writeFileSync(prep.planJsonPath, "{not json");
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_INVALID");
  fs.writeFileSync(prep.planJsonPath, "﻿" + JSON.stringify(goodPlanJson()));
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_INVALID");
});

test("validatePlanJson:未知字段 / schema_version 错 / summary 空 / plan_markdown 超长 → PLAN_INVALID", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  const cases = [
    { ...goodPlanJson(), secret: "leak" },
    { ...goodPlanJson(), schema_version: 2 },
    { ...goodPlanJson(), summary: "" },
    { ...goodPlanJson(), plan_markdown: "x".repeat(12 * 1024 + 1) }
  ];
  for (const c of cases) {
    fs.writeFileSync(prep.planJsonPath, JSON.stringify(c));
    assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_INVALID", "应拒绝: " + JSON.stringify(c).slice(0, 60));
  }
});

test("validatePlanJson:超 16 KiB → PLAN_TOO_LARGE", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  fs.writeFileSync(prep.planJsonPath, "x".repeat(PLAN_MAX_JSON_BYTES + 1));
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_TOO_LARGE");
});

test("validatePlanJson:plan.json 是目录 → PLAN_OUTPUT_PATH_INVALID", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  fs.mkdirSync(prep.planJsonPath); // 目录
  assert.throws(() => validatePlanJson(prep.planJsonPath), (e) => e.code === "PLAN_OUTPUT_PATH_INVALID");
});

test("verifyTaskBundleUnchanged:未变 → 通过;被改 → TASK_MUTATED_DURING_PLAN;缺失 → TASK_MUTATED_DURING_PLAN", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  // 未变
  assert.doesNotThrow(() => verifyTaskBundleUnchanged({ plansDir: prep.plansDir, taskJsonName: prep.taskJsonName, taskSha256Before: prep.taskSha256Before }));
  // 被改(注意 task json 是 0400 只读,测试用 chmod 后写)
  const dst = path.join(prep.plansDir, prep.taskJsonName);
  fs.chmodSync(dst, 0o600); fs.writeFileSync(dst, '{"schema_version":1,"mutated":true}'); fs.chmodSync(dst, 0o400);
  assert.throws(() => verifyTaskBundleUnchanged({ plansDir: prep.plansDir, taskJsonName: prep.taskJsonName, taskSha256Before: prep.taskSha256Before }), (e) => e.code === "TASK_MUTATED_DURING_PLAN");
});

test("writePlanManifest:ready 含 plan 块;failed 不含 plan 正文但含 errorCode", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  const mpReady = writePlanManifest({ plansDir: prep.plansDir, runId: "hgr_pw0123456789", logicalDocumentId: "hgd_pw", provider: "claude_code_cli", sourcePath: src, sourceSha256Before: prep.sourceSha256Before, taskSha256: "sha256:x", planSha256: "sha256:y", planByteLength: 42, status: "ready" });
  const ready = JSON.parse(fs.readFileSync(mpReady, "utf8"));
  assert.equal(ready.status, "ready");
  assert.equal(ready.kind, "htmlgenius_plan_manifest");
  assert.equal(ready.plan && ready.plan.sha256, "sha256:y");
  assert.equal(ready.error_code, null);
  // failed
  const mpFail = writePlanManifest({ plansDir: prep.plansDir, runId: "hgr_pw0123456789", logicalDocumentId: "hgd_pw", provider: "claude_code_cli", sourcePath: src, sourceSha256Before: prep.sourceSha256Before, taskSha256: "sha256:x", status: "failed", errorCode: "PLAN_INVALID" });
  const failed = JSON.parse(fs.readFileSync(mpFail, "utf8"));
  assert.equal(failed.plan, null, "失败 manifest 不含 plan 正文");
  assert.equal(failed.error_code, "PLAN_INVALID");
});

test("quarantinePlan:删 output/plan.json 但保留目录(供失败 manifest)", () => {
  const { src } = mkSrc();
  const ws = mkWorkspace(src);
  const { json, md } = mkTaskFiles(ws);
  const prep = preparePlanRun({ sourcePath: src, workspaceRoot: ws, logicalDocumentId: "hgd_pw", runId: "hgr_pw0123456789", taskJsonPath: json, taskMdPath: md });
  fs.writeFileSync(prep.planJsonPath, JSON.stringify(goodPlanJson()));
  quarantinePlan(prep.plansDir);
  assert.ok(!fs.existsSync(prep.planJsonPath), "plan.json 被清理");
  assert.ok(fs.existsSync(prep.plansDir), "目录保留");
});
