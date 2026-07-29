// version.js — 版本管理:防抖/定时自动存 + 列表 + 还原(sanitize)
import { serializeDoc } from "./serialize.js";
import { sanitizeHTML } from "./sanitize.js";

// BE-2:版本接口需 Bearer session 鉴权。token 由 viewer.html / 测试 page fixture 写入
// localStorage.hg_session(与 annotate.js 的 authHeaders 同源)。未登录则不带头 → 401。
function authHeader(extra) {
  const h = Object.assign({}, extra || {});
  try {
    const tok = localStorage.getItem("hg_session");
    if (tok) h["Authorization"] = `Bearer ${tok}`;
  } catch (e) {}
  return h;
}

export class VersionManager {
  constructor(docId, iDoc, iWin, apiBase = "/api") {
    this.docId = docId;
    this.iDoc = iDoc;
    this.iWin = iWin;
    this.api = apiBase;
    this.timer = null;
    this.interval = null;
    this.dirty = false;
    this._onRestore = null;
  }

  start(debounceMs = 1500, intervalMs = 5000) {
    this.iDoc.body.addEventListener("input", () => this.schedule(debounceMs));
    this.interval = this.iWin.setInterval(() => this.flush(), intervalMs);
    this.iWin.addEventListener("beforeunload", () => this.flushSync());
  }

  schedule(ms) {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }

  flushPending() {
    // 撤销路径调用:把未落库 dirty 立即存(避免丢步)
    return this.flush();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    clearTimeout(this.timer);
    const html = serializeDoc(this.iDoc);
    try {
      await fetch(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions`, {
        method: "POST",
        headers: authHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify({ html_content: html, source: "edit" }),
      });
    } catch (e) {
      this.dirty = true;  // 失败重试
    }
  }

  flushSync() {
    // beforeunload 不能等 async。改用 keepalive fetch(sendBeacon 无法带 Authorization 头,
    // 版本接口现已需鉴权);keepalive 使请求在页面卸载后仍发出。
    if (!this.dirty) return;
    this.dirty = false;
    const html = serializeDoc(this.iDoc);
    try {
      fetch(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions`, {
        method: "POST",
        keepalive: true,
        headers: authHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify({ html_content: html, source: "edit" }),
      }).catch(() => {});
    } catch (e) {}
  }

  async list() {
    const r = await fetch(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions`, {
      headers: authHeader(),
    });
    return (await r.json()).items || [];
  }

  async restore(version, onRestore) {
    const r = await fetch(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions/${version}`, {
      headers: authHeader(),
    });
    const raw = await r.text();
    const cleaned = sanitizeHTML(raw);
    this.iDoc.open();
    this.iDoc.write(cleaned);
    this.iDoc.close();
    if (onRestore) onRestore();
  }
}
