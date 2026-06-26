import { describe, anchor } from "./anchoring/text-quote.js";

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
let syncing = false;
const marksById = new Map(); // annId -> mark element(iframe 内)

toggleBtn.addEventListener("click", () => {
  userToggled = true;
  sidebar.classList.toggle("collapsed");
});
archiveToggle.addEventListener("click", () => {
  const show = archiveEl.hidden;
  archiveEl.hidden = !show;
  archiveToggle.classList.toggle("expanded", show);
});

frame.src = docPath;
frame.addEventListener("load", init);

/** 注入 iframe 内的高亮样式 + 悬浮批注浮层 */
function injectStyle(doc) {
  const style = doc.createElement("style");
  style.textContent = `
    mark[data-ann]{ background:#fff3a0; border-radius:2px; cursor:pointer; }
    mark[data-ann].flash{ background:#fbbf24; }
    #ann-float{
      position:absolute; z-index:999999; display:none;
      background:#1f2328; color:#fff; border-radius:8px; padding:6px;
      box-shadow:0 4px 12px rgba(0,0,0,.25); font-size:13px;
    }
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

  setupScrollSync();
  await loadAnnotations();
}

/** iframe 与 sidebar-scroll 双向同步滚动 */
function setupScrollSync() {
  iWin.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    sidebarScroll.scrollTop = iWin.scrollY;
    syncing = false;
  });
  sidebarScroll.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    iWin.scrollTo({ top: sidebarScroll.scrollTop });
    syncing = false;
  });
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

async function loadAnnotations() {
  marksById.clear();
  iDoc.querySelectorAll("mark[data-ann]").forEach((m) => {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  });
  iRoot.normalize();

  const r = await fetch(`${API}/annotations?document_id=${encodeURIComponent(docId)}`);
  const data = await r.json();

  const main = [];
  const archive = [];
  for (const ann of data.items) {
    const range = anchor(ann.selector, iRoot);
    if (range) {
      const mark = highlight(range, ann);
      marksById.set(ann.id, mark);
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
}

/** mark 在 iframe 文档中的纵向位置(相对文档顶) */
function markDocY(annId) {
  const m = marksById.get(annId);
  if (!m) return 0;
  const r = m.getBoundingClientRect();
  return r.top + (iWin ? iWin.scrollY : 0);
}

/** 主卡片:绝对锚定到对应高亮的 Y,重叠时向下避让 */
function renderMainCards(items) {
  listEl.innerHTML = "";
  const docH = Math.max(iDoc.documentElement.scrollHeight, iRoot.scrollHeight);
  listEl.style.height = docH + "px";

  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty" style="position:absolute;top:8px;left:0;right:0;">选中正文文字 → 点「批注」</div>`;
    return;
  }

  const withY = items.map((ann) => ({ ann, y: markDocY(ann.id) }));
  withY.sort((a, b) => a.y - b.y);

  const GAP = 6;
  let prevBottom = -Infinity;
  for (const { ann, y } of withY) {
    const card = createCardEl(ann, false);
    listEl.appendChild(card);
    let top = Math.max(0, y);
    if (top < prevBottom + GAP) top = prevBottom + GAP;
    card.style.top = top + "px";
    prevBottom = top + card.offsetHeight;
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

function renderCards(container, items, isArchive) {
  container.innerHTML = "";
  for (const ann of items) {
    container.appendChild(createCardEl(ann, isArchive));
  }
}

function scrollToAnn(annId) {
  const mark = marksById.get(annId);
  if (!mark) return;
  syncing = true;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  const markY = markDocY(annId);
  sidebarScroll.scrollTo({ top: Math.max(0, markY - sidebarScroll.clientHeight / 2), behavior: "smooth" });
  setTimeout(() => { syncing = false; }, 700);
  mark.classList.add("flash");
  setTimeout(() => mark.classList.remove("flash"), 1200);
}

function activateCard(annId) {
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
  const card = document.querySelector(`.card[data-ann="${annId}"]`);
  if (card) {
    card.classList.add("active");
    syncing = true;
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => { syncing = false; }, 500);
  }
}

function highlight(range, ann) {
  const mark = iDoc.createElement("mark");
  mark.dataset.ann = ann.id;
  mark.addEventListener("click", () => activateCard(ann.id));
  try {
    range.surroundContents(mark);
  } catch (e) {
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
  return mark;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
