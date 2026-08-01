// bridge/test/copilot-patch-run.test.mjs — 方向3 Copilot patch preview/apply 编排测试(注入 fake SDK,零真实 runtime)。
// 与 patch-run.test.mjs(claude)/ codex-patch-run.test.mjs 同构:Copilot 完全只读 session(writableFiles=[])
// 输出编辑 JSON(reply 文本),host 确定性应用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { executeCopilotPatchPreviewRun, executeCopilotPatchApplyRun } from "../copilot-adapter.mjs";
import { COPILOT_RUNTIMES } from "../copilot-runtime.mjs";
import { makeFakeSdk } from "./fake-copilot-sdk.mjs";
import { generateRunId, sha256File } from "../task-bundle.mjs";

const require = createRequire(import.meta.url);
const ChangeContract = require("../../extension/change-contract.js");

const SRC = '<!doctype html><html><body><h1>Old Title</h1><p>keep me</p></body></html>';

function setup(content = SRC) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-patch-"));
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
function selectorFor(sdk) {
  return async () => ({ sdk, runtime: COPILOT_RUNTIMES.BUNDLED_SDK_CLI, cliPath: null, version: "1.0.7-fake" });
}
function collect() { const frames = []; return { frames, emit: (f) => frames.push(f) }; }
const EDITS = { schema_version: 1, edits: [{ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" }] };

test("copilot patch preview: reply(带围栏/prose)→ patch-preview-ready,edits.json 落 copilot 子目录", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "改标题")], ["a1"]);
  const runId = generateRunId();
  const sdk = makeFakeSdk({ session: { reply: "分析完成。\n```json\n" + JSON.stringify(EDITS) + "\n```" } });
  const { frames, emit } = collect();
  await executeCopilotPatchPreviewRun(previewMsg(p, task, runId), { emit, selectRuntime: selectorFor(sdk) });
  const ready = frames.find((f) => f.type === "patch-preview-ready");
  assert.ok(ready, "发出 patch-preview-ready");
  assert.equal(ready.provider, "github_copilot");
  assert.equal(ready.provider_runtime, COPILOT_RUNTIMES.BUNDLED_SDK_CLI);
  assert.equal(ready.edits.length, 1);
  assert.equal(ready.edits[0].status, "ok");
  assert.equal(ready.compliance.applicable, 1);
  const runsDir = path.join(path.dirname(p), ".htmlgenius-bridge", "copilot", "hgd_test", "runs", runId);
  const ep = path.join(runsDir, "edits.json");
  assert.ok(fs.existsSync(ep), "edits.json 落盘于 copilot 子目录");
  assert.equal(fs.statSync(ep).mode & 0o777, 0o600);
});

test("copilot patch preview: 完全只读 —— 写工具被 onPreToolUse 拒绝,但有效 reply 仍成功", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const denials = [];
  const sdk = makeFakeSdk({
    session: {
      reply: JSON.stringify(EDITS),
      writer: ({ cwd, config }) => {
        // 模拟 Agent 试图写文件 → 围栏必须拒绝(writableFiles=[] → write_not_allowed_output)
        const d = config.hooks.onPreToolUse({ toolName: "write", toolArgs: { path: path.join(cwd, "stray.html"), content: "x" } });
        denials.push(d);
      }
    }
  });
  const { frames, emit } = collect();
  await executeCopilotPatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, selectRuntime: selectorFor(sdk) });
  assert.equal(denials.length, 1);
  assert.equal(denials[0].permissionDecision, "deny", "patch session 任何写工具都被拒");
  assert.ok(frames.find((f) => f.type === "patch-preview-ready"), "写被拒不阻塞有效编辑输出");
});

test("copilot patch preview: 无效 reply + 有越权写被拒 → PERMISSION_DENIED 归因", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const sdk = makeFakeSdk({
    session: {
      reply: "我无法生成编辑。",
      writer: ({ cwd, config }) => { config.hooks.onPreToolUse({ toolName: "write", toolArgs: { path: path.join(cwd, "x.html"), content: "x" } }); }
    }
  });
  const { frames, emit } = collect();
  await executeCopilotPatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, selectRuntime: selectorFor(sdk) });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "COPILOT_PERMISSION_DENIED");
});

test("copilot patch preview: 无效 reply(无越权)→ PATCH_EDITS_INVALID(供回落)", async () => {
  const { p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "x")], ["a1"]);
  const sdk = makeFakeSdk({ session: { reply: "我无法生成编辑。" } });
  const { frames, emit } = collect();
  await executeCopilotPatchPreviewRun(previewMsg(p, task, generateRunId()), { emit, selectRuntime: selectorFor(sdk) });
  assert.equal(frames.find((f) => f.type === "bridge_failed").code, "PATCH_EDITS_INVALID");
});

test("copilot patch apply: sibling = source + 且仅 + 确认编辑,manifest 署名 github_copilot", async () => {
  const { dir, p } = setup();
  const task = buildTask(p, [ann("a1", "Old Title", "改"), ann("a2", "keep me", "改2")], ["a1", "a2"]);
  const runId = generateRunId();
  const edits = { schema_version: 1, edits: [
    { id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" },
    { id: "e2", comment_ref: "a2", action: "replace_text", locator: { exact: "keep me" }, replacement: "CHANGED" }
  ] };
  const sdk = makeFakeSdk({ session: { reply: JSON.stringify(edits) } });
  await executeCopilotPatchPreviewRun(previewMsg(p, task, runId), { emit: () => {}, selectRuntime: selectorFor(sdk) });
  const { frames, emit } = collect();
  await executeCopilotPatchApplyRun({ run_id: runId, source: { logical_document_id: "hgd_test", artifact_uri: pathToFileURL(p).href }, confirmed_edit_ids: ["e1"] }, { emit });
  const ready = frames.find((f) => f.type === "candidate-ready");
  assert.ok(ready, "发出 candidate-ready");
  const candPath = path.join(dir, "reportV1.1.html");
  assert.ok(fs.existsSync(candPath), "sibling 候选已发布");
  const html = fs.readFileSync(candPath, "utf8");
  assert.ok(html.includes("New Title") && html.includes("keep me") && !html.includes("CHANGED"), "仅应用确认编辑");
  assert.equal(ready.patch, undefined, "candidate-ready 不得携带 patch 清单(禁止私自样式变更)");
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(p), ".htmlgenius-bridge", "copilot", "hgd_test", "runs", runId, "candidate-manifest.json"), "utf8"));
  assert.equal(manifest.provider, "github_copilot");
  assert.equal(manifest.session, null, "Copilot 永不持久化 session");
  assert.equal(fs.readFileSync(p, "utf8"), SRC, "原文件未改");
});
