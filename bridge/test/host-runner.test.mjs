// bridge/test/host-runner.test.mjs — claude_handoff_start 编排测试(注入 fake claude,零子进程)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { executeHandoff } from "../host-runner.mjs";
import { taskSha256, sha256File } from "../task-bundle.mjs";
import { makeFakeClaude } from "./fake-claude.mjs";

const require = createRequire(import.meta.url);
const ChangeContract = require("../../extension/change-contract.js");

function mkFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hg-runner-"));
  const html = path.join(tmp, "report.html");
  fs.writeFileSync(html, "<!doctype html><html><body>hello</body></html>");
  return { tmp, html, uri: pathToFileURL(html).href, hash: sha256File(html) };
}
function sampleTask() {
  const anns = [
    { id: "a1", parent_id: null, _status: "open", quote: "hello", selector: { exact: "hello" }, body: { comment: "改这里" } },
    { id: "a2", parent_id: "a1", _status: "open", quote: "", selector: {}, body: { comment: "回复" } }
  ];
  return ChangeContract.buildTask({
    mode: "precise_patch", rootIds: ["a1"], brief: "", preserveText: "",
    artifact: { title: "T", url: "file:///x.html", isLocal: true }
  }, anns);
}
function baseMsg(fix, session) {
  return {
    run_id: "hgr_run1234567890",
    source: { logical_document_id: "hgd_doc1", artifact_uri: fix.uri, base_artifact_hash: fix.hash },
    session: session || { mode: "new", session_id: null },
    task: sampleTask()
  };
}
function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

test("new run 全流程:checking→running→session_created→completed(run_id/session_id/task_sha256),bundle 落盘且 SHA 匹配", async () => {
  const fix = mkFixture();
  const claude = makeFakeClaude();
  const { events, emit } = collect();
  await executeHandoff(baseMsg(fix), { emit, claude });

  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes("bridge_status"));
  assert.ok(kinds.includes("bridge_session_created"));
  const done = events.find((e) => e.type === "bridge_completed");
  assert.ok(done, "有 bridge_completed");
  assert.equal(done.run_id, "hgr_run1234567890");
  assert.equal(done.session_id, claude.cfg.runResult.sessionId);
  assert.equal(done.task_sha256, taskSha256(sampleTask()));

  // bundle 落盘:workspace 固定路径 + json 存在 + 盘上哈希 = 回报哈希
  const ws = path.join(fix.tmp, ".htmlgenius-bridge", "claude", "hgd_doc1");
  const jsonPath = path.join(ws, "task-hgr_run1234567890.json");
  assert.ok(fs.existsSync(jsonPath));
  assert.equal(sha256File(jsonPath), done.task_sha256);
  const bundle = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(bundle.annotations.length, 1);
  assert.equal(bundle.annotations[0].replies.length, 1);

  // claude 调用:cwd=workspace,prompt 含 bundle 绝对路径与 SHA
  assert.equal(claude.calls.runHandoff.length, 1);
  assert.equal(claude.calls.runHandoff[0].cwd, ws);
  assert.ok(claude.calls.runHandoff[0].promptText.includes(jsonPath));
  assert.ok(claude.calls.runHandoff[0].promptText.includes(done.task_sha256));
  // status 顺序:checking 先于 running
  const st = events.filter((e) => e.type === "bridge_status").map((e) => e.status);
  assert.deepEqual(st, ["checking", "running"]);
});

test("continue:只用保存的 UUID + 同一 workspace 调 resumeHandoff;非法 UUID 直接拒绝", async () => {
  const fix = mkFixture();
  const uuid = "abcdefab-1234-5678-9abc-def012345678";
  const claude = makeFakeClaude();
  const { events, emit } = collect();
  await executeHandoff(baseMsg(fix, { mode: "continue", session_id: uuid }), { emit, claude });

  assert.equal(claude.calls.resumeHandoff.length, 1);
  assert.equal(claude.calls.runHandoff.length, 0, "continue 不走 new");
  assert.equal(claude.calls.resumeHandoff[0].resumeSessionId, uuid);
  assert.equal(claude.calls.resumeHandoff[0].cwd, path.join(fix.tmp, ".htmlgenius-bridge", "claude", "hgd_doc1"));
  assert.ok(!events.some((e) => e.type === "bridge_session_created"), "continue 不发 session_created");
  assert.ok(events.some((e) => e.type === "bridge_completed"));

  // 非法 UUID(想蒙混 -c/picker)→ NO_SAVED_SESSION,不碰 claude
  const claude2 = makeFakeClaude();
  const c2 = collect();
  await executeHandoff(baseMsg(fix, { mode: "continue", session_id: "latest" }), { emit: c2.emit, claude: claude2 });
  const fail = c2.events.find((e) => e.type === "bridge_failed");
  assert.equal(fail.code, "NO_SAVED_SESSION");
  assert.equal(claude2.calls.resumeHandoff.length + claude2.calls.runHandoff.length, 0);
});

test("base 哈希不一致 → SOURCE_CHANGED_BEFORE_START,不调用 claude、无 completed", async () => {
  const fix = mkFixture();
  const claude = makeFakeClaude();
  const { events, emit } = collect();
  const msg = baseMsg(fix);
  msg.source.base_artifact_hash = "sha256:" + "0".repeat(64);
  await executeHandoff(msg, { emit, claude });
  const fail = events.find((e) => e.type === "bridge_failed");
  assert.equal(fail.code, "SOURCE_CHANGED_BEFORE_START");
  assert.ok(!events.some((e) => e.type === "bridge_completed"));
  assert.equal(claude.calls.runHandoff.length + claude.calls.checkAuth.length, 0, "未进入 claude 阶段");
});

test("运行期 source 被外部改动 → SOURCE_MUTATED_DURING_HANDOFF(不算成功,不写 session)", async () => {
  const fix = mkFixture();
  const claude = makeFakeClaude({
    onRun: () => fs.appendFileSync(fix.html, "<!--mutated-->") // 模拟用户/其他进程在运行期改文件
  });
  const { events, emit } = collect();
  await executeHandoff(baseMsg(fix), { emit, claude });
  const fail = events.find((e) => e.type === "bridge_failed");
  assert.equal(fail.code, "SOURCE_MUTATED_DURING_HANDOFF");
  assert.ok(!events.some((e) => e.type === "bridge_completed"));
});

test("auth 失败 → CLAUDE_NOT_LOGGED_IN 透传,无 session/completed", async () => {
  const fix = mkFixture();
  const claude = makeFakeClaude({ authFail: "CLAUDE_NOT_LOGGED_IN" });
  const { events, emit } = collect();
  await executeHandoff(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "CLAUDE_NOT_LOGGED_IN");
  assert.ok(!events.some((e) => e.type === "bridge_completed"));
});

test("claude result 无效(无 UUID)→ CLAUDE_INVALID_RESULT 透传", async () => {
  const fix = mkFixture();
  const claude = makeFakeClaude({ runFail: { code: "CLAUDE_INVALID_RESULT", message: "no uuid" } });
  const { events, emit } = collect();
  await executeHandoff(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "CLAUDE_INVALID_RESULT");
});

test("请求校验:restructure 模式 / 缺字段 / 坏 SHA → 拒绝", async () => {
  const fix = mkFixture();
  const claude = makeFakeClaude();
  // restructure
  const c1 = collect();
  const m1 = baseMsg(fix); m1.task.mode = "restructure";
  await executeHandoff(m1, { emit: c1.emit, claude });
  assert.equal(c1.events.find((e) => e.type === "bridge_failed").code, "INVALID_MODE");
  // 缺 run_id
  const c2 = collect();
  await executeHandoff({ ...baseMsg(fix), run_id: "" }, { emit: c2.emit, claude });
  assert.equal(c2.events.find((e) => e.type === "bridge_failed").code, "BAD_REQUEST");
  // 坏 base hash
  const c3 = collect();
  const m3 = baseMsg(fix); m3.source.base_artifact_hash = "md5:abc";
  await executeHandoff(m3, { emit: c3.emit, claude });
  assert.equal(c3.events.find((e) => e.type === "bridge_failed").code, "BAD_REQUEST");
  assert.equal(claude.calls.runHandoff.length, 0);
});
