// extension/bridge-validate.js — v0.7.1 handoff completion 的双重校验纯函数(spec §6.2)。
// 不碰 chrome/Storage,便于 Node 单测;background service worker 经 importScripts 复用。
// 任何字段不匹配都返回 {ok:false, code:COMPLETION_MISMATCH} —— 不写 session、不显示成功。
(function (root) {
  "use strict";

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var SHA_RE = /^sha256:[0-9a-f]{64}$/;

  // task_sha256 的唯一算法 —— 与 bridge/task-bundle.mjs 的 canonicalTaskJson + sha256Bytes 完全一致:
  // "sha256:" + hex(sha256(JSON.stringify(task, null, 2) 的 UTF-8 bytes))。
  // background(service worker)用 crypto.subtle(异步)。
  function computeTaskSha256(task) {
    var bytes = new TextEncoder().encode(JSON.stringify(task, null, 2));
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
      return "sha256:" + hex;
    });
  }

  // 逐字段比对 host 回送的 completion 与本机 run 记录(spec §6.2):
  // run_id / task_sha256(同时与 background 自算值对照)/ session_id 合法 UUID。
  function validateHandoffCompletion(run, completion, recomputedTaskSha) {
    if (!run || !completion) return { ok: false, code: "RUN_NOT_FOUND" };
    if (completion.run_id !== run.run_id) return { ok: false, code: "COMPLETION_MISMATCH", field: "run_id" };
    if (typeof completion.task_sha256 !== "string" || !SHA_RE.test(completion.task_sha256)) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "task_sha256" };
    }
    if (completion.task_sha256 !== run.task_sha256) return { ok: false, code: "COMPLETION_MISMATCH", field: "task_sha256" };
    if (recomputedTaskSha && completion.task_sha256 !== recomputedTaskSha) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "task_sha256_recomputed" };
    }
    if (typeof completion.session_id !== "string" || !UUID_RE.test(completion.session_id)) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "session_id" };
    }
    return { ok: true, session_id: completion.session_id, task_sha256: completion.task_sha256 };
  }

  // session 记录的 workspace_path(续发时 host 需要同一 cwd):<source-parent>/.htmlgenius-bridge/claude/<id>。
  function workspacePathForFileUrl(fileUrl, logicalDocumentId) {
    try {
      var u = new URL(fileUrl);
      if (u.protocol !== "file:") return null;
      var dir = decodeURIComponent(u.pathname).replace(/\/[^/]*$/, "");
      return dir + "/.htmlgenius-bridge/claude/" + logicalDocumentId;
    } catch (e) { return null; }
  }

  var api = { computeTaskSha256: computeTaskSha256, validateHandoffCompletion: validateHandoffCompletion, workspacePathForFileUrl: workspacePathForFileUrl };
  root.BridgeValidate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
