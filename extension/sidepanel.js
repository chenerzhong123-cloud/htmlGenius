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

  async function sendToContent(msg) {
    const tab = await getActiveTab();
    if (!tab) return null;
    currentTabId = tab.id;
    try { return await chrome.tabs.sendMessage(tab.id, msg); }
    catch (e) { console.log("content script not ready:", e); return null; }
  }
  // 重拉当前 tab 评论并刷新评论卡(+ 若 contract 开则同步本轮快照)。切 tab / 评论变化时用。
  // sendToContent 已把 currentTabId 更新为活动 tab → sidepanel 按 tab 独立显示评论。
  async function refreshAnnotations() {
    const resp = await sendToContent({ type: "get-annotations" });
    if (!resp || resp.type !== "annotations-list") return;
    isLocal = resp.isLocal;
    _editing = !!resp.editing;
    _artifactState = resp.artifact_state || _artifactState;
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
  async function activateActiveTab(showDialog) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    // v0.8.1 顺序修复:先 activate → 连新 port → 最后断旧 port。
    // 旧顺序(先断旧 port)会让 content-script 的 onDisconnect→失活 异步晚到,误杀刚激活的状态
    // (激活确认窗被移除且不恢复 → 「点刷新按钮没反应」)。配合 content-script 的延迟失活双保险。
    const oldPort = _panelPort;
    try { await chrome.tabs.sendMessage(tab.id, { type: "activate", showDialog: showDialog !== false }); }
    catch (e) { /* content-script 未就绪,等 onUpdated(complete) 再试 */ }
    // #5: 建立长连接 —— 侧边栏关闭(页面销毁)→ Chrome 自动断开 port → content-script onDisconnect 失活
    try { _panelPort = chrome.tabs.connect(tab.id, { name: "hg-panel" }); } catch (e) {}
    if (oldPort && oldPort !== _panelPort) { try { oldPort.disconnect(); } catch (e) {} } // 切标签:最后再断旧 port
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
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === "annotations-updated") {
      refreshAnnotations();
    } else if (msg.type === "presence") {
      renderPresence(msg.users);
    } else if (msg.type === "start-comment") {
      // issue 4:若正处于「整理评论/创建任务」流程(sheet 打开),草稿会被 sheet 盖住、用户无处输入 →
      // 不开草稿,改显示醒目提示,引导先返回收件箱。否则正常开草稿。
      if (_contractOpen) { showBlockNotice(); }
      else { hideBlockNotice(); showDraft(msg.selector, msg.quote); }
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
      const card = document.querySelector('.card[data-id="' + msg.id + '"]');
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
    }
  });

  let _editing = false;
  let _elementMode = false; // v0.6: 高级(元素)模式

  // 标准 alert 图标(success=对勾圆 / warning=三角感叹号),用经典控件不手画
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
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
    const epanel = document.getElementById("element-panel");
    if (epanel) epanel.hidden = !_elementMode; // v0.6: 元素面板(M3 填内容)
    const adv = document.getElementById("adv-mode-btn");
    if (adv) adv.hidden = !_editing; // v0.6: 仅编辑态显示「切换高级模式」
    renderArtifactControls();
  }
  function renderArtifactControls() {
    const reload = document.getElementById("artifact-reload-btn");
    const status = document.getElementById("artifact-status");
    if (reload) reload.hidden = !isLocal;
    if (!status) return;
    if (!isLocal || !_artifactState) { status.hidden = true; return; }
    const hash = _artifactState.loaded_artifact_hash;
    const logical = _artifactState.logical_document_id;
    if (!hash && !logical) { status.hidden = true; return; }
    status.textContent = t("artifact.status").replace("{id}", logical || "—").replace("{hash}", hash ? hash.slice(0, 19) + "…" : t("artifact.hashPending"));
    status.hidden = false;
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

  function renderCards(items) {
    _lastItems = items || [];
    const c = document.getElementById("annotations");
    c.innerHTML = "";
    if (!items || items.length === 0) {
      c.innerHTML = '<div class="empty">' + esc(t("comment.empty")) + '</div>';
      updateCommentCount(0);
      return;
    }
    const openItems = items.filter((a) => a._status !== "stale");
    const staleItems = items.filter((a) => a._status === "stale");
    const byParent = {};
    openItems.forEach((a) => { const k = a.parent_id || null; (byParent[k] = byParent[k] || []).push(a); });
    function buildCard(ann, depth, stale) {
      const card = document.createElement("div");
      card.className = "card" + (stale ? " stale" : "");
      card.dataset.id = ann.id; // #4: 页面点高亮跳转时定位卡片
      if (depth) card.style.marginLeft = (depth * 14) + "px";
      const quote = (ann.quote || "").slice(0, 60);
      const comment = (ann.body && ann.body.comment) || t("card.noComment");
      const who = (ann.author && ann.author.name) ? "[" + ann.author.name + "]" : "";
      card.innerHTML = '<div class="quote">' + esc(quote) + '</div><div>' + esc(who + " ") + linkify(comment) + '</div>'
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
      chrome.storage.sync.get(["user", "mode"], (cfg) => {
        const me = cfg.user && cfg.user.id;
        if (cfg.mode !== "synced" || (ann.author && ann.author.id === me)) {
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
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitDraft(); }
      if (e.key === "Escape") { e.preventDefault(); cancelDraft(); }
    });
  }

  function commitDraft() {
    const draft = document.querySelector(".draft-card");
    if (!draft || !_pendingSelector) return;
    const comment = draft.querySelector(".draft-input").value;
    sendToContent({
      type: "commit-comment",
      selector: _pendingSelector.selector,
      quote: _pendingSelector.quote,
      comment: comment || "",
    });
    _pendingSelector = null;
    draft.remove();
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
      sendToContent({ type: "reply", parentId: parent.id, comment: ta.value || "" });
      editor.remove();
    };
    editor.querySelector(".reply-save").addEventListener("click", submit);
    editor.querySelector(".reply-cancel").addEventListener("click", () => editor.remove());
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
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
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
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

  function showToast(msg) {
    let tl = document.querySelector(".toast");
    if (!tl) { tl = document.createElement("div"); tl.className = "toast"; document.body.appendChild(tl); }
    tl.textContent = msg;
    tl.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => tl.classList.remove("show"), 2000);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function linkify(text) {
    const safe = esc(text);
    return safe.replace(/https?:\/\/[^\s<]+/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>');
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

  let _contractStep = "closed"; // closed | compose | comment-scope | plan-running | plan-review | candidate-running
  let _selectedNodeIds = new Set(); // 本轮勾选的节点 id(root+reply;真相源)
  let _contractRunKind = "candidate"; // candidate | plan(sidepanel 本次派发)
  let _contractRunId = null;          // 当前 sidepanel 跟踪的 run id(匹配 bridge-stream/完成事件)
  let _streamText = "";               // Agent 实时输出累积(agentMessage delta)
  let _candidateResult = null;      // 最近一次 candidate-ready 结果(只读成功态)
  let _candidateVersionLabel = null;  // 本文档候选版本号标签(来自 host "1.N" 字符串,如 "1.3")
  // v0.8.1 provider probe + plan-first 状态(spec §3.D/§5)
  let _provider = null;             // 当前选中 provider id(仅 ready 可选)
  let _providerStates = {};         // { providerId: probe 记录 }
  let _providerCacheAt = 0;         // probe 缓存时间戳(ms);30s 内不重探
  let _plan = null;                 // 已校验计划记录(bridge-plan-ready):{ plan_id, plan_sha256, plan_markdown, provider, source_artifact_uri, base_artifact_hash, task_sha256 }
  let _planStale = false;           // 计划后改 contract/artifact → true,阻止确认

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
      else { contractBridge.textContent = _provider ? t("bridge.sendTo").replace("{agent}", providerLabel(_provider)) : t("bridge.run"); contractBridge.disabled = !canDispatch; contractBridge.classList.remove("aborting"); }
    }
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
    accountSheet.classList.remove("show");
    avatarBtn.classList.remove("active");
    closeLangSheet();
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
    _provider = null; _providerStates = {}; _providerCacheAt = 0;
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
  }
  // 据后台活动 run 同步 _contractRunning:在跑 → 终止态 + 计时器 + 进度窗;不在跑 → 可发送态。
  // 修「同 tab 关掉契约页又重进,按钮误显示可发送(但 run 仍在跑)」。
  async function syncRunStateFromBackground(tabId) {
    if (!tabId) return;
    const resp = await chrome.runtime.sendMessage({ type: "bridge-query-active-run", tab_id: tabId }).catch(() => null);
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
        if (btn) btn.innerHTML = esc(t("contract.copied"));
        showToast(t("contract.copied"));
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
        _provider = (Object.keys(_providerStates).find((id) => _providerStates[id].status === "ready")) || null;
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
      btn.classList.toggle("active", id === _provider);
      btn.disabled = !ready;
      const dot = btn.querySelector(".agent-dot");
      if (dot) dot.className = "agent-dot" + (ready ? " ready" : (p && p.status === "auth_required" ? " warn" : ""));
      const note = btn.querySelector(".agent-note");
      if (note) note.textContent = providerStatusText(p);
    });
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

  async function queryHealth() {
    if (!_contractOpen) return;
    if (connCenter) connCenter.hidden = false;
    if (connTitle) connTitle.textContent = t("conn.titleChecking");
    const resp = await chrome.runtime.sendMessage({ type: "bridge-query-health" }).catch(() => null);
    _health = (resp && resp.health) ? resp.health : null;
    renderConnCenter();
  }
  async function fetchBootstrap() {
    if (_bootstrap) return _bootstrap;
    const resp = await chrome.runtime.sendMessage({ type: "bridge-get-bootstrap" }).catch(() => null);
    if (resp && resp.ok && resp.bootstrap) _bootstrap = resp.bootstrap;
    return _bootstrap;
  }
  function connCopy(text, hintKey) {
    if (!text) return;
    const done = () => connSetHint(t(hintKey), "ok");
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
    return !!(h && h.bridge && h.bridge.status === "ready"
      && Array.isArray(h.providers) && h.providers.some((p) => p && p.status === "ready"));
  }
  // §5.2 状态矩阵 → 由纯函数 ConnectionCenterState.connStateFor 驱动(v0.9.1 §9.1,可 node:test 验证)
  function renderConnCenter() {
    if (!connCenter) return;
    if (!_contractOpen) { connCenter.hidden = true; return; }
    connCenter.hidden = false;
    if (connRepairConfirm) connRepairConfirm.hidden = true;
    const st = ConnectionCenterState.connStateFor(_health, {
      userCollapsed: _connCollapsed,
      devOnly: !!(_bootstrap && _bootstrap.dev_only)
    });
    connCenter.className = "conn-center" + (st.cls ? " " + st.cls : "") + (st.collapsed ? " collapsed" : "");
    if (connHead) connHead.setAttribute("aria-expanded", String(!st.collapsed));
    connTitle.textContent = (st.titleKey === "conn.titleConnected")
      ? t(st.titleKey).replace("{n}", String(st.readyCount || 0))
      : t(st.titleKey);
    if (connDesc) { connDesc.textContent = st.descKey ? t(st.descKey) : ""; connDesc.hidden = !st.descKey; }
    renderConnProviders(st.showProviders && _health ? (_health.providers || []) : []);
    setConnButton(connPrimary, st.primary ? t(st.primary.labelKey) : null, st.primary ? st.primary.action : null);
    setConnButton(connSecondary, st.secondary ? t(st.secondary.labelKey) : null, st.secondary ? st.secondary.action : null);
    let hint = st.permanentHintKey ? t(st.permanentHintKey) : "";
    if (hint && st.devOnly) hint += " " + t("conn.devOnly");
    connSetPermanent(hint);
  }
  async function connDo(action) {
    if (!action) return;
    if (action === "check") {
      if (connCheck) connCheck.disabled = true;
      if (connPrimary && connPrimary.dataset.action === "check") connPrimary.disabled = true;
      await queryHealth();
      if (connCheck) connCheck.disabled = false;
      if (connPrimary) connPrimary.disabled = false;
      return;
    }
    if (action === "setup" || action === "terminal") {
      const b = await fetchBootstrap();
      if (!b) return;
      if (action === "setup") connCopy(b.setup_prompt, "conn.setupCopied");
      else connCopy(b.terminal_command, "conn.terminalCopied");
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
  if (connPrimary) connPrimary.addEventListener("click", () => connDo(connPrimary.dataset.action));
  if (connSecondary) connSecondary.addEventListener("click", () => connDo(connSecondary.dataset.action));
  if (connCheck) connCheck.addEventListener("click", () => connDo("check"));
  if (connDiag) connDiag.addEventListener("click", () => {
    // §5.4:只复制脱敏 health JSON;host 不存在时用兜底形态
    const h = _health || { schema_version: 1, overall: "action_required", bridge: { status: "install_required" }, reason_code: "BRIDGE_NOT_INSTALLED", extension_version: (_bootstrap && _bootstrap.extension_version) || "" };
    connCopy(JSON.stringify(h, null, 2), "conn.diagCopied");
  });
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
    const full = contractBridgeStatus.classList.contains("expanded-full");
    contractBridgeStatus.hidden = !text && !_runEvents.length && !_candidateResult;
    const tx = cbsTextEl(); if (tx) tx.textContent = text || "";
    contractBridgeStatus.className = "contract-bridge-status" + (cls ? " " + cls : "") + (expanded ? " expanded" : "") + (full ? " expanded-full" : "");
  }
  // 发送后默认展开进度窗(capped 限高);完成/终止后收起;点击在 收起→capped→全展→收起 间循环。
  // open=false 收起;open=true 打开,full=true 进一步全展开(看全部历史)。
  function expandBridgeDetail(open, full) {
    if (!contractBridgeStatus) return;
    const d = contractBridgeStatus.querySelector(".cbs-detail");
    if (!d) return;
    if (!open) {
      d.hidden = true;
      contractBridgeStatus.classList.remove("expanded");
      contractBridgeStatus.classList.remove("expanded-full");
      return;
    }
    d.hidden = false;
    contractBridgeStatus.classList.add("expanded");
    contractBridgeStatus.classList.toggle("expanded-full", !!full);
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
    try { chrome.storage.local.get([RUN_LOG_KEY], (res) => {
      const list = (res && Array.isArray(res[RUN_LOG_KEY])) ? res[RUN_LOG_KEY] : [];
      list.unshift(entry); const trimmed = list.slice(0, 3);
      chrome.storage.local.set({ [RUN_LOG_KEY]: trimmed }, () => renderHistoryFromList(trimmed));
    }); } catch (e) {}
  }
  function loadRunHistory() {
    try { chrome.storage.local.get([RUN_LOG_KEY], (res) => renderHistoryFromList((res && res[RUN_LOG_KEY]) || [])); } catch (e) {}
  }
  function renderHistoryFromList(list) {
    const ul = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-history");
    if (!ul) return;
    if (!list || !list.length) { ul.innerHTML = '<li class="cbs-empty">' + esc(t("run.noHistory")) + "</li>"; return; }
    ul.innerHTML = list.map((r) => {
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
    return null;
  }
  function renderStreamText() {
    const el = contractBridgeStatus && contractBridgeStatus.querySelector(".cbs-stream");
    if (!el) return;
    el.textContent = _streamText.slice(-400);
    el.classList.toggle("typing", !!_streamText);
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
      || code === "CANDIDATE_SYMLINK" || code === "CANDIDATE_NOT_FILE" || code === "CANDIDATE_TOO_LARGE" || code === "CANDIDATE_NOT_UTF8") return t("bridge.candidateInvalid");
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

  if (contractCloseBtn) contractCloseBtn.addEventListener("click", closeContract);
  // scope 卡 / brief / preserve 改动 → 刷新 UI + 计划失效检测(spec §3.E.9)
  document.querySelectorAll('input[name="contract-scope"]').forEach((r) => r.addEventListener("change", () => { refreshContractUI(); checkPlanStale(); }));
  if (contractBrief) contractBrief.addEventListener("input", () => { refreshContractUI(); checkPlanStale(); });
  if (contractPreserve) contractPreserve.addEventListener("input", () => { refreshContractUI(); checkPlanStale(); });
  if (contractCopyPrompt) contractCopyPrompt.addEventListener("click", () => copyContract());
  // 发送按钮:运行中 → 终止任务(cancelBridgeRun);否则 → 发送(startBridgeRun)
  if (contractBridge) contractBridge.addEventListener("click", () => { if (_contractRunning) cancelBridgeRun(); else startBridgeRun(); });
  // 状态栏点击:三态循环 收起 → capped(限高)→ 全展 → 收起
  if (contractBridgeStatus) contractBridgeStatus.addEventListener("click", () => {
    const d = contractBridgeStatus.querySelector(".cbs-detail");
    if (!d) return;
    const isHidden = d.hidden;
    const isFull = contractBridgeStatus.classList.contains("expanded-full");
    if (isHidden) expandBridgeDetail(true, false);
    else if (!isFull) expandBridgeDetail(true, true);
    else expandBridgeDetail(false);
  });
  if (contractPlanBtn) contractPlanBtn.addEventListener("click", startPlanRun);
  if (contractGotoRange) contractGotoRange.addEventListener("click", () => setContractStep("comment-scope"));
  // 发送组菜单:⌄ 切换 + 重新 probe(缓存过期);agent 选 provider;外部点击关闭
  const sendToggle = document.getElementById("contract-send-toggle");
  const sendMenu = document.getElementById("contract-send-menu");
  function closeSendMenu() { if (sendMenu) sendMenu.classList.remove("show"); if (sendToggle) sendToggle.setAttribute("aria-expanded", "false"); }
  if (sendToggle) sendToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    queryProviders(false); // 点开下拉时若缓存过期则重探(spec §3.D)
    const open = !sendMenu.classList.contains("show");
    if (open) { sendMenu.classList.add("show"); sendToggle.setAttribute("aria-expanded", "true"); } else closeSendMenu();
  });
  if (sendMenu) sendMenu.addEventListener("click", (e) => {
    const ag = e.target.closest(".agent");
    if (ag && !ag.disabled) { selectProvider(ag.dataset.provider); closeSendMenu(); return; }
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

  document.getElementById("edit-btn").addEventListener("click", () => {
    // 编辑态由 content-script 经 edit-state 广播同步;此处乐观翻转即时反馈
    sendToContent({ type: _editing ? "disable-edit" : "enable-edit" });
    _editing = !_editing;
    renderMode();
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
  document.getElementById("act-save").addEventListener("click", async () => {
    // #2: 下载在 side panel 触发(content-script 只回传 HTML,避免异步消息丢用户手势被拦)
    const r = await sendToContent({ type: "save-html" });
    if (r && r.html) {
      const blob = new Blob([r.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = r.name || "page.html";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      sendToContent({ type: "mark-artifact-snapshot-exported" });
    }
  });
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
  // v0.8 #5: 字号 / 标题 / 对齐 列表浮层(条目文案用与工具栏相同的 i18n key)
  const SP_SIZES = [["size.sm", "0.85em"], ["size.std", "1em"], ["size.lg", "1.3em"], ["size.xl", "1.7em"]];
  function buildSpListPops() {
    const sizePop = document.getElementById("sp-size-pop");
    if (sizePop && !sizePop.dataset.built) {
      sizePop.dataset.built = "1";
      sizePop.innerHTML = SP_SIZES.map((s) => '<button class="li" type="button" data-kind="style" data-prop="fontSize" data-val="' + s[1] + '" style="font-size:' + s[1] + '">' + esc(t(s[0])) + "</button>").join("");
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

  // === 协同登录(飞书 + Google 档3,后端地址烤在 config.js) ===
  const BACKEND = (window.HG_CONFIG && window.HG_CONFIG.backend) || "";
  const loginBtn = document.getElementById("lark-login-btn");
  const googleBtn = document.getElementById("google-login-btn");
  const loginState = document.getElementById("login-state");
  const teamSetup = document.getElementById("team-setup");
  const inviteInput = document.getElementById("invite-code-input");

  function getCfg(keys) { return new Promise((r) => chrome.storage.sync.get(keys, r)); }
  function setCfg(obj) { return new Promise((r) => chrome.storage.sync.set(obj, r)); }

  // reload=true:显式登录后刷页(让 content-script 切到 RemoteStore 加载协同批注)。
  // silentReauth(侧边栏打开时静默重登)传 false —— 不刷页,否则会冲掉刚弹出的编辑确认窗。
  async function applySession(r, reload = true) {
    await setCfg({ mode: "synced", backend: BACKEND, session_token: r.token, user: r.user });
    showLoggedIn(r.user);
    if (teamSetup) teamSetup.hidden = true;
    if (reload) {
      const tab = await getActiveTab();
      if (tab && tab.id) { try { await chrome.tabs.reload(tab.id); } catch (e) { /* 非关键 */ } }
    }
  }
  function showLoggedIn(user) {
    _sessionUser = user;
    loginState.textContent = t("state.loggedIn") + (user.name || user.id) + " ";
    renderLogoutBtn();
    renderInviteBtn();
  }
  function refreshLoginState() { if (_sessionUser) showLoggedIn(_sessionUser); }
  function renderLogoutBtn() {
    let b = document.getElementById("logout-btn");
    if (!b) { b = document.createElement("button"); b.id = "logout-btn"; b.addEventListener("click", doLogout); loginState.appendChild(b); }
    b.textContent = t("state.logout");
  }
  function renderInviteBtn() {
    let b = document.getElementById("invite-btn");
    if (!b) { b = document.createElement("button"); b.id = "invite-btn"; b.addEventListener("click", doInvite); loginState.appendChild(b); }
    b.textContent = t("state.invite");
  }
  async function doLogout() {
    const cfg = await getCfg(["session_token"]);
    if (cfg.session_token) {
      try { await fetch(BACKEND + "/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + cfg.session_token } }); } catch (e) { /* 忽略 */ }
    }
    await new Promise((r) => chrome.storage.sync.remove(["session_token", "user", "mode"], r));
    _sessionUser = null;
    loginState.textContent = t("state.loggedOut");
    ["logout-btn", "invite-btn"].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
    renderPresence([]); // 登出:清掉在线人数
  }
  async function doInvite() {
    const cfg = await getCfg(["session_token"]);
    try {
      const r = await fetch(BACKEND + "/auth/invites", { method: "POST", headers: { Authorization: "Bearer " + cfg.session_token } });
      const j = await r.json();
      if (j.code) {
        showToast(t("team.inviteCopied") + j.code);
        try { await navigator.clipboard.writeText(j.code); } catch (e) {}
      }
    } catch (e) { showToast(t("team.inviteFail")); }
  }

  // 飞书登录
  loginBtn.addEventListener("click", async () => {
    loginState.textContent = t("login.larkLoading");
    try {
      const r = await Login.start({ backend: BACKEND });
      await applySession(r);
      showToast(t("login.larkSuccess"));
    } catch (e) { loginState.textContent = t("login.fail") + (e && e.message ? e.message : e); }
  });

  // Google 登录(交互)
  googleBtn.addEventListener("click", async () => {
    loginState.textContent = t("login.googleLoading");
    try {
      const r = await Login.googleStart({ interactive: true });
      if (r.token) { await applySession(r); showToast(t("login.googleSuccess")); }
      else { loginState.textContent = t("login.okJoinCreate"); if (teamSetup) teamSetup.hidden = false; }
    } catch (e) { loginState.textContent = t("login.fail") + (e && e.message ? e.message : e); }
  });

  // 加入团队(凭码)
  document.getElementById("join-btn").addEventListener("click", async () => {
    const code = (inviteInput.value || "").trim();
    if (!code) { showToast(t("team.fillInvite")); return; }
    loginState.textContent = t("team.joining");
    try {
      const r = await Login.googleStart({ interactive: true, action: "join", code });
      if (r.token) { await applySession(r); showToast(t("team.joinSuccess")); }
      else { loginState.textContent = t("team.joinFail"); }
    } catch (e) { loginState.textContent = t("team.joinFailMsg") + (e && e.message ? e.message : e); }
  });
  // 新建团队
  document.getElementById("create-team-btn").addEventListener("click", async () => {
    loginState.textContent = t("team.creating");
    try {
      const r = await Login.googleStart({ interactive: true, action: "create" });
      if (r.token) { await applySession(r); showToast(t("team.createSuccess")); }
    } catch (e) { loginState.textContent = t("team.createFail"); }
  });

  // join 链接页(/hg/join?code=)content-script 发来的码 → 预填 + 展开
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "join-code" && inviteInput) {
      inviteInput.value = msg.code;
      if (teamSetup) teamSetup.hidden = false;
      loginState.textContent = t("team.invitePrefill");
    }
    // bridge:background 推送的 run 进度/完成/失败/计划就绪(仅当前 tab 且任务 sheet 打开时处理)
    if (_contractOpen && msg && msg.tab_id === currentTabId) {
      if (msg.type === "bridge-stream") { handleStream(msg); return; } // v0.8.1 Codex 实时流(delta/工具/文件)
      if (msg.type === "bridge-plan-ready") { onPlanReady(msg); } // v0.8.1 plan run 完成 → plan-review
      else if (msg.type === "bridge-progress" && _contractRunning) {
        const m = _contractRunKind === "plan" ? t("bridge.planRunning").replace("{agent}", providerLabel(_provider)) : t("bridge.candidateRunning");
        setBridgeStatus(m, "running");
        if (msg.summary) pushProgress(msg.summary);
      } else if (msg.type === "bridge-completed") {
        setContractRunning(false); stopRunTimer();
        if (msg.candidate) showCandidateResult(msg); // 候选成功态(状态栏版本号 + 打开按钮;background 已自动新开候选页签)
        const doneText = msg.candidate ? t("bridge.candidateCompleted") : t("bridge.completed");
        setBridgeStatus(doneText, "ok");
        pushProgress(doneText);
        recordRun({ provider: _provider, run_kind: "candidate", status: "completed", duration_s: runDurationSec(), started_at: nowHMS(), mode: getContractMode() });
        expandBridgeDetail(false); // 完成后收起进度窗(候选版本号 + 打开按钮仍在主行可见)
      } else if (msg.type === "bridge-failed") {
        setContractRunning(false); stopRunTimer();
        if (_contractStep === "plan-running") setContractStep("compose");
        const failText = tBridgeFailed(msg.code, msg);
        setBridgeStatus(failText, bridgeFailClass(msg.code));
        pushProgress(failText);
        recordRun({ provider: _provider, run_kind: _contractRunKind, status: "failed", duration_s: runDurationSec(), started_at: nowHMS(), mode: getContractMode(), code: msg.code });
        expandBridgeDetail(false);
      }
    }
  });

  // 静默重登:侧栏打开 → getAuthToken(非交互)→ 有团队直接 session;否则查已有 session
  async function silentReauth() {
    try {
      const r = await Login.googleStart({ interactive: false });
      if (r.token) { await applySession(r, false); return; } // 静默重登不刷页(否则冲掉编辑确认窗)
      if (r.teams && r.teams.length === 0) { loginState.textContent = t("team.needTeam"); if (teamSetup) teamSetup.hidden = false; return; }
    } catch (e) { /* 无 Google token,落到 storage 检查 */ }
    const cfg = await getCfg(["mode", "session_token"]);
    if (cfg.mode === "synced" && cfg.session_token) {
      try {
        const me = await fetch(BACKEND + "/auth/me", { headers: { Authorization: "Bearer " + cfg.session_token } }).then((r) => (r.ok ? r.json() : null));
        if (me && me.id) {
          showLoggedIn(me);
          return;
        }
      } catch (e) {}
      loginState.textContent = t("state.expired");
    }
  }
  silentReauth();

  // === Tab 切换 + 头像浮层(方案1:编辑默认主视图,批注次级,账号收头像) ===
  function switchTab(name) {
    document.getElementById("view-edit").classList.toggle("show", name === "edit");
    document.getElementById("view-comment").classList.toggle("show", name === "comment");
    document.getElementById("tab-edit").classList.toggle("active", name === "edit");
    document.getElementById("tab-comment").classList.toggle("active", name === "comment");
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

  const avatarBtn = document.getElementById("avatar");
  const accountSheet = document.getElementById("account-sheet");
  avatarBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = accountSheet.classList.toggle("show");
    avatarBtn.classList.toggle("active", open);
    if (open) closeLangSheet();
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
    if (open) { accountSheet.classList.remove("show"); avatarBtn.classList.remove("active"); }
  });
  langSheet.addEventListener("click", (e) => {
    const opt = e.target.closest(".lang-opt");
    if (!opt) return;
    if (window.HG_I18N) HG_I18N.setLang(opt.dataset.lang);
  });
  // 点击外部关两个浮层
  document.addEventListener("click", (e) => {
    if (!accountSheet.contains(e.target) && e.target !== avatarBtn) {
      accountSheet.classList.remove("show");
      avatarBtn.classList.remove("active");
    }
    if (langSheet && !langSheet.contains(e.target) && e.target !== langBtn) closeLangSheet();
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
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info && info.status === "complete") activateActiveTab(false); });
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
    activateActiveTab(true); // 打开侧边栏:激活当前页 + 弹编辑确认窗(刷新前)
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
