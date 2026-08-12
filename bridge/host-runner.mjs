// bridge/host-runner.mjs — claude_handoff_start 的编排(v0.7.1,spec §7)。
// 与 host.mjs 解耦:executeHandoff(msg, { emit, claude }) 接受注入的 claude adapter,
// 生产用真实 claude-cli.mjs,自动测试注入 fake-claude(不消耗模型额度)。
// host 不控制 tab、不给 content script 发消息;只 emit native 帧给 background(§4.1)。
//
// 流程(§7):字段/SHA/schema 校验 → source base 哈希比对 → 稳定 workspace + task bundle(0600/0700)
// → claude auth status → new:claude -p / continue:--resume <已存 UUID>(cwd=workspace)
// → 重读 source 哈希(运行期被改 → SOURCE_MUTATED_DURING_HANDOFF)→ bridge_completed(仅 session/hash)。
// 本版 Claude 无写文件权限:不产 candidate、不回写、不导航 —— 验收是「任务真实到达 Claude Code CLI」。
import {
  resolveSourceArtifact, verifySourceHash, createWorkspace, writeTaskBundle,
  buildHandoffPrompt, buildCandidatePrompt, buildPlanPrompt, buildPatchPrompt, approvedPlanPreamble, rootAnnotationIdsOf, isSha256Tagged, sha256File
} from "./task-bundle.mjs";
import { isSessionUuid, checkAuth, runHandoff, resumeHandoff, runPatch, HANDOFF_TIMEOUT_MS } from "./claude-cli.mjs";
import {
  resolveSourcePath, prepareCandidateRun, writeManifest, validateCandidate,
  publishSiblingCandidate, quarantineCandidate, writeApprovedPlan, nextCandidateVersionLabel, sha256Bytes
} from "./candidate-workspace.mjs";
import {
  preparePlanRun, verifyTaskBundleUnchanged, validatePlanJson, writePlanManifest, quarantinePlan
} from "./plan-workspace.mjs";
import { parseEditsJson, applyEdits, extractEditsFromMessages } from "./patch-edits.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const realClaude = { checkAuth, runHandoff, resumeHandoff, runPatch };

// candidate run 需要读写完整 HTML 文件,比 ack 回执慢得多。实测:1 条评论约 3 分钟;
// v0.8.1:Claude 候选超时 15 分钟(与 Codex 两侧统一)。整页重生成常很慢(等 API 占 98% 时间),
// 15 分钟给复杂页留足余量;真挂起时用户可点「终止任务」中止,不必干等。
const CANDIDATE_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟
// v0.8.1 plan run(spec §6.5):Agent 只写一个 plan.json,不重写整页 HTML → 比 candidate 快得多。3 分钟,不无限等待。
const CLAUDE_PLAN_TIMEOUT_MS = 3 * 60 * 1000; // 3 分钟

function truncateMsg(s) {
  const t = String(s || "");
  return t.length > 400 ? t.slice(0, 400) + "…" : t;
}

// —— bridge_stream 流量围栏(R-7):封堵「Agent 被 prompt 诱导回显,经流式通道外泄」的大体积通道 ——
// 累计字节上限:进度/状态 UI 足够,但封死整文件回显式外泄。超限只发一条固定截断提示(不含模型/用户文本)。
const MAX_STREAM_BYTES = 256 * 1024;

// handoff 是 ack-only:模型文本一律不回传(即便将来 adapter 改为流式也不泄漏)。
// candidate/plan 允许进度流,但累计字节超 MAX_STREAM_BYTES 后停止转发 bridge_stream(其余帧不受影响)。
// 导出供单测校验流围栏(R-7 关键不变量)。
export const STREAM_BYTE_LIMIT = MAX_STREAM_BYTES;
export function wrapEmit(rawEmit, { runId, allowStream }) {
  if (!allowStream) {
    return (payload) => {
      if (payload && payload.type === "bridge_stream") return; // handoff:丢弃所有模型文本帧
      rawEmit(payload);
    };
  }
  let used = 0;
  let capped = false;
  return (payload) => {
    if (!payload || payload.type !== "bridge_stream") { rawEmit(payload); return; }
    if (capped) return;
    used += Buffer.byteLength(String(payload.text || ""), "utf8");
    if (used > MAX_STREAM_BYTES) {
      capped = true;
      try { rawEmit({ type: "bridge_stream", run_id: runId, kind: "info", text: "[stream truncated: byte limit reached]" }); } catch (_) {}
      return;
    }
    rawEmit(payload);
  };
}

// R-7:从消息读「用户显式打开的工作区根」(扩展可选字段 workspace_root_uri,file: URL)。
// 命中则 realpath 包含校验在 resolveSource* 内生效;未提供返回 null → 仅靠软链/realpath 硬化兜底(向后兼容)。
function sourceWorkspaceRoot(source) {
  const u = source && source.workspace_root_uri;
  if (typeof u !== "string" || !/^file:/i.test(u)) return null;
  try { return fileURLToPath(u); } catch (_) { return null; }
}

export async function executeHandoff(msg, { emit: rawEmit, claude } = {}) {
  if (typeof rawEmit !== "function") throw new Error("emit is required");
  const cli = claude || realClaude;
  const runId = msg && msg.run_id;
  // R-7:handoff 是 ack-only,模型文本一律不回传(桥接通道上绝不出现 bridge_stream)。
  const emit = wrapEmit(rawEmit, { runId, allowStream: false });
  const status = (s) => emit({ type: "bridge_status", run_id: runId, status: s });
  const failed = (code, message) => emit({ type: "bridge_failed", run_id: runId, code, message: truncateMsg(message) });

  // —— 1. 字段/SHA/schema 校验 ——
  if (!msg || typeof msg !== "object") { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing message" }); return; }
  if (typeof runId !== "string" || !runId) { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing run_id" }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== "string" || !source.logical_document_id) { failed("BAD_REQUEST", "missing source.logical_document_id"); return; }
  if (typeof source.artifact_uri !== "string" || !source.artifact_uri) { failed("BAD_REQUEST", "missing source.artifact_uri"); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed("BAD_REQUEST", "source.base_artifact_hash must be sha256:<64hex>"); return; }
  if (session.mode !== "new" && session.mode !== "continue") { failed("BAD_REQUEST", "session.mode must be new|continue"); return; }
  if (session.mode === "continue" && !isSessionUuid(session.session_id)) { failed("NO_SAVED_SESSION", "continue requires a stored UUID session_id; refusing to guess or pick"); return; }

  status("checking");

  // —— 2. source 解析 + host 自算哈希(不与 extension 的 DOM 序列化哈希比对;两者方法不同必然不匹配) ——
  // R-7:workspace_root_uri(扩展可选)提供时,resolveSourceArtifact 做 realpath 工作区包含校验。
  const workspaceRoot = sourceWorkspaceRoot(source);
  let sourcePath, hostSourceHash;
  try {
    sourcePath = resolveSourceArtifact(source.artifact_uri, { workspaceRoot }).sourcePath;
    hostSourceHash = sha256File(sourcePath);
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message); return; }

  // —— 3. 稳定 workspace + task bundle(JSON + md,0600/0700)——
  let workspace, bundle;
  try {
    workspace = createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostSourceHash });
  } catch (e) { failed(e.code || "BUNDLE_FAILED", e.message); return; }

  // —— 4. auth(未登录/未安装即停)——
  try { await cli.checkAuth({ cwd: workspace }); }
  catch (e) { failed(e.code || "CLAUDE_NOT_LOGGED_IN", e.message); return; }

  // —— 5/6. 执行交接:new → claude -p;continue → --resume <stored-uuid>,cwd=workspace ——
  status("running");
  const promptText = buildHandoffPrompt({
    jsonPath: bundle.jsonPath,
    taskSha256: bundle.taskSha256,
    runId,
    rootAnnotationIds: rootAnnotationIdsOf(task)
  });
  let sessionId;
  try {
    if (session.mode === "continue") {
      const r = await cli.resumeHandoff({ cwd: workspace, promptText, resumeSessionId: session.session_id });
      sessionId = r.sessionId;
    } else {
      const r = await cli.runHandoff({ cwd: workspace, promptText });
      sessionId = r.sessionId;
      emit({ type: "bridge_session_created", run_id: runId, session_id: sessionId }); // 只在 new 时发
    }
  } catch (e) { failed(e.code || "RUN_FAILED", e.message); return; }

  // —— 7. 重读 source:与 host 自己的运行前哈希比对(不与 extension 比对;方法不同) ——
  try {
    const afterHash = sha256File(sourcePath);
    if (afterHash !== hostSourceHash) throw new Error("source changed during run");
  } catch (e) {
    emit({
      type: "bridge_failed", run_id: runId, code: "SOURCE_MUTATED_DURING_HANDOFF",
      message: "source file changed during handoff; not treating as a clean handoff",
    });
    return; // 不写 session、不显示成功(§7.9 / §6.2)
  }

  // —— 8. 完成:只回 session id 与 task hash(不回传 Claude 完整 response)——
  emit({
    type: "bridge_completed",
    run_id: runId,
    session_id: sessionId,
    task_sha256: bundle.taskSha256
  });
}

// 供测试/诊断:再读一次 source 哈希(不抛错版本)。
export function currentSourceHash(sourcePath) {
  try { return sha256File(sourcePath); } catch (e) { return null; }
}

// —— Night Pack A spec §3/§4:candidate 执行编排 ——
// 与 executeHandoff(ack)并列;host.mjs 按 run_kind 分发。
// 流程:校验 → source snapshot(0400)+ task 复制进 runs/<runId> → auth → claude(Read,Glob,Grep,Write)
// → 重读 source(变 → SOURCE_MUTATED_DURING_CANDIDATE)→ 校验 candidate 形态 → 原子 sibling → ready manifest
// → emit candidate-ready。任何失败:quarantine + failed manifest + bridge_failed,绝不创建 sibling / 不触 artifact 协议。
const CANDIDATE_FAIL_STATUS = {
  SOURCE_CHANGED_BEFORE_START: "source_changed_before_start",
  SOURCE_MUTATED_DURING_CANDIDATE: "source_changed_during_run",
  CANDIDATE_MISSING: "candidate_missing",
  CANDIDATE_EMPTY: "candidate_invalid_html",
  CANDIDATE_INVALID_HTML: "candidate_invalid_html",
  CANDIDATE_SYMLINK: "candidate_invalid_html",
  CANDIDATE_NOT_FILE: "candidate_invalid_html",
  CANDIDATE_TOO_LARGE: "candidate_invalid_html",
  CANDIDATE_NOT_UTF8: "candidate_invalid_html",
  CLAUDE_RUN_FAILED: "claude_failed",
  CLAUDE_INVALID_RESULT: "claude_failed",
  CLAUDE_MAX_TURNS: "max_turns_reached",
  CLAUDE_TIMEOUT: "timed_out"
};

export async function executeCandidateRun(msg, { emit: rawEmit, claude } = {}) {
  if (typeof rawEmit !== "function") throw new Error("emit is required");
  const cli = claude || realClaude;
  const runId = msg && msg.run_id;
  // R-7:candidate 允许进度流,但累计字节超 MAX_STREAM_BYTES 后停止转发(封堵大体积外泄)。
  const emit = wrapEmit(rawEmit, { runId, allowStream: true });
  const status = (s) => emit({ type: "bridge_status", run_id: runId, status: s });
  const failed = (code, message, runsDir, ctx) => {
    if (runsDir) {
      try { quarantineCandidate(runsDir); } catch (_) {}
      try {
        writeManifest({
          runsDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: "claude_code_cli",
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          sourceSha256After: (ctx && ctx.sourceSha256After) || null,
          changeContractSha256: (ctx && ctx.taskSha256) || null,
          sessionId: (ctx && ctx.sessionId) || null,
          status: CANDIDATE_FAIL_STATUS[code] || "claude_failed"
        });
      } catch (_) {}
    }
    emit({ type: "bridge_failed", run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验
  if (!msg || typeof msg !== "object") { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing message" }); return; }
  if (typeof runId !== "string" || !runId) { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing run_id" }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== "string" || !source.logical_document_id) { failed("BAD_REQUEST", "missing source.logical_document_id"); return; }
  if (typeof source.artifact_uri !== "string" || !source.artifact_uri) { failed("BAD_REQUEST", "missing source.artifact_uri"); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed("BAD_REQUEST", "source.base_artifact_hash must be sha256:<64hex>"); return; }
  if (session.mode !== "new" && session.mode !== "continue") { failed("BAD_REQUEST", "session.mode must be new|continue"); return; }
  if (session.mode === "continue" && !isSessionUuid(session.session_id)) { failed("NO_SAVED_SESSION", "continue requires a stored UUID session_id"); return; }
  if (task && task.mode === "restructure") { failed("INVALID_MODE", "restructure is plan-only; run_kind candidate not allowed"); return; }

  status("checking");

  // 2. source 解析 + 稳定 workspace + task bundle
  // host 自算源哈希(不与 extension 的 DOM 序列化哈希比对;两者方法不同必然不匹配,导致误报 SOURCE_CHANGED_BEFORE_START)
  // R-7:workspace_root_uri(扩展可选)提供时,resolveSourcePath 做 realpath 工作区包含校验。
  const workspaceRoot = sourceWorkspaceRoot(source);
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri, { workspaceRoot });
    const hostHash = sha256File(sourcePath);
    workspace = createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, taskSha256: null }); return; }

  // 3. candidate 工作区:snapshot(0400)+ task 复制进 runs/<runId>(0700)
  let prep;
  try {
    prep = prepareCandidateRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 3.1 v0.8.1 §6.8:candidate 携带 approved_plan → 写只读 approved-plan.md(辅助约束,不替代 Change Contract)
  if (msg.approved_plan && typeof msg.approved_plan.edited_plan_markdown === "string") {
    try { writeApprovedPlan({ runsDir: prep.runsDir, editedPlanMarkdown: msg.approved_plan.edited_plan_markdown }); }
    catch (e) { failed("PREPARE_FAILED", "cannot write approved-plan.md: " + (e && e.message), prep.runsDir, ctxBase); return; }
  }

  // 4. auth
  try { await cli.checkAuth({ cwd: prep.runsDir }); }
  catch (e) { failed(e.code || "CLAUDE_NOT_LOGGED_IN", e.message, prep.runsDir, ctxBase); return; }

  // 5. 执行:claude(Read,Glob,Grep,Write),cwd=runs/<runId>
  status("running");
  const promptText = buildCandidatePrompt({ runId, task })
    + (msg.approved_plan ? approvedPlanPreamble(msg.approved_plan.edited_plan_markdown) : "");
  let sessionId;
  // Claude 流式:stream-json 事件 → bridge_stream(sidepanel 实时展示生成过程/工具,便于排障超时)
  const claudeStream = (ev) => { try { emit({ type: "bridge_stream", run_id: runId, kind: ev.kind, text: ev.text, starting: !!ev.starting }); } catch (_) {} };
  try {
    if (session.mode === "continue") {
      const r = await cli.resumeHandoff({ cwd: prep.runsDir, promptText, resumeSessionId: session.session_id, runKind: "candidate", timeoutMs: CANDIDATE_TIMEOUT_MS, onStream: claudeStream });
      sessionId = r.sessionId;
    } else {
      const r = await cli.runHandoff({ cwd: prep.runsDir, promptText, runKind: "candidate", timeoutMs: CANDIDATE_TIMEOUT_MS, onStream: claudeStream });
      sessionId = r.sessionId;
      emit({ type: "bridge_session_created", run_id: runId, session_id: sessionId });
    }
  } catch (e) { failed(e.code || "RUN_FAILED", e.message, prep.runsDir, { ...ctxBase, sessionId: null }); return; }

  // 6. 重读 source:运行期被改 → 不采用 candidate(spec §3.4.4)
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed("SOURCE_MUTATED_DURING_CANDIDATE", "cannot re-read source after run", prep.runsDir, { ...ctxBase, sessionId }); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed("SOURCE_MUTATED_DURING_CANDIDATE", "source changed during candidate run; candidate not adopted", prep.runsDir, { ...ctxBase, sourceSha256After, sessionId });
    return;
  }

  // 7. 校验 candidate 形态
  let cand;
  try { cand = validateCandidate(prep.candidatePath, prep.sourceByteLength); }
  catch (e) { failed(e.code || "CANDIDATE_MISSING", e.message, prep.runsDir, { ...ctxBase, sourceSha256After, sessionId }); return; }

  // 8. 原子 sibling 复制(同名不覆盖)。v0.8.1:文档级版本号 V1.1/V1.2 → 写进文件名 + candidate-ready
  let resultPath; let versionLabel;
  try {
    versionLabel = nextCandidateVersionLabel({ sourcePath, logicalDocumentId: source.logical_document_id });
    resultPath = publishSiblingCandidate({ candidatePath: prep.candidatePath, sourcePath, runId, versionLabel });
  } catch (e) { failed(e.code || "CANDIDATE_PUBLISH_FAILED", e.message, prep.runsDir, { ...ctxBase, sourceSha256After, sessionId }); return; }

  // 9. ready manifest
  let manifestPath;
  try {
    manifestPath = writeManifest({
      runsDir: prep.runsDir, runId, logicalDocumentId: source.logical_document_id, provider: "claude_code_cli",
      sourcePath, sourceSha256Before: prep.sourceSha256Before, sourceSha256After,
      candidateResultPath: resultPath, candidateWorkspacePath: prep.candidatePath,
      candidateSha256: cand.sha256, candidateByteLength: cand.byteLength,
      changeContractSha256: bundle.taskSha256, sessionId, status: "ready"
    });
  } catch (e) { failed("MANIFEST_FAILED", e.message, prep.runsDir, { ...ctxBase, sourceSha256After, sessionId }); return; }

  // 10. candidate-ready(最小 completion;不含 Claude stdout/思维链;带版本号 V1.N)
  emit({
    type: "candidate-ready",
    run_id: runId,
    task_sha256: bundle.taskSha256,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: prep.sourceSha256Before,
    candidate_uri: pathToFileURL(resultPath).href,
    candidate_sha256: cand.sha256,
    version_label: versionLabel,
    manifest_path: manifestPath
  });
}

// —— v0.8.1 spec §6.5:Claude plan 执行编排(run_kind === "plan")——
// 与 executeCandidateRun 并列;host.mjs 按 run_kind 分发。流程:
// 校验 → source snapshot(0400)+ task 复制进 plans/<runId>(0700)+ output/(0700)→ auth
// → claude(Read,Glob,Grep,Write,cwd=plans/<runId>,3min)→ 重读 source(变 → SOURCE_MUTATED_DURING_PLAN)
// → task bundle hash 前后比对(变 → TASK_MUTATED_DURING_PLAN)→ 校验 output/plan.json(schema v1 + 路径安全)
// → ready manifest → emit plan-ready。任何失败:quarantine + 失败 manifest(无 plan 正文)+ bridge_failed。
// 绝不创建 candidate sibling / candidate.html(spec §6.7);plan 与 candidate 工作区物理隔离。
const PLAN_FAIL_STATUS = {
  BAD_REQUEST: "bad_request",
  SOURCE_MUTATED_DURING_PLAN: "source_changed_during_run",
  TASK_MUTATED_DURING_PLAN: "task_changed_during_run",
  PLAN_MISSING: "plan_missing",
  PLAN_INVALID: "plan_invalid",
  PLAN_TOO_LARGE: "plan_invalid",
  PLAN_SYMLINK: "plan_invalid",
  PLAN_OUTPUT_PATH_INVALID: "plan_invalid",
  CLAUDE_RUN_FAILED: "claude_failed",
  CLAUDE_INVALID_RESULT: "claude_failed",
  CLAUDE_TIMEOUT: "timed_out"
};

export async function executePlanRun(msg, { emit: rawEmit, claude } = {}) {
  if (typeof rawEmit !== "function") throw new Error("emit is required");
  const cli = claude || realClaude;
  const runId = msg && msg.run_id;
  // R-7:plan 同 candidate,允许进度流但累计字节封顶(封堵大体积外泄)。
  const emit = wrapEmit(rawEmit, { runId, allowStream: true });
  const status = (s) => emit({ type: "bridge_status", run_id: runId, status: s });
  const failed = (code, message, plansDir, ctx) => {
    if (plansDir) {
      try { quarantinePlan(plansDir); } catch (_) {}
      try {
        writePlanManifest({
          plansDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: "claude_code_cli",
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          sourceSha256After: (ctx && ctx.sourceSha256After) || null,
          taskSha256: (ctx && ctx.taskSha256) || null,
          status: "failed", errorCode: code
        });
      } catch (_) {}
    }
    emit({ type: "bridge_failed", run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验
  if (!msg || typeof msg !== "object") { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing message" }); return; }
  if (typeof runId !== "string" || !runId) { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing run_id" }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== "string" || !source.logical_document_id) { failed("BAD_REQUEST", "missing source.logical_document_id"); return; }
  if (typeof source.artifact_uri !== "string" || !source.artifact_uri) { failed("BAD_REQUEST", "missing source.artifact_uri"); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed("BAD_REQUEST", "source.base_artifact_hash must be sha256:<64hex>"); return; }
  if (session.mode !== "new" && session.mode !== "continue") { failed("BAD_REQUEST", "session.mode must be new|continue"); return; }
  if (session.mode === "continue" && !isSessionUuid(session.session_id)) { failed("NO_SAVED_SESSION", "continue requires a stored UUID session_id"); return; }
  if (task && task.mode === "restructure") { failed("INVALID_MODE", "restructure not allowed"); return; }

  status("checking");

  // 2. source 解析 + 稳定 workspace + task bundle
  // R-7:workspace_root_uri(扩展可选)提供时,resolveSourcePath 做 realpath 工作区包含校验。
  const workspaceRoot = sourceWorkspaceRoot(source);
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri, { workspaceRoot });
    const hostHash = sha256File(sourcePath);
    workspace = createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, taskSha256: null }); return; }

  // 3. plan 工作区:snapshot(0400)+ task 复制进 plans/<runId>(0700)+ output/(0700)
  let prep;
  try {
    prep = preparePlanRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath, taskSha256: bundle.taskSha256 }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 4. auth
  try { await cli.checkAuth({ cwd: prep.plansDir }); }
  catch (e) { failed(e.code || "CLAUDE_NOT_LOGGED_IN", e.message, prep.plansDir, ctxBase); return; }

  // 5. 执行:claude(Read,Glob,Grep,Write),cwd=plans/<runId>,3min
  status("running");
  const promptText = buildPlanPrompt({ runId, task });
  let sessionId;
  const claudeStream = (ev) => { try { emit({ type: "bridge_stream", run_id: runId, kind: ev.kind, text: ev.text, starting: !!ev.starting }); } catch (_) {} };
  try {
    const r = await cli.runHandoff({ cwd: prep.plansDir, promptText, runKind: "plan", timeoutMs: CLAUDE_PLAN_TIMEOUT_MS, onStream: claudeStream });
    sessionId = r.sessionId;
  } catch (e) {
    const code = (e && e.code === "CLAUDE_TIMEOUT") ? "CLAUDE_PLAN_TIMEOUT" : (e.code || "CLAUDE_PLAN_FAILED");
    failed(code, e.message, prep.plansDir, ctxBase); return;
  }

  // 6. 重读 source:运行期被改 → 计划废弃(§6.2)
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed("SOURCE_MUTATED_DURING_PLAN", "cannot re-read source after plan run", prep.plansDir, ctxBase); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed("SOURCE_MUTATED_DURING_PLAN", "source changed during plan run; plan not adopted", prep.plansDir, { ...ctxBase, sourceSha256After }); return;
  }

  // 7. task bundle hash 前后比对(§6.2:task 文件运行前后 SHA 必须一致)
  try { verifyTaskBundleUnchanged({ plansDir: prep.plansDir, taskJsonName: prep.taskJsonName, taskSha256Before: prep.taskSha256Before }); }
  catch (e) { failed("TASK_MUTATED_DURING_PLAN", e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 8. 校验 output/plan.json(schema v1 + 路径安全)
  let planResult;
  try { planResult = validatePlanJson(prep.planJsonPath); }
  catch (e) { failed(e.code || "PLAN_MISSING", e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 9. ready manifest
  let manifestPath;
  try {
    manifestPath = writePlanManifest({
      plansDir: prep.plansDir, runId, logicalDocumentId: source.logical_document_id, provider: "claude_code_cli",
      sourcePath, sourceSha256Before: prep.sourceSha256Before, sourceSha256After,
      taskSha256: bundle.taskSha256, planSha256: planResult.planSha256, planByteLength: planResult.byteLength,
      status: "ready"
    });
  } catch (e) { failed("MANIFEST_FAILED", e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 10. plan-ready(最小 completion;不含 Claude stdout/思维链;绝不附带 candidate)
  const p = planResult.plan;
  emit({
    type: "plan-ready",
    provider: "claude_code_cli", // v0.9.1 §5.3:plan-ready 与 codex/copilot 同型携带 provider
    run_id: runId,
    task_sha256: bundle.taskSha256,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: prep.sourceSha256Before,
    plan_sha256: planResult.planSha256,
    plan: { schema_version: p.schema_version, summary: p.summary, plan_markdown: p.plan_markdown, out_of_scope: Array.isArray(p.out_of_scope) ? p.out_of_scope.slice() : [] },
    manifest_path: manifestPath
  });
}

// —— 方向3 确定性编辑快车道:preview 编排(run_kind === "patch_preview")——
// Claude 只读 source.html、以最终文本输出结构化编辑 JSON(不写任何文件);host 提取并 dry-run applyEdits
// 得到每条编辑的状态(ok/not_found/ambiguous/conflict/out_of_scope),写 edits.json 供 apply 复用,
// emit patch-preview-ready(编辑清单+状态+合规汇总)。坏 JSON → PATCH_EDITS_INVALID(供 background 回落 candidate)。
const PATCH_TIMEOUT_MS = 8 * 60 * 1000; // 结构化输出通常比整页重写快,8 分钟给真实复杂页 + 模型繁忙留余量(用户可随时终止)
const PATCH_FAIL_STATUS = {
  BAD_REQUEST: "bad_request",
  INVALID_MODE: "bad_request",
  SOURCE_MUTATED_DURING_PATCH: "source_changed_during_run",
  PATCH_EDITS_INVALID: "patch_edits_invalid",
  PATCH_RUN_NOT_FOUND: "patch_run_not_found",
  CLAUDE_RUN_FAILED: "claude_failed",
  CLAUDE_INVALID_RESULT: "claude_failed",
  CLAUDE_MAX_TURNS: "max_turns_reached",
  CLAUDE_TIMEOUT: "timed_out"
};

function readTaskJson(runsDir, runId) {
  return JSON.parse(fs.readFileSync(path.join(runsDir, "task-" + runId + ".json"), "utf8"));
}

// —— 共享:Agent 结果 → 结构化编辑提取 → dry-run 状态标注 → 落 edits.json(0600)——
// claude(单条 resultText)/ codex·copilot(多条 messages)的 patch preview 共用同一条解析与校验链,
// 状态语义永远一致;坏 JSON 抛 PATCH_EDITS_INVALID(供 background 回落 candidate),写盘失败抛 PREPARE_FAILED。
export function persistPatchPreview({ runsDir, runId, snapshotHtml, task, taskSha256, resultText, messages }) {
  const _parsed = (messages != null ? extractEditsFromMessages(messages) : parseEditsJson(resultText));
  const edits = _parsed.edits;
  const dry = applyEdits(snapshotHtml, edits, task);
  const skipById = new Map(dry.skipped.map((s) => [s.id, s]));
  const annotated = edits.map((ed) => {
    const sk = skipById.get(ed.id);
    return Object.assign({}, ed, { status: sk ? sk.status : "ok", message: sk ? sk.message : "" });
  });
  const compliance = {
    total: edits.length,
    applicable: dry.applied.length,
    out_of_scope: dry.skipped.filter((s) => s.status === "out_of_scope").length,
    not_found: dry.skipped.filter((s) => s.status === "not_found").length,
    ambiguous: dry.skipped.filter((s) => s.status === "ambiguous").length,
    conflict: dry.skipped.filter((s) => s.status === "conflict").length,
    note: _parsed.note || null
  };
  try {
    const ep = path.join(runsDir, "edits.json");
    fs.writeFileSync(ep, JSON.stringify({ schema_version: 1, run_id: runId, task_sha256: taskSha256, edits }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(ep, 0o600); } catch (_) {}
  } catch (e) {
    const err = new Error("cannot write edits.json: " + (e && e.message));
    err.code = "PREPARE_FAILED";
    throw err;
  }
  return { edits: annotated, compliance };
}

export async function executePatchPreviewRun(msg, { emit: rawEmit, claude } = {}) {
  if (typeof rawEmit !== "function") throw new Error("emit is required");
  const cli = claude || realClaude;
  const runId = msg && msg.run_id;
  const emit = wrapEmit(rawEmit, { runId, allowStream: true }); // v0.9.x:patch 开流式(让"无变更理由"等推理进流式窗口 + 诊断 agent_stream)
  const status = (s) => emit({ type: "bridge_status", run_id: runId, status: s });
  const failed = (code, message, runsDir, ctx) => {
    if (runsDir) {
      try {
        writeManifest({
          runsDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: "claude_code_cli",
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          changeContractSha256: (ctx && ctx.taskSha256) || null,
          status: PATCH_FAIL_STATUS[code] || "claude_failed"
        });
      } catch (_) {}
    }
    emit({ type: "bridge_failed", run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验
  if (!msg || typeof msg !== "object") { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing message" }); return; }
  if (typeof runId !== "string" || !runId) { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing run_id" }); return; }
  const source = msg.source || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== "string" || !source.logical_document_id) { failed("BAD_REQUEST", "missing source.logical_document_id"); return; }
  if (typeof source.artifact_uri !== "string" || !source.artifact_uri) { failed("BAD_REQUEST", "missing source.artifact_uri"); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed("BAD_REQUEST", "source.base_artifact_hash must be sha256:<64hex>"); return; }
  if (!task || task.mode !== "precise_patch") { failed("INVALID_MODE", "patch run_kind requires task.mode precise_patch"); return; }

  status("checking");

  // 2. source 解析 + workspace + task bundle
  const workspaceRoot = sourceWorkspaceRoot(source);
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri, { workspaceRoot });
    const hostHash = sha256File(sourcePath);
    workspace = createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id }); return; }

  // 3. candidate 工作区:source snapshot(0400)+ task 复制进 runs/<runId>(与 apply 共享同一 run 目录)
  let prep;
  try {
    prep = prepareCandidateRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath, taskSha256: bundle.taskSha256 }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 4. auth
  try { await cli.checkAuth({ cwd: prep.runsDir }); }
  catch (e) { failed(e.code || "CLAUDE_NOT_LOGGED_IN", e.message, prep.runsDir, ctxBase); return; }

  // 5. 驱动 Claude 输出编辑 JSON(只读工具,不写文件)
  status("running");
  const promptText = buildPatchPrompt({ runId, task });
  const claudeStream = (ev) => { try { emit({ type: "bridge_stream", run_id: runId, kind: ev.kind, text: ev.text, starting: !!ev.starting }); } catch (_) {} };
  let resultText;
  try {
    const r = await cli.runPatch({ cwd: prep.runsDir, promptText, timeoutMs: PATCH_TIMEOUT_MS, onStream: claudeStream });
    resultText = r.resultText;
  } catch (e) { failed(e.code || "CLAUDE_RUN_FAILED", e.message, prep.runsDir, ctxBase); return; }

  // 6-8. 提取/校验编辑清单 → dry-run 状态标注 → 落 edits.json(共享 persistPatchPreview,与 codex/copilot 同链)
  let annotated, compliance;
  try {
    const snapshotHtml = fs.readFileSync(prep.snapshotPath, "utf8");
    const r = persistPatchPreview({ runsDir: prep.runsDir, runId, snapshotHtml, task, taskSha256: bundle.taskSha256, resultText });
    annotated = r.edits; compliance = r.compliance;
  } catch (e) { failed(e.code || "PATCH_EDITS_INVALID", e.message, prep.runsDir, ctxBase); return; }

  // 9. 重读 source:运行期被改 → 预览作废
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed("SOURCE_MUTATED_DURING_PATCH", "cannot re-read source after patch preview", prep.runsDir, ctxBase); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed("SOURCE_MUTATED_DURING_PATCH", "source changed during patch preview; preview invalidated", prep.runsDir, { ...ctxBase, sourceSha256After });
    return;
  }

  // 10. patch-preview-ready(结构化编辑清单 + 状态 + 合规汇总;不含模型原始文本)
  emit({
    type: "patch-preview-ready",
    run_id: runId,
    task_sha256: bundle.taskSha256,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: prep.sourceSha256Before,
    edits: annotated,
    compliance
  });
}

// —— 方向3:apply 编排(run_kind === "patch_apply")——
// 读回 preview 落盘的 edits.json + source snapshot,应用 confirmed_edit_ids 子集 → candidate.html,
// 经现有 validate/publish/manifest 发 candidate-ready(附带 applied/skipped)。
// 安全:candidate = snapshot + 且仅 + 确认编辑;真实 source 已偏离 snapshot(preview 后被改)→ SOURCE_MUTATED_DURING_PATCH 拒绝。
// provider-neutral:应用本身是确定性的(不调任何 Agent CLI),claude/codex/copilot 共用;
// workspaceFor({sourcePath,logicalDocumentId}) 决定 run 目录落在哪个 provider 子目录(默认 claude),
// provider 只影响 manifest 署名。codex-adapter / copilot-adapter 以薄封装注入各自参数复用本函数。
export async function executePatchApplyRun(msg, { emit: rawEmit, workspaceFor, provider } = {}) {
  if (typeof rawEmit !== "function") throw new Error("emit is required");
  const runId = msg && msg.run_id;
  const manifestProvider = provider || "claude_code_cli";
  const emit = wrapEmit(rawEmit, { runId, allowStream: false });
  const status = (s) => emit({ type: "bridge_status", run_id: runId, status: s });
  const failed = (code, message, runsDir, ctx) => {
    if (runsDir) {
      try {
        writeManifest({
          runsDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: manifestProvider,
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          changeContractSha256: (ctx && ctx.taskSha256) || null,
          status: PATCH_FAIL_STATUS[code] || "claude_failed"
        });
      } catch (_) {}
    }
    emit({ type: "bridge_failed", run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验
  if (!msg || typeof msg !== "object") { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing message" }); return; }
  if (typeof runId !== "string" || !runId) { emit({ type: "bridge_failed", code: "BAD_REQUEST", message: "missing run_id" }); return; }
  const source = msg.source || {};
  if (typeof source.logical_document_id !== "string" || !source.logical_document_id) { failed("BAD_REQUEST", "missing source.logical_document_id"); return; }
  if (typeof source.artifact_uri !== "string" || !source.artifact_uri) { failed("BAD_REQUEST", "missing source.artifact_uri"); return; }
  if (!Array.isArray(msg.confirmed_edit_ids)) { failed("BAD_REQUEST", "confirmed_edit_ids must be an array"); return; }
  const confirmedIds = new Set(msg.confirmed_edit_ids.map(String));

  status("checking");

  // 2. 定位 preview 留下的 run 目录(workspace 由 source+logicalId 稳定派生;provider 子目录由 workspaceFor 决定)
  const workspaceRoot = sourceWorkspaceRoot(source);
  let sourcePath, workspace;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri, { workspaceRoot });
    workspace = workspaceFor
      ? workspaceFor({ sourcePath, logicalDocumentId: source.logical_document_id })
      : createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id }); return; }
  const runsDir = path.join(workspace, "runs", runId);
  const snapshotPath = path.join(runsDir, "source.html");
  const editsPath = path.join(runsDir, "edits.json");
  const candidatePath = path.join(runsDir, "candidate.html");
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(editsPath)) {
    failed("PATCH_RUN_NOT_FOUND", "patch preview run dir missing (snapshot/edits)", null, { logicalDocumentId: source.logical_document_id, sourcePath });
    return;
  }

  // 3. 读 snapshot + edits + task
  let snapshotHtml, snapshotByteLength, snapshotSha, editsRecord, task;
  try {
    const snapBuf = fs.readFileSync(snapshotPath);
    snapshotHtml = snapBuf.toString("utf8");
    snapshotByteLength = snapBuf.length;
    snapshotSha = sha256Bytes(snapBuf);
    editsRecord = JSON.parse(fs.readFileSync(editsPath, "utf8"));
    task = readTaskJson(runsDir, runId);
  } catch (e) { failed("PATCH_RUN_NOT_FOUND", "cannot read patch run artifacts: " + (e && e.message), null, { logicalDocumentId: source.logical_document_id, sourcePath }); return; }
  const allEdits = Array.isArray(editsRecord.edits) ? editsRecord.edits : [];
  const confirmedEdits = allEdits.filter((ed) => ed && confirmedIds.has(String(ed.id)));
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: snapshotSha, taskSha256: editsRecord.task_sha256 || null };

  // 4. source 漂移校验:真实 source 必须仍等于 snapshot(preview 后被改 → 拒绝基于陈旧内容产 candidate)
  let realSourceSha;
  try { realSourceSha = sha256File(sourcePath); }
  catch (e) { failed("SOURCE_MUTATED_DURING_PATCH", "cannot re-read source before apply", runsDir, ctxBase); return; }
  if (realSourceSha !== snapshotSha) {
    failed("SOURCE_MUTATED_DURING_PATCH", "source changed since patch preview; candidate not produced", runsDir, ctxBase);
    return;
  }

  // 5. 确定性应用(构造保证:candidate = snapshot + 且仅 + 确认编辑)
  status("running");
  const result = applyEdits(snapshotHtml, confirmedEdits, task);
  try {
    fs.writeFileSync(candidatePath, Buffer.from(result.html, "utf8"), { mode: 0o600 });
  } catch (e) { failed("PREPARE_FAILED", "cannot write candidate.html: " + (e && e.message), runsDir, ctxBase); return; }

  // 6. 校验 candidate 形态
  let cand;
  try { cand = validateCandidate(candidatePath, snapshotByteLength); }
  catch (e) { failed(e.code || "CANDIDATE_MISSING", e.message, runsDir, ctxBase); return; }

  // 7. 原子 sibling + 版本号
  let resultPath, versionLabel;
  try {
    versionLabel = nextCandidateVersionLabel({ sourcePath, logicalDocumentId: source.logical_document_id });
    resultPath = publishSiblingCandidate({ candidatePath, sourcePath, runId, versionLabel });
  } catch (e) { failed(e.code || "CANDIDATE_PUBLISH_FAILED", e.message, runsDir, ctxBase); return; }

  // 8. ready manifest
  let manifestPath;
  try {
    manifestPath = writeManifest({
      runsDir, runId, logicalDocumentId: source.logical_document_id, provider: manifestProvider,
      sourcePath, sourceSha256Before: snapshotSha, sourceSha256After: realSourceSha,
      candidateResultPath: resultPath, candidateWorkspacePath: candidatePath,
      candidateSha256: cand.sha256, candidateByteLength: cand.byteLength,
      changeContractSha256: editsRecord.task_sha256 || null, sessionId: null, status: "ready"
    });
  } catch (e) { failed("MANIFEST_FAILED", e.message, runsDir, ctxBase); return; }

  // 9. candidate-ready(复用现有终态)。不再附带 patch.applied/skipped —— 候选页不画任何改动标记
  //    (禁止私自样式变更;精确编辑结果即成品文档,改动沿用原样式)。applyEdits 的 applied/skipped 仅用于本地确定性应用,不上报。
  emit({
    type: "candidate-ready",
    run_id: runId,
    task_sha256: editsRecord.task_sha256 || null,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: snapshotSha,
    candidate_uri: pathToFileURL(resultPath).href,
    candidate_sha256: cand.sha256,
    version_label: versionLabel,
    manifest_path: manifestPath
  });
}
