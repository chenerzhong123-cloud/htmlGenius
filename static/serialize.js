// serialize.js — 序列化 iframe 完整文档(含 head/style),剥离所有注入元素后返回 outerHTML
export function serializeDoc(iDoc) {
  const clone = iDoc.documentElement.cloneNode(true);
  clone.querySelectorAll("[data-htmlgenius-injected]").forEach((el) => el.remove());
  return clone.outerHTML;
}
