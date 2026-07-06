// content-script.js — htmlGenius 注入当前页:双模式 + 批注 + overlay + 编辑(本地)
// v0.3.1: 修①侧边栏消失(sendMessage替代port) ②overlay位移(缓存range) ③颜色色板
(function () {
  "use strict";

  const { describe, anchor } = window;

  // === 协同 sync/mode:读 chrome.storage.sync,mode==="synced" 才接入后端 ===
  // 无配置或 mode 为 local/unset → 走 LocalStore(零回归)。
  let _cfg = { mode: "local" };
  let _sync = null;
  // Fix #4: cfg 读取异步,但 createAnnotation/reply 必须在 _cfg.user 就绪后才能保存
  // (否则 RemoteStore 用默认 X-User-Id: u_self → author.id 与 sidepanel 的 cfg.user.id 不匹配 → 无删除按钮)。
  // 用 Promise 让保存路径 await 它。
  const cfgReady = new Promise((resolve) => {
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(
        ["mode", "backend", "team_token", "user"],
        (c) => {
          _cfg = Object.assign({}, _cfg, c || {});
          if (_cfg.mode === "synced") {
            Storage.configure(_cfg); // 切到 RemoteStore
            startSync();
          }
          resolve(_cfg);
        }
      );
    } else {
      resolve(_cfg);
    }
  });

  // applyRemoteChange:把 delta 应用到 window.__hgAnnotations(纯 Sync.applyDelta)
  // 再调 loadAnnotations() 重渲染 overlay(读 Storage 全量 + anchor)。
  // 测试钩子:window.__hgApplyRemoteChange。
  function applyRemoteChange(delta) {
    if (!window.__hgAnnotations) window.__hgAnnotations = [];
    if (window.Sync && typeof window.Sync.applyDelta === "function") {
      window.Sync.applyDelta(window.__hgAnnotations, delta);
    }
    loadAnnotations();
  }
  window.__hgApplyRemoteChange = applyRemoteChange;

  // startSync:解析 docId 后开 EventSource,回调映射到 applyRemoteChange。
  function startSync() {
    if (!window.Sync) return;
    Storage.getDocumentId().then((docId) => {
      _sync = window.Sync.start({
        backend: _cfg.backend,
        team_token: _cfg.team_token,
        docId,
        user: _cfg.user,
        onCreate: (ann) => applyRemoteChange({ op: "create", annotation: ann }),
        onDelete: (id) => applyRemoteChange({ op: "delete", id }),
        // §5.3 重连/首连对账:onopen 时全量 GET 一次,补齐断线期间漏掉的 delta。
        onReconnect: () => loadAnnotations(),
        onPresence: (users) => {
          try {
            chrome.runtime.sendMessage({ type: "presence", users }).catch(() => {});
          } catch (e) { /* 非关键路径 */ }
        },
      });
    });
  }

  window.addEventListener("beforeunload", () => { if (_sync) _sync.stop(); });


  // === 双模式判断 ===
  const isLocal = ["file:", "data:", "blob:"].includes(location.protocol)
    || ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);

  // Fix #3/#2: content-script 是编辑态的唯一真相源,sidepanel 经 get-annotations 同步。
  // 页面始终以「查看」模式启动(含刷新);进入编辑需显式 enable-edit。
  let _editing = false;
  // Fix #1: 编辑输入后延迟重锚定 overlay 高亮。
  let reanchorTimer = 0;

  // === 注入样式 ===
  const style = document.createElement("style");
  style.textContent = `
    .hg-hl{ position:fixed; background:rgba(232,165,90,0.32); pointer-events:none; z-index:2147483646; border-radius:2px; }
    .hg-hl.flash{ background:rgba(204,120,92,0.5); }
    #hg-toolbar{ position:fixed; z-index:2147483647; display:none; background:#181715; color:#faf9f5;
      border-radius:8px; padding:4px; gap:2px; align-items:center; box-shadow:0 4px 12px rgba(0,0,0,.28); font-size:13px;
      font-family:"Inter","PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,system-ui,sans-serif; }
    #hg-toolbar.show{ display:flex; }
    #hg-toolbar button{ background:transparent; color:#faf9f5; border:0; cursor:pointer; padding:4px 8px; border-radius:6px; font-size:13px; }
    #hg-toolbar button:hover{ background:#252320; }
    #hg-toolbar button[data-act="comment"]{ background:#cc785c; color:#fff; }
    #hg-toolbar button[data-act="comment"]:hover{ background:#a9583e; }
    #hg-toolbar .hg-sep{ width:1px; height:18px; background:#3a3935; margin:0 2px; }
    #hg-toolbar .hg-colors{ display:none; gap:2px; align-items:center; }
    #hg-toolbar .hg-colors.show{ display:flex; }
    #hg-toolbar .hg-c{ width:16px; height:16px; border-radius:50%; cursor:pointer; border:1px solid rgba(250,249,245,0.3); }
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
      sendResponse({ type: "annotations-list", items: window.__hgAnnotations || [], isLocal, editing: _editing });
    } else if (msg.type === "scroll-to") {
      const ann = (window.__hgAnnotations || []).find((a) => a.id === msg.id);
      if (ann) {
        const range = anchor(ann.selector, document.body);
        if (range) range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "enable-edit") {
      document.body.contentEditable = "true"; _editing = true;
      sendResponse({ ok: true });
    } else if (msg.type === "disable-edit") {
      document.body.contentEditable = "false"; _editing = false;
      sendResponse({ ok: true });
    } else if (msg.type === "get-export") {
      sendResponse({ type: "export-data", items: window.__hgAnnotations || [] });
    } else if (msg.type === "reply") {
      // 复用父批注的 selector 上下文(回复无独立选区)
      const parent = (window.__hgAnnotations || []).find((a) => a.id === msg.parentId);
      const sel = (parent && parent.selector) || { type: "TextQuoteSelector", exact: (parent && parent.quote) || "" };
      // Fix #4: 等 _cfg.user 就绪,保证 X-User-Id 正确 → author.id 与 sidepanel 一致。
      cfgReady.then(() => Storage.getDocumentId()).then((docId) =>
        Storage.saveAnnotation({
          document_id: docId,
          selector: sel,
          quote: sel.exact || "",
          body: { comment: msg.comment, action: "rewrite", instruction: "" },
          parent_id: msg.parentId,
        })
      ).then(() => loadAnnotations());
      sendResponse({ ok: true });
    } else if (msg.type === "commit-comment") {
      // 来自 sidepanel 草稿块的提交:用 start-comment 时捕获的 selector + 用户输入的评论落库。
      cfgReady.then(() => Storage.getDocumentId()).then((docId) =>
        Storage.saveAnnotation({
          document_id: docId,
          selector: msg.selector,
          quote: msg.quote,
          body: { comment: msg.comment, action: "rewrite", instruction: "" },
          author: _cfg.user || { id: "u_self", name: "作者" },
        })
      ).then(() => loadAnnotations());
      sendResponse({ ok: true });
    } else if (msg.type === "delete-annotation") {
      Storage.deleteAnnotation(msg.id).then((ok) => {
        sendResponse(ok ? { ok: true } : { forbidden: true });
        if (ok) loadAnnotations();
      });
      return true; // 异步
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
  // v0.4.1: 不再用浏览器 prompt。捕获选区后通知 sidepanel 开草稿块内联编辑,
  // 用户在侧边栏提交(commit-comment)时才真正落库。
  async function createAnnotation() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const selector = describe(range, document.body);
    if (!selector || !selector.exact) return;
    chrome.runtime.sendMessage({ type: "start-comment", selector, quote: selector.exact }).catch(() => {});
    sel.removeAllRanges();
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
      if (_editing) document.body.contentEditable = "true"; // Fix #2: undo 后保持编辑态
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

  // Fix #1: body 被编辑时(任意模式),延迟重锚定 overlay 高亮,使其跟随文字移动。
  // 放在 isLocal 块之外 —— 远程页若也开了 contentEditable 同样生效。与上面的
  // undo/version input 监听互不冲突(两者都可触发)。
  document.body.addEventListener("input", () => {
    if (reanchorTimer) clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(() => { loadAnnotations(); }, 300);
  });

  // === 初始化 ===
  loadAnnotations();
  console.log("htmlGenius v0.4 ready, mode:", isLocal ? "local" : "remote(readonly)", "starts in view");
})();
