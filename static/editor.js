// editor.js — contenteditable 编辑运行时:初始化 + 限定不可编辑元素 + 粘贴纯文本 + emit dom-changed + 撤销
const undoStack = [];
const MAX_UNDO = 50;

export function pushUndo(iDoc) {
  undoStack.push(iDoc.body.innerHTML);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

export function undo(iDoc) {
  if (!undoStack.length) return false;
  iDoc.body.innerHTML = undoStack.pop();
  iDoc.dispatchEvent(new iDoc.defaultView.Event("dom-changed", { bubbles: true }));
  return true;
}

export function initEditor(iDoc, iWin) {
  const body = iDoc.body;
  body.contentEditable = "true";

  // 不可编辑:head 内元素 + 注入元素(overlay/浮工具栏)
  iDoc.querySelectorAll("script,style,head,title,meta,link,[data-htmlgenius-injected]").forEach((el) => {
    el.setAttribute("contenteditable", "false");
    el.setAttribute("tabindex", "-1");
  });

  // 粘贴:借鉴 Quill clipboard 模块——保留安全格式(DOMPurify 清洗),非纯文本
  body.addEventListener("paste", (e) => {
    e.preventDefault();
    const cd = e.clipboardData || {};
    const html = cd.getData("text/html") || "";
    const text = cd.getData("text/plain") || "";
    const sel = iDoc.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    if (html && window.DOMPurify) {
      const clean = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
      range.insertNode(range.createContextualFragment(clean));
    } else {
      range.insertNode(iDoc.createTextNode(text));
    }
    range.collapse(false);
  });

  // input → emit dom-changed + 借鉴 Lexical 合并连续输入为一步 undo(debounce 1s push)
  let undoDebounce = 0;
  body.addEventListener("input", () => {
    iDoc.dispatchEvent(new iWin.Event("dom-changed", { bubbles: true }));
    clearTimeout(undoDebounce);
    undoDebounce = setTimeout(() => pushUndo(iDoc), 1000);
  });
  // Ctrl+Shift+Z 撤销(避开浏览器原生 Ctrl+Z 的字符级 undo)
  iDoc.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      undo(iDoc);
    }
  });
}
