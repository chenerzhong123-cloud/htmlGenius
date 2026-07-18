// bridge/test/bridge-validate.test.mjs — background completion double-check 纯函数测试(§12.6)。
// 任一字段不匹配 -> COMPLETION_MISMATCH,绝不发 artifact-update-ready / 不导航。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateCompletion, parentDirOf } = require("../../extension/bridge-validate.js");

const BASE = "sha256:" + "0".repeat(64);
const RESULT = "sha256:" + "1".repeat(64);
const run = {
  run_id: "hgr_1", logical_document_id: "hgd_1",
  source_artifact_uri: "file:///abs/report.html", base_artifact_hash: BASE
};
function goodCompletion(overrides = {}) {
  return Object.assign({
    run_id: "hgr_1", logical_document_id: "hgd_1", thread_id: "thr_1", turn_id: "turn_1",
    source: "bridge", result_kind: "new_artifact",
    base_artifact_hash: BASE, result_artifact_hash: RESULT,
    result_artifact_uri: "file:///abs/.htmlgenius-candidates/hgr_1/result.html"
  }, overrides);
}

test("parentDirOf: file URL 父目录(file: origin=null 特例)", () => {
  assert.equal(parentDirOf("file:///abs/report.html"), "file:///abs");
  assert.equal(parentDirOf("file:///Users/x/sub/r.html"), "file:///Users/x/sub");
});

test("validateCompletion: 全匹配 -> ok", () => {
  const r = validateCompletion(run, goodCompletion());
  assert.equal(r.ok, true);
  assert.equal(r.result_artifact_uri, "file:///abs/.htmlgenius-candidates/hgr_1/result.html");
});

test("validateCompletion: 伪造 run_id -> COMPLETION_MISMATCH(run_id)", () => {
  assert.equal(validateCompletion(run, goodCompletion({ run_id: "hgr_evil" })).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: 伪造 base hash -> COMPLETION_MISMATCH", () => {
  assert.equal(validateCompletion(run, goodCompletion({ base_artifact_hash: "sha256:" + "9".repeat(64) })).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: 伪造 logical_document_id -> COMPLETION_MISMATCH", () => {
  assert.equal(validateCompletion(run, goodCompletion({ logical_document_id: "hgd_evil" })).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: source != bridge -> COMPLETION_MISMATCH", () => {
  assert.equal(validateCompletion(run, goodCompletion({ source: "agent" })).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: result_kind != new_artifact -> COMPLETION_MISMATCH", () => {
  assert.equal(validateCompletion(run, goodCompletion({ result_kind: "overwrite" })).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: result_artifact_uri 逃逸 candidate 目录 -> COMPLETION_MISMATCH", () => {
  // 试图指向源文件本身(覆盖原文件)/ 任意路径
  assert.equal(validateCompletion(run, goodCompletion({ result_artifact_uri: "file:///abs/report.html" })).code, "COMPLETION_MISMATCH");
  assert.equal(validateCompletion(run, goodCompletion({ result_artifact_uri: "file:///etc/passwd" })).code, "COMPLETION_MISMATCH");
  assert.equal(validateCompletion(run, goodCompletion({ result_artifact_uri: "https://evil/x.html" })).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: 非 file: source(run.source_artifact_uri)仍安全(空 parent)", () => {
  const httpRun = Object.assign({}, run, { source_artifact_uri: "https://site/r.html" });
  assert.equal(validateCompletion(httpRun, goodCompletion()).code, "COMPLETION_MISMATCH");
});

test("validateCompletion: 不同 source 父目录的 candidate 也不认(防跨目录)", () => {
  // candidate 在别的目录树下
  assert.equal(validateCompletion(run, goodCompletion({ result_artifact_uri: "file:///other/.htmlgenius-candidates/hgr_1/result.html" })).code, "COMPLETION_MISMATCH");
});
