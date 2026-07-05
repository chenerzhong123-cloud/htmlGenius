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
          renderMode();
          renderCards(resp.items);
        }
      });
    } else if (msg.type === "presence") {
      // content-script 转发的在线用户列表
      renderPresence(msg.users);
    }
  });

  function renderMode() {
    const el = document.getElementById("mode-indicator");
    el.textContent = isLocal ? "\u{1F4CD} 本地文档(可编辑)" : "\u{1F310} 远程网页(只读批注)";
    el.className = isLocal ? "local" : "remote";
    document.getElementById("edit-btn").hidden = isLocal;
  }

  function renderCards(items) {
    const c = document.getElementById("annotations");
    c.innerHTML = "";
    if (!items || items.length === 0) {
      c.innerHTML = '<div class="empty">选中文字 → 点「批注」</div>';
      return;
    }
    for (const ann of items) {
      const card = document.createElement("div");
      card.className = "card" + (ann._status === "stale" ? " stale" : "");
      const quote = (ann.quote || "").slice(0, 60);
      const comment = (ann.body && ann.body.comment) || "(无评论)";
      card.innerHTML = '<div class="quote">' + esc(quote) + '</div><div>' + esc(comment) + '</div>';
      card.addEventListener("click", () => sendToContent({ type: "scroll-to", id: ann.id }));
      c.appendChild(card);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  document.getElementById("export-btn").addEventListener("click", () => {
    sendToContent({ type: "get-export" }).then((resp) => {
      if (resp && resp.type === "export-data") exportPrompt(resp.items);
    });
  });

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (confirm("⚠ 编辑仅本地临时修改,刷新或关闭页面后丢失,无法保存回原网页。\n\n确认进入编辑模式?")) {
      sendToContent({ type: "enable-edit" });
      document.getElementById("edit-btn").hidden = true;
      document.getElementById("mode-indicator").textContent = "\u{1F4DD} 编辑模式(临时)";
    }
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
      renderMode();
      renderCards(resp.items);
    }
  });
  loadCfg();

  function exportPrompt(items) {
    if (!items || items.length === 0) { alert("暂无批注"); return; }
    const lines = items.map((a, i) => {
      const sel = a.selector || {};
      const exact = sel.exact || a.quote || "";
      const prefix = (sel.prefix || "").trim();
      const suffix = (sel.suffix || "").trim();
      const loc = (prefix || suffix)
        ? "定位:" + (prefix ? "前文「" + prefix + "」 " : "") + "【原文】「" + exact + "」" + (suffix ? " 后文「" + suffix + "」" : "")
        : "定位:【原文】「" + exact + "」";
      return "==批注" + (i + 1) + "==\n" + loc + "\n评论:" + ((a.body && a.body.comment) || "(无)");
    });
    const prompt = "你是一名 HTML 编辑执行器。下面给出文档的 " + items.length + " 条批注,请逐条执行修改,并输出完整的新版 HTML:\n\n" + lines.join("\n\n");
    navigator.clipboard.writeText(prompt).then(() => {
      const btn = document.getElementById("export-btn");
      btn.textContent = "已复制 ✓";
      setTimeout(() => btn.textContent = "回灌", 1500);
    });
  }
})();
