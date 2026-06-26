// editor.js — contenteditable 编辑运行时:初始化 + 限定不可编辑元素 + 粘贴纯文本 + emit dom-changed
export function initEditor(iDoc, iWin) {
  const body = iDoc.body;
  body.contentEditable = "true";

  // 不可编辑:head 内元素 + 注入元素(overlay/浮工具栏)
  iDoc.querySelectorAll("script,style,head,title,meta,link,[data-htmlgenius-injected]").forEach((el) => {
    el.setAttribute("contenteditable", "false");
    el.setAttribute("tabindex", "-1");
  });

  // 粘贴:仅纯文本(防外部 style/class/script 污染结构)
  body.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = ((e.clipboardData || {}).getData || (() => "")).call(e.clipboardData, "text/plain") || "";
    const sel = iDoc.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(iDoc.createTextNode(text));
      range.collapse(false);
    }
  });

  // input → emit dom-changed(供 annotate 触发 re-anchor)
  body.addEventListener("input", () => {
    iDoc.dispatchEvent(new iWin.Event("dom-changed", { bubbles: true }));
  });
}
