// content-script.js — htmlGenius 注入当前页:双模式 + 批注 + overlay + 编辑(本地)
// v0.3.1: 修①侧边栏消失(sendMessage替代port) ②overlay位移(缓存range) ③颜色色板
(function () {
  "use strict";

  const { describe, anchor } = window;

  // === 双模式判断 ===
  const isLocal = ["file:", "data:", "blob:"].includes(location.protocol)
    || ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);

  // === 注入样式 ===
  const style = document.createElement("style");
  style.textContent = `
    .hg-hl{ position:fixed; background:rgba(255,243,160,0.55); pointer-events:none; z-index:2147483646; border-radius:2px; }
    .hg-hl.flash{ background:rgba(251,191,36,0.75); }
    #hg-toolbar{ position:fixed; z-index:2147483647; display:none; background:#1f2328; color:#fff;
      border-radius:6px; padding:4px; gap:2px; align-items:center; box-shadow:0 4px 12px rgba(0,0,0,.25); font-size:13px; }
    #hg-toolbar.show{ display:flex; }
    #hg-toolbar button{ background:transparent; color:#fff; border:0; cursor:pointer; padding:2px 6px; border-radius:4px; font-size:13px; }
    #hg-toolbar button:hover{ background:#374151; }
    #hg-toolbar .hg-sep{ width:1px; height:18px; background:#4b5563; margin:0 2px; }
    #hg-toolbar .hg-colors{ display:none; gap:2px; align-items:center; }
    #hg-toolbar .hg-colors.show{ display:flex; }
    #hg-toolbar .hg-c{ width:16px; height:16px; border-radius:50%; cursor:pointer; border:1px solid rgba(255,255,255,0.3); }
  `;
  document.head.appendChild(style);

  // === 浮工具栏 ===
  const toolbar = document.createElement("div");
  toolbar.id = "hg-toolbar";
  let toolbarHTML = `<button data-act="comment">批注</button>`;
  if (isLocal) {
    toolbarHTML += `<span class="hg-sep"></span><button data-act="bold"><b>B</b></button>`;
    // ③ 预设色板替代 input[type=color]
    const colors = ["#ef4444","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ec4899","#6b7280","#000000"];
    toolbarHTML += `<button data-act="color-toggle">A</button>`;
    toolbarHTML += `<span class="hg-colors" id="hg-colors">`;
    for (const c of colors) toolbarHTML += `<span class="hg-c" data-color="${c}" style="background:${c}"></span>`;
    toolbarHTML += `</span>`;
  }
  toolbar.innerHTML = toolbarHTML;
  document.body.appendChild(toolbar);
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());

  // 色板切换
  const colorPanel = toolbar.querySelector("#hg-colors");
  toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "comment") {
      toolbar.classList.remove("show");
      createAnnotation();
    } else if (btn.dataset.act === "bold") {
      applyStyle("fontWeight", "bold");
    } else if (btn.dataset.act === "color-toggle") {
      if (colorPanel) colorPanel.classList.toggle("show");
    }
  });
  // 色板点击
  if (colorPanel) {
    colorPanel.addEventListener("click", (e) => {
      const sw = e.target.closest(".hg-c");
      if (sw) { applyStyle("color", sw.dataset.color); colorPanel.classList.remove("show"); }
    });
  }

  // === ① 通信改 sendMessage 广播(替代 port) ===
  // content script → side panel: chrome.runtime.sendMessage
  // side panel → content script: chrome.tabs.sendMessage
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get-annotations") {
      sendResponse({ type: "annotations-list", items: window.__hgAnnotations || [], isLocal });
    } else if (msg.type === "scroll-to") {
      const ann = (window.__hgAnnotations || []).find((a) => a.id === msg.id);
      if (ann) {
        const range = anchor(ann.selector, document.body);
        if (range) range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "enable-edit") {
      document.body.contentEditable = "true";
      sendResponse({ ok: true });
    } else if (msg.type === "get-export") {
      sendResponse({ type: "export-data", items: window.__hgAnnotations || [] });
    }
    return true; // 异步 sendResponse
  });

  function broadcastUpdate() {
    chrome.runtime.sendMessage({ type: "annotations-updated" }).catch(() => {});
  }

  // === selectionchange → toolbar 定位(rAF 防抖) ===
  let barRAF = 0;
  document.addEventListener("selectionchange", () => {
    if (barRAF) return;
    barRAF = requestAnimationFrame(() => {
      barRAF = 0;
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { toolbar.classList.remove("show"); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { toolbar.classList.remove("show"); return; }
      toolbar.style.left = (rect.left + rect.width / 2) + "px";
      toolbar.style.top = (rect.top - 8) + "px";
      toolbar.style.transform = "translate(-50%,-100%)";
      toolbar.classList.add("show");
    });
  });

  // === 批注创建 ===
  async function createAnnotation() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const selector = describe(range, document.body);
    if (!selector || !selector.exact) return;
    const comment = prompt("批注评论(可空):") || "";
    const docId = await Storage.getDocumentId();
    await Storage.saveAnnotation({
      document_id: docId, selector, quote: selector.exact,
      body: { comment, action: "rewrite", instruction: "" },
    });
    sel.removeAllRanges();
    await loadAnnotations();
  }

  // === 样式应用(仅本地) ===
  function applyStyle(prop, value) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const span = document.createElement("span");
    span.style[prop] = value;
    try { range.surroundContents(span); }
    catch (e) { span.appendChild(range.extractContents()); range.insertNode(span); }
  }

  // === ② overlay:缓存 range,滚动时只更新 rect(不重 anchor) ===
  let overlayData = []; // [{ divs: [div...], range }]
  async function loadAnnotations() {
    overlayData.forEach((o) => o.divs.forEach((d) => d.remove()));
    overlayData = [];
    const docId = await Storage.getDocumentId();
    const items = await Storage.listAnnotations(docId);
    for (const ann of items) {
      const range = anchor(ann.selector, document.body);
      if (range) {
        ann._status = "open";
        const entry = { divs: [], range };
        for (const r of range.getClientRects()) {
          const div = document.createElement("div");
          div.className = "hg-hl";
          div.style.left = r.left + "px";
          div.style.top = r.top + "px";
          div.style.width = r.width + "px";
          div.style.height = r.height + "px";
          document.body.appendChild(div);
          entry.divs.push(div);
        }
        overlayData.push(entry);
      } else {
        ann._status = "stale";
      }
    }
    window.__hgAnnotations = items;
    broadcastUpdate();
  }

  // 滚动/resize → 只更新 rect(快,不重 anchor)
  let posRAF = 0;
  function updatePositions() {
    if (posRAF) return;
    posRAF = requestAnimationFrame(() => {
      posRAF = 0;
      for (const entry of overlayData) {
        const rects = entry.range.getClientRects();
        // 如果 rect 数量变了(换行变化),重建该条
        if (rects.length !== entry.divs.length) {
          entry.divs.forEach((d) => d.remove());
          entry.divs = [];
          for (const r of rects) {
            const div = document.createElement("div");
            div.className = "hg-hl";
            div.style.left = r.left + "px";
            div.style.top = r.top + "px";
            div.style.width = r.width + "px";
            div.style.height = r.height + "px";
            document.body.appendChild(div);
            entry.divs.push(div);
          }
        } else {
          for (let i = 0; i < rects.length; i++) {
            entry.divs[i].style.left = rects[i].left + "px";
            entry.divs[i].style.top = rects[i].top + "px";
            entry.divs[i].style.width = rects[i].width + "px";
            entry.divs[i].style.height = rects[i].height + "px";
          }
        }
      }
    });
  }
  window.addEventListener("scroll", updatePositions, true);
  window.addEventListener("resize", updatePositions);

  // === 本地模式:版本管理 + 撤销 + 粘贴 ===
  if (isLocal) {
    const undoStack = [];
    const MAX_UNDO = 50;
    let undoDebounce = 0;

    function pushUndo() {
      undoStack.push(document.body.innerHTML);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    }

    function doUndo() {
      if (!undoStack.length) return;
      document.body.innerHTML = undoStack.pop();
      loadAnnotations();
    }

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        doUndo();
      }
    });

    let versionTimer = 0;
    document.body.addEventListener("input", () => {
      clearTimeout(undoDebounce);
      undoDebounce = setTimeout(pushUndo, 1000);
      clearTimeout(versionTimer);
      versionTimer = setTimeout(async () => {
        const docId = await Storage.getDocumentId();
        const html = document.documentElement.outerHTML;
        await Storage.saveVersion(docId, html);
      }, 1500);
    });

    document.body.addEventListener("paste", (e) => {
      e.preventDefault();
      const cd = e.clipboardData || {};
      const html = cd.getData("text/html") || "";
      const text = cd.getData("text/plain") || "";
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      if (html && window.DOMPurify) {
        const clean = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
        range.insertNode(range.createContextualFragment(clean));
      } else {
        range.insertNode(document.createTextNode(text));
      }
      range.collapse(false);
    });
  }

  // === 初始化 ===
  loadAnnotations();
  if (isLocal) document.body.contentEditable = "true";
  console.log("htmlGenius v0.3.1 ready, mode:", isLocal ? "local(editable)" : "remote(readonly)");
})();
