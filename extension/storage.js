// storage.js — IndexedDB 封装(annotations + versions)
const DB_NAME = "htmlgenius";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("annotations")) {
        const s = db.createObjectStore("annotations", { keyPath: "id" });
        s.createIndex("document_id", "document_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("versions")) {
        const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
        v.createIndex("document_id", "document_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res(value);
    tx.onerror = () => rej(tx.error);
  });
}

async function dbGetAllByIndex(store, indexName, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).index(indexName).getAll(value);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

// 本地 IndexedDB 实现(原 Storage 对象,行为保持完全一致 —— 仅重命名)
const LocalStore = {
  async getDocumentId() {
    return location.origin + location.pathname;
  },
  async saveAnnotation(ann) {
    ann.id = ann.id || "ann_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    ann.document_id = ann.document_id || await this.getDocumentId();
    ann.created_at = ann.created_at || new Date().toISOString();
    ann.status = ann.status || "open";
    return dbPut("annotations", ann);
  },
  async listAnnotations(docId) {
    return dbGetAllByIndex("annotations", "document_id", docId);
  },
  async deleteAnnotation(id) {
    return dbDelete("annotations", id);
  },
  async saveVersion(docId, html) {
    return dbPut("versions", { document_id: docId, html_content: html, created_at: new Date().toISOString(), source: "edit" });
  },
  async listVersions(docId) {
    return dbGetAllByIndex("versions", "document_id", docId);
  },
};

// === mode 分派器 ===
// 默认 _store = LocalStore(未调用 configure 时零回归)。
// configure({mode:"synced", ...}) 切到 RemoteStore 做注解四件套;
// 版本(saveVersion/listVersions)始终走 LocalStore —— 版本不同步(B1 范围)。
let _store = LocalStore;
const Storage = {
  configure(cfg) {
    if (cfg && cfg.mode === "synced" && window.RemoteStore) {
      _store = window.RemoteStore.make(cfg);
    } else {
      _store = LocalStore;
    }
  },
  getDocumentId() { return _store.getDocumentId(); },
  saveAnnotation(a) { return _store.saveAnnotation(a); },
  listAnnotations(d) { return _store.listAnnotations(d); },
  deleteAnnotation(id) { return _store.deleteAnnotation(id); },
  // 版本永远本地(IndexedDB),与 mode 无关
  saveVersion(docId, html) { return LocalStore.saveVersion(docId, html); },
  listVersions(docId) { return LocalStore.listVersions(docId); },
};
window.Storage = Storage;
