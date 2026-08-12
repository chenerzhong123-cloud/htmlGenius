// storage.js — IndexedDB 封装(annotations + legacy versions + artifact versions + bridge sessions/runs)
// 用 globalThis(而非 window)以兼容 background service worker(无 window);在 content-script/sidepanel globalThis===window,行为不变。
const DB_NAME = "htmlgenius";
const DB_VERSION = 6;

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
      if (!db.objectStoreNames.contains("documents")) {
        const d = db.createObjectStore("documents", { keyPath: "logical_document_id" });
        d.createIndex("canonical_uri", "canonical_uri", { unique: false });
      }
      if (!db.objectStoreNames.contains("artifact_versions")) {
        const a = db.createObjectStore("artifact_versions", { keyPath: "id", autoIncrement: true });
        a.createIndex("logical_document_id", "logical_document_id", { unique: false });
        a.createIndex("artifact_hash", "artifact_hash", { unique: false });
      }
      // v0.7.1 (DB v4): bridge schema 升级为 provider-neutral(spec §5)——
      // bridge_sessions 主键改为 "<logical_document_id>:<provider>" 复合 key(+logical_document_id/provider 索引);
      // bridge_runs 增补 status 索引。v3(Codex 时代)的 session/run 记录直接作废:
      // 删 store 重建(本地、临时、仅传输证据,无用户内容损失)。
      if (e.oldVersion < 4) {
        if (db.objectStoreNames.contains("bridge_sessions")) db.deleteObjectStore("bridge_sessions");
        if (db.objectStoreNames.contains("bridge_runs")) db.deleteObjectStore("bridge_runs");
      }
      if (!db.objectStoreNames.contains("bridge_sessions")) {
        const bs = db.createObjectStore("bridge_sessions", { keyPath: "key" });
        bs.createIndex("logical_document_id", "logical_document_id", { unique: false });
        bs.createIndex("provider", "provider", { unique: false });
      }
      if (!db.objectStoreNames.contains("bridge_runs")) {
        const br = db.createObjectStore("bridge_runs", { keyPath: "run_id" });
        br.createIndex("logical_document_id", "logical_document_id", { unique: false });
        br.createIndex("tab_id", "tab_id", { unique: false });
        br.createIndex("status", "status", { unique: false });
      }
      // v0.8.1 (DB v5): plan-first bridge(spec §5.5)——新增 bridge_plans(只新增,不删 session/run)。
      // 记录受控 plan(用户可编辑副本);不存 Agent stdout/完整 prompt/HTML/思维链。
      if (!db.objectStoreNames.contains("bridge_plans")) {
        const bp = db.createObjectStore("bridge_plans", { keyPath: "plan_id" });
        bp.createIndex("logical_document_id", "logical_document_id", { unique: false });
        bp.createIndex("tab_id", "tab_id", { unique: false });
        bp.createIndex("status", "status", { unique: false });
        bp.createIndex("plan_run_id", "plan_run_id", { unique: false });
      }
      // v0.9.x (DB v6):诊断队列 —— background 在 run 终态(failed/no_change)捕获的诊断记录。
      // 留最近 N 条(默认 10);sidepanel 报告浮层读它(支持关 sidepanel 后重开仍可上报)。
      // 不存 token/密钥;agent_stream 可能含页面内容(用户上报前可审视)。
      if (!db.objectStoreNames.contains("bridge_diagnostics")) {
        const bd = db.createObjectStore("bridge_diagnostics", { keyPath: "id", autoIncrement: true });
        bd.createIndex("at", "at", { unique: false });
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

// SUP-7:单事务原子读改写 —— 把 get + 合并 + put 放进同一个 readwrite 事务,
// 避免跨事务「读-改-写」在并发更新下 last-write-wins 丢字段。
// mutator(current) 返回要写回的对象;返回 undefined 表示不写(记录不存在等),此时 resolve(null)。
async function dbUpdate(store, key, mutator) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    const req = os.get(key);
    req.onsuccess = () => {
      const next = mutator(req.result || null);
      if (next === undefined || next === null) { tx.oncomplete = () => res(null); return; }
      os.put(next);
      tx.oncomplete = () => res(next);
    };
    req.onerror = () => rej(req.error);
    tx.onerror = () => rej(tx.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
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

function canonicalArtifactUri(uri) {
  const value = String(uri || "");
  try { const u = new URL(value); u.hash = ""; return u.href; } catch (e) { return value.split("#")[0]; }
}
function legacyDocumentIdForUri(uri) {
  try { const u = new URL(uri); return u.origin + u.pathname; } catch (e) { return String(uri || "").split("#")[0]; }
}

function isManagedLocalUri(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === "file:" || ["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname);
  } catch (e) { return false; }
}

function newLogicalDocumentId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return "hgd_" + globalThis.crypto.randomUUID();
  return "hgd_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
}

async function getDocumentByUri(uri) {
  const canonical = canonicalArtifactUri(uri);
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("documents", "readonly");
    const req = tx.objectStore("documents").getAll();
    req.onsuccess = () => res((req.result || []).find((doc) => doc.canonical_uri === canonical || (doc.known_uris || []).includes(canonical)) || null);
    req.onerror = () => rej(req.error);
  });
}

async function migrateLegacyAnnotations(logicalDocumentId, uri) {
  const legacyId = legacyDocumentIdForUri(uri);
  if (legacyId === logicalDocumentId) return;
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("annotations", "readwrite");
    const store = tx.objectStore("annotations");
    const req = store.index("document_id").getAll(legacyId);
    req.onsuccess = () => (req.result || []).forEach((ann) => {
      // put 覆盖原记录，幂等且不复制回复、selector 或 id。
      ann.document_id = logicalDocumentId;
      store.put(ann);
    });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// 本地 IndexedDB 实现(原 Storage 对象,行为保持完全一致 —— 仅重命名)
const LocalStore = {
  async getDocumentId(uri) {
    const value = canonicalArtifactUri(uri || location.href);
    if (!isManagedLocalUri(value)) return legacyDocumentIdForUri(value);
    return (await this.getOrCreateLocalDocument(value)).logical_document_id;
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
  async updateAnnotation(id, bodyPatch) {
    // 按 id 读出 → 合并 body → 写回(保留 id / parent_id 回复链 / author / selector)
    // SUP-7:读+合并+写放进单事务,避免并发更新互相覆盖。
    const result = await dbUpdate("annotations", id, (ann) => {
      if (!ann) return undefined;
      ann.body = Object.assign({}, ann.body || {}, bodyPatch);
      return ann;
    });
    return result !== null && result !== undefined;
  },
  async saveVersion(docId, html, baseHash) {
    // base_hash:本次编辑所基于的「原始文件」正文哈希;重开时用它判断磁盘文件是否被外部改动过
    return dbPut("versions", { document_id: docId, html_content: html, created_at: new Date().toISOString(), source: "edit", base_hash: baseHash || null });
  },
  async listVersions(docId) {
    return dbGetAllByIndex("versions", "document_id", docId);
  },
  async getOrCreateLocalDocument(uri) {
    const canonical = canonicalArtifactUri(uri);
    if (!isManagedLocalUri(canonical)) throw new Error("Not a managed local artifact URI");
    const existing = await getDocumentByUri(canonical);
    if (existing) return existing;
    const now = new Date().toISOString();
    const doc = { logical_document_id: newLogicalDocumentId(), canonical_uri: canonical, known_uris: [canonical], created_at: now, updated_at: now };
    await dbPut("documents", doc);
    await migrateLegacyAnnotations(doc.logical_document_id, canonical);
    return doc;
  },
  getDocumentByUri,
  async linkArtifactUri(logicalDocumentId, uri) {
    const canonical = canonicalArtifactUri(uri);
    const doc = await dbGet("documents", logicalDocumentId);
    if (!doc) throw new Error("Unknown logical document");
    if (!isManagedLocalUri(canonical)) throw new Error("Not a managed local artifact URI");
    if (!(doc.known_uris || []).includes(canonical)) doc.known_uris = (doc.known_uris || []).concat(canonical);
    doc.updated_at = new Date().toISOString();
    await dbPut("documents", doc);
    return doc;
  },
  async getLatestArtifactVersion(logicalDocumentId, source) {
    const versions = await dbGetAllByIndex("artifact_versions", "logical_document_id", logicalDocumentId);
    return versions.filter((v) => !source || v.source === source)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0))).pop() || null;
  },
  async getLatestArtifactVersionForUri(logicalDocumentId, uri, source) {
    const canonical = canonicalArtifactUri(uri);
    const versions = await dbGetAllByIndex("artifact_versions", "logical_document_id", logicalDocumentId);
    return versions.filter((v) => v.artifact_uri === canonical && (!source || v.source === source))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || ((a.id || 0) - (b.id || 0))).pop() || null;
  },
  async saveArtifactVersion(record) {
    const now = new Date().toISOString();
    const saved = Object.assign({}, record, { created_at: record.created_at || now });
    await dbPut("artifact_versions", saved);
    return saved;
  },
  async markLatestArtifactVersionExported(logicalDocumentId) {
    const latest = await this.getLatestArtifactVersion(logicalDocumentId, "local_edit");
    if (!latest) return null;
    // SUP-7:对该版本记录的读+标 exported_at+写放进单事务,避免覆盖并发写入的其他字段。
    return dbUpdate("artifact_versions", latest.id, (rec) => {
      if (!rec) return undefined;
      return Object.assign({}, rec, { exported_at: new Date().toISOString() });
    });
  },
  // === v0.7.1 bridge session / run(本地,扩展 IndexedDB;不进 RemoteStore)===
  // 仅按 logical_document_id + provider 读写会话;不提供按 session_id 浏览/导入(§5.1)。
  bridgeSessionKey(logicalDocumentId, provider) { return logicalDocumentId + ":" + provider; },
  async getBridgeSession(logicalDocumentId, provider) {
    return dbGet("bridge_sessions", this.bridgeSessionKey(logicalDocumentId, provider));
  },
  async saveBridgeSession(record) {
    const now = new Date().toISOString();
    const rec = Object.assign({}, record, { updated_at: record.updated_at || now, created_at: record.created_at || now });
    if (!rec.key) rec.key = this.bridgeSessionKey(rec.logical_document_id, rec.provider); // 复合主键自动组装
    return dbPut("bridge_sessions", rec);
  },
  async getBridgeRun(runId) { return dbGet("bridge_runs", runId); },
  async getActiveBridgeRunForTab(tabId) {
    const runs = await dbGetAllByIndex("bridge_runs", "tab_id", tabId);
    // 方向3:awaiting_confirm(patch 预览待用户确认)也算 active —— 审阅期间保持 tab 锁,sidepanel 可感知 pending;
    // 该状态可恢复(预览 edits 已存 run 记录、edits.json 在盘上),故不计入 listActiveBridgeRuns 的「重启即失败」对账。
    return runs.find((r) => r.status === "starting" || r.status === "running" || r.status === "awaiting_confirm") || null;
  },
  // CORE-1:SW 重启对账用 —— 所有未终态(starting/running)的 run。status 索引已建(见 onupgradeneeded)。
  async listActiveBridgeRuns() {
    const starting = await dbGetAllByIndex("bridge_runs", "status", "starting");
    const running = await dbGetAllByIndex("bridge_runs", "status", "running");
    return (starting || []).concat(running || []);
  },
  async saveBridgeRun(record) {
    const rec = Object.assign({}, record, { created_at: record.created_at || new Date().toISOString() });
    return dbPut("bridge_runs", rec);
  },
  async updateBridgeRun(runId, patch) {
    // SUP-7:读+合并+写放进单事务,避免并发 run 状态更新互相覆盖。
    return dbUpdate("bridge_runs", runId, (run) => {
      if (!run) return undefined;
      return Object.assign({}, run, patch);
    });
  },
  // Night Pack A §6:最近一次 completed 的 candidate run(只读 run metadata;不含 prompt/comment/candidate HTML)
  async getLatestCompletedCandidateRun(logicalDocumentId) {
    const runs = await dbGetAllByIndex("bridge_runs", "logical_document_id", logicalDocumentId);
    const cands = (runs || []).filter((r) => r.status === "completed" && r.run_kind === "candidate" && r.candidate_uri);
    if (!cands.length) return null;
    cands.sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
    return cands[0];
  },
  // v0.8.1 bridge_plans(spec §5.5):受控 plan CRUD。长度上限在 background 校验层把关;
  // 不存 Agent stdout/完整 prompt/HTML/思维链。
  async saveBridgePlan(record) {
    const now = new Date().toISOString();
    const rec = Object.assign({}, record, { updated_at: record.updated_at || now, created_at: record.created_at || now });
    return dbPut("bridge_plans", rec);
  },
  async getBridgePlan(planId) { return dbGet("bridge_plans", planId); },
  async updateBridgePlan(planId, patch) {
    // SUP-7:读+合并+写放进单事务,避免并发 plan 更新互相覆盖。
    return dbUpdate("bridge_plans", planId, (plan) => {
      if (!plan) return undefined;
      return Object.assign({}, plan, patch, { updated_at: new Date().toISOString() });
    });
  },
  async markDraftPlansStaleForDocument(logicalDocumentId, exceptPlanId) {
    const plans = await dbGetAllByIndex("bridge_plans", "logical_document_id", logicalDocumentId);
    const updated = [];
    // SUP-8:所有 draft→stale 写入放进同一个 readwrite 事务,中途抛错则整体回滚(全有或全无),
    // 避免原先循环里每次 dbPut 各开事务导致「部分 stale、部分 draft」的不一致。
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction("bridge_plans", "readwrite");
      const os = tx.objectStore("bridge_plans");
      (plans || []).forEach((p) => {
        if (p && p.status === "draft" && p.plan_id !== exceptPlanId) {
          const u = Object.assign({}, p, { status: "stale", updated_at: new Date().toISOString() });
          updated.push(u);
          os.put(u);
        }
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    return updated;
  },
  // === v0.9.x 诊断队列(background 终态捕获:failed / no_change;留最近 N 条)===
  // enqueueDiagnostic 追加一条并修剪到最近 keep 条(id 自增、倒序=最新在前)。
  async enqueueDiagnostic(record, opts) {
    const keep = (opts && opts.keep) || 10;
    const rec = Object.assign({}, record, { at: record.at || new Date().toISOString() });
    await dbPut("bridge_diagnostics", rec);
    try {
      const all = await this.listDiagnostics();
      if (all.length > keep) {
        // all 已按 id 倒序;尾部是最旧,删掉超出的部分。
        for (const s of all.slice(keep)) { try { await dbDelete("bridge_diagnostics", s.id); } catch (_) {} }
      }
    } catch (_) {}
    return rec;
  },
  async listDiagnostics(limit) {
    const db = await openDB();
    const all = await new Promise((res, rej) => {
      const tx = db.transaction("bridge_diagnostics", "readonly");
      const req = tx.objectStore("bridge_diagnostics").getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    all.sort((a, b) => (b.id || 0) - (a.id || 0)); // id 倒序(最新在前)
    return limit ? all.slice(0, limit) : all;
  },
  async clearDiagnostics() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction("bridge_diagnostics", "readwrite");
      tx.objectStore("bridge_diagnostics").clear();
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  },
  async deleteDiagnostic(id) { return dbDelete("bridge_diagnostics", id); },
};

// === mode 分派器 ===
// 默认 _store = LocalStore(未调用 configure 时零回归)。
// configure({mode:"synced", ...}) 切到 RemoteStore 做注解四件套;
// 版本(saveVersion/listVersions)始终走 LocalStore —— 版本不同步(B1 范围)。
let _store = LocalStore;
const Storage = {
  configure(cfg) {
    if (cfg && cfg.mode === "synced" && globalThis.RemoteStore) {
      _store = globalThis.RemoteStore.make(cfg);
    } else {
      _store = LocalStore;
    }
  },
  getDocumentId(uri) { return _store.getDocumentId(uri); },
  saveAnnotation(a) { return _store.saveAnnotation(a); },
  listAnnotations(d) { return _store.listAnnotations(d); },
  deleteAnnotation(id) { return _store.deleteAnnotation(id); },
  updateAnnotation(id, bodyPatch) { return _store.updateAnnotation(id, bodyPatch); },
  // 版本永远本地(IndexedDB),与 mode 无关
  saveVersion(docId, html, baseHash) { return LocalStore.saveVersion(docId, html, baseHash); },
  listVersions(docId) { return LocalStore.listVersions(docId); },
  getOrCreateLocalDocument(uri) { return LocalStore.getOrCreateLocalDocument(uri); },
  getDocumentByUri(uri) { return LocalStore.getDocumentByUri(uri); },
  linkArtifactUri(logicalDocumentId, uri) { return LocalStore.linkArtifactUri(logicalDocumentId, uri); },
  getLatestArtifactVersion(logicalDocumentId, source) { return LocalStore.getLatestArtifactVersion(logicalDocumentId, source); },
  getLatestArtifactVersionForUri(logicalDocumentId, uri, source) { return LocalStore.getLatestArtifactVersionForUri(logicalDocumentId, uri, source); },
  saveArtifactVersion(record) { return LocalStore.saveArtifactVersion(record); },
  markLatestArtifactVersionExported(logicalDocumentId) { return LocalStore.markLatestArtifactVersionExported(logicalDocumentId); },
  // v0.7 bridge:始终本地(LocalStore),与协同 mode 无关
  getBridgeSession(logicalDocumentId, provider) { return LocalStore.getBridgeSession(logicalDocumentId, provider); },
  saveBridgeSession(record) { return LocalStore.saveBridgeSession(record); },
  getBridgeRun(runId) { return LocalStore.getBridgeRun(runId); },
  getActiveBridgeRunForTab(tabId) { return LocalStore.getActiveBridgeRunForTab(tabId); },
  listActiveBridgeRuns() { return LocalStore.listActiveBridgeRuns(); },
  saveBridgeRun(record) { return LocalStore.saveBridgeRun(record); },
  updateBridgeRun(runId, patch) { return LocalStore.updateBridgeRun(runId, patch); },
  // Night Pack A §6:最近一次 completed candidate run。facade 之前漏挂这一行 → background.js:55 报
  // "Storage.getLatestCompletedCandidateRun is not a function"(LocalStore 里早有实现,只是没转发)。
  getLatestCompletedCandidateRun(logicalDocumentId) { return LocalStore.getLatestCompletedCandidateRun(logicalDocumentId); },
  // v0.8.1 bridge_plans(spec §5.5):facade 转发
  saveBridgePlan(record) { return LocalStore.saveBridgePlan(record); },
  getBridgePlan(planId) { return LocalStore.getBridgePlan(planId); },
  updateBridgePlan(planId, patch) { return LocalStore.updateBridgePlan(planId, patch); },
  markDraftPlansStaleForDocument(logicalDocumentId, exceptPlanId) { return LocalStore.markDraftPlansStaleForDocument(logicalDocumentId, exceptPlanId); },
  // v0.9.x 诊断队列:facade 转发(始终本地)
  enqueueDiagnostic(record, opts) { return LocalStore.enqueueDiagnostic(record, opts); },
  listDiagnostics(limit) { return LocalStore.listDiagnostics(limit); },
  clearDiagnostics() { return LocalStore.clearDiagnostics(); },
  deleteDiagnostic(id) { return LocalStore.deleteDiagnostic(id); },
  canonicalArtifactUri,
  isManagedLocalUri,
  legacyDocumentIdForUri,
};
globalThis.Storage = Storage;
