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

  // === 飞书登录(v0.5 协同) ===
  const loginBtn = document.getElementById("lark-login-btn");
  const backendInput = document.getElementById("backend-input");
  const loginState = document.getElementById("login-state");

  function getCfg(keys) { return new Promise((r) => chrome.storage.sync.get(keys, r)); }
  function setCfg(obj) { return new Promise((r) => chrome.storage.sync.set(obj, r)); }

  function renderLogoutBtn() {
    if (document.getElementById("logout-btn")) return;
    const b = document.createElement("button");
    b.id = "logout-btn"; b.textContent = "退出登录";
    b.addEventListener("click", doLogout);
    loginState.appendChild(b);
  }
  async function doLogout() {
    const cfg = await getCfg(["backend", "session_token"]);
    if (cfg.backend && cfg.session_token) {
      try {
        await fetch(cfg.backend + "/auth/logout", {
          method: "POST", headers: { Authorization: "Bearer " + cfg.session_token },
        });
      } catch (e) { /* 忽略:本地清 storage 即可 */ }
    }
    await new Promise((r) => chrome.storage.sync.remove(["session_token", "user", "mode"], r));
    loginState.textContent = "已退出(刷新页面回到本地模式)";
    const ob = document.getElementById("logout-btn"); if (ob) ob.remove();
  }
  async function checkSession() {
    const cfg = await getCfg(["mode", "backend", "session_token"]);
    if (cfg.backend) backendInput.value = cfg.backend;
    if (cfg.mode === "synced" && cfg.session_token && cfg.backend) {
      try {
        const me = await fetch(cfg.backend + "/auth/me", {
          headers: { Authorization: "Bearer " + cfg.session_token },
        }).then((r) => (r.ok ? r.json() : null));
        if (me && me.id) {
          loginState.textContent = "已登录:" + (me.name || me.id) + " ";
          renderLogoutBtn();
          return;
        }
      } catch (e) { /* 失效,落到下行提示 */ }
      loginState.textContent = "登录已失效,请重新登录";
    }
  }
  loginBtn.addEventListener("click", async () => {
    const backend = (backendInput.value || "").trim().replace(/\/+$/, "");
    if (!backend) { showToast("请填后端地址"); return; }
    if (!/^https?:\/\//.test(backend)) { showToast("后端地址需以 http(s):// 开头"); return; }
    loginState.textContent = "登录中…";
    try {
      const r = await Login.start({ backend });
      await setCfg({ mode: "synced", backend, session_token: r.token, user: r.user });
      loginState.textContent = "已登录:" + (r.user.name || r.user.id) + " ";
      renderLogoutBtn();
      showToast("登录成功,刷新页面以接入协同");
    } catch (e) {
      loginState.textContent = "登录失败:" + (e && e.message ? e.message : e);
    }
  });
  checkSession();

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
