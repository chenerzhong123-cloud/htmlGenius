// bridge/host-runner.mjs — start_run 的编排:prepareRun → app-server(thread/turn)→ finalizeRun → 发完成/失败事件。
// 与 host.mjs 解耦:executeStartRun 接受 { spawnClient, emit },便于用 fake app-server 单测,生产用真实 AppServerClient。
// 不让 host 自己控制 tab 或给 content script 发消息;它只 emit native 帧给 background(§4.1)。
import { prepareRun, finalizeRun, buildSandboxPolicy } from "./run-manager.mjs";
import { buildCodexPrompt } from "./prompt.mjs";

function errCode(code, message) { const e = new Error(message || code); e.code = code; return e; }

export async function executeStartRun(msg, { spawnClient, emit } = {}) {
  const runId = msg && msg.request_id;
  const source = msg && msg.source;
  const execution = (msg && msg.execution) || {};
  const task = msg && msg.change_contract;
  const status = (s, summary) => emit({
    type: "bridge_status", run_id: runId, status: s, summary: String(summary || "").slice(0, 160)
  });

  if (typeof emit !== "function") throw errCode("BAD_DEPS", "emit is required");
  if (!runId || !source || !task) { emit({ type: "bridge_failed", run_id: runId, code: "BAD_REQUEST", message: "missing request_id/source/change_contract" }); return; }
  if (execution.mode === "restructure") { emit({ type: "bridge_failed", run_id: runId, code: "INVALID_MODE", message: "restructure must not start a bridge run" }); return; }

  status("starting", "preparing source artifact");
  let prep;
  try { prep = prepareRun({ source, runId }); }
  catch (e) { emit({ type: "bridge_failed", run_id: runId, code: e.code || "PREPARE_FAILED", message: e.message || "prepare failed" }); return; }

  let promptText;
  try { promptText = buildCodexPrompt({ task, sourcePath: prep.sourcePath, resultPath: prep.resultPath }); }
  catch (e) { emit({ type: "bridge_failed", run_id: runId, code: e.code || "PROMPT_FAILED", message: e.message || "prompt failed" }); return; }

  const sandbox = buildSandboxPolicy({ candidateDir: prep.candidateDir, sourceParent: prep.sourceParent });
  const client = spawnClient();
  try { if (client && typeof client.start === "function") client.start(); } catch (_) {}

  try {
    status("starting", "initializing codex app-server");
    await client.initialize({ clientName: "htmlgenius-bridge", clientVersion: "0.7.0" });

    let threadId = execution.thread_id || null;
    if (execution.session_mode === "continue") {
      if (!threadId) throw errCode("NO_SAVED_THREAD", "continue requested without thread_id");
      await client.threadResume({ threadId });
    } else {
      const r = await client.threadStart({ cwd: sandbox.cwd, sandbox });
      threadId = (r && (r.thread_id || r.id)) || threadId;
      if (threadId) emit({ type: "bridge_thread_created", run_id: runId, thread_id: threadId });
    }

    status("running", "codex turn in progress");
    const turn = await client.runTurn(
      { cwd: sandbox.cwd, sandbox, approvalPolicy: sandbox.approvalPolicy, input: [{ type: "text", text: promptText }] },
      { onStarted: (turnId) => emit({ type: "bridge_turn_started", run_id: runId, turn_id: turnId || null }) }
    );
    const turnId = (turn && (turn.turn_id || turn.id)) || null;

    // finalizeRun 再次校验 source 未变 + result.html 合法 + 候选 hash;失败抛 SOURCE_MUTATED/NO_RESULT/NO_ARTIFACT_CHANGE
    const completion = finalizeRun({
      sourcePath: prep.sourcePath, confirmedBaseHash: prep.confirmedBaseHash,
      candidateDir: prep.candidateDir, resultPath: prep.resultPath,
      runId, logicalDocumentId: source.logical_document_id, threadId, turnId
    });
    emit(completion);
  } catch (e) {
    emit({ type: "bridge_failed", run_id: runId, code: (e && e.code) || "RUN_FAILED", message: (e && e.message) || "run failed" });
  } finally {
    try { await client.stop(); } catch (_) {}
  }
}
