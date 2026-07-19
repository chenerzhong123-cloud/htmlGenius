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
  buildHandoffPrompt, rootAnnotationIdsOf, isSha256Tagged, sha256File
} from "./task-bundle.mjs";
import { isSessionUuid, checkAuth, runHandoff, resumeHandoff } from "./claude-cli.mjs";

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
