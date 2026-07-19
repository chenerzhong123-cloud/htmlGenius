// background.js — htmlGenius service worker。v0.7.1:Claude Code handoff gateway。
// 所有 Native Host 通信只经过这里;Side Panel 与 content-script 不得 connectNative(§4)。
// 职责:bridge-start 严格校验 → 连 native host → claude_handoff_start → 路由 host 事件 →
// completion 逐字段 double-check(run_id / task_sha256 自算对照 / session UUID)→ 持久化 run+session。
// 本版是「任务交接验收」:不产 candidate、不写回、不 reload、不重锚定批注(§1 明确不做)。
// host 名 provider-neutral(com.htmlgenius.local_bridge):后续 Codex adapter 复用同一 host。
importScripts("storage.js", "bridge-validate.js");

const NATIVE_HOST = "com.htmlgenius.local_bridge";
const PROVIDER = "claude_code_cli";
const BRIDGE_VERSION = "0.7.1";

// tab -> { run_id, port, terminal }
const _runsByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

function nowIso() { return new Date().toISOString(); }
function newRunId() {
  return "hgr_" + (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "").slice(0, 24)
    || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
}
function isUuid(s) { return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }
function broadcast(payload) {
  // 向 sidepanel 推送 run 进度;sidepanel 关闭时无接收者,run 在 background/host 继续(§9)
  try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch (e) { /* 非关键 */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "bridge-start") {
    handleBridgeStart(msg).then(sendResponse, (e) => sendResponse({ ok: false, code: "BG_ERROR", message: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "bridge-query-session") {
    handleQuerySession(msg).then(sendResponse, () => sendResponse({ ok: false, code: "NO_ARTIFACT_STATE" }));
    return true;
  }
});

// sidepanel 探测当前 tab 是否有可「继续」的 bridge-owned Claude session(供会话选择显示)
async function handleQuerySession({ tab_id }) {
  const ex = await chrome.tabs.sendMessage(tab_id, { type: "get-export" }).catch(() => null);
  if (!ex || ex.type !== "export-data") return { ok: false, code: "NO_ARTIFACT_STATE" };
  const logicalId = ex.logicalDocumentId || (ex.artifact_state && ex.artifact_state.logical_document_id);
  if (!logicalId) return { ok: false, code: "NO_LOGICAL_DOC" };
  const sess = await Storage.getBridgeSession(logicalId, PROVIDER);
  const continuable = !!(sess && sess.ownership === "htmlgenius" && sess.provider === PROVIDER
    && isUuid(sess.session_id) && sess.status !== "running");
  return { ok: true, has_session: !!sess, continuable, last_status: sess && sess.status };
}

async function handleBridgeStart({ tab_id, provider, session_mode, change_contract }) {
  if (!tab_id) return { ok: false, code: "NO_TAB" };
  if (provider !== PROVIDER) return { ok: false, code: "UNKNOWN_PROVIDER", message: "v0.7.1 only supports " + PROVIDER };
  if (session_mode !== "new" && session_mode !== "continue") return { ok: false, code: "BAD_SESSION_MODE" };

  // 1. 自行向 content-script 取可信 artifact state(不信 sidepanel 传的 hash/uri/logicalId)
  const ex = await chrome.tabs.sendMessage(tab_id, { type: "get-export" }).catch(() => null);
  if (!ex || ex.type !== "export-data") return { ok: false, code: "NO_ARTIFACT_STATE" };
  const art = ex.artifact || {};
  const logicalId = ex.logicalDocumentId || (ex.artifact_state && ex.artifact_state.logical_document_id);
  const loadedHash = ex.loadedArtifactHash || (ex.artifact_state && ex.artifact_state.loaded_artifact_hash);

  // 2. 严格校验(§6.1)
  if (!art.isLocal) return { ok: false, code: "NOT_LOCAL" };
  if (!logicalId || !loadedHash) return { ok: false, code: "NO_ARTIFACT_VERSION" };
  const task = change_contract;
  if (!task || typeof task !== "object") return { ok: false, code: "NO_CONTRACT" };
  if (task.mode === "restructure") return { ok: false, code: "INVALID_MODE" };
  if (!["precise_patch", "local_optimize", "regenerate"].includes(task.mode)) return { ok: false, code: "INVALID_MODE" };
  // contract 的 artifact URL 必须与当前 tab URI 一致(防跨文档伪造)
  if (task.artifact && task.artifact.url && art.url && task.artifact.url !== art.url) {
    return { ok: false, code: "CONTRACT_ARTIFACT_MISMATCH" };
  }
  // root IDs 必须都存在于当前 non-stale 顶层批注集合
  const validRoots = new Set((ex.items || []).filter((a) => a && a.parent_id == null && a._status !== "stale").map((a) => a.id));
  const rootIds = (task.source && task.source.root_annotation_ids) || [];
  if (!rootIds.length || rootIds.some((id) => !validRoots.has(id))) return { ok: false, code: "INVALID_ROOT_IDS" };

  // 3. tab lock:同一 tab 不允许并发 run
  const active = await Storage.getActiveBridgeRunForTab(tab_id);
  if (active) return { ok: false, code: "RUN_IN_PROGRESS", run_id: active.run_id };

  // 4. continue 必须有 bridge-owned、claude、非 running 的已存 session(只能用保存的 UUID 续发)
  let session_id = null;
  if (session_mode === "continue") {
    const sess = await Storage.getBridgeSession(logicalId, PROVIDER);
    if (!sess || sess.ownership !== "htmlgenius" || sess.provider !== PROVIDER || sess.status === "running" || !isUuid(sess.session_id)) {
      return { ok: false, code: "NO_CONTINUABLE_SESSION" };
    }
    session_id = sess.session_id;
  }

  // 5. task_sha256(与 host 同算法;background 自算,completion 时再对照)
  const taskSha = await BridgeValidate.computeTaskSha256(task);

  // 6. 建 run 记录(status=starting)
  const runId = newRunId();
  const run = {
    run_id: runId, logical_document_id: logicalId, tab_id,
    provider: PROVIDER, session_mode,
    session_id: null, task_sha256: taskSha,
    source_artifact_uri: art.url, base_artifact_hash: loadedHash,
    status: "starting",
    error_code: null,
    created_at: nowIso(), completed_at: null
  };
  await Storage.saveBridgeRun(run);

  // 7. 连 native host + 发 claude_handoff_start
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    await Storage.updateBridgeRun(runId, { status: "failed", error_code: "BRIDGE_NOT_INSTALLED", completed_at: nowIso() });
    return { ok: false, code: "BRIDGE_NOT_INSTALLED", run_id: runId };
  }
  if (chrome.runtime.lastError || !port) {
    await Storage.updateBridgeRun(runId, { status: "failed", error_code: "BRIDGE_NOT_INSTALLED", completed_at: nowIso() });
    return { ok: false, code: "BRIDGE_NOT_INSTALLED", run_id: runId };
  }

  _runsByTab.set(tab_id, { run_id: runId, port, terminal: false });
  port.onMessage.addListener((m) => onHostMessage(tab_id, runId, m, taskSha, logicalId, art.url));
  port.onDisconnect.addListener(() => onHostDisconnect(tab_id, runId));

  port.postMessage({
    type: "claude_handoff_start",
    run_id: runId,
    source: {
      logical_document_id: logicalId,
      artifact_uri: art.url,
      base_artifact_hash: loadedHash
    },
    session: { mode: session_mode, session_id: session_id },
    task: task
  });

  return { ok: true, run_id: runId, mode: task.mode, session_mode };
}

function onHostMessage(tab_id, runId, m, taskSha, logicalId, artifactUrl) {
  if (!m || !m.type) return;
  if (m.run_id && m.run_id !== runId) return; // 串号防御
  if (m.type === "bridge_status") {
    // host 发 checking/running;run 状态机只有 starting/running/completed/failed
    const status = m.status === "running" ? "running" : "starting";
    Storage.updateBridgeRun(runId, { status }).catch(() => {});
    broadcast({ type: "bridge-progress", tab_id, run_id: runId, status, summary: String(m.summary || "").slice(0, 160) });
    return;
  }
  if (m.type === "bridge_session_created") {
    // new 模式 host 建好 session;只记到 run,session store 等 completed 才写(失败不落 session)
    if (isUuid(m.session_id)) {
      Storage.updateBridgeRun(runId, { session_id: m.session_id }).catch(() => {});
    }
    broadcast({ type: "bridge-progress", tab_id, run_id: runId, status: "running" });
    return;
  }
  if (m.type === "bridge_completed") {
    completeRun(tab_id, runId, m, taskSha, logicalId, artifactUrl);
    return;
  }
  if (m.type === "bridge_failed") {
    failRun(tab_id, runId, m.code || "RUN_FAILED", m.message || "");
    return;
  }
}

function onHostDisconnect(tab_id, runId) {
  const entry = _runsByTab.get(tab_id);
  if (!entry || entry.run_id !== runId || entry.terminal) return;
  const err = chrome.runtime.lastError;
  failRun(tab_id, runId, "HOST_DISCONNECTED", err ? String(err.message || err) : "native host disconnected");
}

async function failRun(tab_id, runId, code, message) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;
  await Storage.updateBridgeRun(runId, { status: "failed", error_code: code, completed_at: nowIso() }).catch(() => {});
  // 失败不写 session(§6.2:任何对照失败均不写 session、不显示成功)
  broadcast({ type: "bridge-failed", tab_id, run_id: runId, code, message });
}

async function completeRun(tab_id, runId, completion, taskSha, logicalId, artifactUrl) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;

  // 1. 双重校验:host 回送 vs 本机 run 记录 vs background 自算 task SHA(§6.2)
  const run = await Storage.getBridgeRun(runId).catch(() => null);
  if (!run) return failRun(tab_id, runId, "RUN_NOT_FOUND", "no run record for completion");
  const v = BridgeValidate.validateHandoffCompletion(run, completion, taskSha);
  if (!v.ok) return failRun(tab_id, runId, v.code, "completion rejected: " + v.code + (v.field ? " (" + v.field + ")" : ""));

  // 2. 持久化 run(completed)+ session(bridge-owned;只在成功时写)
  await Storage.updateBridgeRun(runId, { status: "completed", session_id: v.session_id, completed_at: nowIso() }).catch(() => {});
  await Storage.saveBridgeSession({
    logical_document_id: logicalId, provider: PROVIDER, ownership: "htmlgenius",
    session_id: v.session_id,
    workspace_path: BridgeValidate.workspacePathForFileUrl(artifactUrl, logicalId),
    status: "completed"
  }).catch(() => {});

  // 3. v0.7.1 到此为止:不写回、不 reload、不重锚定(§1)。仅通知 sidepanel 显示成功。
  broadcast({ type: "bridge-completed", tab_id, run_id: runId, session_id: v.session_id });
}
