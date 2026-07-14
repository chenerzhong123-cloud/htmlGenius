// remote-store.js — REST 版 Storage(同 storage.js 注解接口)
// 暴露 window.RemoteStore:
//   - make(cfg)            → 实现 {getDocumentId, saveAnnotation, listAnnotations, deleteAnnotation} 的对象
//   - buildCreateRequest   → 纯函数:构造 POST /api/annotations 请求(测试用,不发真实请求)
//   - parseCreate          → 纯函数:解析后端返回的 annotation dict
//   - authHeaders          → 内部工具(导出便于复用/调试)
// 版本(saveVersion/listVersions)永远不在此处 —— 版本不同步(B1 范围),仍走 IndexedDB。
window.RemoteStore = (function () {
  "use strict";

  function authHeaders(cfg) {
    // v0.5: 只发 session token;author 由后端从 session 注入(不再带 X-User 头)
    return {
      "Authorization": "Bearer " + cfg.session_token,
      "Content-Type": "application/json",
    };
  }

  // 纯函数:构造创建批注请求(不发真实 fetch,测试页直接断言其输出)
  function buildCreateRequest(cfg, docId, ann) {
    ann = ann || {};
    return {
      url: cfg.backend + "/api/annotations",
      headers: authHeaders(cfg),
      body: {
        document_id: docId,
        selector: ann.selector,
        quote: ann.quote,
        body: ann.body || { comment: "", action: "rewrite", instruction: "" },
        parent_id: ann.parent_id || null,
      },
    };
  }

  // 纯函数:解析后端返回的 annotation dict(当前契约为透传)
  function parseCreate(json) {
    return json;
  }

  function make(cfg) {
    return {
      async getDocumentId() {
        return location.origin + location.pathname;
      },
      async saveAnnotation(ann) {
        ann = ann || {};
        const docId = ann.document_id || await this.getDocumentId();
        const req = buildCreateRequest(cfg, docId, ann);
        console.log("[hg] RS.save POST", req.url, "headers:", JSON.stringify(req.headers));
        try {
          const r = await fetch(req.url, {
            method: "POST",
            headers: req.headers,
            body: JSON.stringify(req.body),
          });
          console.log("[hg] RS.save resp", r.status);
          if (!r.ok) throw new Error("save failed " + r.status);
          return r.json();
        } catch (e) {
          console.error("[hg] RS.save ERROR:", e.message || e);
          throw e;
        }
      },
      async listAnnotations(docId) {
        const url = cfg.backend + "/api/annotations?document_id=" + encodeURIComponent(docId);
        console.log("[hg] RS.list GET", url);
        try {
          const r = await fetch(url, { headers: authHeaders(cfg) });
          console.log("[hg] RS.list resp", r.status);
          if (!r.ok) throw new Error("list failed " + r.status);
          const j = await r.json();
          return j.items || [];
        } catch (e) {
          console.error("[hg] RS.list ERROR:", e.message || e);
          throw e;
        }
      },
      async deleteAnnotation(id) {
        const url = cfg.backend + "/api/annotations/" + encodeURIComponent(id);
        const r = await fetch(url, { method: "DELETE", headers: authHeaders(cfg) });
        // 403 = 非作者,业务层视为删除未生效但不抛错(返回 false)
        if (!r.ok && r.status !== 403) throw new Error("delete failed " + r.status);
        return r.ok;
      },
      async updateAnnotation(id, bodyPatch) {
        // PATCH /api/annotations/:id {body};作者校验由后端做,403→返回 false(非作者)
        const url = cfg.backend + "/api/annotations/" + encodeURIComponent(id);
        const r = await fetch(url, { method: "PATCH", headers: authHeaders(cfg), body: JSON.stringify({ body: bodyPatch }) });
        if (!r.ok && r.status !== 403) throw new Error("update failed " + r.status);
        return r.ok;
      },
    };
  }

  return { make, buildCreateRequest, parseCreate, authHeaders };
})();
