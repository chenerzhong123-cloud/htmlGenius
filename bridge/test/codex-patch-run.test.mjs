// bridge/test/codex-patch-run.test.mjs — 方向3 Codex patch preview/apply 编排测试(注入 fake client,零真实 App)。
// 与 patch-run.test.mjs(claude)同构:Codex 只读沙箱输出编辑 JSON(messages),host 确定性应用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { executeCodexPatchPreviewRun, executeCodexPatchApplyRun } from "../codex-adapter.mjs";
import { generateRunId, sha256File } from "../task-bundle.mjs";

const require = createRequire(import.meta.url);
const ChangeContract = require("../../extension/change-contract.js");

const SRC = '<!doctype html><html><body><h1>Old Title</h1><p>keep me</p></body></html>';

function setup(content = SRC) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-codex-patch-"));
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
    session: { mode: "new" },
    task
  };
}
// verifySchema 要求的最小合法 schema(与 codex fixture 同形)
function makeSchemaDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hg-codex-patch-sch-"));
  fs.writeFileSync(path.join(d, "ClientRequest.json"), JSON.stringify({
    initialize: {}, "thread/start": {}, "thread/resume": {},
    "turn/start": { sandboxPolicy: { type: "workspaceWrite" }, approvalPolicy: "never", cwd: "x" }
  }));
  return d;
}
// fake CodexAppServerClient:记录 runTask 入参,按配置回 messages
function makeFakeClient({ messages, failWith } = {}) {
  const calls = [];
  return {
    calls,
    runTask: async (args) => {
      calls.push(args);
      if (failWith) { const e = new Error(failWith.message); e.code = failWith.code; throw e; }
      return { threadId: "thr_test", terminal: {}, messages: messages || [] };
    },
    close: async () => {}
  };
}
function opts(client) {
  return { client, runtime: { runtimePath: "/fake/codex-runtime" }, schemaDir: makeSchemaDir() };
}
function collect() { const frames = []; return { frames, emit: (f) => frames.push(f) }; }
const EDITS = { schema_version: 1, edits: [{ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" }] };

test("codex patch preview: 成功发 patch-preview-ready(多消息倒序提取),readOnly 沙箱,edits.json 落 codex 子目录", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "改标题")], ["a1"]);
  const runId = generateRunId();
  const client = makeFakeClient({ messages: ["过程说明:我读了 source.html。", JSON.stringify(EDITS)] });
  const { frames, emit } = collect();
  await executeCodexPatchPreviewRun(previewMsg(p, task, runId), { emit, ...opts(client) });
  const ready = frames.find((f) => f.type === "patch-preview-ready");
  assert.ok(ready, "发出 patch-preview-ready");
  assert.equal(ready.provider, "codex_app_server");
  assert.equal(ready.edits.length, 1);
  assert.equal(ready.edits[0].status, "ok");
  assert.equal(ready.compliance.applicable, 1);
  // readOnly 沙箱(OS 层禁写,与 claude 禁 Write argv 同语义)
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].readOnly, true, "patch preview 必须 readOnly 沙箱");
  // edits.json 落在 codex provider 子目录(不是 claude 目录)
  const runsDir = path.join(path.dirname(p), ".htmlgenius-bridge", "codex", "hgd_test", "runs", runId);
  const ep = path.join(runsDir, "edits.json");
  assert.ok(fs.existsSync(ep), "edits.json 落盘于 codex 子目录");
  assert.equal(fs.statSync(ep).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(path.dirname(p), ".htmlgenius-bridge", "claude")), "不得写到 claude 子目录");
});

test("codex patch preview: 无有效编辑消息 → PATCH_EDITS_INVALID(供回落 candidate)", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const client = makeFakeClient({ messages: ["抱歉,我无法生成编辑。"] });
  const { frames, emit } = collect();
  await executeCodexPatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, ...opts(client) });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "PATCH_EDITS_INVALID");
});

test("codex patch preview: session.mode continue 拒绝(patch 每次新 thread)", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const msg = previewMsg(p, task, generateRunId());
  msg.session = { mode: "continue", thread_id: "thr_x" };
  const { frames, emit } = collect();
  await executeCodexPatchPreviewRun(msg, { emit, ...opts(makeFakeClient()) });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "CODEX_SESSION_UNAVAILABLE");
});

test("codex patch preview: task.mode 非 precise_patch → INVALID_MODE", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  task.mode = "regenerate";
  const { frames, emit } = collect();
  await executeCodexPatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, ...opts(makeFakeClient()) });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "INVALID_MODE");
});

test("codex patch apply: sibling = source + 且仅 + 确认编辑,manifest 署名 codex_app_server", async () => {
  const { dir, p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "改"), ann("a2", "keep me", "改2")], ["a1", "a2"]);
  const runId = generateRunId();
  const edits = { schema_version: 1, edits: [
    { id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" },
    { id: "e2", comment_ref: "a2", action: "replace_text", locator: { exact: "keep me" }, replacement: "CHANGED" }
  ] };
  await executeCodexPatchPreviewRun(previewMsg(p, task, runId), { emit: () => {}, ...opts(makeFakeClient({ messages: [JSON.stringify(edits)] })) });
  const { frames, emit } = collect();
  await executeCodexPatchApplyRun({ run_id: runId, source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href }, confirmed_edit_ids: ["e1"] }, { emit });
  const ready = frames.find((f) => f.type === "candidate-ready");
  assert.ok(ready, "发出 candidate-ready");
  const candPath = path.join(dir, "reportV1.1.html");
  assert.ok(fs.existsSync(candPath), "sibling 候选已发布");
  const html = fs.readFileSync(candPath, "utf8");
  assert.ok(html.includes("New Title") && html.includes("keep me") && !html.includes("CHANGED"), "仅应用确认编辑");
  assert.equal(ready.patch.applied.length, 1);
  // manifest 署名为 codex
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(p), ".htmlgenius-bridge", "codex", "hgd_test", "runs", runId, "candidate-manifest.json"), "utf8"));
  assert.equal(manifest.provider, "codex_app_server");
  assert.equal(manifest.status, "ready");
  // 原文件未改
  assert.equal(fs.readFileSync(p, "utf8"), SRC);
});

test("codex patch apply: source 在 preview 后被改 → SOURCE_MUTATED_DURING_PATCH 拒绝", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const runId = generateRunId();
  await executeCodexPatchPreviewRun(previewMsg(p, task, runId), { emit: () => {}, ...opts(makeFakeClient({ messages: [JSON.stringify(EDITS)] })) });
  fs.writeFileSync(p, SRC.replace("keep me", "user edited meanwhile"));
  const { frames, emit } = collect();
  await executeCodexPatchApplyRun({ run_id: runId, source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href }, confirmed_edit_ids: ["e1"] }, { emit });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "SOURCE_MUTATED_DURING_PATCH");
});
