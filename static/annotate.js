import { describe, anchor } from "./anchoring/text-quote.js";

const params = new URLSearchParams(location.search);
const docId = params.get("doc") || "01_token";
const docPath =
  docId === "spec"
    ? "/docs/2026-06-25-html-annotation-feedback-loop-design.html"
    : `/samples/${docId}.html`;

const API = "/api";
const frame = document.getElementById("doc-frame");
const statusEl = document.getElementById("status");
document.getElementById("doc-title").textContent = `文档:${docId}`;

frame.src = docPath;
frame.addEventListener("load", init);

/** 给 iframe 注入高亮样式(非侵入:不改目标 HTML 文件) */
function injectStyle(doc) {
  const style = doc.createElement("style");
  style.textContent = `mark[data-ann]{background:#fff3a0;border-radius:2px;cursor:help;}`;
  doc.head.appendChild(style);
}

async function init() {
  const doc = frame.contentDocument;
  if (!doc) return;
  injectStyle(doc);
  doc.body.addEventListener("mouseup", onSelect);
  window.__describe = describe; // 暴露给端到端测试用
  window.__frame = frame;
  await loadAnnotations(doc.body);
}

async function onSelect() {
  const doc = frame.contentDocument;
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const selector = describe(range, doc.body);
  if (!selector || !selector.exact) return;
  const comment = window.prompt("批注内容(可选):") || "";
  await saveAnnotation({
    document_id: docId,
    selector,
    quote: selector.exact,
    body: { comment, action: "rewrite", instruction: "" },
  });
  sel.removeAllRanges();
  await loadAnnotations(doc.body);
}

async function saveAnnotation(payload) {
  const r = await fetch(`${API}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

/** 清除旧高亮,重新按 selector 定位渲染 */
async function loadAnnotations(root) {
  const doc = root.ownerDocument;
  doc.querySelectorAll("mark[data-ann]").forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  root.normalize();

  const r = await fetch(`${API}/annotations?document_id=${encodeURIComponent(docId)}`);
  const data = await r.json();
  let opened = 0;
  let stale = 0;
  for (const ann of data.items) {
    const range = anchor(ann.selector, root);
    if (range) {
      highlight(doc, range, ann);
      opened++;
    } else {
      stale++;
    }
  }
  statusEl.textContent = `已定位 ${opened} 条 · stale ${stale} 条`;
}

function highlight(doc, range, ann) {
  const mark = doc.createElement("mark");
  mark.dataset.ann = ann.id;
  mark.title = ann.body?.comment || "(无评论)";
  try {
    range.surroundContents(mark);
  } catch (e) {
    // 选区边界不整(跨节点)surroundContents 会抛错:fallback 提取再包裹
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
}
