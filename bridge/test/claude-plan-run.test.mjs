// bridge/test/claude-plan-run.test.mjs — v0.8.1 Claude plan 执行编排(spec §6.5/§6.8/§9 Bridge)。
// 注入 makeFakeClaude(对象级):plan run 写 output/plan.json;验证 plan-ready、绝不产 candidate/sibling、
// source/task 运行期改动失败、缺失/无效 plan 失败、approved_plan 写只读 approved-plan.md。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executePlanRun, executeCandidateRun } from "../host-runner.mjs";
import { sha256File } from "../candidate-workspace.mjs";
import { makeFakeClaude } from "./fake-claude.mjs";

function mkFix(mode = "precise_patch") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cplan-"));
  const src = path.join(dir, "report.html");
  fs.writeFileSync(src, "<!doctype html><html><body>hello world</body></html>");
  const root = path.join(dir, ".htmlgenius-bridge", "claude", "hgd_cp");
  fs.mkdirSync(root, { recursive: true });
  const task = {
    schema_version: 1, kind: "htmlgenius_change_contract", mode,
    artifact: { title: "T", url: pathToFileURL(src).href, is_local: true },
    source: { root_annotation_ids: ["r1"], root_annotation_count: 1 },
    annotations: [{ id: "r1", quote: "hello", comment: "change it", selector: { exact: "hello" }, replies: [] }],
    brief: "", preserve: [], contract: { write_scope: "target_only", locked_outside_scope: true, on_ambiguous_target: "ask_or_stop", verification: ["v"] }
  };
  return { dir, src, root, task, hash: sha256File(src) };
}
function baseMsg(fix, runId = "hgr_cp0123456789") {
  return { run_id: runId, run_kind: "plan", source: { logical_document_id: "hgd_cp", artifact_uri: pathToFileURL(fix.src).href, base_artifact_hash: fix.hash }, session: { mode: "new", session_id: null }, task: fix.task };
}
function collect() { const events = []; return { events, emit: (e) => events.push(e) }; }
function goodPlan() { return { schema_version: 1, kind: "htmlgenius_change_plan", summary: "目标", plan_markdown: "1. 改 a\n2. 改 b", out_of_scope: ["不改 footer"] }; }

test("plan 成功:fake 写 output/plan.json → plan-ready + ready manifest;绝不产 candidate/sibling", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "output", "plan.json"), JSON.stringify(goodPlan())) });
  const { events, emit } = collect();
  await executePlanRun(baseMsg(fix), { emit, claude });
  const ready = events.find((e) => e.type === "plan-ready");
  assert.ok(ready, "emit plan-ready");
  assert.ok(claude.calls.runHandoff.length, "runHandoff 被调用");
  assert.match(ready.task_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(ready.plan_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ready.plan.summary, "目标");
  assert.equal(ready.logical_document_id, "hgd_cp");
  assert.equal(ready.source_sha256_before, fix.hash);
  assert.equal(claude.calls.runHandoff[0].runKind, "plan", "runHandoff 以 runKind=plan 调用");
  // 绝不产 candidate
  assert.ok(!events.some((e) => e.type === "candidate-ready"), "plan run 不发 candidate-ready");
  assert.ok(!fs.existsSync(path.join(fix.dir, "report--htmlgenius-hgr_cp0123456789.candidate.html")), "plan run 不创建 sibling candidate");
  // manifest ready
  const mp = path.join(fix.root, "plans", "hgr_cp0123456789", "plan-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.kind, "htmlgenius_plan_manifest");
  assert.equal(manifest.plan && manifest.plan.sha256, ready.plan_sha256);
});

test("plan 未写 output/plan.json → PLAN_MISSING,无 plan-ready", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: () => {} });
  const { events, emit } = collect();
  await executePlanRun(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "PLAN_MISSING");
  assert.ok(!events.some((e) => e.type === "plan-ready"));
});

test("plan 写无效 JSON / 未知字段 → PLAN_INVALID", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "output", "plan.json"), "{not json") });
  const c1 = collect();
  await executePlanRun(baseMsg(fix), { emit: c1.emit, claude });
  assert.equal(c1.events.find((e) => e.type === "bridge_failed").code, "PLAN_INVALID");
  const fix2 = mkFix();
  const claude2 = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "output", "plan.json"), JSON.stringify({ ...goodPlan(), evil: 1 })) });
  const c2 = collect();
  await executePlanRun(baseMsg(fix2), { emit: c2.emit, claude: claude2 });
  assert.equal(c2.events.find((e) => e.type === "bridge_failed").code, "PLAN_INVALID");
});

test("plan 运行期 source 被改 → SOURCE_MUTATED_DURING_PLAN,不返回计划", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => { fs.writeFileSync(path.join(a.cwd, "output", "plan.json"), JSON.stringify(goodPlan())); fs.appendFileSync(fix.src, "<!--mutated-->"); } });
  const { events, emit } = collect();
  await executePlanRun(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "SOURCE_MUTATED_DURING_PLAN");
  assert.ok(!events.some((e) => e.type === "plan-ready"), "source 变 → 不返回计划");
});

test("plan 运行期 task bundle 被改 → TASK_MUTATED_DURING_PLAN", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => {
    fs.writeFileSync(path.join(a.cwd, "output", "plan.json"), JSON.stringify(goodPlan()));
    const tj = path.join(a.cwd, "task-hgr_cp0123456789.json");
    fs.chmodSync(tj, 0o600); fs.writeFileSync(tj, '{"mutated":true}'); fs.chmodSync(tj, 0o400);
  } });
  const { events, emit } = collect();
  await executePlanRun(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "TASK_MUTATED_DURING_PLAN");
});

test("plan 写 candidate.html 不算计划输出(仍 PLAN_MISSING,且不发布 candidate)", async () => {
  // Agent 误把输出写成 candidate.html(非 plan.json)→ PLAN_MISSING;绝不接受 candidate.html
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "candidate.html"), "<!doctype html><html></html>") });
  const { events, emit } = collect();
  await executePlanRun(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "PLAN_MISSING");
  assert.ok(!fs.existsSync(path.join(fix.dir, "report--htmlgenius-hgr_cp0123456789.candidate.html")), "不发布 candidate");
});

test("§6.8:candidate 携带 approved_plan → 写只读 approved-plan.md;无 plan 的 candidate 回归不受影响", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "candidate.html"), "<!doctype html><html><body>ok</body></html>") });
  const msg = baseMsg(fix, "hgr_cp0123456789");
  msg.run_kind = "candidate";
  msg.approved_plan = { plan_id: "hgp_1", plan_sha256: "sha256:" + "a".repeat(64), edited_plan_markdown: "1. 计划步骤\n2. 另一步" };
  const { events, emit } = collect();
  await executeCandidateRun(msg, { emit, claude });
  assert.ok(events.some((e) => e.type === "candidate-ready"), "approved_plan 不影响 candidate 成功");
  const ap = path.join(fix.root, "runs", "hgr_cp0123456789", "approved-plan.md");
  assert.ok(fs.existsSync(ap), "approved-plan.md 写入");
  assert.equal(fs.readFileSync(ap, "utf8"), "1. 计划步骤\n2. 另一步");
  assert.equal(fs.statSync(ap).mode & 0o777, 0o400, "approved-plan.md 只读 0400");
  // prompt 含 approved plan 前言
  assert.match(claude.calls.runHandoff[0].promptText, /Approved implementation plan/, "prompt 追加 approved plan 前言");
});
