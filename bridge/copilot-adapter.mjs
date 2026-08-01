// bridge/copilot-adapter.mjs — v0.8.2 GitHub Copilot provider 的工作流编排(spec §5/§6)。
// executeCopilotCandidateRun / executeCopilotPlanRun:与 host-runner(claude)/ codex-adapter 并列,
// host.mjs 按 copilot_handoff_start + run_kind 分发。
//
// 流程(candidate):字段校验(session.mode 必须 new)→ candidate workspace(snapshot)→ task bundle →
// 执行前 runtime 选择(local_cli 优先 → bundled;Plan 携带 required_provider_runtime 时锁定,不一致 → RUNTIME_CHANGED)→
// 受控 SDK session(empty 模式 + 工具 allow-list + onPreToolUse 路径围栏,只允许写 candidate.html)→
// source hash 校验 → validateCandidate → publishSibling(版本号 V1.N)→ manifest(provider=github_copilot,不存 session)→ candidate-ready。
// Plan 同构:只允许写 output/plan.json;plan-ready 带 provider_runtime;绝不产出 candidate(§5.4/§9)。
// 不采信模型 response 文本:成功与否只看受控输出文件 + hash 校验(§5.3)。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveSourcePath, prepareCandidateRun, writeManifest, validateCandidate,
  publishSiblingCandidate, quarantineCandidate, writeApprovedPlan, nextCandidateVersionLabel
} from './candidate-workspace.mjs';
import {
  createWorkspace, writeTaskBundle, buildCandidatePrompt, buildPlanPrompt, buildPatchPrompt, approvedPlanPreamble,
  isSha256Tagged, sha256File
} from './task-bundle.mjs';
import {
  preparePlanRun, verifyTaskBundleUnchanged, validatePlanJson, writePlanManifest, quarantinePlan
} from './plan-workspace.mjs';
import {
  COPILOT_PROVIDER, COPILOT_RUNTIMES, COPILOT_ERRORS,
  PLAN_TIMEOUT_MS, CANDIDATE_TIMEOUT_MS,
  selectCopilotRuntime, runCopilotSession
} from './copilot-runtime.mjs';
import { persistPatchPreview, executePatchApplyRun } from './host-runner.mjs';

const BRIDGE_DIR_NAME = '.htmlgenius-bridge';
const PROVIDER_DIR_NAME = 'copilot';

// copilot workspace 目录:.htmlgenius-bridge/copilot/<logicalId>/(与 claude / codex 的 provider 子目录并列)
export function copilotWorkspacePathFor({ sourcePath, logicalDocumentId }) {
  // BR-1:与 claude 的 workspacePathFor 同款白名单校验,防 logical_document_id 路径穿越
  // (path.join 会归一化 "..";调用处 try/catch 会以 BAD_LOGICAL_ID 上报 failed)。
  if (typeof logicalDocumentId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(logicalDocumentId)) {
    const e = new Error('logical_document_id must match [A-Za-z0-9_:-]{1,128}');
    e.code = 'BAD_LOGICAL_ID';
    throw e;
  }
  return path.join(path.dirname(sourcePath), BRIDGE_DIR_NAME, PROVIDER_DIR_NAME, logicalDocumentId);
}

// COPILOT_HOME 放在 provider 目录下、run workspace 围栏之外(Agent 的文件工具读不到自己的会话态;§7)。
function copilotHomeFor(workspace, runId, kind) {
  return path.join(workspace, '.copilot-home', (kind === 'plan' ? 'plan-' : 'run-') + runId);
}

function truncateMsg(s) { const t = String(s || ''); return t.length > 400 ? t.slice(0, 400) + '…' : t; }

// manifest 失败 status(§5.5 / §3.3)
const COPILOT_FAIL_STATUS = {
  [COPILOT_ERRORS.SDK_NOT_INSTALLED]: 'copilot_sdk_not_installed',
  [COPILOT_ERRORS.CLI_NOT_FOUND]: 'copilot_cli_not_found',
  [COPILOT_ERRORS.INCOMPATIBLE]: 'copilot_incompatible',
  [COPILOT_ERRORS.AUTH_REQUIRED]: 'copilot_auth_required',
  [COPILOT_ERRORS.RUNTIME_CHANGED]: 'copilot_runtime_changed',
  [COPILOT_ERRORS.PERMISSION_DENIED]: 'copilot_permission_denied',
  [COPILOT_ERRORS.PLAN_FAILED]: 'copilot_plan_failed',
  [COPILOT_ERRORS.PLAN_TIMEOUT]: 'copilot_plan_timeout',
  [COPILOT_ERRORS.RUN_FAILED]: 'copilot_run_failed',
  [COPILOT_ERRORS.TIMEOUT]: 'copilot_timeout',
  SOURCE_MUTATED_DURING_CANDIDATE: 'source_changed_during_run',
  SOURCE_CHANGED_BEFORE_START: 'source_changed_before_start',
  SOURCE_MUTATED_DURING_PLAN: 'source_changed_during_run',
  SOURCE_MUTATED_DURING_PATCH: 'source_changed_during_run',
  TASK_MUTATED_DURING_PLAN: 'task_changed_during_run',
  PATCH_EDITS_INVALID: 'patch_edits_invalid',
  PATCH_RUN_NOT_FOUND: 'patch_run_not_found',
  CANDIDATE_MISSING: 'candidate_missing',
  CANDIDATE_INVALID_HTML: 'candidate_invalid_html',
  CANDIDATE_SYMLINK: 'candidate_invalid_html',
  CANDIDATE_NOT_FILE: 'candidate_invalid_html',
  CANDIDATE_EMPTY: 'candidate_invalid_html',
  CANDIDATE_TOO_LARGE: 'candidate_invalid_html',
  CANDIDATE_NOT_UTF8: 'candidate_invalid_html'
};

// runCopilotSession 的脱敏事件 → bridge_stream 帧(与 claude/codex 同一 UI 协议)。
function makeCopilotStreamer(runId, emit) {
  return (e) => {
    try {
      if (!e) return;
      if (e.kind === 'text') emit({ type: 'bridge_stream', run_id: runId, kind: 'delta', text: String(e.text || '') });
      else if (e.kind === 'tool') emit({ type: 'bridge_stream', run_id: runId, kind: 'info', text: 'tool: ' + String(e.name || '') });
      else if (e.kind === 'tool_denied') emit({ type: 'bridge_stream', run_id: runId, kind: 'info', text: 'denied: ' + String(e.tool || '') + ' (' + String(e.category || '') + ')' });
    } catch (_) { /* 非关键 */ }
  };
}

// ———————————————————————— Candidate ————————————————————————

export async function executeCopilotCandidateRun(msg, { emit, selectRuntime, sdkLoader, execFileImpl, env, fsImpl } = {}) {
  if (typeof emit !== 'function') throw new Error('emit is required');
  const runId = msg && msg.run_id;
  const status = (s) => emit({ type: 'bridge_status', run_id: runId, status: s });
  const failed = (code, message, runsDir, ctx) => {
    if (runsDir) {
      try { quarantineCandidate(runsDir); } catch (_) {}
      try {
        writeManifest({
          runsDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: COPILOT_PROVIDER,
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          sourceSha256After: (ctx && ctx.sourceSha256After) || null,
          changeContractSha256: (ctx && ctx.taskSha256) || null,
          sessionId: null, // §7.5:Copilot session ID 永不读取/持久化
          status: COPILOT_FAIL_STATUS[code] || 'copilot_run_failed'
        });
      } catch (_) {}
    }
    emit({ type: 'bridge_failed', run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验(§5.3)
  if (!msg || typeof msg !== 'object') { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing message' }); return; }
  if (typeof runId !== 'string' || !runId) { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing run_id' }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== 'string' || !source.logical_document_id) { failed('BAD_REQUEST', 'missing source.logical_document_id'); return; }
  if (typeof source.artifact_uri !== 'string' || !source.artifact_uri) { failed('BAD_REQUEST', 'missing source.artifact_uri'); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed('BAD_REQUEST', 'source.base_artifact_hash must be sha256:<64hex>'); return; }
  // Copilot 始终新建 ephemeral session;不支持续发(§0/§7.6)
  if (session.mode !== 'new') { failed('SESSION_MODE_NOT_ALLOWED', 'copilot candidate requires session.mode=new'); return; }
  if (task && task.mode === 'restructure') { failed('INVALID_MODE', 'restructure is plan-only; copilot candidate 不允许'); return; }

  status('checking');

  // 2. source 解析 + workspace + task bundle
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri);
    const hostHash = sha256File(sourcePath);
    workspace = copilotWorkspacePathFor({ sourcePath, logicalDocumentId: source.logical_document_id });
    fs.mkdirSync(workspace, { recursive: true });
    try { fs.chmodSync(workspace, 0o700); } catch (_) {}
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id }); return; }

  // 3. candidate workspace:snapshot(0400)+ task 复制进 runs/<runId>(0700)
  let prep;
  try {
    prep = prepareCandidateRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 3.1 携带 approved_plan → 只读 approved-plan.md(§5.3 统一契约)
  if (msg.approved_plan && typeof msg.approved_plan.edited_plan_markdown === 'string') {
    try { writeApprovedPlan({ runsDir: prep.runsDir, editedPlanMarkdown: msg.approved_plan.edited_plan_markdown }); }
    catch (e) { failed('PREPARE_FAILED', 'cannot write approved-plan.md: ' + (e && e.message), prep.runsDir, ctxBase); return; }
  }

  // 4. 执行前 runtime 选择(§3.2:plan 携带 required_provider_runtime 时锁定;此前允许 local→bundled fallback)
  let sel;
  try {
    const selector = selectRuntime || selectCopilotRuntime;
    sel = await selector({
      requiredRuntime: msg.required_provider_runtime || null,
      sdkLoader, execFileImpl, env, fsImpl
    });
  } catch (e) { failed(e.code || COPILOT_ERRORS.SDK_NOT_INSTALLED, e.message, prep.runsDir, ctxBase); return; }

  // 5. 受控 session:cwd=runs/<runId>,只允许写 candidate.html
  status('running');
  const home = copilotHomeFor(workspace, runId, 'candidate');
  try { fs.mkdirSync(home, { recursive: true }); try { fs.chmodSync(home, 0o700); } catch (_) {} } catch (_) {}
  let run;
  try {
    run = await runCopilotSession({
      sdk: sel.sdk, runtime: sel.runtime, cliPath: sel.cliPath,
      cwd: prep.runsDir, baseDirectory: home,
      prompt: buildCandidatePrompt({ runId, task }) + (msg.approved_plan ? approvedPlanPreamble(msg.approved_plan.edited_plan_markdown) : ''),
      timeoutMs: CANDIDATE_TIMEOUT_MS,
      writableFiles: [prep.candidatePath],
      runKind: 'candidate',
      onEvent: makeCopilotStreamer(runId, emit),
      fsImpl
    });
  } catch (e) { failed(e.code || COPILOT_ERRORS.RUN_FAILED, e.message, prep.runsDir, ctxBase); return; }

  // 6. 重读 source:运行期被改 → 不采用(§7)
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed('SOURCE_MUTATED_DURING_CANDIDATE', '无法重读 source', prep.runsDir, ctxBase); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed('SOURCE_MUTATED_DURING_CANDIDATE', 'source 在 copilot run 期间变化,candidate 未采用', prep.runsDir, { ...ctxBase, sourceSha256After }); return;
  }

  // 7. 校验 candidate 形态;若期间有越权工具被拒且无输出 → 归因 PERMISSION_DENIED(§5.5)
  let cand;
  try { cand = validateCandidate(prep.candidatePath, prep.sourceByteLength); }
  catch (e) {
    const code = (run && run.denialCount > 0) ? COPILOT_ERRORS.PERMISSION_DENIED : (e.code || 'CANDIDATE_MISSING');
    failed(code, e.message, prep.runsDir, { ...ctxBase, sourceSha256After }); return;
  }

  // 8. 原子 sibling(同名不覆盖)+ 文档级版本号 V1.N
  let resultPath, versionLabel;
  try {
    versionLabel = nextCandidateVersionLabel({ sourcePath, logicalDocumentId: source.logical_document_id });
    resultPath = publishSiblingCandidate({ candidatePath: prep.candidatePath, sourcePath, runId, versionLabel });
  } catch (e) { failed(e.code || 'CANDIDATE_PUBLISH_FAILED', e.message, prep.runsDir, { ...ctxBase, sourceSha256After }); return; }

  // 9. ready manifest(provider=github_copilot;不存 session)
  let manifestPath;
  try {
    manifestPath = writeManifest({
      runsDir: prep.runsDir, runId, logicalDocumentId: source.logical_document_id, provider: COPILOT_PROVIDER,
      sourcePath, sourceSha256Before: prep.sourceSha256Before, sourceSha256After,
      candidateResultPath: resultPath, candidateWorkspacePath: prep.candidatePath,
      candidateSha256: cand.sha256, candidateByteLength: cand.byteLength,
      changeContractSha256: bundle.taskSha256, sessionId: null, status: 'ready'
    });
  } catch (e) { failed('MANIFEST_FAILED', e.message, prep.runsDir, { ...ctxBase, sourceSha256After }); return; }

  // 10. candidate-ready(字段与 claude/codex 相同;额外 provider_runtime;无 thread_id;§5.3)
  emit({
    type: 'candidate-ready',
    provider: COPILOT_PROVIDER,
    provider_runtime: sel.runtime,
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

// ———————————————————————— Plan ————————————————————————

export async function executeCopilotPlanRun(msg, { emit, selectRuntime, sdkLoader, execFileImpl, env, fsImpl } = {}) {
  if (typeof emit !== 'function') throw new Error('emit is required');
  const runId = msg && msg.run_id;
  const status = (s) => emit({ type: 'bridge_status', run_id: runId, status: s });
  const failed = (code, message, plansDir, ctx) => {
    if (plansDir) {
      try { quarantinePlan(plansDir); } catch (_) {}
      try {
        writePlanManifest({
          plansDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: COPILOT_PROVIDER,
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          sourceSha256After: (ctx && ctx.sourceSha256After) || null,
          taskSha256: (ctx && ctx.taskSha256) || null,
          status: 'failed', errorCode: code
        });
      } catch (_) {}
    }
    emit({ type: 'bridge_failed', run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验(§5.4)
  if (!msg || typeof msg !== 'object') { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing message' }); return; }
  if (typeof runId !== 'string' || !runId) { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing run_id' }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== 'string' || !source.logical_document_id) { failed('BAD_REQUEST', 'missing source.logical_document_id'); return; }
  if (typeof source.artifact_uri !== 'string' || !source.artifact_uri) { failed('BAD_REQUEST', 'missing source.artifact_uri'); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed('BAD_REQUEST', 'source.base_artifact_hash must be sha256:<64hex>'); return; }
  if (session.mode !== 'new') { failed('SESSION_MODE_NOT_ALLOWED', 'copilot plan requires session.mode=new'); return; }
  if (task && task.mode === 'restructure') { failed('INVALID_MODE', 'restructure not allowed'); return; }

  status('checking');

  // 2. source 解析 + workspace + task bundle
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri);
    const hostHash = sha256File(sourcePath);
    workspace = copilotWorkspacePathFor({ sourcePath, logicalDocumentId: source.logical_document_id });
    fs.mkdirSync(workspace, { recursive: true });
    try { fs.chmodSync(workspace, 0o700); } catch (_) {}
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id }); return; }

  // 3. plan 工作区:snapshot(0400)+ task 复制进 plans/<runId>(0700)+ output/
  let prep;
  try {
    prep = preparePlanRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath, taskSha256: bundle.taskSha256 }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 4. 执行前 runtime 选择(plan 无 required runtime;local→bundled fallback 允许)
  let sel;
  try {
    const selector = selectRuntime || selectCopilotRuntime;
    sel = await selector({ requiredRuntime: null, sdkLoader, execFileImpl, env, fsImpl });
  } catch (e) { failed(e.code || COPILOT_ERRORS.SDK_NOT_INSTALLED, e.message, prep.plansDir, ctxBase); return; }

  // 5. 受控 session:cwd=plans/<runId>,只允许写 output/plan.json(不得用 SDK 的 plan.md API / 内建 /plan;§5.4)
  status('running');
  const home = copilotHomeFor(workspace, runId, 'plan');
  try { fs.mkdirSync(home, { recursive: true }); try { fs.chmodSync(home, 0o700); } catch (_) {} } catch (_) {}
  let run;
  try {
    run = await runCopilotSession({
      sdk: sel.sdk, runtime: sel.runtime, cliPath: sel.cliPath,
      cwd: prep.plansDir, baseDirectory: home,
      prompt: buildPlanPrompt({ runId, task }),
      timeoutMs: PLAN_TIMEOUT_MS,
      writableFiles: [prep.planJsonPath],
      runKind: 'plan',
      onEvent: makeCopilotStreamer(runId, emit),
      fsImpl
    });
  } catch (e) { failed(e.code || COPILOT_ERRORS.PLAN_FAILED, e.message, prep.plansDir, ctxBase); return; }

  // 6. 重读 source:运行期被改 → 计划废弃
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed('SOURCE_MUTATED_DURING_PLAN', '无法重读 source', prep.plansDir, ctxBase); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed('SOURCE_MUTATED_DURING_PLAN', 'source 在 copilot plan run 期间变化,计划未采用', prep.plansDir, { ...ctxBase, sourceSha256After }); return;
  }

  // 7. task bundle hash 前后比对
  try { verifyTaskBundleUnchanged({ plansDir: prep.plansDir, taskJsonName: prep.taskJsonName, taskSha256Before: prep.taskSha256Before }); }
  catch (e) { failed('TASK_MUTATED_DURING_PLAN', e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 8. 校验 output/plan.json(唯一可信输出;模型 response 文本不作为计划;有越权拒绝且无计划 → PERMISSION_DENIED)
  let planResult;
  try { planResult = validatePlanJson(prep.planJsonPath); }
  catch (e) {
    const code = (run && run.denialCount > 0) ? COPILOT_ERRORS.PERMISSION_DENIED : (e.code || 'PLAN_MISSING');
    failed(code, e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return;
  }

  // 9. ready manifest(provider=github_copilot;plan 不可续发)
  let manifestPath;
  try {
    manifestPath = writePlanManifest({
      plansDir: prep.plansDir, runId, logicalDocumentId: source.logical_document_id, provider: COPILOT_PROVIDER,
      sourcePath, sourceSha256Before: prep.sourceSha256Before, sourceSha256After,
      taskSha256: bundle.taskSha256, planSha256: planResult.planSha256, planByteLength: planResult.byteLength,
      status: 'ready'
    });
  } catch (e) { failed('MANIFEST_FAILED', e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 10. plan-ready(§5.4:带 provider_runtime 供确认时锁定;绝不附带 candidate)
  const p = planResult.plan;
  emit({
    type: 'plan-ready',
    provider: COPILOT_PROVIDER,
    provider_runtime: sel.runtime,
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

// ———————————————————————— Patch(方向3 确定性编辑快车道)————————————————————————
// 与 claude/codex 同型:Copilot 在完全只读(writableFiles=[] → onPreToolUse 拒绝一切写)的受控 session 中
// 读 source.html,最终 reply 文本输出结构化编辑 JSON → host 提取并确定性应用(复用 persistPatchPreview /
// executePatchApplyRun,不重建第二套解析与应用链)。不采信 reply 为「结果」之外的任何副作用(没有副作用可言:禁写)。

const COPILOT_PATCH_TIMEOUT_MS = 8 * 60 * 1000; // 结构化输出比整页重写快,与 claude patch 同口径;用户可随时终止

// sendAndWait 的 reply 形态跨 SDK 版本不稳:string | {data:{content}} | {content} | parts 数组;
// 统一归一为纯文本再交 patch-edits 稳健提取(容忍围栏/prose)。
function copilotReplyText(reply) {
  if (reply == null) return "";
  if (typeof reply === "string") return reply;
  if (typeof reply.content === "string") return reply.content;
  if (reply.data && typeof reply.data.content === "string") return reply.data.content;
  if (Array.isArray(reply.content)) {
    return reply.content.map((p) => (p && typeof p.text === "string") ? p.text : "").join("");
  }
  try { return JSON.stringify(reply); } catch (_) { return ""; }
}

export async function executeCopilotPatchPreviewRun(msg, { emit, selectRuntime, sdkLoader, execFileImpl, env, fsImpl } = {}) {
  if (typeof emit !== 'function') throw new Error('emit is required');
  const runId = msg && msg.run_id;
  const status = (s) => emit({ type: 'bridge_status', run_id: runId, status: s });
  const failed = (code, message, runsDir, ctx) => {
    if (runsDir) {
      try {
        writeManifest({
          runsDir, runId,
          logicalDocumentId: (ctx && ctx.logicalDocumentId) || (msg && msg.source && msg.source.logical_document_id) || null,
          provider: COPILOT_PROVIDER,
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          changeContractSha256: (ctx && ctx.taskSha256) || null,
          sessionId: null, // §7.5:Copilot session ID 永不读取/持久化
          status: COPILOT_FAIL_STATUS[code] || 'copilot_run_failed'
        });
      } catch (_) {}
    }
    emit({ type: 'bridge_failed', run_id: runId, code, message: truncateMsg(message) });
  };

  // 1. 字段校验
  if (!msg || typeof msg !== 'object') { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing message' }); return; }
  if (typeof runId !== 'string' || !runId) { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing run_id' }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== 'string' || !source.logical_document_id) { failed('BAD_REQUEST', 'missing source.logical_document_id'); return; }
  if (typeof source.artifact_uri !== 'string' || !source.artifact_uri) { failed('BAD_REQUEST', 'missing source.artifact_uri'); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed('BAD_REQUEST', 'source.base_artifact_hash must be sha256:<64hex>'); return; }
  if (session.mode !== 'new') { failed('SESSION_MODE_NOT_ALLOWED', 'copilot patch requires session.mode=new'); return; }
  if (!task || task.mode !== 'precise_patch') { failed('INVALID_MODE', 'patch run_kind requires task.mode precise_patch'); return; }

  status('checking');

  // 2. source 解析 + workspace + task bundle
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri);
    const hostHash = sha256File(sourcePath);
    workspace = copilotWorkspacePathFor({ sourcePath, logicalDocumentId: source.logical_document_id });
    fs.mkdirSync(workspace, { recursive: true });
    try { fs.chmodSync(workspace, 0o700); } catch (_) {}
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id }); return; }

  // 3. run 工作区:snapshot(0400)+ task 复制进 runs/<runId>(与 apply 共享同一 run 目录)
  let prep;
  try {
    prep = prepareCandidateRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 4. 执行前 runtime 选择(patch 无 required runtime;local→bundled fallback 允许)
  let sel;
  try {
    const selector = selectRuntime || selectCopilotRuntime;
    sel = await selector({ requiredRuntime: null, sdkLoader, execFileImpl, env, fsImpl });
  } catch (e) { failed(e.code || COPILOT_ERRORS.SDK_NOT_INSTALLED, e.message, prep.runsDir, ctxBase); return; }

  // 5. 完全只读 session:writableFiles=[] → onPreToolUse 拒绝一切写工具(与 claude 禁 Write argv 同语义)
  status('running');
  const home = copilotHomeFor(workspace, runId, 'candidate');
  try { fs.mkdirSync(home, { recursive: true }); try { fs.chmodSync(home, 0o700); } catch (_) {} } catch (_) {}
  let run;
  try {
    run = await runCopilotSession({
      sdk: sel.sdk, runtime: sel.runtime, cliPath: sel.cliPath,
      cwd: prep.runsDir, baseDirectory: home,
      prompt: buildPatchPrompt({ runId, task }),
      timeoutMs: COPILOT_PATCH_TIMEOUT_MS,
      writableFiles: [],          // 空允许写清单 → 任何写工具都被拒(patch 只读 source,输出在 reply 文本)
      runKind: 'patch',
      onEvent: null,              // patch 预览不流式(与 claude patch 同口径)
      fsImpl
    });
  } catch (e) { failed(e.code || COPILOT_ERRORS.RUN_FAILED, e.message, prep.runsDir, ctxBase); return; }

  // 6. 提取/校验编辑清单 → dry-run 状态标注 → 落 edits.json(与 claude/codex 共享 persistPatchPreview)
  let annotated, compliance;
  try {
    const snapshotHtml = fs.readFileSync(prep.snapshotPath, 'utf8');
    const r = persistPatchPreview({
      runsDir: prep.runsDir, runId, snapshotHtml, task, taskSha256: bundle.taskSha256,
      resultText: copilotReplyText(run && run.reply)
    });
    annotated = r.edits; compliance = r.compliance;
  } catch (e) {
    // 有越权写被拒且无有效编辑输出 → 归因 PERMISSION_DENIED(与 candidate/plan 同归因口径)
    const code = (e.code && e.code !== 'PATCH_EDITS_INVALID') ? e.code
      : (run && run.denialCount > 0) ? COPILOT_ERRORS.PERMISSION_DENIED : 'PATCH_EDITS_INVALID';
    failed(code, e.message, prep.runsDir, ctxBase); return;
  }

  // 7. 重读 source:运行期被改 → 预览作废
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed('SOURCE_MUTATED_DURING_PATCH', '无法重读 source', prep.runsDir, ctxBase); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed('SOURCE_MUTATED_DURING_PATCH', 'source 在 copilot patch preview 期间变化,预览作废', prep.runsDir, { ...ctxBase, sourceSha256After });
    return;
  }

  // 8. patch-preview-ready(与 claude/codex 同型;带 provider_runtime 供诊断)
  emit({
    type: 'patch-preview-ready',
    provider: COPILOT_PROVIDER,
    provider_runtime: sel.runtime,
    run_id: runId,
    task_sha256: bundle.taskSha256,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: prep.sourceSha256Before,
    edits: annotated,
    compliance
  });
}

// copilot patch apply:确定性应用与 provider 无关(不调 Agent SDK),复用 host-runner 的 apply 编排,
// 仅注入 copilot 的 workspace 解析(provider 子目录)与 manifest 署名。
export function executeCopilotPatchApplyRun(msg, opts = {}) {
  return executePatchApplyRun(msg, {
    ...opts,
    workspaceFor: ({ sourcePath, logicalDocumentId }) => copilotWorkspacePathFor({ sourcePath, logicalDocumentId }),
    provider: COPILOT_PROVIDER
  });
}
