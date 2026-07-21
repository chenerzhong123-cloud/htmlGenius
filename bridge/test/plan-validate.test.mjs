// bridge/test/plan-validate.test.mjs — v0.8.1 plan-first bridge 纯校验函数测试(spec §9 Storage/Background 最低验收)。
// 覆盖:plan.json v1 schema、plan-ready 逐字段校验(含「绝不跨侧比 hash」)、计划确认 §5.4 全失败码、provider probe cache、probe 结果裁剪。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PV = require("../../extension/plan-validate.js");
const { validatePlanReady, validatePlanSchema, validatePlanConfirmation, makeProviderProbeCache, sanitizeProbeResult, utf8ByteLength } = PV;

const SHA = "sha256:" + "a".repeat(64);
const PSHA = "sha256:" + "c".repeat(64);
const HOST_SHA = "sha256:" + "b".repeat(64); // host 原始字节 hash(绝不与 extension DOM hash 比)

function goodPlan() {
  return { schema_version: 1, summary: "一句话目标", plan_markdown: "1. 改 a\n2. 改 b", out_of_scope: [] };
}
function goodPlanReady(over = {}) {
  return Object.assign({
    run_id: "hgr_1", provider: "claude_code_cli", task_sha256: SHA, logical_document_id: "hgd_1",
    source_uri: "file:///x/y.html", source_sha256_before: HOST_SHA, plan_sha256: PSHA, plan: goodPlan()
  }, over);
}
function goodRun(over = {}) {
  return Object.assign({
    run_id: "hgr_1", provider: "claude_code_cli", task_sha256: SHA, logical_document_id: "hgd_1",
    source_artifact_uri: "file:///x/y.html", base_artifact_hash: "domhash1"
  }, over);
}

// ---------- plan.json v1 schema(§6.3)----------
test("validatePlanSchema:合法结构 → ok", () => {
  assert.equal(validatePlanSchema(goodPlan()).ok, true);
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: "m", out_of_scope: ["a"], kind: "htmlgenius_change_plan" }).ok, true);
});

test("validatePlanSchema:未知字段拒绝", () => {
  const r = validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: "m", out_of_scope: [], secret: "leak" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PLAN_INVALID");
  assert.match(r.field, /unknown_field/);
});

test("validatePlanSchema:summary/plan_markdown 非空 + 长度上限", () => {
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "", plan_markdown: "m", out_of_scope: [] }).ok, false);
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: "", out_of_scope: [] }).ok, false);
  const longSummary = "x".repeat(1025);
  assert.equal(validatePlanSchema({ schema_version: 1, summary: longSummary, plan_markdown: "m", out_of_scope: [] }).ok, false);
  const longMd = "x".repeat(12 * 1024 + 1);
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: longMd, out_of_scope: [] }).ok, false);
});

test("validatePlanSchema:out_of_scope ≤20 条、每条 ≤512 bytes;schema_version 必须 1", () => {
  const many = Array.from({ length: 21 }, () => "x");
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: "m", out_of_scope: many }).ok, false);
  const bigItem = ["x".repeat(513)];
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: "m", out_of_scope: bigItem }).ok, false);
  assert.equal(validatePlanSchema({ schema_version: 2, summary: "s", plan_markdown: "m", out_of_scope: [] }).ok, false);
});

test("validatePlanSchema:UTF-8 字节计数(中文/emoji)", () => {
  // "中" 是 3 bytes;12KiB 上限按字节算
  const md = "中".repeat(4096); // 4096*3 = 12288 = 12KiB → ok
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: md, out_of_scope: [] }).ok, true);
  const mdOver = "中".repeat(4097); // 12291 > 12288 → reject
  assert.equal(validatePlanSchema({ schema_version: 1, summary: "s", plan_markdown: mdOver, out_of_scope: [] }).ok, false);
});

// ---------- plan-ready §5.3 ----------
test("validatePlanReady:字段全匹配 → ok(host source_sha256_before 与 extension DOM hash 不同也不影响)", () => {
  // 关键:host_sha(原始字节)≠ run.base_artifact_hash(DOM 序列化),但绝不比较 → ok
  const v = validatePlanReady(goodRun(), goodPlanReady(), SHA);
  assert.equal(v.ok, true);
  assert.notEqual(HOST_SHA, "domhash1"); // 确认两者确实不同,证明没被偷偷比较
});

test("validatePlanReady:run/task/logical/source_uri 任一不匹配即拒", () => {
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ run_id: "hgr_2" }), SHA).ok, false);
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ provider: "codex_app_server" }), SHA).ok, false);
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ task_sha256: "sha256:" + "f".repeat(64) }), SHA).ok, false);
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ logical_document_id: "hgd_2" }), SHA).ok, false);
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ source_uri: "file:///other.html" }), SHA).ok, false);
});

test("validatePlanReady:recomputed task SHA 不一致即拒", () => {
  const v = validatePlanReady(goodRun(), goodPlanReady(), "sha256:" + "9".repeat(64));
  assert.equal(v.ok, false);
  assert.equal(v.code, "COMPLETION_MISMATCH");
  assert.match(v.field, /recomputed/);
});

test("validatePlanReady:plan_sha256 非法 / plan schema 非法 → PLAN_INVALID", () => {
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ plan_sha256: "notsha" }), SHA).code, "PLAN_INVALID");
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ plan: { schema_version: 1, summary: "s", plan_markdown: "m", out_of_scope: [], leak: 1 } }), SHA).code, "PLAN_INVALID");
});

test("validatePlanReady:当前 tab DOM hash 与 run 起始 hash 不一致 → PLAN_STALE_SOURCE(运行期间 artifact 被改)", () => {
  // currentLoadedHash 与 run.base_artifact_hash 比(同侧可比);host source hash 不参与
  const v = validatePlanReady(goodRun(), goodPlanReady(), SHA, "differentDomHash");
  assert.equal(v.ok, false);
  assert.equal(v.code, "PLAN_STALE_SOURCE");
  assert.equal(v.field, "base_artifact_hash");
  // 一致时 ok
  assert.equal(validatePlanReady(goodRun(), goodPlanReady(), SHA, "domhash1").ok, true);
});

test("validatePlanReady:source URI 的 hash 片段不影响 canonical 比较", () => {
  assert.equal(validatePlanReady(goodRun(), goodPlanReady({ source_uri: "file:///x/y.html#anchor" }), SHA).ok, true);
});

// ---------- 计划确认 §5.4 ----------
function goodPlanRec(over = {}) {
  return Object.assign({
    plan_id: "hgp_1", status: "draft", provider: "claude_code_cli", logical_document_id: "hgd_1", tab_id: 5,
    source_artifact_uri: "file:///x/y.html", base_artifact_hash: "domhash1", task_sha256: SHA, plan_sha256: PSHA
  }, over);
}
function goodCtx(over = {}) {
  return Object.assign({
    provider: "claude_code_cli", logical_document_id: "hgd_1", tab_id: 5, source_artifact_uri: "file:///x/y.html",
    loaded_artifact_hash: "domhash1", task_sha256: SHA, edited_plan_markdown: "用户审核后的计划文本", plan_sha256: PSHA
  }, over);
}

test("validatePlanConfirmation:全部一致 → ok", () => {
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx()).ok, true);
});

test("validatePlanConfirmation:plan 不存在 → PLAN_NOT_FOUND", () => {
  assert.equal(validatePlanConfirmation(null, goodCtx()).code, "PLAN_NOT_FOUND");
});

test("validatePlanConfirmation:status 非 draft(approved/rejected/stale)→ PLAN_ALREADY_USED", () => {
  for (const st of ["approved", "rejected", "stale"]) {
    assert.equal(validatePlanConfirmation(goodPlanRec({ status: st }), goodCtx()).code, "PLAN_ALREADY_USED");
  }
});

test("validatePlanConfirmation:provider 变更 → PLAN_CONTRACT_CHANGED", () => {
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ provider: "codex_app_server" })).code, "PLAN_CONTRACT_CHANGED");
  assert.equal(validatePlanConfirmation(goodPlanRec({ provider: "codex_app_server" }), goodCtx()).code, "PLAN_CONTRACT_CHANGED");
});

test("validatePlanConfirmation:logical_document_id / tab_id / source_uri / base_hash 变更 → PLAN_STALE_SOURCE", () => {
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ logical_document_id: "hgd_2" })).code, "PLAN_STALE_SOURCE");
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ tab_id: 6 })).code, "PLAN_STALE_SOURCE");
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ source_artifact_uri: "file:///other.html" })).code, "PLAN_STALE_SOURCE");
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ loaded_artifact_hash: "changedDomHash" })).code, "PLAN_STALE_SOURCE");
});

test("validatePlanConfirmation:contract SHA 变更 → PLAN_CONTRACT_CHANGED", () => {
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ task_sha256: "sha256:" + "z".repeat(64) })).code, "PLAN_CONTRACT_CHANGED");
});

test("validatePlanConfirmation:edited_plan_markdown 空 / 超长 → PLAN_EDIT_INVALID", () => {
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ edited_plan_markdown: "" })).code, "PLAN_EDIT_INVALID");
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ edited_plan_markdown: null })).code, "PLAN_EDIT_INVALID");
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ edited_plan_markdown: "x".repeat(12 * 1024 + 1) })).code, "PLAN_EDIT_INVALID");
});

test("validatePlanConfirmation:plan_sha256 与存储不一致 → PLAN_INVALID", () => {
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ plan_sha256: "sha256:" + "q".repeat(64) })).code, "PLAN_INVALID");
  assert.equal(validatePlanConfirmation(goodPlanRec(), goodCtx({ plan_sha256: "bad" })).code, "PLAN_INVALID");
});

// ---------- provider probe cache(§5.1)----------
test("makeProviderProbeCache:30s TTL;过期失效;clear 生效", () => {
  let t = 1000;
  const c = makeProviderProbeCache({ ttlMs: 30000, now: () => t });
  assert.equal(c.get(), null);
  c.set({ ok: true, providers: [] });
  assert.deepEqual(c.get(), { ok: true, providers: [] });
  t += 29000;
  assert.deepEqual(c.get(), { ok: true, providers: [] }); // 未过期
  t += 2000; // 累计 31000 > 30000
  assert.equal(c.get(), null); // 过期
  c.set({ ok: true, providers: [{ id: "claude_code_cli" }] });
  c.clear();
  assert.equal(c.get(), null);
});

// ---------- probe 结果裁剪(§3.D / §5.1:不暴露路径/TeamID/stderr/auth)----------
test("sanitizeProbeResult:未知 status 归一 error;缺失 provider 归一 not_found", () => {
  const r = sanitizeProbeResult({ providers: [{ id: "claude_code_cli", status: "ready", version: "1.2.3", capabilities: ["candidate", "plan"] }] });
  // codex 缺失 → not_found
  const codex = r.providers.find((p) => p.id === "codex_app_server");
  assert.equal(codex.status, "not_found");
  const claude = r.providers.find((p) => p.id === "claude_code_cli");
  assert.equal(claude.status, "ready");
  assert.equal(claude.version, "1.2.3");
  assert.deepEqual(claude.capabilities, ["candidate", "plan"]);
});

test("sanitizeProbeResult:version 仅 ready 附;未知 status 归一 error;某一 provider 失败不污染另一", () => {
  const r = sanitizeProbeResult({
    providers: [
      { id: "claude_code_cli", status: "ready", version: "9.9.9", capabilities: [] },
      { id: "codex_app_server", status: "some_unknown_status", version: "leak-stderr-here", capabilities: [] }
    ]
  });
  const claude = r.providers.find((p) => p.id === "claude_code_cli");
  const codex = r.providers.find((p) => p.id === "codex_app_server");
  assert.equal(claude.status, "ready");        // claude 未被 codex 的未知状态污染
  assert.equal(claude.version, "9.9.9");
  assert.equal(codex.status, "error");         // 未知 → error
  assert.equal(codex.version, undefined);      // 非 ready 不附 version(stderr 不可泄漏)
});

test("sanitizeProbeResult:版本摘要截断 ≤64;非白名单 provider 被丢弃", () => {
  const r = sanitizeProbeResult({ providers: [{ id: "claude_code_cli", status: "ready", version: "x".repeat(200) }, { id: "rogue_provider", status: "ready" }] });
  const claude = r.providers.find((p) => p.id === "claude_code_cli");
  assert.equal(claude.version.length, 64);
  assert.equal(r.providers.find((p) => p.id === "rogue_provider"), undefined);
});

test("utf8ByteLength:中文/emoji 按 UTF-8 字节计", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("中"), 3);
  assert.equal(utf8ByteLength("🚀"), 4);
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength(null), 0);
});
