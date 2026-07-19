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
  buildHandoffPrompt, buildCandidatePrompt, rootAnnotationIdsOf, isSha256Tagged, sha256File
} from "./task-bundle.mjs";
import { isSessionUuid, checkAuth, runHandoff, resumeHandoff } from "./claude-cli.mjs";
import {
  resolveSourcePath, prepareCandidateRun, writeManifest, validateCandidate,
  publishSiblingCandidate, quarantineCandidate
} from "./candidate-workspace.mjs";
import { pathToFileURL } from "node:url";

const realClaude = { checkAuth, runHandoff, resumeHandoff };

function truncateMsg(s) {
  const t = String(s || "");
  return t.length > 400 ? t.slice(0, 400) + "…" : t;
}

export async function executeHandoff(msg, { emit, claude } = {}) {
  if (typeof emit !== "function") throw new Error("emit is required");
  const cli = claude || realClaude;
  const runId = msg && msg.run_id;
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

  // —— 2. source 解析 + base 哈希比对 ——
  let sourcePath;
  try {
    sourcePath = resolveSourceArtifact(source.artifact_uri).sourcePath;
    verifySourceHash({ sourcePath, expectedHash: source.base_artifact_hash });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message); return; }

  // —— 3. 稳定 workspace + task bundle(JSON + md,0600/0700)——
  let workspace, bundle;
  try {
    workspace = createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: source.base_artifact_hash });
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

  // —— 7. 重读 source:运行期被外部改动 → 不算成功交接(本版 Claude 无写权限,改动来自用户/其他进程)——
  try {
    verifySourceHash({ sourcePath, expectedHash: source.base_artifact_hash });
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
  CLAUDE_TIMEOUT: "timed_out"
};

export async function executeCandidateRun(msg, { emit, claude } = {}) {
  if (typeof emit !== "function") throw new Error("emit is required");
  const cli = claude || realClaude;
  const runId = msg && msg.run_id;
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
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri);
    verifySourceHash({ sourcePath, expectedHash: source.base_artifact_hash });
    workspace = createWorkspace({ sourcePath, logicalDocumentId: source.logical_document_id });
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: source.base_artifact_hash });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, taskSha256: null }); return; }

  // 3. candidate 工作区:snapshot(0400)+ task 复制进 runs/<runId>(0700)
  let prep;
  try {
    prep = prepareCandidateRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || "PREPARE_FAILED", e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 4. auth
  try { await cli.checkAuth({ cwd: prep.runsDir }); }
  catch (e) { failed(e.code || "CLAUDE_NOT_LOGGED_IN", e.message, prep.runsDir, ctxBase); return; }

  // 5. 执行:claude(Read,Glob,Grep,Write),cwd=runs/<runId>
  status("running");
  const promptText = buildCandidatePrompt({ runId, task });
  let sessionId;
  try {
    if (session.mode === "continue") {
      const r = await cli.resumeHandoff({ cwd: prep.runsDir, promptText, resumeSessionId: session.session_id, runKind: "candidate" });
      sessionId = r.sessionId;
    } else {
      const r = await cli.runHandoff({ cwd: prep.runsDir, promptText, runKind: "candidate" });
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

  // 8. 原子 sibling 复制(同名不覆盖)
  let resultPath;
  try { resultPath = publishSiblingCandidate({ candidatePath: prep.candidatePath, sourcePath, runId }); }
  catch (e) { failed(e.code || "CANDIDATE_PUBLISH_FAILED", e.message, prep.runsDir, { ...ctxBase, sourceSha256After, sessionId }); return; }

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

  // 10. candidate-ready(最小 completion;不含 Claude stdout/思维链)
  emit({
    type: "candidate-ready",
    run_id: runId,
    task_sha256: bundle.taskSha256,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: prep.sourceSha256Before,
    candidate_uri: pathToFileURL(resultPath).href,
    candidate_sha256: cand.sha256,
    manifest_path: manifestPath
  });
}
