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

const Storage = {
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
