// selection-toolbar.js — 选中文字浮工具栏(加粗/颜色/字号/对齐)+ 样式应用(单元素;跨标签在 Task6 扩展)
export function initToolbar(iDoc, iWin) {
  const bar = iDoc.createElement("div");
  bar.id = "hg-toolbar";
  bar.dataset.htmlgeniusInjected = "true";
  bar.innerHTML = `
    <button data-act="bold" title="加粗"><b>B</b></button>
    <input type="color" data-act="color" title="颜色">
    <select data-act="fontsize" title="字号"><option value="">字号</option><option value="14">14</option><option value="18">18</option><option value="24">24</option></select>
    <button data-act="align-left" title="左对齐">⇤</button>
    <button data-act="align-center" title="居中">↔</button>
  `;
  iDoc.body.appendChild(bar);

  const style = iDoc.createElement("style");
  style.dataset.htmlgeniusInjected = "true";
  style.textContent =
    "#hg-toolbar{position:absolute;display:none;z-index:999998;background:#1f2328;color:#fff;border-radius:6px;padding:4px;align-items:center;gap:4px;}" +
    "#hg-toolbar.show{display:flex;}" +
    "#hg-toolbar button{background:transparent;color:#fff;border:0;cursor:pointer;padding:2px 6px;border-radius:4px;font-size:13px;}" +
    "#hg-toolbar button:hover{background:#374151;}" +
    "#hg-toolbar select,input{border-radius:4px;}";
  iDoc.head.appendChild(style);

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) applyAction(iDoc, btn.dataset.act);
  });
  bar.querySelector('input[data-act="color"]').addEventListener("input", (e) => applyAction(iDoc, "color", e.target.value));
  bar.querySelector('select[data-act="fontsize"]').addEventListener("change", (e) => applyAction(iDoc, "fontsize", e.target.value));

  iDoc.addEventListener("selectionchange", () => {
    const sel = iDoc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { bar.classList.remove("show"); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { bar.classList.remove("show"); return; }
    bar.style.left = (rect.left + rect.width / 2 + iWin.scrollX) + "px";
    bar.style.top = (rect.top - 8 + iWin.scrollY) + "px";
    bar.style.transform = "translate(-50%,-100%)";
    bar.classList.add("show");
  });
  return bar;
}

export function applyAction(iDoc, act, value) {
  const sel = iDoc.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (act === "bold") applyStyle(iDoc, range, "fontWeight", "bold");
  else if (act === "color") applyStyle(iDoc, range, "color", value);
  else if (act === "fontsize") applyStyle(iDoc, range, "fontSize", value + "px");
  else if (act === "align-left") applyAlign(iDoc, range, "left");
  else if (act === "align-center") applyAlign(iDoc, range, "center");
}

/** 包 span 只改选区(单/跨标签);跨标签 surroundContents 失败时 extractContents 兜底 */
export function applyStyle(iDoc, range, prop, value) {
  const span = iDoc.createElement("span");
  span.style[prop] = value;
  try {
    range.surroundContents(span);
  } catch (e) {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  iDoc.dispatchEvent(new iDoc.defaultView.Event("dom-changed", { bubbles: true }));
  return span;
}

function applyAlign(iDoc, range, align) {
  let el = range.commonAncestorContainer;
  if (el.nodeType === 3) el = el.parentElement;
  while (el && el !== iDoc.body) {
    if (iDoc.defaultView.getComputedStyle(el).display === "block") {
      el.style.textAlign = align;
      iDoc.dispatchEvent(new iDoc.defaultView.Event("dom-changed", { bubbles: true }));
      return;
    }
    el = el.parentElement;
  }
}
