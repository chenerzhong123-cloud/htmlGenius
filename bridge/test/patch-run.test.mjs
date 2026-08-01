// bridge/test/patch-run.test.mjs — 方向3 patch preview/apply 编排测试(注入 fake claude,零模型额度)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { executePatchPreviewRun, executePatchApplyRun } from "../host-runner.mjs";
import { makeFakeClaude } from "./fake-claude.mjs";
import { generateRunId, sha256File } from "../task-bundle.mjs";

const require = createRequire(import.meta.url);
const ChangeContract = require("../../extension/change-contract.js");

const SRC = '<!doctype html><html><body><h1>Old Title</h1><p>keep me</p></body></html>';

function setup(content = SRC) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-patch-"));
  const p = path.join(dir, "report.html");
  fs.writeFileSync(p, content);
  return { dir, p };
}
function buildTask(p, anns, rootIds) {
  return ChangeContract.buildTask({
    mode: "precise_patch", rootIds,
    artifact: { title: "T", url: pathToFileURL(p).href, isLocal: true },
    brief: "", preserveText: ""
  }, anns);
}
function ann(id, exact, comment) {
  return { id, parent_id: null, _status: "open", quote: exact, selector: { exact, prefix: "", suffix: "" }, body: { comment }, author: { name: "u" } };
}
function previewMsg(p, task, runId) {
  return {
    run_id: runId,
    source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href, base_artifact_hash: sha256File(p) },
    task
  };
}
function collect() { const frames = []; return { frames, emit: (f) => frames.push(f) }; }

test("patch preview: 成功发 patch-preview-ready,编辑带 ok 状态,edits.json 落盘", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "改标题")], ["a1"]);
  const runId = generateRunId();
  const edits = { schema_version: 1, edits: [{ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" }] };
  const claude = makeFakeClaude({ runPatchResult: { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", resultText: JSON.stringify(edits) } });
  const { frames, emit } = collect();
  await executePatchPreviewRun(previewMsg(p, task, runId), { emit, claude });
  const ready = frames.find((f) => f.type === "patch-preview-ready");
  assert.ok(ready, "发出 patch-preview-ready");
  assert.equal(ready.edits.length, 1);
  assert.equal(ready.edits[0].status, "ok");
  assert.equal(ready.compliance.applicable, 1);
  assert.equal(ready.compliance.out_of_scope, 0);
  // edits.json 落盘 0600
  const runsDir = path.join(path.dirname(p), ".htmlgenius-bridge", "claude", "hgd_test", "runs", runId);
  const ep = path.join(runsDir, "edits.json");
  assert.ok(fs.existsSync(ep));
  assert.equal(fs.statSync(ep).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(ep, "utf8")).edits.length, 1);
});

test("patch preview: Claude 输出坏 JSON → PATCH_EDITS_INVALID(供回落)", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const claude = makeFakeClaude({ runPatchResult: { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", resultText: "sorry I cannot" } });
  const { frames, emit } = collect();
  await executePatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, claude });
  const failed = frames.find((f) => f.type === "bridge_failed");
  assert.equal(failed.code, "PATCH_EDITS_INVALID");
});

test("patch preview: task.mode 非 precise_patch → INVALID_MODE", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  task.mode = "regenerate";
  const claude = makeFakeClaude();
  const { frames, emit } = collect();
  await executePatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, claude });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "INVALID_MODE");
});

test("patch apply: 成功发 candidate-ready,sibling = source + 且仅 + 确认编辑", async () => {
  const { dir, p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "改"), ann("a2", "keep me", "改2")], ["a1", "a2"]);
  const runId = generateRunId();
  const edits = { schema_version: 1, edits: [
    { id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" },
    { id: "e2", comment_ref: "a2", action: "replace_text", locator: { exact: "keep me" }, replacement: "CHANGED" }
  ] };
  const claude = makeFakeClaude({ runPatchResult: { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", resultText: JSON.stringify(edits) } });
  await executePatchPreviewRun(previewMsg(p, task, runId), { emit: () => {}, claude });

  // 只确认 e1 → candidate 含 New Title,但仍保留 keep me(e2 未应用)
  const { frames, emit } = collect();
  await executePatchApplyRun({ run_id: runId, source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href }, confirmed_edit_ids: ["e1"] }, { emit, claude });
  const ready = frames.find((f) => f.type === "candidate-ready");
  assert.ok(ready, "发出 candidate-ready");
  assert.equal(ready.version_label, "1.1");
  const candPath = path.join(dir, "reportV1.1.html");
  assert.ok(fs.existsSync(candPath), "sibling 候选已发布");
  const html = fs.readFileSync(candPath, "utf8");
  assert.ok(html.includes("New Title"), "确认编辑已应用");
  assert.ok(html.includes("keep me"), "未确认编辑未被应用");
  assert.ok(!html.includes("CHANGED"));
  // 候选页禁止私自样式变更:candidate-ready 不再携带 patch 清单(改动区高亮已移除)
  assert.equal(ready.patch, undefined, "candidate-ready 不得携带 patch 清单(禁止私自样式变更)");
  // 原文件未被改
  assert.equal(fs.readFileSync(p, "utf8"), SRC);
});

test("patch apply: source 在 preview 后被改 → SOURCE_MUTATED_DURING_PATCH 拒绝", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const runId = generateRunId();
  const edits = { schema_version: 1, edits: [{ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" }] };
  const claude = makeFakeClaude({ runPatchResult: { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", resultText: JSON.stringify(edits) } });
  await executePatchPreviewRun(previewMsg(p, task, runId), { emit: () => {}, claude });
  fs.writeFileSync(p, SRC.replace("keep me", "user edited meanwhile")); // 用户期间改了源
  const { frames, emit } = collect();
  await executePatchApplyRun({ run_id: runId, source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href }, confirmed_edit_ids: ["e1"] }, { emit, claude });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "SOURCE_MUTATED_DURING_PATCH");
});

test("patch apply: preview run 目录缺失 → PATCH_RUN_NOT_FOUND", async () => {
  const { p } = setup();
  const claude = makeFakeClaude();
  const { frames, emit } = collect();
  await executePatchApplyRun({ run_id: generateRunId(), source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href }, confirmed_edit_ids: ["e1"] }, { emit, claude });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "PATCH_RUN_NOT_FOUND");
});
