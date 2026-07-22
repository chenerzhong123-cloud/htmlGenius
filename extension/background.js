// background.js — htmlGenius service worker。v0.7.1:Claude Code handoff gateway。
// 所有 Native Host 通信只经过这里;Side Panel 与 content-script 不得 connectNative(§4)。
// 职责:bridge-start 严格校验 → 连 native host → claude_handoff_start → 路由 host 事件 →
// completion 逐字段 double-check(run_id / task_sha256 自算对照 / session UUID)→ 持久化 run+session。
// 本版是「任务交接验收」:不产 candidate、不写回、不 reload、不重锚定批注(§1 明确不做)。
// host 名 provider-neutral(com.htmlgenius.local_bridge):后续 Codex adapter 复用同一 host。
importScripts("storage.js", "bridge-validate.js", "plan-validate.js");

const NATIVE_HOST = "com.htmlgenius.local_bridge";
const PROVIDER = "claude_code_cli";
const CODEX_PROVIDER = "codex_app_server";
const SUPPORTED_PROVIDERS = new Set([PROVIDER, CODEX_PROVIDER]);
const BRIDGE_VERSION = "0.8.1";
// v0.8.1 §5.2/§6.7:candidate + plan 是新主流程;handoff 旧路径保留兼容(V0.8.1 UI 不再创建)。
const ALLOWED_RUN_KINDS = new Set(["candidate", "plan", "handoff"]);
// v0.8.1 §5.1:provider probe 30s 缓存(成功与失败都缓存)。纯函数模块在 plan-validate.js,此处只持引用。
const _providerProbe = PlanValidate.makeProviderProbeCache();

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
  if (msg.type === "bridge-query-providers") {
    // v0.8.1 §5.1:provider probe。只读检查;30s 缓存(成功与失败都缓存);不暴露 runtime 路径/TeamID/stderr/认证。
    handleQueryProviders().then(sendResponse, (e) => sendResponse({ ok: false, code: "BG_ERROR", providers: [], message: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "bridge-query-session") {
    handleQuerySession(msg).then(sendResponse, () => sendResponse({ ok: false, code: "NO_ARTIFACT_STATE" }));
    return true;
  }
  if (msg.type === "bridge-query-active-run") {
    // sidepanel 卡死恢复:查后台是否真有在跑的 run(若 SW 曾被杀、失败事件丢失,sidepanel 的 _contractRunning 会卡在 true)
    (async () => {
      const active = await Storage.getActiveBridgeRunForTab(msg.tab_id);
      sendResponse({ active: !!active, run_id: active && active.run_id });
    })();
    return true;
  }
  if (msg.type === "bridge-query-latest-candidate") {
    // Night Pack A §6:返回最近一次 completed candidate 的 run metadata(只读,无敏感内容)
    (async () => {
      const ex = await chrome.tabs.sendMessage(msg.tab_id, { type: "get-export" }).catch(() => null);
      const logicalId = ex && (ex.logicalDocumentId || (ex.artifact_state && ex.artifact_state.logical_document_id));
      if (!logicalId) return sendResponse({ ok: true, run: null });
      const run = await Storage.getLatestCompletedCandidateRun(logicalId);
      sendResponse({ ok: true, run: run ? {
        run_id: run.run_id, provider: run.provider, completed_at: run.completed_at,
        source_uri: run.source_artifact_uri, candidate_uri: run.candidate_uri,
        candidate_sha256: run.candidate_sha256, base_artifact_hash: run.base_artifact_hash,
        version_label: run.version_label || null, manifest_path: run.manifest_path
      } : null });
    })();
    return true;
  }
  if (msg.type === "bridge-cancel") {
    // v0.8.1 用户终止任务:断 native host port(进程随之退出)→ 标 USER_CANCELLED 终态 → 广播 bridge-failed
    (async () => { sendResponse({ ok: await cancelRun(msg.tab_id, msg.run_id) }); })();
    return true;
  }
});

// sidepanel 探测当前 tab 是否有可「继续」的 bridge-owned Claude session(供会话选择显示)
async function handleQuerySession({ tab_id, provider }) {
  const prov = SUPPORTED_PROVIDERS.has(provider) ? provider : PROVIDER;
  const ex = await chrome.tabs.sendMessage(tab_id, { type: "get-export" }).catch(() => null);
  if (!ex || ex.type !== "export-data") return { ok: false, code: "NO_ARTIFACT_STATE" };
  const logicalId = ex.logicalDocumentId || (ex.artifact_state && ex.artifact_state.logical_document_id);
  if (!logicalId) return { ok: false, code: "NO_LOGICAL_DOC" };
  const sess = await Storage.getBridgeSession(logicalId, prov);
  const continuable = !!(sess && sess.ownership === "htmlgenius" && sess.provider === prov
    && sess.status !== "running" && (prov === CODEX_PROVIDER ? !!sess.thread_id : isUuid(sess.session_id)));
  return { ok: true, has_session: !!sess, continuable, last_status: sess && sess.status };
}

async function handleBridgeStart({ tab_id, provider, session_mode, run_kind, change_contract, plan }) {
  if (!tab_id) return { ok: false, code: "NO_TAB" };
  if (!SUPPORTED_PROVIDERS.has(provider)) return { ok: false, code: "UNKNOWN_PROVIDER", message: "unsupported provider: " + provider };
  const runKind = run_kind || "handoff"; // Night Pack A: "candidate" 产受控 candidate;"plan" v0.8.1 产受控修改计划;缺省 "handoff"(v0.7.1 ack)
  if (!ALLOWED_RUN_KINDS.has(runKind)) return { ok: false, code: "BAD_RUN_KIND" };
  // v0.8.1 §5.2:candidate/plan 必须 session_mode==='new' —— continue → SESSION_MODE_NOT_ALLOWED。
  //   旧 bridge_sessions/resume 代码不删(handoff 仍允许 continue,兼容旧路径),但 V0.8.1 UI 不再调用。
  if ((runKind === "candidate" || runKind === "plan") && session_mode !== "new") {
    return { ok: false, code: "SESSION_MODE_NOT_ALLOWED" };
  }
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

  // 3. task_sha256(与 host 同算法;background 自算,completion/plan-ready 时再对照)—— 提前算,plan 确认要用
  const taskSha = await BridgeValidate.computeTaskSha256(task);

  // 3.1 v0.8.1 §5.4:candidate 携带 plan 时,launch 前确认校验(plan_id 存在/draft/provider/doc/tab/artifact/contract/edited/plan_sha256)。
  //     通过后由 launch 成功步骤把 plan 标 approved + 记 candidate_run_id(plan 只能背一次 candidate launch)。
  if (runKind === "candidate" && plan) {
    const planRec = await Storage.getBridgePlan(plan.plan_id).catch(() => null);
    const pv = PlanValidate.validatePlanConfirmation(planRec, {
      provider, logical_document_id: logicalId, tab_id,
      source_artifact_uri: art.url, loaded_artifact_hash: loadedHash,
      task_sha256: taskSha, edited_plan_markdown: plan.edited_plan_markdown, plan_sha256: plan.plan_sha256
    });
    if (!pv.ok) return { ok: false, code: pv.code, message: "plan confirmation rejected: " + pv.code + (pv.field ? " (" + pv.field + ")" : "") };
  }

  // 4. tab lock:同一 tab 不允许并发 run
  const active = await Storage.getActiveBridgeRunForTab(tab_id);
  if (active) return { ok: false, code: "RUN_IN_PROGRESS", run_id: active.run_id };

  // 5. continue:按 provider 查 bridge-owned、非 running 的已存 session(仅 handoff 旧路径可达;candidate/plan 已被 session_mode 门禁拦下)
  //    claude 用保存的 session_id UUID;codex 用保存的 thread_id(spec §5/§6.2)
  let continueRef = null;
  if (session_mode === "continue") {
    const sess = await Storage.getBridgeSession(logicalId, provider);
    if (!sess || sess.ownership !== "htmlgenius" || sess.provider !== provider || sess.status === "running") {
      return { ok: false, code: "NO_CONTINUABLE_SESSION" };
    }
    if (provider === PROVIDER) {
      if (!isUuid(sess.session_id)) return { ok: false, code: "NO_CONTINUABLE_SESSION" };
      continueRef = sess.session_id;
    } else {
      if (!sess.thread_id) return { ok: false, code: "NO_CONTINUABLE_SESSION" };
      continueRef = sess.thread_id;
    }
  }

  // 6. 建 run 记录(status=starting)。mode/root_annotation_ids 供 plan-ready 建 bridge_plans(M3 stale 检测也用)
  const runId = newRunId();
  const run = {
    run_id: runId, logical_document_id: logicalId, tab_id,
    provider, session_mode, run_kind: runKind,
    session_id: null, task_sha256: taskSha,
    source_artifact_uri: art.url, base_artifact_hash: loadedHash,
    mode: task.mode || null,
    root_annotation_ids: rootIds.slice(),
    selected_annotation_ids: [],
    status: "starting",
    error_code: null, plan_id: null,
    created_at: nowIso(), completed_at: null
  };
  await Storage.saveBridgeRun(run);

  // 7. 连 native host + 发 handoff_start(candidate/plan 同型消息,host 按 run_kind 路由 —— §6.7)
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

  const startMsg = {
    type: provider === CODEX_PROVIDER ? "codex_handoff_start" : "claude_handoff_start",
    provider,
    run_id: runId,
    run_kind: runKind,
    source: {
      logical_document_id: logicalId,
      artifact_uri: art.url,
      base_artifact_hash: loadedHash
    },
    session: provider === CODEX_PROVIDER
      ? { mode: session_mode, thread_id: continueRef }
      : { mode: session_mode, session_id: continueRef },
    task: task
  };
  // v0.8.1 §6.8:candidate 携带已确认 plan → 装入 approved_plan(plan_id/原 plan_sha256/用户审核后的 edited_plan_markdown)
  if (runKind === "candidate" && plan) {
    startMsg.approved_plan = { plan_id: plan.plan_id, plan_sha256: plan.plan_sha256, edited_plan_markdown: plan.edited_plan_markdown };
  }
  port.postMessage(startMsg);

  // 8. v0.8.1 §5.4:plan 已通过确认 → 标 approved + 记 candidate_run_id(launch 成功后;plan 只能背一次 candidate)
  if (runKind === "candidate" && plan && plan.plan_id) {
    Storage.updateBridgePlan(plan.plan_id, { status: "approved", candidate_run_id: runId, updated_at: nowIso() }).catch(() => {});
  }

  return { ok: true, run_id: runId, provider, mode: task.mode, session_mode, run_kind: runKind };
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
  if (m.type === "candidate-ready") {
    completeCandidate(tab_id, runId, m, taskSha, logicalId, artifactUrl);
    return;
  }
  if (m.type === "plan-ready") {
    // v0.8.1 §5.3:host 受控 plan run 产物。逐字段校验(绝不跨侧比 hash)→ 建 bridge_plans(draft)→ 广播(不含路径/session)。
    completePlan(tab_id, runId, m, taskSha, logicalId, artifactUrl);
    return;
  }
  if (m.type === "bridge_stream") {
    // v0.8.1:Codex turn 中途进度(token 流/工具/文件)。只转发安全摘要,不含命令体/路径/stderr/思维链正文。
    broadcast({ type: "bridge-stream", tab_id, run_id: runId, kind: m.kind || "info", text: String(m.text || "").slice(0, 800), starting: !!m.starting });
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
  console.log("[hg] run FAILED run=", runId, "tab=", tab_id, "code=", code, "msg=", String(message || "").slice(0, 160));
  // 先广播再写库:SW 可能在 await IndexedDB 期间被 Chrome 杀掉 → broadcast 永远不执行 → sidepanel 卡死
  broadcast({ type: "bridge-failed", tab_id, run_id: runId, code, message });
  await Storage.updateBridgeRun(runId, { status: "failed", error_code: code, completed_at: nowIso() }).catch(() => {});
}

// v0.8.1 用户主动终止:断 host port(子进程退出)→ 终态广播 USER_CANCELLED;不触 onHostDisconnect 二次广播
async function cancelRun(tab_id, runId) {
  const entry = _runsByTab.get(tab_id);
  if (!entry || (runId && entry.run_id !== runId)) return false;
  entry.terminal = true;
  try { if (entry.port) entry.port.disconnect(); } catch (e) {}
  const rid = entry.run_id;
  _runsByTab.delete(tab_id);
  console.log("[hg] run CANCELLED run=", rid, "tab=", tab_id);
  await Storage.updateBridgeRun(rid, { status: "failed", error_code: "USER_CANCELLED", completed_at: nowIso() }).catch(() => {});
  broadcast({ type: "bridge-failed", tab_id, run_id: rid, code: "USER_CANCELLED", message: "user cancelled" });
  return true;
}

// v0.8.1 Chrome 系统通知:候选生成成功后提醒用户回来看新 candidate.html;点击通知打开候选页签。
const _notifyCandidateUri = new Map(); // notificationId → candidate_uri
// v0.8.1 复用已打开的同 URL 候选页签(避免「自动开 + 点通知开」开出两个一样的 tab):
// 记住打开过的 candidate 页签 id,若仍存活则 focus,否则新建。
const _candidateTabByUrl = new Map(); // candidate_uri → tabId
async function focusOrCreateCandidateTab(url) {
  if (!url) return;
  const existing = _candidateTabByUrl.get(url);
  if (existing != null) {
    const t = await chrome.tabs.get(existing).catch(() => null);
    if (t) {
      await chrome.tabs.update(t.id, { active: true }).catch(() => {});
      if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      return;
    }
    _candidateTabByUrl.delete(url);
  }
  const tab = await chrome.tabs.create({ url }).catch(() => null);
  if (tab && tab.id != null) _candidateTabByUrl.set(url, tab.id);
}
function notifyCandidateReady(versionLabel, candidateUri) {
  if (!chrome.notifications) return;
  const id = "hg-candidate-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  if (candidateUri) _notifyCandidateUri.set(id, candidateUri);
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "htmlGenius",
    message: (versionLabel ? ("新候选版本 V" + versionLabel + " 已生成") : "新候选版本已生成") + "，点击查看",
    priority: 2
  }, () => {});
}
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((nid) => {
    const uri = _notifyCandidateUri.get(nid);
    if (uri) { focusOrCreateCandidateTab(uri); _notifyCandidateUri.delete(nid); }
    try { chrome.notifications.clear(nid); } catch (e) {}
  });
}

// v0.8.1 提示音:候选生成成功时播放一声"叮"。MV3 service worker 无 Web Audio → 用 offscreen 文档承载。
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    const has = await chrome.offscreen.hasDocument();
    if (has) return true;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "候选生成成功时播放提示音(MV3 service worker 无 Web Audio API)"
    });
    return true;
  } catch (e) { return false; }
}
async function playDing() {
  if (!(await ensureOffscreen())) return;
  chrome.runtime.sendMessage({ type: "play-ding", target: "offscreen" }).catch(() => {});
}

async function completeRun(tab_id, runId, completion, taskSha, logicalId, artifactUrl) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;

  // 1. 双重校验:host 回送 vs 本机 run 记录 vs background 自算 task SHA(§6.2)
  const run = await Storage.getBridgeRun(runId).catch(() => null);
  if (!run) return failRun(tab_id, runId, "RUN_NOT_FOUND", "no run record for completion");
  const v = BridgeValidate.validateHandoffCompletion(run, completion, taskSha);
  if (!v.ok) return failRun(tab_id, runId, v.code, "completion rejected: " + v.code + (v.field ? " (" + v.field + ")" : ""));

  // 2. 先广播(用户可见关键操作);再持久化(SW 可能在 await 期间被杀)
  broadcast({ type: "bridge-completed", tab_id, run_id: runId, session_id: v.session_id });
  await Storage.updateBridgeRun(runId, { status: "completed", session_id: v.session_id, completed_at: nowIso() }).catch(() => {});
  await Storage.saveBridgeSession({
    logical_document_id: logicalId, provider: PROVIDER, ownership: "htmlgenius",
    session_id: v.session_id,
    workspace_path: BridgeValidate.workspacePathForFileUrl(artifactUrl, logicalId),
    status: "completed"
  }).catch(() => {});
}

// —— Night Pack A spec §5.1:candidate-ready → 逐字段比对 → 受控 new_artifact(复用 v0.6.2 消费者)→ 打开 candidate + 重锚 ——
async function completeCandidate(tab_id, runId, completion, taskSha, logicalId, artifactUrl) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;

  const run = await Storage.getBridgeRun(runId).catch(() => null);
  if (!run) return failRun(tab_id, runId, "RUN_NOT_FOUND", "no run record for candidate-ready");
  console.log("[hg] candidate-ready run=", runId, "provider=", run.provider, "tab=", tab_id);
  // 逐字段对照(background 自存 run metadata;任一不一致即拒绝,不导航/不链接/不迁移)
  if (completion.task_sha256 !== run.task_sha256 || completion.task_sha256 !== taskSha) {
    return failRun(tab_id, runId, "COMPLETION_MISMATCH", "task_sha256 mismatch");
  }
  // 注意:不比对 source_sha256_before 与 run.base_artifact_hash。
  // host 用 sha256File(原始字节)算;extension 用 DOM 序列化(Chrome 规范化后)算 → 永远不匹配。
  // host 内部已自校验(snapshot 前后 + 运行前后),background 无需跨侧再比。
  if (completion.logical_document_id !== run.logical_document_id || completion.logical_document_id !== logicalId) {
    return failRun(tab_id, runId, "COMPLETION_MISMATCH", "logical_document_id mismatch");
  }
  // source_uri:用 basename 比较。host 用 realpathSync 解析(可能解析 symlink,如 /var→/private/var、iCloud、
  // 目录别名),扩展侧用原始 URL → 全路径 canon 比较会因 realpath 差异误判失败。logical_document_id +
  // task_sha256 已校验防跨文档伪造,这里只需 basename 一致(同一源文件)。
  const urlBasename = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\/+/, "").split("/").pop(); } catch (e) { return ""; } };
  if (urlBasename(completion.source_uri) !== urlBasename(artifactUrl)) {
    return failRun(tab_id, runId, "COMPLETION_MISMATCH", "source_uri mismatch");
  }
  if (typeof completion.candidate_uri !== "string" || !/^file:/i.test(completion.candidate_uri)) {
    return failRun(tab_id, runId, "COMPLETION_MISMATCH", "candidate_uri not a file URL");
  }

  // 受控 new_artifact:content-script 确认 base hash + logical relation + 受控 URI 后才链接
  const consumerResp = await chrome.tabs.sendMessage(tab_id, {
    type: "artifact-update-ready",
    source: "bridge",
    result_kind: "new_artifact",
    result_artifact_uri: completion.candidate_uri, // 必须是 result_artifact_uri(content-script handleArtifactUpdateReady 校验此字段名,见 content-script.js:1255);写 result_uri 会被判 VALIDATION_ERROR → CONSUMER_REJECTED → UI 卡在「生成中」
    result_artifact_hash: completion.candidate_sha256,
    base_artifact_hash: completion.source_sha256_before,
    run_id: runId,
    task_sha256: completion.task_sha256,
    logical_document_id: completion.logical_document_id
  }).catch(() => null);
  console.log("[hg] consumer resp=", consumerResp && consumerResp.ok ? "ok" : "REJECT", consumerResp && consumerResp.code, consumerResp && consumerResp.action);
  if (!consumerResp || !consumerResp.ok) {
    return failRun(tab_id, runId, "CONSUMER_REJECTED", "artifact-update-ready consumer rejected: " + (consumerResp && consumerResp.code));
  }

  // 先广播(用户可见:侧边栏立即显示成功);version_label 来自 host(文档级版本号 V1.N,已写进文件名)。
  const provider = run.provider || completion.provider || PROVIDER;
  const isCodex = provider === CODEX_PROVIDER;
  const sessionId = isCodex ? (completion.thread_id || null) : (run.session_id || null);
  const versionLabel = completion.version_label || null;
  broadcast({
    type: "bridge-completed", tab_id, run_id: runId, candidate: true, version_label: versionLabel,
    candidate_uri: completion.candidate_uri, source_uri: completion.source_uri,
    candidate_sha256: completion.candidate_sha256, source_sha256_before: completion.source_sha256_before
  });
  // 先持久化 status=completed(+version_label),再开页签:确保用户切回源 tab 时 reconcile 能读到终态,
  // 发送按钮可靠恢复(否则 tabs.create 触发的切 tab 竞态会让源 tab 卡在 running)。
  const runPatch = { status: "completed", completed_at: nowIso(),
    candidate_uri: completion.candidate_uri, candidate_sha256: completion.candidate_sha256,
    version_label: versionLabel, manifest_path: completion.manifest_path };
  if (isCodex && sessionId) runPatch.thread_id = sessionId;
  await Storage.updateBridgeRun(runId, runPatch).catch(() => {});
  if (sessionId) {
    const sessionRec = {
      logical_document_id: logicalId, provider, ownership: "htmlgenius",
      workspace_path: BridgeValidate.workspacePathForFileUrl(artifactUrl, logicalId),
      status: "completed"
    };
    if (isCodex) sessionRec.thread_id = sessionId; else sessionRec.session_id = sessionId;
    await Storage.saveBridgeSession(sessionRec).catch(() => {});
  }
  // 自动打开候选页签(原 source 页签保持不动);同 URL 复用已开页签,避免重复开多个;失败由 sidepanel「打开候选版本」按钮兜底
  focusOrCreateCandidateTab(completion.candidate_uri);
  // v0.8.1 系统通知 + 提示音:提醒用户回来看新候选
  try { notifyCandidateReady(versionLabel, completion.candidate_uri); } catch (e) { /* 非关键 */ }
  try { playDing(); } catch (e) { /* 非关键 */ }
}

// —— v0.8.1 §5.3:plan-ready → 逐字段校验(host 回送 vs run 记录;绝不跨侧比 hash)→ 建 bridge_plans(draft)→ 广播 bridge-plan-ready ——
async function completePlan(tab_id, runId, planReady, taskSha, logicalId, artifactUrl) {
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;

  const run = await Storage.getBridgeRun(runId).catch(() => null);
  if (!run) return failRun(tab_id, runId, "RUN_NOT_FOUND", "no run record for plan-ready");

  // 重新取当前 tab 的 loaded hash(spec §5.3「校验扩展侧 hash 是否仍对应当前 tab」)。tab 关闭则跳过此项,以 run 记录为准。
  let currentLoadedHash = null;
  const ex = await chrome.tabs.sendMessage(tab_id, { type: "get-export" }).catch(() => null);
  if (ex) currentLoadedHash = ex.loadedArtifactHash || (ex.artifact_state && ex.artifact_state.loaded_artifact_hash) || null;

  const v = PlanValidate.validatePlanReady(run, planReady, taskSha, currentLoadedHash);
  if (!v.ok) {
    return failRun(tab_id, runId, v.code, "plan-ready rejected: " + v.code + (v.field ? " (" + v.field + ")" : ""));
  }

  // 建 bridge_plans 记录(status=draft)。不存 Agent stdout/完整 prompt/HTML 源码/思维链;长度上限在 validator 已把关。
  const planId = newPlanId();
  const p = planReady.plan;
  const planRec = {
    plan_id: planId,
    plan_run_id: runId,
    candidate_run_id: null,
    provider: run.provider,
    logical_document_id: logicalId,
    tab_id,
    source_artifact_uri: artifactUrl,
    base_artifact_hash: run.base_artifact_hash,                // extension DOM hash(同侧可比)
    host_source_sha256_before: planReady.source_sha256_before || null, // host 原始字节 hash(证据,绝不跨侧比)
    task_sha256: taskSha,
    plan_sha256: planReady.plan_sha256,
    mode: run.mode || null,
    root_annotation_ids: (run.root_annotation_ids || []).slice(),
    selected_annotation_ids: (run.selected_annotation_ids || []).slice(),
    plan_markdown: p.plan_markdown,
    summary: p.summary,
    out_of_scope: Array.isArray(p.out_of_scope) ? p.out_of_scope.slice() : [],
    status: "draft",
    created_at: nowIso(), updated_at: nowIso()
  };
  await Storage.saveBridgePlan(planRec).catch(() => {});
  // run 记 completed(plan run 的终态)+ 关联 plan_id + manifest_path(本地审计;不广播给 UI)
  await Storage.updateBridgeRun(runId, { status: "completed", plan_id: planId, manifest_path: planReady.manifest_path || null, completed_at: nowIso() }).catch(() => {});

  // 广播:绝不含 manifest_path / session / thread / 路径(spec §5.3)。plan 是受控 plan.json 的可展示副本。
  broadcast({
    type: "bridge-plan-ready", tab_id, run_id: runId, plan_id: planId,
    plan: { schema_version: p.schema_version, summary: p.summary, plan_markdown: p.plan_markdown, out_of_scope: planRec.out_of_scope }
  });
}

// v0.8.1 §5.1:provider probe。Native host 只读检查(不创 session/thread/candidate);30s 缓存(成功与失败都缓存)。
async function handleQueryProviders() {
  const cached = _providerProbe.get();
  if (cached) return cached;

  let raw;
  try { raw = await probeProvidersViaHost(); }
  catch (e) {
    // probe 整体失败:两个 provider 归一为 error(sanitize 会补齐缺失项);仍缓存 30s 避免频繁重探。
    raw = { providers: [{ id: PROVIDER, status: "error" }, { id: CODEX_PROVIDER, status: "error" }] };
  }
  const result = { ok: true, providers: PlanValidate.sanitizeProbeResult(raw).providers, checked_at: nowIso() };
  _providerProbe.set(result);
  return result;
}

// 连 native host 发 provider_probe;host 回 provider_probe_result。单次往返,~10s 超时。
// M2 host 实现前,host 不识别 provider_probe → 返回 bridge_failed/unknown_message → 归一为 error(两个 provider 各自暂不可用),不抛错。
function probeProvidersViaHost() {
  return new Promise((resolve) => {
    let port, settled = false, timer = null;
    const ERR_BOTH = { providers: [{ id: PROVIDER, status: "error" }, { id: CODEX_PROVIDER, status: "error" }] };
    const finish = (val) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); try { port && port.disconnect(); } catch (e) {} resolve(val); };
    try { port = chrome.runtime.connectNative(NATIVE_HOST); }
    catch (e) { return finish(ERR_BOTH); }
    if (chrome.runtime.lastError || !port) return finish(ERR_BOTH);
    timer = setTimeout(() => finish(ERR_BOTH), 10000);
    port.onMessage.addListener((m) => {
      if (!m) return;
      if (m.type === "provider_probe_result") return finish(m);
      // host 未实现 probe(M2 前)→ bridge_failed/unknown_message:归一为 error,不卡 10s
      if (m.type === "bridge_failed") return finish(ERR_BOTH);
    });
    port.onDisconnect.addListener(() => finish(ERR_BOTH));
    try { port.postMessage({ type: "provider_probe", providers: [PROVIDER, CODEX_PROVIDER] }); }
    catch (e) { finish(ERR_BOTH); }
  });
}

function newPlanId() {
  return "hgp_" + (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "").slice(0, 24)
    || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
}
