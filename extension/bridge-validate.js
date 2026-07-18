// extension/bridge-validate.js — background completion double-check 的纯函数(§6.3, §12.6)。
// 不碰 chrome/Storage,便于 Node 单测;background service worker 经 importScripts 复用。
// 任何字段不匹配都返回 {ok:false, code:COMPLETION_MISMATCH},绝不发 artifact-update-ready / 不导航。
(function (root) {
  "use strict";
  function parentDirOf(fileUrl) {
    try {
      const u = new URL(fileUrl);
      const path = u.pathname.replace(/\/[^/]*$/, "");
      if (u.protocol === "file:") return "file://" + path; // file: 的 origin 是 "null",用 protocol+path 重建
      return u.origin + path;
    } catch (e) { return ""; }
  }

  // 逐字段比对 host 回送的 completion 与本机 run 记录,并校验 result 落在 source 父目录的 candidate 目录下。
  function validateCompletion(run, completion) {
    if (!run || !completion) return { ok: false, code: "RUN_NOT_FOUND" };
    if (completion.run_id !== run.run_id) return { ok: false, code: "COMPLETION_MISMATCH", field: "run_id" };
    if (completion.logical_document_id !== run.logical_document_id) return { ok: false, code: "COMPLETION_MISMATCH", field: "logical_document_id" };
    if (completion.base_artifact_hash !== run.base_artifact_hash) return { ok: false, code: "COMPLETION_MISMATCH", field: "base_artifact_hash" };
    if (completion.source !== "bridge") return { ok: false, code: "COMPLETION_MISMATCH", field: "source" };
    if (completion.result_kind !== "new_artifact") return { ok: false, code: "COMPLETION_MISMATCH", field: "result_kind" };
    const resultUri = String(completion.result_artifact_uri || "");
    if (!/^file:/i.test(resultUri)) return { ok: false, code: "COMPLETION_MISMATCH", field: "result_artifact_uri" };
    const expectedParent = parentDirOf(run.source_artifact_uri);
    if (!expectedParent || resultUri.indexOf(expectedParent + "/.htmlgenius-candidates/") !== 0) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "result_artifact_uri" };
    }
    return { ok: true, result_artifact_uri: resultUri };
  }

  const api = { validateCompletion, parentDirOf };
  root.BridgeValidate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
