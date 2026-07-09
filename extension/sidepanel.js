// sidepanel.js — v0.4.1: 内联交互(创建/回复/删除均不用浏览器弹窗)
(function () {
  "use strict";

  let isLocal = false;
  let currentTabId = null;
  let _pendingSelector = null; // 新建批注草稿的 {selector, quote}(来自 content-script)
  let _toastTimer = 0;

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
    }
  });

  let _editing = false;

  function renderMode() {
    const el = document.getElementById("mode-indicator");
    const btn = document.getElementById("edit-btn");
    btn.hidden = false;
    if (_editing) {
      el.textContent = "\u{1F4DD} 编辑模式";
      btn.textContent = "切换查看模式";
    } else {
      el.textContent = isLocal ? "\u{1F4CD} 本地文档(可编辑)" : "\u{1F310} 远程网页(只读批注)";
      btn.textContent = "切换编辑模式";
    }
  }

  function renderCards(items) {
    const c = document.getElementById("annotations");
    c.innerHTML = "";
    if (!items || items.length === 0) {
      c.innerHTML = '<div class="empty">选中文字 → 点「批注」</div>';
      return;
    }
    const byParent = {};
    items.forEach((a) => { const k = a.parent_id || null; (byParent[k] = byParent[k] || []).push(a); });
    function renderNode(ann, depth) {
      const card = document.createElement("div");
      card.className = "card" + (ann._status === "stale" ? " stale" : "");
      card.style.marginLeft = (depth * 14) + "px";
      const quote = (ann.quote || "").slice(0, 60);
      const comment = (ann.body && ann.body.comment) || "(无评论)";
      const who = (ann.author && ann.author.name) ? "[" + ann.author.name + "]" : "";
      card.innerHTML = '<div class="quote">' + esc(quote) + '</div><div>' + esc(who + " ") + linkify(comment) + '</div>';
      const acts = document.createElement("div");
      acts.className = "card-acts";
      const reply = document.createElement("button");
      reply.textContent = "回复"; reply.title = "回复";
      reply.addEventListener("click", (e) => { e.stopPropagation(); doReply(ann, card); });
      acts.appendChild(reply);
      chrome.storage.sync.get(["user", "mode"], (cfg) => {
        const me = cfg.user && cfg.user.id;
        if (cfg.mode !== "synced" || (ann.author && ann.author.id === me)) {
          const del = document.createElement("button");
          del.textContent = "删除"; del.title = "删除";
          del.addEventListener("click", (e) => { e.stopPropagation(); doDelete(ann, card); });
          acts.appendChild(del);
        }
      });
      card.appendChild(acts);
      card.addEventListener("click", () => sendToContent({ type: "scroll-to", id: ann.id }));
      c.appendChild(card);
      (byParent[ann.id] || []).forEach((ch) => renderNode(ch, depth + 1));
    }
    (byParent[null] || []).forEach((a) => renderNode(a, 0));
  }

  // === 新建批注:内联草稿块(替代浏览器 prompt)===
  function showDraft(selector, quote) {
    cancelDraft();
    _pendingSelector = { selector, quote };
    const host = document.getElementById("draft-host");
    const draft = document.createElement("div");
    draft.className = "draft-card";
    draft.innerHTML =
      '<div class="draft-label">新建批注</div>' +
      '<div class="quote">' + esc((quote || "").slice(0, 80)) + '</div>' +
      '<textarea class="draft-input" placeholder="写评论…(Enter 保存 · Shift+Enter 换行)" rows="3"></textarea>' +
      '<div class="draft-acts"><button class="draft-cancel">取消</button><button class="draft-save">保存</button></div>';
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
      '<textarea placeholder="回复…(Enter 保存 · Shift+Enter 换行)" rows="2"></textarea>' +
      '<div class="draft-acts"><button class="reply-cancel">取消</button><button class="reply-save">保存</button></div>';
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

  // === 删除:卡片内联确认(替代浏览器 confirm)===
  function doDelete(ann, card) {
    card.querySelectorAll(".reply-editor, .delete-confirm").forEach((e) => e.remove());
    const conf = document.createElement("div");
    conf.className = "delete-confirm";
    conf.innerHTML = '<span>删除这条?回复一并删除。</span><button class="del-cancel">取消</button><button class="del-ok">确认删除</button>';
    card.appendChild(conf);
    conf.querySelector(".del-ok").addEventListener("click", () => {
      sendToContent({ type: "delete-annotation", id: ann.id }).then((r) => {
        if (r && r.forbidden) showToast("只能删除自己的批注");
      });
      conf.remove();
    });
    conf.querySelector(".del-cancel").addEventListener("click", () => conf.remove());
  }

  function showToast(msg) {
    let t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
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
        if (!items.length) { showToast("暂无批注"); return; }
        const prompt = (window.BuildPrompt ? BuildPrompt.fromAnnotations(items) : "");
        navigator.clipboard.writeText(prompt).then(() => {
          const btn = document.getElementById("export-btn");
          btn.textContent = "已复制 ✓";
          setTimeout(() => (btn.textContent = "一键复制所有评论"), 1500);
        });
      }
    });
  });

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (!_editing) {
      if (!isLocal && !confirm("⚠ 编辑仅本地临时修改,刷新或关闭页面后丢失,无法保存回原网页。\n\n进入编辑模式?")) return;
      sendToContent({ type: "enable-edit" });
      _editing = true;
    } else {
      sendToContent({ type: "disable-edit" });
      _editing = false;
    }
    renderMode();
  });

  function renderPresence(users) {
    const el = document.getElementById("presence");
    if (!users || users.length === 0) { el.textContent = ""; return; }
    el.textContent = "在线: " + users.map((u) => u.name || u.id).join(", ");
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

  async function applySession(r) {
    await setCfg({ mode: "synced", backend: BACKEND, session_token: r.token, user: r.user });
    loginState.textContent = "已登录:" + (r.user.name || r.user.id) + " ";
    renderLogoutBtn();
    renderInviteBtn();
    if (teamSetup) teamSetup.hidden = true;
    const tab = await getActiveTab();
    if (tab && tab.id) { try { await chrome.tabs.reload(tab.id); } catch (e) { /* 非关键 */ } }
  }
  function renderLogoutBtn() {
    if (document.getElementById("logout-btn")) return;
    const b = document.createElement("button");
    b.id = "logout-btn"; b.textContent = "退出";
    b.addEventListener("click", doLogout);
    loginState.appendChild(b);
  }
  function renderInviteBtn() {
    if (document.getElementById("invite-btn")) return;
    const b = document.createElement("button");
    b.id = "invite-btn"; b.textContent = "邀请队友";
    b.addEventListener("click", doInvite);
    loginState.appendChild(b);
  }
  async function doLogout() {
    const cfg = await getCfg(["session_token"]);
    if (cfg.session_token) {
      try { await fetch(BACKEND + "/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + cfg.session_token } }); } catch (e) { /* 忽略 */ }
    }
    await new Promise((r) => chrome.storage.sync.remove(["session_token", "user", "mode"], r));
    loginState.textContent = "已退出";
    ["logout-btn", "invite-btn"].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
  }
  async function doInvite() {
    const cfg = await getCfg(["session_token"]);
    try {
      const r = await fetch(BACKEND + "/auth/invites", { method: "POST", headers: { Authorization: "Bearer " + cfg.session_token } });
      const j = await r.json();
      if (j.code) {
        showToast("邀请码已复制:" + j.code);
        try { await navigator.clipboard.writeText(j.code); } catch (e) {}
      }
    } catch (e) { showToast("邀请失败"); }
  }

  // 飞书登录
  loginBtn.addEventListener("click", async () => {
    loginState.textContent = "飞书登录中…";
    try {
      const r = await Login.start({ backend: BACKEND });
      await applySession(r);
      showToast("飞书登录成功");
    } catch (e) { loginState.textContent = "登录失败:" + (e && e.message ? e.message : e); }
  });

  // Google 登录(交互)
  googleBtn.addEventListener("click", async () => {
    loginState.textContent = "Google 登录中…";
    try {
      const r = await Login.googleStart({ interactive: true });
      if (r.token) { await applySession(r); showToast("Google 登录成功"); }
      else { loginState.textContent = "登录成功,请加入或新建团队"; if (teamSetup) teamSetup.hidden = false; }
    } catch (e) { loginState.textContent = "登录失败:" + (e && e.message ? e.message : e); }
  });

  // 加入团队(凭码)
  document.getElementById("join-btn").addEventListener("click", async () => {
    const code = (inviteInput.value || "").trim();
    if (!code) { showToast("填邀请码"); return; }
    loginState.textContent = "加入中…";
    try {
      const r = await Login.googleStart({ interactive: true, action: "join", code });
      if (r.token) { await applySession(r); showToast("已加入团队"); }
      else { loginState.textContent = "加入失败(码无效?)"; }
    } catch (e) { loginState.textContent = "加入失败:" + (e && e.message ? e.message : e); }
  });
  // 新建团队
  document.getElementById("create-team-btn").addEventListener("click", async () => {
    loginState.textContent = "建团中…";
    try {
      const r = await Login.googleStart({ interactive: true, action: "create" });
      if (r.token) { await applySession(r); showToast("已创建并加入团队"); }
    } catch (e) { loginState.textContent = "建团失败:" + (e && e.message ? e.message : e); }
  });

  // join 链接页(/hg/join?code=)content-script 发来的码 → 预填 + 展开
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "join-code" && inviteInput) {
      inviteInput.value = msg.code;
      if (teamSetup) teamSetup.hidden = false;
      loginState.textContent = "已填入邀请码,点「Google 登录」→「加入团队」";
    }
  });

  // 静默重登:侧栏打开 → getAuthToken(非交互)→ 有团队直接 session;否则查已有 session
  async function silentReauth() {
    try {
      const r = await Login.googleStart({ interactive: false });
      if (r.token) { await applySession(r); return; }
      if (r.teams && r.teams.length === 0) { loginState.textContent = "请加入或新建团队"; if (teamSetup) teamSetup.hidden = false; return; }
    } catch (e) { /* 无 Google token,落到 storage 检查 */ }
    const cfg = await getCfg(["mode", "session_token"]);
    if (cfg.mode === "synced" && cfg.session_token) {
      try {
        const me = await fetch(BACKEND + "/auth/me", { headers: { Authorization: "Bearer " + cfg.session_token } }).then((r) => (r.ok ? r.json() : null));
        if (me && me.id) {
          loginState.textContent = "已登录:" + (me.name || me.id) + " ";
          renderLogoutBtn(); renderInviteBtn();
          return;
        }
      } catch (e) {}
      loginState.textContent = "登录已失效,请重新登录";
    }
  }
  silentReauth();

  // 初始化
  sendToContent({ type: "get-annotations" }).then((resp) => {
    if (resp && resp.type === "annotations-list") {
      isLocal = resp.isLocal;
      _editing = !!resp.editing;
      renderMode();
      renderCards(resp.items);
    }
  });
})();
