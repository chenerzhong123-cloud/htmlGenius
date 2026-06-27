import { describe, anchor } from "./anchoring/text-quote.js";
import { initEditor } from "./editor.js";
import { initToolbar } from "./selection-toolbar.js";
import { VersionManager } from "./version.js";

const params = new URLSearchParams(location.search);
const docId = params.get("doc") || "01_token";
const docPath = docId === "spec"
  ? "/docs/2026-06-25-html-annotation-feedback-loop-design.html"
  : `/samples/${docId}.html`;

const API = "/api";
const frame = document.getElementById("doc-frame");
const statusEl = document.getElementById("status");
document.getElementById("doc-title").textContent = `文档:${docId}`;

const sidebar = document.getElementById("sidebar");
const sidebarScroll = document.getElementById("sidebar-scroll");
const listEl = document.getElementById("sidebar-list");
const archiveEl = document.getElementById("sidebar-archive");
const countArchive = document.getElementById("count-archive");
const toggleBtn = document.getElementById("toggle-sidebar");
const archiveToggle = document.getElementById("archive-toggle");

let userToggled = false;
let lastSelector = null;
let iWin = null;
let posRAF = 0;
let viewHCached = 0;
const rangesById = new Map();    // annId -> Range(iframe 内,DOM 不动)
const overlaysById = new Map();  // annId -> [.ann-hl 矩形 div]
const cardsById = new Map();     // annId -> { card, baseY, height }

toggleBtn.addEventListener("click", () => {
  userToggled = true;
  sidebar.classList.toggle("collapsed");
});
archiveToggle.addEventListener("click", () => {
  const show = archiveEl.hidden;
  archiveEl.hidden = !show;
  archiveToggle.classList.toggle("expanded", show);
});

const exportBtn = document.getElementById("export-btn");
if (exportBtn) exportBtn.addEventListener("click", exportToClipboard);

frame.src = docPath;
frame.addEventListener("load", init);

/** 注入 iframe 内的 overlay 高亮样式 + 悬浮批注浮层 */
function injectStyle(doc) {
  const style = doc.createElement("style");
  style.textContent = `
    .ann-hl{ position:absolute; background:rgba(255,243,160,0.55); border-radius:2px; pointer-events:none; z-index:1; }
    .ann-hl.flash{ background:rgba(251,191,36,0.75); }
    #ann-float{ position:absolute; z-index:999999; display:none; background:#1f2328; color:#fff; border-radius:8px; padding:6px; box-shadow:0 4px 12px rgba(0,0,0,.25); font-size:13px; }
    #ann-float.show{ display:block; }
    #ann-btn{ background:transparent; color:#fff; border:0; cursor:pointer; padding:4px 12px; border-radius:5px; font-size:13px; font-weight:500; }
    #ann-btn:hover{ background:#374151; }
    #ann-editor{ display:none; }
    #ann-editor.show{ display:block; }
    #ann-editor textarea{ width:240px; height:64px; font-size:13px; padding:6px; border:0; border-radius:5px; resize:none; box-sizing:border-box; }
    #ann-editor .row{ display:flex; gap:6px; justify-content:flex-end; margin-top:6px; }
    #ann-editor button{ border:0; border-radius:5px; padding:4px 12px; cursor:pointer; font-size:12px; font-weight:500; }
    #ann-submit{ background:#0969da; color:#fff; }
    #ann-cancel{ background:#4b5563; color:#fff; }
  `;
  style.dataset.htmlgeniusInjected = "true";
  doc.head.appendChild(style);

  const f = doc.createElement("div");
  f.id = "ann-float";
  f.innerHTML = `
    <button id="ann-btn">批注</button>
    <div id="ann-editor">
      <textarea id="ann-input" placeholder="写下评论…"></textarea>
      <div class="row">
        <button id="ann-cancel">取消</button>
        <button id="ann-submit">提交</button>
      </div>
    </div>
  `;
  f.dataset.htmlgeniusInjected = "true";
  doc.body.appendChild(f);
}

let iDoc, iRoot, iFloat, iBtn, iEditor, iInput;

async function init() {
  iDoc = frame.contentDocument;
  iWin = frame.contentWindow;
  if (!iDoc) return;
  iRoot = iDoc.body;
  injectStyle(iDoc);
  iFloat = iDoc.getElementById("ann-float");
  iBtn = iDoc.getElementById("ann-btn");
  iEditor = iDoc.getElementById("ann-editor");
  iInput = iDoc.getElementById("ann-input");

  window.__describe = describe; // 供 e2e 测试
  window.__buildPrompt = buildPrompt;
  window.__frame = frame;

  iFloat.addEventListener("mousedown", (e) => e.preventDefault());
  iDoc.addEventListener("selectionchange", onSelectionChange);
  iBtn.addEventListener("click", () => {
    iBtn.style.display = "none";
    iEditor.classList.add("show");
    iInput.focus();
  });
  iDoc.getElementById("ann-cancel").addEventListener("click", hideFloat);
  iDoc.getElementById("ann-submit").addEventListener("click", submitFromFloat);

  // iframe 滚动/缩放 → rAF 更新卡片 transform(侧栏不滚动,避免双滚动卡顿)
  viewHCached = sidebarScroll.clientHeight;
  iWin.addEventListener("scroll", scheduleUpdate);
  iWin.addEventListener("resize", () => { viewHCached = sidebarScroll.clientHeight; scheduleUpdate(); });
  // editor 编辑后 → debounce re-anchor(批注在新 DOM 上重新定位)
  iDoc.addEventListener("dom-changed", scheduleReanchor);
  // v0.2: 编辑运行时(contenteditable + 浮工具栏 + 版本管理)
  initEditor(iDoc, iWin);
  initToolbar(iDoc, iWin);
  window.__vm = new VersionManager(docId, iDoc, iWin);
  window.__vm.start();
  await loadAnnotations();
}

let reanchorTimer = 0;
function scheduleReanchor() {
  clearTimeout(reanchorTimer);
  reanchorTimer = setTimeout(() => loadAnnotations(), 300);
}

function scheduleUpdate() {
  if (posRAF) return;
  posRAF = requestAnimationFrame(() => { posRAF = 0; updatePositions(); });
}

function currentRange() {
  const s = iDoc.getSelection();
  if (!s || s.isCollapsed || s.rangeCount === 0) return null;
  const r = s.getRangeAt(0);
  if (!r.toString().trim()) return null;
  return r;
}

function onSelectionChange() {
  if (iEditor && iEditor.classList.contains("show")) return;
  const r = currentRange();
  if (!r) { hideFloat(); lastSelector = null; return; }
  const selector = describe(r, iRoot);
  if (!selector || !selector.exact) { hideFloat(); return; }
  lastSelector = selector;

  const rect = r.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { hideFloat(); return; }
  const above = rect.top > 50;
  iFloat.style.left = `${rect.left + rect.width / 2}px`;
  iFloat.style.top = above ? `${rect.top - 8}px` : `${rect.bottom + 8}px`;
  iFloat.style.transform = above ? "translate(-50%, -100%)" : "translate(-50%, 0)";
  iFloat.classList.add("show");
  iBtn.style.display = "";
  iEditor.classList.remove("show");
  iInput.value = "";
}

function hideFloat() {
  if (!iFloat) return;
  iFloat.classList.remove("show");
  iEditor.classList.remove("show");
  iBtn.style.display = "";
  if (iInput) iInput.value = "";
}

async function submitFromFloat() {
  if (!lastSelector || !lastSelector.exact) return;
  const comment = iInput.value.trim();
  await saveAnnotation({
    document_id: docId,
    selector: lastSelector,
    quote: lastSelector.exact,
    body: { comment, action: "rewrite", instruction: "" },
  });
  hideFloat();
  lastSelector = null;
  iDoc.getSelection().removeAllRanges();
  await loadAnnotations();
}

async function saveAnnotation(payload) {
  const r = await fetch(`${API}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function deleteAnnotation(aid) {
  await fetch(`${API}/annotations/${aid}`, { method: "DELETE" });
  await loadAnnotations();
}

/** 导出 sink:把批注组装成结构化 prompt,复制到剪贴板(回灌 CLI) */
async function exportToClipboard() {
  const r = await fetch(`${API}/annotations?document_id=${encodeURIComponent(docId)}`);
  const data = await r.json();
  const items = data.items || [];
  if (items.length === 0) { alert("暂无批注可回灌"); return; }
  for (const a of items) a._section = sectionOf(a.id);
  const prompt = buildPrompt(items);
  try {
    await navigator.clipboard.writeText(prompt);
    if (exportBtn) {
      const old = exportBtn.textContent;
      exportBtn.textContent = "已复制 ✓";
      setTimeout(() => { exportBtn.textContent = old; }, 1500);
    }
  } catch (e) {
    console.error("clipboard failed", e);
    const w = window.open("", "_blank");
    if (w) {
      w.document.title = "回灌 prompt";
      w.document.body.style.whiteSpace = "pre-wrap";
      w.document.body.style.fontFamily = "monospace";
      w.document.body.textContent = prompt;
    } else {
      alert("复制失败,请手动复制:\n\n" + prompt);
    }
  }
}

function buildPrompt(items) {
  const lines = items.map((a, i) => {
    const sel = a.selector || {};
    const exact = sel.exact || a.quote || "";
    const prefix = (sel.prefix || "").trim();
    const suffix = (sel.suffix || "").trim();
    const section = a._section ? `〔章节:${a._section}〕 ` : "";
    const loc = (prefix || suffix)
      ? `定位:${prefix ? `前文「${prefix}」 ` : ""}【原文】「${exact}」${suffix ? ` 后文「${suffix}」` : ""}`
      : `定位:【原文】「${exact}」(无前后文,请按原文唯一定位)`;
    const action = a.body?.action || "rewrite";
    const instr = (a.body?.instruction || "").trim() || a.body?.comment || "(无)";
    return `==批注 ${i + 1} / ${items.length}== ${section}\n动作:${action}\n${loc}\n指令:${instr}`;
  });
  return `你是一名 HTML 编辑执行器。下面给出文档《${docId}》的 ${items.length} 条批注,请严格逐条执行修改,并输出完整的新版 HTML(从 <!DOCTYPE html> 到 </html>,不要省略、不要用 diff)。

执行规则:
1. 每条【定位】由「前文 + 原文 + 后文」三段联合匹配,定位到唯一一处;若文档有多处同名片段,只改定位匹配到的那一处,其余保持不变。
2. 按 action 处理:rewrite=按指令改写该处;delete=删除该处(保留所在块级结构);question=不改正文,仅在文末「待确认问题」清单列出。
3. 只改批注命中的位置,不得改动其他段落的文字、结构、样式、链接。
4. 保留原文档 DOCTYPE、head、CSS、script 与整体结构,仅替换被命中的文本。
5. 全部处理完后,先输出一行「==已处理 ${items.length} 条批注==」,再输出完整 HTML。

${lines.join("\n\n")}`;
}

/** 章节锚点(B 兜底):批注所在最近 h1/h2/h3 标题文本(用于极短/重复原文消歧) */
function sectionOf(annId) {
  const range = rangesById.get(annId);
  if (!range) return "";
  let el = range.commonAncestorContainer;
  if (el.nodeType === 3) el = el.parentNode;
  while (el && el !== iRoot) {
    if (el.tagName && /^H[1-3]$/.test(el.tagName)) return (el.textContent || "").trim();
    const h = el.querySelector ? el.querySelector("h1,h2,h3") : null;
    if (h) return (h.textContent || "").trim();
    el = el.parentElement;
  }
  return "";
}

async function loadAnnotations() {
  rangesById.clear();
  iDoc.querySelectorAll(".ann-hl").forEach((d) => d.remove());
  overlaysById.clear();

  const r = await fetch(`${API}/annotations?document_id=${encodeURIComponent(docId)}`);
  const data = await r.json();

  const main = [];
  const archive = [];
  for (const ann of data.items) {
    const range = anchor(ann.selector, iRoot);
    if (range) {
      rangesById.set(ann.id, range);
      overlaysById.set(ann.id, highlightOverlay(range, ann));
      main.push(ann);
    } else {
      archive.push(ann);
    }
  }

  renderMainCards(main);
  renderCards(archiveEl, archive, true);

  countArchive.textContent = archive.length ? `(${archive.length})` : "";
  statusEl.textContent = `批注 ${main.length} 条 · 已归档 ${archive.length} 条`;

  if (!userToggled) {
    sidebar.classList.toggle("collapsed", main.length + archive.length === 0);
  }
  updatePositions();
}

/** overlay 高亮:用矩形覆盖 range 的所有 rect(文档坐标,不随滚动变),完全不碰原文 DOM */
function highlightOverlay(range, ann) {
  const rects = range.getClientRects();
  const sy = iWin.scrollY, sx = iWin.scrollX;
  const divs = [];
  for (const r of rects) {
    const div = iDoc.createElement("div");
    div.className = "ann-hl";
    div.dataset.ann = ann.id;
    div.dataset.htmlgeniusInjected = "true";
    div.style.left = (r.left + sx) + "px";
    div.style.top = (r.top + sy) + "px";
    div.style.width = r.width + "px";
    div.style.height = r.height + "px";
    iRoot.appendChild(div);
    divs.push(div);
  }
  return divs;
}

/** range 在 iframe viewport 的顶部 Y(随滚动变) */
function rangeViewportY(annId) {
  const range = rangesById.get(annId);
  if (!range) return -9999;
  const rects = range.getClientRects();
  if (!rects.length) return -9999;
  return rects[0].top;
}

/** range 在 iframe 文档中的顶部 Y(相对文档顶,固定——renderMainCards 一次性算 baseY 用) */
function markDocY(annId) {
  const range = rangesById.get(annId);
  if (!range) return 0;
  const r = range.getBoundingClientRect();
  return r.top + (iWin ? iWin.scrollY : 0);
}

/** 每帧:只读 scrollY + 设 transform/opacity(用缓存 baseY/height/viewH,不读布局属性,避免 reflow) */
function updatePositions() {
  const sy = iWin.scrollY;
  for (const [, info] of cardsById) {
    const vy = info.baseY - sy;
    info.card.style.transform = `translateY(${vy}px)`;
    const out = (vy + info.height < -20 || vy > viewHCached + 20);
    if (out) {
      if (info.card.style.opacity !== "0") { info.card.style.opacity = "0"; info.card.style.pointerEvents = "none"; }
    } else if (info.card.style.opacity !== "1") {
      info.card.style.opacity = "1"; info.card.style.pointerEvents = "auto";
    }
  }
}

function createCardEl(ann, isArchive) {
  const card = document.createElement("div");
  card.className = "card" + (isArchive ? " archive" : "");
  card.dataset.ann = ann.id;
  const quote = (ann.quote || "").slice(0, 80);
  const comment = ann.body?.comment || "(无评论)";
  const badge = isArchive ? "无法定位" : (ann.body?.action || "");
  card.innerHTML = `
    <div class="quote">${escapeHtml(quote)}</div>
    <div class="comment">${escapeHtml(comment)}</div>
    <div class="meta">
      <span class="badge">${escapeHtml(badge)}</span>
      <button class="del">删除</button>
    </div>
  `;
  if (!isArchive) {
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) return;
      scrollToAnn(ann.id);
    });
  }
  card.querySelector(".del").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteAnnotation(ann.id);
  });
  return card;
}

function renderMainCards(items) {
  listEl.innerHTML = "";
  cardsById.clear();
  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty" style="position:absolute;top:8px;left:0;right:0;">选中正文文字 → 点「批注」</div>`;
    return;
  }
  // 一次性:按文档 Y 排序 + 重叠避让算 baseY + 缓存高度(避免每帧读布局属性)
  const sorted = [...items].sort((a, b) => markDocY(a.id) - markDocY(b.id));
  const GAP = 6;
  let prevBottom = -Infinity;
  for (const ann of sorted) {
    const card = createCardEl(ann, false);
    listEl.appendChild(card);
    const docY = markDocY(ann.id);
    const h = card.offsetHeight;
    let baseY = Math.max(0, docY);
    if (baseY < prevBottom + GAP) baseY = prevBottom + GAP;
    card.style.transform = `translateY(${baseY}px)`;
    cardsById.set(ann.id, { card, baseY, height: h });
    prevBottom = baseY + h;
  }
}

function renderCards(container, items, isArchive) {
  container.innerHTML = "";
  for (const ann of items) container.appendChild(createCardEl(ann, isArchive));
}

function scrollToAnn(annId) {
  const range = rangesById.get(annId);
  if (!range) return;
  const top = range.getBoundingClientRect().top + iWin.scrollY - iWin.innerHeight / 2;
  iWin.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  // flash overlay
  const divs = overlaysById.get(annId) || [];
  divs.forEach((d) => d.classList.add("flash"));
  setTimeout(() => divs.forEach((d) => d.classList.remove("flash")), 1200);
  // smooth 滚动期间持续更新卡片位置
  let n = 0;
  const tick = () => { updatePositions(); if (n++ < 60) requestAnimationFrame(tick); };
  tick();
  activateCard(annId);
}

function activateCard(annId) {
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
  const card = document.querySelector(`.card[data-ann="${annId}"]`);
  if (card) card.classList.add("active");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
