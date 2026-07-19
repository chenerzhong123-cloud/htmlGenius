// bridge/test/bridge-validate.test.mjs — background completion 双重校验纯函数测试(v0.7.1)。
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeTaskSha256, validateHandoffCompletion, workspacePathForFileUrl } = require("../../extension/bridge-validate.js");

const UUID = "11111111-2222-3333-4444-555555555555";
function sha(json2) { return "sha256:" + crypto.createHash("sha256").update(Buffer.from(json2, "utf8")).digest("hex"); }

test("computeTaskSha256:与 host 的 canonical 算法一致(sha256 of JSON.stringify(task,null,2))", async () => {
  const task = { schema_version: 1, kind: "htmlgenius_change_contract", mode: "precise_patch", brief: "x" };
  const expected = sha(JSON.stringify(task, null, 2));
  assert.equal(await computeTaskSha256(task), expected);
  // 中文/emoji 的 UTF-8 字节一致
  const t2 = { brief: "中文 emoji 🚀" };
  assert.equal(await computeTaskSha256(t2), sha(JSON.stringify(t2, null, 2)));
});

test("validateHandoffCompletion:字段全匹配 → ok", () => {
  const run = { run_id: "hgr_1", task_sha256: "sha256:" + "a".repeat(64) };
  const completion = { run_id: "hgr_1", session_id: UUID, task_sha256: run.task_sha256 };
  const v = validateHandoffCompletion(run, completion, run.task_sha256);
  assert.deepEqual(v, { ok: true, session_id: UUID, task_sha256: run.task_sha256 });
});

test("validateHandoffCompletion:任一字段不匹配即拒(绝不放行)", () => {
  const taskSha = "sha256:" + "a".repeat(64);
  const run = { run_id: "hgr_1", task_sha256: taskSha };
  // run_id 不符
  assert.equal(validateHandoffCompletion(run, { run_id: "hgr_2", session_id: UUID, task_sha256: taskSha }).code, "COMPLETION_MISMATCH");
  // task_sha256 与 run 记录不符
  assert.equal(validateHandoffCompletion(run, { run_id: "hgr_1", session_id: UUID, task_sha256: "sha256:" + "b".repeat(64) }).code, "COMPLETION_MISMATCH");
  // task_sha256 与 background 自算值不符(即便与 run 记录一致)
  assert.equal(validateHandoffCompletion(run, { run_id: "hgr_1", session_id: UUID, task_sha256: taskSha }, "sha256:" + "c".repeat(64)).code, "COMPLETION_MISMATCH");
  // task_sha256 格式非法
  assert.equal(validateHandoffCompletion(run, { run_id: "hgr_1", session_id: UUID, task_sha256: "md5:x" }).code, "COMPLETION_MISMATCH");
  // session_id 不是 UUID
  assert.equal(validateHandoffCompletion(run, { run_id: "hgr_1", session_id: "latest", task_sha256: taskSha }).code, "COMPLETION_MISMATCH");
  assert.equal(validateHandoffCompletion(run, { run_id: "hgr_1", session_id: "", task_sha256: taskSha }).code, "COMPLETION_MISMATCH");
  // 缺 run / completion
  assert.equal(validateHandoffCompletion(null, {}).code, "RUN_NOT_FOUND");
});

test("workspacePathForFileUrl:<source-parent>/.htmlgenius-bridge/claude/<id>;非 file: → null", () => {
  assert.equal(workspacePathForFileUrl("file:///Users/x/docs/report.html", "hgd_1"),
    "/Users/x/docs/.htmlgenius-bridge/claude/hgd_1");
  assert.equal(workspacePathForFileUrl("file:///a/spa%20ce/r.html", "hgd_2"),
    "/a/spa ce/.htmlgenius-bridge/claude/hgd_2"); // %20 解码为空格
  assert.equal(workspacePathForFileUrl("https://example.com/r.html", "hgd_3"), null);
  assert.equal(workspacePathForFileUrl("not a url", "hgd_4"), null);
});
