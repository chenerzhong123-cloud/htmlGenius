// version.js — 版本管理:防抖/定时自动存 + 列表 + 还原(sanitize)
import { serializeDoc } from "./serialize.js";
import { sanitizeHTML } from "./sanitize.js";

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html_content: html, source: "edit" }),
      });
    } catch (e) {
      this.dirty = true;  // 失败重试
    }
  }

  flushSync() {
    // beforeunload 不能等 async:用 sendBeacon
    if (!this.dirty) return;
    this.dirty = false;
    const html = serializeDoc(this.iDoc);
    const blob = new Blob([JSON.stringify({ html_content: html, source: "edit" })], { type: "application/json" });
    navigator.sendBeacon(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions`, blob);
  }

  async list() {
    const r = await fetch(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions`);
    return (await r.json()).items || [];
  }

  async restore(version, onRestore) {
    const r = await fetch(`${this.api}/documents/${encodeURIComponent(this.docId)}/versions/${version}`);
    const raw = await r.text();
    const cleaned = sanitizeHTML(raw);
    this.iDoc.open();
    this.iDoc.write(cleaned);
    this.iDoc.close();
    if (onRestore) onRestore();
  }
}
