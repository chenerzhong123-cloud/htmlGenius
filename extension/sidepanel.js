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
  let _contractItems = [];        // 打开 Composer 时的批注快照(供校验/渲染,不随列表变化)
  let _contractSourceRootIds = [];
  let _contractArtifact = null;
  let _contractOpen = false;
  let _contractTriggerEl = null;  // 关闭 Composer 后恢复焦点

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

  // 激活当前页:content-script 收到后才显示高亮/工具栏/编辑(关闭侧边栏时普通浏览零打扰)
  // showDialog=true 仅在打开侧边栏时用(弹编辑确认窗);切标签/刷新用 false(静默)
  let _panelPort = null; // #5: 与活动标签的长连接;侧边栏关闭→port 断开→content-script 立即失活
  async function activateActiveTab(showDialog) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) return;
    if (_panelPort) { try { _panelPort.disconnect(); } catch (e) {} _panelPort = null; } // 切标签:旧标签失活
    try { await chrome.tabs.sendMessage(tab.id, { type: "activate", showDialog: showDialog !== false }); }
    catch (e) { /* content-script 未就绪,等 onUpdated(complete) 再试 */ }
    // #5: 建立长连接 —— 侧边栏关闭(页面销毁)→ Chrome 自动断开 port → content-script onDisconnect 立即失活
    try { _panelPort = chrome.tabs.connect(tab.id, { name: "hg-panel" }); } catch (e) {}
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
      sendToContent({ type: "get-annotations" }).then((resp) => {
        if (resp && resp.type === "annotations-list") {
          isLocal = resp.isLocal;
          _editing = !!resp.editing; // 以页面实际编辑态为准(刷新后复位为查看)
          _artifactState = resp.artifact_state || _artifactState;
          renderMode();
          renderCards(resp.items);
          maybeShowReloadResult(resp.items);
        }
      });
    } else if (msg.type === "presence") {
      renderPresence(msg.users);
    } else if (msg.type === "start-comment") {
      // 页面上点了「批注」→ 在侧边栏开草稿块内联编辑评论
      showDraft(msg.selector, msg.quote);
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
      _elementMode = !!msg.on; updateAdvModeBtn(); // v0.6: 模式翻转 → 按钮 + 互斥显隐
    } else if (msg.type === "element-selected") {
      renderElementPanel(msg.info); // v0.6 M2: 渲染选中元素信息
    } else if (msg.type === "annotation-clicked") {
      // #4: 页面点高亮 → 切到批注 tab + 滚到卡片 + 聚焦回复输入
      switchTab("comment");
      const card = document.querySelector('.card[data-id="' + msg.id + '"]');
      const ann = (_lastItems || []).find((a) => a.id === msg.id);
      if (card && ann) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1400);
        doReply(ann, card);
      }
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
  const FONT_OPTS = [["", "默认"], ["sans-serif", "无衬线"], ["serif", "衬线"], ["monospace", "等宽"], ['"PingFang SC",sans-serif', "苹方"], ['"Microsoft YaHei",sans-serif', "微软雅黑"], ["Arial,sans-serif", "Arial"], ["Georgia,serif", "Georgia"]];
  const LS_OPTS = [["", "默认"], ["-0.02em", "紧凑"], ["0.05em", "略松"], ["0.1em", "宽松"], ["0.15em", "很宽"]];
  const LH_OPTS = [["", "默认"], ["1", "1.0"], ["1.3", "1.3"], ["1.5", "1.5"], ["1.7", "1.7"], ["2", "2.0"]];
  const PAD_OPTS = [["", "默认"], ["0", "0"], ["6px", "6"], ["12px", "12"], ["18px", "18"], ["24px", "24"]];
  function styleSelect(prop, label, opts, cur) {
    const oh = opts.map((o) => '<option value="' + esc(o[0]) + '"' + (o[0] === (cur || "") ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("");
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
        if (!depth) {
          // v0.6.1:仅顶层非 stale 卡片可「生成任务」(回复卡片不出现,避免失去上下文)
          const gen = document.createElement("button");
          gen.textContent = t("card.genTask"); gen.title = t("card.genTask");
          gen.addEventListener("click", (e) => {
            e.stopPropagation();
            _contractTriggerEl = gen;
            sendToContent({ type: "get-export" }).then((resp) => {
              if (!resp || resp.type !== "export-data") { showToast(t("contract.copyFail")); return; }
              openContract([ann.id], resp.items || [], resp.artifact);
            });
          });
          acts.appendChild(gen);
        }
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
    window.focus();          // 抢侧边栏窗口焦点(点批注浮窗时焦点在页面)
    ta.focus();              // 立即聚焦输入框(不用 setTimeout,避免被页面抢回)
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

  // === v0.6.1 修改契约 Composer(批注 → 带允许范围/保护规则/验收条件的任务)===
  const contractSheet = document.getElementById("contract-sheet");
  const contractCloseBtn = document.getElementById("contract-close");
  const contractSummary = document.getElementById("contract-source-summary");
  const contractSourceList = document.getElementById("contract-source-list");
  const contractBrief = document.getElementById("contract-brief");
  const contractBriefError = document.getElementById("contract-brief-error");
  const contractBriefReq = document.getElementById("contract-brief-req");
  const contractPreserve = document.getElementById("contract-preserve");
  const contractPlanHint = document.getElementById("contract-plan-hint");
  const contractCopyPrompt = document.getElementById("contract-copy-prompt");
  const contractCopyJson = document.getElementById("contract-copy-json");
  const contractFallback = document.getElementById("contract-output-fallback");
  const contractFallbackText = document.getElementById("contract-fallback-text");

  function countReplies(rootId, allItems) {
    const kids = {};
    (allItems || []).forEach((a) => { const p = a.parent_id || null; (kids[p] = kids[p] || []).push(a.id); });
    let n = 0; const stack = (kids[rootId] || []).slice();
    while (stack.length) { const id = stack.pop(); n += 1; (kids[id] || []).forEach((c) => stack.push(c)); }
    return n;
  }
  function getContractMode() {
    const checked = document.querySelector('input[name="contract-mode"]:checked');
    return checked ? checked.value : "precise_patch";
  }
  function getContractDraft() {
    return {
      mode: getContractMode(),
      rootIds: _contractSourceRootIds.slice(),
      brief: contractBrief.value,
      preserveText: contractPreserve.value,
      artifact: _contractArtifact || { title: "", url: "", isLocal: false }
    };
  }
  function renderContractSource() {
    const items = _contractItems;
    const roots = items.filter((a) => _contractSourceRootIds.indexOf(a.id) !== -1 && a.parent_id == null && a._status !== "stale");
    contractSummary.textContent = t("contract.source").replace("{n}", String(roots.length));
    if (!roots.length) {
      contractSourceList.innerHTML = '<div class="src-item" style="color:var(--text-faint)">' + esc(t("contract.empty")) + "</div>";
      return;
    }
    contractSourceList.innerHTML = roots.map((a) => {
      const q = (a.quote || "").slice(0, 48);
      const reps = countReplies(a.id, items);
      return '<div class="src-item"><span class="src-quote">' + esc(q) + '</span><span class="src-meta">' + reps + " " + esc(t("contract.replies")) + "</span></div>";
    }).join("");
  }
  function refreshContractUI() {
    if (!_contractOpen) return;
    const draft = getContractDraft();
    const meta = (window.ChangeContract.MODES || []).find((m) => m.id === draft.mode);
    const req = !!(meta && meta.briefRequired);
    if (contractBriefReq) contractBriefReq.hidden = !req;
    if (contractPlanHint) contractPlanHint.hidden = draft.mode !== "restructure";
    if (contractCopyPrompt) contractCopyPrompt.textContent = (draft.mode === "restructure") ? t("contract.copyPlan") : t("contract.copyPrompt");
    if (contractCloseBtn) contractCloseBtn.setAttribute("aria-label", t("contract.close")); // i18n aria-label(禁硬编码)
    // 选中态:给当前选中模式卡加 .selected(:has 的 JS 兜底,旧 Chromium 也能正确高亮)
    document.querySelectorAll(".mode-card").forEach((c) => {
      const inp = c.querySelector("input"); c.classList.toggle("selected", !!(inp && inp.checked));
    });
    const v = window.ChangeContract.validateDraft(draft, _contractItems);
    if (v.errors.brief) { contractBriefError.textContent = t("contract.briefRequired"); contractBriefError.hidden = false; }
    else { contractBriefError.hidden = true; }
    const disable = !v.ok;
    contractCopyPrompt.disabled = disable;
    contractCopyJson.disabled = disable;
  }
  function openContract(rootIds, items, artifact) {
    _contractItems = items || [];
    _contractSourceRootIds = (rootIds || []).slice();
    _contractArtifact = artifact || { title: "", url: "", isLocal: false };
    _contractOpen = true;
    const precise = document.querySelector('input[name="contract-mode"][value="precise_patch"]');
    if (precise) precise.checked = true;
    contractBrief.value = "";
    contractPreserve.value = "";
    contractBriefError.hidden = true;
    contractFallback.hidden = true;
    contractFallbackText.value = "";
    accountSheet.classList.remove("show");
    avatarBtn.classList.remove("active");
    closeLangSheet();
    renderContractSource();
    refreshContractUI();
    contractSheet.hidden = false;
    contractSheet.classList.add("show");
    setTimeout(() => { try { contractBrief.focus(); } catch (e) {} }, 0);
  }
  function closeContract() {
    _contractOpen = false;
    contractSheet.classList.remove("show");
    contractSheet.hidden = true;
    const el = _contractTriggerEl;
    _contractTriggerEl = null;
    if (el && el.focus) { try { el.focus(); } catch (e) {} }
  }
  function showContractFallback(out) {
    contractFallback.hidden = false;
    contractFallbackText.value = out;
    try { contractFallbackText.focus(); contractFallbackText.select(); } catch (e) {}
    showToast(t("contract.copyFail"));
  }
  function copyContract(kind) {
    const draft = getContractDraft();
    let task;
    try { task = window.ChangeContract.buildTask(draft, _contractItems); }
    catch (e) { showToast(t("contract.copyFail")); return; }
    const out = (kind === "json") ? window.ChangeContract.serialize(task) : window.ChangeContract.renderPrompt(task);
    const btn = (kind === "json") ? contractCopyJson : contractCopyPrompt;
    const orig = btn.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(out).then(() => {
        btn.textContent = t("contract.copied");
        showToast(t("contract.copied"));
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => showContractFallback(out));
    } else {
      showContractFallback(out);
    }
  }

  if (contractCloseBtn) contractCloseBtn.addEventListener("click", closeContract);
  document.querySelectorAll('input[name="contract-mode"]').forEach((r) => r.addEventListener("change", refreshContractUI));
  if (contractBrief) contractBrief.addEventListener("input", refreshContractUI);
  if (contractCopyPrompt) contractCopyPrompt.addEventListener("click", () => copyContract("prompt"));
  if (contractCopyJson) contractCopyJson.addEventListener("click", () => copyContract("json"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _contractOpen) { e.preventDefault(); closeContract(); } });

  // 底部「生成修改任务」:取全部未失效顶层批注 → 打开 Composer(无顶层批注时按钮已 disabled)
  document.getElementById("export-btn").addEventListener("click", () => {
    sendToContent({ type: "get-export" }).then((resp) => {
      if (!resp || resp.type !== "export-data") return;
      const items = resp.items || [];
      const roots = window.ChangeContract.getRoots(items);
      if (!roots.length) { showToast(t("contract.empty")); return; }
      _contractTriggerEl = document.getElementById("export-btn");
      openContract(roots.map((r) => r.id), items, resp.artifact);
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
    else if (e.target.id === "el-textedit") sendToContent({ type: "element-edit-text" });
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
  // change(而非 input):取色确认后一次性施效,避免连续触发时选区 range 失效
  document.getElementById("color-text").addEventListener("change", (e) => sendToContent({ type: "apply-color", kind: "text", color: e.target.value }));
  document.getElementById("color-hl").addEventListener("change", (e) => sendToContent({ type: "apply-color", kind: "highlight", color: e.target.value }));

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
    if (_contractOpen) { renderContractSource(); refreshContractUI(); } // Composer 打开时跟随语言刷新
    refreshLoginState();
    closeLangSheet();
  }

  // 切换标签 / 当前页刷新完成:静默重新激活(确认窗只在侧边栏打开时弹,刷新后不再弹)
  chrome.tabs.onActivated.addListener(() => activateActiveTab(false));
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info && info.status === "complete") activateActiveTab(false); });
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
