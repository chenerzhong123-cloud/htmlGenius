// extension/plan-validate.js — v0.8.1 plan-first bridge 的纯校验函数(spec §5.3 plan-ready / §5.4 计划确认 / §5.1 probe cache / §6.3 plan.json v1)。
// 不碰 chrome/Storage,便于 Node 单测;background service worker 经 importScripts 复用(与 bridge-validate.js 同风格:IIFE + globalThis + CommonJS)。
// 关键不变量(spec §5.3「Hash 规则不可简化」):host 的 source_sha256_before(原始文件字节)与 extension 的 base_artifact_hash(DOM 序列化)
// 永远不能直接相等比较 —— 两者都可作为证据记录,但绝不能跨侧比对,否则所有正常 plan 都被误判失败。
(function (root) {
  "use strict";

  var SHA_RE = /^sha256:[0-9a-f]{64}$/;
  var PROVIDER_RE = /^(claude_code_cli|codex_app_server)$/;
  var PLAN_MAX_MARKDOWN_BYTES = 12 * 1024;
  var PLAN_MAX_SUMMARY_BYTES = 1024;
  var PLAN_MAX_OUT_OF_SCOPE = 20;
  var PLAN_MAX_OOS_ITEM_BYTES = 512;

  function utf8ByteLength(s) {
    return new TextEncoder().encode(String(s == null ? "" : s)).length;
  }

  // file URL canonical(去 hash 片段);与 storage.canonicalArtifactUri 同语义,但本模块不依赖 storage。
  function _canonical(u) {
    var v = String(u || "");
    try { var url = new URL(v); url.hash = ""; return url.href; }
    catch (e) { return v.split("#")[0]; }
  }

  // plan.json v1 字段白名单 + 长度上限(spec §6.3)。未知字段 / 超长 / 缺字段 → PLAN_INVALID。
  var PLAN_FIELD_WHITELIST = { schema_version: 1, kind: 1, summary: 1, plan_markdown: 1, out_of_scope: 1 };

  function validatePlanSchema(plan) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      return { ok: false, code: "PLAN_INVALID", field: "plan" };
    }
    for (var k in plan) {
      if (!Object.prototype.hasOwnProperty.call(plan, k)) continue;
      if (!PLAN_FIELD_WHITELIST[k]) return { ok: false, code: "PLAN_INVALID", field: "plan.unknown_field:" + k };
    }
    if (plan.schema_version !== 1) return { ok: false, code: "PLAN_INVALID", field: "schema_version" };
    if (typeof plan.summary !== "string" || !plan.summary || utf8ByteLength(plan.summary) > PLAN_MAX_SUMMARY_BYTES) {
      return { ok: false, code: "PLAN_INVALID", field: "summary" };
    }
    if (typeof plan.plan_markdown !== "string" || !plan.plan_markdown || utf8ByteLength(plan.plan_markdown) > PLAN_MAX_MARKDOWN_BYTES) {
      return { ok: false, code: "PLAN_INVALID", field: "plan_markdown" };
    }
    var oos = plan.out_of_scope;
    if (!Array.isArray(oos) || oos.length > PLAN_MAX_OUT_OF_SCOPE) return { ok: false, code: "PLAN_INVALID", field: "out_of_scope" };
    for (var i = 0; i < oos.length; i++) {
      if (typeof oos[i] !== "string" || utf8ByteLength(oos[i]) > PLAN_MAX_OOS_ITEM_BYTES) {
        return { ok: false, code: "PLAN_INVALID", field: "out_of_scope[" + i + "]" };
      }
    }
    return { ok: true };
  }

  // §5.3:plan-ready 逐字段校验。host 回送 vs background 自存 run 记录。
  //   run:{ run_id, provider, task_sha256, logical_document_id, source_artifact_uri, base_artifact_hash }
  //   planReady:{ run_id, provider?, task_sha256, logical_document_id, source_uri, source_sha256_before, plan_sha256, plan }
  //   recomputedTaskSha:background 自算 task SHA(可选;与 planReady.task_sha256 对照)。
  //   currentLoadedHash:plan-ready 时当前 tab 的 DOM hash(可选;与 run.base_artifact_hash 对照 —— 同侧可比)。
  // 注意:source_sha256_before(host 原始字节 hash)绝不参与比较,只作为证据由 background 落库。
  function validatePlanReady(run, planReady, recomputedTaskSha, currentLoadedHash) {
    if (!run || !planReady) return { ok: false, code: "RUN_NOT_FOUND" };
    if (planReady.run_id !== run.run_id) return { ok: false, code: "COMPLETION_MISMATCH", field: "run_id" };
    if (planReady.provider && planReady.provider !== run.provider) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "provider" };
    }
    if (typeof planReady.task_sha256 !== "string" || !SHA_RE.test(planReady.task_sha256)) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "task_sha256" };
    }
    if (planReady.task_sha256 !== run.task_sha256) return { ok: false, code: "COMPLETION_MISMATCH", field: "task_sha256" };
    if (recomputedTaskSha && planReady.task_sha256 !== recomputedTaskSha) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "task_sha256_recomputed" };
    }
    if (planReady.logical_document_id !== run.logical_document_id) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "logical_document_id" };
    }
    // source URI:同为 extension 侧 file URL,canonical 后可比(防 hash 片段假阴性)
    if (_canonical(planReady.source_uri) !== _canonical(run.source_artifact_uri)) {
      return { ok: false, code: "COMPLETION_MISMATCH", field: "source_uri" };
    }
    // 当前 tab DOM hash 与 run 起始 hash(同侧可比);若不一致说明运行期间 artifact 被改 → plan 作废
    if (typeof currentLoadedHash === "string" && currentLoadedHash && run.base_artifact_hash &&
        currentLoadedHash !== run.base_artifact_hash) {
      return { ok: false, code: "PLAN_STALE_SOURCE", field: "base_artifact_hash" };
    }
    if (typeof planReady.plan_sha256 !== "string" || !SHA_RE.test(planReady.plan_sha256)) {
      return { ok: false, code: "PLAN_INVALID", field: "plan_sha256" };
    }
    var pv = validatePlanSchema(planReady.plan);
    if (!pv.ok) return pv;
    return { ok: true };
  }

  // §5.4:candidate 携带 plan 时的确认校验(launch native host 前调用)。
  //   planRec:Storage.getBridgePlan(plan_id) 结果(扩展侧持久化的受控计划)。
  //   ctx:{ provider, logical_document_id, tab_id, source_artifact_uri(canonical), loaded_artifact_hash,
  //          task_sha256, edited_plan_markdown, plan_sha256 }
  function validatePlanConfirmation(planRec, ctx) {
    if (!planRec) return { ok: false, code: "PLAN_NOT_FOUND" };
    if (planRec.status !== "draft") return { ok: false, code: "PLAN_ALREADY_USED", field: "status:" + planRec.status };
    if (!ctx || !PROVIDER_RE.test(ctx.provider)) return { ok: false, code: "PLAN_CONTRACT_CHANGED", field: "provider" };
    if (planRec.provider !== ctx.provider) return { ok: false, code: "PLAN_CONTRACT_CHANGED", field: "provider" };
    if (planRec.logical_document_id !== ctx.logical_document_id) {
      return { ok: false, code: "PLAN_STALE_SOURCE", field: "logical_document_id" };
    }
    if (planRec.tab_id !== ctx.tab_id) return { ok: false, code: "PLAN_STALE_SOURCE", field: "tab_id" };
    // artifact URI(canonical)+ extension DOM hash:均为同侧值,可比;host 的 host_source_sha256_before 不在此比
    if (_canonical(planRec.source_artifact_uri) !== _canonical(ctx.source_artifact_uri)) {
      return { ok: false, code: "PLAN_STALE_SOURCE", field: "source_artifact_uri" };
    }
    if (planRec.base_artifact_hash !== ctx.loaded_artifact_hash) {
      return { ok: false, code: "PLAN_STALE_SOURCE", field: "base_artifact_hash" };
    }
    if (planRec.task_sha256 !== ctx.task_sha256) return { ok: false, code: "PLAN_CONTRACT_CHANGED", field: "task_sha256" };
    // plan_sha256:消息携带的必须与存储原 SHA(host 算的不可编辑原计划)一致
    if (typeof ctx.plan_sha256 !== "string" || !SHA_RE.test(ctx.plan_sha256)) {
      return { ok: false, code: "PLAN_INVALID", field: "plan_sha256" };
    }
    if (planRec.plan_sha256 !== ctx.plan_sha256) return { ok: false, code: "PLAN_INVALID", field: "plan_sha256_mismatch" };
    // edited_plan_markdown:非空 + ≤12KiB(用户可见且已审核的文本)
    var edited = ctx.edited_plan_markdown;
    if (typeof edited !== "string" || !edited) return { ok: false, code: "PLAN_EDIT_INVALID", field: "empty" };
    if (utf8ByteLength(edited) > PLAN_MAX_MARKDOWN_BYTES) return { ok: false, code: "PLAN_EDIT_INVALID", field: "too_long" };
    return { ok: true };
  }

  // §5.1:provider probe cache。30s TTL;成功与失败结果都缓存(失败也缓存,避免频繁重探)。
  // opts.ttlMs(默认 30000)、opts.now(注入时钟,便于单测)。
  function makeProviderProbeCache(opts) {
    opts = opts || {};
    var ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : 30000;
    var nowFn = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };
    var entry = null; // { result, expiresAt }
    return {
      get: function () {
        if (!entry) return null;
        if (nowFn() > entry.expiresAt) { entry = null; return null; }
        return entry.result;
      },
      set: function (result) { entry = { result: result, expiresAt: nowFn() + ttlMs }; },
      clear: function () { entry = null; }
    };
  }

  // 把 host probe 结果裁剪成 UI 安全的 providers 数组(spec §3.D/§5.1:绝不返回 runtime 路径/TeamID/schema 路径/stderr/认证)。
  // hostResult:{ providers: [{ id, label?, status, version?, capabilities? }] }
  // 返回 { providers: [{ id, label, status, capabilities, version? }] } —— 缺失 provider 归一为 not_found;未知 status 归一为 error。
  var _PROBE_LABELS = { claude_code_cli: "Claude Code", codex_app_server: "Codex" };
  var _PROBE_VALID_STATUS = { ready: 1, checking: 1, not_installed: 1, not_found: 1, auth_required: 1, incompatible: 1, untrusted: 1, error: 1 };

  function sanitizeProbeResult(hostResult) {
    var providers = (hostResult && Array.isArray(hostResult.providers)) ? hostResult.providers : [];
    var out = [];
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i] || {};
      if (!PROVIDER_RE.test(p.id)) continue;
      var status = _PROBE_VALID_STATUS[p.status] ? p.status : "error";
      var rec = {
        id: p.id,
        label: _PROBE_LABELS[p.id] || p.label || p.id,
        status: status,
        capabilities: Array.isArray(p.capabilities) ? p.capabilities.slice() : []
      };
      // 仅 ready 时附简短版本摘要(截断,非完整 stderr/路径)
      if (status === "ready" && typeof p.version === "string" && p.version) {
        rec.version = String(p.version).slice(0, 64);
      }
      out.push(rec);
    }
    // 保证两个 provider 都出现(缺失归一为 not_found)——某一 provider 探测失败不污染另一 provider 的结果
    for (var id in _PROBE_LABELS) {
      if (!Object.prototype.hasOwnProperty.call(_PROBE_LABELS, id)) continue;
      var exists = false;
      for (var j = 0; j < out.length; j++) { if (out[j].id === id) { exists = true; break; } }
      if (!exists) out.push({ id: id, label: _PROBE_LABELS[id], status: "not_found", capabilities: [] });
    }
    return { providers: out };
  }

  var api = {
    validatePlanReady: validatePlanReady,
    validatePlanSchema: validatePlanSchema,
    validatePlanConfirmation: validatePlanConfirmation,
    makeProviderProbeCache: makeProviderProbeCache,
    sanitizeProbeResult: sanitizeProbeResult,
    utf8ByteLength: utf8ByteLength,
    PLAN_MAX_MARKDOWN_BYTES: PLAN_MAX_MARKDOWN_BYTES
  };
  root.PlanValidate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
