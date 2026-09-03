// sidepanel.js — v0.4.1: 内联交互(创建/回复/删除均不用浏览器弹窗)+ 中/英/日 i18n
(function () {
  "use strict";

  const t = (k) => (window.HG_I18N ? window.HG_I18N.t(k) : k);

  let isLocal = false;
  let currentTabId = null;
  let _pendingSelector = null; // 新建批注草稿的 {selector, quote}(来自 content-script)
  let _toastTimer = 0;
  let _lastItems = []; // 上次渲染的批注(供切换语言时重绘)
  let _sessionUser = null; // 已登录用户(供切换语言时重绘登录态文案)
  let _artifactState = null;
  let _pendingArtifactReload = false;
  // v0.6.1 修改契约 Composer 临时状态(不持久化)
  let _contractItems = [];        // 本轮评论快照(供校验/渲染;评论更新时重取)
  let _contractArtifact = null;
  let _contractOpen = false;
  let _contractTriggerEl = null;  // 关闭 Composer 后恢复焦点
  // v0.8.1 bridge 状态
  let _contractMeta = null;              // {isLocal, logicalDocumentId, loadedArtifactHash}
  let _contractRunning = false;

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  const CONTENT_SCRIPT_FILES = [
    "vendor/purify.min.js", "text-quote.js", "remote-store.js", "sync.js", "storage.js",
    "artifact-version.js", "buildprompt.js", "i18n.js", "undo.js", "palette.js", "config.js",
    "content-script.js",
  ];
  const _contentRecoveryByTab = new Map();
  function canInjectInto(tab) {
    const url = String((tab && tab.url) || "");
    return /^(https?|file):/i.test(url);
  }
  async function recoverContentScript(tab, showDialog) {
    if (!tab || !tab.id || !canInjectInto(tab) || !chrome.scripting || !chrome.scripting.executeScript) return false;
    if (_contentRecoveryByTab.has(tab.id)) return _contentRecoveryByTab.get(tab.id);
    const recovery = (async () => {
      try {
        // 若依赖脚本仍在，只重载主控制器，避免重复执行带顶层 const 的 storage/text-quote；
        // 若页面是在扩展安装前打开的，则一次补齐完整依赖链。
        const probe = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => !!(window.describe && window.anchor && window.Storage && window.HG_I18N && window.HG_CONFIG),
        });
        const depsReady = !!(probe && probe[0] && probe[0].result);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, files: depsReady ? ["content-script.js"] : CONTENT_SCRIPT_FILES,
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const active = await getActiveTab();
        if (!active || active.id !== tab.id) return false;
        const reply = await chrome.tabs.sendMessage(tab.id, { type: "activate", showDialog: showDialog !== false });
        return !!(reply && reply.ok);
      } catch (e) {
        console.log("content script recovery failed:", e);
        return false;
      } finally {
        _contentRecoveryByTab.delete(tab.id);
      }
    })();
    _contentRecoveryByTab.set(tab.id, recovery);
    return recovery;
  }

  async function sendToContent(msg) {
    const tab = await getActiveTab();
    if (!tab) return null;
    currentTabId = tab.id;
    try { return await chrome.tabs.sendMessage(tab.id, msg); }
    catch (e) {
      console.log("content script not ready:", e);
      // 扩展刚安装/更新、页面长时间挂起或 content-script 上下文失效时，无需让用户刷新网页：
      // 对普通网页自动补注入一次，再重放原操作。Chrome 内部页仍按平台限制保持不可注入。
      if (await recoverContentScript(tab, false)) {
        try { return await chrome.tabs.sendMessage(tab.id, msg); }
        catch (retryError) { console.log("content script retry failed:", retryError); }
      }
      return null;
    }
  }
  // 重拉当前 tab 评论并刷新评论卡(+ 若 contract 开则同步本轮快照)。切 tab / 评论变化时用。
  // sendToContent 已把 currentTabId 更新为活动 tab → sidepanel 按 tab 独立显示评论。
  async function refreshAnnotations() {
    const resp = await sendToContent({ type: "get-annotations" });
    const respTabId = currentTabId; // sendToContent 已把它设为本次查询的活动 tab
    const active = await getActiveTab();
    const stillActive = !active || active.id === respTabId; // 响应是否仍属于当前活动 tab(防快速切 tab 竞态)
    if (!resp || resp.type !== "annotations-list") {
      // content-script 不可达(新 tab 仍在加载 / 受限页 / file:// 未开权限):
      // 仅在仍是当前 tab 时清空,避免残留上一页的评论;旧 tab 的迟到失败不清(让当前 tab 自己的刷新接管)
      if (stillActive) renderCards([]);
      return;
    }
    if (!stillActive) return; // 防竞态:快速切 tab 时旧 tab 的响应晚到,丢弃,不覆盖当前 tab
    isLocal = resp.isLocal;
    _editing = !!resp.editing;
    _artifactState = resp.artifact_state || _artifactState;
    renderSyncPausedHint(resp.synced, resp.sse_live);
    renderMode();
    renderCards(resp.items);
    maybeShowReloadResult(resp.items);
    if (_contractOpen) {
      const ex = await sendToContent({ type: "get-export" }).catch(() => null);
      if (ex && ex.type === "export-data" && _contractOpen) {
        _contractItems = ex.items || [];
        _contractArtifact = ex.artifact || _contractArtifact;
        _contractMeta = bridgeMeta(ex);
        if (_contractStep === "comment-scope") renderCommentScope();
        else { refreshContractUI(); checkPlanStale(); }
      }
    }
  }

  // 激活当前页:content-script 收到后才显示高亮/工具栏/编辑(关闭侧边栏时普通浏览零打扰)
  // showDialog=true 仅在打开侧边栏时用(弹编辑确认窗);切标签/刷新用 false(静默)
  let _panelPort = null; // #5: 与活动标签的长连接;侧边栏关闭→port 断开→content-script 失活
  const ACTIVATION_RETRY_DELAYS = [0, 160, 420, 900];
  async function activateActiveTab(showDialog) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    // v0.9.9: 切 tab 前先隐藏草稿恢复提示,避免上一标签的草稿态残留到新标签;
    //         新标签若有待恢复草稿,content-script 会在 activate 回调里重新广播显示。
    const drp = document.getElementById("draft-restore-prompt");
    if (drp) drp.hidden = true;
    // v0.8.1 顺序修复:先 activate → 连新 port → 最后断旧 port。
    // 旧顺序(先断旧 port)会让 content-script 的 onDisconnect→失活 异步晚到,误杀刚激活的状态
    // (激活确认窗被移除且不恢复 → 「点刷新按钮没反应」)。配合 content-script 的延迟失活双保险。
    const oldPort = _panelPort;
    // file:// 页的 content script 往往比 tab 的 complete 事件更晚就绪。过去只发一次 activate，
    // 这段短暂竞态会把页面永久留在“未激活”状态，选区自然不会显示评论工具栏。
    let csReady = false;
    for (const wait of ACTIVATION_RETRY_DELAYS) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        const active = await getActiveTab();
        if (!active || active.id !== tab.id) return; // 用户已切 tab，不激活旧页
        await chrome.tabs.sendMessage(tab.id, { type: "activate", showDialog: showDialog !== false });
        csReady = true;
        break;
      } catch (e) { /* content-script 尚未注入，继续短暂重试 */ }
    }
    // 静态注入失效时（如扩展刚更新但网页早已打开），主动补注入，无需用户刷新页面。
    if (!csReady) csReady = await recoverContentScript(tab, showDialog);
    // file:// 页若 content script 未就绪,几乎必是「允许访问文件网址」toggle 关了(Chrome 对所有扩展默认关)。
    syncFileAccessHint(tab, csReady);
    syncRefreshHint(tab, csReady);
    // #5: 建立长连接 —— 侧边栏关闭(页面销毁)→ Chrome 自动断开 port → content-script onDisconnect 失活
    if (csReady) { try { _panelPort = chrome.tabs.connect(tab.id, { name: "hg-panel" }); } catch (e) {} }
    if (oldPort && oldPort !== _panelPort) { try { oldPort.disconnect(); } catch (e) {} } // 切标签:最后再断旧 port
    return csReady;
  }
  // file:// 本地文件页:Chrome 默认禁止扩展访问(content script 不注入),需用户在 chrome://extensions
  // 手动开「允许访问文件网址」。检测到 file:// 页 CS 未就绪 → 显示提示;CS 就绪或非 file:// → 隐藏。
  function syncFileAccessHint(tab, csReady) {
    const el = document.getElementById("file-access-hint");
    if (!el) return;
    // 方案 A(v0.9.9):manifest 已加 "tabs" 权限 → chrome:// 新标签页等页面的 tab.url 现在可读,
    // 不再因 url 隐藏被误判成 file://(修「新标签页误显 hint」)。file:// 关「允许访问文件网址」时
    // Chrome 仍可能隐藏其 url → 兜底:加载完成却读不到 url 视同 file:// 未开权限,显示引导。
    const urlHidden = !!(tab && tab.id != null && !tab.url && tab.status === "complete");
    const isFileUrl = !!(tab && tab.url && /^file:/i.test(tab.url)) || urlHidden;
    el.hidden = !(isFileUrl && !csReady);
  }
  // 安装前已打开的标签:content-script 没注入 → activate 收不到回应,停在「正在连接」。
  // 触发条件:CS 未就绪 + 页面已加载完(不会自己好)+ 非 file://(交给文件访问提示)+ 非浏览器内部页(刷新无意义)。
  // 用户点「刷新页面」→ chrome.tabs.reload → onUpdated(complete) 重跑 activateActiveTab → CS 就绪 → 本提示自动隐藏。
  function syncRefreshHint(tab, csReady) {
    const el = document.getElementById("refresh-needed-hint");
    if (!el) return;
    if (csReady) { el.hidden = true; return; }                         // CS 已连上
    if (!tab || tab.status !== "complete") { el.hidden = true; return; } // 还在加载,先等
    const url = (tab && tab.url) || "";
    const urlHidden = !url && tab.id != null;
    if (/^file:/i.test(url) || urlHidden) { el.hidden = true; return; } // file:// 交给文件访问提示,不重复
    if (/^(chrome|edge|about|chrome-extension|view-source):/i.test(url)) { el.hidden = true; return; } // 浏览器内部页,刷新无意义
    el.hidden = false;                                                 // 已加载完 + 非 file + 非内部页 + CS 没来 = 安装前已打开
  }
  // #1: 心跳 —— 侧边栏在线时持续 ping 活动标签,content-script 超时未收到则自动失活(兜底)
  async function pingActiveTab() {
    const tab = await getActiveTab();
    if (tab && tab.id) { try { await chrome.tabs.sendMessage(tab.id, { type: "panel-ping" }); } catch (e) { /* 非关键 */ } }
  }

  // 收起侧边栏:立即断开 port(同步,触发活动标签失活)+ 广播 deactivate(兜底其他标签)
  function onPanelClosing() {
    if (_panelPort) { try { _panelPort.disconnect(); } catch (e) {} _panelPort = null; }
    try {
      chrome.tabs.query({}, (tabs) => {
        (tabs || []).forEach((tb) => {
          if (tb.id) { try { chrome.tabs.sendMessage(tb.id, { type: "deactivate" }); } catch (e) { /* 无 cs 则忽略 */ } }
        });
      });
    } catch (e) { /* 非关键 */ }
  }
  window.addEventListener("pagehide", onPanelClosing);
  window.addEventListener("beforeunload", onPanelClosing);

  // 接收 content-script 消息
  const _handledCommentRequests = new Set();
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "annotations-updated") {
      refreshAnnotations();
    } else if (msg.type === "presence") {
      renderPresence(msg.users);
    } else if (msg.type === "start-comment") {
      const requestId = String(msg.request_id || "");
      if (requestId && _handledCommentRequests.has(requestId)) {
        if (sendResponse) sendResponse({ ok: true, duplicate: true });
        return;
      }
      // issue 4:若正处于「整理评论/创建任务」流程(sheet 打开),草稿会被 sheet 盖住、用户无处输入 →
      // 不开草稿,改显示醒目提示,引导先返回收件箱。否则正常开草稿。
      if (_contractOpen) { showBlockNotice(); }
      else {
        // 账号/团队页会用 CSS 隐藏评论视图。收到页面上的评论动作时自动回到评论页，
        // 避免草稿已创建却完全不可见，表现成“Comment 没反应”。
        if (document.body.classList.contains("account-view-open")) exitAccountView();
        hideBlockNotice(); showDraft(msg.selector, msg.quote);
      }
      if (requestId) {
        _handledCommentRequests.add(requestId);
        if (_handledCommentRequests.size > 32) _handledCommentRequests.delete(_handledCommentRequests.values().next().value);
      }
      if (sendResponse) sendResponse({ ok: true, blocked: !!_contractOpen });
    } else if (msg.type === "edit-state") {
      // content-script 切换编辑态后同步按钮(确认窗「刷新」/ 手动「开始编辑」均经此)
      _editing = !!msg.editing;
      if (msg.isLocal !== undefined) isLocal = msg.isLocal;
      renderMode();
    } else if (msg.type === "artifact-reload-requested") {
      // 仅 content-script 的已验证 completion 会发此事件；这里不包含任何 Bridge/NM 调用。
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId) { _pendingArtifactReload = true; chrome.tabs.reload(tabId, { bypassCache: true }); }
    } else if (msg.type === "element-mode-changed") {
      _elementMode = !!msg.on; updateAdvModeBtn(); renderMode(); // v0.6 #11: 模式翻转 → 刷新 edit-tools/元素面板/编辑态显隐(退出高级模式后仍在编辑态)
    } else if (msg.type === "element-selected") {
      renderElementPanel(msg.info); // v0.6 M2: 渲染选中元素信息
    } else if (msg.type === "annotation-clicked") {
      // #4: 页面点高亮 → 切到评论 tab + 滚到卡片 + 聚焦回复输入
      switchTab("comment");
      // CORE-5:msg.id 来自消息,不拼进属性选择器(防 CSS 注入/转义歧义)→ 遍历卡片比对 dataset.id
      const _id = String(msg.id);
      const _cards = document.querySelectorAll(".card");
      let card = null;
      for (const c of _cards) { if (String(c.dataset.id) === _id) { card = c; break; } }
      const ann = (_lastItems || []).find((a) => a.id === msg.id);
      if (card && ann) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1400);
        doReply(ann, card);
      }
    } else if (msg.type === "format-state") {
      // v0.8 #5: 页面选区的 B/I/U/S 格式状态同步 —— 两个入口点亮态一致
      const st = msg.states || {};
      ["bold", "italic", "underline", "strike"].forEach((k) => {
        const b = document.getElementById("act-" + k);
        if (b) b.classList.toggle("active", !!st[k]);
      });
    } else if (msg.type === "toast") {
      // v0.8: content-script 侧的提示(如「请先在页面选中文字」)统一走 toast
      if (msg.text) showToast(msg.text);
    } else if (msg.type === "unsaved-state") {
      // v0.9.6: 草稿态同步 —— 有未提交快照时点亮保存按钮微标(保存后 content-script 会再广播 false)
      const d = document.getElementById("save-dot");
      if (d) d.hidden = !msg.unsaved;
    } else if (msg.type === "draft-restore-prompt") {
      // v0.9.9: 草稿恢复横幅迁入 Side Panel —— content-script 检测到待恢复草稿时广播显隐
      const p = document.getElementById("draft-restore-prompt");
      if (p) p.hidden = !msg.show;
    } else if (msg.type === "sync-fatal") {
      // R-12:SSE session 失效(取票 401/403,sync.js 已停止重连)→ 长显提示用户重新登录
      showToast(t("toast.sessionExpired"), 6000);
    }
  });

  let _editing = false;
  let _elementMode = false; // v0.6: 高级(元素)模式

  // 标准 alert 图标(success=对勾圆 / warning=三角感叹号),用经典控件不手画
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  // SSE 省流提示:协同账号下,当前页签的实时连接断开(后台页签超时/隐藏加载)时提示;
  // 切回该页签即自动重连对账,无需用户手动刷新。
  function renderSyncPausedHint(synced, sseLive) {
    const hint = document.getElementById("sync-paused-hint");
    if (hint) hint.hidden = !(synced && sseLive === false);
  }
  function renderMode() {
    const el = document.getElementById("mode-indicator");
    const btn = document.getElementById("edit-btn");
    btn.hidden = false;
    // 本地=绿(持久保存) / 远程=黄(临时,刷新丢失)
    el.className = "alert " + (isLocal ? "alert-success" : "alert-warning");
    const text = _editing
      ? (isLocal ? t("mode.editingLocal") : t("mode.editingRemote"))
      : (isLocal ? t("mode.idleLocal") : t("mode.idleRemote"));
    el.innerHTML = (isLocal ? ICON_OK : ICON_WARN) + "<span>" + esc(text) + "</span>";
    btn.textContent = _editing ? t("edit.exit") : t("edit.start");
    const tools = document.getElementById("edit-tools");
    if (tools) tools.hidden = !_editing || _elementMode; // 元素模式时让位给元素面板
    const bar = document.getElementById("edit-actions-bar");
    if (bar) bar.hidden = !_editing || _elementMode; // v0.9.6: 底部动作栏与工具区同步显隐
    const epanel = document.getElementById("element-panel");
    if (epanel) epanel.hidden = !_elementMode; // v0.6: 元素面板(M3 填内容)
    const adv = document.getElementById("adv-mode-btn");
    if (adv) adv.hidden = true; // v0.9.1:暂时隐藏「切换高级模式」入口(对用户较难懂);元素级编辑能力保留,恢复时改回 !_editing
    renderArtifactControls();
  }
  function renderArtifactControls() {
    // v0.9.1:artifact 信息行(本地 artifact · 文档 · 基线)与「重新读取文件」按钮已按需求移除。
    // content-script 自动重载流程(artifact-reload-requested → 刷新 → reload 结果提示)保留,不受影响。
  }
  function maybeShowReloadResult(items) {
    if (!_pendingArtifactReload) return;
    _pendingArtifactReload = false;
    const result = document.getElementById("artifact-reload-result");
    if (!result) return;
    const open = (items || []).filter((a) => a._status !== "stale").length;
    const stale = (items || []).filter((a) => a._status === "stale").length;
    result.textContent = t("artifact.reloaded").replace("{open}", open).replace("{stale}", stale);
    result.hidden = false;
  }
  // v0.6: 高级模式按钮文案/高亮 + 互斥显隐
  function updateAdvModeBtn() {
    const b = document.getElementById("adv-mode-btn");
    if (!b) return;
    b.textContent = t(_elementMode ? "adv.exit" : "adv.enter");
    b.classList.toggle("active", _elementMode);
    renderMode();
  }
  // v0.6 M6: 元素样式预设(fontFamily/letterSpacing/lineHeight/padding)
  const FONT_OPTS = [["sans-serif", "无衬线"], ["serif", "衬线"], ["monospace", "等宽"], ['"PingFang SC",sans-serif', "苹方"], ['"Microsoft YaHei",sans-serif', "微软雅黑"], ["Arial,sans-serif", "Arial"], ["Georgia,serif", "Georgia"]];
  const LS_OPTS = [["-0.02em", "紧凑"], ["0.05em", "略松"], ["0.1em", "宽松"], ["0.15em", "很宽"]];
  const LH_OPTS = [["1", "1.0"], ["1.3", "1.3"], ["1.5", "1.5"], ["1.7", "1.7"], ["2", "2.0"]];
  const PAD_OPTS = [["0", "0"], ["6px", "6"], ["12px", "12"], ["18px", "18"], ["24px", "24"]];
  // 规范化比较(浏览器会把 font-family 回读成 "PingFang SC", sans-serif 带空格,与 option 字符串不等 → 误显首项)
  function normStyle(v) { return String(v || "").split(",").map((s) => s.trim()).join(",").toLowerCase(); }
  function styleSelect(prop, label, opts, cur) {
    const c = normStyle(cur);
    const inPreset = opts.some((o) => normStyle(o[0]) === c);
    let oh = "";
    if (cur && !inPreset) oh += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>'; // 真实当前值(规范化后不在预设里)
    oh += opts.map((o) => '<option value="' + esc(o[0]) + '"' + (inPreset && normStyle(o[0]) === c ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("");
    return '<label class="ep-style"><span>' + esc(label) + '</span><select data-style="' + prop + '">' + oh + "</select></label>";
  }
  // v0.6 M7: Emoji 库
  const EMOJIS = ["😀","😄","😁","🙂","😊","😍","🤩","😘","😎","🤔","😐","😴","😭","😡","👍","👎","👌","✌️","🤝","👏","🙌","💪","🙏","💯","✅","❌","⭐","🔥","💡","❤️","🎉","🎊","🚀","✨","📌","📎","📷","📊","📈","🔑","⏰","📅","🌍","🎯","🏆","💰","📝","✏️","🔍","⚙️","🎨","🎵","📱","💻","🌐","🔗","💬","💭","⚠️","❓","❗","➕","➖","✖️","✔️"];
  function buildEmojiPanel() {
    const p = document.getElementById("emoji-panel");
    if (!p || p.dataset.built) return;
    p.dataset.built = "1";
    p.innerHTML = EMOJIS.map((e) => '<button class="emoji-i" type="button" data-e="' + e + '">' + e + "</button>").join("");
  }
  // v0.6 M2: 渲染选中元素信息到元素面板(M3 加操作按钮)
  function renderElementPanel(info) {
    const el = document.getElementById("element-panel");
    if (!el) return;
    if (!info) {
      el.innerHTML = '<div class="ep-hint">' + esc(t("adv.enter")) + '</div><div class="ep-sub">' + esc(t("ep.noSel")) + '</div>';
      return;
    }
    const cls = (info.classes || "").trim().split(/\s+/).filter(Boolean)
      .map((c) => '<code class="ep-c">.' + esc(c) + '</code>').join(" ");
    el.innerHTML =
      '<div class="ep-head"><code class="ep-tag">' + esc(info.tag) + (info.id ? '#' + esc(info.id) : '') + '</code>' +
      '<span class="ep-size">' + info.w + '×' + info.h + '</span>' +
      '<span class="ep-sib">' + (info.siblingIndex + 1) + '/' + info.siblingCount + '</span></div>' +
      (cls ? '<div class="ep-cls">' + cls + '</div>' : '') +
      (info.textPreview ? '<div class="ep-text">' + esc(info.textPreview) + '</div>' : '') +
      '<div class="ep-styles">' +
      styleSelect("fontFamily", t("style.font"), FONT_OPTS, (info.styles || {}).fontFamily) +
      styleSelect("letterSpacing", t("style.letter"), LS_OPTS, (info.styles || {}).letterSpacing) +
      styleSelect("lineHeight", t("style.line"), LH_OPTS, (info.styles || {}).lineHeight) +
      styleSelect("padding", t("style.padding"), PAD_OPTS, (info.styles || {}).padding) +
      '</div>' +
      '<div class="ep-acts"><button id="el-parent" class="ep-btn ep-ghost">↑ ' + esc(t("ep.parent")) + '</button>' +
      '<button id="el-textedit" class="ep-btn ep-ghost">' + esc(t("ep.editText")) + '</button>' +
      '<button id="el-dup" class="ep-btn">' + esc(t("ep.duplicate")) + '</button>' +
      '<button id="el-del" class="ep-btn ep-danger">' + esc(t("ep.delete")) + '</button></div>' +
      '<div class="ep-draghint">' + esc(t("ep.dragHint")) + '</div>';
  }

  let _othersSeenTracked = false; // others_comments_seen 会话级去重(面板文档每次打开重新加载,标志随之重置)
  function renderCards(items) {
    _lastItems = items || [];
    const c = document.getElementById("annotations");
    c.innerHTML = "";
    if (!items || items.length === 0) {
      c.innerHTML = '<div class="empty">' + esc(t("comment.empty")) + '</div>';
      updateCommentCount(0);
      return;
    }
    // 「看过别人的评论」代理指标:渲染列表里出现带作者且非本人的评论,每面板会话只报一次。
    // 无 author 的(本地未同步评论)不算;_sessionUser 尚未恢复时先不报,恢复后 renderCards 会被重调再报。
    if (!_othersSeenTracked) {
      const hasOthers = (items || []).some((a) => a && a.author && a.author.id && (!_sessionUser || a.author.id !== _sessionUser.id));
      if (hasOthers && _sessionUser) { _othersSeenTracked = true; HGAnalytics.track("others_comments_seen"); }
    }
    const openItems = items.filter((a) => a._status !== "stale");
    const staleItems = items.filter((a) => a._status === "stale");
    const byParent = {};
    openItems.forEach((a) => { const k = a.parent_id || null; (byParent[k] = byParent[k] || []).push(a); });
    function isOwnComment(ann, user) {
      return !!(user && user.id && ann.author && ann.author.id === user.id);
    }
    function authorInitial(name) {
      return Array.from(String(name || t("author.fallback")).trim())[0] || "?";
    }
    function buildCard(ann, depth, stale) {
      const card = document.createElement("div");
      card.className = "card" + (stale ? " stale" : "");
      card.dataset.id = ann.id; // #4: 页面点高亮跳转时定位卡片
      if (depth) card.style.marginLeft = (depth * 14) + "px";
      const quote = (ann.quote || "").slice(0, 60);
      const comment = (ann.body && ann.body.comment) || t("card.noComment");
      const authorName = (ann.author && ann.author.name) || t("author.fallback");
      const own = isOwnComment(ann, _sessionUser);
      card.innerHTML = '<div class="quote">' + esc(quote) + '</div>'
        + '<div class="card-author"><span class="card-avatar" aria-hidden="true">' + esc(authorInitial(authorName)) + '</span>'
        + '<span class="card-author-name">' + esc(authorName) + '</span>'
        + '<span class="card-author-self"' + (own ? "" : " hidden") + '>' + esc(t("author.you")) + '</span></div>'
        + '<div class="comment">' + linkify(comment) + '</div>'
        + (stale ? '<div class="stale-hint">' + esc(t("stale.hint")) + '</div>' : "");
      const acts = document.createElement("div");
      acts.className = "card-acts";
      if (!stale) {
        const reply = document.createElement("button");
        reply.textContent = t("card.reply"); reply.title = t("card.reply");
        reply.addEventListener("click", (e) => { e.stopPropagation(); doReply(ann, card); });
        acts.appendChild(reply);
        // v0.7.2:删除单卡片「生成任务」快捷入口(spec §4.2:避免两个心智模型);
        // 任务入口统一为评论列表底部「整理评论,创建编辑任务」。保留回复/编辑/删除/定位。
      }
      getCfg(["user", "mode"]).then((cfg) => {
        const me = cfg.user && cfg.user.id;
        const self = card.querySelector(".card-author-self");
        if (self) self.hidden = !isOwnComment(ann, cfg.user);
        // 本地批注属于这台浏览器的文档数据，不属于团队成员身份。登录/切换账号后仍必须
        // 可编辑和删除历史本地评论；只有真正的远程团队批注才按作者身份限制。
        if (isLocal || cfg.mode !== "synced" || (ann.author && ann.author.id === me)) {
          const edit = document.createElement("button");
          edit.textContent = t("card.edit"); edit.title = t("card.edit");
          edit.addEventListener("click", (e) => { e.stopPropagation(); doEdit(ann, card); });
          acts.appendChild(edit);
          const del = document.createElement("button");
          del.textContent = t("card.delete"); del.title = t("card.delete");
          del.addEventListener("click", (e) => { e.stopPropagation(); doDelete(ann, card); });
          acts.appendChild(del);
        }
      });
      card.appendChild(acts);
      card.addEventListener("click", () => sendToContent({ type: "scroll-to", id: ann.id }));
      return card;
    }
    function renderNode(ann, depth) {
      c.appendChild(buildCard(ann, depth, false));
      (byParent[ann.id] || []).forEach((ch) => renderNode(ch, depth + 1));
    }
    (byParent[null] || []).forEach((a) => renderNode(a, 0));
    // #3: 失效评论(原文已不在当前页面)置底独立分区展示
    if (staleItems.length) {
      const sec = document.createElement("div");
      sec.className = "stale-section";
      const head = document.createElement("div");
      head.className = "stale-head";
      head.innerHTML = esc(t("stale.section")) + ' <span class="stale-count">' + staleItems.length + '</span>';
      const purge = document.createElement("button");
      purge.className = "stale-purge";
      purge.textContent = t("stale.purge");
      purge.addEventListener("click", (e) => { e.stopPropagation(); purgeStale(staleItems); });
      head.appendChild(purge);
      sec.appendChild(head);
      staleItems.forEach((ann) => sec.appendChild(buildCard(ann, 0, true)));
      c.appendChild(sec);
    }
    updateCommentCount((byParent[null] || []).length);
    // v0.6.1:无未失效顶层批注时,底部「生成修改任务」disabled 且不打开空 Composer
    const _exportBtn = document.getElementById("export-btn");
    if (_exportBtn) _exportBtn.disabled = !((byParent[null] || []).length > 0);
    const _siteExportBtn = document.getElementById("site-export-btn");
    if (_siteExportBtn) _siteExportBtn.hidden = !!isLocal || !_sessionUser;
  }

  // #2: 一键删除所有失效评论(原文已不在当前页面)
  function purgeStale(items) {
    Promise.all(items.map((a) => sendToContent({ type: "delete-annotation", id: a.id }))).then(() => {
      sendToContent({ type: "get-annotations" }).then((resp) => {
        if (resp && resp.type === "annotations-list") { _editing = !!resp.editing; renderMode(); renderCards(resp.items); }
      });
    });
  }

  // === 新建批注:内联草稿块(替代浏览器 prompt)===
  function showDraft(selector, quote) {
    cancelDraft();
    switchTab("comment");
    _pendingSelector = { selector, quote };
    const host = document.getElementById("draft-host");
    const draft = document.createElement("div");
    draft.className = "draft-card";
    draft.innerHTML =
      '<div class="draft-label">' + esc(t("draft.label")) + '</div>' +
      '<div class="quote">' + esc((quote || "").slice(0, 80)) + '</div>' +
      '<textarea class="draft-input" placeholder="' + esc(t("draft.placeholder")) + '" rows="3"></textarea>' +
      '<div class="draft-acts"><button class="draft-cancel">' + esc(t("draft.cancel")) + '</button><button class="draft-save">' + esc(t("draft.save")) + '</button></div>';
    host.appendChild(draft);
    const ta = draft.querySelector(".draft-input");
    ta.classList.add("ready"); // 视觉「准备输入」脉冲提示(跨上下文聚焦受限时的可见线索)
    // 直接聚焦:若侧栏面板恰好处于活动状态,光标立即出现
    try { window.focus(); } catch (e) {}
    try { ta.focus(); } catch (e) {}
    // 跨上下文聚焦限制:页面点击触发的消息无法在侧栏合成「用户手势」,caret 常不亮。
    // 退而求其次——用户指针/焦点首次到达侧栏时,自动把光标落到草稿输入框(仅一次),交互更顺。
    const grabFocus = () => {
      try { if (document.activeElement !== ta) ta.focus(); } catch (e) {}
      ta.classList.remove("ready");
      window.removeEventListener("focus", grabFocus);
      document.removeEventListener("pointerdown", grabFocus, true);
    };
    window.addEventListener("focus", grabFocus);
    document.addEventListener("pointerdown", grabFocus, true);
    draft.querySelector(".draft-save").addEventListener("click", commitDraft);
    draft.querySelector(".draft-cancel").addEventListener("click", cancelDraft);
    ta.addEventListener("keydown", (e) => {
      // IME 组词(选字)中的回车只提交候选,不保存;再按一次回车(isComposing=false)才真正保存。
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commitDraft(); }
      if (e.key === "Escape") { e.preventDefault(); cancelDraft(); }
    });
  }

  async function commitDraft() {
    const draft = document.querySelector(".draft-card");
    if (!draft || !_pendingSelector) return;
    const save = draft.querySelector(".draft-save");
    if (save && save.disabled) return;
    const comment = draft.querySelector(".draft-input").value;
    const pending = _pendingSelector;
    if (save) { save.disabled = true; save.textContent = t("draft.saving"); }
    const response = await sendToContent({
      type: "commit-comment",
      selector: pending.selector,
      quote: pending.quote,
      comment: comment || "",
    });
    // 用户可能在网络等待期间又选了一段文字。旧请求的回包不得
    // 清除新草稿，只处理自己发起时对应的节点和 selector。
    if (!draft.isConnected || _pendingSelector !== pending) return;
    if (response && response.ok) {
      HGAnalytics.track("comment_create", { is_local: isLocal }); // 只计服务端/本地确认成功的根评论
      _pendingSelector = null;
      draft.remove();
      await refreshAnnotations();
      return;
    }
    if (save) { save.disabled = false; save.textContent = t("draft.save"); }
    showToast(t("toast.commentFail"));
  }

  function cancelDraft() {
    const draft = document.querySelector(".draft-card");
    if (draft) draft.remove();
    _pendingSelector = null;
  }

  // === 回复:卡片内联编辑器(替代浏览器 prompt)===
  function doReply(parent, card) {
    card.querySelectorAll(".reply-editor, .delete-confirm").forEach((e) => e.remove());
    document.querySelectorAll(".reply-editor").forEach((e) => e.remove()); // 关掉别处已开的
    const editor = document.createElement("div");
    editor.className = "reply-editor";
    editor.innerHTML =
      '<textarea placeholder="' + esc(t("reply.placeholder")) + '" rows="2"></textarea>' +
      '<div class="draft-acts"><button class="reply-cancel">' + esc(t("draft.cancel")) + '</button><button class="reply-save">' + esc(t("draft.save")) + '</button></div>';
    card.appendChild(editor);
    const ta = editor.querySelector("textarea");
    window.focus();
    ta.focus();
    const submit = () => {
      const save = editor.querySelector(".reply-save");
      if (save && save.disabled) return;
      if (save) save.disabled = true;
      sendToContent({ type: "reply", parentId: parent.id, comment: ta.value || "" }).then((resp) => {
        if (resp && resp.ok) {
          HGAnalytics.track("reply_create", { is_to_other: !!(parent.author && parent.author.id && _sessionUser && parent.author.id !== _sessionUser.id) });
          editor.remove(); refreshAnnotations(); return;
        }
        if (save) save.disabled = false;
        showToast(t("toast.replyFail"));
      });
    };
    editor.querySelector(".reply-save").addEventListener("click", submit);
    editor.querySelector(".reply-cancel").addEventListener("click", () => editor.remove());
    ta.addEventListener("keydown", (e) => {
      // IME 组词(选字)中的回车只提交候选,不保存;再按一次回车(isComposing=false)才真正保存。
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); editor.remove(); }
    });
  }

  // === #2: 编辑已保存评论(作者本人;镜像 doReply,textarea 预填现有内容,保存发 update-annotation)===
  function doEdit(ann, card) {
    card.querySelectorAll(".reply-editor, .delete-confirm").forEach((e) => e.remove());
    document.querySelectorAll(".reply-editor").forEach((e) => e.remove());
    const editor = document.createElement("div");
    editor.className = "reply-editor";
    editor.innerHTML =
      '<textarea placeholder="' + esc(t("reply.placeholder")) + '" rows="2"></textarea>' +
      '<div class="draft-acts"><button class="reply-cancel">' + esc(t("draft.cancel")) + '</button><button class="reply-save">' + esc(t("draft.save")) + '</button></div>';
    card.appendChild(editor);
    const ta = editor.querySelector("textarea");
    ta.value = (ann.body && ann.body.comment) || ""; // 预填
    window.focus();
    ta.focus();
    const submit = () => {
      sendToContent({ type: "update-annotation", id: ann.id, comment: ta.value || "" }).then((r) => {
        if (r && r.forbidden) { showToast(t("toast.editForbidden")); return; }
        // 显式重新拉取并重渲染(不依赖 broadcastUpdate,确保编辑后卡片立即刷新为新内容)
        sendToContent({ type: "get-annotations" }).then((resp) => {
          if (resp && resp.type === "annotations-list") { _editing = !!resp.editing; renderMode(); renderCards(resp.items); }
        });
      });
      editor.remove();
    };
    editor.querySelector(".reply-save").addEventListener("click", submit);
    editor.querySelector(".reply-cancel").addEventListener("click", () => editor.remove());
    ta.addEventListener("keydown", (e) => {
      // IME 组词(选字)中的回车只提交候选,不保存;再按一次回车(isComposing=false)才真正保存。
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); editor.remove(); }
    });
  }

  // === 删除:卡片内联确认(替代浏览器 confirm)===
  function doDelete(ann, card) {
    card.querySelectorAll(".reply-editor, .delete-confirm").forEach((e) => e.remove());
    const conf = document.createElement("div");
    conf.className = "delete-confirm";
    conf.innerHTML = '<span>' + esc(t("delete.confirm")) + '</span><button class="del-cancel">' + esc(t("delete.cancel")) + '</button><button class="del-ok">' + esc(t("delete.ok")) + '</button>';
    card.appendChild(conf);
    conf.querySelector(".del-ok").addEventListener("click", () => {
      sendToContent({ type: "delete-annotation", id: ann.id }).then((r) => {
        if (r && r.forbidden) showToast(t("toast.deleteForbidden"));
      });
      conf.remove();
    });
    conf.querySelector(".del-cancel").addEventListener("click", () => conf.remove());
  }

  function showToast(msg, duration) {
    let tl = document.querySelector(".toast");
    if (!tl) { tl = document.createElement("div"); tl.className = "toast"; document.body.appendChild(tl); }
    tl.textContent = msg;
    tl.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => tl.classList.remove("show"), duration || 2000);
  }
  // v0.9.7 按钮"已生效"反馈:文案短暂切到成功提示 + 成功色,让用户明确看到这一步成功了(复制/检查等)
  function flashBtn(btn, text, opts) {
    if (!btn) return;
    if (btn.dataset.hgOrig === undefined) btn.dataset.hgOrig = btn.textContent;
    if (text != null) btn.textContent = text;
    btn.classList.add("hg-flash-ok");
    clearTimeout(btn._hgFlash);
    btn._hgFlash = setTimeout(() => {
      btn.classList.remove("hg-flash-ok");
      if (btn.dataset.hgOrig !== undefined) btn.textContent = btn.dataset.hgOrig;
      delete btn.dataset.hgOrig;
    }, (opts && opts.ms) || 1600);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function linkify(text) {
    // CORE-6:从原文(esc 前)按 URL 切片,URL 段经 new URL() 白名单只放行 http(s);
    // 非 URL 段统一 esc 显示,href 属性单独 esc。避免「先 esc 再匹配」时 &amp;/&copy;
    // 等 HTML 实体在 href 中被浏览器二次解码而损坏链接。
    const raw = String(text == null ? "" : text);
    return raw.split(/(https?:\/\/[^\s<"'`]*)/).map((piece) => {
      if (/^https?:\/\//.test(piece)) {
        try {
          const u = new URL(piece);
          if (u.protocol === "http:" || u.protocol === "https:") {
            return '<a href="' + esc(piece) + '" target="_blank" rel="noopener noreferrer">' + esc(piece) + '</a>';
          }
        } catch (e) { /* 非法 URL → 当普通文本 */ }
      }
      return esc(piece);
    }).join("");
  }

  // === v0.8.1 创建编辑任务(状态机 spec §2/§4.1)===
  // step: closed | compose(选择修改范围,默认全选直达)| comment-scope(选择评论范围,高级入口)
  //       | plan-running | plan-review(确认修改计划)| candidate-running。
  // 临时草稿只存内存:关闭/Esc 清空;不写 annotation、chrome.storage 或 IndexedDB。
  // 每次派发均 session_mode=new;绝不续发 plan task,不接管用户外部会话。
  const contractSheet = document.getElementById("contract-sheet");
  const contractCloseBtn = document.getElementById("contract-close");
  const contractBrief = document.getElementById("contract-brief");
  const contractBriefError = document.getElementById("contract-brief-error");
  const contractPreserve = document.getElementById("contract-preserve");
  const contractCopyPrompt = document.getElementById("contract-copy-prompt");
  const contractFallback = document.getElementById("contract-output-fallback");
  const contractFallbackText = document.getElementById("contract-fallback-text");
  const contractBridge = document.getElementById("contract-bridge");
  const contractSendHint = document.getElementById("contract-send-hint");
  const contractBridgeStatus = document.getElementById("contract-bridge-status");
  // v0.9 Connection Center
  const connCenter = document.getElementById("conn-center");
  const connHead = document.getElementById("conn-head");
  const connTitle = document.getElementById("conn-title");
  const connDesc = document.getElementById("conn-desc");
  const connProviders = document.getElementById("conn-providers");
  const connPrimary = document.getElementById("conn-primary");
  const connSecondary = document.getElementById("conn-secondary");
  const connCheck = document.getElementById("conn-check");
  const connDiag = document.getElementById("conn-diag");
  const connHint = document.getElementById("conn-hint");
  const connChecking = document.getElementById("conn-checking");
  const connCheckingDots = document.getElementById("conn-checking-dots");
  const connCheckingElapsed = document.getElementById("conn-checking-elapsed");
  const connRepairConfirm = document.getElementById("conn-repair-confirm");
  const connRepairOk = document.getElementById("conn-repair-ok");
  const connRepairCancel = document.getElementById("conn-repair-cancel");
  const contractGotoRange = document.getElementById("contract-goto-range");
  const contractPlanBtn = document.getElementById("contract-plan");
  // comment-scope 步骤元素
  const selectSummary = document.getElementById("contract-select-summary");
  const selectManyWarning = document.getElementById("contract-many-warning");
  const selectList = document.getElementById("contract-select-list");
  const selectToggleAll = document.getElementById("contract-toggle-all");
  const contractRangeConfirm = document.getElementById("contract-range-confirm");
  // plan-review 步骤元素
  const planEditor = document.getElementById("plan-editor");
  const planRegenerate = document.getElementById("plan-regenerate");
  const planConfirmBtn = document.getElementById("plan-confirm");
  const planStaleHint = document.getElementById("plan-stale-hint");
  const planReviewAgent = document.getElementById("plan-review-agent");
  // v0.8.1 候选成功态:状态栏内的版本号 + 打开按钮(compose 内候选卡 / hash evidence / 返回源文件 已移除)
  const cbsCandidate = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-candidate");
  const cbsVersion = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-version");
  const cbsOpen = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-open");
  // 方向3 确定性编辑预览
  const patchPreview = document.getElementById("patch-preview");
  const patchBadge = document.getElementById("patch-badge");
  const patchEditList = document.getElementById("patch-edit-list");
  const patchConfirmBtn = document.getElementById("patch-confirm");
  const patchCancelBtn = document.getElementById("patch-cancel");
  const patchApplyModeRadios = document.querySelectorAll('input[name="patch-apply-mode"]');

  let _contractStep = "closed"; // closed | compose | comment-scope | plan-running | plan-review | candidate-running
  let _selectedNodeIds = new Set(); // 本轮勾选的节点 id(root+reply;真相源)
  let _contractRunKind = "candidate"; // candidate | plan(sidepanel 本次派发)
  let _contractRunId = null;          // 当前 sidepanel 跟踪的 run id(匹配 bridge-stream/完成事件)
  let _streamText = "";               // Agent 实时输出累积(agentMessage delta)
  let _lastFailed = null;             // 最近一次 bridge 失败(诊断上报用)
  let _candidateResult = null;      // 最近一次 candidate-ready 结果(只读成功态)
  let _candidateVersionLabel = null;  // 本文档候选版本号标签(来自 host "1.N" 字符串,如 "1.3")
  // v0.8.1 provider probe + plan-first 状态(spec §3.D/§5)
  // 展示默认值与实际已选 provider 必须分离：后者只能是已 ready 的 provider，
  // 否则会让发送按钮的可用性判断卡在未就绪状态。
  const DEFAULT_PROVIDER = "codex_app_server";
  let _provider = null;
  let _providerStates = {};         // { providerId: probe 记录 }
  let _providerCacheAt = 0;         // probe 缓存时间戳(ms);30s 内不重探
  // 默认 provider:优先 Codex(用户偏好),Codex 不可用则退第一个 ready。
  function _pickDefaultProvider() {
    if (_providerStates["codex_app_server"] && _providerStates["codex_app_server"].status === "ready") return "codex_app_server";
    return Object.keys(_providerStates).find((id) => _providerStates[id] && _providerStates[id].status === "ready") || null;
  }
  let _plan = null;                 // 已校验计划记录(bridge-plan-ready):{ plan_id, plan_sha256, plan_markdown, provider, source_artifact_uri, base_artifact_hash, task_sha256 }
  let _planStale = false;           // 计划后改 contract/artifact → true,阻止确认
  let _patchPending = null;         // 方向3:待确认的精确编辑预览 { run_id, edits, compliance }

  function countReplies(rootId, allItems) {
    const kids = {};
    (allItems || []).forEach((a) => { const p = a.parent_id || null; (kids[p] = kids[p] || []).push(a.id); });
    let n = 0; const stack = (kids[rootId] || []).slice();
    while (stack.length) { const id = stack.pop(); n += 1; (kids[id] || []).forEach((c) => stack.push(c)); }
    return n;
  }
  // parent→children 索引(原始顺序),供嵌套渲染与子树勾选
  function buildChildrenIndex(items) {
    const pos = new Map(); (items || []).forEach((a, i) => { if (a && a.id != null) pos.set(a.id, i); });
    const kids = new Map();
    (items || []).forEach((a) => { if (!a || a.id == null || !a.parent_id) return; const p = a.parent_id; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); });
    kids.forEach((arr) => arr.sort((x, y) => (pos.get(x.id) | 0) - (pos.get(y.id) | 0)));
    return kids;
  }
  // 所有 non-stale 节点 id(root+reply,原始顺序)
  function allNonStaleNodeIds(items) {
    return (items || []).filter((a) => a && a._status !== "stale" && a.id != null).map((a) => String(a.id));
  }
  // 节点及其全部后代 id(含自身)
  function descendantIds(id, kids) {
    const out = [String(id)]; const stack = (kids.get(id) || []).slice();
    while (stack.length) { const c = stack.pop(); out.push(String(c.id)); (kids.get(c.id) || []).forEach((x) => stack.push(x)); }
    return out;
  }
  // 已选 root(按 getRoots 原序,供 buildTask rootIds;§4.4 稳定)
  function orderedSelectedRootIds() {
    return window.ChangeContract.getRoots(_contractItems)
      .filter((a) => _selectedNodeIds.has(String(a.id))).map((a) => a.id);
  }
  // 已选且 non-stale 的节点数(用于计数行 M)
  function selectedNodeCount() {
    const nonStale = new Set(allNonStaleNodeIds(_contractItems));
    let n = 0; _selectedNodeIds.forEach((id) => { if (nonStale.has(id)) n++; });
    return n;
  }
  // v0.8.1:mode 直接 = 三档 scope 卡选中值(spec §3.B/§4.2)。不再有 restructure / 执行 seg 派生。
  function getContractMode() {
    const scope = document.querySelector('input[name="contract-scope"]:checked');
    const v = scope ? scope.value : "precise_patch";
    return ["precise_patch", "local_optimize", "regenerate"].includes(v) ? v : "precise_patch";
  }
  function getContractDraft() {
    return {
      mode: getContractMode(),
      rootIds: orderedSelectedRootIds(),
      selectedIds: Array.from(_selectedNodeIds), // 节点级选择:buildTask 据此裁剪未选回复
      brief: contractBrief.value,
      preserveText: contractPreserve.value,
      artifact: _contractArtifact || { title: "", url: "", isLocal: false }
    };
  }
  // 高级选项里「选择评论范围」链接的实时计数
  function renderRangeLink() {
    const total = allNonStaleNodeIds(_contractItems).length;
    const selected = selectedNodeCount();
    if (contractGotoRange) {
      contractGotoRange.textContent = t("compose.selectRangeCount")
        .replace("{selected}", String(selected)).replace("{total}", String(total));
    }
  }
  function refreshContractUI() {
    if (!_contractOpen) return;
    const draft = getContractDraft();
    if (contractCopyPrompt) contractCopyPrompt.textContent = t("contract.copyPrompt");
    if (contractCloseBtn) contractCloseBtn.setAttribute("aria-label", t("contract.close"));
    // scope 卡高亮兜底(:has 不支持的旧内核)
    document.querySelectorAll(".scope-card").forEach((c) => {
      const inp = c.querySelector("input"); c.classList.toggle("sel-fallback", !!(inp && inp.checked));
    });
    // brief 非必填(v0.8.1:三档 mode 均不强制 brief);隐藏旧错误
    if (contractBriefError) contractBriefError.hidden = true;
    const v = window.ChangeContract.validateDraft(draft, _contractItems);
    const disable = !v.ok;
    const lock = _contractRunning;
    // 发送组 + 计划按钮:仅本地 managed artifact 可用(spec §3.B/§3.E)
    const bridgeEligible = !!(_contractMeta && _contractMeta.isLocal && _contractMeta.logicalDocumentId && _contractMeta.loadedArtifactHash);
    const providerReady = !!(_provider && _providerStates[_provider] && _providerStates[_provider].status === "ready");
    const canDispatch = bridgeEligible && providerReady && !disable;
    if (contractBridge) {
      // 运行中:发送按钮 →「终止任务」(始终可点);否则恢复「发送给 {Agent}」
      if (lock) { contractBridge.textContent = t("bridge.abort"); contractBridge.disabled = false; contractBridge.classList.add("aborting"); }
      else {
        // 连接探测期间只用 Codex 作为展示 fallback；真正发起任务仍必须等 ready provider 被选中。
        const displayedProvider = _provider || DEFAULT_PROVIDER;
        contractBridge.textContent = t("bridge.sendTo").replace("{agent}", providerLabel(displayedProvider));
        contractBridge.disabled = !canDispatch;
        contractBridge.classList.remove("aborting");
      }
    }
    // v0.9.1:发送按钮因「非本地文档」置灰时给说明(远程网页 / 缺 artifact 不能直发;运行中不显示)。
    // 普通用户不易想到要切到本地文件,故显式提示;连接问题另有 Connection Center 与 ⌄ 教程,不在此重复。
    if (contractSendHint) contractSendHint.hidden = !(!lock && !bridgeEligible);
    // v0.8.1:「先给我看修改计划」前端先隐去(后端 plan 逻辑保留,待合适时机再细化);保持常 hidden
    if (contractPlanBtn) contractPlanBtn.hidden = true;
    if (contractCopyPrompt) contractCopyPrompt.disabled = false; // 复制 Prompt 始终可用(用户可随时复制去自己的会话)
    renderRangeLink();
    renderPlanConfirmState();
  }
  const PROVIDER_LABELS = { claude_code_cli: "Claude Code", codex_app_server: "Codex", github_copilot: "GitHub Copilot" };
  // v0.9.1:label 取自同源 provider 元数据的 label_key(随三语言切换);PROVIDER_LABELS 仅作降级兜底
  function providerLabel(id) {
    const d = (typeof ProviderMetadata !== "undefined") ? ProviderMetadata.getProviderDescriptor(id) : null;
    if (d) { const v = t(d.label_key); if (v && v !== d.label_key) return v; }
    return PROVIDER_LABELS[id] || "Claude Code";
  }
  // 重置契约表单(新一轮开始 / 关闭清空时)
  function resetContractForm() {
    const precise = document.querySelector('input[name="contract-scope"][value="precise_patch"]');
    if (precise) precise.checked = true;
    if (contractBrief) contractBrief.value = "";
    if (contractPreserve) contractPreserve.value = "";
    if (contractBriefError) contractBriefError.hidden = true;
    if (contractFallback) { contractFallback.hidden = true; }
    if (contractFallbackText) contractFallbackText.value = "";
    if (contractBridgeStatus) {
      contractBridgeStatus.hidden = true;
      contractBridgeStatus.className = "contract-bridge-status";
      const d = contractBridgeStatus.querySelector(".cbs-detail"); if (d) d.hidden = true;
      const tx = contractBridgeStatus.querySelector(".cbs-text"); if (tx) tx.textContent = "";
      const tm = contractBridgeStatus.querySelector(".cbs-timer"); if (tm) tm.textContent = "";
    }
    if (cbsCandidate) cbsCandidate.hidden = true;
    _candidateResult = null;
    stopRunTimer(); resetRunEvents();
    _plan = null; _planStale = false;
  }
  function showContractSheet() {
    exitAccountView();
    closeLangSheet();
    // 契约流程是 Header 下的独占内容视图：Header 保留，Tab 与两块主内容退出布局。
    document.body.classList.add("contract-open");
    contractSheet.hidden = false;
    contractSheet.classList.add("show");
  }
  // 流程中禁止新建评论的醒目提示(issue 4)
  function showBlockNotice() {
    const n = document.getElementById("contract-block-notice");
    if (n) n.hidden = false;
  }
  function hideBlockNotice() {
    const n = document.getElementById("contract-block-notice");
    if (n) n.hidden = true;
  }
  // v0.8.1 入口:默认全选所有 non-stale 节点(root+reply)→ 直达 compose(选择修改范围)+ 探测 provider
  function openContract(roots, items, artifact, meta) {
    _contractItems = items || [];
    _contractArtifact = artifact || { title: "", url: "", isLocal: false };
    _contractMeta = meta || { isLocal: !!(artifact && artifact.isLocal), logicalDocumentId: null, loadedArtifactHash: null };
    _selectedNodeIds = new Set(allNonStaleNodeIds(items)); // 默认全选(含回复)
    // 注意:不在此处置 _contractRunning=false。若后台仍有活动 run(用户关掉契约页又重进),
    // 由 syncRunStateFromBackground 据实同步 —— 在跑就保持「终止任务」态,避免误显示可发送。
    // provider 状态是机器级(不随页面/标签变化),不再每次开契约清空:切到新标签页(如新生成的 candidate)
    // 打开契约时若清空 _providerStates,要等异步 probe/queryHealth(~2-3s)回来才重新可用,期间发送按钮
    // 置灰,用户误以为没连上。保留上一轮/上一页状态 → 按钮立即可用;新鲜度由 queryProviders(true) 与
    // queryHealth()(其会同步 health.providers 进 _providerStates)在后台保证。
    _plan = null; _planStale = false;
    _contractOpen = true;
    resetContractForm();
    hideBlockNotice();
    setContractStep("compose");
    showContractSheet();
    queryProviders(true); // 打开即 probe(spec §3.D);30s 内不重探
    // v0.9 Connection Center:连接状态并行检查(无副作用);重置折叠/health
    _health = null; _connCollapsed = null;
    queryHealth();
    fetchBootstrap().then(() => renderConnCenter());
    getActiveTab().then((tab) => {
      if (!tab || !tab.id) return;
      loadCandidateEvidence(tab.id); // §6 持久证据
      syncRunStateFromBackground(tab.id); // 同 tab 重进:据后台活动 run 还原运行态(终止按钮/计时器/进度窗)
    });
    loadRunHistory(); // 预载最近 3 次任务历史(展开状态栏时立即可见)
    HGAnalytics.track("task_open", { scope: getContractMode() });
  }
  // 据后台活动 run 同步 _contractRunning:在跑 → 终止态 + 计时器 + 进度窗;不在跑 → 可发送态。
  // 修「同 tab 关掉契约页又重进,按钮误显示可发送(但 run 仍在跑)」。
  async function syncRunStateFromBackground(tabId) {
    if (!tabId) return;
    const resp = await chrome.runtime.sendMessage({ type: "bridge-query-active-run", tab_id: tabId }).catch(() => null);
    // CORE-4(v0.9.9):await 期间用户可能已切 tab —— 不再把 A tab 的运行态错写到 B tab(镜像 refreshAnnotations 的 stillActive 守卫)
    if (currentTabId !== tabId) return;
    if (resp && resp.active) {
      _contractRunning = true;
      if (resp.run_id) _contractRunId = resp.run_id;
      if (resp.run_kind) _contractRunKind = resp.run_kind;
      setContractRunning(true); // 显示「终止任务」+ 禁用输入
      const agent = providerLabel(resp.provider || _provider);
      const isPlan = _contractRunKind === "plan";
      setBridgeStatus((isPlan ? t("bridge.planRunning") : t("bridge.candidateRunning")).replace("{agent}", agent), "running");
      startRunTimer();
      expandBridgeDetail(true);
    } else {
      _contractRunning = false;
      setContractRunning(false);
    }
  }
  // 步骤切换:show/hide 三个 step 面板 + data-step
  function setContractStep(step) {
    _contractStep = step;
    contractSheet.dataset.step = step;
    const steps = ["compose", "comment-scope", "plan-review"];
    const map = { compose: "contract-step-compose", "comment-scope": "contract-step-comment-scope", "plan-review": "contract-step-plan-review" };
    steps.forEach((s) => { const el = document.getElementById(map[s]); if (el) el.hidden = (s !== step); });
    if (step === "compose") refreshContractUI();
    if (step === "comment-scope") renderCommentScope();
    if (step === "plan-review") renderPlanReview();
  }
  // comment-scope:嵌套回复树,每个节点(root+reply)一个 checkbox;整卡可点;子树随父勾选(spec §3.C)
  function renderCommentScope() {
    const items = _contractItems;
    const kids = buildChildrenIndex(items);
    const roots = window.ChangeContract.getRoots(items);
    const total = allNonStaleNodeIds(items).length;
    if (selectManyWarning) selectManyWarning.hidden = !(total > 20);
    if (selectList) {
      const renderNode = (a, depth) => {
        const id = String(a.id);
        const checked = _selectedNodeIds.has(id);
        const isRoot = !a.parent_id;
        let h = '<label class="select-card' + (checked ? " selected" : "") + (isRoot ? "" : " reply") + '" data-id="' + esc(id) + '" style="margin-left:' + (depth * 16) + 'px">'
          + '<input type="checkbox"' + (checked ? " checked" : "") + '>'
          + '<span class="select-body">'
          + '<div class="quote">' + esc((a.quote || "").slice(0, 60)) + "</div>"
          + '<div class="select-text">' + linkify((a.body && a.body.comment) || "") + "</div>"
          + "</span></label>";
        (kids.get(a.id) || []).filter((c) => c._status !== "stale").forEach((c) => { h += renderNode(c, depth + 1); });
        return h;
      };
      selectList.innerHTML = roots.map((r) => renderNode(r, 0)).join("");
    }
    refreshRangeCounts();
  }
  // comment-scope 计数行 + 确认按钮(M=0 禁用 + 动态文案)+ 全选/取消全选切换
  function refreshRangeCounts() {
    const m = selectedNodeCount();
    const total = allNonStaleNodeIds(_contractItems).length;
    if (selectSummary) {
      selectSummary.innerHTML = t("range.summary")
        .replace("{total}", "<strong>" + total + "</strong>")
        .replace("{selected}", "<strong>" + m + "</strong>");
    }
    if (contractRangeConfirm) {
      contractRangeConfirm.disabled = m === 0;
      contractRangeConfirm.textContent = t("range.confirm").replace("{selected}", String(m)).replace("{total}", String(total));
    }
    if (selectToggleAll) {
      selectToggleAll.textContent = (m === total && total > 0) ? t("range.deselectAll") : t("range.selectAll");
    }
  }
  // close / Esc → A:丢弃本轮 selectedRootIds 与 form draft(spec §2/§4.1)
  function closeContract() {
    _health = null; _connCollapsed = null;
    if (connCenter) connCenter.hidden = true;
    _contractOpen = false;
    _contractStep = "closed";
    _selectedNodeIds = new Set(); // 清空临时 Set
    resetContractForm();                  // 清空表单 → 再次进入恢复默认全选 + 空表单(spec §6.8)
    document.body.classList.remove("contract-open");
    contractSheet.classList.remove("show");
    contractSheet.hidden = true;
    const el = _contractTriggerEl;
    _contractTriggerEl = null;
    if (el && el.focus) { try { el.focus(); } catch (e) {} }
  }
  // v0.8.1:候选成功态展示在状态栏(版本号 + 打开按钮)。compose 内候选卡 / hash evidence / 返回源文件 已移除。
  function showCandidateResult(msg) {
    _candidateResult = msg || null;
    if (msg && msg.version_label) _candidateVersionLabel = String(msg.version_label);
    renderCandidateIndicator();
  }
  function renderCandidateIndicator() {
    if (!cbsCandidate) return;
    const ready = !!_candidateResult;
    cbsCandidate.hidden = !ready;
    if (ready && cbsVersion) {
      cbsVersion.textContent = t("candidate.versionReady").replace("{n}", _candidateVersionLabel || "1.1");
    }
    if (ready && contractBridgeStatus) contractBridgeStatus.hidden = false;
  }
  // 刷新 Side Panel 后:预载本文档最近候选的版本号标签(不强制弹状态栏;仅完成后展示用)
  async function loadCandidateEvidence(tabId) {
    const r = await chrome.runtime.sendMessage({ type: "bridge-query-latest-candidate", tab_id: tabId }).catch(() => null);
    if (r && r.run && r.run.version_label) _candidateVersionLabel = String(r.run.version_label);
  }
  function showContractFallback(out) {
    contractFallback.hidden = false;
    contractFallbackText.value = out;
    try { contractFallbackText.focus(); contractFallbackText.select(); } catch (e) {}
    showToast(t("contract.copyFail"));
  }
  // spec §4.3 提交前防线:重取最新 export,若已选评论在此期间 stale/删除 → 可理解错误 + 回 B 刷新,
  // 绝不拿旧快照发送。返回 true=可继续提交;false=已拦截并回到 B。
  async function refreshSelectionBeforeSubmit() {
    const resp = await sendToContent({ type: "get-export" });
    if (!resp || resp.type !== "export-data") return true; // 拿不到最新数据时沿用本轮快照,不阻塞
    const items = resp.items || [];
    const validIds = new Set(allNonStaleNodeIds(items)); // root+reply 均参与 stale 判定
    const staleSelected = Array.from(_selectedNodeIds).filter((id) => !validIds.has(id));
    // 无论是否有 stale,都用最新数据刷新本轮快照(评论内容/回复可能已更新)
    _contractItems = items;
    _contractArtifact = resp.artifact || _contractArtifact;
    _contractMeta = bridgeMeta(resp);
    if (staleSelected.length) {
      staleSelected.forEach((id) => _selectedNodeIds.delete(id));
      showToast(t("taskSelect.staleChanged"));
      setContractStep("comment-scope");
      return false;
    }
    checkPlanStale(); // 评论/artifact 变化可能使已生成计划失效(spec §3.E.9)
    return true;
  }
  // 复制 Prompt(spec §4.3):renderPrompt 反映当前三档 mode + 已选评论 + brief + preserve。不需要 provider ready。
  async function copyContract() {
    if (!(await refreshSelectionBeforeSubmit())) return;
    const draft = getContractDraft();
    let task;
    try { task = window.ChangeContract.buildTask(draft, _contractItems); }
    catch (e) { showToast(t("contract.copyFail")); return; }
    const out = window.ChangeContract.renderPrompt(task);
    const btn = contractCopyPrompt;
    const orig = btn ? btn.innerHTML : "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(out).then(() => {
        if (btn) btn.innerHTML = esc(t("contract.copied")); // v0.9.8 反馈靠按钮"已复制 ✓"状态(不用 toast,避免遮挡底部按钮)
        setTimeout(() => { if (btn) btn.innerHTML = orig; }, 1500);
      }).catch(() => showContractFallback(out));
    } else {
      showContractFallback(out);
    }
  }

  // === v0.7 Codex Local Bridge 辅助 ===
  function bridgeMeta(resp) {
    return {
      isLocal: !!(resp && resp.artifact && resp.artifact.isLocal),
      logicalDocumentId: (resp && resp.logicalDocumentId) || (resp && resp.artifact_state && resp.artifact_state.logical_document_id) || null,
      loadedArtifactHash: (resp && resp.loadedArtifactHash) || (resp && resp.artifact_state && resp.artifact_state.loaded_artifact_hash) || null
    };
  }
  // v0.8.1 provider probe(spec §3.D/§5.1):bridge-query-providers → 30s 缓存 → 渲染菜单状态。
  function queryProviders(force) {
    if (!force && _providerCacheAt && (Date.now() - _providerCacheAt < 30000) && Object.keys(_providerStates).length) {
      renderProviderMenu(); refreshContractUI(); return;
    }
    chrome.runtime.sendMessage({ type: "bridge-query-providers" }).then((r) => {
      if (!r || !r.ok) return;
      _providerStates = {};
      (r.providers || []).forEach((p) => { _providerStates[p.id] = p; });
      _providerCacheAt = Date.now();
      // 恢复上次选择(仅 ready),否则选第一个 ready
      if (!_provider || !(_providerStates[_provider] && _providerStates[_provider].status === "ready")) {
        _provider = _pickDefaultProvider();
      }
      if (_contractOpen) { renderProviderMenu(); refreshContractUI(); }
    }).catch(() => {});
  }
  // v0.8.2:Copilot 的 runtime 摘要(host probe 返回的 runtime 枚举 → 三语标签;退化用 host 的 runtime_label,≤64 已在 sanitize 把关)
  function providerRuntimeNote(p) {
    if (!p) return null;
    if (p.runtime === "local_cli") return t("provider.copilotLocalCli");
    if (p.runtime === "bundled_sdk_cli") return t("provider.copilotSdkRuntime");
    return (typeof p.runtime_label === "string" && p.runtime_label) ? p.runtime_label : null;
  }
  function providerStatusText(p) {
    if (!p) return t("provider.checking");
    const s = p.status;
    if (s === "ready") {
      const rn = providerRuntimeNote(p);
      if (rn) return t("provider.ready") + " · " + rn;
      return p.version ? (t("provider.ready") + " · " + p.version) : t("provider.ready");
    }
    if (s === "checking") return t("provider.checking");
    if (s === "not_installed" || s === "not_found") return t("provider.notInstalled");
    if (s === "auth_required") {
      const rn = providerRuntimeNote(p);
      return rn ? (t("provider.authRequired") + " · " + rn) : t("provider.authRequired");
    }
    if (s === "incompatible" || s === "untrusted") return t("provider.incompatible");
    return t("provider.error");
  }
  function renderProviderMenu() {
    document.querySelectorAll(".send-menu .agent").forEach((btn) => {
      const id = btn.dataset.provider;
      const p = _providerStates[id];
      const ready = !!(p && p.status === "ready");
      const inUse = ready && id === _provider;
      btn.classList.toggle("active", inUse);
      btn.disabled = !ready;
      const dot = btn.querySelector(".agent-dot");
      // 默认检查连接期间(!p 或 status=checking):dot 转圈,文案「正在连接」
      let dotCls = "agent-dot";
      if (ready) dotCls += inUse ? " ready in-use" : " ready";
      else if (p && p.status === "auth_required") dotCls += " warn";
      else if (!p || p.status === "checking") dotCls += " checking";
      if (dot) dot.className = dotCls;
      const note = btn.querySelector(".agent-note");
      if (note) note.textContent = providerStatusText(p);
      // 右侧 chip:使用中(当前激活) / 切换(已连接未激活,提示整行可点切换) / 未连接不显示
      const chip = btn.querySelector(".agent-chip");
      if (chip) {
        if (inUse) { chip.hidden = false; chip.className = "agent-chip in-use"; chip.textContent = t("provider.inUse"); }
        else if (ready) { chip.hidden = false; chip.className = "agent-chip switch"; chip.textContent = t("provider.switch"); }
        else { chip.hidden = true; chip.className = "agent-chip"; chip.textContent = ""; }
      }
    });
    renderSendSetup();
  }
  // v0.9.1:下箭头弹窗内嵌「未连接」教程。没有任何 ready provider 时显示一条 npx 安装命令(取自 bootstrap,
  // 已带真实扩展 ID);有任一 ready 即隐藏。命令缺失时按需拉 bootstrap。复制走 connCopy + 按钮就地反馈。
  function renderSendSetup() {
    const box = document.getElementById("contract-send-setup");
    if (!box) return;
    let readyCount = 0;
    for (const id in _providerStates) { if (_providerStates[id] && _providerStates[id].status === "ready") readyCount++; }
    if (readyCount > 0) { box.hidden = true; return; }
    box.hidden = false;
    const cmdEl = document.getElementById("contract-send-setup-cmd");
    if (!cmdEl) return;
    const cmd = (_bootstrap && _bootstrap.terminal_command) || "";
    if (cmd) { cmdEl.textContent = cmd; return; }
    if (!cmdEl.textContent) {
      fetchBootstrap().then(() => {
        if (_bootstrap && _bootstrap.terminal_command) cmdEl.textContent = _bootstrap.terminal_command;
      });
    }
  }
  function selectProvider(id) {
    const p = _providerStates[id];
    if (!p || p.status !== "ready") return; // 仅 ready 可选
    _provider = id;
    renderProviderMenu();
    refreshContractUI();
  }

  // === v0.9 Connection Center(§5):health 驱动的连接状态与用户级初始化入口 ===
  // health 只认 reason_code/枚举,不解析文本;任何状态都保留「复制 Prompt」降级路径(§0.2)。
  let _health = null;            // bridge-query-health 结果(§3.4 脱敏契约)
  let _connCollapsed = null;     // null=按状态自动;true/false=用户手动覆盖
  let _bootstrap = null;         // bridge-get-bootstrap 缓存(纯本地模板)
  let _connHintTimer = null;
  let _connPermanentHint = "";

  const CONN_REASON_TEXT = {
    CLAUDE_NOT_INSTALLED: "conn.status.claudeNotInstalled",
    CLAUDE_AUTH_REQUIRED: "conn.status.claudeAuth",
    CODEX_APP_NOT_FOUND: "conn.status.codexNotFound",
    CODEX_APP_UNTRUSTED: "conn.status.codexIncompatible",
    CODEX_APP_INCOMPATIBLE: "conn.status.codexIncompatible",
    CODEX_AUTH_REQUIRED: "conn.status.codexAuth",
    COPILOT_RUNTIME_NOT_FOUND: "conn.status.copilotNotFound",
    COPILOT_AUTH_REQUIRED: "conn.status.copilotAuth",
    COPILOT_RUNTIME_INCOMPATIBLE: "conn.status.copilotIncompatible",
    PROVIDER_PROBE_FAILED: "conn.status.probeFailed",
    PROVIDER_POLICY_BLOCKED: "conn.status.probeFailed"
  };

  // v0.9.4:检查中动态计时——循环省略号 + 已用 Ns,避免用户以为卡住
  let _connCheckTimer = null, _connCheckStart = 0, _connCheckDotIdx = 0;
  const _CONN_CHECK_DOTS = ["", ".", "..", "..."];
  function _renderConnChecking() {
    const s = Math.max(0, Math.round((Date.now() - _connCheckStart) / 1000));
    if (connCheckingElapsed) connCheckingElapsed.textContent = t("conn.checkingElapsed").replace("{n}", String(s));
    if (connCheckingDots) connCheckingDots.textContent = _CONN_CHECK_DOTS[_connCheckDotIdx++ % _CONN_CHECK_DOTS.length];
  }
  function startConnChecking() {
    if (connChecking) connChecking.hidden = false;
    _connCheckStart = Date.now(); _connCheckDotIdx = 0;
    _renderConnChecking();
    if (_connCheckTimer) clearInterval(_connCheckTimer);
    _connCheckTimer = setInterval(_renderConnChecking, 400);
  }
  function stopConnChecking() {
    if (_connCheckTimer) { clearInterval(_connCheckTimer); _connCheckTimer = null; }
    if (connChecking) connChecking.hidden = true;
  }
  async function queryHealth() {
    if (!_contractOpen) return;
    if (connCenter) connCenter.hidden = false;
    if (connTitle) connTitle.textContent = t("conn.titleChecking");
    startConnChecking();
    try {
      const resp = await chrome.runtime.sendMessage({ type: "bridge-query-health" }).catch(() => null);
      _health = (resp && resp.health) ? resp.health : null;
    } finally {
      stopConnChecking();
    }
    // v0.9.4:检查连接成功后,立即把 health.providers 同步进 _providerStates 并重渲染发送菜单。
    // 发送菜单的 Agent 选择器读 _providerStates(由独立的 provider_probe 流填充,30s 缓存),与 _health
    // (bridge_health)是两条往返;不同步则点完「检查连接」Agent 选择器仍显示旧状态,用户看不出已连接
    // (要等 provider_probe 异步完成才更新,体感像"没连上")。两者同源(host 的 probeProviders),状态等价。
    if (_health && Array.isArray(_health.providers)) {
      _providerStates = {};
      _health.providers.forEach((p) => { if (p && p.id) _providerStates[p.id] = p; });
      _providerCacheAt = Date.now();
      if (!_provider || !(_providerStates[_provider] && _providerStates[_provider].status === "ready")) {
        _provider = _pickDefaultProvider();
      }
      renderProviderMenu();
      refreshContractUI();
    }
    renderConnCenter();
  }
  async function fetchBootstrap() {
    if (_bootstrap) return _bootstrap;
    const resp = await chrome.runtime.sendMessage({ type: "bridge-get-bootstrap" }).catch(() => null);
    if (resp && resp.ok && resp.bootstrap) _bootstrap = resp.bootstrap;
    return _bootstrap;
  }
  function connCopy(text, hintKey, btn) {
    if (!text) return;
    const done = () => {
      connSetHint(t(hintKey), "ok"); // #conn-hint 已移除 → 空操作
      if (btn) flashBtn(btn, t("bridge.copied")); // v0.9.8 反馈靠按钮"已复制 ✓"状态变化(不再用 toast,避免遮挡底部按钮)
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done();
      } catch (e) { /* 非关键 */ }
    }
  }
  function connSetPermanent(text) {
    _connPermanentHint = text || "";
    if (connHint && (!connHint.dataset.temp || connHint.hidden)) {
      connHint.textContent = _connPermanentHint;
      connHint.className = "conn-hint" + (_connPermanentHint ? " warn" : "");
      connHint.hidden = !_connPermanentHint;
    }
  }
  function connSetHint(text, cls) {
    if (!connHint) return;
    connHint.dataset.temp = "1";
    connHint.textContent = text || "";
    connHint.className = "conn-hint" + (cls ? " " + cls : "");
    connHint.hidden = !text;
    if (_connHintTimer) clearTimeout(_connHintTimer);
    _connHintTimer = setTimeout(() => {
      delete connHint.dataset.temp;
      connHint.textContent = _connPermanentHint;
      connHint.className = "conn-hint" + (_connPermanentHint ? " warn" : "");
      connHint.hidden = !_connPermanentHint;
    }, 5000);
  }
  function connProviderStatusText(p) {
    if (p && p.status === "ready") return t("conn.status.ready");
    const key = p && CONN_REASON_TEXT[p.reason_code];
    return key ? t(key) : t("conn.status.probeFailed");
  }
  function connProviderStatusClass(p) {
    if (p && p.status === "ready") return "ready";
    if (p && (p.status === "auth_required" || p.status === "not_installed")) return "warn";
    return "err";
  }
  function renderConnProviders(list) {
    if (!connProviders) return;
    connProviders.innerHTML = "";
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) { connProviders.hidden = true; return; }
    for (const p of arr) {
      const li = document.createElement("li");
      const b = document.createElement("b"); b.textContent = providerLabel(p.id);
      const st = document.createElement("span");
      st.className = "conn-pstatus " + connProviderStatusClass(p);
      st.textContent = connProviderStatusText(p);
      li.appendChild(b); li.appendChild(st);
      if (p.status !== "ready") {
        const a = document.createElement("a");
        a.className = "conn-guide"; a.target = "_blank"; a.rel = "noopener";
        a.href = "https://www.deuce.monster/htmlgenius/agents.html";
        a.textContent = t("conn.agentsGuide");
        li.appendChild(a);
      }
      connProviders.appendChild(li);
    }
    connProviders.hidden = false;
  }
  function setConnButton(btn, label, action) {
    if (!btn) return;
    if (!label) { btn.hidden = true; btn.dataset.action = ""; return; }
    btn.hidden = false; btn.textContent = label; btn.dataset.action = action || "";
  }
  function connAutoCollapsed(h) {
    // v0.9.1:Connection Center 默认收起(无论是否已连接),用户点标题手动展开;与 connStateFor 的默认折叠基准一致。
    return true;
  }
  // §5.2 状态矩阵 → 由纯函数 ConnectionCenterState.connStateFor 驱动(v0.9.1 §9.1,可 node:test 验证)
  // 语义版本比较(a<b→负,==0,>正);只比数字段。
  function _cmpVer(a, b) {
    const pa = String(a || "").split("."), pb = String(b || "").split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
      if (x !== y) return x - y;
    }
    return 0;
  }
  function renderConnCenter() {
    if (!connCenter) return;
    if (!_contractOpen) { connCenter.hidden = true; return; }
    connCenter.hidden = false;
    if (connRepairConfirm) connRepairConfirm.hidden = true;
    const st = ConnectionCenterState.connStateFor(_health, {
      userCollapsed: _connCollapsed,
      devOnly: !!(_bootstrap && _bootstrap.dev_only)
    });
    // Bridge 升级提醒:host bridge 版本 < 目标版本(TARGET_BRIDGE_VERSION,经 _bootstrap.bridge_version 传回)。
    // 有新版时:① 钉住展开 —— 覆盖 ready 态的自动折叠(connStateFor ready→collapsed=true),否则升级按钮被折进
    //            display:none 的 body 里、点完「检查连接」就消失;仅在用户未手动折叠过时钉住(尊重用户显式收起)。
    //         ② 常驻提示 + 露出「复制命令行指令升级」按钮(文案与安装态的「复制 Terminal 命令」区分)。
    // 未连接态(install_required / repair_required)由 connStateFor 自身露出「复制 Terminal 命令」,不在此覆盖。
    const _hostVer = (_health && _health.bridge && _health.bridge.version) || null;
    const _targetVer = (_bootstrap && _bootstrap.bridge_version) || null;
    const _upgrade = !!(_hostVer && _targetVer && _cmpVer(_hostVer, _targetVer) < 0);
    const _collapsed = (_upgrade && _connCollapsed === null) ? false : st.collapsed;
    connCenter.className = "conn-center" + (st.cls ? " " + st.cls : "") + (connHead && _collapsed ? " collapsed" : "");
    if (connHead) connHead.setAttribute("aria-expanded", String(!_collapsed));
    if (connTitle) {
      connTitle.textContent = (st.titleKey === "conn.titleConnected")
        ? t(st.titleKey).replace("{n}", String(st.readyCount || 0))
        : t(st.titleKey);
    }
    // Provider status is already rendered once in the send list. Repeating it in
    // Connection Center makes the menu look like two competing Agent pickers.
    renderConnProviders([]);
    setConnButton(connPrimary, st.primary ? t(st.primary.labelKey) : null, st.primary ? st.primary.action : null);
    setConnButton(connSecondary, st.secondary ? t(st.secondary.labelKey) : null, st.secondary ? st.secondary.action : null);
    let hint = st.permanentHintKey ? t(st.permanentHintKey) : "";
    if (hint && st.devOnly) hint += " " + t("conn.devOnly");
    connSetPermanent(hint);
    if (_upgrade) {
      connSetPermanent(t("conn.bridgeUpdate").replace("{v}", _targetVer));
      setConnButton(connSecondary, t("conn.copyTerminalUpgrade"), "terminal");
    }
  }
  async function connDo(action, btn) {
    if (!action) return;
    if (action === "check") {
      if (connCheck) { connCheck.disabled = true; if (connCheck.dataset.hgOrig === undefined) connCheck.dataset.hgOrig = connCheck.textContent; connCheck.textContent = t("btn.checking"); }
      if (connPrimary && connPrimary.dataset.action === "check") connPrimary.disabled = true;
      await queryHealth();
      if (connPrimary) connPrimary.disabled = false;
      if (connCheck) { connCheck.disabled = false; flashBtn(connCheck, t("btn.checked")); }
      return;
    }
    if (action === "setup" || action === "terminal") {
      const b = await fetchBootstrap();
      if (!b) return;
      if (action === "setup") connCopy(b.setup_prompt, "conn.setupCopied", btn);
      else connCopy(b.terminal_command, "conn.terminalCopied", btn);
      renderConnCenter(); // dev_only 标注
      return;
    }
    if (action === "repair") {
      if (connRepairConfirm) connRepairConfirm.hidden = false;
    }
  }
  if (connHead) connHead.addEventListener("click", () => {
    const cur = (_connCollapsed === null) ? connAutoCollapsed(_health) : _connCollapsed;
    _connCollapsed = !cur;
    renderConnCenter();
  });
  if (connPrimary) connPrimary.addEventListener("click", () => connDo(connPrimary.dataset.action, connPrimary));
  if (connSecondary) connSecondary.addEventListener("click", () => connDo(connSecondary.dataset.action, connSecondary));
  if (connCheck) connCheck.addEventListener("click", () => connDo("check"));
  if (connDiag) connDiag.addEventListener("click", () => {
    // §5.4:只复制脱敏 health JSON;host 不存在时用兜底形态
    const h = _health || { schema_version: 1, overall: "action_required", bridge: { status: "install_required" }, reason_code: "BRIDGE_NOT_INSTALLED", extension_version: (_bootstrap && _bootstrap.extension_version) || "" };
    connCopy(JSON.stringify(h, null, 2), "conn.diagCopied", connDiag);
  });
  // file:// 访问提示:Chrome 禁止扩展直接打开 chrome:// 页面(安全限制),只能复制 URL 让用户粘贴到地址栏。
  const fileAccessCopy = document.getElementById("file-access-copy");
  // 复制带扩展 ID 的深链:用户粘贴到地址栏回车后,Chrome 直达 htmlGenius 扩展详情页(省去找扩展+点详情两步)。
  // 注:Chrome 禁止扩展编程打开 chrome:// 页面(tabs.create 报 Cannot access a chrome:// URL),故只能复制由用户粘贴。
  // 用 Chrome Web Store 官方扩展 ID(非 chrome.runtime.id):商店版用户装的即此 ID;本地 unpacked 版的 runtime.id 是
  // manifest key 派生的开发 ID,与商店 ID 不同,故写死官方 ID 保证复制链接恒指向官方扩展详情页。
  const OFFICIAL_EXTENSION_ID = "fcapmgclnpiljjlcaficmjjclkaepaon";
  if (fileAccessCopy) fileAccessCopy.addEventListener("click", () => connCopy("chrome://extensions/?id=" + OFFICIAL_EXTENSION_ID, "fileAccess.copied", fileAccessCopy));
  if (connRepairCancel) connRepairCancel.addEventListener("click", () => { if (connRepairConfirm) connRepairConfirm.hidden = true; });
  if (connRepairOk) connRepairOk.addEventListener("click", async () => {
    connRepairOk.disabled = true;
    const resp = await chrome.runtime.sendMessage({ type: "bridge-repair", confirmed_actions: ["repair_native_host"] }).catch(() => null);
    connRepairOk.disabled = false;
    if (connRepairConfirm) connRepairConfirm.hidden = true;
    if (resp && resp.ok && resp.health) {
      _health = resp.health;
      renderConnCenter();
      connSetHint(t("conn.repaired"), "ok");
      queryProviders(true); // 修复后重探 provider
    } else {
      connSetHint(tBridgeFailed((resp && resp.code) || "HOST_REPAIR_ERROR", null), "warn");
    }
  });

  // === 状态栏:计时器 + 本次进度时间线 + 最近 3 次历史(可点击展开/收起)===
  // 协议层无 token 流;用计时器(每秒跳)+ 阶段事件时间线 + 历史给用户「在动、没卡死」的可感知反馈。
  let _runTimer = null;
  let _runStartedAt = 0;
  let _runEvents = [];               // 本次 run 事件时间线 [{ts, text}]
  const RUN_LOG_KEY = "hg_recent_runs";
  function cbsTextEl() { return contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-text"); }
  function setBridgeStatus(text, cls) {
    if (!contractBridgeStatus) return;
    const expanded = contractBridgeStatus.classList.contains("expanded");
    contractBridgeStatus.hidden = !text && !_runEvents.length && !_candidateResult;
    const tx = cbsTextEl(); if (tx) tx.textContent = text || "";
    contractBridgeStatus.className = "contract-bridge-status" + (cls ? " " + cls : "") + (expanded ? " expanded" : "");
  }
  // 发送后默认展开进度窗(capped 限高);完成/终止后收起;点击在 收起↔半高 间切换(无全高态)。
  // open=false 收起;open=true 打开半高(内部滚动看更多)。
  function expandBridgeDetail(open) {
    if (!contractBridgeStatus) return;
    const d = contractBridgeStatus.querySelector(".cbs-detail");
    if (!d) return;
    if (!open) {
      d.hidden = true;
      contractBridgeStatus.classList.remove("expanded");
      return;
    }
    d.hidden = false;
    contractBridgeStatus.classList.add("expanded");
    loadRunHistory();
  }
  function startRunTimer() { stopRunTimer(); _runStartedAt = Date.now(); updateRunTimer(); _runTimer = setInterval(updateRunTimer, 1000); }
  // 切 tab 恢复运行态时:沿用原 _runStartedAt 继续计时(不复位)
  function resumeRunTimer() { stopRunTimer(); if (_runStartedAt) { updateRunTimer(); _runTimer = setInterval(updateRunTimer, 1000); } }
  function stopRunTimer() { if (_runTimer) { clearInterval(_runTimer); _runTimer = null; } }
  function updateRunTimer() {
    const el = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-timer");
    if (!el || !_runStartedAt) return;
    const secs = Math.max(0, Math.floor((Date.now() - _runStartedAt) / 1000));
    el.textContent = secs + "s";
  }
  function runDurationSec() { return _runStartedAt ? Math.max(0, Math.floor((Date.now() - _runStartedAt) / 1000)) : 0; }
  function nowHMS() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0"); }
  function pushProgress(text) { _runEvents.push({ ts: nowHMS(), text: String(text || "") }); renderProgress(); if (contractBridgeStatus) contractBridgeStatus.hidden = false; }
  function renderProgress() {
    const ul = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-progress");
    if (!ul) return;
    ul.innerHTML = _runEvents.slice(-12).map((e) => '<li><span class="cbs-ts">' + esc(e.ts) + "</span> " + esc(e.text) + "</li>").join("");
  }
  function resetRunEvents() { _runEvents = []; _streamText = ""; renderProgress(); renderStreamText(); }
  function recordRun(entry) {
    try {
      entry.ts = Date.now(); // 数值时间戳,供「最近 N 次」严格按时间排序
      chrome.storage.local.get([RUN_LOG_KEY], (res) => {
        const list = (res && Array.isArray(res[RUN_LOG_KEY])) ? res[RUN_LOG_KEY] : [];
        list.push(entry);
        list.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // 新→旧排序后取前 3 = 最近 3 条
        const trimmed = list.slice(0, 3);
        chrome.storage.local.set({ [RUN_LOG_KEY]: trimmed }, () => renderHistoryFromList(trimmed));
      });
    } catch (e) {}
  }
  function loadRunHistory() {
    try { chrome.storage.local.get([RUN_LOG_KEY], (res) => renderHistoryFromList((res && res[RUN_LOG_KEY]) || [])); } catch (e) {}
  }
  function renderHistoryFromList(list) {
    const ul = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-history");
    if (!ul) return;
    if (!list || !list.length) { ul.innerHTML = '<li class="cbs-empty">' + esc(t("run.noHistory")) + "</li>"; return; }
    // 按时间顺序排列(旧→新,最新在最下);旧记录无数值 ts 时按 started_at 字符串兜底
    const ordered = list.slice().sort((a, b) => {
      const ta = a.ts != null ? a.ts : 0, tb = b.ts != null ? b.ts : 0;
      return (ta - tb) || String(a.started_at || "").localeCompare(String(b.started_at || ""));
    });
    ul.innerHTML = ordered.map((r) => {
      const tag = (r.run_kind === "plan" ? t("run.kindPlan") : t("run.kindCandidate"));
      const st = r.status === "completed" ? t("run.ok") : (r.status === "plan-ready" ? t("run.planOk") : t("run.fail"));
      return '<li><span class="cbs-ts">' + esc(r.started_at || "") + "</span> " + esc(providerLabel(r.provider) || "?") + " · " + esc(tag) + " · " + esc(st) + (r.duration_s != null ? " · " + r.duration_s + "s" : "") + "</li>";
    }).join("");
  }
  // v0.8.1 Agent 实时流(Codex turn 中途):delta 逐字累积成「当前输出」;file/command/reasoning/tokens 作事件行
  function handleStream(msg) {
    if (!msg || msg.run_id !== _contractRunId) return;
    if (msg.kind === "delta") { _streamText += msg.text; renderStreamText(); if (contractBridgeStatus) contractBridgeStatus.hidden = false; }
    else if (msg.kind === "message") { _streamText = msg.text; renderStreamText(); }
    else { const label = streamLabel(msg); if (label) pushProgress(label); }
  }
  function streamLabel(msg) {
    if (msg.kind === "file") return msg.starting ? ("📄 " + t("run.file") + ":" + (msg.text ? " " + msg.text : "")) : null;
    if (msg.kind === "command") return msg.starting ? ("🔧 " + t("run.command")) : null;
    if (msg.kind === "reasoning") return msg.starting ? ("💭 " + t("run.reasoning")) : null;
    if (msg.kind === "tokens") return "⚡ " + msg.text + " tokens";
    if (msg.kind === "tool_denied") return "⛔ " + t("diag.toolDenied") + ": " + String(msg.tool || "?") + " (" + String(msg.category || "") + ")";
    if (msg.kind === "info") return "· " + String(msg.text || "");  // Copilot tool 等(info 流):可见以便排障
    return null;
  }
  function renderStreamText() {
    const el = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-stream");
    if (!el) return;
    el.textContent = _streamText; // 完整会话(不再只取末尾 400 字符),框可滚动便于排障
    el.classList.toggle("typing", !!_streamText);
    el.scrollTop = el.scrollHeight; // 自动滚到底,最新输出可见
  }
  function bridgeFailClass(code) {
    if (code === "USER_CANCELLED") return "warn";
    if (code === "CODEX_TIMED_OUT") return "warn";
    if (code === "SOURCE_CHANGED_BEFORE_START" || code === "SOURCE_MUTATED" || code === "SOURCE_MUTATED_DURING_HANDOFF"
      || code === "SOURCE_MUTATED_DURING_CANDIDATE" || code === "SOURCE_MUTATED_DURING_PLAN"
      || code === "BRIDGE_NOT_INSTALLED" || code === "CLAUDE_NOT_LOGGED_IN" || code === "CLAUDE_NOT_INSTALLED"
      || code === "SESSION_MODE_NOT_ALLOWED" || code === "CODEX_AUTH_REQUIRED"
      || code === "COPILOT_SDK_NOT_INSTALLED" || code === "COPILOT_CLI_NOT_FOUND" || code === "COPILOT_CLI_INCOMPATIBLE"
      || code === "COPILOT_AUTH_REQUIRED" || code === "COPILOT_RUNTIME_CHANGED" || code === "COPILOT_TIMEOUT"
      || code === "COPILOT_PLAN_TIMEOUT") return "warn";
    return "err";
  }
  function tBridgeFailed(code, host) {
    if (code === "USER_CANCELLED") return t("bridge.cancelled");
    if (code === "CODEX_TIMED_OUT") return t("bridge.codexTimeout");
    // v0.8.2 Copilot 失败码(§5.5)
    if (code === "COPILOT_SDK_NOT_INSTALLED" || code === "COPILOT_CLI_NOT_FOUND") return t("bridge.copilotNotInstalled");
    if (code === "COPILOT_CLI_INCOMPATIBLE") return t("bridge.copilotIncompatible");
    if (code === "COPILOT_AUTH_REQUIRED") return t("bridge.copilotAuthRequired");
    if (code === "COPILOT_RUNTIME_CHANGED") return t("bridge.copilotRuntimeChanged");
    if (code === "COPILOT_PERMISSION_DENIED") return t("bridge.copilotPermissionDenied");
    if (code === "COPILOT_TIMEOUT" || code === "COPILOT_PLAN_TIMEOUT") return t("bridge.copilotTimeout");
    if (code === "COPILOT_PLAN_FAILED") return t("bridge.planFailed");
    if (code === "SOURCE_CHANGED_BEFORE_START" || code === "SOURCE_MUTATED" || code === "SOURCE_MUTATED_DURING_HANDOFF") return t("bridge.sourceChanged");
    if (code === "SOURCE_MUTATED_DURING_CANDIDATE") return t("bridge.sourceMutated");
    if (code === "SOURCE_MUTATED_DURING_PLAN") return t("bridge.planSourceMutated");
    if (code === "PLAN_MISSING" || code === "PLAN_INVALID" || code === "PLAN_TOO_LARGE" || code === "PLAN_SYMLINK" || code === "PLAN_OUTPUT_PATH_INVALID") return t("bridge.planInvalid");
    if (code === "CLAUDE_PLAN_FAILED" || code === "CLAUDE_PLAN_TIMEOUT" || code === "CODEX_PLAN_FAILED" || code === "CODEX_PLAN_TIMEOUT") return t("bridge.planFailed");
    if (code === "CANDIDATE_MISSING" || code === "CANDIDATE_INVALID_HTML" || code === "CANDIDATE_EMPTY"
      || code === "CANDIDATE_SYMLINK" || code === "CANDIDATE_NOT_FILE" || code === "CANDIDATE_TOO_LARGE" || code === "CANDIDATE_NOT_UTF8") return t("bridge.candidateInvalid").replace("{agent}", providerLabel(_provider));
    if (code === "BRIDGE_NOT_INSTALLED") return t("bridge.notInstalled");
    if (code === "CLAUDE_NOT_LOGGED_IN" || code === "CLAUDE_NOT_INSTALLED" || code === "CODEX_AUTH_REQUIRED") return t("bridge.notLoggedIn");
    if (code === "SESSION_MODE_NOT_ALLOWED") return t("bridge.sessionModeNotAllowed");
    if (code === "PLAN_NOT_FOUND" || code === "PLAN_STALE_SOURCE" || code === "PLAN_CONTRACT_CHANGED" || code === "PLAN_EDIT_INVALID" || code === "PLAN_ALREADY_USED") return t("bridge.planConfirmFailed");
    return t("bridge.failed").replace("{msg}", (host && host.message) ? host.message : (code || ""));
  }
  function setContractRunning(running) {
    _contractRunning = !!running;
    contractSheet.querySelectorAll('input[name="contract-scope"], textarea').forEach((el) => { el.disabled = running; });
    refreshContractUI();
  }
  // 卡死恢复:确认后台是否真有活跃 run
  async function ensureNotStuckRunning() {
    if (!_contractRunning) return true;
    const tab = await getActiveTab();
    if (tab && tab.id) {
      const resp = await chrome.runtime.sendMessage({ type: "bridge-query-active-run", tab_id: tab.id }).catch(() => null);
      if (!resp || !resp.active) { _contractRunning = false; setContractRunning(false); }
    }
    return !_contractRunning;
  }
  // 通用派发:run_kind = candidate | plan;candidate 可携带已确认 plan
  async function dispatchBridgeRun(runKind, opts) {
    if (!(await ensureNotStuckRunning())) return;
    if (!(await refreshSelectionBeforeSubmit())) return; // spec §4.3:发送前过 stale 防线 + plan 失效检查
    if (!_provider) { setBridgeStatus(t("bridge.noProvider"), "warn"); return; }
    const draft = getContractDraft();
    let task;
    try { task = window.ChangeContract.buildTask(draft, _contractItems); }
    catch (e) { setBridgeStatus(t("bridge.invalid"), "err"); return; }
    const tab = await getActiveTab();
    if (!tab || !tab.id) { setBridgeStatus(t("bridge.failed").replace("{msg}", "no active tab"), "err"); return; }
    currentTabId = tab.id; // 确保 bridge 消息路由匹配当前 run 的 tab(修 candidate-ready 不终结)
    _contractRunKind = runKind;
    _candidateResult = null; renderCandidateIndicator();
    const payload = { type: "bridge-start", provider: _provider, run_kind: runKind, tab_id: tab.id, session_mode: "new", change_contract: task };
    if (runKind === "candidate" && opts && opts.plan) payload.plan = opts.plan;
    chrome.runtime.sendMessage(payload).then((resp) => {
      if (resp && resp.ok) {
        // v2 口径:task_send 仅计真正的编辑任务(candidate);plan 预跑单独计 plan_request,
        // 计划确认后发送计 plan_confirm(流失 = plan_request − plan_confirm)。
        if (runKind === "candidate") HGAnalytics.track("task_send", { provider: _provider, scope: draft.mode });
        if (runKind === "plan") HGAnalytics.track("plan_request", { provider: _provider, scope: draft.mode });
        if (runKind === "candidate" && opts && opts.plan) HGAnalytics.track("plan_confirm", { provider: _provider, scope: draft.mode });
        setContractRunning(true);
        if (resp.run_id) _contractRunId = resp.run_id;
        // 状态栏可见:plan 确认后从 plan-review 发的 candidate 也要回 compose 看进度
        if (_contractStep !== "compose") setContractStep("compose");
        resetRunEvents();
        const startMsg = (runKind === "plan" ? t("bridge.planRunning") : t("bridge.candidateRunning")).replace("{agent}", providerLabel(_provider));
        setBridgeStatus(startMsg, "running");
        pushProgress(t("run.started").replace("{agent}", providerLabel(_provider)));
        startRunTimer();
        pushProgress(startMsg);
        expandBridgeDetail(true); // 发送后默认展开进度窗,用户看到实时进展
      } else {
        const code = resp && resp.code;
        if (code === "BRIDGE_NOT_INSTALLED") setBridgeStatus(t("bridge.notInstalled"), "warn");
        else if (code === "NOT_LOCAL" || code === "NO_ARTIFACT_VERSION") setBridgeStatus(t("bridge.hint"), "warn");
        else setBridgeStatus(tBridgeFailed(code, resp), bridgeFailClass(code));
        pushProgress(tBridgeFailed(code, resp));
      }
    }).catch(() => { setBridgeStatus(t("bridge.notInstalled"), "warn"); pushProgress(t("bridge.notInstalled")); });
  }
  function startBridgeRun() { return dispatchBridgeRun("candidate", _plan && !_planStale ? { plan: planPayload() } : null); }
  // v0.8.1 plan 流:先给我看修改计划 → run_kind=plan → plan-running → bridge-plan-ready → plan-review
  function startPlanRun() { return dispatchBridgeRun("plan"); }
  // v0.8.1 终止任务:通知 background 断 host port(→ USER_CANCELLED 终态广播);UI 等 bridge-failed 回灌后恢复发送按钮
  async function cancelBridgeRun() {
    if (contractBridge) contractBridge.disabled = true; // 防重复点击
    setBridgeStatus(t("bridge.cancelling"), "warn");
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    chrome.runtime.sendMessage({ type: "bridge-cancel", tab_id: tab.id, run_id: _contractRunId }).then((resp) => {
      // 竞态兜底:后台已无活跃 run(刚完成/失败/SW 被杀)→ 终止广播不会到,这里直接恢复发送态
      if (resp && resp.ok === false && _contractRunning) {
        _contractRunning = false; setContractRunning(false); stopRunTimer();
        setBridgeStatus(t("bridge.cancelled"), "warn");
      }
    }).catch(() => {});
  }
  // plan-ready 到达:存计划,进 plan-review(spec §5.3/§3.E)
  function onPlanReady(msg) {
    setContractRunning(false);
    stopRunTimer();
    if (!msg || !msg.plan_id || !msg.plan) {
      pushProgress(t("bridge.planFailed"));
      recordRun({ provider: _provider, run_kind: "plan", status: "failed", duration_s: runDurationSec(), started_at: nowHMS(), mode: getContractMode() });
      setBridgeStatus(t("bridge.planFailed"), "err");
      return;
    }
    const draft = getContractDraft();
    _plan = {
      plan_id: msg.plan_id,
      plan_sha256: msg.plan_sha256,
      plan_markdown: msg.plan.plan_markdown || "",
      summary: msg.plan.summary || "",
      out_of_scope: msg.plan.out_of_scope || [],
      provider: _provider,
      source_artifact_uri: _contractArtifact && _contractArtifact.url,
      base_artifact_hash: _contractMeta && _contractMeta.loadedArtifactHash,
      task_sha256: null
    };
    try { _plan.task_sha256 = taskFingerprint(draft); } catch (e) {}
    _planStale = false;
    pushProgress(t("run.planReady"));
    recordRun({ provider: _provider, run_kind: "plan", status: "plan-ready", duration_s: runDurationSec(), started_at: nowHMS(), mode: getContractMode() });
    setContractStep("plan-review");
    setBridgeStatus("", null);
  }
  // sidepanel 内 plan stale 检测用的契约指纹(canonical JSON 字符串)。真正的硬校验在 background(§5.4 task_sha256)。
  function taskFingerprint(draft) {
    const task = window.ChangeContract.buildTask(draft, _contractItems);
    return JSON.stringify(task, null, 2);
  }
  function planPayload() {
    if (!_plan) return null;
    return { plan_id: _plan.plan_id, plan_sha256: _plan.plan_sha256, edited_plan_markdown: planEditor ? planEditor.value : _plan.plan_markdown };
  }
  function renderPlanReview() {
    if (planReviewAgent && _provider) planReviewAgent.textContent = providerLabel(_provider) + " · ";
    if (planEditor && _plan) planEditor.value = _plan.plan_markdown;
    renderPlanConfirmState();
  }
  function renderPlanConfirmState() {
    if (!planConfirmBtn || !_plan) return;
    const edited = planEditor ? planEditor.value.trim() : "";
    planConfirmBtn.disabled = _contractRunning || _planStale || !edited;
    if (planStaleHint) planStaleHint.hidden = !_planStale;
  }
  // 计划后改 contract(mode/评论/brief/preserve/artifact)→ 标 stale,阻止确认(spec §3.E.9)
  function checkPlanStale() {
    if (!_plan || _planStale) return;
    if (!_contractMeta || _plan.base_artifact_hash !== _contractMeta.loadedArtifactHash) { _planStale = true; }
    const draft = getContractDraft();
    try { if (taskFingerprint(draft) !== _plan.task_sha256) _planStale = true; } catch (e) {}
    renderPlanConfirmState();
  }
  // 确认计划 → 新 candidate task(携带 plan);绝不 resume plan task(spec §3.E.8/§5.4)
  function confirmPlan() {
    if (_planStale) return;
    return dispatchBridgeRun("candidate", { plan: planPayload() });
  }

  // === 方向3:确定性编辑预览(先预览后确认)。bridge-patch-preview 到达 → 渲染编辑清单 + 合规徽章 → 用户勾选确认 →
  //     发 bridge-patch-apply(仅勾选的 ok 编辑)→ background 另起 host 落 candidate(复用 completeCandidate)。===
  const PATCH_STATUS_KEY = { out_of_scope: "patch.outOfScope", not_found: "patch.notFound", ambiguous: "patch.ambiguous", conflict: "patch.conflict" };
  function patchStatusText(st) { const k = PATCH_STATUS_KEY[st]; return k ? t(k) : String(st); }
  function _patchNoteHtml(compliance) {
    // Agent 在 patch JSON note 字段给的"无变更/跳过理由";无则不显示。
    if (compliance && compliance.note) return '<div class="pp-note">' + esc(t("patch.agentNote")) + " " + esc(String(compliance.note)) + "</div>";
    return "";
  }
  function renderPatchPreview(edits, compliance) {
    if (!patchEditList) return;
    const items = (edits || []).slice().sort((a, b) => ((a.status === "ok" ? 0 : 1) - (b.status === "ok" ? 0 : 1)));
    if (items.length === 0) {
      // 空编辑:Agent 判定无需修改(目标已满足评论要求,或无法唯一定位)。给明确说明 + Agent 的 note 理由。
      patchEditList.innerHTML = '<div class="pp-empty">' + esc(t("patch.noneNeeded")) + "</div>" + _patchNoteHtml(compliance);
    } else {
    patchEditList.innerHTML = items.map((e) => {
      const isOk = e.status === "ok";
      const actionLabel = e.action === "set_style" ? t("patch.setStyle") : t("patch.replaceText");
      const loc = esc((e.locator && e.locator.exact) || "");
      const detail = e.action === "set_style"
        ? '<span class="pp-loc">' + loc + '</span> → <span class="pp-new">' + esc((e.property || "") + ": " + (e.value || "")) + '</span>'
        : '<span class="pp-old">' + loc + '</span> → <span class="pp-new">' + esc(e.replacement || "") + '</span>';
      const badge = isOk ? "" : '<span class="pp-status pp-' + esc(e.status) + '">' + esc(patchStatusText(e.status)) + '</span>';
      const checkbox = isOk
        ? '<input type="checkbox" class="pp-check" data-id="' + esc(e.id) + '" checked>'
        : '<input type="checkbox" class="pp-check" disabled>';
      return '<div class="pp-item' + (isOk ? "" : " pp-problem") + '">' + checkbox +
        '<div class="pp-body"><div class="pp-action">' + esc(actionLabel) + (e.comment_ref ? " · " + esc(String(e.comment_ref)) : "") + "</div>" +
        '<div class="pp-detail">' + detail + "</div>" + badge + "</div></div>";
    }).join("") + _patchNoteHtml(compliance);
    }
    if (patchBadge && compliance) {
      const skip = (compliance.total || 0) - (compliance.applicable || 0);
      patchBadge.textContent = (compliance.applicable || 0) + " " + t("patch.willApply") + (skip > 0 ? " · " + skip + " " + t("patch.needAttention") : "");
    }
  }
  function showPatchPreview(msg) {
    _patchPending = { run_id: msg.run_id, edits: msg.edits || [], compliance: msg.compliance || {} };
    renderPatchPreview(msg.edits, msg.compliance);
    if (patchPreview) patchPreview.hidden = false;
    setContractRunning(false); stopRunTimer();            // 等用户确认,停「运行中」转圈
    setBridgeStatus(t("patch.previewTitle"), "running");
    if (contractBridge) contractBridge.disabled = true;   // 预览期间禁发送(避免与 pending run 冲突)
  }
  function hidePatchPreview() {
    _patchPending = null;
    if (patchPreview) patchPreview.hidden = true;
    if (contractBridge) contractBridge.disabled = _contractRunning; // 运行中仍保持禁用(发送键此时是「终止」)
  }
  function confirmPatch() {
    if (!_patchPending) return;
    const checked = Array.from(patchEditList.querySelectorAll(".pp-check:checked")).map((el) => el.getAttribute("data-id"));
    if (!checked.length) {
      // 没有勾选任何可应用编辑 → 等同取消(绝不发空清单去产出与原文相同的无意义 candidate)
      cancelPatch();
      setBridgeStatus(t("patch.nothingToApply"), "warn");
      return;
    }
    const runId = _patchPending.run_id;
    hidePatchPreview();
    _contractRunId = runId; setContractRunning(true); startRunTimer();
    setBridgeStatus(t("bridge.candidateRunning").replace("{agent}", providerLabel(_provider)), "running");
    expandBridgeDetail(true);
    chrome.runtime.sendMessage({ type: "bridge-patch-apply", tab_id: currentTabId, run_id: runId, confirmed_edit_ids: checked })
      .then((resp) => {
        if (resp && resp.ok) HGAnalytics.track("task_accept", { provider: _provider });
        if (!resp || !resp.ok) { setContractRunning(false); stopRunTimer(); setBridgeStatus(tBridgeFailed(resp && resp.code, resp), bridgeFailClass(resp && resp.code)); }
      })
      .catch(() => { setContractRunning(false); stopRunTimer(); setBridgeStatus(t("bridge.notInstalled"), "warn"); });
  }
  function cancelPatch() {
    if (!_patchPending) return;
    const runId = _patchPending.run_id;
    hidePatchPreview();
    chrome.runtime.sendMessage({ type: "bridge-cancel", tab_id: currentTabId, run_id: runId }).catch(() => {});
    setBridgeStatus(t("patch.cancelled"), "warn");
  }
  // 设置持久化 + 按钮接线
  if (patchApplyModeRadios.length) {
    try { chrome.storage.sync.get({ hgPatchApplyMode: "apply_then_review" }, (r) => {
      const mode = (r && r.hgPatchApplyMode) || "apply_then_review"; // 默认:直接应用,事后审阅
      patchApplyModeRadios.forEach((rd) => { rd.checked = (rd.value === mode); });
    }); } catch (e) {}
    patchApplyModeRadios.forEach((rd) => rd.addEventListener("change", () => { if (rd.checked) { try { chrome.storage.sync.set({ hgPatchApplyMode: rd.value }); } catch (e) {} } }));
  }
  if (patchConfirmBtn) patchConfirmBtn.addEventListener("click", confirmPatch);
  if (patchCancelBtn) patchCancelBtn.addEventListener("click", cancelPatch);

  if (contractCloseBtn) contractCloseBtn.addEventListener("click", closeContract);
  // scope 卡 / brief / preserve 改动 → 刷新 UI + 计划失效检测(spec §3.E.9)
  document.querySelectorAll('input[name="contract-scope"]').forEach((r) => r.addEventListener("change", () => { refreshContractUI(); checkPlanStale(); }));
  if (contractBrief) contractBrief.addEventListener("input", () => { refreshContractUI(); checkPlanStale(); });
  if (contractPreserve) contractPreserve.addEventListener("input", () => { refreshContractUI(); checkPlanStale(); });
  if (contractCopyPrompt) contractCopyPrompt.addEventListener("click", () => copyContract());
  // 发送按钮:运行中 → 终止任务(cancelBridgeRun);否则 → 发送(startBridgeRun)
  if (contractBridge) contractBridge.addEventListener("click", () => { if (_contractRunning) cancelBridgeRun(); else startBridgeRun(); });
  // 状态栏点击:两态切换 收起 ↔ 半高(capped 限高,内部滚动)
  if (contractBridgeStatus) contractBridgeStatus.addEventListener("click", () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 正在选中文字(拖选复制报错文案)时不触发折叠切换
    const d = contractBridgeStatus.querySelector(".cbs-detail");
    if (!d) return;
    expandBridgeDetail(d.hidden);
  });
  if (contractPlanBtn) contractPlanBtn.addEventListener("click", startPlanRun);
  // v0.9.8:整个「选择评论范围」方框都可点(原先只有点文字才行)→ 进评论勾选级
  const commentRangeEntry = document.getElementById("comment-range-entry");
  if (commentRangeEntry) commentRangeEntry.addEventListener("click", () => setContractStep("comment-scope"));
  if (commentRangeEntry) commentRangeEntry.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setContractStep("comment-scope"); } });
  // 发送组菜单:⌄ 切换 + 重新 probe(缓存过期);agent 选 provider;外部点击关闭
  const sendToggle = document.getElementById("contract-send-toggle");
  const sendMenu = document.getElementById("contract-send-menu");
  function closeSendMenu() {
    if (sendMenu) { sendMenu.classList.remove("show"); sendMenu.hidden = true; }
    if (sendToggle) sendToggle.setAttribute("aria-expanded", "false");
  }
  if (sendToggle) sendToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    queryProviders(false); // 点开下拉时若缓存过期则重探(spec §3.D)
    const open = !sendMenu.classList.contains("show");
    if (open) {
      // `hidden` 在 Chrome UA stylesheet 中带 !important；仅加 .show 仍会被隐藏，
      // 导致下拉里的 Connection Center 永远无法进入。
      sendMenu.hidden = false;
      sendMenu.classList.add("show");
      sendToggle.setAttribute("aria-expanded", "true");
    } else closeSendMenu();
  });
  if (sendMenu) sendMenu.addEventListener("click", (e) => {
    const ag = e.target.closest(".agent");
    if (ag && !ag.disabled) { selectProvider(ag.dataset.provider); closeSendMenu(); return; }
  });
  // v0.9.1:下拉教程里的「复制」安装命令按钮(就地反馈,不关菜单)
  const sendSetupCopy = document.getElementById("contract-send-setup-copy");
  if (sendSetupCopy) sendSetupCopy.addEventListener("click", (e) => {
    e.stopPropagation();
    const cmdEl = document.getElementById("contract-send-setup-cmd");
    const cmd = (cmdEl && cmdEl.textContent) || (_bootstrap && _bootstrap.terminal_command) || "";
    if (!cmd) return;
    connCopy(cmd, "conn.terminalCopied", sendSetupCopy); // v0.9.7 connCopy 内置按钮"已复制 ✓"闪烁
  });
  document.addEventListener("click", (e) => { if (sendMenu && !e.target.closest(".send-group")) closeSendMenu(); });
  // 状态栏候选「打开候选版本」:新标签打开(background 完成时已自动开;此为手动兜底)。阻止冒泡,避免触发状态栏展开/收起。
  if (cbsCandidate) cbsCandidate.addEventListener("click", (e) => e.stopPropagation());
  if (cbsOpen) cbsOpen.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_candidateResult && _candidateResult.candidate_uri) {
      try { chrome.tabs.create({ url: _candidateResult.candidate_uri }); } catch (er) {}
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _contractOpen) { e.preventDefault(); closeContract(); } });

  // === v0.8.1 comment-scope / plan-review 事件 ===
  document.getElementById("contract-compose-back").addEventListener("click", closeContract); // compose --返回页面评论--> 关闭契约,回评论视图
  document.getElementById("contract-range-back").addEventListener("click", () => setContractStep("compose")); // comment-scope --返回--> compose(保留草稿)
  document.getElementById("contract-range-confirm").addEventListener("click", () => setContractStep("compose")); // 确认选择 → 回 compose
  // comment-scope 卡片勾选:事件委托;子树随父勾选(spec §3.C/§4.4)
  if (selectList) selectList.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const card = cb.closest(".select-card");
    if (!card) return;
    const id = card.dataset.id;
    const kids = buildChildrenIndex(_contractItems);
    descendantIds(id, kids).forEach((x) => { if (cb.checked) _selectedNodeIds.add(x); else _selectedNodeIds.delete(x); });
    renderCommentScope();
  });
  // 全选/取消全选
  if (selectToggleAll) selectToggleAll.addEventListener("click", () => {
    const nonStale = allNonStaleNodeIds(_contractItems);
    const allSelected = selectedNodeCount() === nonStale.length && nonStale.length > 0;
    _selectedNodeIds = new Set(allSelected ? [] : nonStale);
    renderCommentScope();
  });
  // plan-review:编辑计划 → 刷新确认态;重新生成 → 新 plan task(旧计划作废);确认 → 新 candidate task(携带 plan)
  if (planEditor) planEditor.addEventListener("input", renderPlanConfirmState);
  if (planRegenerate) planRegenerate.addEventListener("click", () => { _plan = null; _planStale = false; setContractStep("compose"); startPlanRun(); });
  if (planConfirmBtn) planConfirmBtn.addEventListener("click", confirmPlan);
  document.getElementById("contract-plan-review-back").addEventListener("click", () => setContractStep("compose")); // plan-review --返回--> compose(计划保留为未采纳草稿)
  // ? tooltip:click toggle(触屏可用),hover/focus 由 CSS 处理;同时关掉其他已开的
  document.addEventListener("click", (e) => {
    const tip = e.target.closest(".tip");
    document.querySelectorAll(".tip.open").forEach((x) => { if (x !== tip) x.classList.remove("open"); });
    if (tip) { e.preventDefault(); e.stopPropagation(); tip.classList.toggle("open"); }
  });

  // 「创建编辑任务」(spec §3.A/§4.2):get-export → roots → 默认全选 → 直达 compose
  document.getElementById("export-btn").addEventListener("click", () => {
    sendToContent({ type: "get-export" }).then((resp) => {
      if (!resp || resp.type !== "export-data") return;
      const items = resp.items || [];
      const roots = window.ChangeContract.getRoots(items);
      if (!roots.length) { showToast(t("contract.empty")); return; }
      _contractTriggerEl = document.getElementById("export-btn");
      openContract(roots, items, resp.artifact, bridgeMeta(resp));
    });
  });

  const siteExportBtn = document.getElementById("site-export-btn");
  if (siteExportBtn) siteExportBtn.addEventListener("click", async () => {
    if (siteExportBtn.disabled) return;
    siteExportBtn.disabled = true;
    siteExportBtn.textContent = t("siteExport.loading");
    try {
      const [tab, cfg] = await Promise.all([getActiveTab(), getCfg(["session_token", "mode"])]);
      const origin = window.SiteCommentExport && tab ? window.SiteCommentExport.siteOrigin(tab.url || "") : null;
      if (!origin) throw new Error(t("siteExport.unsupported"));
      if (!cfg.session_token || cfg.mode !== "synced") throw new Error(t("siteExport.loginRequired"));
      const response = await fetch(
        BACKEND + "/api/site-annotations?site_origin=" + encodeURIComponent(origin) + "&status=open",
        { headers: { Authorization: "Bearer " + cfg.session_token } },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error((data && data.detail) || t("siteExport.failed"));
      if (!data || !data.total) { showToast(t("siteExport.empty")); return; }
      const lang = window.HG_I18N ? window.HG_I18N.getLang() : "en";
      const prompt = window.SiteCommentExport.buildPrompt(data, lang);
      await navigator.clipboard.writeText(prompt);
      showToast(t(data.truncated ? "siteExport.copiedTruncated" : "siteExport.copied")
        .replace("{comments}", String(data.total)).replace("{pages}", String(data.page_count)));
    } catch (e) {
      showToast((e && e.message) || t("siteExport.failed"));
    } finally {
      siteExportBtn.disabled = false;
      siteExportBtn.textContent = t("siteExport.button");
    }
  });

  document.getElementById("edit-btn").addEventListener("click", () => {
    // 编辑态由 content-script 经 edit-state 广播同步;此处乐观翻转即时反馈
    if (!_editing) HGAnalytics.track("edit_start", { is_local: isLocal });
    else HGAnalytics.track("edit_end", { is_local: isLocal });
    sendToContent({ type: _editing ? "disable-edit" : "enable-edit" });
    _editing = !_editing;
    renderMode();
  });
  // 安装前已打开的标签:点「刷新页面」重载当前 tab → content-script 注入 → 自动连上(提示随之隐藏)
  const refreshNowBtn = document.getElementById("refresh-now-btn");
  if (refreshNowBtn) refreshNowBtn.addEventListener("click", () => {
    getActiveTab().then((tab) => { if (tab && tab.id) { try { chrome.tabs.reload(tab.id, { bypassCache: true }); } catch (e) { /* 非关键 */ } } });
  });
  const artifactReloadBtn = document.getElementById("artifact-reload-btn");
  const artifactReloadConfirm = document.getElementById("artifact-reload-confirm");
  function performArtifactReload() {
    if (artifactReloadConfirm) artifactReloadConfirm.hidden = true;
    _pendingArtifactReload = true;
    getActiveTab().then((tab) => { if (tab && tab.id) chrome.tabs.reload(tab.id, { bypassCache: true }); });
  }
  if (artifactReloadBtn) artifactReloadBtn.addEventListener("click", async () => {
    const response = await sendToContent({ type: "prepare-artifact-reload" });
    if (!response || !response.ok) return;
    if (response.status === "needs_confirmation") { if (artifactReloadConfirm) artifactReloadConfirm.hidden = false; }
    else performArtifactReload();
  });
  const artifactReloadCancel = document.getElementById("artifact-reload-cancel");
  const artifactReloadConfirmBtn = document.getElementById("artifact-reload-confirm-btn");
  if (artifactReloadCancel) artifactReloadCancel.addEventListener("click", () => { if (artifactReloadConfirm) artifactReloadConfirm.hidden = true; });
  if (artifactReloadConfirmBtn) artifactReloadConfirmBtn.addEventListener("click", performArtifactReload);

  // v0.6: 切换高级(元素)模式
  document.getElementById("adv-mode-btn").addEventListener("click", () => sendToContent({ type: "toggle-element-mode" }));
  // v0.6 M3: 元素面板操作(事件委托;面板 innerHTML 会随选中重建)
  document.getElementById("element-panel").addEventListener("click", (e) => {
    if (e.target.id === "el-del") sendToContent({ type: "element-delete" });
    else if (e.target.id === "el-dup") sendToContent({ type: "element-duplicate" });
    else if (e.target.id === "el-parent") sendToContent({ type: "element-select-parent" });
    else if (e.target.id === "el-textedit") {
      sendToContent({ type: "element-edit-text" });
      // #8: 释放侧边栏焦点 → 焦点回到页面,控件里的闪烁光标立即可见(content-script 一侧同时 window.focus() 配合)
      try { window.blur(); } catch (er) {}
    }
  });
  // v0.6 M6: 元素样式 select 改动 → element-style
  document.getElementById("element-panel").addEventListener("change", (e) => {
    const s = e.target.closest("select[data-style]");
    if (s) sendToContent({ type: "element-style", prop: s.dataset.style, value: s.value });
  });
  // v0.6 M7: Emoji 库 — 按钮开关面板 + 点 emoji 插入
  document.getElementById("act-emoji").addEventListener("click", () => {
    const p = document.getElementById("emoji-panel");
    buildEmojiPanel();
    p.hidden = !p.hidden;
  });
  document.getElementById("emoji-panel").addEventListener("click", (e) => {
    const b = e.target.closest(".emoji-i");
    if (b) sendToContent({ type: "insert-text", text: b.dataset.e });
  });
  // #3a/#3b: 侧边栏会话动作 + 取色 → 发消息给 content-script(content-script 在页面施效)
  document.getElementById("act-undo").addEventListener("click", () => sendToContent({ type: "undo" }));
  document.getElementById("act-redo").addEventListener("click", () => sendToContent({ type: "redo" }));
  document.getElementById("act-reset").addEventListener("click", () => sendToContent({ type: "reset-edit" }));
  // v0.9.6: 下载统一走这里(content-script 只回传 HTML;下载需在 side panel 触发以保住用户手势)
  function downloadHtml(html, filename) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename || "page.html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  // v0.9.6: 保存按钮右上角的「未保存」微标(有未提交草稿时点亮)
  function setSaveDot(on) {
    const d = document.getElementById("save-dot");
    if (d) d.hidden = !on;
  }
  document.getElementById("act-save").addEventListener("click", async () => {
    // 保存(主):下载原文件名。content-script 在回复前将「当前」快照标为已提交，
    // 避免 debounce 尚未落库时误把上一个版本当作已保存。
    const r = await sendToContent({ type: "save-html", commit: true });
    if (r && r.html) {
      downloadHtml(r.html, r.name || "page.html");
      if (r.committed) setSaveDot(false);
    }
  });
  // v0.9.9: 草稿恢复横幅迁入 Side Panel —— 恢复/丢弃回传 content-script 执行(逻辑同原页内横幅按钮)
  const draftRestoreBtn = document.getElementById("draft-restore-btn");
  const draftDiscardBtn = document.getElementById("draft-discard-btn");
  if (draftRestoreBtn) draftRestoreBtn.addEventListener("click", () => { sendToContent({ type: "draft-restore" }); });
  if (draftDiscardBtn) draftDiscardBtn.addEventListener("click", () => { sendToContent({ type: "draft-discard" }); });
  // v0.8 #4/#1: 面板内 swatch 浮层(替代原生 color input,杜绝系统选色器右溢出;浮层挂整个
  //   .edit-colors 行,8 列 × 2 行 = 16 色整齐无空位)。
  // v0.9.1:文字色与高亮色均取自单一来源 palette.js(与 content-script 工具栏同一份取值,杜绝漂移)。
  //   顺带把文字色第 15 格统一为品牌 mint #88e6d1(替换旧蓝 #7c8cff)。
  const SP_TEXT_COLORS = (typeof HG_PALETTE !== "undefined" && HG_PALETTE.TEXT_COLORS) || ["#0a0a0a", "#374151", "#6b7280", "#9ca3af", "#ffffff", "#ef4444", "#f97316", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#88e6d1", "#e11d48"];
  const SP_HL_COLORS = (typeof HG_PALETTE !== "undefined" && HG_PALETTE.HL_COLORS) || ["#fff59d", "#ffd54f", "#ffcdd2", "#f8bbd0", "#e1bee7", "#c5cae9", "#bbdefb", "#b2dfdb", "#c8e6c9", "#dcedc8", "#ffccbc", "#ffe0b2", "#d7ccc8", "#e5e7eb", "#ffffff", "transparent"];
  function buildSpSwatches() {
    const map = [["sp-color-text-pop", SP_TEXT_COLORS], ["sp-color-hl-pop", SP_HL_COLORS]];
    for (const [id, arr] of map) {
      const p = document.getElementById(id);
      if (!p || p.dataset.built) continue;
      p.dataset.built = "1";
      // transparent 不写 inline background,让 CSS 的红斜杠「清除高亮」样式生效
      p.innerHTML = arr.map((c) => '<button class="sw" type="button" data-c="' + c + '"' + (c === "transparent" ? ' title="' + esc(t("tool.clear")) + '"' : ' style="background:' + c + '"') + "></button>").join("");
    }
  }
  // 字号以数字 px 展示；自定义输入支持任意正数。
  const SP_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48];
  function buildSpListPops() {
    const sizePop = document.getElementById("sp-size-pop");
    if (sizePop && !sizePop.dataset.built) {
      sizePop.dataset.built = "1";
      sizePop.innerHTML = SP_SIZES.map((s) => '<button class="li" type="button" data-kind="style" data-prop="fontSize" data-val="' + s + 'px" style="font-size:' + s + 'px">' + s + " px</button>").join("")
        + '<label class="sp-size-custom"><input type="number" min="0.1" step="0.1" inputmode="decimal" placeholder="' + esc(t("tool.sizeCustom")) + '" aria-label="' + esc(t("tool.sizeCustom")) + '"><span>px</span></label>';
    }
    const headPop = document.getElementById("sp-heading-pop");
    if (headPop && !headPop.dataset.built) {
      headPop.dataset.built = "1";
      headPop.innerHTML = [["P", "heading.normal", ""], ["H1", "heading.h1", "lg-h1"], ["H2", "heading.h2", "lg-h2"], ["H3", "heading.h3", "lg-h3"]]
        .map((h) => '<button class="li ' + h[2] + '" type="button" data-kind="block" data-fmt="heading" data-val="' + h[0] + '">' + esc(t(h[1])) + "</button>").join("");
    }
    const alignPop = document.getElementById("sp-align-pop");
    if (alignPop && !alignPop.dataset.built) {
      alignPop.dataset.built = "1";
      alignPop.innerHTML = [["left", "align.left"], ["center", "align.center"], ["right", "align.right"], ["justify", "align.justify"]]
        .map((a) => '<button class="li" type="button" data-kind="block" data-fmt="align" data-val="' + a[0] + '">' + esc(t(a[1])) + "</button>").join("");
    }
    // 字体弹层：单列、可滚动，按一个连续列表展示全部字体。
    const fontPop = document.getElementById("sp-font-pop");
    if (fontPop && !fontPop.dataset.built) {
      fontPop.dataset.built = "1";
      const FONTS = (typeof HG_PALETTE !== "undefined" && HG_PALETTE.FONTS) || [];
      fontPop.innerHTML = FONTS.map((g) => g.items.map((f) =>
        '<button class="li" type="button" data-kind="style" data-prop="fontFamily" data-val="' + f[1] + '" style="font-family:' + f[1] + '">' + esc(f[0]) + "</button>"
      ).join("")).join("");
    }
  }
  function closeAllSpPops() {
    document.querySelectorAll(".sp-color-pop, .sp-list-pop").forEach((x) => { x.hidden = true; });
    document.querySelectorAll(".sp-color-btn, .sp-block-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  function toggleSpPop(id) {
    const p = document.getElementById(id);
    if (!p) return;
    const open = p.hidden;
    closeAllSpPops();
    if (open) { p.hidden = false; const btn = p.parentElement.querySelector(".sp-color-btn, .sp-block-btn"); if (btn) btn.setAttribute("aria-expanded", "true"); }
  }
  document.getElementById("sp-color-text").addEventListener("click", () => { buildSpSwatches(); toggleSpPop("sp-color-text-pop"); });
  document.getElementById("sp-color-hl").addEventListener("click", () => { buildSpSwatches(); toggleSpPop("sp-color-hl-pop"); });
  document.getElementById("sp-size").addEventListener("click", () => { buildSpListPops(); toggleSpPop("sp-size-pop"); });
  document.getElementById("sp-heading").addEventListener("click", () => { buildSpListPops(); toggleSpPop("sp-heading-pop"); });
  document.getElementById("sp-align").addEventListener("click", () => { buildSpListPops(); toggleSpPop("sp-align-pop"); });
  document.getElementById("sp-font").addEventListener("click", () => { buildSpListPops(); toggleSpPop("sp-font-pop"); });
  document.querySelector(".edit-colors").addEventListener("click", (e) => {
    const sw = e.target.closest(".sw");
    if (!sw) return;
    const pop = sw.closest(".sp-color-pop");
    const kind = pop && pop.id === "sp-color-text-pop" ? "text" : "highlight";
    sendToContent({ type: "apply-color", kind, color: sw.dataset.c });
    closeAllSpPops();
  });
  // v0.8 #5: 字号/标题/对齐条目 —— 交互是侧边栏自己的弹层,修改内容与工具栏走【同一个 execEdit】
  document.querySelector(".edit-blocks").addEventListener("click", (e) => {
    const li = e.target.closest(".li");
    if (!li) return;
    if (li.dataset.kind === "style") sendToContent({ type: "edit-style", prop: li.dataset.prop, value: li.dataset.val });
    else sendToContent({ type: "edit-block", fmt: li.dataset.fmt, value: li.dataset.val });
    closeAllSpPops();
  });
  function applySpCustomSize(input) {
    const size = Number(input && input.value);
    if (!Number.isFinite(size) || size <= 0) return;
    sendToContent({ type: "edit-style", prop: "fontSize", value: String(size) + "px" });
    closeAllSpPops();
  }
  document.getElementById("sp-size-pop").addEventListener("keydown", (e) => {
    if (e.target.matches(".sp-size-custom input") && e.key === "Enter") { e.preventDefault(); applySpCustomSize(e.target); }
  });
  document.getElementById("sp-size-pop").addEventListener("change", (e) => {
    if (e.target.matches(".sp-size-custom input")) applySpCustomSize(e.target);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".sp-color-wrap, .sp-pop-wrap")) closeAllSpPops(); });

  // v0.8 #5: 评论 + B/I/U/S + 清除格式 —— 与页面浮动工具栏同一批工具、同一修改入口(execEdit)
  document.getElementById("act-comment").addEventListener("click", () => sendToContent({ type: "create-comment" }));
  ["bold", "italic", "underline", "strike"].forEach((cmd) => {
    document.getElementById("act-" + cmd).addEventListener("click", () => sendToContent({ type: "edit-toggle", cmd: cmd }));
  });
  document.getElementById("act-clear").addEventListener("click", () => sendToContent({ type: "edit-clear" }));

  // #1: 在线人数从评论区移到「身份入口」(账号浮层)显示,只显示人数、不显示姓名(评论卡片已有姓名)
  function renderPresence(users) {
    const el = document.getElementById("presence-count");
    if (!el) return;
    const n = (users && users.length) || 0;
    if (n > 0 && _sessionUser) {
      el.hidden = false;
      el.textContent = t("presence.count").replace("{n}", n);
    } else {
      el.hidden = true;
    }
  }

  // === 协同登录(Google 档3,后端地址烤在 config.js;飞书登录 UX 已下线,后端 /auth/lark/* 保留) ===
  const BACKEND = (window.HG_CONFIG && window.HG_CONFIG.backend) || "";
  const accountHost = document.getElementById("account-flow-host");
  let _sessionTeam = null;  // {id, name}:当前工作区
  let _sessionTeams = [];   // 用户全部工作区

  // 账号会话是设备状态：token、身份、当前团队和协同模式必须同存 storage.local。
  // 以前只把 token 放 local、其余身份放 sync；两个设备登录不同账号时会发生身份/令牌错配。
  // 非会话偏好（例如诊断开关）仍按原样留在 sync。
  const DEVICE_ACCOUNT_KEYS = new Set(["mode", "backend", "session_token", "user", "team_id", "team_name"]);
  function getCfg(keys) {
    return new Promise((r) => {
      const localKeys = keys.filter((k) => DEVICE_ACCOUNT_KEYS.has(k));
      const syncKeys = keys.filter((k) => !DEVICE_ACCOUNT_KEYS.has(k));
      const out = {};
      let pending = (syncKeys.length ? 1 : 0) + (localKeys.length ? 1 : 0);
      if (pending === 0) return r(out);
      if (syncKeys.length) chrome.storage.sync.get(syncKeys, (s) => { Object.assign(out, s); if (--pending === 0) r(out); });
      if (localKeys.length) chrome.storage.local.get(localKeys, (l) => {
        Object.assign(out, l);
        // 兼容旧版本仅本地保存 token 的已登录设备：不信任 sync 中的 user/team，
        // 只推导本设备可用的协同模式，真实身份之后仍由 /auth/me 或登录响应确认。
        if (keys.includes("mode") && !out.mode && out.session_token) out.mode = "synced";
        if (keys.includes("backend") && !out.backend) out.backend = BACKEND;
        if (--pending === 0) r(out);
      });
    });
  }
  function setCfg(obj) {
    return new Promise((r) => {
      const local = {}, sync = {};
      Object.entries(obj || {}).forEach(([key, value]) => (DEVICE_ACCOUNT_KEYS.has(key) ? local : sync)[key] = value);
      let pending = (Object.keys(local).length ? 1 : 0) + (Object.keys(sync).length ? 1 : 0);
      if (!pending) return r();
      if (Object.keys(local).length) chrome.storage.local.set(local, () => { if (--pending === 0) r(); });
      if (Object.keys(sync).length) chrome.storage.sync.set(sync, () => { if (--pending === 0) r(); });
    });
  }
  // 自动恢复登录是用户明确授权后的便利功能，不属于默认行为。
  // 邮箱不保存密码，只复用已有的本应用 session；Google 才额外复用 Google 会话。
  // 标记只存当前设备，且「退出登录」会撤销它。
  function getLocalCfg(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function setAutoLogin(enabled) {
    return new Promise((resolve) => {
      if (enabled) chrome.storage.local.set({ auto_login_enabled: true }, resolve);
      else chrome.storage.local.remove(["auto_login_enabled", "google_auto_login"], resolve);
    });
  }
  function saveLastActiveTeam(userId, teamId) {
    if (!userId || !teamId) return Promise.resolve();
    return new Promise((resolve) => {
      chrome.storage.local.set({ last_active_team: { user_id: userId, team_id: teamId } }, resolve);
    });
  }

  // reload=true:显式登录后刷页(让 content-script 切到 RemoteStore 加载协同批注)。
  // silentReauth(侧边栏打开时静默重登)传 false —— 不刷页,否则会冲掉刚弹出的编辑确认窗。
  async function applySession(r, reload = true, opts = {}) {
    const restoreLastTeam = opts.restoreLastTeam !== false;
    const teams = Array.isArray(r && r.teams) ? r.teams : [];
    // 登录时优先恢复「此账号」在本设备上上次激活的团队；绝不能把另一账号的 team_id 带过来。
    // 若没有历史团队，才使用后端按 joined_at 排好的首个团队作为默认值。
    let targetTeam = null;
    if (r && r.token && teams.length) {
      if (restoreLastTeam) {
        const [saved, local] = await Promise.all([
          getCfg(["user", "team_id"]),
          getLocalCfg(["last_active_team"]),
        ]);
        const last = local.last_active_team;
        if (last && r.user && last.user_id === r.user.id) {
          targetTeam = teams.find((tm) => tm.team_id === last.team_id) || null;
        }
        if (!targetTeam && saved.user && r.user && saved.user.id === r.user.id && saved.team_id) {
          targetTeam = teams.find((tm) => tm.team_id === saved.team_id) || null;
        }
      }
      if (!targetTeam && !r.team_id) targetTeam = teams[0];
    }
    if (targetTeam && targetTeam.team_id !== r.team_id) {
      try {
        const switched = await fetch(BACKEND + "/auth/switch-team", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + r.token },
          body: JSON.stringify({ team_id: targetTeam.team_id }),
        });
        if (switched.ok) {
          const j = await switched.json();
          r = Object.assign({}, r, j, { teams: teams });
        }
      } catch (e) { /* 保留服务端签发的 team_id，后续按正常路径处理 */ }
    }
    // 持久化团队身份(team_id + team_name):account sheet 展示当前团队 + 为后续团队切换预留。
    if (Array.isArray(r.teams)) _sessionTeams = r.teams; // Google 登录带全部团队;switch 复用现存列表
    const tm = (r.teams || []).find((x) => x.team_id === r.team_id);
    const teamName = r.team_name || (tm && tm.name) || "";
    _sessionTeam = r.team_id ? { id: r.team_id, name: teamName, role: tm && tm.role } : null;
    await setCfg({ mode: "synced", backend: BACKEND, session_token: r.token, user: r.user, team_id: r.team_id || "", team_name: teamName });
    await saveLastActiveTeam(r.user && r.user.id, r.team_id);
    _sessionUser = r.user;
    // 有团队时永远先进入团队首页。邀请链接只作为后续用户主动选择「加入团队」时的预填值，
    // 不能抢占登录后的默认落点。
    if (r.team_id) _pendingJoinIntent = false;
    setAccountFlow(r.team_id ? "home" : (_pendingJoinIntent ? "join" : "join-or-create"));
    if (reload) {
      const tab = await getActiveTab();
      if (tab && tab.id) { try { await chrome.tabs.reload(tab.id); } catch (e) { /* 非关键 */ } }
    }
  }
  // === 账号工作区流程(状态机:一次一个任务;渲染进 #account-flow-host)===
  let _accountFlow = "home";      // auth|email-login|email-register|invite-email|home|invite|members|rename|switch|join-or-create|join|create
  let _authEmailOpen = false;      // auth 首屏是否展开邮箱输入
  let _accountEmail = "";          // 邮箱(跨 auth 子状态)
  let _accountError = "";          // 当前页错误文案(红色)
  let _accountStatus = "";         // 当前页状态文案(主色;如登录中提示)
  let _inviteCopied = false;       // invite 页"已复制"
  let _membersCache = null;        // members 页:{items, isOwner} 或 null(未加载)
  let _confirmRemoveSub = "";      // 成员移除二次确认
  let _confirmTransferSub = "";    // 所有权转让二次确认
  let _accountBusy = false;        // 防重复提交(switch/join/create)
  let _emailBusy = false;          // 邮箱登录/注册请求中的防重复提交锁
  let _emailCodeSent = false;      // 注册:验证码已发送
  let _emailCooldown = 0;          // 发送验证码倒计时(秒)
  let _emailCooldownTimer = null;
  let _inviteEmailCodeSent = false; // 免密码入团:已发验证码
  let _inviteTeamName = "";         // 服务端验证后返回的团队名
  let _pendingJoinCode = "";       // join-code 消息预填的邀请码
  let _pendingJoinIntent = false;  // 仅邀请链接可置 true，防止旧 code 劫持常规登录
  let _joinRequestCopied = false;  // 加入页的邀请请求话术已复制
  let _rememberAutoLogin = false;  // 登录方式选择页的单次显式授权，跨邮箱子步骤保留

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function hostField(name) {
    const e = accountHost && accountHost.querySelector('[data-field="' + name + '"]');
    return e ? (e.value || "") : "";
  }
  function hostChecked(name) {
    const e = accountHost && accountHost.querySelector('[data-field="' + name + '"]');
    return !!(e && e.checked);
  }
  async function offerPasswordSave(formName) {
    // 仅在后端确认登录成功后请求浏览器保存。密码不会进入 extension storage，也不会发往额外服务。
    const form = accountHost && accountHost.querySelector('form[data-form="' + formName + '"]');
    if (!form || !window.PasswordCredential || !navigator.credentials || typeof navigator.credentials.store !== "function") return;
    try { await navigator.credentials.store(new window.PasswordCredential(form)); } catch (e) { /* 浏览器/扩展 origin 不支持时静默回退 */ }
  }
  const FLOW_TITLE = {
    home: "ws.t.home", invite: "ws.t.invite", members: "ws.t.members", rename: "ws.t.rename", switch: "ws.t.switch",
    "join-or-create": "ws.t.joc", join: "ws.t.join", create: "ws.t.create",
    auth: "ws.t.account", "email-login": "ws.t.account", "email-register": "ws.t.account", "invite-email": "ws.t.join",
  };
  function setAccountFlow(flow, opts) {
    const previousFlow = _accountFlow;
    _accountFlow = flow;
    if (flow !== "invite") _inviteCopied = false;
    if (flow !== "join") _joinRequestCopied = false;
    if (flow !== "members") _confirmRemoveSub = "";
    if (flow !== "members") _confirmTransferSub = "";
    // 错误/状态只属于触发它的那一步；切页后不能跟到下一项任务上。两者互斥(设其一清另一)。
    if (opts && opts.error) { _accountError = opts.error; _accountStatus = ""; }
    else if (opts && opts.status) { _accountStatus = opts.status; _accountError = ""; }
    else if (flow !== previousFlow) { _accountError = ""; _accountStatus = ""; }
    // 标题栏是唯一的返回导航：邮箱子步骤返回登录方式，首层则退出团队面板。
    const back = document.getElementById("account-back-btn");
    if (back) {
      const returnsToProviderChoice = !_sessionUser && (_authEmailOpen || flow === "email-login" || flow === "email-register" || flow === "invite-email");
      back.style.visibility = "visible";
      back.setAttribute("aria-label", returnsToProviderChoice ? t("ws.auth.back") : t("account.back"));
      back.title = returnsToProviderChoice ? t("ws.auth.back") : t("account.back");
    }
    renderAccountFlow();
    // checkbox 是可选偏好，不应抢占首焦点；先让用户落在当前步骤的主输入或主操作上。
    const f = accountHost && accountHost.querySelector(".af-input, .af-primary");
    if (f) { try { f.focus(); } catch (e) {} }
  }
  function renderAccountFlow() {
    if (!accountHost) return;
    const out = !_sessionUser;
    let flow = _accountFlow;
    if (out && ["auth", "email-login", "email-register", "invite-email"].indexOf(flow) < 0) flow = "auth";
    if (!out && ["auth", "email-login", "email-register", "invite-email"].indexOf(flow) >= 0) flow = "home";
    _accountFlow = flow;
    const views = {
      auth: viewAuth, "email-login": viewEmailLogin, "email-register": viewEmailRegister, "invite-email": viewInviteEmail,
      home: viewHome, profile: viewProfile, invite: viewInvite, members: viewMembers, rename: viewRename, switch: viewSwitch,
      "join-or-create": viewJoinOrCreate, join: viewJoin, create: viewCreate,
    };
    accountHost.innerHTML = (views[flow] || viewHome)();
  }
  function afErr() { return _accountError ? '<div class="af-error">' + esc(_accountError) + "</div>" : ""; }
  function afStatus() { return _accountStatus ? '<div class="af-status">' + esc(_accountStatus) + "</div>" : ""; }
  // --- 未登录 ---
  function viewAuth() {
    if (!_authEmailOpen) {
      return '<div class="af-page"><h2 class="af-h2">' + t("ws.auth.title") + "</h2>"
        + '<p class="af-copy">' + t("ws.auth.copy") + "</p>"
        + '<button class="af-primary" data-action="open-invite-email">' + t("inviteEmail.open") + "</button>"
        + '<button class="af-primary" data-action="google-login">' + t("login.google") + "</button>"
        + '<button class="af-secondary" data-action="open-email">' + t("ws.auth.email") + "</button>"
        + '<label class="af-check af-auto-login"><input type="checkbox" data-field="remember_auto_login"' + (_rememberAutoLogin ? " checked" : "") + '><span>' + t("login.rememberAuto") + "</span></label>" + afStatus() + afErr() + "</div>";
    }
    return '<form class="af-page" data-form="email-continue"><h2 class="af-h2">' + t("ws.auth.title") + "</h2>"
      + '<label class="af-label">' + t("login.emailPh") + "</label>"
      + '<input class="af-input" type="email" name="username" autocomplete="username" required data-field="email" placeholder="' + t("login.emailPh") + '" value="' + esc(_accountEmail) + '">'
      + '<button class="af-primary" type="submit">' + t("login.continue") + "</button>" + afErr() + "</form>";
  }
  function viewEmailLogin() {
    return '<form class="af-page" data-form="email-login"><p class="af-eyebrow">' + esc(_accountEmail) + "</p>"
      + '<h2 class="af-h2">' + t("ws.login.title") + "</h2>"
      + '<input class="af-input" type="email" name="username" autocomplete="username" required data-field="email" placeholder="' + t("login.emailPh") + '" value="' + esc(_accountEmail) + '">'
      + '<input class="af-input" type="password" name="password" autocomplete="current-password" required data-field="password" placeholder="' + t("login.pwPh") + '">'
      + '<button class="af-primary" type="submit">' + t("login.emailLogin") + "</button>" + afErr() + "</form>";
  }
  function viewEmailRegister() {
    let body, form;
    if (_emailCodeSent) {
      form = "email-register";
      body = '<input class="af-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-field="code" placeholder="' + t("login.codePh") + '">'
        + '<button class="af-primary" type="submit">' + t("login.emailRegister") + "</button>"
        + '<button class="af-link" type="button" data-action="resend-code">' + (_emailCooldown > 0 ? t("login.resendIn").replace("{n}", _emailCooldown) : t("ws.register.resend")) + "</button>";
    } else {
      form = "email-register-start";
      body = '<input class="af-input" type="email" name="username" autocomplete="username" required data-field="email" placeholder="' + t("login.emailPh") + '" value="' + esc(_accountEmail) + '">'
        + '<input class="af-input" type="password" name="new-password" autocomplete="new-password" required data-field="password" placeholder="' + t("login.pwPh") + '">'
        + '<button class="af-primary" type="submit">' + t("login.sendCode") + "</button>";
    }
    return '<form class="af-page" data-form="' + form + '"><p class="af-eyebrow">' + esc(_accountEmail) + "</p>"
      + '<h2 class="af-h2">' + t("ws.register.title") + "</h2>"
      + '<p class="af-copy">' + t("ws.register.copy") + "</p>" + body + afErr() + "</form>";
  }
  function viewInviteEmail() {
    let body, form;
    if (_inviteEmailCodeSent) {
      form = "invite-email-verify";
      body = (_inviteTeamName ? '<p class="af-status">' + esc(t("inviteEmail.team").replace("{team}", _inviteTeamName)) + "</p>" : "")
        + '<input class="af-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required data-field="code" placeholder="' + t("login.codePh") + '">'
        + '<button class="af-primary" type="submit"' + (_emailBusy ? " disabled" : "") + '>' + t("inviteEmail.verify") + "</button>"
        + '<button class="af-link" type="button" data-action="invite-email-resend">' + (_emailCooldown > 0 ? t("login.resendIn").replace("{n}", _emailCooldown) : t("ws.register.resend")) + "</button>";
    } else {
      form = "invite-email-request";
      body = '<input class="af-input" type="text" required data-field="invite_code" placeholder="' + t("ws.join.ph") + '" value="' + esc(_pendingJoinCode) + '">'
        + '<input class="af-input" type="email" autocomplete="email" required data-field="email" placeholder="' + t("login.emailPh") + '" value="' + esc(_accountEmail) + '">'
        + '<button class="af-primary" type="submit"' + (_emailBusy ? " disabled" : "") + '>' + t("inviteEmail.send") + "</button>";
    }
    return '<form class="af-page" data-form="' + form + '"><p class="af-eyebrow">' + t("ws.t.join") + "</p>"
      + '<h2 class="af-h2">' + t("inviteEmail.title") + "</h2>"
      + '<p class="af-copy">' + t("inviteEmail.copy") + "</p>" + body + afErr() + "</form>";
  }
  // --- 已登录 ---
  // 行尾右箭头:SVG 描边图标(16px),替代原「›」字符(太小、各平台渲染不一)
  const AF_CHEV = '<svg class="af-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  function viewHome() {
    const u = _sessionUser || {}, team = _sessionTeam || {};
    const multi = _sessionTeams.length > 1;
    // 无上传团队图标的入口 → 不再展示工作区卡片,标题只显示团队自定义名称(无名字时兜底「未命名团队」)。
    // 多团队时的切换入口从卡片右上角迁到列表行(与成员/加入创建同级)。
    return '<div class="af-page"><p class="af-eyebrow">' + esc(u.name || u.id || "") + "</p>"
      + '<h2 class="af-h2">' + esc(team.name || t("ws.unnamed")) + "</h2>"
      + '<p class="af-copy">' + t("ws.home.copy") + "</p>"
      + '<button class="af-primary" data-action="go-invite">' + t("ws.home.invite") + "</button>"
      + '<div class="af-list">'
      + '<button class="af-row" data-action="go-members"><span>' + t("ws.t.members") + "</span>" + AF_CHEV + "</button>"
      + (team.role === "owner" ? '<button class="af-row" data-action="go-rename"><span>' + t("ws.t.rename") + "</span>" + AF_CHEV + "</button>" : "")
      + (multi ? '<button class="af-row" data-action="go-switch"><span>' + t("ws.t.switch") + "</span>" + AF_CHEV + "</button>" : "")
      + '<button class="af-row" data-action="go-joc"><span>' + t("ws.home.joc") + "</span>" + AF_CHEV + "</button>"
      + '<button class="af-row af-danger" data-action="logout"><span>' + t("state.logout") + "</span>" + AF_CHEV + "</button>"
      + "</div></div>";
  }
  function viewProfile() {
    const u = _sessionUser || {};
    return '<form class="af-page" data-form="rename-profile"><p class="af-eyebrow">' + esc(u.name || u.id || "") + '</p>'
      + '<h2 class="af-h2">' + t("ws.profile.title") + '</h2><p class="af-copy">' + t("ws.profile.copy") + '</p>'
      + '<label class="af-label" for="profile-name-input">' + t("ws.profile.label") + '</label>'
      + '<input id="profile-name-input" class="af-input" type="text" maxlength="100" required data-field="name" placeholder="' + t("ws.profile.ph") + '" value="' + esc(u.name || "") + '">'
      + '<button class="af-primary" type="submit"' + (_accountBusy ? " disabled" : "") + '>' + t("ws.profile.action") + '</button>' + afErr() + '</form>';
  }
  function viewInvite() {
    const team = _sessionTeam || {};
    const toast = _inviteCopied ? '<div class="af-toast">' + t("ws.invite.copied") + "</div>" : "";
    const fallback = !_inviteCopied && _accountError
      ? '<div class="af-fallback"><span>' + t("ws.invite.fallback") + '</span><input class="af-input" type="text" readonly value="' + esc(_accountError) + '"></div>'
      : "";
    return '<div class="af-page"><p class="af-eyebrow">' + esc(team.name || "") + "</p>"
      + '<h2 class="af-h2">' + t("ws.t.invite") + "</h2>"
      + '<p class="af-copy">' + t("ws.invite.copy") + "</p>" + toast + fallback
      + '<button class="af-primary" data-action="gen-invite">' + t("ws.invite.gen") + "</button>"
      + '<p class="af-note">' + t("ws.invite.note") + "</p></div>";
  }
  function viewMembers() {
    const team = _sessionTeam || {};
    if (_membersCache === null) return '<div class="af-page"><h2 class="af-h2">' + t("ws.t.members") + '</h2><p class="af-copy">' + t("ws.loading") + "</p></div>";
    const items = (_membersCache && _sessionMembers_items()) || [];
    if (!items.length) return '<div class="af-page"><p class="af-eyebrow">' + esc(team.name || "") + '</p><h2 class="af-h2">' + t("ws.t.members") + '</h2><p class="af-copy">' + t("ws.members.empty") + "</p></div>";
    const meId = _sessionUser && _sessionUser.id;
    const rows = items.map(function (m) {
      const name = esc(m.name || m.sub), role = m.role === "owner" ? t("ws.members.owner") : t("ws.members.member");
      const initial = esc((m.name || m.sub || "?").charAt(0).toUpperCase());
      let right = "";
      if (m.sub === meId) {
        right = '<button class="af-link af-transfer" data-action="go-profile">' + t("ws.t.profile") + "</button>";
      } else if (_membersCache.isOwner) {
        right = (_confirmTransferSub === m.sub)
          ? '<span class="af-confirm af-transfer-confirm"><span class="af-transfer-note">' + t("ws.members.transferNote") + '</span><span><button class="af-link af-transfer" data-action="confirm-transfer" data-sub="' + esc(m.sub) + '">' + t("ws.members.confirmTransfer") + "</button>"
            + '<button class="af-link" data-action="cancel-transfer">' + t("ws.members.cancel") + "</button></span></span>"
          : (_confirmRemoveSub === m.sub)
          ? '<span class="af-confirm"><button class="af-link af-danger" data-action="confirm-remove" data-sub="' + esc(m.sub) + '">' + t("ws.members.confirmRemove") + "</button>"
            + '<button class="af-link" data-action="cancel-remove">' + t("ws.members.cancel") + "</button></span>"
          : '<span class="af-member-actions"><button class="af-link af-transfer" data-action="transfer-owner" data-sub="' + esc(m.sub) + '">' + t("ws.members.transfer") + "</button>"
            + '<button class="af-link af-danger" data-action="remove-member" data-sub="' + esc(m.sub) + '">' + t("ws.members.remove") + "</button></span>";
      }
      return '<div class="af-member"><span class="af-avatar">' + initial + "</span>"
        + '<div class="af-mtext">' + name + "<small>" + role + "</small></div>" + right + "</div>";
    }).join("");
    return '<div class="af-page"><p class="af-eyebrow">' + esc(team.name || "") + '</p><h2 class="af-h2">' + t("ws.t.members") + '</h2>'
      + '<p class="af-copy">' + t("ws.members.count").replace("{n}", items.length) + "</p>" + rows + afErr() + "</div>";
  }
  function viewRename() {
    const team = _sessionTeam || {};
    return '<form class="af-page" data-form="rename-team"><p class="af-eyebrow">' + esc(team.name || "") + '</p>'
      + '<h2 class="af-h2">' + t("ws.rename.title") + '</h2><p class="af-copy">' + t("ws.rename.copy") + '</p>'
      + '<label class="af-label" for="team-name-input">' + t("ws.create.ph") + '</label>'
      + '<input id="team-name-input" class="af-input" type="text" maxlength="100" required data-field="team_name" placeholder="' + t("ws.rename.ph") + '" value="' + esc(team.name || "") + '">'
      + '<button class="af-primary" type="submit"' + (_accountBusy ? " disabled" : "") + '>' + t("ws.rename.action") + '</button>' + afErr() + '</form>';
  }
  function _sessionMembers_items() { return (_membersCache && _membersCache.items) || []; }
  function viewSwitch() {
    const rows = _sessionTeams.map(function (tm) {
      const cur = _sessionTeam && tm.team_id === _sessionTeam.id;
      return '<button class="af-choice" data-action="switch-team" data-team="' + esc(tm.team_id) + '"' + (_accountBusy ? " disabled" : "") + ">"
        + '<span class="af-choice-icon">' + esc((tm.name || "?").charAt(0).toUpperCase()) + "</span>"
        + '<span class="af-choice-text"><b>' + esc(tm.name || tm.team_id) + "</b>"
        + (cur ? "<span>" + t("ws.switch.current") + "</span>" : "") + "</span></button>";
    }).join("");
    return '<div class="af-page"><p class="af-eyebrow">' + t("ws.switch.eyebrow") + '</p><h2 class="af-h2">' + t("ws.t.switch") + "</h2>" + rows
      + '<button class="af-row" data-action="go-joc"><span>' + t("ws.home.joc") + "</span>" + AF_CHEV + "</button></div>";
  }
  function viewJoinOrCreate() {
    return '<div class="af-page"><p class="af-eyebrow">' + t("ws.t.home") + '</p><h2 class="af-h2">' + t("ws.joc.title") + "</h2>"
      + '<button class="af-choice" data-action="go-join"><span class="af-choice-icon">↗</span><span class="af-choice-text"><b>' + t("ws.join.title") + '</b><span>' + t("ws.join.sub") + "</span></span></button>"
      + '<button class="af-choice" data-action="go-create"><span class="af-choice-icon">＋</span><span class="af-choice-text"><b>' + t("ws.create.title") + '</b><span>' + t("ws.create.sub") + "</span></span></button></div>";
  }
  function viewJoin() {
    const exampleUrl = new URL("/join?code=inv_a1b2c3d4e5f6", BACKEND || "https://deuce.monster").href;
    const request = t("ws.join.request");
    return '<div class="af-page"><p class="af-eyebrow">' + t("ws.t.join") + '</p><h2 class="af-h2">' + t("ws.join.title") + '</h2><p class="af-copy">' + t("ws.join.copy") + "</p>"
      + '<input class="af-input" type="text" data-field="invite_code" placeholder="' + t("ws.join.ph") + '" value="' + esc(_pendingJoinCode) + '">'
      + '<button class="af-primary" data-action="join-workspace"' + (_accountBusy ? " disabled" : "") + ">" + t("ws.join.action") + "</button>"
      + '<div class="af-join-help"><p class="af-help-label">' + t("ws.join.exampleLabel") + '</p><code class="af-example-url">' + esc(exampleUrl) + '</code>'
      + '<p class="af-help-label">' + t("ws.join.requestLabel") + '</p><p class="af-request-copy">' + esc(request) + '</p>'
      + '<button class="af-secondary af-copy-request" data-action="copy-join-request">' + t(_joinRequestCopied ? "ws.join.requestCopied" : "ws.join.requestCopy") + '</button></div>'
      + afErr() + "</div>";
  }
  function viewCreate() {
    return '<div class="af-page"><p class="af-eyebrow">' + t("ws.t.create") + '</p><h2 class="af-h2">' + t("ws.create.title") + '</h2><p class="af-copy">' + t("ws.create.copy") + "</p>"
      + '<input class="af-input" type="text" data-field="team_name" placeholder="' + t("ws.create.ph") + '">'
      + '<button class="af-primary" data-action="create-workspace"' + (_accountBusy ? " disabled" : "") + ">" + t("ws.create.action") + "</button>" + afErr() + "</div>";
  }
  function showLoggedIn(user) { _sessionUser = user; renderCards(_lastItems); setAccountFlow(_sessionTeam ? "home" : "join-or-create"); }
  function refreshLoginState() { if (_sessionUser) renderAccountFlow(); }
  async function _authFetch(path, init) {
    const cfg = await getCfg(["session_token"]);
    const headers = Object.assign({ Authorization: "Bearer " + cfg.session_token }, (init && init.headers) || {});
    return fetch(BACKEND + path, Object.assign({}, init, { headers }));
  }
  // --- flow 动作 / 数据 ---
  async function genInviteAndCopy() {
    try {
      const r = await _authFetch("/auth/invites", { method: "POST" });
      const j = await r.json();
      if (!j.join_url) { showToast(t("team.inviteFail")); return; }
      const url = new URL(j.join_url, BACKEND || "https://deuce.monster").href;
      try { await navigator.clipboard.writeText(url); _inviteCopied = true; _accountError = ""; HGAnalytics.track("invite_copied"); }
      catch (e) { _accountError = url; }  // 剪贴板失败 → fallback 显示只读链接
      renderAccountFlow();
    } catch (e) { showToast(t("team.inviteFail")); }
  }
  async function loadMembersInto() {
    const teamId = _sessionTeam && _sessionTeam.id;
    _membersCache = null; renderAccountFlow();
    if (!teamId) return;
    try {
      const r = await _authFetch("/auth/teams/" + teamId + "/members");
      if (!r.ok) { _membersCache = { items: [], isOwner: false }; renderAccountFlow(); return; }
      const items = (await r.json()).items || [];
      const meId = _sessionUser && _sessionUser.id;
      _membersCache = { items: items, isOwner: items.some((m) => m.sub === meId && m.role === "owner") };
    } catch (e) { _membersCache = { items: [], isOwner: false }; }
    renderAccountFlow();
  }
  async function removeMemberInline(sub) {
    const teamId = _sessionTeam && _sessionTeam.id;
    try {
      const r = await _authFetch("/auth/teams/" + teamId + "/members/" + encodeURIComponent(sub), { method: "DELETE" });
      if (r.ok) { _confirmRemoveSub = ""; await loadMembersInto(); }
      else { showToast(t("team.removeFail")); }
    } catch (e) { showToast(t("team.removeFail")); }
  }
  async function transferOwnership(sub) {
    if (_accountBusy) return;
    const teamId = _sessionTeam && _sessionTeam.id;
    if (!teamId || !sub) return;
    _accountBusy = true; renderAccountFlow();
    try {
      const r = await _authFetch("/auth/teams/" + encodeURIComponent(teamId) + "/transfer-ownership",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: sub }) });
      const j = await r.json();
      if (!r.ok) { _accountBusy = false; _confirmTransferSub = ""; setAccountFlow("members", { error: (j && j.detail) || t("ws.members.transferFail") }); return; }
      _sessionTeam = Object.assign({}, _sessionTeam, { role: "member" });
      _sessionTeams = _sessionTeams.map((tm) => tm.team_id === teamId ? Object.assign({}, tm, { role: "member" }) : tm);
      _confirmTransferSub = "";
      _accountBusy = false;
      await loadMembersInto();
      showToast(t("ws.members.transferOk"));
    } catch (e) { _accountBusy = false; _confirmTransferSub = ""; setAccountFlow("members", { error: t("ws.members.transferFail") }); }
  }
  async function joinWorkspace() {
    if (_accountBusy) return;
    const code = hostField("invite_code").trim();
    if (!code) { setAccountFlow("join", { error: t("ws.join.fillCode") }); return; }
    // 失败或网络重试时保留用户刚输入的码；join-code 预填与手输走同一份状态。
    _pendingJoinCode = code;
    _accountBusy = true; renderAccountFlow();
    try {
      const r = await _authFetch("/auth/teams/join",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite_code: code }) });
      const j = await r.json();
      if (!r.ok) { _accountBusy = false; setAccountFlow("join", { error: (j && j.detail) || t("ws.join.fail") }); return; }
      _pendingJoinCode = "";
      await applySession({ token: j.token, user: j.user, team_id: j.team_id, team_name: j.team_name, teams: j.teams }, false, { restoreLastTeam: false });
      HGAnalytics.track("join_workspace");
      _accountBusy = false; showToast(t("ws.join.ok")); broadcastTeamChanged();
    } catch (e) { _accountBusy = false; setAccountFlow("join", { error: t("ws.join.fail") }); }
  }
  async function copyJoinRequest() {
    try {
      await navigator.clipboard.writeText(t("ws.join.request"));
      _joinRequestCopied = true;
      renderAccountFlow();
    } catch (e) { setAccountFlow("join", { error: t("ws.join.requestCopyFail") }); }
  }
  async function createWorkspace() {
    if (_accountBusy) return;
    const name = hostField("team_name").trim();
    if (!name) { setAccountFlow("create", { error: t("ws.create.fillName") }); return; }
    _accountBusy = true; renderAccountFlow();
    try {
      const r = await _authFetch("/auth/teams",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) });
      const j = await r.json();
      if (!r.ok) { _accountBusy = false; setAccountFlow("create", { error: (j && j.detail) || t("ws.create.fail") }); return; }
      await applySession({ token: j.token, user: j.user, team_id: j.team_id, team_name: j.team_name, teams: j.teams }, false, { restoreLastTeam: false });
      HGAnalytics.track("create_workspace");
      _accountBusy = false; showToast(t("ws.create.ok")); broadcastTeamChanged();
    } catch (e) { _accountBusy = false; setAccountFlow("create", { error: t("ws.create.fail") }); }
  }
  async function renameTeam() {
    if (_accountBusy) return;
    const teamId = _sessionTeam && _sessionTeam.id;
    const name = hostField("team_name").trim();
    if (!teamId) { setAccountFlow("home"); return; }
    if (!name) { setAccountFlow("rename", { error: t("ws.rename.fillName") }); return; }
    _accountBusy = true; renderAccountFlow();
    try {
      const r = await _authFetch("/auth/teams/" + encodeURIComponent(teamId),
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) });
      const j = await r.json();
      if (!r.ok) { _accountBusy = false; setAccountFlow("rename", { error: (j && j.detail) || t("ws.rename.fail") }); return; }
      _sessionTeams = _sessionTeams.map((tm) => tm.team_id === teamId ? Object.assign({}, tm, { name: j.name }) : tm);
      _sessionTeam = Object.assign({}, _sessionTeam, { name: j.name });
      await setCfg({ team_name: j.name });
      _accountBusy = false;
      setAccountFlow("home");
      showToast(t("ws.rename.ok"));
    } catch (e) { _accountBusy = false; setAccountFlow("rename", { error: t("ws.rename.fail") }); }
  }
  async function renameProfile() {
    if (_accountBusy) return;
    const name = hostField("name").trim();
    if (!name) { setAccountFlow("profile", { error: t("ws.profile.fillName") }); return; }
    _accountBusy = true; renderAccountFlow();
    try {
      const r = await _authFetch("/auth/me", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name })
      });
      const j = await r.json();
      if (!r.ok) { _accountBusy = false; setAccountFlow("profile", { error: (j && j.detail) || t("ws.profile.fail") }); return; }
      _sessionUser = Object.assign({}, _sessionUser, { name: j.name });
      await setCfg({ user: _sessionUser });
      _accountBusy = false;
      setAccountFlow("home");
      showToast(t("ws.profile.ok"));
    } catch (e) { _accountBusy = false; setAccountFlow("profile", { error: t("ws.profile.fail") }); }
  }
  async function doGoogleLogin() {
    HGAnalytics.track("login_start", { method: "google" });
    _rememberAutoLogin = hostChecked("remember_auto_login");
    setAccountFlow("auth", { status: t("login.googleLoading") });
    try {
      const r = await Login.googleStart({ interactive: true });
      if (r.token) {
        // 只在成功完成一次用户主动登录后保存授权；失败/取消不改变原设置。
        await setAutoLogin(_rememberAutoLogin);
        await applySession(r);
        HGAnalytics.track("login_success", { method: "google" });
        showToast(t("login.googleSuccess"));
      }
      else { setAccountFlow("auth", { error: t("login.okJoinCreate") }); }
    } catch (e) { trackLoginFailure("google", (e && e.stage) || "oauth_flow", e); setAccountFlow("auth", { error: t("login.fail") + (e && e.message ? e.message : e) }); }
  }
  const LOGIN_FAILURE_CODES = new Set(["GOOGLE_CONFIG_MISSING", "OAUTH_FLOW_FAILED", "OAUTH_TOKEN_MISSING", "INVALID_REQUEST", "UNAUTHORIZED", "CONFLICT", "INVALID_INPUT", "RATE_LIMITED", "HTTP_ERROR"]);
  function trackLoginFailure(method, stage, error) {
    const code = error && LOGIN_FAILURE_CODES.has(error.code) ? error.code : "UNKNOWN";
    let appVersion = "";
    try { appVersion = chrome.runtime.getManifest().version || ""; } catch (e) {}
    HGAnalytics.track("login_failed", { method: method, stage: stage, code: code, app_version: appVersion });
  }
  async function emailContinue() {
    _accountEmail = hostField("email").trim();
    if (!_accountEmail || _accountEmail.indexOf("@") < 0) { setAccountFlow("auth", { error: t("login.emailFillEmail") }); return; }
    if (_emailBusy) return;
    HGAnalytics.track("login_start", { method: "email" });
    _emailBusy = true;
    try {
      const p = await Login.emailProbe(BACKEND, _accountEmail);
      _emailBusy = false;
      setAccountFlow(p && p.exists ? "email-login" : "email-register");
    } catch (e) { _emailBusy = false; trackLoginFailure("email", "email_probe", e); setAccountFlow("auth", { error: t("login.fail") + (e && e.message ? e.message : e) }); }
  }
  async function emailLoginAction() {
    _accountEmail = hostField("email").trim() || _accountEmail;
    const pw = hostField("password");
    if (!_accountEmail || _accountEmail.indexOf("@") < 0) { setAccountFlow("email-login", { error: t("login.emailFillEmail") }); return; }
    if (!pw) { setAccountFlow("email-login", { error: t("login.emailFillPw") }); return; }
    if (_emailBusy) return;
    _emailBusy = true;
    try {
      const r = await Login.emailLogin(BACKEND, _accountEmail, pw);
      await offerPasswordSave("email-login");
      await setAutoLogin(_rememberAutoLogin);
      await applySession(r);
      _emailBusy = false;
      HGAnalytics.track("login_success", { method: "email" }); showToast(t("login.emailSuccess"));
    } catch (e) { _emailBusy = false; trackLoginFailure("email", "email_login", e); setAccountFlow("email-login", { error: t("login.fail") + (e && e.message ? e.message : e) }); }
  }
  function updateEmailCooldownLabel() {
    if (!accountHost) return;
    const label = _emailCooldown > 0
      ? t("login.resendIn").replace("{n}", _emailCooldown)
      : t("ws.register.resend");
    accountHost.querySelectorAll('[data-action="resend-code"], [data-action="invite-email-resend"]').forEach((button) => {
      button.textContent = label;
    });
  }
  function startEmailCooldown(n) {
    _emailCooldown = n;
    if (_emailCooldownTimer) clearInterval(_emailCooldownTimer);
    updateEmailCooldownLabel();
    _emailCooldownTimer = setInterval(() => {
      _emailCooldown = Math.max(0, _emailCooldown - 1);
      if (_emailCooldown <= 0) { clearInterval(_emailCooldownTimer); _emailCooldownTimer = null; }
      // 只更新倒计时按钮，不重建整个表单。重建会每秒替换验证码输入框，
      // 造成焦点丢失、已输入内容清空，最终无法提交。
      if (_accountFlow === "email-register" || _accountFlow === "invite-email") updateEmailCooldownLabel();
    }, 1000);
  }
  async function sendCodeAction() {
    _accountEmail = hostField("email").trim() || _accountEmail;
    const pw = hostField("password");
    if (!_accountEmail || _accountEmail.indexOf("@") < 0) { setAccountFlow("email-register", { error: t("login.emailFillEmail") }); return; }
    if (pw.length < 8) { setAccountFlow("email-register", { error: t("login.emailFillPw") }); return; }
    if (_emailBusy) return;
    _emailBusy = true;
    try {
      await Login.emailRegister(BACKEND, _accountEmail, pw);
      _emailBusy = false;
      _emailCodeSent = true; _accountError = ""; startEmailCooldown(60); renderAccountFlow();
      showToast(t("login.codeSent"));
    } catch (e) { _emailBusy = false; trackLoginFailure("email", "email_register", e); setAccountFlow("email-register", { error: t("login.fail") + (e && e.message ? e.message : e) }); }
  }
  async function resendCodeAction() {
    if (_emailBusy || _emailCooldown > 0) return;
    _emailBusy = true;
    try {
      await Login.emailResend(BACKEND, _accountEmail);
      _emailBusy = false;
      _accountError = ""; startEmailCooldown(60); renderAccountFlow();
      showToast(t("login.codeSent"));
    } catch (e) { _emailBusy = false; trackLoginFailure("email", "email_resend", e); setAccountFlow("email-register", { error: t("login.fail") + (e && e.message ? e.message : e) }); }
  }
  async function emailRegisterAction() {
    const code = hostField("code").trim();
    if (!code) { setAccountFlow("email-register", { error: t("login.emailFillCode") }); return; }
    const inv = hostField("invite_code").trim();
    if (_emailBusy) return;
    _emailBusy = true;
    try {
      const r = await Login.emailVerify(BACKEND, _accountEmail, code, inv, "");
      await setAutoLogin(_rememberAutoLogin);
      await applySession(r);
      _emailBusy = false;
      showToast(t("login.emailSuccess"));
    } catch (e) { _emailBusy = false; trackLoginFailure("email", "email_verify", e); setAccountFlow("email-register", { error: t("login.fail") + (e && e.message ? e.message : e) }); }
  }
  async function inviteEmailRequestAction() {
    _pendingJoinCode = hostField("invite_code").trim() || _pendingJoinCode;
    _accountEmail = hostField("email").trim() || _accountEmail;
    if (!_pendingJoinCode) { setAccountFlow("invite-email", { error: t("ws.join.fillCode") }); return; }
    if (!_accountEmail || _accountEmail.indexOf("@") < 0) { setAccountFlow("invite-email", { error: t("login.emailFillEmail") }); return; }
    if (_emailBusy) return;
    HGAnalytics.track("login_start", { method: "invite_email" });
    _emailBusy = true; renderAccountFlow();
    try {
      const r = await Login.inviteEmailRequest(BACKEND, _accountEmail, _pendingJoinCode);
      _inviteTeamName = (r && r.team_name) || "";
      _inviteEmailCodeSent = true;
      _emailBusy = false; _accountError = ""; startEmailCooldown(60); renderAccountFlow();
      showToast(t("login.codeSent"));
    } catch (e) {
      _emailBusy = false;
      trackLoginFailure("invite_email", "invite_email_request", e);
      setAccountFlow("invite-email", { error: t("login.fail") + (e && e.message ? e.message : e) });
    }
  }
  async function inviteEmailVerifyAction() {
    const code = hostField("code").trim();
    if (!code) { setAccountFlow("invite-email", { error: t("login.emailFillCode") }); return; }
    if (_emailBusy) return;
    _emailBusy = true; renderAccountFlow();
    try {
      const r = await Login.inviteEmailVerify(BACKEND, _accountEmail, _pendingJoinCode, code);
      // 邀请加入的目标就是免反复登录；验证一次后默认在本设备恢复已有 session。
      await setAutoLogin(true);
      await applySession(r, true, { restoreLastTeam: false });
      _emailBusy = false; _inviteEmailCodeSent = false; _pendingJoinCode = ""; _pendingJoinIntent = false;
      HGAnalytics.track("login_success", { method: "invite_email" });
      HGAnalytics.track("join_workspace");
      showToast(t("inviteEmail.success"));
    } catch (e) {
      _emailBusy = false;
      trackLoginFailure("invite_email", "invite_email_verify", e);
      setAccountFlow("invite-email", { error: t("login.fail") + (e && e.message ? e.message : e) });
    }
  }
  async function inviteEmailResendAction() {
    if (_emailBusy || _emailCooldown > 0) return;
    _inviteEmailCodeSent = false;
    await inviteEmailRequestAction();
  }
  async function switchTeam(teamId) {
    try {
      const r = await _authFetch("/auth/switch-team",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ team_id: teamId }) });
      if (!r.ok) throw new Error("switch " + r.status);
      const j = await r.json();
      await applySession({ token: j.token, user: j.user, team_id: j.team_id, team_name: j.team_name, teams: _sessionTeams }, false, { restoreLastTeam: false });
      HGAnalytics.track("workspace_switch");
      showToast(t("team.switched"));
      broadcastTeamChanged(); // 所有协同页重载(切到新团队的批注/SSE)
    } catch (e) { showToast(t("team.switchFail")); }
  }
  function broadcastTeamChanged() {
    chrome.tabs.query({}, (tabs) => {
      for (const tb of tabs || []) {
        if (tb && tb.id != null) { try { chrome.tabs.sendMessage(tb.id, { type: "team-changed" }).catch(() => {}); } catch (e) {} }
      }
    });
  }
  async function doLogout() {
    const cfg = await getCfg(["session_token"]);
    if (cfg.session_token) {
      try { await fetch(BACKEND + "/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + cfg.session_token } }); } catch (e) { /* 忽略 */ }
    }
    await new Promise((r) => {
      let p = 2; const done = () => { if (--p === 0) r(); };
      // 用户主动退出 = 同时撤销本应用 session 和曾授予的自动恢复登录授权。
      chrome.storage.local.remove(["session_token", "user", "mode", "team_id", "team_name", "auto_login_enabled", "google_auto_login"], done);
      // 清除旧版遗留的跨设备身份字段，避免降级/旧页面继续读取到另一设备账号。
      chrome.storage.sync.remove(["user", "mode", "team_id", "team_name"], done);
    });
    _sessionUser = null;
    _sessionTeam = null; _sessionTeams = [];
    _authEmailOpen = false; _accountEmail = ""; _emailCodeSent = false; _inviteEmailCodeSent = false; _inviteTeamName = ""; _membersCache = null; _pendingJoinCode = ""; _pendingJoinIntent = false; _rememberAutoLogin = false; _accountStatus = "";
    renderPresence([]); // 登出:清掉在线人数
    setAccountFlow("auth");
  }

  // flow 事件代理(单一 handler:data-go 路由 + data-action 动作)
  // 原生 form submit 统一承接按钮点击和 Enter；保留语义化表单，让 Chrome Password Manager 识别凭据字段。
  if (accountHost) accountHost.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    switch (form.dataset.form) {
      case "email-continue": emailContinue(); break;
      case "email-login": emailLoginAction(); break;
      case "email-register-start": sendCodeAction(); break;
      case "email-register": emailRegisterAction(); break;
      case "invite-email-request": inviteEmailRequestAction(); break;
      case "invite-email-verify": inviteEmailVerifyAction(); break;
      case "rename-team": renameTeam(); break;
      case "rename-profile": renameProfile(); break;
    }
  });
  if (accountHost) accountHost.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { setAccountFlow(go.dataset.go); return; }
    const actEl = e.target.closest("[data-action]");
    if (!actEl) return;
    const a = actEl.dataset.action;
    const GOTO = { "go-profile": "profile", "go-invite": "invite", "go-members": "members", "go-rename": "rename", "go-switch": "switch",
      "go-joc": "join-or-create", "go-join": "join", "go-create": "create" };
    if (GOTO[a]) {
      // 只有邀请链接带来的码才可预填；普通入口和已放弃的手输码都从空白输入开始。
      if (a === "go-join") {
        const hasInvitePrefill = _pendingJoinIntent || !!_pendingJoinCode;
        _pendingJoinIntent = false;
        if (!hasInvitePrefill) _pendingJoinCode = "";
      }
      setAccountFlow(GOTO[a]);
      if (a === "go-members" && _membersCache === null) loadMembersInto();
      return;
    }
    switch (a) {
      case "google-login": doGoogleLogin(); break;
      case "open-invite-email": _inviteEmailCodeSent = false; _inviteTeamName = ""; setAccountFlow("invite-email"); break;
      case "open-email": _rememberAutoLogin = hostChecked("remember_auto_login"); _authEmailOpen = true; setAccountFlow("auth"); break;
      case "back-auth": _authEmailOpen = false; setAccountFlow("auth"); break;
      case "email-continue": emailContinue(); break;
      case "email-login": emailLoginAction(); break;
      case "send-code":
      case "resend-code": resendCodeAction(); break;
      case "email-register": emailRegisterAction(); break;
      case "invite-email-resend": inviteEmailResendAction(); break;
      case "gen-invite": genInviteAndCopy(); break;
      case "remove-member": _confirmRemoveSub = actEl.dataset.sub || ""; renderAccountFlow(); break;
      case "cancel-remove": _confirmRemoveSub = ""; renderAccountFlow(); break;
      case "confirm-remove": removeMemberInline(actEl.dataset.sub || ""); break;
      case "transfer-owner": _confirmRemoveSub = ""; _confirmTransferSub = actEl.dataset.sub || ""; renderAccountFlow(); break;
      case "cancel-transfer": _confirmTransferSub = ""; renderAccountFlow(); break;
      case "confirm-transfer": transferOwnership(actEl.dataset.sub || ""); break;
      case "switch-team": switchTeam(actEl.dataset.team || ""); break;
      case "join-workspace": joinWorkspace(); break;
      case "copy-join-request": copyJoinRequest(); break;
      case "create-workspace": createWorkspace(); break;
      case "logout": doLogout(); break;
    }
  });
  // 邀请链接只在未登录时作为认证上下文使用。已登录用户把 /join 页面当普通网页打开时，
  // 绝不能让 content-script 的异步消息改写当前团队或把 Side Panel 强制跳到加入页。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "join-code" && msg.code) {
      if (_sessionUser) return;
      _pendingJoinCode = msg.code;
      _pendingJoinIntent = true;
      enterAccountView({ preserveJoinCode: true });
      setAccountFlow("invite-email");
    }
  });

  // === bridge 事件处理(抽成函数,供「实时分发」与「切 tab 后回放缓存的终态事件」复用)===
  // 终态/预览事件发给非当前 tab 时先缓存,切回该 tab 时回放 —— 修「生成中切 tab 丢失结果/失败原因」。
  const _pendingTabEvents = new Map(); // tabId -> 切 tab 期间到达的终态/预览事件
  const PASS_THROUGH_EVENTS = new Set(["bridge-failed", "bridge-completed", "bridge-plan-ready", "bridge-patch-preview", "bridge-patch-fallback"]);
  function handleBridgeEvent(msg) {
    if (msg.type === "bridge-stream") { handleStream(msg); return; } // v0.8.1 Codex 实时流(delta/工具/文件)
    if (msg.type === "bridge-patch-preview") { showPatchPreview(msg); return; } // 方向3:精确编辑预览(先预览后确认)
    if (msg.type === "bridge-patch-fallback") { // 方向3:坏 JSON 回落完整候选 —— 切到新 run 继续跟进度,不弹错误
      if (_patchPending && msg.old_run_id === _patchPending.run_id) hidePatchPreview();
      if (msg.new_run_id) _contractRunId = msg.new_run_id;
      setContractRunning(true); startRunTimer();
      setBridgeStatus(t("patch.fallback"), "running");
      pushProgress(t("patch.fallback"));
      return;
    }
    if (msg.type === "bridge-plan-ready") { onPlanReady(msg); } // v0.8.1 plan run 完成 → plan-review
    else if (msg.type === "bridge-progress" && _contractRunning) {
      const m = (_contractRunKind === "plan" ? t("bridge.planRunning") : t("bridge.candidateRunning")).replace("{agent}", providerLabel(_provider));
      setBridgeStatus(m, "running");
      if (msg.summary) pushProgress(msg.summary);
    } else if (msg.type === "bridge-completed") {
      setContractRunning(false); stopRunTimer();
      if (msg.candidate) HGAnalytics.track("task_success", { provider: _provider });
      if (msg.candidate) showCandidateResult(msg); // 候选成功态(状态栏版本号 + 打开按钮;background 已自动新开候选页签)
      const doneText = msg.candidate ? t("bridge.candidateCompleted") : t("bridge.completed");
      setBridgeStatus(doneText, "ok");
      pushProgress(doneText);
      recordRun({ provider: _provider, run_kind: _contractRunKind || "candidate", status: "completed", duration_s: runDurationSec(), started_at: nowHMS(), mode: getContractMode() });
      expandBridgeDetail(false); // 完成后收起进度窗(候选版本号 + 打开按钮仍在主行可见)
    } else if (msg.type === "bridge-failed") {
      setContractRunning(false); stopRunTimer();
      if (_contractStep === "plan-running") setContractStep("compose");
      _lastFailed = { code: msg.code || null, message: msg.message || "", provider: _provider, run_kind: _contractRunKind || null, at: new Date().toISOString() };
      HGAnalytics.track("task_failed", { provider: _provider, code: msg.code || "UNKNOWN" });
      // v0.9.x:自动上报改由 background captureDiag 在 failRun 终态负责(sidepanel 关闭也能报);此处不再重复上报。
      const failText = tBridgeFailed(msg.code, msg);
      setBridgeStatus(failText, bridgeFailClass(msg.code));
      pushProgress(failText);
      recordRun({ provider: _provider, run_kind: _contractRunKind, status: "failed", duration_s: runDurationSec(), started_at: nowHMS(), mode: getContractMode(), code: msg.code });
      expandBridgeDetail(false);
    }
  }

  // bridge 终态/预览事件:发给非当前 tab → 缓存,切回该 tab 回放(join-code 已在账号 flow 监听里处理)
  chrome.runtime.onMessage.addListener((msg) => {
    // bridge:终态/预览事件发给了非当前 tab → 缓存,切回该 tab 时回放(修「生成中切 tab 丢失结果/失败原因」)
    if (msg && msg.tab_id && msg.tab_id !== currentTabId && PASS_THROUGH_EVENTS.has(msg.type)) {
      _pendingTabEvents.set(msg.tab_id, msg);
      if (_pendingTabEvents.size > 16) { const k = _pendingTabEvents.keys().next().value; if (k !== msg.tab_id) _pendingTabEvents.delete(k); }
      return;
    }
    if (_contractOpen && msg && msg.tab_id === currentTabId) handleBridgeEvent(msg);
  });

  // 自动恢复登录：仅在用户勾选授权后才读取已有 session；Google 再额外尝试非交互 OAuth。
  async function silentReauth() {
    const local = await getLocalCfg(["auto_login_enabled"]);
    if (local.auto_login_enabled !== true) return;
    try {
      const r = await Login.googleStart({ interactive: false });
      if (r.token) { await applySession(r, false); HGAnalytics.track("session_restore", { method: "google" }); return; } // 静默重登不刷页(否则冲掉编辑确认窗)
      if (r && r.teams && r.teams.length === 0) { _sessionUser = r.user || _sessionUser; setAccountFlow("join-or-create"); return; }
    } catch (e) { /* 邮箱账号或 Google 会话失效时，继续检查已有应用 session */ }
    const cfg = await getCfg(["mode", "session_token", "team_id", "team_name"]);
    if (cfg.mode === "synced" && cfg.session_token) {
      try {
        const me = await fetch(BACKEND + "/auth/me", { headers: { Authorization: "Bearer " + cfg.session_token } }).then((r) => (r.ok ? r.json() : null));
        if (me && me.id) {
          // 兼容团队功能上线前签发的旧 session：它的 active team 为空，
          // 但用户后来已获得 membership。此时换发首个已加入团队的 session，
          // 绝不能把用户错误送到「加入团队」。
          if (!me.team_id && Array.isArray(me.teams) && me.teams.length) {
            const defaultTeam = me.teams[0];
            const switched = await fetch(BACKEND + "/auth/switch-team", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.session_token },
              body: JSON.stringify({ team_id: defaultTeam.team_id }),
            });
            if (switched.ok) {
              const j = await switched.json();
              await applySession(Object.assign({}, j, { teams: me.teams }), false);
              HGAnalytics.track("session_restore", { method: "stored" });
              return;
            }
          }
          // 恢复持久化的团队身份 + 全部团队列表(/auth/me 现返回 teams),供下拉切换。
          if (Array.isArray(me.teams)) _sessionTeams = me.teams;
          const cur = _sessionTeams.find((x) => x.team_id === (cfg.team_id || me.team_id));
          _sessionTeam = cur ? { id: cur.team_id, name: cur.name, role: cur.role }
            : ((cfg.team_id || me.team_id) ? { id: cfg.team_id || me.team_id, name: cfg.team_name || "" } : null);
          showLoggedIn(me);
          HGAnalytics.track("session_restore", { method: "stored" });
          return;
        }
      } catch (e) {}
      setAccountFlow("auth", { error: t("state.expired") });
    }
  }
  silentReauth();

  // === Tab 切换 + 账号视图(编辑默认主视图,批注次级,账号点头像进入整面板视图) ===
  let _activeMainTab = "edit"; // 进入账号视图前记住的主视图,退出时恢复
  function switchTab(name) {
    _activeMainTab = name;
    const editActive = name === "edit";
    const editView = document.getElementById("view-edit");
    const commentView = document.getElementById("view-comment");
    const editTab = document.getElementById("tab-edit");
    const commentTab = document.getElementById("tab-comment");
    editView.classList.toggle("show", editActive);
    commentView.classList.toggle("show", !editActive);
    editView.hidden = !editActive;
    commentView.hidden = editActive;
    editTab.classList.toggle("active", editActive);
    commentTab.classList.toggle("active", !editActive);
    editTab.setAttribute("aria-selected", String(editActive));
    commentTab.setAttribute("aria-selected", String(!editActive));
  }
  function updateCommentCount(n) {
    // 仅管理计数徽标;标签文案由 .tab-label[data-i18n] 承担,避免覆盖 SVG 图标
    const tab = document.getElementById("tab-comment");
    if (!tab) return;
    let cnt = tab.querySelector(".count");
    if (n > 0) {
      if (!cnt) { cnt = document.createElement("span"); cnt.className = "count"; tab.appendChild(cnt); }
      cnt.textContent = n;
    } else if (cnt) {
      cnt.remove();
    }
  }
  document.getElementById("tab-edit").addEventListener("click", () => switchTab("edit"));
  document.getElementById("tab-comment").addEventListener("click", () => switchTab("comment"));
  document.getElementById("tabbar").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = (e.key === "ArrowLeft" || e.key === "Home") ? "edit" : "comment";
    switchTab(next);
    document.getElementById(next === "edit" ? "tab-edit" : "tab-comment").focus();
  });

  const avatarBtn = document.getElementById("avatar");
  const accountSheet = document.getElementById("account-sheet");
  const accountBackBtn = document.getElementById("account-back-btn");
  const tabbarEl = document.getElementById("tabbar");
  // 账号视图:点头像进入整面板视图(非小浮层),隐藏 edit/comment + tabbar;返回时恢复原主视图。
  function enterAccountView({ preserveJoinCode = false } = {}) {
    // 账号/团队与创建编辑任务都是独占内容视图；从 Header 切换时不能叠两层状态。
    if (_contractOpen) closeContract();
    const ev = document.getElementById("view-edit");
    const cv = document.getElementById("view-comment");
    // 账号/工作区是独占视图：CSS 状态锁阻止任何异步刷新把 Tab 或主视图重新带回。
    document.body.classList.add("account-view-open");
    ev.classList.remove("show"); cv.classList.remove("show");
    ev.hidden = true; cv.hidden = true;
    if (tabbarEl) tabbarEl.hidden = true;
    accountSheet.hidden = false;
    accountSheet.classList.add("show");
    avatarBtn.classList.add("active");
    _authEmailOpen = false;
    _rememberAutoLogin = false;
    // 账号入口不是邀请链接入口。若保留旧码，下一次普通登录会被错误地导向邀请码页。
    if (!preserveJoinCode) { _pendingJoinCode = ""; _pendingJoinIntent = false; }
    setAccountFlow(_sessionUser ? "home" : "auth");
  }
  function exitAccountView() {
    document.body.classList.remove("account-view-open");
    accountSheet.classList.remove("show");
    accountSheet.hidden = true;
    avatarBtn.classList.remove("active");
    if (tabbarEl) tabbarEl.hidden = false;
    switchTab(_activeMainTab || "edit");
  }
  avatarBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (accountSheet.classList.contains("show")) exitAccountView();
    else { enterAccountView(); closeLangSheet(); }
  });
  if (accountBackBtn) accountBackBtn.addEventListener("click", () => {
    // 登录流程：邮箱输入/密码/验证码均回到登录方式选择；不在页面底部重复放一个「‹ 返回」。
    if (!_sessionUser && (_authEmailOpen || _accountFlow === "email-login" || _accountFlow === "email-register" || _accountFlow === "invite-email")) {
      _authEmailOpen = false;
      if (_accountFlow === "invite-email") { _inviteEmailCodeSent = false; _inviteTeamName = ""; }
      setAccountFlow("auth");
      return;
    }
    // 已登录：子页回团队首页；只有首页才退出团队面板。
    if (_sessionUser && _accountFlow !== "home") {
      // 返回当前团队意味着放弃本次加入动作，不能让邀请码在后续登录中继续劫持路由。
      if (_accountFlow === "join") { _pendingJoinCode = ""; _pendingJoinIntent = false; }
      setAccountFlow("home");
    }
    else exitAccountView();
  });

  // === 语言切换(中/英/日;跟随浏览器,默认英文,可手动切换,本地存储) ===
  const langBtn = document.getElementById("lang-btn");
  const langSheet = document.getElementById("lang-sheet");
  const langCode = document.getElementById("lang-code");
  const LANG_CODE = { zh: "中", en: "EN", ja: "日" };
  const LANG_HTML = { zh: "zh-CN", en: "en", ja: "ja" };

  function refreshLangUI() {
    const l = window.HG_I18N ? HG_I18N.getLang() : "en";
    if (langCode) langCode.textContent = LANG_CODE[l] || "EN";
    document.documentElement.lang = LANG_HTML[l] || "en";
    if (langSheet) langSheet.querySelectorAll(".lang-opt").forEach((o) => o.classList.toggle("active", o.dataset.lang === l));
  }
  function closeLangSheet() {
    if (!langSheet) return;
    langSheet.classList.remove("show");
    langBtn.classList.remove("active");
  }
  langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = langSheet.classList.toggle("show");
    langBtn.classList.toggle("active", open);
  });
  langSheet.addEventListener("click", (e) => {
    const opt = e.target.closest(".lang-opt");
    if (!opt) return;
    if (window.HG_I18N) HG_I18N.setLang(opt.dataset.lang);
  });
  // v0.9.6 问题反馈浮层(header 反馈按钮 → 小红书二维码引导)
  const feedbackBtn = document.getElementById("feedback-btn");
  const feedbackSheet = document.getElementById("feedback-sheet");
  function closeFeedbackSheet() {
    if (!feedbackSheet) return;
    feedbackSheet.classList.remove("show");
    if (feedbackBtn) feedbackBtn.setAttribute("aria-expanded", "false");
  }
  if (feedbackBtn && feedbackSheet) {
    feedbackBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = feedbackSheet.classList.toggle("show");
      feedbackBtn.setAttribute("aria-expanded", String(open));
      if (open) { closeLangSheet(); prepareDiagnostics(); }
    });
    const fbClose = document.getElementById("feedback-close");
    if (fbClose) fbClose.addEventListener("click", closeFeedbackSheet);
  }
  // === 诊断上报：与联系作者共用同一弹层；不在 UI 中展示诊断细节，用户可按需复制。 ===
  let _diagQueue = []; // 最近捕获的诊断记录(background 终态写入 IndexedDB,sidepanel 读出)
  // sidepanel 侧环境快照(上传时 enrich 进队列记录;background SW 无 navigator,故在此补)
  function _diagEnvSnapshot() {
    const manifest = chrome.runtime.getManifest();
    const ua = navigator.userAgent || "";
    return {
      chrome_version: (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "",
      platform: navigator.platform || "",
      backend: BACKEND,
      bridge: (_health && _health.bridge) ? { status: _health.bridge.status, version: _health.bridge.version } : null,
      providers: (_health && _health.providers) || [],
      provider_selected: _provider,
      active_team: _sessionTeam ? { id: _sessionTeam.id, name: _sessionTeam.name } : null,
      app_version: manifest.version,
    };
  }
  // 队列记录 → 上传 bundle(叠加 sidepanel 环境快照 + mode)
  function _diagBundleForUpload(rec, uploadMode) {
    return Object.assign({ mode: uploadMode }, _diagEnvSnapshot(), rec);
  }
  async function uploadDiagnostics(bundle) {
    const r = await fetch(BACKEND + "/api/diagnostics", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle),
    }).catch(() => null);
    return (r && r.ok) ? r.json() : null;
  }
  async function refreshDiagnostics() {
    try { _diagQueue = await Storage.listDiagnostics(10); } catch (_) { _diagQueue = []; }
  }
  async function prepareDiagnostics() {
    await refreshDiagnostics();
    getCfg(["hgAutoDiag"]).then((c) => { const cb = document.getElementById("diag-auto-toggle"); if (cb) cb.checked = !!(c && c.hgAutoDiag); });
  }
  const diagUpload = document.getElementById("diag-upload-btn");
  if (diagUpload) diagUpload.addEventListener("click", async () => {
    await refreshDiagnostics();
    const toUpload = _diagQueue;
    if (!toUpload.length) return;
    diagUpload.disabled = true;
    let ok = 0, lastId = null;
    for (const rec of toUpload) {
      const r = await uploadDiagnostics(_diagBundleForUpload(rec, "manual"));
      if (r && r.id != null) { ok++; lastId = r.id; }
    }
    diagUpload.disabled = false;
    let msg = t("diag.uploadFail");
    if (ok) { msg = t("diag.uploadOk").replace("{id}", lastId); if (ok > 1) msg += " · " + ok; }
    showToast(msg);
    if (ok) { try { await Storage.clearDiagnostics(); } catch (_) {} }
  });
  const diagCopy = document.getElementById("diag-copy-btn");
  if (diagCopy) diagCopy.addEventListener("click", async () => {
    await refreshDiagnostics();
    const toCopy = _diagQueue;
    if (!toCopy.length) return;
    try { navigator.clipboard.writeText(JSON.stringify(toCopy.map((r) => _diagBundleForUpload(r, "manual")), null, 2)); showToast(t("diag.copied")); } catch (_) {}
  });
  const diagAuto = document.getElementById("diag-auto-toggle");
  if (diagAuto) diagAuto.addEventListener("change", () => setCfg({ hgAutoDiag: !!diagAuto.checked }));

  // v0.9.9 前往官网(header 主页按钮 → 新标签打开;URL 取 manifest.homepage_url,与商店/仓库同源)
  const websiteBtn = document.getElementById("website-btn");
  if (websiteBtn) websiteBtn.addEventListener("click", () => {
    const url = (chrome.runtime.getManifest().homepage_url) || "https://www.deuce.monster/htmlgenius/";
    try { chrome.tabs.create({ url }).catch(() => { window.open(url, "_blank"); }); }
    catch (e) { window.open(url, "_blank"); }
  });

  // 点击外部关三个浮层
  document.addEventListener("click", (e) => {
    if (langSheet && !langSheet.contains(e.target) && e.target !== langBtn) closeLangSheet();
    if (feedbackSheet && !feedbackSheet.contains(e.target) && e.target !== feedbackBtn) closeFeedbackSheet();
  });

  // 切换语言后重渲染所有文案(静态 apply + 动态 renderMode/renderCards)
  function reRenderAll() {
    if (window.HG_I18N) HG_I18N.apply(document.body);
    refreshLangUI();
    renderMode();
    renderCards(_lastItems);
    if (_contractOpen) {
      if (_contractStep === "comment-scope") renderCommentScope();   // 评论范围:卡片/计数/警告/按钮跟随语言
      else if (_contractStep === "plan-review") renderPlanReview();  // 计划审阅:文案跟随语言
      else refreshContractUI();                                       // compose:scope/高级/bridge 跟随语言
      renderProviderMenu();                                           // provider 状态文案跟随语言
      renderConnCenter();                                             // v0.9 Connection Center 文案跟随语言
    }
    refreshLoginState();
    // v0.8: 弹层条目(字号/标题/对齐/色板 title)跟随新语言 —— 清 built 缓存,下次打开时重建
    document.querySelectorAll(".sp-list-pop, .sp-color-pop").forEach((p) => { delete p.dataset.built; p.innerHTML = ""; });
    closeAllSpPops();
    closeLangSheet();
  }

  // === v0.8.1 per-tab 状态:每个浏览器 tab 一份 contract/运行态快照,切 tab 时存旧取新 ===
  // Side Panel 是单实例(MV3),「per-tab 独立」= 切 tab 时把当前 tab 的草稿/运行/计时/候选快照存起来,
  // 恢复目标 tab 的快照。多 run 并行由 background(_runsByTab)保证,这里只负责 UI 跟随活动 tab。
  const _tabStates = new Map(); // tabId -> snapshot
  function snapshotTabState(tabId) {
    if (!tabId) return;
    _tabStates.set(tabId, {
      open: _contractOpen,
      step: _contractStep,
      selectedNodeIds: Array.from(_selectedNodeIds),
      running: _contractRunning,
      runKind: _contractRunKind,
      runId: _contractRunId,
      provider: _provider,
      providerStates: Object.assign({}, _providerStates),
      providerCacheAt: _providerCacheAt,
      plan: _plan ? Object.assign({}, _plan) : null,
      planStale: _planStale,
      candidateResult: _candidateResult,
      candidateVersionLabel: _candidateVersionLabel,
      runEvents: _runEvents.slice(),
      streamText: _streamText,
      runStartedAt: _runStartedAt,
      brief: contractBrief ? contractBrief.value : "",
      preserve: contractPreserve ? contractPreserve.value : "",
      scope: getContractMode()
    });
    // 上限保护:超过 16 个快照时丢最旧的(非当前)
    if (_tabStates.size > 16) { const k = _tabStates.keys().next().value; if (k !== tabId) _tabStates.delete(k); }
  }
  function restoreTabState(tabId) {
    const s = _tabStates.get(tabId);
    if (!s) {
      // 该 tab 无快照(新 tab / 从未打开契约):若当前契约开着,关掉(新 tab 不继承草稿)
      if (_contractOpen) { _contractOpen = false; _contractStep = "closed"; contractSheet.classList.remove("show"); contractSheet.hidden = true; }
      stopRunTimer();
      return;
    }
    _contractOpen = s.open;
    _contractRunning = s.running;
    _contractRunKind = s.runKind;
    _contractRunId = s.runId;
    _provider = s.provider;
    _providerStates = s.providerStates || {};
    _providerCacheAt = s.providerCacheAt;
    _plan = s.plan;
    _planStale = s.planStale;
    _candidateResult = s.candidateResult;
    _candidateVersionLabel = s.candidateVersionLabel || null;
    _runEvents = (s.runEvents || []).slice();
    _streamText = s.streamText || "";
    _runStartedAt = s.runStartedAt || 0;
    _selectedNodeIds = new Set(s.selectedNodeIds || []);
    if (contractBrief) contractBrief.value = s.brief || "";
    if (contractPreserve) contractPreserve.value = s.preserve || "";
    const scopeRadio = document.querySelector('input[name="contract-scope"][value="' + (s.scope || "precise_patch") + '"]');
    if (scopeRadio) scopeRadio.checked = true;
    if (s.open) {
      showContractSheet();
      setContractStep(s.step || "compose");
      renderProgress(); renderStreamText(); renderCandidateIndicator();
      renderProviderMenu();
      if (s.running) resumeRunTimer(); else stopRunTimer();
      setContractRunning(s.running); // 禁用/启用输入 + 刷新发送(终止)按钮态
    } else {
      contractSheet.classList.remove("show"); contractSheet.hidden = true;
      stopRunTimer();
    }
    // 方向3/通用:回放切 tab 期间到达的终态/预览事件(修「生成中切 tab 丢失结果/失败原因」)
    const pending = _pendingTabEvents.get(tabId);
    if (pending) { _pendingTabEvents.delete(tabId); handleBridgeEvent(pending); }
  }
  // 切回某 tab 时,若 UI 还显示 running,但后台 run 已终结(完成/失败/取消),reconcile 到终态,避免永远转圈
  async function reconcileTabRun(tabId) {
    if (!_contractRunning) return;
    const resp = await chrome.runtime.sendMessage({ type: "bridge-query-active-run", tab_id: tabId }).catch(() => null);
    if (!resp || !resp.active) {
      _contractRunning = false; setContractRunning(false); stopRunTimer();
      await loadCandidateEvidence(tabId);
      renderCandidateIndicator();
    }
  }

  // 切换标签 / 当前页刷新完成:静默重新激活(确认窗只在侧边栏打开时弹,刷新后不再弹)
  // 切 tab:先快照离开的 tab → 激活新 tab → 恢复新 tab 的契约/运行态 → 重拉评论 → reconcile 后台 run
  chrome.tabs.onActivated.addListener((activeInfo) => {
    const incoming = (activeInfo && activeInfo.tabId) || null;
    const outgoing = currentTabId;
    if (outgoing && incoming && outgoing !== incoming) snapshotTabState(outgoing);
    (async () => {
      await activateActiveTab(false);
      if (incoming) restoreTabState(incoming);
      await refreshAnnotations();
      if (incoming) reconcileTabRun(incoming);
    })();
  });
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info && info.status === "complete") {
      (async () => { await activateActiveTab(false); await refreshAnnotations(); })();
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => { _tabStates.delete(tabId); });
  // #1: 心跳 —— 只要侧边栏开着就持续 ping 活动标签(收起后停止 → content-script 看门狗失活)
  setInterval(pingActiveTab, 4000);

  // === #4: 主题切换(深色 Nebula / 浅色 Airtable);存 chrome.storage.local,content-script 监听同步 ===
  const themeBtn = document.getElementById("theme-btn");
  const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function applyTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    if (themeBtn) themeBtn.innerHTML = t === "dark" ? SUN_SVG : MOON_SVG; // 深色显示太阳(切浅)、浅色显示月亮(切深)
  }
  function setTheme(theme) {
    applyTheme(theme);
    try { chrome.storage.local.set({ hg_theme: theme }); } catch (e) {} // content-script 监听 storage.onChanged 同步
  }
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setTheme(cur === "light" ? "dark" : "light");
  });

  // === 初始化 ===
  (async () => {
    try {
      const cfg = await getLocalCfg(["session_token"]);
      HGAnalytics.track("panel_open", { is_logged_in: !!cfg.session_token });
    } catch (e) { HGAnalytics.track("panel_open"); }
    if (window.HG_I18N) {
      await HG_I18N.init();
      HG_I18N.apply(document.body);
      HG_I18N.onChange(reRenderAll);
    }
    refreshLangUI();
    // #4: 载入主题偏好(无则跟随系统 prefers-color-scheme,默认深色)
    chrome.storage.local.get(["hg_theme"], (r) => {
      let theme = r && r.hg_theme;
      if (theme !== "light" && theme !== "dark") {
        theme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
      }
      applyTheme(theme);
    });
    await activateActiveTab(true); // 打开侧边栏:先确保页面脚本就绪，再读取评论，避免初始化竞态
    const resp = await sendToContent({ type: "get-annotations" });
    if (resp && resp.type === "annotations-list") {
      isLocal = resp.isLocal;
      _editing = !!resp.editing;
      _artifactState = resp.artifact_state || _artifactState;
      renderMode();
      renderCards(resp.items);
    }
  })();
})();
