// bridge/codex-adapter.mjs — Codex App Server provider 的工作流编排(v0.8 spec §4/§6/§7)。
// executeCodexCandidateRun:校验 → candidate workspace(snapshot) → App 发现/schema 兼容 →
// CodexAppServerClient.runCandidate(handshake→thread/start|resume→turn/start→turn/completed) →
// source hash 校验 → validateCandidate → publishSibling → manifest(provider=codex_app_server) → candidate-ready。
// 复用 Night Pack A 的 candidate-workspace / task-bundle,不重建第二套文件协议(spec §7)。
// 与 host-runner.executeCandidateRun(claude) 并列;host.mjs 按 provider 分发。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveSourcePath, prepareCandidateRun, writeManifest, validateCandidate,
  publishSiblingCandidate, quarantineCandidate, writeApprovedPlan
} from './candidate-workspace.mjs';
import { createWorkspace, writeTaskBundle, buildCodexPrompt, buildPlanPrompt, approvedPlanPreamble, isSha256Tagged, sha256File } from './task-bundle.mjs';
import {
  discoverAppRuntime, verifySchema, CodexAppServerClient, DEFAULT_TURN_TIMEOUT_MS,
  CODEX_APP_NOT_FOUND, CODEX_APP_UNTRUSTED, CODEX_INCOMPATIBLE, CODEX_AUTH_REQUIRED,
  CODEX_SESSION_UNAVAILABLE, CODEX_TURN_FAILED, CODEX_TIMED_OUT
} from './codex-app-server-client.mjs';
import {
  preparePlanRun, verifyTaskBundleUnchanged, validatePlanJson, writePlanManifest, quarantinePlan
} from './plan-workspace.mjs';

const SCHEMA_GEN_TIMEOUT_MS = 60_000;
const BRIDGE_DIR_NAME = '.htmlgenius-bridge';
const PROVIDER_DIR_NAME = 'codex';

// codex workspace 目录(spec §5/§6.3.1):.htmlgenius-bridge/codex/<logicalId>/(与 claude 的 provider 子目录并列)
export function codexWorkspacePathFor({ sourcePath, logicalDocumentId }) {
  return path.join(path.dirname(sourcePath), BRIDGE_DIR_NAME, PROVIDER_DIR_NAME, logicalDocumentId);
}

function truncateMsg(s) { const t = String(s || ''); return t.length > 400 ? t.slice(0, 400) + '…' : t; }
function sanitizedEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'];
  const env = {}; for (const k of keep) { if (process.env[k] != null) env[k] = process.env[k]; } return env;
}

// manifest 失败 status(spec §3.3/§9)
const CODEX_FAIL_STATUS = {
  [CODEX_APP_NOT_FOUND]: 'codex_app_not_found',
  [CODEX_APP_UNTRUSTED]: 'codex_app_untrusted',
  [CODEX_INCOMPATIBLE]: 'codex_incompatible',
  [CODEX_AUTH_REQUIRED]: 'codex_auth_required',
  [CODEX_SESSION_UNAVAILABLE]: 'codex_session_unavailable',
  [CODEX_TURN_FAILED]: 'codex_turn_failed',
  [CODEX_TIMED_OUT]: 'codex_timed_out',
  SOURCE_MUTATED_DURING_CANDIDATE: 'source_changed_during_run',
  SOURCE_CHANGED_BEFORE_START: 'source_changed_before_start',
  CANDIDATE_MISSING: 'candidate_missing',
  CANDIDATE_INVALID_HTML: 'candidate_invalid_html',
  CANDIDATE_SYMLINK: 'candidate_invalid_html',
  CANDIDATE_NOT_FILE: 'candidate_invalid_html',
  CANDIDATE_EMPTY: 'candidate_invalid_html',
  CANDIDATE_TOO_LARGE: 'candidate_invalid_html',
  CANDIDATE_NOT_UTF8: 'candidate_invalid_html'
};

// spawn <runtime> app-server generate-json-schema --out schemaDir(生产用;测试可注入 generateSchema)
export function spawnGenerateSchema(runtimePath, schemaDir) {
  return new Promise((resolve, reject) => {
    let child; let settled = false; let stderr = '';
    try {
      child = spawn(runtimePath, ['app-server', 'generate-json-schema', '--out', schemaDir],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv(), windowsHide: true });
    } catch (e) { return reject(Object.assign(new Error('spawn generate-json-schema 失败: ' + (e && e.message)), { code: CODEX_APP_NOT_FOUND })); }
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 1024); });
    const timer = setTimeout(() => { if (settled) return; settled = true; try { child.kill(); } catch (_) {} reject(Object.assign(new Error('generate-json-schema 超时'), { code: CODEX_INCOMPATIBLE })); }, SCHEMA_GEN_TIMEOUT_MS);
    child.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(Object.assign(new Error('spawn error: ' + (e && e.message)), { code: CODEX_APP_NOT_FOUND })); });
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timer); if (code === 0) resolve(); else reject(Object.assign(new Error('generate-json-schema exit ' + code + ': ' + stderr.slice(0, 200)), { code: CODEX_INCOMPATIBLE })); });
  });
}

export async function executeCodexCandidateRun(msg, { emit, runtime, client, schemaDir, generateSchema } = {}) {
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
          provider: 'codex_app_server',
          sourcePath: (ctx && ctx.sourcePath) || null,
          sourceSha256Before: (ctx && ctx.sourceSha256Before) || null,
          sourceSha256After: (ctx && ctx.sourceSha256After) || null,
          changeContractSha256: (ctx && ctx.taskSha256) || null,
          sessionId: (ctx && ctx.threadId) || null,
          status: CODEX_FAIL_STATUS[code] || 'codex_turn_failed'
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
  if (session.mode !== 'new' && session.mode !== 'continue') { failed('BAD_REQUEST', 'session.mode must be new|continue'); return; }
  if (session.mode === 'continue' && (typeof session.thread_id !== 'string' || !session.thread_id)) { failed(CODEX_SESSION_UNAVAILABLE, 'continue 需要 bridge-owned thread_id'); return; }
  if (task && task.mode === 'restructure') { failed('INVALID_MODE', 'restructure is plan-only; codex candidate 不允许'); return; }

  status('checking');

  // 2. source 解析 + workspace + task bundle(host 自算源哈希,不与 extension DOM 序列化哈希比对)
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri);
    const hostHash = sha256File(sourcePath);
    workspace = codexWorkspacePathFor({ sourcePath, logicalDocumentId: source.logical_document_id });
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

  // 3.1 v0.8.1 §6.8:candidate 携带 approved_plan → 写只读 approved-plan.md(辅助约束,不替代 Change Contract)
  if (msg.approved_plan && typeof msg.approved_plan.edited_plan_markdown === 'string') {
    try { writeApprovedPlan({ runsDir: prep.runsDir, editedPlanMarkdown: msg.approved_plan.edited_plan_markdown }); }
    catch (e) { failed('PREPARE_FAILED', 'cannot write approved-plan.md: ' + (e && e.message), prep.runsDir, ctxBase); return; }
  }

  // 4. App runtime 发现与信任(spec §2.2)
  let rt = runtime;
  if (!rt) { try { rt = discoverAppRuntime(); } catch (e) { failed(e.code || CODEX_APP_NOT_FOUND, e.message, prep.runsDir, ctxBase); return; } }

  // 5. schema 兼容(spec §2):generate-json-schema → verifySchema
  let sd = schemaDir;
  if (!sd) {
    sd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-schema-'));
    try { await (generateSchema || spawnGenerateSchema)(rt.runtimePath, sd); }
    catch (e) { failed(e.code || CODEX_INCOMPATIBLE, e.message, prep.runsDir, ctxBase); return; }
  }
  try { verifySchema({ schemaDir: sd }); }
  catch (e) { failed(CODEX_INCOMPATIBLE, e.message, prep.runsDir, ctxBase); return; }

  // 6. runCandidate:handshake → thread/start|resume → turn/start → turn/completed
  status('running');
  const c = client || new CodexAppServerClient(rt.runtimePath);
  let result = null;
  try {
    result = await c.runCandidate({
      sessionMode: session.mode,
      storedThreadId: session.mode === 'continue' ? session.thread_id : null,
      workspaceCwd: prep.runsDir,
      prompt: buildCodexPrompt({ task }) + (msg.approved_plan ? approvedPlanPreamble(msg.approved_plan.edited_plan_markdown) : ''),
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS
    });
  } catch (e) {
    failed(e.code || CODEX_TURN_FAILED, e.message, prep.runsDir, { ...ctxBase, threadId: result && result.threadId });
    try { await c.close(); } catch (_) {} return;
  }
  try { await c.close(); } catch (_) {}
  const threadId = result && result.threadId;

  // 7. 重读 source:运行期被改 → 不采用(spec §3.4.4/§7)
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed('SOURCE_MUTATED_DURING_CANDIDATE', '无法重读 source', prep.runsDir, { ...ctxBase, threadId }); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed('SOURCE_MUTATED_DURING_CANDIDATE', 'source 在 codex run 期间变化,candidate 未采用', prep.runsDir, { ...ctxBase, sourceSha256After, threadId }); return;
  }

  // 8. 校验 candidate 形态
  let cand;
  try { cand = validateCandidate(prep.candidatePath, prep.sourceByteLength); }
  catch (e) { failed(e.code || 'CANDIDATE_MISSING', e.message, prep.runsDir, { ...ctxBase, sourceSha256After, threadId }); return; }

  // 9. 原子 sibling(同名不覆盖)
  let resultPath;
  try { resultPath = publishSiblingCandidate({ candidatePath: prep.candidatePath, sourcePath, runId }); }
  catch (e) { failed(e.code || 'CANDIDATE_PUBLISH_FAILED', e.message, prep.runsDir, { ...ctxBase, sourceSha256After, threadId }); return; }

  // 10. ready manifest(provider=codex_app_server,session=thread_id)
  let manifestPath;
  try {
    manifestPath = writeManifest({
      runsDir: prep.runsDir, runId, logicalDocumentId: source.logical_document_id, provider: 'codex_app_server',
      sourcePath, sourceSha256Before: prep.sourceSha256Before, sourceSha256After,
      candidateResultPath: resultPath, candidateWorkspacePath: prep.candidatePath,
      candidateSha256: cand.sha256, candidateByteLength: cand.byteLength,
      changeContractSha256: bundle.taskSha256, sessionId: threadId, status: 'ready'
    });
  } catch (e) { failed('MANIFEST_FAILED', e.message, prep.runsDir, { ...ctxBase, sourceSha256After, threadId }); return; }

  // 11. candidate-ready(最小 completion;含 thread_id 供续发;不含 agent message/stdout)
  emit({
    type: 'candidate-ready',
    provider: 'codex_app_server',
    run_id: runId,
    thread_id: threadId,
    task_sha256: bundle.taskSha256,
    logical_document_id: source.logical_document_id,
    source_uri: pathToFileURL(sourcePath).href,
    source_sha256_before: prep.sourceSha256Before,
    candidate_uri: pathToFileURL(resultPath).href,
    candidate_sha256: cand.sha256,
    manifest_path: manifestPath
  });
}

// —— v0.8.1 spec §6.6:Codex plan 执行编排(run_kind === "plan",provider=codex_app_server)——
// 与 executeCodexCandidateRun 并列;host.mjs 按 run_kind 分发。流程:
// 校验 → plan workspace(snapshot+task+output)→ App 发现/schema → client.runPlan(永远 thread/start,writableRoots 仅 plan 目录,禁网)
// → 重读 source(变 → SOURCE_MUTATED_DURING_PLAN)→ task bundle hash 前后比对 → 校验 output/plan.json → ready manifest → plan-ready。
// 绝不创建 candidate sibling / candidate.html(§6.7);plan 与 candidate 工作区物理隔离。plan-ready 不含 thread_id(plan 不可续发)。
export async function executeCodexPlanRun(msg, { emit, runtime, client, schemaDir, generateSchema } = {}) {
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
          provider: 'codex_app_server',
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

  // 1. 字段校验
  if (!msg || typeof msg !== 'object') { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing message' }); return; }
  if (typeof runId !== 'string' || !runId) { emit({ type: 'bridge_failed', code: 'BAD_REQUEST', message: 'missing run_id' }); return; }
  const source = msg.source || {};
  const session = msg.session || {};
  const task = msg.task;
  if (typeof source.logical_document_id !== 'string' || !source.logical_document_id) { failed('BAD_REQUEST', 'missing source.logical_document_id'); return; }
  if (typeof source.artifact_uri !== 'string' || !source.artifact_uri) { failed('BAD_REQUEST', 'missing source.artifact_uri'); return; }
  if (!isSha256Tagged(source.base_artifact_hash)) { failed('BAD_REQUEST', 'source.base_artifact_hash must be sha256:<64hex>'); return; }
  if (session.mode !== 'new' && session.mode !== 'continue') { failed('BAD_REQUEST', 'session.mode must be new|continue'); return; }
  if (task && task.mode === 'restructure') { failed('INVALID_MODE', 'restructure not allowed'); return; }

  status('checking');

  // 2. source 解析 + workspace + task bundle
  let sourcePath, workspace, bundle;
  try {
    sourcePath = resolveSourcePath(source.artifact_uri);
    const hostHash = sha256File(sourcePath);
    workspace = codexWorkspacePathFor({ sourcePath, logicalDocumentId: source.logical_document_id });
    fs.mkdirSync(workspace, { recursive: true });
    try { fs.chmodSync(workspace, 0o700); } catch (_) {}
    bundle = writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash: hostHash });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id }); return; }

  // 3. plan 工作区:snapshot(0400)+ task 复制进 plans/<runId>(0700)+ output/(0700)
  let prep;
  try {
    prep = preparePlanRun({ sourcePath, workspaceRoot: workspace, logicalDocumentId: source.logical_document_id, runId, taskJsonPath: bundle.jsonPath, taskMdPath: bundle.mdPath });
  } catch (e) { failed(e.code || 'PREPARE_FAILED', e.message, null, { logicalDocumentId: source.logical_document_id, sourcePath, taskSha256: bundle.taskSha256 }); return; }
  const ctxBase = { logicalDocumentId: source.logical_document_id, sourcePath, sourceSha256Before: prep.sourceSha256Before, taskSha256: bundle.taskSha256 };

  // 4. App runtime 发现与信任
  let rt = runtime;
  if (!rt) { try { rt = discoverAppRuntime(); } catch (e) { failed(e.code || CODEX_APP_NOT_FOUND, e.message, prep.plansDir, ctxBase); return; } }

  // 5. schema 兼容
  let sd = schemaDir;
  if (!sd) {
    sd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-schema-'));
    try { await (generateSchema || spawnGenerateSchema)(rt.runtimePath, sd); }
    catch (e) { failed(e.code || CODEX_INCOMPATIBLE, e.message, prep.plansDir, ctxBase); return; }
  }
  try { verifySchema({ schemaDir: sd }); }
  catch (e) { failed(CODEX_INCOMPATIBLE, e.message, prep.plansDir, ctxBase); return; }

  // 6. runPlan(§6.6:永远 thread/start,writableRoots 仅 plan 目录,禁网)
  status('running');
  const c = client || new CodexAppServerClient(rt.runtimePath);
  let result = null;
  try {
    result = await c.runPlan({
      workspaceCwd: prep.plansDir,
      prompt: buildPlanPrompt({ runId, task }),
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS
    });
  } catch (e) {
    const code = (e && e.code === CODEX_TIMED_OUT) ? 'CODEX_PLAN_TIMEOUT' : (e.code || 'CODEX_PLAN_FAILED');
    failed(code, e.message, prep.plansDir, ctxBase);
    try { await c.close(); } catch (_) {} return;
  }
  try { await c.close(); } catch (_) {}

  // 7. 重读 source:运行期被改 → 计划废弃(§6.2)
  let sourceSha256After;
  try { sourceSha256After = sha256File(sourcePath); }
  catch (e) { failed('SOURCE_MUTATED_DURING_PLAN', '无法重读 source', prep.plansDir, ctxBase); return; }
  if (sourceSha256After !== prep.sourceSha256Before) {
    failed('SOURCE_MUTATED_DURING_PLAN', 'source 在 codex plan run 期间变化,计划未采用', prep.plansDir, { ...ctxBase, sourceSha256After }); return;
  }

  // 8. task bundle hash 前后比对(§6.2)
  try { verifyTaskBundleUnchanged({ plansDir: prep.plansDir, taskJsonName: prep.taskJsonName, taskSha256Before: prep.taskSha256Before }); }
  catch (e) { failed('TASK_MUTATED_DURING_PLAN', e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 9. 校验 output/plan.json(schema v1 + 路径安全)
  let planResult;
  try { planResult = validatePlanJson(prep.planJsonPath); }
  catch (e) { failed(e.code || 'PLAN_MISSING', e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 10. ready manifest(provider=codex_app_server;plan 不可续发,不记 thread)
  let manifestPath;
  try {
    manifestPath = writePlanManifest({
      plansDir: prep.plansDir, runId, logicalDocumentId: source.logical_document_id, provider: 'codex_app_server',
      sourcePath, sourceSha256Before: prep.sourceSha256Before, sourceSha256After,
      taskSha256: bundle.taskSha256, planSha256: planResult.planSha256, planByteLength: planResult.byteLength,
      status: 'ready'
    });
  } catch (e) { failed('MANIFEST_FAILED', e.message, prep.plansDir, { ...ctxBase, sourceSha256After }); return; }

  // 11. plan-ready(最小 completion;不含 thread_id/agent message/stdout;绝不附带 candidate)
  const p = planResult.plan;
  emit({
    type: 'plan-ready',
    provider: 'codex_app_server',
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
