// bridge/test/host-runner.test.mjs — start_run 编排测试(§12.3/12.4)。用 fake app-server + 注入 spawnClient/emit。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { AppServerClient } from "../app-server-client.mjs";
import { executeStartRun } from "../host-runner.mjs";
import { sha256File } from "../run-manager.mjs";

const require = createRequire(import.meta.url);
const CC = require("../../extension/change-contract.js");
const fakePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-app-server.mjs");

const SRC_HTML = "<!doctype html><html><head><title>report</title></head><body><p>原文一</p></body></html>";

function makeSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-host-"));
  const p = path.join(dir, "report.html");
  fs.writeFileSync(p, SRC_HTML);
  return { dir, p, uri: pathToFileURL(p).href, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}
function makeTask(mode, anns = [{ id: "a1", parent_id: null, quote: "原文一", selector: { exact: "原文一" }, body: { comment: "改短" }, author: { name: "Z" } }]) {
  return CC.buildTask({
    mode, rootIds: ["a1"], brief: "请把这段内容改短,语气更直接一些", preserveText: "公司名",
    artifact: { title: "report", url: "file:///tmp/report.html", isLocal: true }
  }, anns);
}
function makeSpawnClient(mode, { write = true } = {}) {
  return () => {
    const c = new AppServerClient({
      command: [process.execPath, fakePath],
      env: { ...process.env, HG_FAKE_MODE: mode, HG_FAKE_DELAY: 10, HG_FAKE_WRITE_RESULT: write ? "1" : "0" }
    });
    return c;
  };
}

test("executeStartRun(new): 全流程成功 -> thread_created/turn_started/completed;source hash 不变", async () => {
  const src = makeSource();
  try {
    const base = sha256File(src.p);
    const emits = [];
    await executeStartRun({
      type: "start_run", request_id: "hgr_test1",
      source: { artifact_uri: src.uri, logical_document_id: "hgd_1", base_artifact_hash: base },
      execution: { provider: "codex_app_server", session_mode: "new", thread_id: null, mode: "precise_patch" },
      change_contract: makeTask("precise_patch")
    }, { spawnClient: makeSpawnClient("normal"), emit: (p) => emits.push(p) });

    const types = emits.map((e) => e.type);
    assert.ok(types.includes("bridge_thread_created"), "应发 bridge_thread_created");
    assert.ok(types.includes("bridge_turn_started"), "应发 bridge_turn_started");
    const completed = emits.find((e) => e.type === "bridge_completed");
    assert.ok(completed, "应发 bridge_completed");
    assert.equal(completed.result_kind, "new_artifact");
    assert.equal(completed.base_artifact_hash, base);
    assert.notEqual(completed.result_artifact_hash, base);
    assert.match(completed.result_artifact_uri, /^file:\/.+result\.html$/);
    assert.equal(completed.logical_document_id, "hgd_1");
    // 关键不变量:source 字节哈希 run 后未变
    assert.equal(sha256File(src.p), base);
  } finally { src.cleanup(); }
});

test("executeStartRun: base 不一致 -> bridge_failed SOURCE_CHANGED_BEFORE_START,不发 thread/turn", async () => {
  const src = makeSource();
  try {
    const emits = [];
    await executeStartRun({
      type: "start_run", request_id: "hgr_changed",
      source: { artifact_uri: src.uri, logical_document_id: "hgd_1", base_artifact_hash: "sha256:wrong" },
      execution: { provider: "codex_app_server", session_mode: "new", mode: "precise_patch" },
      change_contract: makeTask("precise_patch")
    }, { spawnClient: makeSpawnClient("normal"), emit: (p) => emits.push(p) });
    const types = emits.map((e) => e.type);
    assert.ok(!types.includes("bridge_thread_created"), "base 不一致不应建 thread");
    const failed = emits.find((e) => e.type === "bridge_failed");
    assert.ok(failed);
    assert.equal(failed.code, "SOURCE_CHANGED_BEFORE_START");
  } finally { src.cleanup(); }
});

test("executeStartRun: turn 失败 -> bridge_failed TURN_FAILED", async () => {
  const src = makeSource();
  try {
    const base = sha256File(src.p);
    const emits = [];
    await executeStartRun({
      type: "start_run", request_id: "hgr_fail",
      source: { artifact_uri: src.uri, logical_document_id: "hgd_1", base_artifact_hash: base },
      execution: { provider: "codex_app_server", session_mode: "new", mode: "local_optimize" },
      change_contract: makeTask("local_optimize")
    }, { spawnClient: makeSpawnClient("turn_failed"), emit: (p) => emits.push(p) });
    const failed = emits.find((e) => e.type === "bridge_failed");
    assert.ok(failed);
    assert.equal(failed.code, "TURN_FAILED");
  } finally { src.cleanup(); }
});

test("executeStartRun: Codex 未写 result -> bridge_failed NO_RESULT", async () => {
  const src = makeSource();
  try {
    const base = sha256File(src.p);
    const emits = [];
    await executeStartRun({
      type: "start_run", request_id: "hgr_noresult",
      source: { artifact_uri: src.uri, logical_document_id: "hgd_1", base_artifact_hash: base },
      execution: { provider: "codex_app_server", session_mode: "new", mode: "regenerate" },
      change_contract: makeTask("regenerate")
    }, { spawnClient: makeSpawnClient("normal", { write: false }), emit: (p) => emits.push(p) });
    const failed = emits.find((e) => e.type === "bridge_failed");
    assert.ok(failed);
    assert.equal(failed.code, "NO_RESULT");
  } finally { src.cleanup(); }
});

test("executeStartRun(continue): 用提供的 thread_id 走 thread/resume,不发 thread_created", async () => {
  const src = makeSource();
  try {
    const base = sha256File(src.p);
    const emits = [];
    await executeStartRun({
      type: "start_run", request_id: "hgr_cont",
      source: { artifact_uri: src.uri, logical_document_id: "hgd_1", base_artifact_hash: base },
      execution: { provider: "codex_app_server", session_mode: "continue", thread_id: "thr_saved_xyz", mode: "precise_patch" },
      change_contract: makeTask("precise_patch")
    }, { spawnClient: makeSpawnClient("normal"), emit: (p) => emits.push(p) });
    const types = emits.map((e) => e.type);
    assert.ok(!types.includes("bridge_thread_created"), "continue 不应发 thread_created");
    assert.ok(types.includes("bridge_completed"), "仍应完成");
    const completed = emits.find((e) => e.type === "bridge_completed");
    assert.equal(completed.thread_id, "thr_saved_xyz");
  } finally { src.cleanup(); }
});

test("executeStartRun: restructure -> 立即 bridge_failed INVALID_MODE(防御)", async () => {
  const src = makeSource();
  try {
    const emits = [];
    await executeStartRun({
      type: "start_run", request_id: "hgr_restr",
      source: { artifact_uri: src.uri, logical_document_id: "hgd_1", base_artifact_hash: sha256File(src.p) },
      execution: { provider: "codex_app_server", session_mode: "new", mode: "restructure" },
      change_contract: { mode: "restructure" }
    }, { spawnClient: makeSpawnClient("normal"), emit: (p) => emits.push(p) });
    const failed = emits.find((e) => e.type === "bridge_failed");
    assert.ok(failed);
    assert.equal(failed.code, "INVALID_MODE");
  } finally { src.cleanup(); }
});
