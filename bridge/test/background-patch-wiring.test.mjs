// bridge/test/background-patch-wiring.test.mjs — 方向3 确定性编辑快车道 background 接线(源码级断言)。
// background.js 依赖 chrome.*/importScripts 无法在 Node 跑;仿 background-plan-wiring.test.mjs 锁住关键契约。
// 重点回归:runKind 必须是 let(升级 patch_preview 时就地重新赋值;若回退成 const 会抛
// "Assignment to constant variable" 导致精准修补发送即失败 —— 真实冒烟踩过的坑)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "background.js"), "utf8");
const storage = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "storage.js"), "utf8");

test("background runKind 必须用 let 声明(升级 patch_preview 需重新赋值;const 会抛 Assignment to constant variable)", () => {
  assert.match(bg, /let runKind = run_kind/, "runKind 必须是 let(曾因 const 导致精准修补发送即失败)");
  assert.doesNotMatch(bg, /const runKind = run_id/, "runKind 不得回退为 const");
});

test("background candidate+precise_patch+provider 支持 patch → 内部升级 patch_preview(_no_patch 防回落死循环)", () => {
  assert.match(bg, /runKind === "candidate" && task\.mode === "precise_patch" && !_no_patch && ProviderMetadata\.providerSupports\(provider, "patch"\)/);
  assert.match(bg, /runKind = "patch_preview"/);
});

test("background patch run 记录回存 patch_change_contract(坏 JSON 回落 candidate 复用)", () => {
  assert.match(bg, /patch_change_contract: runKind === "patch_preview" \? task : null/);
});

test("background onHostMessage 含 patch-preview-ready 分支 → onPatchPreviewReady", () => {
  assert.match(bg, /m\.type === "patch-preview-ready"/);
  assert.match(bg, /onPatchPreviewReady\(tab_id, runId, m, taskSha, logicalId, artifactUrl\)/);
});

test("background bridge-patch-apply 消息入口 → handlePatchApply", () => {
  assert.match(bg, /msg\.type === "bridge-patch-apply"/);
  assert.match(bg, /handlePatchApply\(msg\)/);
});

test("background patch_preview 坏 JSON(PATCH_EDITS_INVALID)→ 静默回落 candidate", () => {
  assert.match(bg, /run\.run_kind === "patch_preview" && m\.code === "PATCH_EDITS_INVALID" && run\.patch_change_contract/);
  assert.match(bg, /patchFallbackToCandidate\(tab_id, runId, run, m\)/);
});

test("background patch 函数齐备:onPatchPreviewReady / handlePatchApply / patchFallbackToCandidate", () => {
  assert.match(bg, /async function onPatchPreviewReady\(/);
  assert.match(bg, /async function handlePatchApply\(/);
  assert.match(bg, /async function patchFallbackToCandidate\(/);
});

test("candidate-ready 携带 patch.applied 完整编辑(host 发出 → background 存高亮清单到 chrome.storage.local)", () => {
  const hostRunner = fs.readFileSync(path.resolve(__dirname, "..", "host-runner.mjs"), "utf8");
  assert.match(hostRunner, /applied: appliedFull, skipped: result\.skipped/);
  assert.match(bg, /completion\.patch && Array\.isArray\(completion\.patch\.applied\)/);
  assert.match(bg, /hg_patch_hl:/);
});

test("storage getActiveBridgeRunForTab 含 awaiting_confirm(patch 预览待确认期保持 tab 锁,且不计入重启即失败对账)", () => {
  assert.match(storage, /r\.status === "awaiting_confirm"/);
  // listActiveBridgeRuns(重启对账)不得把 awaiting_confirm 当失败 —— 只查 starting/running 索引
  const m = storage.match(/async listActiveBridgeRuns\(\)[\s\S]{0,200}/);
  assert.ok(m && !/awaiting_confirm/.test(m[0]), "listActiveBridgeRuns 不得纳入 awaiting_confirm(该态可恢复)");
});

test("background onPatchPreviewReady:可应用编辑为空(okIds.length===0)不得自动应用(会产出与原文相同的无意义 candidate)", () => {
  // 回归:目标已满足时 Agent 返回空/全跳过编辑;旧逻辑仍自动 patch_apply 空清单 → 生成零变化候选 + 版本号,误导用户重试
  assert.match(bg, /mode === "apply_then_review" && okIds\.length > 0/, "自动应用必须以 okIds 非空为前提");
  assert.doesNotMatch(bg, /if \(mode === "apply_then_review"\) \{\s*\n\s*const okIds/, "不得回退为无条件自动应用");
});

test("sidepanel patch 预览:空编辑渲染说明(patch.noneNeeded);确认时 0 勾选不发空清单", () => {
  const sp = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "sidepanel.js"), "utf8");
  assert.match(sp, /pp-empty/, "空编辑列表需有专用空状态");
  assert.match(sp, /patch\.noneNeeded/, "空状态文案走 i18n");
  assert.match(sp, /if \(!checked\.length\)/, "0 勾选必须拦在发送前(改为取消)");
});

test("content-script: 候选(new_artifact)绝不 linkArtifactUri 到源文档(评论不跨文件共享,源评论不随应用丢失)", () => {
  // 回归:候选曾被 link 进源逻辑文档 → 旧评论高亮跨 tab 继承到候选页;候选页「失效评论」一键清除
  // 会删掉源文件仍有效的评论。候选必须是独立逻辑文档(版本血缘仍记 saveArtifactVersion,不受影响)。
  const cs = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "content-script.js"), "utf8");
  assert.ok(!cs.includes("linkArtifactUri(_logicalDocumentId, resultUri)"), "new_artifact 不得再链接到源逻辑文档");
  assert.match(cs, /await Storage\.saveArtifactVersion\(\{ logical_document_id: _logicalDocumentId, artifact_uri: resultUri/, "版本血缘记录保留");
});
