// background.js — htmlGenius service worker。v0.7:Bridge gateway。
// 所有 Native Host 通信只经过这里;Side Panel 与 content-script 不得 connectNative(§6)。
// 职责:bridge-start 严格校验 → 连 native host → 路由 host 事件 → completion 逐字段 double-check →
//       经 v0.6.2 的 artifact-update-ready 消费者接受后才 tabs.update 导航。冲突即停,绝不伪造成功。
importScripts("storage.js", "bridge-validate.js");

const NATIVE_HOST = "com.htmlgenius.codex_bridge";
const BRIDGE_VERSION = "0.7.0";

// tab -> { run_id, logical_document_id, source_artifact_uri, base_artifact_hash, target_artifact_uri, port, terminal }
const _runsByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// v0.6.2 遗留:把完成事件转发给 content-script 的 base-hash 校验消费者(§6.3 步骤1)。
async function forwardArtifactUpdateToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload);
}

function nowIso() { return new Date().toISOString(); }
function newRunId() { return "hgr_" + (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "").slice(0, 24) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10))); }
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

// sidepanel 探测当前 tab 是否有可「继续」的 bridge session(供 session choice 显示)
async function handleQuerySession({ tab_id }) {
  const ex = await chrome.tabs.sendMessage(tab_id, { type: "get-export" }).catch(() => null);
  if (!ex || ex.type !== "export-data") return { ok: false, code: "NO_ARTIFACT_STATE" };
  const logicalId = ex.logicalDocumentId || (ex.artifact_state && ex.artifact_state.logical_document_id);
  if (!logicalId) return { ok: false, code: "NO_LOGICAL_DOC" };
  const sess = await Storage.getBridgeSession(logicalId);
  const continuable = !!(sess && sess.ownership === "htmlgenius" && sess.provider === "codex_app_server" && sess.thread_id && sess.last_status !== "running");
  return { ok: true, has_session: !!sess, continuable, last_status: sess && sess.last_status };
}

async function handleBridgeStart({ tab_id, session_mode, change_contract }) {
  if (!tab_id) return { ok: false, code: "NO_TAB" };
  // 1. 自行向 content-script 取 artifact_state(不信 sidepanel 传的 hash/uri/logicalId)
  const ex = await chrome.tabs.sendMessage(tab_id, { type: "get-export" }).catch(() => null);
  if (!ex || ex.type !== "export-data") return { ok: false, code: "NO_ARTIFACT_STATE" };
  const art = ex.artifact || {};
  const logicalId = ex.logicalDocumentId || (ex.artifact_state && ex.artifact_state.logical_document_id);
  const loadedHash = ex.loadedArtifactHash || (ex.artifact_state && ex.artifact_state.loaded_artifact_hash);
  const mode = change_contract && change_contract.mode;

  // 2. 严格校验(§6.1)
  if (!art.isLocal) return { ok: false, code: "NOT_LOCAL" };
  if (!logicalId || !loadedHash) return { ok: false, code: "NO_ARTIFACT_VERSION" };
  if (mode === "restructure") return { ok: false, code: "INVALID_MODE" };
  if (!["precise_patch", "local_optimize", "regenerate"].includes(mode)) return { ok: false, code: "INVALID_MODE" };

  const active = await Storage.getActiveBridgeRunForTab(tab_id);
  if (active) return { ok: false, code: "RUN_IN_PROGRESS", run_id: active.run_id };

  // continue 必须有 htmlgenius-owned、codex、非 running 的 session + thread_id
  let thread_id = null;
  if (session_mode === "continue") {
    const sess = await Storage.getBridgeSession(logicalId);
    if (!sess || sess.ownership !== "htmlgenius" || sess.provider !== "codex_app_server" || sess.last_status === "running" || !sess.thread_id) {
      return { ok: false, code: "NO_CONTINUABLE_SESSION" };
    }
    thread_id = sess.thread_id;
  }

  // 3. 建 run 记录(status=starting)
  const runId = newRunId();
  const run = {
    run_id: runId, logical_document_id: logicalId, tab_id,
    source_artifact_uri: art.url, base_artifact_hash: loadedHash, target_artifact_uri: null,
    mode, session_mode: session_mode === "continue" ? "continue" : "new",
    thread_id, turn_id: null, status: "starting",
    created_at: nowIso(), completed_at: null, error_code: null
  };
  await Storage.saveBridgeRun(run);

  // 4. 连 native host + 发 start_run
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

  _runsByTab.set(tab_id, { run_id: runId, logical_document_id: logicalId, source_artifact_uri: art.url, base_artifact_hash: loadedHash, target_artifact_uri: null, port, terminal: false });
  port.onMessage.addListener((m) => onHostMessage(tab_id, runId, m));
  port.onDisconnect.addListener(() => onHostDisconnect(tab_id, runId));

  port.postMessage({
    type: "start_run", request_id: runId,
    source: { artifact_uri: art.url, logical_document_id: logicalId, base_artifact_hash: loadedHash },
    execution: { provider: "codex_app_server", session_mode: run.session_mode, thread_id, mode },
    change_contract
  });

  return { ok: true, run_id: runId, mode, session_mode: run.session_mode };
}

function onHostMessage(tab_id, runId, m) {
  if (!m || !m.type) return;
  if (m.type === "bridge_status") {
    const status = m.status === "running" ? "running" : "starting";
    Storage.updateBridgeRun(runId, { status }).catch(() => {});
    broadcast({ type: "bridge-progress", tab_id, run_id: runId, status, summary: m.summary || "" });
    return;
  }
  if (m.type === "bridge_thread_created") {
    // 写 bridge_sessions(ownership=htmlgenius),续发身份可追溯(§7.2)
    Storage.getBridgeRun(runId).then((run) => {
      if (!run) return;
      Storage.updateBridgeRun(runId, { thread_id: m.thread_id }).catch(() => {});
      Storage.saveBridgeSession({
        logical_document_id: run.logical_document_id, provider: "codex_app_server", ownership: "htmlgenius",
        thread_id: m.thread_id, cwd: null, last_turn_id: null, last_status: "running"
      }).catch(() => {});
    });
    broadcast({ type: "bridge-progress", tab_id, run_id: runId, status: "running", thread_id: m.thread_id });
    return;
  }
  if (m.type === "bridge_turn_started") {
    Storage.updateBridgeRun(runId, { turn_id: m.turn_id, status: "running" }).catch(() => {});
    broadcast({ type: "bridge-progress", tab_id, run_id: runId, status: "running", turn_id: m.turn_id });
    return;
  }
  if (m.type === "bridge_completed") {
    completeRun(tab_id, runId, m);
    return;
  }
  if (m.type === "bridge_failed") {
    failRun(tab_id, runId, m.code || "RUN_FAILED", m.message || "", m);
    return;
  }
}

function onHostDisconnect(tab_id, runId) {
  const entry = _runsByTab.get(tab_id);
  if (!entry || entry.run_id !== runId || entry.terminal) return;
  const err = chrome.runtime.lastError;
  failRun(tab_id, runId, "HOST_DISCONNECTED", err ? String(err.message || err) : "native host disconnected");
}

async function failRun(tab_id, runId, code, message, hostMsg) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;
  await Storage.updateBridgeRun(runId, { status: "failed", error_code: code, completed_at: nowIso() }).catch(() => {});
  // 更新 session last_status=failed(若有)
  const run = await Storage.getBridgeRun(runId).catch(() => null);
  if (run) await Storage.saveBridgeSession({
    logical_document_id: run.logical_document_id, provider: "codex_app_server", ownership: "htmlgenius",
    thread_id: run.thread_id || null, last_status: "failed"
  }).catch(() => {});
  broadcast({ type: "bridge-failed", tab_id, run_id: runId, code, message, host: hostMsg || null });
}

async function completeRun(tab_id, runId, completion) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;

  // 1. 逐字段 double-check:与本地 run 记录比对 run_id / logical_id / base hash / source / result_kind
  //    + result URI 必须落在 source 父目录的 .htmlgenius-candidates/ 下(§6.3, §12.6)。
  const run = await Storage.getBridgeRun(runId).catch(() => null);
  if (!run) return failRun(tab_id, runId, "RUN_NOT_FOUND", "no run record for completion");
  const v = BridgeValidate.validateCompletion(run, completion);
  if (!v.ok) return failRun(tab_id, runId, v.code, "completion rejected: " + v.code + (v.field ? " (" + v.field + ")" : ""));
  const resultUri = v.result_artifact_uri;
  await Storage.updateBridgeRun(runId, { status: "completed", target_artifact_uri: resultUri, turn_id: completion.turn_id || run.turn_id, completed_at: nowIso() }).catch(() => {});

  // 2. 经 v0.6.2 消费者:artifact-update-ready → content-script base-hash 校验 + linkArtifactUri
  const consumerResp = await forwardArtifactUpdateToTab(tab_id, {
    type: "artifact-update-ready",
    source: "bridge",
    result_kind: "new_artifact",
    base_artifact_hash: completion.base_artifact_hash,
    result_artifact_hash: completion.result_artifact_hash,
    logical_document_id: completion.logical_document_id,
    result_artifact_uri: resultUri
  }).catch(() => null);

  if (!consumerResp || !consumerResp.ok) {
    return failRun(tab_id, runId, "CONSUMER_REJECTED", "artifact-update-ready consumer rejected: " + (consumerResp && consumerResp.code));
  }

  // 3. 消费者接受(new_artifact → navigate_required)→ 导航
  if (consumerResp.action === "navigate_required") {
    broadcast({ type: "bridge-completed", tab_id, run_id: runId, result_artifact_uri: resultUri });
    chrome.tabs.update(tab_id, { url: resultUri }).catch(() => {});
  } else if (consumerResp.action === "reload") {
    broadcast({ type: "bridge-completed", tab_id, run_id: runId, action: "reload" });
  }
}
