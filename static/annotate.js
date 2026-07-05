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

// v0.4 鉴权:T2 后 /api/annotations 需要 Bearer token。token 由 viewer.html
// 写入 localStorage.hg_token;未设置则返回 undefined → 不发 Authorization(会 401,
// 这正是引导用户输入 token 的正确信号)。
function hgToken() {
  try { return localStorage.getItem("hg_token") || null; } catch (e) { return null; }
}
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  const tok = hgToken();
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

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

/** 注入 iframe 内的 overlay 高亮样式(批注浮层已并入 selection-toolbar,不再单独注入 #ann-float) */
function injectStyle(doc) {
  const style = doc.createElement("style");
  style.textContent = `
    .ann-hl{ position:absolute; background:rgba(255,243,160,0.55); border-radius:2px; pointer-events:none; z-index:1; }
    .ann-hl.flash{ background:rgba(251,191,36,0.75); }
  `;
  style.dataset.htmlgeniusInjected = "true";
  doc.head.appendChild(style);
}

let iDoc, iRoot;

async function init() {
  iDoc = frame.contentDocument;
  iWin = frame.contentWindow;
  if (!iDoc) return;
  iRoot = iDoc.body;
  injectStyle(iDoc);

  window.__describe = describe; // 供 e2e 测试
  window.__buildPrompt = buildPrompt;
  window.__frame = frame;

  // iframe 滚动/缩放 → rAF 更新卡片 transform
  viewHCached = sidebarScroll.clientHeight;
  iWin.addEventListener("scroll", scheduleUpdate);
  iWin.addEventListener("resize", () => { viewHCached = sidebarScroll.clientHeight; scheduleUpdate(); });
  // 编辑后 → re-anchor(编辑中不重建,避免打字闪烁;失焦/停顿才重建)
  iDoc.addEventListener("dom-changed", scheduleReanchor);
  // undo 后 #hg-toolbar 被 innerHTML 覆盖 → 重建 toolbar + overlay
  iDoc.addEventListener("undo-done", () => {
    initToolbar(iDoc, iWin, createAnnotationFromSelection);
    loadAnnotations();
  });
  iDoc.body.addEventListener("blur", () => setTimeout(scheduleReanchor, 120), true);
  // v0.2: 编辑运行时(contenteditable + 浮工具栏[含 Comment]+ 版本管理)
  initEditor(iDoc, iWin);
  initToolbar(iDoc, iWin, createAnnotationFromSelection);
  window.__vm = new VersionManager(docId, iDoc, iWin);
  window.__vm.start();
  await loadAnnotations();
}

let reanchorTimer = 0;
function scheduleReanchor() {
  // ① 编辑中(contenteditable 活跃)不 re-anchor,避免每次输入都全清重建 overlay → 闪烁
  const editing = iDoc.activeElement && iDoc.activeElement.isContentEditable;
  clearTimeout(reanchorTimer);
  if (editing) return;  // 编辑中不重建,等失焦(blur)再触发
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

/** ② 批注入口(由 selection-toolbar 的 Comment 按钮调用):当前选区 → selector → 评论 → 存储 */
async function createAnnotationFromSelection() {
  const r = currentRange();
  if (!r) return;
  const selector = describe(r, iRoot);
  if (!selector || !selector.exact) return;
  const comment = (iWin.prompt("批注评论(可空):") || "").trim();
  await saveAnnotation({
    document_id: docId,
    selector,
    quote: selector.exact,
    body: { comment, action: "rewrite", instruction: "" },
  });
  iDoc.getSelection().removeAllRanges();
  await loadAnnotations();
}

async function saveAnnotation(payload) {
  const r = await fetch(`${API}/annotations`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function deleteAnnotation(aid) {
  await fetch(`${API}/annotations/${aid}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  await loadAnnotations();
}

/** 导出 sink:把批注组装成结构化 prompt,复制到剪贴板(回灌 CLI) */
async function exportToClipboard() {
  const r = await fetch(`${API}/annotations?document_id=${encodeURIComponent(docId)}`, {
    headers: authHeaders(),
  });
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

/** 章节锚点(B 兜底):批注所在最近 h1/h2/h3 标题文本 */
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

  const r = await fetch(`${API}/annotations?document_id=${encodeURIComponent(docId)}`, {
    headers: authHeaders(),
  });
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

function rangeViewportY(annId) {
  const range = rangesById.get(annId);
  if (!range) return -9999;
  const rects = range.getClientRects();
  if (!rects.length) return -9999;
  return rects[0].top;
}

function markDocY(annId) {
  const range = rangesById.get(annId);
  if (!range) return 0;
  const r = range.getBoundingClientRect();
  return r.top + (iWin ? iWin.scrollY : 0);
}

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
  const divs = overlaysById.get(annId) || [];
  divs.forEach((d) => d.classList.add("flash"));
  setTimeout(() => divs.forEach((d) => d.classList.remove("flash")), 1200);
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
