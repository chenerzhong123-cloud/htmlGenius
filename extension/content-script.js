// content-script.js — htmlGenius 注入当前页:批注 + overlay + 富文本编辑(本地可存 / 远程临时)
// v0.3.1: 修①侧边栏消失(sendMessage替代port) ②overlay位移(缓存range) ③颜色色板
(function () {
  "use strict";

  const { describe, anchor } = window;
  console.log("[hg] cs loaded: Storage=", typeof window.Storage, "RemoteStore=", typeof window.RemoteStore, "Sync=", typeof window.Sync);

  // === 协同 sync/mode:读 chrome.storage.sync,mode==="synced" 才接入后端 ===
  // 无配置或 mode 为 local/unset → 走 LocalStore(零回归)。
  let _cfg = { mode: "local" };
  let _sync = null;
  // cfg 读取异步;协同模式下保存批注需等 _cfg.session_token 就绪(RemoteStore 用它做 Authorization)。
  const cfgReady = new Promise((resolve) => {
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(
        ["mode", "backend", "session_token", "user"],
        (c) => {
          _cfg = Object.assign({}, _cfg, c || {});
          console.log("[hg] cfg:", JSON.stringify({mode:_cfg.mode, backend:_cfg.backend, hasToken:!!_cfg.session_token, hasUser:!!_cfg.user}));
          if (_cfg.mode === "synced") {
            Storage.configure(_cfg); // 切到 RemoteStore
            startSync();
            console.log("[hg] switched to RemoteStore(协同)");
          } else {
            console.log("[hg] staying LocalStore(本地)—— storage 里 mode 不是 synced");
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
        session_token: _cfg.session_token,
        docId,
        user: _cfg.user,
        onCreate: (ann) => applyRemoteChange({ op: "create", annotation: ann }),
        onUpdate: (ann) => applyRemoteChange({ op: "update", annotation: ann }),
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


  // join 链接页:路径 /join 带 ?code → 通知 sidepanel 预填邀请码
  try {
    if (location.pathname.endsWith("/join")) {
      var _jc = new URLSearchParams(location.search).get("code");
      if (_jc) chrome.runtime.sendMessage({ type: "join-code", code: _jc }).catch(function () {});
    }
  } catch (e) { /* 非关键 */ }

  // === 双模式判断 ===
  const isLocal = ["file:", "data:", "blob:"].includes(location.protocol)
    || ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);
  // 仅 file/localhost artifact 进入 v0.6.2 的逻辑文档协议；data/blob 保持旧本地编辑语义。
  const isManagedArtifact = !!(window.Storage && Storage.isManagedLocalUri && Storage.isManagedLocalUri(location.href));
  const _artifactUri = window.Storage && Storage.canonicalArtifactUri ? Storage.canonicalArtifactUri(location.href) : location.href.split("#")[0];
  let _logicalDocumentId = null;
  let _loadedArtifactHash = null;
  let _renderedArtifactHash = null;
  let _hasUnsavedLocalSnapshot = false;
  let _lastReconcileStatus = "clean";
  let _artifactVerificationError = false;
  // content-script 的源哈希必须 = host 读磁盘拿到的原始字节哈希(两者比对,否则误报 SOURCE_CHANGED)。
  // 不能用 DOM 序列化(serializeCurrentArtifact),因为 Chrome 的 HTML parser 会规范化标记
  // (属性重排/补 head/body/小写化/插 tbody…),DOM.outerHTML ≠ 文件字节 → 永远不匹配。
  // 故改为 fetch 原始文件字节后直接 sha256。
  const _loadedArtifactHashReady = (isManagedArtifact && window.HgArtifactVersion)
    ? (async () => {
        try {
          const resp = await fetch(_artifactUri);
          const buf = await resp.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", buf);
          const hex = Array.prototype.map.call(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
          const hash = "sha256:" + hex;
          _loadedArtifactHash = hash; _renderedArtifactHash = hash; return hash;
        } catch (e) {
          // fallback:DOM 序列化(旧逻辑;与 host 字节哈希可能不一致,仅用于 fetch 不可用场景)
          try {
            const hash = await window.HgArtifactVersion.sha256Hex(
              window.HgArtifactVersion.serializeCurrentArtifact(document.documentElement));
            _loadedArtifactHash = hash; _renderedArtifactHash = hash; return hash;
          } catch (e2) {
            _lastReconcileStatus = "error"; console.error("[hg] artifact hash unavailable", e2); throw e2;
          }
        }
      })()
    : Promise.resolve(null);

  // Fix #3/#2: content-script 是编辑态的唯一真相源,sidepanel 经 get-annotations 同步。
  // 页面始终以「查看」模式启动(含刷新);进入编辑需显式 enable-edit。
  let _editing = false;
  let _elementMode = false; // v0.6: 高级(元素)模式 —— 与文字编辑互斥
  let _selectedEl = null;   // v0.6: 当前选中控件
  let _textEditingEl = null; // v0.6 #5: 元素模式下正在编辑文字的控件
  // #2/#3a: 编辑历史(线性模型,undo/redo/reset;核心状态机在 undo.js)+ 侧栏取色/emoji 用的最近选区
  let _lastRange = null;  // 非折叠选区(取色用)
  let _lastCursor = null; // 任意光标位(emoji 插入用)
  let _undoDebounce = 0;
  let _versionTimer = 0;
  let _activated = false;          // 侧边栏激活前:不显示工具栏/高亮/编辑(避免对所有网页打扰)
  let _refreshDialogShown = false; // 本页面会话内只弹一次编辑确认窗(刷新后随页面重载重置)
  let _baseHash = null;            // 兼容旧变量名；v0.6.2 中为完整 artifact SHA-256 基线。
  let _lastPingAt = 0;             // #1: 最近一次收到侧边栏心跳的时间;超时则失活(收起侧边栏)
  // Fix #1: 编辑输入后延迟重锚定 overlay 高亮。
  let reanchorTimer = 0;

  // === 注入样式(浮动工具栏 + 高亮 + 确认弹窗;用 --hg-* 变量,深色默认 / [data-hg-theme=light] 浅色) ===
  const style = document.createElement("style");
  style.dataset.hgInjected = "ui";
  style.textContent = `
    :root{
      --hg-bg:#171b2a; --hg-fg:#f6f7fb; --hg-line:rgba(255,255,255,.12); --hg-hover:rgba(255,255,255,.07);
      --hg-brand:#7c8cff; --hg-brand-hover:#91a0ff; --hg-brand-soft:rgba(124,140,255,.16);
      --hg-cta:linear-gradient(120deg,#8492ff,#a88bff); --hg-cta-hover:linear-gradient(120deg,#91a0ff,#b89cff);
      --hg-cta-shadow:0 8px 24px rgba(104,121,250,.25); --hg-shadow:0 14px 34px rgba(0,0,0,.34);
      --hl:rgba(124,140,255,.22); --hl-flash:rgba(124,140,255,.42);
      --modal-bg:#10131f; --modal-fg:#f6f7fb; --modal-muted:#8d95aa; --mask:rgba(8,10,18,.62);
    }
    :root[data-hg-theme="light"]{
      --hg-bg:#ffffff; --hg-fg:#181d26; --hg-line:#dddddd; --hg-hover:rgba(24,29,38,.06);
      --hg-brand:#181d26; --hg-brand-hover:#0d1218; --hg-brand-soft:rgba(24,29,38,.07);
      --hg-cta:#181d26; --hg-cta-hover:#0d1218; --hg-cta-shadow:0 1px 2px rgba(24,29,38,.18); --hg-shadow:0 8px 24px rgba(24,29,38,.14);
      --hl:rgba(24,29,38,.10); --hl-flash:rgba(24,29,38,.18);
      --modal-bg:#ffffff; --modal-fg:#181d26; --modal-muted:#41454d; --mask:rgba(24,29,38,.4);
    }
    .hg-hl{ position:fixed; background:var(--hl); pointer-events:none; z-index:2147483646; border-radius:2px; }
    .hg-hl.flash{ background:var(--hl-flash); }
    .hg-inspect,.hg-select{ position:fixed; pointer-events:none; z-index:2147483645; border-radius:3px; }
    .hg-inspect{ background:rgba(124,140,255,.14); border:1px solid rgba(124,140,255,.7); }
    .hg-select{ background:rgba(121,233,247,.12); border:2px solid var(--hg-brand); }
    .hg-select.flash{ box-shadow:0 0 0 3px var(--hg-brand); } /* #8: 进入文字编辑时闪烁一圈,提示启动成功 */
    .hg-tip{ position:fixed; pointer-events:none; z-index:2147483647; transform:translateY(-100%); margin-top:-4px;
      background:var(--hg-bg); color:var(--hg-fg); border:1px solid var(--hg-line); border-radius:6px;
      padding:3px 7px; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow:var(--hg-shadow); white-space:nowrap; }
    .hg-drop{ position:fixed; pointer-events:none; z-index:2147483645; height:2px; background:var(--hg-brand); box-shadow:0 0 6px rgba(124,140,255,.8); border-radius:1px; }
    #hg-toolbar{ position:fixed; z-index:2147483647; display:none; background:var(--hg-bg); color:var(--hg-fg);
      border:1px solid var(--hg-line); border-radius:9px; padding:4px; gap:1px; align-items:center;
      box-shadow:var(--hg-shadow); font-size:13px;
      font-family:"Inter","PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,system-ui,sans-serif; }
    #hg-toolbar.show{ display:flex; flex-wrap:wrap; max-width:92vw; }
    #hg-toolbar button{ background:transparent; color:var(--hg-fg); border:0; cursor:pointer; padding:4px 7px; border-radius:6px; font-size:13px; line-height:1; }
    #hg-toolbar button:hover{ background:var(--hg-hover); }
    #hg-toolbar button.active{ background:var(--hg-brand-soft); color:var(--hg-brand-hover); }
    #hg-toolbar button[data-act="comment"]{ background:var(--hg-brand); color:#fff; }
    #hg-toolbar button[data-act="comment"]:hover{ background:var(--hg-brand-hover); }
    #hg-toolbar:not(.editing) .hg-edit-tool{ display:none !important; }
    #hg-toolbar .hg-sep{ width:1px; height:18px; background:var(--hg-line); margin:0 3px; }
    #hg-toolbar .hg-haspop{ position:relative; }
    #hg-toolbar .hg-ul{ display:inline-block; width:11px; height:2px; margin-left:1px; vertical-align:middle; border-radius:1px; }
    #hg-toolbar .hg-ico{ vertical-align:middle; display:inline-block; }
    #hg-toolbar .hg-popover{ display:none; position:absolute; top:calc(100% + 6px); left:0; background:var(--hg-bg);
      border:1px solid var(--hg-line); padding:6px;
      border-radius:9px; box-shadow:var(--hg-shadow); gap:4px; z-index:1; }
    #hg-toolbar .hg-popover.show{ display:flex; flex-wrap:wrap; max-width:220px; }
    #hg-toolbar .hg-popover.hg-popcol{ flex-direction:column; min-width:108px; }
    #hg-toolbar .hg-c{ width:16px; height:16px; border-radius:4px; cursor:pointer; border:1px solid var(--hg-line); }
    #hg-toolbar .hg-item{ background:transparent; color:var(--hg-fg); border:0; text-align:left; padding:5px 8px; border-radius:6px; cursor:pointer; font-size:12px; line-height:1.3; }
    #hg-toolbar .hg-item:hover{ background:var(--hg-hover); }
    #hg-toolbar .hg-emoji{ font-size:16px; background:transparent; color:var(--hg-fg); border:0; cursor:pointer; padding:4px 5px; border-radius:6px; line-height:1; }
    #hg-toolbar .hg-emoji:hover{ background:var(--hg-hover); }
    #hg-toolbar .hg-item.hg-h1{ font-weight:700; font-size:14px; }
    #hg-toolbar .hg-item.hg-h2{ font-weight:600; font-size:13px; }
    #hg-toolbar .hg-item.hg-h3{ font-weight:600; font-size:12px; }
    /* 编辑确认弹窗(页面级;激活侧边栏时弹一次) */
    .hg-modal-mask{ position:fixed; inset:0; background:var(--mask); display:flex; align-items:center; justify-content:center; z-index:2147483647; }
    .hg-modal{ width:360px; max-width:92vw; background:var(--modal-bg); color:var(--modal-fg); border:1px solid var(--hg-line);
      border-radius:12px; padding:20px 22px; box-shadow:var(--hg-shadow);
      font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
    .hg-modal-title{ font-size:15px; font-weight:600; color:var(--modal-fg); line-height:1.45; margin-bottom:10px; }
    .hg-modal-tip{ font-size:12.5px; color:var(--modal-muted); line-height:1.6; margin-bottom:16px; }
    .hg-modal-acts{ display:flex; gap:8px; justify-content:flex-end; }
    .hg-modal-acts button{ height:34px; padding:0 16px; border-radius:9px; font-size:12.5px; font-weight:600; cursor:pointer; border:1px solid transparent; font-family:inherit; }
    .hg-modal-cancel{ background:transparent; color:var(--modal-muted); border-color:var(--hg-line); font-weight:500; }
    .hg-modal-cancel:hover{ background:var(--hg-hover); }
    .hg-modal-ok{ background:var(--hg-cta); color:#fff; box-shadow:var(--hg-cta-shadow); }
    .hg-modal-ok:hover{ background:var(--hg-cta-hover); }
  `;
  document.head.appendChild(style);
  // #4: 按本地存储的主题偏好设页面 <html> 的 data-hg-theme(侧边栏切换主题时经 storage.onChanged 同步)
  function applyHgTheme(theme) {
    document.documentElement.dataset.hgTheme = theme === "light" ? "light" : "dark";
  }
  try {
    chrome.storage.local.get(["hg_theme"], (r) => applyHgTheme((r && r.hg_theme) || "dark"));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.hg_theme) applyHgTheme(changes.hg_theme.newValue);
    });
  } catch (e) { /* 非关键 */ }

  // === 浮工具栏(本地 + 远程均可编辑;远程为临时修改,刷新丢失)===
  // v0.8: 调色板为工具栏与侧边栏的【同一份来源】,两边 UI 各自渲染但取值必须一致。
  // 16 色 = 侧栏浮层 8 列 × 2 行(整齐无空位);高亮色刻意不含纯白 —— 纯白高亮会让浅色文字
  // 「隐形」(背景与文字同亮,视觉上像被盖住),transparent 表示「清除高亮」。
  const TEXT_COLORS = ["#0a0a0a","#374151","#6b7280","#9ca3af","#ffffff","#ef4444","#f97316","#f59e0b","#10b981","#06b6d4","#3b82f6","#6366f1","#8b5cf6","#ec4899","#7c8cff","#e11d48"];
  const HL_COLORS = ["#fff59d","#ffe14d","#ffd54f","#ffcdd2","#f8bbd0","#e1bee7","#c5cae9","#bbdefb","#b2dfdb","#c8e6c9","#dcedc8","#ffccbc","#ffe0b2","#d7ccc8","#e5e7eb","transparent"];
  // SIZES:[labelKey, em];标签随语言变化(toolbarHTML 内取 t())
  const SIZES = [["size.sm","0.85em"],["size.std","1em"],["size.lg","1.3em"],["size.xl","1.7em"]];
  const t = (k) => (window.HG_I18N ? window.HG_I18N.t(k) : k);

  const toolbar = document.createElement("div");
  toolbar.id = "hg-toolbar";
  function toolbarHTML() {
    const sep = `<span class="hg-sep hg-edit-tool"></span>`;
    let h = `<button data-act="comment" title="${t("tool.comment")}">${t("tool.comment")}</button>` + sep;
    h += `<button data-act="bold" class="hg-edit-tool" title="${t("tool.bold")}"><b>B</b></button>`;
    h += `<button data-act="italic" class="hg-edit-tool" title="${t("tool.italic")}"><i>I</i></button>`;
    h += `<button data-act="underline" class="hg-edit-tool" title="${t("tool.underline")}"><u>U</u></button>`;
    h += `<button data-act="strike" class="hg-edit-tool" title="${t("tool.strikethrough")}"><s>S</s></button>` + sep;
    h += `<button data-act="pop-textcolor" class="hg-haspop hg-edit-tool" title="${t("tool.color")}"><svg class="hg-ico" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 20h20v4H2zm3.49-3h2.42l1.27-3.58h5.65L16.09 17h2.42L13.25 3h-2.5zm4.42-5.61l2.03-5.79h.12l2.03 5.79z"/><rect x="2" y="20" width="20" height="4" fill="#ef4444"/></svg></button>`;
    h += `<div class="hg-popover hg-edit-tool" data-pop="textcolor">` + TEXT_COLORS.map((c) => `<span class="hg-c" data-fmt="color" data-val="${c}" style="background:${c}"></span>`).join("") + `</div>`;
    h += `<button data-act="pop-highlight" class="hg-haspop hg-edit-tool" title="${t("tool.highlight")}"><svg class="hg-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3" fill="#fff59d" stroke="#fff59d" stroke-width="2" stroke-linejoin="round"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    h += `<div class="hg-popover hg-edit-tool" data-pop="highlight">` + HL_COLORS.map((c) => `<span class="hg-c" data-fmt="background" data-val="${c}" style="background:${c}"></span>`).join("") + `</div>`;
    h += `<button data-act="pop-size" class="hg-haspop hg-edit-tool" title="${t("tool.size")}">${t("tool.sizeLabel")}</button>`;
    h += `<div class="hg-popover hg-popcol hg-edit-tool" data-pop="size">` + SIZES.map((s) => `<button class="hg-item" data-fmt="fontSize" data-val="${s[1]}" style="font-size:${s[1]}">${t(s[0])}</button>`).join("") + `</div>`;
    h += `<button data-act="pop-heading" class="hg-haspop hg-edit-tool" title="${t("tool.heading")}">H</button>`;
    h += `<div class="hg-popover hg-popcol hg-edit-tool" data-pop="heading">`
      + `<button class="hg-item" data-fmt="heading" data-val="P">${t("heading.normal")}</button>`
      + `<button class="hg-item hg-h1" data-fmt="heading" data-val="H1">${t("heading.h1")}</button>`
      + `<button class="hg-item hg-h2" data-fmt="heading" data-val="H2">${t("heading.h2")}</button>`
      + `<button class="hg-item hg-h3" data-fmt="heading" data-val="H3">${t("heading.h3")}</button>`
      + `</div>`;
    h += `<button data-act="pop-align" class="hg-haspop hg-edit-tool" title="${t("tool.align")}">☰</button>`;
    h += `<div class="hg-popover hg-popcol hg-edit-tool" data-pop="align">`
      + `<button class="hg-item" data-fmt="align" data-val="left">${t("align.left")}</button>`
      + `<button class="hg-item" data-fmt="align" data-val="center">${t("align.center")}</button>`
      + `<button class="hg-item" data-fmt="align" data-val="right">${t("align.right")}</button>`
      + `<button class="hg-item" data-fmt="align" data-val="justify">${t("align.justify")}</button>`
      + `</div>`;
    h += `<button data-act="pop-emoji" class="hg-haspop hg-edit-tool" title="${t("emoji.title")}">😊</button>`;
    h += `<div class="hg-popover hg-edit-tool" data-pop="emoji">` + ["😀","😄","😁","😍","😎","🤔","👍","👌","👏","🙏","💯","✅","❌","⭐","🔥","💡","❤️","🎉","🚀","✨","📌","📎","🔍","🎨","💬","⚠️","❓","❗","✏️","📝","🎯","➕"].map((e) => `<button class="hg-emoji hg-edit-tool" data-emoji="${e}">${e}</button>`).join("") + `</div>`;
    h += sep + `<button data-act="clear" class="hg-edit-tool" title="${t("tool.clear")}">✕</button>`;
    return h;
  }
  toolbar.innerHTML = toolbarHTML();
  document.body.appendChild(toolbar);
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());

  // 语言变更后重建工具栏文案(事件委托绑在 toolbar 上,重设 innerHTML 不影响监听)
  function updateToolbarLabels() { toolbar.innerHTML = toolbarHTML(); }

  function closeAllPopovers() {
    toolbar.querySelectorAll(".hg-popover.show").forEach((p) => p.classList.remove("show"));
  }
  function togglePopover(name) {
    const pop = toolbar.querySelector('.hg-popover[data-pop="' + name + '"]');
    if (!pop) return;
    const willOpen = !pop.classList.contains("show");
    closeAllPopovers();
    if (willOpen) pop.classList.add("show");
  }

  // 统一开关编辑态:设 contentEditable + 工具栏 editing 类 + 广播给侧边栏同步按钮
  function setEditing(on) {
    if (!on && _elementMode) setElementMode(false); // 退出编辑前先关元素模式(v0.6)
    document.body.contentEditable = on ? "true" : "false";
    _editing = on;
    toolbar.classList.toggle("editing", on);
    if (on) initUndoBaseline(); // #2: 进入编辑时记下原始基线(本地/远程均可撤销)
    if (!on) closeAllPopovers();
    try { chrome.runtime.sendMessage({ type: "edit-state", editing: on, isLocal: isLocal }).catch(() => {}); } catch (e) {}
  }

  // v0.6: 高级(元素)模式 —— 与文字编辑互斥。开:关 contentEditable + 隐藏文字工具栏;关:恢复。
  function setElementMode(on) {
    if (on === _elementMode) return;
    _elementMode = on;
    if (on) {
      if (_editing) document.body.contentEditable = "false"; // 让点击选元素而非进文字编辑态
      toolbar.classList.remove("show"); // 元素模式不弹文字工具栏
      closeAllPopovers();
      ensureElOverlays();
      document.body.style.userSelect = "none"; // 元素模式禁止框选文字(拖拽时不误选)
      document.addEventListener("mousemove", onElInspect);
      document.addEventListener("click", onElClick, true); // capture:吞页面默认点击 + 选元素
      document.addEventListener("pointerdown", onElPointerDown, true);
      document.addEventListener("pointermove", onElPointerMove);
      document.addEventListener("pointerup", onElPointerUp);
    } else {
      document.removeEventListener("mousemove", onElInspect);
      document.removeEventListener("click", onElClick, true);
      document.removeEventListener("pointerdown", onElPointerDown, true);
      document.removeEventListener("pointermove", onElPointerMove);
      document.removeEventListener("pointerup", onElPointerUp);
      if (_textEditingEl) { _textEditingEl.contentEditable = "false"; _textEditingEl = null; }
      _selectedEl = null; _elDrag = null;
      hideElOverlays();
      document.body.style.userSelect = "";
      if (_editing) document.body.contentEditable = "true"; // 恢复文字编辑
    }
    try { chrome.runtime.sendMessage({ type: "element-mode-changed", on: on }).catch(() => {}); } catch (e) {}
  }

  // === v0.6 M2: 元素 inspect(悬停画框)+ 点选 ===
  let _elInspectBox = null, _elSelectBox = null, _elTip = null, _elDrop = null, _elRAF = 0;
  function ensureElOverlays() {
    if (_elInspectBox) return;
    _elInspectBox = document.createElement("div"); _elInspectBox.className = "hg-inspect"; _elInspectBox.style.display = "none"; document.body.appendChild(_elInspectBox);
    _elSelectBox = document.createElement("div"); _elSelectBox.className = "hg-select"; _elSelectBox.style.display = "none"; document.body.appendChild(_elSelectBox);
    _elTip = document.createElement("div"); _elTip.className = "hg-tip"; _elTip.style.display = "none"; document.body.appendChild(_elTip);
    _elDrop = document.createElement("div"); _elDrop.className = "hg-drop"; _elDrop.style.display = "none"; document.body.appendChild(_elDrop);
  }
  function hideElOverlays() {
    if (_elInspectBox) _elInspectBox.style.display = "none";
    if (_elSelectBox) _elSelectBox.style.display = "none";
    if (_elTip) _elTip.style.display = "none";
    if (_elDrop) _elDrop.style.display = "none";
  }
  function elSkipped(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (el.closest && el.closest("#hg-toolbar,.hg-inspect,.hg-select,.hg-tip,.hg-hl")) return true;
    return false;
  }
  function pickEl(x, y) { const el = document.elementFromPoint(x, y); return elSkipped(el) ? null : el; }
  function elLabel(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    let cls = "";
    if (typeof el.className === "string" && el.className) cls = "." + el.className.trim().split(/\s+/)[0];
    const r = el.getBoundingClientRect();
    return tag + id + cls + " · " + Math.round(r.width) + "×" + Math.round(r.height);
  }
  function elInfo(el) {
    const r = el.getBoundingClientRect();
    const parent = el.parentElement;
    let idx = -1, count = 0;
    if (parent) { idx = Array.prototype.indexOf.call(parent.children, el); count = parent.children.length; }
    const s = el.style;
    return {
      tag: el.tagName.toLowerCase(), id: el.id || "",
      classes: (typeof el.className === "string" ? el.className : ""),
      w: Math.round(r.width), h: Math.round(r.height),
      siblingIndex: idx, siblingCount: count,
      textPreview: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      styles: { fontFamily: s.fontFamily || "", letterSpacing: s.letterSpacing || "", lineHeight: s.lineHeight || "", padding: s.padding || "" },
    };
  }
  function positionBox(box, r) {
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px"; box.style.display = "block";
  }
  function onElInspect(e) {
    if (!_elementMode) return;
    if (_elDrag && _elDrag.moved) { _elInspectBox.style.display = "none"; _elTip.style.display = "none"; return; } // 拖拽中不显示 inspect
    if (_elRAF) return;
    _elRAF = requestAnimationFrame(() => {
      _elRAF = 0;
      const el = pickEl(e.clientX, e.clientY);
      if (el) {
        positionBox(_elInspectBox, el.getBoundingClientRect());
        const r = el.getBoundingClientRect();
        _elTip.textContent = elLabel(el);
        _elTip.style.left = r.left + "px"; _elTip.style.top = r.top + "px"; _elTip.style.display = "block";
        if (_selectedEl) positionBox(_elSelectBox, _selectedEl.getBoundingClientRect()); // 滚动/移动时选区框跟随
      } else { _elInspectBox.style.display = "none"; _elTip.style.display = "none"; }
    });
  }
  function selectEl(el) {
    _selectedEl = el;
    positionBox(_elSelectBox, el.getBoundingClientRect());
    try { chrome.runtime.sendMessage({ type: "element-selected", info: elInfo(el) }).catch(() => {}); } catch (er) {}
  }
  function deselectEl() {
    _selectedEl = null;
    if (_elSelectBox) _elSelectBox.style.display = "none";
    try { chrome.runtime.sendMessage({ type: "element-selected", info: null }).catch(() => {}); } catch (er) {}
  }
  function deleteSelectedEl() { // v0.6 #6: 删除选中控件(按钮 + Delete/Backspace 键共用)
    if (!_selectedEl || _selectedEl === document.body || !_selectedEl.parentElement) return;
    _selectedEl.remove(); _selectedEl = null;
    if (_elSelectBox) _elSelectBox.style.display = "none";
    try { chrome.runtime.sendMessage({ type: "element-selected", info: null }).catch(() => {}); } catch (er) {}
    pushUndo();
  }
  // v0.6 #5: 元素模式下编辑选中控件的文字(子态:该控件 contentEditable=true,内部点击放行)
  function enterTextEdit() {
    if (!_selectedEl || _selectedEl === document.body) return;
    _textEditingEl = _selectedEl;
    _textEditingEl.contentEditable = "true";
    // #8: 从侧边栏点「编辑文字」时,窗口焦点停在侧边栏区域,仅 element.focus() 光标(caret)不显示,
    // 用户要再点一下控件才出光标。先 window.focus() 把焦点拿回页面、再聚焦控件 + 落光标到文末,
    // 点按钮后立即出现闪烁光标(侧边栏一侧也会 window.blur() 配合放焦点)。
    try { window.focus(); } catch (e) {}
    try { _textEditingEl.focus({ preventScroll: false }); } catch (e) { _textEditingEl.focus(); }
    try { const r = document.createRange(); r.selectNodeContents(_textEditingEl); r.collapse(false); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
    if (_elSelectBox && _elSelectBox.style.display !== "none") {
      _elSelectBox.classList.add("flash"); setTimeout(() => _elSelectBox.classList.remove("flash"), 600); // 视觉反馈:选框闪一圈
    }
  }
  function exitTextEdit() {
    if (!_textEditingEl) return;
    _textEditingEl.contentEditable = "false";
    _textEditingEl = null;
    pushUndo();
  }
  // 元素模式:capture 吞掉页面默认点击(链接/按钮)+ 选元素;点空白 → 取消选择
  function onElClick(e) {
    if (!_elementMode) return;
    if (_textEditingEl && _textEditingEl.contains(e.target)) return; // 文字编辑子态:控件内部放行(原生光标)
    if (_textEditingEl) exitTextEdit(); // 点到别处 → 先退出文字编辑
    const el = pickEl(e.clientX, e.clientY);
    if (!el) { deselectEl(); return; }
    e.preventDefault(); e.stopPropagation();
    selectEl(el);
  }
  // v0.6 M4: 同级拖拽重排。pointerdown 记起点;移动>5px 判定为拖拽;up 时按指针越过的同级中点 insertBefore。
  let _elDrag = null;
  function onElPointerDown(e) {
    if (!_elementMode) return;
    if (_textEditingEl && _textEditingEl.contains(e.target)) return; // 文字编辑中放行
    const el = pickEl(e.clientX, e.clientY);
    if (!el) return;
    _elDrag = { el: el, startX: e.clientX, startY: e.clientY, moved: false, parent: null, dropBefore: null };
  }
  function onElPointerMove(e) {
    if (!_elementMode || !_elDrag) return;
    if (!_elDrag.moved) {
      const dx = e.clientX - _elDrag.startX, dy = e.clientY - _elDrag.startY;
      if (dx * dx + dy * dy < 25) return; // <5px:仍是点击
      _elDrag.moved = true;
      _elDrag.parent = _elDrag.el.parentElement;
      _elDrag.el.style.opacity = "0.4";
    }
    if (!_elDrag.parent) return;
    const sibs = Array.prototype.filter.call(_elDrag.parent.children, (c) => c !== _elDrag.el && !elSkipped(c));
    let before = null;
    for (const s of sibs) {
      const r = s.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = s; break; } // 指针在该级上半 → 插它前面
    }
    _elDrag.dropBefore = before; // null = 移到末尾
    showDropIndicator(_elDrag.parent, before, _elDrag.el);
  }
  function onElPointerUp() {
    if (!_elementMode || !_elDrag) return;
    const d = _elDrag; _elDrag = null;
    d.el.style.opacity = "";
    if (d.moved && d.parent) {
      hideDropIndicator();
      d.parent.insertBefore(d.el, d.dropBefore);
      selectEl(d.el);
      pushUndo();
    }
  }
  function showDropIndicator(parent, before, dragEl) {
    ensureElOverlays();
    let top;
    if (before) top = before.getBoundingClientRect().top;
    else {
      const kids = Array.prototype.filter.call(parent.children, (c) => c !== dragEl && !elSkipped(c));
      const last = kids[kids.length - 1];
      top = last ? last.getBoundingClientRect().bottom : parent.getBoundingClientRect().top;
    }
    const pr = parent.getBoundingClientRect();
    _elDrop.style.left = pr.left + "px"; _elDrop.style.top = (top - 1) + "px";
    _elDrop.style.width = pr.width + "px"; _elDrop.style.display = "block";
  }
  function hideDropIndicator() { if (_elDrop) _elDrop.style.display = "none"; }

  // 编辑确认弹窗(页面级,激活侧边栏时弹一次):刷新→进入编辑;取消→保留查看(侧边栏显示「开始编辑」)
  function showRefreshDialog() {
    if (document.getElementById("hg-refresh-modal")) return;
    const mask = document.createElement("div");
    mask.id = "hg-refresh-modal";
    mask.className = "hg-modal-mask";
    const tip = isLocal ? t("refresh.tipLocal") : t("refresh.tipRemote");
    mask.innerHTML =
      '<div class="hg-modal">' +
      '<div class="hg-modal-title">' + t("refresh.title") + '</div>' +
      '<div class="hg-modal-tip">' + tip + '</div>' +
      '<div class="hg-modal-acts">' +
      '<button class="hg-modal-cancel">' + t("refresh.cancel") + '</button>' +
      '<button class="hg-modal-ok">' + t("refresh.confirm") + '</button>' +
      '</div></div>';
    document.body.appendChild(mask);
    // v0.8.1: 按钮处理合并为 mask 上的 capture 委托监听 ——
    // ① capture 阶段先于页面常见的全局 bubble 监听执行,减少被页面点击拦截器挡掉的概率;
    // ② 若 location.reload() 被页面 beforeunload 拦截(模态已关、页面没刷),800ms 兜底直接进编辑,
    //    保证「点刷新一定进编辑」(reload 真发生则该页 JS 上下文已销毁,兜底定时器自然失效)。
    mask.addEventListener("click", (e) => {
      const isOk = !!e.target.closest(".hg-modal-ok");
      const isCancel = !!e.target.closest(".hg-modal-cancel");
      if (!isOk && !isCancel) return;
      e.stopPropagation();
      mask.remove();
      if (!isOk) return;
      console.log("[hg] refresh dialog confirmed → reload");
      try { sessionStorage.setItem("hg_autoedit", "1"); } catch (er) {}
      location.reload();
      setTimeout(() => {
        console.warn("[hg] reload 未发生(被页面 beforeunload 拦截?)→ 兜底直接进入编辑");
        setEditing(true);
      }, 800);
    }, true);
  }

  // #1: 失活 —— 侧边栏收起/切走标签:隐藏浮窗+高亮,并退出编辑(contentEditable 关闭,页面恢复正常浏览)
  function deactivateNow() {
    if (!_activated && !_editing && overlayData.length === 0) return;
    _activated = false;
    toolbar.classList.remove("show");
    closeAllPopovers();
    const modal = document.getElementById("hg-refresh-modal"); // 关掉可能开着的确认窗
    if (modal) modal.remove();
    if (_editing) setEditing(false); // 收起侧边栏 → 退出编辑(Q1)
    overlayData.forEach((o) => o.divs.forEach((d) => d.remove()));
    overlayData = [];
  }

  toolbar.addEventListener("click", (e) => {
    const em = e.target.closest("[data-emoji]");
    if (em) { execEdit({ kind: "insert", text: em.dataset.emoji }); closeAllPopovers(); return; }
    const sw = e.target.closest(".hg-c");
    if (sw) { execEdit({ kind: "style", prop: sw.dataset.fmt === "color" ? "color" : "background", value: sw.dataset.val }); closeAllPopovers(); return; }
    const item = e.target.closest(".hg-item");
    if (item) {
      // #2: 字号是行内样式,走 style;其余(标题/对齐)是块级,走 block
      if (item.dataset.fmt === "fontSize") execEdit({ kind: "style", prop: "fontSize", value: item.dataset.val });
      else execEdit({ kind: "block", fmt: item.dataset.fmt, value: item.dataset.val });
      closeAllPopovers(); return;
    }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "comment") { toolbar.classList.remove("show"); execEdit({ kind: "comment" }); return; }
    // #1: B/I/U/S 走统一入口 —— 原生 toggle(再点取消)+ 每次改动都入撤销历史
    if (act === "bold" || act === "italic" || act === "underline" || act === "strike") { execEdit({ kind: "toggle", cmd: act }); closeAllPopovers(); }
    else if (act === "clear") { execEdit({ kind: "clear" }); closeAllPopovers(); }
    else if (act.indexOf("pop-") === 0) togglePopover(act.slice(4));
  });

  // #1: 依当前选区格式点亮 B/I/U/S 按钮(queryCommandState);清空时取消高亮
  function syncActiveStates() {
    const map = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };
    const states = {};
    Object.keys(map).forEach((act) => {
      let on = false;
      try { on = document.queryCommandState(map[act]); } catch (e) {}
      states[act] = !!on;
      const b = toolbar.querySelector('button[data-act="' + act + '"]');
      if (b) b.classList.toggle("active", !!on);
    });
    // v0.8: 同步 B/I/U/S 点亮态给侧边栏(两个入口同一份选区状态)
    try { chrome.runtime.sendMessage({ type: "format-state", states: states }).catch(() => {}); } catch (e) {}
  }
  // v0.8: 侧边栏入口缺少可用选区时,提示用户先在页面选文字(而不是静默无反应)
  function notifyNoSelection() {
    try { chrome.runtime.sendMessage({ type: "toast", text: t("toast.noSelection") }).catch(() => {}); } catch (e) {}
  }

  // === ① 通信改 sendMessage 广播(替代 port) ===
  // content script → side panel: chrome.runtime.sendMessage
  // side panel → content script: chrome.tabs.sendMessage
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get-annotations") {
      getArtifactState().then((artifact_state) => sendResponse({ type: "annotations-list", items: window.__hgAnnotations || [], isLocal, editing: _editing, artifact_state }))
        .catch(() => sendResponse({ type: "annotations-list", items: window.__hgAnnotations || [], isLocal, editing: _editing, artifact_state: artifactStateSnapshot() }));
      return true;
    } else if (msg.type === "scroll-to") {
      const ann = (window.__hgAnnotations || []).find((a) => a.id === msg.id);
      if (ann) {
        const range = anchor(ann.selector, document.body);
        if (range) range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "enable-edit") {
      setEditing(true); sendResponse({ ok: true });
    } else if (msg.type === "disable-edit") {
      setEditing(false); sendResponse({ ok: true });
    } else if (msg.type === "toggle-element-mode") {
      setElementMode(!_elementMode); sendResponse({ ok: true, on: _elementMode });
    } else if (msg.type === "element-delete") {
      deleteSelectedEl(); sendResponse({ ok: true });
    } else if (msg.type === "element-edit-text") {
      if (_elementMode && _selectedEl) { if (_textEditingEl) exitTextEdit(); else enterTextEdit(); }
      sendResponse({ ok: true });
    } else if (msg.type === "element-duplicate") {
      if (_selectedEl && _selectedEl !== document.body && _selectedEl.parentElement) {
        const clone = _selectedEl.cloneNode(true);
        _selectedEl.after(clone); _selectedEl = clone;
        positionBox(_elSelectBox, clone.getBoundingClientRect());
        try { chrome.runtime.sendMessage({ type: "element-selected", info: elInfo(clone) }).catch(() => {}); } catch (er) {}
        pushUndo();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
    } else if (msg.type === "element-select-parent") {
      if (_selectedEl && _selectedEl.parentElement && _selectedEl.parentElement !== document.body) selectEl(_selectedEl.parentElement);
      sendResponse({ ok: true });
    } else if (msg.type === "element-style") {
      // v0.6: 改选中元素的行内样式(fontFamily/letterSpacing/lineHeight/padding);value="" 清除
      if (_selectedEl && _selectedEl !== document.body) {
        _selectedEl.style[msg.prop] = msg.value;
        try { chrome.runtime.sendMessage({ type: "element-selected", info: elInfo(_selectedEl) }).catch(() => {}); } catch (er) {}
        pushUndo();
      }
      sendResponse({ ok: true });
    } else if (msg.type === "insert-text") {
      // v0.6/v0.8: 在最近光标处插入文本(emoji)。走统一入口(撤销登记 + 重锚定与工具栏一致)。
      const r = execEdit({ kind: "insert", text: msg.text, restore: "cursor" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "edit-toggle") {
      // v0.8: 侧边栏 B/I/U/S —— 与工具栏同一个 execEdit
      const r = execEdit({ kind: "toggle", cmd: msg.cmd, restore: "range" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "edit-style") {
      // v0.8: 侧边栏字号等行内样式
      const r = execEdit({ kind: "style", prop: msg.prop, value: msg.value, restore: "range" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "edit-block") {
      // v0.8: 侧边栏标题/对齐(块级)
      const r = execEdit({ kind: "block", fmt: msg.fmt, value: msg.value, restore: "range" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "edit-clear") {
      // v0.8: 侧边栏清除格式
      const r = execEdit({ kind: "clear", restore: "range" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "create-comment") {
      // v0.8: 侧边栏「评论」按钮 —— 用最近选区建评论(与工具栏评论按钮共用 createAnnotation)
      const r = execEdit({ kind: "comment", restore: "range" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "undo") {
      doUndo(); sendResponse({ ok: true });
    } else if (msg.type === "redo") {
      doRedo(); sendResponse({ ok: true });
    } else if (msg.type === "reset-edit") {
      resetEdit(); sendResponse({ ok: true });
    } else if (msg.type === "save-html") {
      sendResponse({ ok: true, html: buildExportHtml(), name: (document.title || "htmlgenius-page") + ".html" });
    } else if (msg.type === "apply-color") {
      // #3b/v0.8: 侧边栏取色 → 还原最近选区 → 与工具栏同一个 execEdit 施色(逻辑唯一,两边效果一致)
      const r = execEdit({ kind: "style", prop: msg.kind === "highlight" ? "background" : "color", value: msg.color, restore: "range" });
      if (r.code === "NO_SELECTION") notifyNoSelection();
      sendResponse({ ok: !!r.ok, code: r.code });
    } else if (msg.type === "activate") {
      // sidepanel 触发:打开侧边栏(showDialog=true,弹确认窗)/ 切标签或刷新(showDialog=false,静默激活)
      const showDialog = msg.showDialog !== false;
      const wasActive = _activated;
      _activated = true;
      _lastPingAt = Date.now();
      if (!wasActive) loadAnnotations(); // 首次激活:渲染批注高亮
      if (showDialog && !_refreshDialogShown && !_editing) { _refreshDialogShown = true; showRefreshDialog(); }
      sendResponse({ ok: true, isLocal: isLocal });
    } else if (msg.type === "panel-ping") {
      // #1: 侧边栏心跳 —— 仍在线且为活动标签。失活后重新收到则恢复高亮。
      const wasActive = _activated;
      _activated = true;
      _lastPingAt = Date.now();
      if (!wasActive) loadAnnotations();
      sendResponse({ ok: true });
    } else if (msg.type === "deactivate") {
      // #1: 侧边栏收起 → 立即失活(隐藏浮窗/高亮,退出编辑)
      deactivateNow();
      sendResponse({ ok: true });
    } else if (msg.type === "get-artifact-state") {
      getArtifactState().then((artifact_state) => sendResponse({ ok: true, artifact_state }))
        .catch((error) => sendResponse({ ok: false, code: "HASH_UNAVAILABLE", error: String(error && error.message || error), artifact_state: artifactStateSnapshot() }));
      return true;
    } else if (msg.type === "prepare-artifact-reload") {
      if (!isLocal) { sendResponse({ ok: false, code: "NOT_LOCAL" }); }
      else if (_editing || _hasUnsavedLocalSnapshot) { sendResponse({ ok: true, status: "needs_confirmation" }); }
      else { sendResponse({ ok: true, status: "ready" }); }
    } else if (msg.type === "mark-artifact-snapshot-exported") {
      if (_logicalDocumentId) Storage.markLatestArtifactVersionExported(_logicalDocumentId).then(() => {
        _hasUnsavedLocalSnapshot = false; sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false }));
      else sendResponse({ ok: false });
      return true;
    } else if (msg.type === "artifact-update-ready") {
      handleArtifactUpdateReady(msg, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, code: "VALIDATION_ERROR", error: String(error && error.message || error) }));
      return true;
    } else if (msg.type === "get-export") {
      // v0.6.1:附带 artifact 元数据(标题/地址/是否本地)给 ChangeContract;不读文件内容或敏感数据。
      getArtifactState().then((artifact_state) => sendResponse({
        type: "export-data", items: window.__hgAnnotations || [],
        artifact: { title: document.title || "Untitled HTML", url: location.href, isLocal: isLocal },
        artifact_state,
        logicalDocumentId: _logicalDocumentId,
        loadedArtifactHash: _loadedArtifactHash,
      })).catch(() => sendResponse({ type: "export-data", items: window.__hgAnnotations || [], artifact: { title: document.title || "Untitled HTML", url: location.href, isLocal: isLocal }, artifact_state: artifactStateSnapshot(), logicalDocumentId: _logicalDocumentId, loadedArtifactHash: _loadedArtifactHash }));
      return true;
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
          author: _cfg.user || { id: "u_self", name: t("author.fallback") },
        })
      ).then(() => loadAnnotations());
      sendResponse({ ok: true });
    } else if (msg.type === "delete-annotation") {
      Storage.deleteAnnotation(msg.id).then((ok) => {
        sendResponse(ok ? { ok: true } : { forbidden: true });
        if (ok) loadAnnotations();
      });
      return true; // 异步
    } else if (msg.type === "update-annotation") {
      // #2: 作者编辑已保存评论(原地更新 body,保留 id/回复链)
      Storage.updateAnnotation(msg.id, { comment: msg.comment }).then((ok) => {
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

  // #5: 与侧边栏的长连接 —— 侧边栏关闭(页面销毁)→ port 断开 → 失活(比 pagehide+异步 query 可靠)
  // v0.8.1 竞态防护:侧边栏切标签/重激活时「先断旧 port → 再 activate → 再连新 port」,onDisconnect
  // 回调异步到达可能【晚于】新 activate,直接失活会误杀刚激活的状态 —— 激活确认窗被移除且不会恢复
  // (_refreshDialogShown 已置位),表现为「点刷新按钮没反应」。改为延迟失活,窗口内新 port 连上即取消。
  let _deactivateTimer = 0;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "hg-panel") return;
    if (_deactivateTimer) { clearTimeout(_deactivateTimer); _deactivateTimer = 0; } // 新连接到达:取消待执行的失活
    port.onDisconnect.addListener(() => {
      _deactivateTimer = setTimeout(() => { _deactivateTimer = 0; deactivateNow(); }, 600);
    });
  });

  // === selectionchange → toolbar 定位(rAF 防抖) ===
  let barRAF = 0;
  document.addEventListener("selectionchange", () => {
    if (barRAF) return;
    barRAF = requestAnimationFrame(() => {
      barRAF = 0;
      if (!_activated && !_editing) { toolbar.classList.remove("show"); return; } // 未激活且未编辑:不弹工具栏(零打扰)。编辑中即使漏 ping 也保留工具栏。
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { toolbar.classList.remove("show"); closeAllPopovers(); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { toolbar.classList.remove("show"); return; }
      toolbar.style.left = (rect.left + rect.width / 2) + "px";
      toolbar.style.top = (rect.top - 8) + "px";
      toolbar.style.transform = "translate(-50%,-100%)";
      toolbar.classList.add("show");
      syncActiveStates(); // #1: 选区变化时刷新 B/I/U/S 高亮
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

  // === inline 样式:color / background 走逐段包裹(正确处理跨元素/部分选区);fontSize 等 span 包裹 ===
  // 注:B/I/U/S 走 execCommand(见 click handler),不在此处理。
  // 返回是否真的改动了文档 —— 选区失效(指向幽灵节点)时返回 false,由 execEdit 报 NO_SELECTION。
  function applyStyle(prop, value) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    if (prop === "color") return paintRange("color", value);
    if (prop === "background") return paintRange("backgroundColor", value);
    const range = sel.getRangeAt(0);
    const span = document.createElement("span");
    span.style[prop] = value;
    try { range.surroundContents(span); return true; }
    catch (e) {
      try { span.appendChild(range.extractContents()); range.insertNode(span); return span.isConnected; }
      catch (e2) { return false; } // stale 选区(节点已脱离文档)→ 明确无效
    }
  }
  // 把选区内每一段文本节点包裹进带样式的 span(修「只改前半/末字变样」「高亮盖字」)。
  function paintRange(prop, value) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const slices = [];
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest("#hg-toolbar,.hg-hl,.hg-inspect,.hg-select,.hg-tip,.hg-drop")) return NodeFilter.FILTER_REJECT;
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      const start = (n === range.startContainer) ? range.startOffset : 0;
      const end = (n === range.endContainer) ? range.endOffset : n.nodeValue.length;
      if (end > start) slices.push({ node: n, start, end });
    }
    if (!slices.length) {
      const span = document.createElement("span"); span.style[prop] = value;
      try { range.surroundContents(span); return true; }
      catch (e) {
        try { span.appendChild(range.extractContents()); range.insertNode(span); return span.isConnected; }
        catch (e2) { return false; }
      }
    }
    let applied = false;
    for (const s of slices) {
      const node = s.node;
      if (!node.nodeValue || node.nodeValue.length === 0) continue;
      if (!node.isConnected) continue; // stale 防护:脱离文档的幽灵节点不施色(否则会「施了但页面没变化」)
      const start = Math.min(s.start, node.nodeValue.length);
      const end = Math.min(s.end, node.nodeValue.length);
      if (end <= start) continue;
      const inside = node.splitText(start);            // inside = [start, len)
      if (end - start < inside.nodeValue.length) inside.splitText(end - start); // 截到 [start,end)
      const span = document.createElement("span");
      span.style[prop] = value;
      inside.parentNode.insertBefore(span, inside);
      span.appendChild(inside);
      applied = true;
    }
    return applied;
  }
  // 重锚定 overlay(编辑/插入后让批注高亮跟随文字新位置)
  function scheduleReanchor() {
    if (reanchorTimer) clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(() => { loadAnnotations(); }, 300);
  }
  // 在当前选区/光标处插入文本(浮动栏 emoji 与侧边栏 emoji 共用;撤销登记由 execEdit 统一负责)
  function insertTextAtSelection(text) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
    return true;
  }
  // === 块级格式:标题 / 对齐(作用于选区所在段落块)===
  function blockOf(node) {
    let n = node && node.nodeType === 3 ? node.parentElement : node;
    while (n && n !== document.body) {
      if (n.nodeType === 1 && /^(H1|H2|H3|H4|H5|H6|P|DIV|LI|BLOCKQUOTE|TD|TH|PRE|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|FIGURE|FIGCAPTION|DD|DT|DETAILS|SUMMARY|ADDRESS|FORM|FIELDSET)$/.test(n.tagName)) return n;
      n = n.parentNode;
    }
    return null;
  }
  function applyFormat(fmt, val) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (fmt === "heading") {
      // #3: blockOf 找不到标准块时,回退到选区共同祖先(避免静默无操作)
      let blk = blockOf(range.startContainer);
      if (!blk) { const c = range.commonAncestorContainer; blk = c.nodeType === 1 ? c : c.parentElement; }
      if (!blk || blk === document.body || !blk.isConnected) return false; // stale 选区 → 无效
      const nw = document.createElement(val);
      while (blk.firstChild) nw.appendChild(blk.firstChild);
      if (blk.style.textAlign) nw.style.textAlign = blk.style.textAlign;
      blk.replaceWith(nw);
      return true;
    } else if (fmt === "align") {
      let blk = blockOf(range.startContainer);
      if (!blk) { const c = range.commonAncestorContainer; blk = c.nodeType === 1 ? c : c.parentElement; }
      if (blk && blk !== document.body && blk.isConnected) { blk.style.textAlign = val; return true; }
      return false;
    }
    return false;
  }
  // === 清除格式:unwrap 选区内带 style 的 span(选区失效返回 false)===
  function clearFormat() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const root = range.commonAncestorContainer;
    if (!root || !root.isConnected) return false; // stale 防护
    const frag = range.extractContents();
    frag.querySelectorAll("span").forEach((sp) => {
      if (sp.getAttribute("style")) {
        while (sp.firstChild) sp.parentNode.insertBefore(sp.firstChild, sp);
        sp.remove();
      }
    });
    range.insertNode(frag);
    return true;
  }

  // === v0.8: 编辑操作的【唯一修改入口】===
  // 浮动工具栏与侧边栏的所有编辑操作最终都走这里执行 —— 两个入口可以各自处理交互展示
  // (如工具栏弹自己的 popover、侧边栏弹自己的色板浮层),但【修改页面内容的逻辑只有这一份】,
  // 保证两边操作效果完全一致,且每次都统一:入撤销历史 + 批注重锚定 + 刷新 B/I/U/S 点亮态。
  // op = {kind:"toggle", cmd:"bold"|"italic"|"underline"|"strike"}
  //    | {kind:"style", prop:"color"|"background"|"fontSize", value}
  //    | {kind:"block", fmt:"heading"|"align", value}
  //    | {kind:"insert", text}   | {kind:"clear"}   | {kind:"comment"}
  // restore:"range"=侧边栏入口先恢复最近非折叠选区;"cursor"=恢复最近光标位(插入用)。
  //          工具栏入口不传 —— 直接用页面实时选区(mousedown preventDefault 保持住的那个)。
  function rangeInDocument(r) {
    // 选区是否仍挂在当前文档上(undo/redo 的 innerHTML 重建会让缓存的 range 指向幽灵节点)
    const n = r && r.commonAncestorContainer;
    if (!n) return false;
    const el = n.nodeType === 3 ? n.parentElement : n;
    if (!el) return false;
    // 双重判定:isConnected + getRootNode 必须都回到当前文档(某些引擎/时序下单项不可靠)
    try { return el.isConnected && n.getRootNode() === document && document.contains(el); }
    catch (e) { return !!el.isConnected; }
  }
  function execEdit(op) {
    if (!op || !op.kind) return { ok: false, code: "BAD_OP" };
    if (op.kind !== "comment" && !_editing) return { ok: false, code: "NOT_EDITING" };
    if (op.restore) {
      const r = op.restore === "cursor" ? (_lastCursor || _lastRange) : _lastRange;
      // #1: 侧边栏入口的 stale 防护 —— 缓存选区已失效时施色只会「施到幽灵节点上」
      // (页面毫无变化,像按钮失灵);此时明确报 NO_SELECTION 让侧边栏提示先选文字。
      if (!r || !rangeInDocument(r)) return { ok: false, code: "NO_SELECTION" };
      const sel = document.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    }
    const TOGGLE = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };
    switch (op.kind) {
      case "toggle":
        if (!TOGGLE[op.cmd]) return { ok: false, code: "BAD_OP" };
        document.execCommand(TOGGLE[op.cmd]); // 原生 toggle(再点取消)
        break;
      case "style":
        if (!applyStyle(op.prop, op.value)) return { ok: false, code: "NO_SELECTION" };
        break;
      case "block":
        if (!applyFormat(op.fmt, op.value)) return { ok: false, code: "NO_SELECTION" };
        break;
      case "insert":
        if (!op.text) return { ok: false, code: "BAD_OP" };
        if (!insertTextAtSelection(op.text)) return { ok: false, code: "NO_SELECTION" };
        break;
      case "clear":
        if (!clearFormat()) return { ok: false, code: "NO_SELECTION" };
        break;
      case "comment":
        createAnnotation();
        return { ok: true };
      default:
        return { ok: false, code: "BAD_OP" };
    }
    pushUndo();          // 关键:每次改动立即入历史(可撤销/重做)。此前工具栏改色/字号走 DOM API
    scheduleReanchor();  // 不触发 input 事件、也无 push,导致改动「撤不掉、重做不回」—— 统一入口后根治。
    syncActiveStates();
    return { ok: true };
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
        if (_activated) { // 未激活时不渲染高亮(数据照载,供侧边栏卡片用)
          const entry = { divs: [], range, id: ann.id }; // #4: 记 id,供点击命中检测
          for (const r of range.getClientRects()) {
            const div = document.createElement("div");
            div.className = "hg-hl";
            div.dataset.annId = ann.id; // #4: 点击命中后定位批注
            div.style.left = r.left + "px";
            div.style.top = r.top + "px";
            div.style.width = r.width + "px";
            div.style.height = r.height + "px";
            document.body.appendChild(div);
            entry.divs.push(div);
          }
          overlayData.push(entry);
        }
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
            div.dataset.annId = entry.id; // #4: 重建时保留 annId
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

  // v0.6 #8: 高级模式 inspect 预览框在滚动时跟随 —— 缓存鼠标坐标,滚动时按该坐标重新拾取元素并重定位。
  let _lastMX = 0, _lastMY = 0;
  document.addEventListener("mousemove", (e) => { _lastMX = e.clientX; _lastMY = e.clientY; }, { passive: true });
  window.addEventListener("scroll", () => { if (_elementMode && !_elDrag) onElInspect({ clientX: _lastMX, clientY: _lastMY }); }, true);

  // #4: 点击页面高亮 → 命中检测(高亮 pointer-events:none 不挡文字/编辑,故用坐标命中)→ 通知侧边栏聚焦评论
  document.addEventListener("click", (e) => {
    if (_editing) return;                 // 编辑态放行(让编辑正常)
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;  // 用户在框选文字,不算"点高亮"
    const x = e.clientX, y = e.clientY;
    for (const entry of overlayData) {
      for (const d of entry.divs) {
        const r = d.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          d.classList.add("flash"); setTimeout(() => d.classList.remove("flash"), 800);
          try { chrome.runtime.sendMessage({ type: "annotation-clicked", id: d.dataset.annId }); } catch (er) {}
          return;
        }
      }
    }
  });

  // === 编辑历史:线性模型(undo/redo/reset),本地/远程均可 ===
  // 核心状态机在 extension/undo.js(createHistory,可单测);此处注入 DOM 读写。
  const MAX_UNDO = 100; // 撤销/重做步数上限(每步存一份完整正文快照,非 diff;大页面注意内存)
  function applyHistState(s) { applyRestoredBody(s); if (_editing) document.body.contentEditable = "true"; loadAnnotations(); }
  const _hist = window.HgUndo.createHistory(captureBodyForSave, applyHistState, MAX_UNDO);
  function initUndoBaseline() { _hist.init(); }
  function pushUndo() { _hist.push(); }
  function doUndo() { _hist.undo(); }
  function doRedo() { _hist.redo(); }
  function resetEdit() { _hist.reset(); }
  // #3a/#2: 构造导出 HTML(剥离扩展注入);下载改在 side panel 触发(content-script 异步消息已失用户手势,直接 a.click 会被拦)
  function buildExportHtml() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("#hg-toolbar, .hg-hl, .hg-inspect, .hg-select, .hg-tip, .hg-drop").forEach((e) => e.remove());
    clone.querySelectorAll('style[data-hg-injected="ui"]').forEach((e) => e.remove()); // 剥离扩展注入样式(用户行内样式/emoji 文本保留)
    return "<!doctype html>\n" + clone.outerHTML;
  }
  // #3b/v0.6: _lastRange=非折叠选区(取色);_lastCursor=任意位(emoji 插入)。分开存,避免光标覆盖取色选区。
  document.addEventListener("selectionchange", () => {
    if (!_editing) return;
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0).cloneRange();
    if (sel.isCollapsed) _lastCursor = r; else { _lastRange = r; _lastCursor = r; }
  });

  // 撤销 + 粘贴:本地/远程均可编辑 → 全局注册(仅 _editing 时拦截,免得抢页面原生快捷键);版本持久化仅本地。
  document.addEventListener("keydown", (e) => {
    if (!_editing) return; // 非编辑态不拦截,保留页面原生 Cmd/Ctrl+Z
    const k = e.key && e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); } // Z=撤销 / Shift+Z=重做(此前 Shift 被当撤销 → 重做键失效)
    else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); doRedo(); } // Windows: Ctrl+Y 重做
    else if (_elementMode && e.key === "Escape") { if (_textEditingEl) exitTextEdit(); else deselectEl(); } // v0.6: Esc 退文字编辑/取消选控件
    else if (_elementMode && _selectedEl && !_textEditingEl && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelectedEl(); } // v0.6 #6: Delete 键删控件
  });
  document.body.addEventListener("input", () => {
    if (!_editing) return;
    clearTimeout(_undoDebounce);
    _undoDebounce = setTimeout(pushUndo, 700);
    if (isLocal) {
      clearTimeout(_versionTimer);
      _versionTimer = setTimeout(async () => {
        if (!isManagedArtifact || !_logicalDocumentId || !_loadedArtifactHash || !window.HgArtifactVersion) return;
        try {
          const html = window.HgArtifactVersion.serializeCurrentArtifact(document.documentElement);
          const artifactHash = await window.HgArtifactVersion.sha256Hex(html);
          await Storage.saveArtifactVersion({ logical_document_id: _logicalDocumentId, artifact_uri: _artifactUri,
            artifact_hash: artifactHash, parent_hash: _loadedArtifactHash, base_artifact_hash: _loadedArtifactHash,
            source: "local_edit", html_content: html });
          _renderedArtifactHash = artifactHash;
          _hasUnsavedLocalSnapshot = true;
        } catch (e) { _lastReconcileStatus = "error"; console.error("[hg] artifact snapshot failed", e); }
      }, 1500);
    }
  });
  document.body.addEventListener("paste", (e) => {
    if (!_editing) return;
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

  // Fix #1: body 被编辑时(任意模式),延迟重锚定 overlay 高亮,使其跟随文字移动。
  // 放在 isLocal 块之外 —— 远程页若也开了 contentEditable 同样生效。与上面的
  // undo/version input 监听互不冲突(两者都可触发)。
  document.body.addEventListener("input", () => {
    updatePositions();    // 即时重定位未受影响的高亮(跟随 reflow,不重 anchor → 更自然)
    scheduleReanchor();   // 300ms 后全量重锚定(修正被编辑区域)
  });

  // === 本地模式:undo 的 body 快照与 artifact 持久化是两条不同路径 ===
  function captureBodyForSave() {
    // 克隆 body,剥离扩展注入的 toolbar 与 overlay,只留用户正文
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("#hg-toolbar, .hg-hl").forEach((el) => el.remove());
    return clone.innerHTML;
  }
  function applyRestoredBody(html) {
    // 用保存的正文重建 body;同一 toolbar 节点重新挂回(保留其事件监听,不产生重复)
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const toolbar = document.getElementById("hg-toolbar");
    document.body.innerHTML = "";
    while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
    if (toolbar) document.body.appendChild(toolbar);
  }
  function applyRestoredArtifact(html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const preservedToolbar = document.getElementById("hg-toolbar");
    const preservedStyle = style.isConnected ? style : document.querySelector("style[data-hg-injected=\"ui\"]");
    const theme = document.documentElement.getAttribute("data-hg-theme");
    if (preservedToolbar) preservedToolbar.remove();
    if (preservedStyle) preservedStyle.remove();
    Array.from(document.documentElement.attributes).forEach((attr) => document.documentElement.removeAttribute(attr.name));
    Array.from(parsed.documentElement.attributes).forEach((attr) => document.documentElement.setAttribute(attr.name, attr.value));
    if (theme) document.documentElement.setAttribute("data-hg-theme", theme);
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    if (preservedStyle) document.head.appendChild(preservedStyle);
    if (preservedToolbar) document.body.appendChild(preservedToolbar);
  }
  function artifactStateSnapshot() {
    return { logical_document_id: _logicalDocumentId, artifact_uri: _artifactUri, loaded_artifact_hash: _loadedArtifactHash,
      rendered_artifact_hash: _renderedArtifactHash, has_unsaved_local_snapshot: _hasUnsavedLocalSnapshot,
      last_reconcile_status: _lastReconcileStatus };
  }
  async function getArtifactState() {
    if (isManagedArtifact && window.HgArtifactVersion) {
      _renderedArtifactHash = await window.HgArtifactVersion.sha256Hex(window.HgArtifactVersion.serializeCurrentArtifact(document.documentElement));
    }
    return artifactStateSnapshot();
  }
  function legacyUriId() { try { return location.origin + location.pathname; } catch (e) { return _artifactUri; } }
  async function recordLoadedArtifact() {
    const latest = await Storage.getLatestArtifactVersion(_logicalDocumentId);
    if (!latest || latest.artifact_hash !== _loadedArtifactHash || latest.artifact_uri !== _artifactUri) {
      await Storage.saveArtifactVersion({ logical_document_id: _logicalDocumentId, artifact_uri: _artifactUri,
        artifact_hash: _loadedArtifactHash, parent_hash: latest && latest.artifact_hash || null, source: "external_reconcile" });
    }
  }
  // 只在完整 artifact 的原始 SHA-256 完全相同才恢复快照；旧 versions 永不恢复。
  async function restoreIfFresh() {
    if (!isManagedArtifact) return;
    try {
      await _loadedArtifactHashReady;
      if (!_loadedArtifactHash) throw new Error("No SHA-256 artifact hash");
      _logicalDocumentId = (await Storage.getOrCreateLocalDocument(_artifactUri)).logical_document_id;
      const expected = await Storage.getLatestArtifactVersionForUri(_logicalDocumentId, _artifactUri, "bridge");
      if (expected && expected.artifact_uri === _artifactUri && expected.result_artifact_hash && expected.result_artifact_hash !== _loadedArtifactHash) {
        _artifactVerificationError = true; _lastReconcileStatus = "error"; console.error("[hg] linked artifact hash did not match bridge completion"); return;
      }
      await recordLoadedArtifact();
      const latest = await Storage.getLatestArtifactVersion(_logicalDocumentId, "local_edit");
      if (latest && latest.html_content) {
        _hasUnsavedLocalSnapshot = !latest.exported_at;
        if (latest.base_artifact_hash === _loadedArtifactHash) {
          applyRestoredArtifact(latest.html_content);
          _renderedArtifactHash = latest.artifact_hash || await window.HgArtifactVersion.sha256Hex(latest.html_content);
        } else _lastReconcileStatus = "conflict";
      }
      const legacy = await Storage.listVersions(legacyUriId());
      if (legacy && legacy.length) console.info("[hg] legacy body-only versions were intentionally not restored during v0.6.2 migration");
      _baseHash = _loadedArtifactHash;
    } catch (e) { _lastReconcileStatus = "error"; _baseHash = null; console.error("[hg] artifact restore unavailable", e); }
  }

  function isSha256(value) { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
  async function handleArtifactUpdateReady(msg, sender) {
    if (!sender || sender.id !== chrome.runtime.id) return { ok: false, code: "VALIDATION_ERROR" };
    if (!isManagedArtifact || !msg || msg.source !== "bridge" || !["overwrite", "new_artifact"].includes(msg.result_kind)
      || !isSha256(msg.base_artifact_hash) || !isSha256(msg.result_artifact_hash) || !msg.logical_document_id || !msg.result_artifact_uri) return { ok: false, code: "VALIDATION_ERROR" };
    if (!_logicalDocumentId || msg.logical_document_id !== _logicalDocumentId) return { ok: false, code: "VALIDATION_ERROR" };
    // bridge 的 base hash 由 host 从原始文件字节计算,content-script 从 DOM 序列化算 → 方法不同,
    // 不做跨侧比对(host 内部已自校验前后哈希)。仅保留 _hasUnsavedLocalSnapshot 拦截(任何来源都适用)。
    if (msg.source !== "bridge" && _loadedArtifactHash !== msg.base_artifact_hash) return { ok: false, code: "BASE_CONFLICT", current_hash: _loadedArtifactHash };
    if (_hasUnsavedLocalSnapshot) return { ok: false, code: "BASE_CONFLICT", current_hash: _loadedArtifactHash };
    const resultUri = Storage.canonicalArtifactUri(msg.result_artifact_uri);
    if (msg.result_kind === "overwrite" && resultUri !== _artifactUri) return { ok: false, code: "VALIDATION_ERROR" };
    if (msg.result_kind === "new_artifact") await Storage.linkArtifactUri(_logicalDocumentId, resultUri);
    await Storage.saveArtifactVersion({ logical_document_id: _logicalDocumentId, artifact_uri: resultUri,
      artifact_hash: msg.result_artifact_hash, result_artifact_hash: msg.result_artifact_hash, parent_hash: msg.base_artifact_hash,
      source: "bridge", result_kind: msg.result_kind });
    if (msg.result_kind === "overwrite") {
      chrome.runtime.sendMessage({ type: "artifact-reload-requested", tabIdHint: sender.tab && sender.tab.id }).catch(() => {});
      return { ok: true, action: "reload" };
    }
    return { ok: true, action: "navigate_required" };
  }
  // 浏览器手工/扩展集成测试钩子；不暴露任何文件写入能力。
  window.__hgArtifactVersionTest = { artifactStateSnapshot, getArtifactState, applyRestoredArtifact, handleArtifactUpdateReady };

  // === #5: i18n —— 读本地存储的语言偏好(覆盖浏览器检测),并监听 sidepanel 的切换实时重建工具栏 ===
  if (window.HG_I18N) {
    HG_I18N.init().then(updateToolbarLabels);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.hg_lang) HG_I18N.reload().then(updateToolbarLabels);
    });
  }

  // #1: 心跳看门狗 —— 侧边栏「关闭」事件偶尔不触发时,连续 ~12s 收不到 ping 也自动失活(兜底)
  setInterval(() => { if (_activated && Date.now() - _lastPingAt > 12000) deactivateNow(); }, 3000);

  // === 初始化 ===
  (async () => {
    // 用户在确认窗点了「刷新」→ 重载后本会话标记 hg_autoedit:自动激活并进入编辑,不再弹窗
    let autoEdit = false;
    try { autoEdit = sessionStorage.getItem("hg_autoedit") === "1"; if (autoEdit) sessionStorage.removeItem("hg_autoedit"); } catch (e) {}
    await restoreIfFresh();
    if (autoEdit) { _activated = true; _refreshDialogShown = true; } // 自激活:渲染高亮 + 跳过确认窗
    if (!_artifactVerificationError) await loadAnnotations();
    if (autoEdit) setEditing(true); // 直接进入编辑(广播 edit-state → 侧边栏同步「退出编辑」)
  })();
  console.log("htmlGenius v0.7.1 ready, mode:", isLocal ? "local" : "remote(editable, temporary)", "starts in view");
})();
