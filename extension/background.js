// background.js — htmlGenius service worker。v0.7.1:Claude Code handoff gateway。
// 所有 Native Host 通信只经过这里;Side Panel 与 content-script 不得 connectNative(§4)。
// 职责:bridge-start 严格校验 → 连 native host → claude_handoff_start → 路由 host 事件 →
// completion 逐字段 double-check(run_id / task_sha256 自算对照 / session UUID)→ 持久化 run+session。
// 本版是「任务交接验收」:不产 candidate、不写回、不 reload、不重锚定批注(§1 明确不做)。
// host 名 provider-neutral(com.htmlgenius.local_bridge):后续 Codex adapter 复用同一 host。
importScripts("storage.js", "bridge-validate.js", "plan-validate.js", "provider-metadata.js", "analytics-core.js");

const NATIVE_HOST = "com.htmlgenius.local_bridge";
const PROVIDER = "claude_code_cli";
const CODEX_PROVIDER = "codex_app_server";
const COPILOT_PROVIDER = "github_copilot"; // v0.8.2:GitHub Copilot(Copilot SDK;Host-only runtime:local_cli / bundled_sdk_cli)
// v0.9.1 §3.1:provider allow-list 与 dispatch 映射由同源只读元数据派生(extension/provider-metadata.js),
// 与 bridge/provider-registry.mjs 的一致性由 provider-registry.test 强制,杜绝四处硬编码漂移。
const SUPPORTED_PROVIDERS = new Set(ProviderMetadata.listProviderIds());
const HANDOFF_START_TYPES = (() => {
  const m = {};
  for (const id of ProviderMetadata.listProviderIds()) m[id] = ProviderMetadata.getProviderDescriptor(id).dispatch_type;
  return m;
})();
// v0.9 §4.3:版本单一来源 —— 扩展版本一律取 manifest(getManifest().version),杜绝四处漂移。
// BRIDGE_PROTOCOL_VERSION:与 bridge-health/host 共用;TARGET_BRIDGE_VERSION:bootstrap 指向的受控 CLI 版本(不得 latest)。
const BRIDGE_PROTOCOL_VERSION = 1;
const TARGET_BRIDGE_VERSION = "1.0.11";
// bridge 自 1.0.0 起独立于扩展 manifest 编号(扩展仍按 0.x.x);此处只钉 bootstrap 指向的 bridge 版本。
// bootstrap 发行态:"development" = 仓库内开发命令(显著标注仅开发环境);"production" = 已发布的固定版本 npx 命令。
// @htmlgenius/bridge 已发布到 npm → production:任何设备 `npx --yes @htmlgenius/bridge@1.0.11 setup` 即可安装。
const BOOTSTRAP_DISTRIBUTION = "production";
function extensionVersion() { try { return chrome.runtime.getManifest().version; } catch (_) { return "0.0.0"; } }
// v0.8.1 §5.2/§6.7:candidate + plan 是新主流程;handoff 旧路径保留兼容(V0.8.1 UI 不再创建)。
const ALLOWED_RUN_KINDS = new Set(["candidate", "plan", "handoff"]);
// v0.8.1 §5.1:provider probe 30s 缓存(成功与失败都缓存)。纯函数模块在 plan-validate.js,此处只持引用。
const _providerProbe = PlanValidate.makeProviderProbeCache();

// tab -> { run_id, port, terminal }
const _runsByTab = new Map();

// content script 注入方式:manifest 静态 content_scripts(matches <all_urls> + 必需 host 权限)。
// 曾在 0.9.17 尝试改为 optional_host_permissions + scripting.registerContentScripts 动态注册
// (收窄安装时攻击面),但真实用户环境出现 registered=[] 且自愈失效的疑难问题,且"任意页批注"
// 的产品形态决定了每个用户最终都要授全站权限——按需授权只增加摩擦。故回退到静态声明(0.9.16
// 同款,线上验证过的行为);其余 v0.9.17 安全加固全部保留。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// 授权变化(用户在 Side Panel 授予/撤销全站权限)→ 通知 Side Panel 引导刷新已打开页面
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener((p) => {
    broadcast({ type: "hg-permissions-changed", added: true, origins: (p && p.origins) || [] });
  });
}
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener((p) => {
    broadcast({ type: "hg-permissions-changed", added: false, origins: (p && p.origins) || [] });
  });
}

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

// v0.9.x 诊断队列:background 累积每个 run 的 stream(sidepanel 关闭也不丢),供终态诊断捕获。
// _streamBuf: runId -> { text:String, denials:[{tool,category}] }。delta/message 拼 text;tool_denied 记结构化。
const _streamBuf = new Map();
const _STREAM_TEXT_CAP = 8000;
function accumulateStream(runId, m) {
  if (!runId || !m) return;
  const kind = m.kind;
  if (kind !== "delta" && kind !== "message" && kind !== "tool_denied") return;
  let buf = _streamBuf.get(runId);
  if (!buf) { buf = { text: "", denials: [] }; _streamBuf.set(runId, buf); }
  if (kind === "delta" || kind === "message") {
    buf.text = (buf.text + String(m.text || "")).slice(-_STREAM_TEXT_CAP);
  } else if (kind === "tool_denied") {
    buf.denials.push({ tool: String(m.tool || ""), category: String(m.category || "") });
  }
}
// 终态取出并清空 runId 的 buffer(captureDiag 用;取完即删,避免内存堆积)。
function takeStreamBuf(runId) {
  const buf = _streamBuf.get(runId);
  if (!buf) return { text: "", denials: [] };
  _streamBuf.delete(runId);
  return { text: buf.text, denials: buf.denials };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  // CORE-3:bridge-* 消息只接受本扩展自身(side panel / content-script)发起 —— sender.id 必须等于本扩展 id,
  // 拦截跨扩展伪造(manifest 未开 externally_connectable,此为纵深防御)。native host 回送走 connectNative
  // 的 port.onMessage(onHostMessage / probe 等),不经 runtime.onMessage,故不受此校验影响。
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (msg.type === "hg-track") { trackEvent(msg.name, msg.params); return; } // 埋点:不回包,fire-and-forget
  if (msg.type === "bridge-start") {
    handleBridgeStart(msg).then(sendResponse, (e) => sendResponse({ ok: false, code: "BG_ERROR", message: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "bridge-patch-apply") {
    // 方向3:用户确认预览后,复用 pending 的 patch run 落 candidate(新开 host 进程读盘上 edits.json)
    handlePatchApply(msg).then(sendResponse, (e) => sendResponse({ ok: false, code: "BG_ERROR", message: String(e && e.message || e) }));
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
    // sidepanel 卡死恢复 / 同 tab 重进还原运行态:查后台是否真有在跑的 run
    (async () => {
      const active = await Storage.getActiveBridgeRunForTab(msg.tab_id);
      sendResponse({ active: !!active, run_id: active && active.run_id,
        provider: active && active.provider, run_kind: active && active.run_kind });
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
  if (msg.type === "bridge-query-health") {
    // v0.9 §4.2:Connection Center 只读 health。Native Messaging 仅 background 发起;host 不存在 → BRIDGE_NOT_INSTALLED。
    queryBridgeHealth().then(sendResponse, (e) => sendResponse({ ok: true, health: notInstalledHealth("BG_ERROR") }));
    return true;
  }
  if (msg.type === "bridge-repair") {
    // v0.9 §4.1:仅用户明确确认后调用;confirmed_actions 必须含 repair_native_host(透传 allow-list,不扩)。
    requestBridgeRepair(Array.isArray(msg.confirmed_actions) ? msg.confirmed_actions : []).then(
      sendResponse, (e) => sendResponse({ ok: false, code: "BG_ERROR", message: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === "bridge-get-bootstrap") {
    // v0.9 §5.3:纯本地生成 Setup Prompt / Terminal 命令。固定模板 + 严格变量(仅 extension id/版本/平台),
    // 绝不拼入页面 HTML、评论、Change Contract、路径、登录态。
    sendResponse({ ok: true, bootstrap: makeBootstrap() });
    return;
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
  // v0.8.2 §6.3.4:Copilot 不存 bridge session、不支持续发 → 恒不可 continue
  const continuable = !!(sess && sess.ownership === "htmlgenius" && sess.provider === prov
    && sess.status !== "running" && prov !== COPILOT_PROVIDER
    && (prov === CODEX_PROVIDER ? !!sess.thread_id : isUuid(sess.session_id)));
  return { ok: true, has_session: !!sess, continuable, last_status: sess && sess.status };
}

async function handleBridgeStart({ tab_id, provider, session_mode, run_kind, change_contract, plan, _no_patch }) {
  if (!tab_id) return { ok: false, code: "NO_TAB" };
  if (!SUPPORTED_PROVIDERS.has(provider)) return { ok: false, code: "UNKNOWN_PROVIDER", message: "unsupported provider: " + provider };
  let runKind = run_kind || "handoff"; // Night Pack A: "candidate" 产受控 candidate;"plan" v0.8.1 产受控修改计划;缺省 "handoff"(v0.7.1 ack)。let:方向3 会在 precise_patch+支持 patch 时就地升级为 patch_preview
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
  //     v0.8.2 §6.4:Copilot 还校验 provider_runtime 一致性(ctx.required_provider_runtime = 将发给 Host 的锁定值)。
  let confirmedPlanRec = null;
  if (runKind === "candidate" && plan) {
    const planRec = await Storage.getBridgePlan(plan.plan_id).catch(() => null);
    const pv = PlanValidate.validatePlanConfirmation(planRec, {
      provider, logical_document_id: logicalId, tab_id,
      source_artifact_uri: art.url, loaded_artifact_hash: loadedHash,
      task_sha256: taskSha, edited_plan_markdown: plan.edited_plan_markdown, plan_sha256: plan.plan_sha256,
      required_provider_runtime: provider === COPILOT_PROVIDER ? (planRec && planRec.provider_runtime) || null : undefined
    });
    if (!pv.ok) return { ok: false, code: pv.code, message: "plan confirmation rejected: " + pv.code + (pv.field ? " (" + pv.field + ")" : "") };
    confirmedPlanRec = planRec;
  }

  // 方向3 确定性编辑快车道:candidate + precise_patch + provider 支持 patch → 内部升级为 patch_preview。
  // sidepanel 发送路径不变(仍发 candidate),升级在 background 透明完成;_no_patch 用于坏 JSON 回落 candidate 时防再次升级(死循环)。
  if (runKind === "candidate" && task.mode === "precise_patch" && !_no_patch && ProviderMetadata.providerSupports(provider, "patch")) {
    runKind = "patch_preview";
  }

  // 4. tab lock:同一 tab 不允许并发 run
  const active = await Storage.getActiveBridgeRunForTab(tab_id);
  if (active) return { ok: false, code: "RUN_IN_PROGRESS", run_id: active.run_id };

  // 5. continue:按 provider 查 bridge-owned、非 running 的已存 session(仅 handoff 旧路径可达;candidate/plan 已被 session_mode 门禁拦下)
  //    claude 用保存的 session_id UUID;codex 用保存的 thread_id(spec §5/§6.2);copilot 永不续发(v0.8.2 §7.6)
  let continueRef = null;
  if (session_mode === "continue") {
    if (provider === COPILOT_PROVIDER) return { ok: false, code: "NO_CONTINUABLE_SESSION" };
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
    patch_change_contract: runKind === "patch_preview" ? task : null, // 方向3:坏 JSON 回落 candidate 时复用
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

  // v0.8.2 §6.3.2:session 字段按 provider 明确构造;Copilot 只发 { mode }(不带任何 session 引用,永不续发)
  let sessionField;
  if (provider === CODEX_PROVIDER) sessionField = { mode: session_mode, thread_id: continueRef };
  else if (provider === COPILOT_PROVIDER) sessionField = { mode: session_mode };
  else sessionField = { mode: session_mode, session_id: continueRef };

  // R-7:工作区根 = 用户打开的 artifact 所在目录(file: URL)。仅本地 file:// 有工作区概念;
  // bridge 据此做 realpath 包含校验,把可读源 .html 限定在该工作区内,堵住「artifact_uri 指向任意
  // 本地 .html → 经 Agent 流式外泄」。远程页留空 → bridge 回退既有 symlink/realpath 防御。
  const _wsRoot = (art && /^file:/i.test(art.url))
    ? (() => { try { const u = new URL(art.url); u.pathname = u.pathname.replace(/[^/]*$/, ""); return u.href; } catch (e) { return undefined; } })()
    : undefined;

  const startMsg = {
    type: HANDOFF_START_TYPES[provider],
    provider,
    run_id: runId,
    run_kind: runKind,
    source: {
      logical_document_id: logicalId,
      artifact_uri: art.url,
      base_artifact_hash: loadedHash,
      workspace_root_uri: _wsRoot
    },
    session: sessionField,
    task: task
  };
  // v0.8.1 §6.8:candidate 携带已确认 plan → 装入 approved_plan(plan_id/原 plan_sha256/用户审核后的 edited_plan_markdown)
  if (runKind === "candidate" && plan) {
    startMsg.approved_plan = { plan_id: plan.plan_id, plan_sha256: plan.plan_sha256, edited_plan_markdown: plan.edited_plan_markdown };
    // v0.8.2 §6.3.6:Copilot 锁定生成计划时的 runtime;Host 必须匹配,否则 COPILOT_RUNTIME_CHANGED
    if (provider === COPILOT_PROVIDER) {
      startMsg.required_provider_runtime = (confirmedPlanRec && confirmedPlanRec.provider_runtime) || null;
    }
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
  if (m.type === "patch-preview-ready") {
    // 方向3:确定性编辑预览就绪 → 按设置(预览确认/直接应用)分流
    onPatchPreviewReady(tab_id, runId, m, taskSha, logicalId, artifactUrl);
    return;
  }
  if (m.type === "plan-ready") {
    // v0.8.1 §5.3:host 受控 plan run 产物。逐字段校验(绝不跨侧比 hash)→ 建 bridge_plans(draft)→ 广播(不含路径/session)。
    completePlan(tab_id, runId, m, taskSha, logicalId, artifactUrl);
    return;
  }
  if (m.type === "bridge_stream") {
    // v0.8.1:Codex turn 中途进度(token 流/工具/文件)。只转发安全摘要,不含命令体/路径/stderr/思维链正文。
    accumulateStream(runId, m); // v0.9.x:background 累积 stream(sidepanel 关闭也不丢),供终态诊断捕获
    broadcast({ type: "bridge-stream", tab_id, run_id: runId, kind: m.kind || "info", text: String(m.text || "").slice(0, 8000), starting: !!m.starting });
    return;
  }
  if (m.type === "bridge_failed") {
    // 方向3:patch_preview 输出坏 JSON(PATCH_EDITS_INVALID)→ 静默回落 candidate(用回存契约重发);其余照常 failRun
    Storage.getBridgeRun(runId).then((run) => {
      if (run && run.run_kind === "patch_preview" && m.code === "PATCH_EDITS_INVALID" && run.patch_change_contract) {
        patchFallbackToCandidate(tab_id, runId, run, m).catch(() => failRun(tab_id, runId, m.code || "RUN_FAILED", m.message || ""));
        return;
      }
      failRun(tab_id, runId, m.code || "RUN_FAILED", m.message || "");
    }).catch(() => failRun(tab_id, runId, m.code || "RUN_FAILED", m.message || ""));
    return;
  }
}

function onHostDisconnect(tab_id, runId) {
  const entry = _runsByTab.get(tab_id);
  if (!entry || entry.run_id !== runId || entry.terminal) return;
  const err = chrome.runtime.lastError;
  failRun(tab_id, runId, "HOST_DISCONNECTED", err ? String(err.message || err) : "native host disconnected");
}

// v0.9.x 诊断队列:run 终态(failed/no_change)捕获诊断上下文 → 入队(留最近 10)。
// sidepanel 关闭也不丢(队列在 IndexedDB);hgAutoDiag opt-in 时 background 直接自动上传。
// 注:agent_stream 可能含页面内容(用户上报前可在 sidepanel 浮层审视);tool_denials 结构化便于定位 Copilot 读源等。
async function captureDiag(runId, { outcome, code, message, compliance }) {
  if (!runId) return;
  let run = null;
  try { run = await Storage.getBridgeRun(runId); } catch (_) {}
  const buf = takeStreamBuf(runId); // 取出累积 stream + 工具拒绝事件,取完即清(防内存堆积)
  const record = {
    at: nowIso(),
    outcome,                           // "failed" | "no_change"
    run_id: runId,
    provider: (run && run.provider) || null,
    run_kind: (run && run.run_kind) || null,
    task_mode: (run && run.mode) || null,
    error_code: code || (run && run.error_code) || null,
    message: String(message || "").slice(0, 1000) || null,
    compliance: compliance || null,
    agent_stream: buf.text,
    tool_denials: buf.denials,
    app_version: extensionVersion(),
    bridge_protocol: BRIDGE_PROTOCOL_VERSION,
  };
  try { await Storage.enqueueDiagnostic(record); } catch (e) { console.warn("[hg] enqueueDiagnostic failed", e); }
  // opt-in 自动上报(参照 onPatchPreviewReady 读 hgPatchApplyMode 的写法)
  let autoDiag = false, backend = "";
  try {
    const cfg = await new Promise((res) => {
      try { chrome.storage.sync.get({ hgAutoDiag: false, backend: "" }, (r) => res(r || {})); }
      catch (e) { res({}); }
    });
    autoDiag = !!(cfg && cfg.hgAutoDiag);
    backend = (cfg && cfg.backend) || "";
  } catch (_) {}
  if (autoDiag) {
    const url = (backend || "https://www.deuce.monster/htmlgenius") + "/api/diagnostics";
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ mode: "auto" }, record)) }).catch(() => {});
  }
}

async function failRun(tab_id, runId, code, message) {
  // R-10(v0.9.9):终态守卫 —— run 已 completed/failed 则不再覆盖。避免迟到的失败(host 在 bridge_completed
  // 后又补发 bridge_failed、或 reconcile 与关 tab 竞态)把成功 run 误标失败 + 双广播/状态长期不一致。
  try {
    if (runId) {
      const cur = await Storage.getBridgeRun(runId);
      if (cur && (cur.status === "completed" || cur.status === "failed")) {
        console.log("[hg] failRun skip (already terminal) run=", runId, "status=", cur.status, "code=", code);
        return;
      }
    }
  } catch (e) { /* 读不到则按原逻辑继续 */ }
  const entry = _runsByTab.get(tab_id);
  if (entry) entry.terminal = true;
  console.log("[hg] run FAILED run=", runId, "tab=", tab_id, "code=", code, "msg=", String(message || "").slice(0, 160));
  // 先广播再写库:SW 可能在 await IndexedDB 期间被 Chrome 杀掉 → broadcast 永远不执行 → sidepanel 卡死
  broadcast({ type: "bridge-failed", tab_id, run_id: runId, code, message });
  await Storage.updateBridgeRun(runId, { status: "failed", error_code: code, completed_at: nowIso() }).catch(() => {});
  captureDiag(runId, { outcome: "failed", code, message }).catch(() => {}); // v0.9.x 诊断队列:失败入队
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

// CORE-1:SW 会被 Chrome 机会性杀死(空闲约 30s / 内存压力)。重启后内存 _runsByTab 清空、
// native host port 已断,但 DB 里 run 仍停在 starting/running → 该 tab 下次 bridge-start 命中
// getActiveBridgeRunForTab 守卫永远 RUN_IN_PROGRESS,sidepanel 一直转圈。每次 SW 新实例加载时
// 对账:DB 中活跃但本实例无 port 的 run 一律标失败并广播。
// 不会误伤:真正在跑的 run 其 SW 实例不会被杀、模块不会重跑;且 saveBridgeRun→_runsByTab.set
// 之间无 await(事件循环视角原子),新建 run 必已在 _runsByTab 中。
async function reconcileOrphanedRuns() {
  let active;
  try { active = await Storage.listActiveBridgeRuns(); } catch (e) { return; }
  for (const run of active || []) {
    if (!run || !run.run_id) continue;
    const entry = _runsByTab.get(run.tab_id);
    if (entry && entry.run_id === run.run_id) continue;  // 本实例仍持有活跃 port,非孤儿
    console.log("[hg] reconcile 孤儿 run 标失败 run=", run.run_id, "tab=", run.tab_id, "was=", run.status);
    await failRun(run.tab_id, run.run_id, "SW_RESTARTED_ORPHANED", "service worker restarted; native host port lost");
  }
}
reconcileOrphanedRuns().catch(() => {});

// CORE-2:运行中关闭 tab → native port 随 tab 断开,但 DB run 未转终态;Chrome 复用 tab id 后,
// 拿到同 id 的无关页签被 getActiveBridgeRunForTab 永久阻塞。关 tab 时主动清理该 tab 的活跃 run。
chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = _runsByTab.get(tabId);
  _runsByTab.delete(tabId);
  if (entry && !entry.terminal) {
    try { if (entry.port) entry.port.disconnect(); } catch (e) {}
    failRun(tabId, entry.run_id, "USER_TAB_CLOSED", "tab closed during run");
    return;
  }
  // 内存无记录但 DB 可能残留活跃 run(如 SW 重启尚未对账就关 tab)→ 按 tab 兜底清理。
  Storage.getActiveBridgeRunForTab(tabId).then((run) => {
    if (run) failRun(tabId, run.run_id, "USER_TAB_CLOSED", "tab closed during run");
  }).catch(() => {});
});

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
    title: "PageTack – Web Annotation",
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

// —— 方向3 确定性编辑快车道:预览就绪分流(设置驱动:先预览后确认 / 直接应用)——
// 存预览(状态 awaiting_confirm)→ 读设置 hgPatchApplyMode:
//   apply_then_review(默认)→ 自动以全部 ok 编辑发 patch_apply(直接产出 candidate,事后审阅);
//   preview_confirm → 断开 preview host(应用时另起进程),广播 bridge-patch-preview 供 sidepanel 确认。
function _patchWorkspaceRoot(uri) {
  if (!(uri && /^file:/i.test(uri))) return undefined;
  try { const u = new URL(uri); u.pathname = u.pathname.replace(/[^/]*$/, ""); return u.href; } catch (e) { return undefined; }
}
async function onPatchPreviewReady(tab_id, runId, m, taskSha, logicalId, artifactUrl) {
  await Storage.updateBridgeRun(runId, { status: "awaiting_confirm", patch_preview: { edits: m.edits, compliance: m.compliance } }).catch(() => {});
  const mode = await new Promise((res) => {
    try { chrome.storage.sync.get({ hgPatchApplyMode: "apply_then_review" }, (r) => res((r && r.hgPatchApplyMode) || "apply_then_review")); }
    catch (e) { res("apply_then_review"); }
  });
  const okIds = (m.edits || []).filter((e) => e && e.status === "ok").map((e) => e.id);
  if (mode === "apply_then_review" && okIds.length > 0) {
    broadcast({ type: "bridge-progress", tab_id, run_id: runId, status: "running" });
    handlePatchApply({ tab_id, run_id: runId, confirmed_edit_ids: okIds }).catch(() => {});
    return;
  }
  // okIds 为空(目标已满足/定位不到/全被跳过)→ 不自动应用零编辑(会产出与原文完全相同的无意义 candidate),
  // 改走预览展示路径:sidepanel 渲染空状态说明,由用户取消收尾。
  // v0.9.x:no_change(applicable===0)入诊断队列 —— 区分 failed,让用户能上报"Agent 没改任何东西"的现场
  if (okIds.length === 0) captureDiag(runId, { outcome: "no_change", compliance: m.compliance }).catch(() => {});
  // 预览确认:收尾 preview host(应用阶段另起进程读盘),保持 run 于 awaiting_confirm(tab 锁仍持有)
  const entry = _runsByTab.get(tab_id);
  if (entry && entry.run_id === runId) { entry.terminal = true; try { entry.port.disconnect(); } catch (_) {} }
  broadcast({ type: "bridge-patch-preview", tab_id, run_id: runId, edits: m.edits, compliance: m.compliance, task_sha256: m.task_sha256 });
}

// —— 方向3:用户确认(或自动应用)后,复用 pending 的 patch run 落 candidate ——
// 新开 host 进程读盘上 edits.json + source snapshot 应用(对 ServiceWorker 挂起健壮);candidate-ready 复用 completeCandidate。
async function handlePatchApply({ tab_id, run_id, confirmed_edit_ids }) {
  if (!tab_id || !run_id) return { ok: false, code: "BAD_REQUEST" };
  if (!Array.isArray(confirmed_edit_ids)) return { ok: false, code: "BAD_REQUEST" };
  const run = await Storage.getBridgeRun(run_id).catch(() => null);
  if (!run || run.run_kind !== "patch_preview" || run.status !== "awaiting_confirm") return { ok: false, code: "NO_PENDING_PATCH" };
  if (run.tab_id !== tab_id) return { ok: false, code: "TAB_MISMATCH" };
  const prev = _runsByTab.get(tab_id);
  if (prev) { prev.terminal = true; try { prev.port.disconnect(); } catch (_) {} }
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); }
  catch (e) { await Storage.updateBridgeRun(run_id, { status: "failed", error_code: "BRIDGE_NOT_INSTALLED", completed_at: nowIso() }); return { ok: false, code: "BRIDGE_NOT_INSTALLED" }; }
  if (chrome.runtime.lastError || !port) {
    await Storage.updateBridgeRun(run_id, { status: "failed", error_code: "BRIDGE_NOT_INSTALLED", completed_at: nowIso() });
    return { ok: false, code: "BRIDGE_NOT_INSTALLED" };
  }
  await Storage.updateBridgeRun(run_id, { status: "running" }).catch(() => {});
  _runsByTab.set(tab_id, { run_id, port, terminal: false });
  port.onMessage.addListener((m) => onHostMessage(tab_id, run_id, m, run.task_sha256, run.logical_document_id, run.source_artifact_uri));
  port.onDisconnect.addListener(() => onHostDisconnect(tab_id, run_id));
  port.postMessage({
    type: HANDOFF_START_TYPES[run.provider],
    provider: run.provider,
    run_id,
    run_kind: "patch_apply",
    source: { logical_document_id: run.logical_document_id, artifact_uri: run.source_artifact_uri, base_artifact_hash: run.base_artifact_hash, workspace_root_uri: _patchWorkspaceRoot(run.source_artifact_uri) },
    confirmed_edit_ids
  });
  broadcast({ type: "bridge-progress", tab_id, run_id, status: "running" });
  return { ok: true, run_id };
}

// —— 方向3:patch_preview 坏 JSON → 静默回落 candidate(用回存契约重发;_no_patch 防再次升级死循环)——
async function patchFallbackToCandidate(tab_id, runId, run, m) {
  const entry = _runsByTab.get(tab_id);
  if (entry && entry.run_id === runId) { entry.terminal = true; try { entry.port.disconnect(); } catch (_) {} }
  await Storage.updateBridgeRun(runId, { status: "failed", error_code: "PATCH_EDITS_INVALID", completed_at: nowIso() }).catch(() => {});
  const res = await handleBridgeStart({ tab_id, provider: run.provider, session_mode: "new", run_kind: "candidate", change_contract: run.patch_change_contract, _no_patch: true });
  if (res && res.ok) {
    broadcast({ type: "bridge-patch-fallback", tab_id, old_run_id: runId, new_run_id: res.run_id });
  } else {
    broadcast({ type: "bridge-failed", tab_id, run_id: runId, code: "PATCH_EDITS_INVALID", message: (m && m.message) || "patch edits invalid; fallback failed" });
  }
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
  const isCopilot = provider === COPILOT_PROVIDER;
  // v0.8.2 §6.3.4:Copilot 不读/不存 session_id(每 run 一个 ephemeral session,不落 bridge_sessions)
  const sessionId = isCopilot ? null : (isCodex ? (completion.thread_id || null) : (run.session_id || null));
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
  // 注:不再存变更高亮清单(原按候选 URI 键控)—— 候选页不画任何改动标记(见 content-script 注释:禁止私自样式变更)。
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
    provider_runtime: planReady.provider_runtime || null,      // v0.8.2 §6.3.5:Copilot 计划确认时锁定同 runtime(枚举已在 validator 把关)
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
  // plan_sha256 必须随广播送达 Side Panel:v0.8.2 §1.1 — onPlanReady 存入 _plan,确认计划时 planPayload() 回传,
  // PlanValidate.validatePlanConfirmation() 要求该值与 bridge_plans 记录一致;缺失则确认永远 PLAN_INVALID。
  broadcast({
    type: "bridge-plan-ready", tab_id, run_id: runId, plan_id: planId,
    plan_sha256: planRec.plan_sha256,
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
    // probe 整体失败:三个 provider 归一为 error(sanitize 会补齐缺失项);仍缓存 30s 避免频繁重探。
    raw = { providers: [{ id: PROVIDER, status: "error" }, { id: CODEX_PROVIDER, status: "error" }, { id: COPILOT_PROVIDER, status: "error" }] };
  }
  const result = { ok: true, providers: PlanValidate.sanitizeProbeResult(raw).providers, checked_at: nowIso() };
  _providerProbe.set(result);
  return result;
}

// —— v0.9 §4.2/§5.3:Connection Center 支撑(health / repair / bootstrap)——

// host 不存在(或连接失败)时的兜底 health(§4.2/§5.4):不展示 Chrome 原始错误,只给机器码。
function notInstalledHealth(reasonCode) {
  return {
    schema_version: 1, overall: "action_required",
    bridge: { status: "install_required", version: null, protocol_version: BRIDGE_PROTOCOL_VERSION, managed_install: false },
    browser: { status: "manifest_missing" },
    providers: [],
    actions: ["copy_setup_prompt", "copy_terminal_command", "copy_diagnostics"],
    reason_code: reasonCode || "BRIDGE_NOT_INSTALLED",
    extension_version: extensionVersion()
  };
}

// 一次 native 往返:发 request,等 match(msg) 返回非 undefined;connect 失败 / disconnect / 超时 → fallback()。
function nativeRoundTrip(request, match, fallback, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let port;
    try { port = chrome.runtime.connectNative(NATIVE_HOST); } catch (e) { return resolve(fallback()); }
    if (chrome.runtime.lastError || !port) return resolve(fallback());
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); try { port.disconnect(); } catch (_) {} resolve(v); } };
    const timer = setTimeout(() => finish(fallback()), timeoutMs);
    port.onMessage.addListener((m) => { const r = match(m); if (r !== undefined) finish(r); });
    port.onDisconnect.addListener(() => finish(fallback()));
    try { port.postMessage(request); } catch (e) { finish(fallback()); }
  });
}

async function queryBridgeHealth() {
  const request = { type: "bridge_health", protocol_version: BRIDGE_PROTOCOL_VERSION, extension: { id: chrome.runtime.id, version: extensionVersion() } };
  return await nativeRoundTrip(request, (m) => {
    if (!m) return undefined;
    if (m.type === "bridge_health_result" && m.health) {
      let h = m.health;
      const pv = h.bridge && h.bridge.protocol_version;
      if (typeof pv === "number" && pv > BRIDGE_PROTOCOL_VERSION) {
        // host 协议比扩展新 → 「扩展需要更新」;不派发编辑任务(§4.3)
        h = Object.assign({}, h, { overall: "action_required", reason_code: "BRIDGE_PROTOCOL_TOO_NEW",
          bridge: Object.assign({}, h.bridge, { status: "protocol_incompatible" }) });
      }
      return { ok: true, health: h };
    }
    // v0.8.2 及更早 host 不认识 bridge_health → unknown_message → 「本地连接组件需要更新」(§4.3)
    if (m.type === "bridge_failed" || m.type === "unknown_message") {
      return { ok: true, health: Object.assign(notInstalledHealth("BRIDGE_PROTOCOL_TOO_OLD"), {
        bridge: { status: "protocol_incompatible", version: null, protocol_version: BRIDGE_PROTOCOL_VERSION, managed_install: false } }) };
    }
    return undefined;
  }, () => ({ ok: true, health: notInstalledHealth("BRIDGE_NOT_INSTALLED") }));
}

async function requestBridgeRepair(confirmedActions) {
  // allow-list 透传:只接受 repair_native_host,其它一律不发(§4.1)
  if (!Array.isArray(confirmedActions) || !confirmedActions.includes("repair_native_host")) {
    return { ok: false, code: "REPAIR_NOT_CONFIRMED" };
  }
  const request = { type: "bridge_repair", protocol_version: BRIDGE_PROTOCOL_VERSION, extension: { id: chrome.runtime.id }, confirmed_actions: ["repair_native_host"] };
  return await nativeRoundTrip(request, (m) => {
    if (!m) return undefined;
    if (m.type === "bridge_health_result" && m.health) return { ok: true, health: m.health };
    if (m.type === "bridge_failed") return { ok: false, code: m.code || "HOST_REPAIR_ERROR" };
    if (m.type === "unknown_message") return { ok: false, code: "BRIDGE_PROTOCOL_TOO_OLD" };
    return undefined;
  }, () => ({ ok: false, code: "BRIDGE_NOT_INSTALLED" }));
}

// v0.9 §5.3:Setup Prompt 固定模板。变量只有 extension id / bridge version;绝不拼入页面 HTML、评论、
// Change Contract、文件路径、用户名、provider 登录态(§6.1)。production = 已发布固定版本 npx 命令;
// development = 仓库内开发命令(显著标注「仅开发环境」)。
const SETUP_PROMPT_TEMPLATES = {
  zh: (id, bv) => "请只帮我初始化 PageTack 的本地连接，不要修改任何项目文件、HTML 文件或 Agent 配置。\n\n用户已明确授权你在“当前用户目录”安装/修复 PageTack Local Bridge；不要请求管理员权限，不要安装或登录任何 Agent，不要读取历史会话、密钥、Cookie 或项目文件。\n\nChrome Extension ID：" + id + "\n需要的 Bridge 版本：" + bv + "\n\n请按顺序执行：\n1. 先运行只读检查：\n   npx --yes @htmlgenius/bridge@" + bv + " doctor --json --extension-id " + id + "\n2. 若检查显示 Bridge 未安装、损坏或需要修复，运行：\n   npx --yes @htmlgenius/bridge@" + bv + " setup --json --scope user --extension-id " + id + "\n3. 再运行一次 doctor。\n\n最后只用简短中文汇报：Bridge 是否已就绪；哪些已支持 Agent 可用；哪些仍需要我自行登录或更新。不要输出绝对路径、token、会话信息或原始日志。",
  en: (id, bv) => "Only initialize the local connection for PageTack; do not modify any project files, HTML files, or Agent configuration.\n\nThe user has explicitly authorized you to install/repair the PageTack Local Bridge in the current user's home directory. Do not request admin privileges, do not install or sign in to any Agent, and do not read past sessions, keys, cookies, or project files.\n\nChrome Extension ID: " + id + "\nRequired Bridge version: " + bv + "\n\nRun in order:\n1. Read-only check first:\n   npx --yes @htmlgenius/bridge@" + bv + " doctor --json --extension-id " + id + "\n2. If Bridge is not installed, corrupt, or needs repair, run:\n   npx --yes @htmlgenius/bridge@" + bv + " setup --json --scope user --extension-id " + id + "\n3. Run doctor once more.\n\nFinally, briefly report whether Bridge is ready, which supported Agents are available, and which still need me to sign in or update. Do not output absolute paths, tokens, session info, or raw logs.",
  ja: (id, bv) => "PageTack のローカル接続の初期化のみを行ってください。プロジェクトファイル、HTML ファイル、Agent 設定は一切変更しないでください。\n\nユーザーは現在のユーザーディレクトリへの PageTack Local Bridge のインストール/修復を明示的に許可しています。管理者権限の要求、Agent のインストール/ログイン、過去のセッション・鍵・Cookie・プロジェクトファイルの読み取りは禁止です。\n\nChrome Extension ID: " + id + "\n必要な Bridge バージョン: " + bv + "\n\n以下の順に実行:\n1. まず読み取り専用チェック:\n   npx --yes @htmlgenius/bridge@" + bv + " doctor --json --extension-id " + id + "\n2. 未インストール/破損/修復が必要と出たら:\n   npx --yes @htmlgenius/bridge@" + bv + " setup --json --scope user --extension-id " + id + "\n3. もう一度 doctor を実行。\n\n最後に、Bridge が準備できたか、どの Agent が利用可能か、ログイン/更新が必要なのはどれかを簡潔に報告してください。絶対パス・トークン・セッション情報・生のログは出力しないでください。"
};
// 开发态模板:仓库内命令(未发布 npm 包时不得给出必然失败的 npx 命令;§5.3)。
const SETUP_PROMPT_TEMPLATES_DEV = {
  zh: (id) => "【仅开发环境】请只帮我初始化 PageTack 的本地连接，不要修改任何项目文件、HTML 文件或 Agent 配置。\n\n用户已明确授权你在“当前用户目录”安装/修复 PageTack Local Bridge；不要请求管理员权限，不要安装或登录任何 Agent，不要读取历史会话、密钥、Cookie 或项目文件。\n\nChrome Extension ID：" + id + "\n\n请按顺序执行（htmlGenius 源码仓库的 bridge/ 目录下）：\n1. npm install\n2. node install-macos.mjs --extension-id " + id + "\n\n最后只用简短中文汇报：Bridge 是否已就绪；哪些已支持 Agent 可用；哪些仍需要我自行登录或更新。不要输出绝对路径、token、会话信息或原始日志。",
  en: (id) => "[DEV ONLY] Only initialize the local connection for PageTack; do not modify any project files, HTML files, or Agent configuration.\n\nThe user has authorized installing/repairing the PageTack Local Bridge in the current user's home directory. No admin privileges, no installing/signing in to Agents, no reading sessions/keys/cookies/project files.\n\nChrome Extension ID: " + id + "\n\nRun in order (inside the htmlGenius repo's bridge/ directory):\n1. npm install\n2. node install-macos.mjs --extension-id " + id + "\n\nFinally, briefly report readiness and which Agents still need sign-in/update. No absolute paths, tokens, session info, or raw logs.",
  ja: (id) => "【開発環境専用】PageTack のローカル接続のみ初期化してください。プロジェクトファイル・HTML・Agent 設定は変更禁止。\n\nChrome Extension ID: " + id + "\n\nhtmlGenius リポジトリの bridge/ ディレクトリで順に実行:\n1. npm install\n2. node install-macos.mjs --extension-id " + id + "\n\n最後に準備状況とログイン/更新が必要な Agent を簡潔に報告。絶対パス・トークン・セッション情報・生のログは出力禁止。"
};

function makeBootstrap() {
  const id = chrome.runtime.id;
  const extVer = extensionVersion();
  // 变量严格校验后才填入模板(§6.1)
  const safeId = (/^[a-p]{32}$/.test(id || "")) ? id : "";
  let lang = "zh";
  try { lang = String(chrome.i18n.getUILanguage() || "zh").slice(0, 2); } catch (_) {}
  const isProd = BOOTSTRAP_DISTRIBUTION === "production";
  const tpl = (isProd ? SETUP_PROMPT_TEMPLATES : SETUP_PROMPT_TEMPLATES_DEV)[lang]
    || (isProd ? SETUP_PROMPT_TEMPLATES.zh : SETUP_PROMPT_TEMPLATES_DEV.zh);
  const out = {
    distribution: BOOTSTRAP_DISTRIBUTION,
    dev_only: !isProd,
    bridge_version: TARGET_BRIDGE_VERSION,
    extension_version: extVer,
    platform: "macOS",
    setup_prompt: safeId ? (isProd ? tpl(safeId, TARGET_BRIDGE_VERSION) : tpl(safeId)) : "",
    terminal_command: ""
  };
  if (safeId) {
    out.terminal_command = isProd
      ? "npx --yes @htmlgenius/bridge@" + TARGET_BRIDGE_VERSION + " setup --json --scope user --extension-id " + safeId
      : "cd <htmlGenius repo>/bridge && npm install && node install-macos.mjs --extension-id " + safeId;
  }
  return out;
}

// 连 native host 发 provider_probe;host 回 provider_probe_result。单次往返,~10s 超时。
// host 不识别 provider_probe → 返回 bridge_failed/unknown_message → 归一为 error(各 provider 各自暂不可用),不抛错。
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
    try { port.postMessage({ type: "provider_probe", providers: [PROVIDER, CODEX_PROVIDER, COPILOT_PROVIDER] }); }
    catch (e) { finish(ERR_BOTH); }
  });
}

function newPlanId() {
  return "hgp_" + (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "").slice(0, 24)
    || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
}

// === 埋点单写者(队列/游标/网络只在此处碰 chrome.storage.local 的 hg_* 键)===
// storage 键:hg_client_id(UUID)/ hg_events([{seq,name,params,ts(ms)}]) / hg_cursors({backend,ga}) / hg_ga({id,secret})
const _AN_STORAGE = {
  get() {
    return new Promise((res) => chrome.storage.local.get(["hg_client_id", "hg_events", "hg_cursors", "hg_ga"], (r) => res(r || {})));
  },
  set(obj) { return new Promise((res) => chrome.storage.local.set(obj, () => res())); },
};
let _flushTimer = 0;
function _analyticsBackend() {
  // 与 captureDiag 同源:backend 存在 chrome.storage.sync,缺省回落官网地址
  return new Promise((res) => {
    try { chrome.storage.sync.get({ backend: "" }, (r) => res((r && r.backend) || "https://www.deuce.monster/htmlgenius")); }
    catch (e) { res("https://www.deuce.monster/htmlgenius"); }
  });
}
async function _ensureClientId(st) {
  if (!st.hg_client_id) {
    let id = "hgcid_" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random().toString(36).slice(2));
    await _AN_STORAGE.set({ hg_client_id: id });
    st.hg_client_id = id;
  }
  return st.hg_client_id;
}
async function trackEvent(name, params) {
  try {
    const st = await _AN_STORAGE.get();
    await _ensureClientId(st);
    const now = Date.now();
    const events = Array.isArray(st.hg_events) ? st.hg_events : [];
    const r = HGAnalyticsCore.appendEvent(events, name, params, now, now, 500);
    let cursors = st.hg_cursors || { backend: 0, ga: 0 };
    if (r.oldestSeq > 1 && cursors.backend < r.oldestSeq - 1) cursors.backend = r.oldestSeq - 1; // 丢最旧 → 游标钳到队列前
    if (r.oldestSeq > 1 && cursors.ga < r.oldestSeq - 1) cursors.ga = r.oldestSeq - 1;
    await _AN_STORAGE.set({ hg_events: r.events, hg_cursors: cursors });
    if (_flushTimer) clearTimeout(_flushTimer); // 防抖 3s(SW 存续期内 best-effort;被杀则等下次唤醒)
    _flushTimer = setTimeout(flushAnalytics, 3000);
  } catch (e) { /* 埋点永不影响产品 */ }
}
async function flushAnalytics() {
  try {
    const st = await _AN_STORAGE.get();
    if (!st.hg_client_id || !Array.isArray(st.hg_events) || !st.hg_events.length) return;
    const clientId = st.hg_client_id;
    let cursors = st.hg_cursors || { backend: 0, ga: 0 };
    const now = Date.now();
    // 路① 自建后端(全量,大陆可达):≤50 条/批;acked_seq 与 rejected 都推进游标(被拒事件不重发)
    let pendingB = HGAnalyticsCore.toFlush(st.hg_events, cursors.backend);
    for (let i = 0; i < pendingB.length; i += 50) {
      const batch = pendingB.slice(i, i + 50).map((e) => ({ seq: e.seq, name: e.name, params: e.params, ts: new Date(e.ts).toISOString() }));
      const base = await _analyticsBackend();
      const r = await fetch(base + "/api/events", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, events: batch }),
      }).catch(() => null);
      if (!r || !r.ok) return; // 本轮放弃:下次唤醒整段补发
      const j = await r.json().catch(() => null);
      if (j && typeof j.acked_seq === "number" && j.acked_seq > cursors.backend) cursors.backend = j.acked_seq;
    }
    // 路② GA4 MP 直发(能到 google 才有意义;配置为空 → 整路跳过,游标不动,靠 500 条上限兜底)
    const ga = st.hg_ga;
    if (ga && ga.id && ga.secret) {
      const pendingG = HGAnalyticsCore.toFlush(st.hg_events, cursors.ga);
      const batches = HGAnalyticsCore.gaBatches(pendingG, now);
      let allOk = true;
      for (const b of batches) {
        const r = await fetch("https://www.google-analytics.com/mp/collect?measurement_id=" + encodeURIComponent(ga.id) + "&api_secret=" + encodeURIComponent(ga.secret), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId, events: b }),
        }).catch(() => null);
        if (!r || !r.ok) { allOk = false; break; } // 2xx 即视为已提交(MP 对无效事件也回 2xx)
      }
      if (allOk && pendingG.length) cursors.ga = pendingG[pendingG.length - 1].seq; // 含被跳过的 >7d 事件
    }
    const kept = HGAnalyticsCore.prune(st.hg_events, cursors.backend, cursors.ga);
    await _AN_STORAGE.set({ hg_events: kept, hg_cursors: cursors });
  } catch (e) { /* 埋点永不影响产品 */ }
}
flushAnalytics(); // SW 启动即补发(SW 随时被杀,这是"下次唤醒"的主要钩子之一)
