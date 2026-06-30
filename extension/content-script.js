// content-script.js — htmlGenius 注入当前页:双模式 + 批注 + overlay + 编辑(本地)
(function () {
  "use strict";

  // text-quote.js 在 content_scripts 中先加载,暴露全局 describe/anchor
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
      border-radius:6px; padding:4px; gap:4px; align-items:center; box-shadow:0 4px 12px rgba(0,0,0,.25); font-size:13px; }
    #hg-toolbar.show{ display:flex; }
    #hg-toolbar button{ background:transparent; color:#fff; border:0; cursor:pointer; padding:2px 8px; border-radius:4px; font-size:13px; }
    #hg-toolbar button:hover{ background:#374151; }
    #hg-toolbar .hg-sep{ width:1px; height:18px; background:#4b5563; margin:0 2px; }
    #hg-toolbar input[type=color]{ width:24px; height:24px; border:0; border-radius:4px; background:transparent; }
  `;
  document.head.appendChild(style);

  // === 浮工具栏 ===
  const toolbar = document.createElement("div");
  toolbar.id = "hg-toolbar";
  let toolbarHTML = `<button data-act="comment">批注</button>`;
  if (isLocal) {
    toolbarHTML += `<span class="hg-sep"></span><button data-act="bold"><b>B</b></button><input type="color" data-act="color">`;
  }
  toolbar.innerHTML = toolbarHTML;
  document.body.appendChild(toolbar);
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());

  // === side panel 通信 ===
  let port = chrome.runtime.connect({ name: "content" });
  port.onMessage.addListener(handlePanelMessage);

  // === selectionchange → toolbar 定位 ===
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

  // === toolbar 点击 ===
  toolbar.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "comment") {
      toolbar.classList.remove("show");
      await createAnnotation();
    } else if (btn.dataset.act === "bold") {
      applyStyle("fontWeight", "bold");
    }
  });
  const colorInput = toolbar.querySelector('input[data-act="color"]');
  if (colorInput) colorInput.addEventListener("input", (e) => applyStyle("color", e.target.value));

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

  // === overlay 高亮 ===
  let overlays = [];
  async function loadAnnotations() {
    overlays.forEach((o) => o.remove());
    overlays = [];
    const docId = await Storage.getDocumentId();
    const items = await Storage.listAnnotations(docId);
    for (const ann of items) {
      const range = anchor(ann.selector, document.body);
      if (range) {
        ann._status = "open";
        for (const r of range.getClientRects()) {
          const div = document.createElement("div");
          div.className = "hg-hl";
          div.style.left = r.left + "px";
          div.style.top = r.top + "px";
          div.style.width = r.width + "px";
          div.style.height = r.height + "px";
          document.body.appendChild(div);
          overlays.push(div);
        }
      } else {
        ann._status = "stale";
      }
    }
    window.__hgAnnotations = items;
    sendToPanel({ type: "annotations-updated" });
  }

  // 滚动/resize → rAF 重定位 overlay
  let updateRAF = 0;
  function scheduleUpdate() {
    if (updateRAF) return;
    updateRAF = requestAnimationFrame(() => { updateRAF = 0; loadAnnotations(); });
  }
  window.addEventListener("scroll", scheduleUpdate, true);
  window.addEventListener("resize", scheduleUpdate);

  // === 通信 ===
  function sendToPanel(msg) { if (port) port.postMessage(msg); }
  function handlePanelMessage(msg) {
    if (msg.type === "get-annotations") {
      sendToPanel({ type: "annotations-list", items: window.__hgAnnotations || [], isLocal });
    } else if (msg.type === "scroll-to") {
      const items = window.__hgAnnotations || [];
      const ann = items.find((a) => a.id === msg.id);
      if (ann) {
        const range = anchor(ann.selector, document.body);
        if (range) range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } else if (msg.type === "enable-edit") {
      document.body.contentEditable = "true";
    } else if (msg.type === "get-export") {
      sendToPanel({ type: "export-data", items: window.__hgAnnotations || [] });
    }
  }

  // === 初始化 ===
  loadAnnotations();
  if (isLocal) document.body.contentEditable = "true";
  console.log("htmlGenius ready, mode:", isLocal ? "local(editable)" : "remote(readonly)");
})();
