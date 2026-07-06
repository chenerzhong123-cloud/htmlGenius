// sidepanel.js — v0.3.1: 改用 sendMessage(替代 port)
(function () {
  "use strict";

  let isLocal = false;
  let currentTabId = null;

  // 获取当前活跃 tab
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  // 发消息到 content script
  async function sendToContent(msg) {
    const tab = await getActiveTab();
    if (!tab) return null;
    currentTabId = tab.id;
    try { return await chrome.tabs.sendMessage(tab.id, msg); }
    catch (e) { console.log("content script not ready:", e); return null; }
  }

  // 接收 content script 广播
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === "annotations-updated") {
      // 请求最新列表
      sendToContent({ type: "get-annotations" }).then((resp) => {
        if (resp && resp.type === "annotations-list") {
          isLocal = resp.isLocal;
          _editing = !!resp.editing; // Fix #3: 以页面实际编辑态为准(刷新后复位为查看)
          renderMode();
          renderCards(resp.items);
        }
      });
    } else if (msg.type === "presence") {
      // content-script 转发的在线用户列表
      renderPresence(msg.users);
    }
  });

  let _editing = false;

  function renderMode() {
    const el = document.getElementById("mode-indicator");
    const btn = document.getElementById("edit-btn");
    btn.hidden = false;  // 始终可见(toggle)
    // Fix #3/#2: 按钮文案始终由 _editing(页面真相源)决定,避免与页面漂移。
    if (_editing) {
      el.textContent = "\u{1F4DD} 编辑模式";
      btn.textContent = "切换查看模式";
    } else {
      el.textContent = isLocal ? "\u{1F4CD} 本地文档(可编辑)" : "\u{1F310} 远程网页(只读批注)";
      btn.textContent = "切换编辑模式";
    }
    el.className = isLocal ? "local" : "remote";
  }

  function renderCards(items) {
    const c = document.getElementById("annotations");
    c.innerHTML = "";
    if (!items || items.length === 0) {
      c.innerHTML = '<div class="empty">选中文字 → 点「批注」</div>';
      return;
    }
    // 按 parent_id 建树(null 为顶层)
    const byParent = {};
    items.forEach((a) => {
      const k = a.parent_id || null;
      (byParent[k] = byParent[k] || []).push(a);
    });
    function renderNode(ann, depth) {
      const card = document.createElement("div");
      card.className = "card" + (ann._status === "stale" ? " stale" : "");
      card.style.marginLeft = (depth * 14) + "px";
      const quote = (ann.quote || "").slice(0, 60);
      const comment = (ann.body && ann.body.comment) || "(无评论)";
      const who = (ann.author && ann.author.name) ? "[" + ann.author.name + "]" : "";
      // Fix #5: who/quote 仍转义;comment 走 linkify(先转义再包 <a>),URL 可点。
      card.innerHTML = '<div class="quote">' + esc(quote) + '</div><div>' + esc(who + " ") + linkify(comment) + '</div>';
      // hover 动作条
      const acts = document.createElement("div");
      acts.className = "card-acts";
      const reply = document.createElement("button");
      reply.textContent = "回复"; reply.title = "回复";
      reply.addEventListener("click", (e) => { e.stopPropagation(); doReply(ann); });
      acts.appendChild(reply);
      chrome.storage.sync.get(["user"], (cfg) => {
        const me = cfg.user && cfg.user.id;
        // 本地模式单用户:所有批注均可删;协同模式:仅作者本人。
        if (isLocal || (ann.author && ann.author.id === me)) {
          const del = document.createElement("button");
          del.textContent = "删除"; del.title = "删除";
          del.addEventListener("click", (e) => { e.stopPropagation(); doDelete(ann); });
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

  function doReply(parent) {
    const name = (parent.author && parent.author.name) || "";
    const comment = prompt("回复 @" + name + ":");
    if (comment == null) return;
    sendToContent({ type: "reply", parentId: parent.id, comment: comment || "" });
  }

  function doDelete(ann) {
    if (!confirm("删除这条批注?回复将一并删除。")) return;
    sendToContent({ type: "delete-annotation", id: ann.id }).then((r) => {
      if (r && r.forbidden) alert("只能删除自己的批注");
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Fix #5: 评论里的 URL 转链接。先转义再插 <a>,故无 XSS 风险。
  function linkify(text) {
    const safe = esc(text);
    return safe.replace(/https?:\/\/[^\s<]+/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>');
  }

  document.getElementById("export-btn").addEventListener("click", () => {
    sendToContent({ type: "get-export" }).then((resp) => {
      if (resp && resp.type === "export-data") {
        const items = resp.items || [];
        if (!items.length) { alert("暂无批注"); return; }
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
    renderMode(); // 文案/指示由 _editing 统一驱动
  });

  // === 协同配置(token+用户)+ presence 展示 (T11) ===
  const CFG_KEYS = ["mode", "backend", "team_token", "user"];

  function toggleCfgFields() {
    const synced = document.getElementById("cfg-mode").value === "synced";
    ["cfg-backend", "cfg-token", "cfg-username"].forEach((id) => {
      document.getElementById(id).hidden = !synced;
    });
  }

  function loadCfg() {
    chrome.storage.sync.get(CFG_KEYS, (c) => {
      document.getElementById("cfg-mode").value = c.mode || "local";
      document.getElementById("cfg-backend").value = c.backend || "";
      document.getElementById("cfg-token").value = c.team_token || "";
      document.getElementById("cfg-username").value = (c.user && c.user.name) || "";
      toggleCfgFields();
    });
  }

  function saveCfg() {
    // 先读旧 user.id,保留稳定身份(避免每次保存变 id)
    chrome.storage.sync.get(["user"], (cur) => {
      const oldId = cur.user && cur.user.id;
      const cfg = {
        mode: document.getElementById("cfg-mode").value,
        backend: document.getElementById("cfg-backend").value.trim(),
        team_token: document.getElementById("cfg-token").value.trim(),
        user: {
          id: oldId || ("u_" + Math.random().toString(36).slice(2, 8)),
          name: document.getElementById("cfg-username").value.trim() || "匿名",
        },
      };
      chrome.storage.sync.set(cfg, () => {
        const btn = document.getElementById("cfg-save");
        btn.textContent = "已保存 ✓";
        setTimeout(() => (btn.textContent = "保存配置"), 1500);
        alert("刷新页面生效");
      });
    });
  }

  function renderPresence(users) {
    const el = document.getElementById("presence");
    if (!users || users.length === 0) { el.textContent = ""; return; }
    el.textContent = "在线: " + users.map((u) => u.name || u.id).join(", ");
  }

  document.getElementById("cfg-mode").addEventListener("change", toggleCfgFields);
  document.getElementById("cfg-save").addEventListener("click", saveCfg);

  // 初始化:请求批注列表 + 加载配置
  sendToContent({ type: "get-annotations" }).then((resp) => {
    if (resp && resp.type === "annotations-list") {
      isLocal = resp.isLocal;
      _editing = !!resp.editing; // Fix #3: 初始即同步页面编辑态(刷新后为查看)
      renderMode();
      renderCards(resp.items);
    }
  });
  loadCfg();
})();
