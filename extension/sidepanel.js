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
          renderMode();
          renderCards(resp.items);
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
    if (tools) tools.hidden = !_editing; // #3a: 会话动作仅编辑态显示
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

  document.getElementById("export-btn").addEventListener("click", () => {
    sendToContent({ type: "get-export" }).then((resp) => {
      if (resp && resp.type === "export-data") {
        const items = resp.items || [];
        if (!items.length) { showToast(t("export.empty")); return; }
        const prompt = (window.BuildPrompt ? BuildPrompt.fromAnnotations(items) : "");
        navigator.clipboard.writeText(prompt).then(() => {
          const btn = document.getElementById("export-btn");
          btn.textContent = t("export.copied");
          setTimeout(() => (btn.textContent = t("export.btn")), 1500);
        });
      }
    });
  });

  document.getElementById("edit-btn").addEventListener("click", () => {
    // 编辑态由 content-script 经 edit-state 广播同步;此处乐观翻转即时反馈
    sendToContent({ type: _editing ? "disable-edit" : "enable-edit" });
    _editing = !_editing;
    renderMode();
  });

  // #3a/#3b: 侧边栏会话动作 + 取色 → 发消息给 content-script(content-script 在页面施效)
  document.getElementById("act-undo").addEventListener("click", () => sendToContent({ type: "undo" }));
  document.getElementById("act-redo").addEventListener("click", () => sendToContent({ type: "redo" }));
  document.getElementById("act-reset").addEventListener("click", () => sendToContent({ type: "reset-edit" }));
  document.getElementById("act-save").addEventListener("click", () => sendToContent({ type: "save-html" }));
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
      renderMode();
      renderCards(resp.items);
    }
  })();
})();
