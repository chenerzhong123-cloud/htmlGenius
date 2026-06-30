// sidepanel.js — htmlGenius 侧边栏:批注卡片 + 回灌 + 编辑入口
(function () {
  "use strict";

  let port = chrome.runtime.connect({ name: "panel" });
  let isLocal = false;

  port.onMessage.addListener((msg) => {
    if (msg.type === "annotations-list") {
      isLocal = msg.isLocal;
      renderMode();
      renderCards(msg.items);
    } else if (msg.type === "annotations-updated") {
      port.postMessage({ type: "get-annotations" });
    } else if (msg.type === "export-data") {
      exportPrompt(msg.items);
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
      card.addEventListener("click", () => port.postMessage({ type: "scroll-to", id: ann.id }));
      c.appendChild(card);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  document.getElementById("export-btn").addEventListener("click", () => {
    port.postMessage({ type: "get-export" });
  });

  document.getElementById("edit-btn").addEventListener("click", () => {
    if (confirm("⚠ 编辑仅本地临时修改,刷新或关闭页面后丢失,无法保存回原网页。\n\n确认进入编辑模式?")) {
      port.postMessage({ type: "enable-edit" });
      document.getElementById("edit-btn").hidden = true;
      document.getElementById("mode-indicator").textContent = "\u{1F4DD} 编辑模式(临时)";
    }
  });

  // 初始化:请求批注列表
  port.postMessage({ type: "get-annotations" });

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
    const prompt = "你是一名 HTML 编辑执行器。下面给出文档的 " + items.length + " 条批注,请且定你逐条执行修改,并输出完整的新版 HTML:\n\n" + lines.join("\n\n");
    navigator.clipboard.writeText(prompt).then(() => {
      const btn = document.getElementById("export-btn");
      btn.textContent = "已复制 ✓";
      setTimeout(() => btn.textContent = "回灌", 1500);
    });
  }
})();
