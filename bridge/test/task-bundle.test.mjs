// bridge/test/task-bundle.test.mjs — task-bundle 纯逻辑测试(spec §11.2/§11.5)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  canonicalTaskJson, taskSha256, sha256Bytes, sha256File, isSha256Tagged,
  resolveSourceArtifact, verifySourceHash, createWorkspace, workspacePathFor,
  writeTaskBundle, assertTaskSchema, buildHandoffPrompt, rootAnnotationIdsOf, buildPatchPrompt,
  buildCandidatePrompt, buildPlanPrompt, buildCodexPrompt
} from "../task-bundle.mjs";

const require = createRequire(import.meta.url);
const ChangeContract = require("../../extension/change-contract.js");

function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("buildPatchPrompt:指示只输出编辑 JSON、绝不写文件,含 schema 与契约围栏", () => {
  const p = buildPatchPrompt({ runId: "hgr_abcdef0123456789", task: sampleTask() });
  assert.ok(p.includes('"schema_version": 1'), "含 edits schema");
  assert.ok(p.includes("replace_text") && p.includes("set_style"), "含两种 action 说明");
  assert.ok(/Do NOT modify any file/i.test(p) && /candidate\.html/.test(p), "禁改文件/禁写 candidate");
  assert.ok(p.includes("<<<HG_USER_DATA>>>"), "契约用户数据围栏保留");
  assert.ok(p.includes("## Change Contract"), "拼接 renderPrompt 契约");
  assert.ok(p.includes("comment_ref"), "要求 comment_ref 关联评论");
});

test("四个执行 prompt 均告诫:原始路径可能在沙箱外、禁止打开,只读 cwd 快照(防沙箱 agent 读不可达路径)", () => {
  const patch = buildPatchPrompt({ runId: "hgr_abcdef0123456789", task: sampleTask() });
  const cand = buildCandidatePrompt({ runId: "hgr_abcdef0123456789", task: sampleTask() });
  const plan = buildPlanPrompt({ runId: "hgr_abcdef0123456789", task: sampleTask() });
  const codex = buildCodexPrompt({ task: sampleTask() });
  // claude/patch/candidate/plan 用英文告诚;codex 用中文告诚
  for (const p of [patch, cand, plan]) {
    assert.ok(/OUTSIDE your accessible workspace/i.test(p) && /do NOT open it/i.test(p), "英文 prompt 须含禁开原始路径告诚");
    assert.ok(/authoritative snapshot/i.test(p), "英文 prompt 须指明 cwd 快照为权威来源");
  }
  assert.ok(/禁止打开/.test(codex) && /权威快照/.test(codex), "codex 中文 prompt 须含禁开原始路径告诚");
});

// 用真实 ChangeContract.buildTask 造 task(单一真相源)
function sampleTask(overrides = {}) {
  const anns = [
    { id: "a1", parent_id: null, _status: "open", quote: "原文一", selector: { exact: "原文一", prefix: "前", suffix: "后" }, body: { comment: "改这里" }, author: { name: "张三" } },
    { id: "a2", parent_id: "a1", _status: "open", quote: "", selector: {}, body: { comment: "同意,再温和点" }, author: { name: "李四" } },
    { id: "b1", parent_id: null, _status: "open", quote: "原文二", selector: { exact: "原文二" }, body: { comment: "删掉" } }
  ];
  return ChangeContract.buildTask(Object.assign({
    mode: "precise_patch", rootIds: ["a1", "b1"], brief: "补充说明背景", preserveText: "保留行A\n保留行B",
    artifact: { title: "T", url: "file:///tmp/report.html", isLocal: true }
  }, overrides), anns);
}

test("taskSha256:同一 task 稳定、不同 task 不同、格式 sha256:<64hex>", () => {
  const t = sampleTask();
  const s1 = taskSha256(t), s2 = taskSha256(sampleTask());
  assert.equal(s1, s2);
  assert.match(s1, /^sha256:[0-9a-f]{64}$/);
  const t2 = sampleTask({ brief: "不同的说明" });
  assert.notEqual(taskSha256(t2), s1);
  // 与手算一致:sha256(JSON.stringify(task,null,2) 的 UTF-8 bytes)
  const manual = "sha256:" + crypto.createHash("sha256").update(Buffer.from(JSON.stringify(t, null, 2), "utf8")).digest("hex");
  assert.equal(s1, manual);
  assert.ok(isSha256Tagged(s1));
  assert.ok(!isSha256Tagged("sha256:zzz"));
});

test("assertTaskSchema:版本/kind/模式/大小校验", () => {
  assert.ok(assertTaskSchema(sampleTask()).length > 0);
  assert.throws(() => assertTaskSchema({ ...sampleTask(), schema_version: 9 }), /schema_version/);
  assert.throws(() => assertTaskSchema({ ...sampleTask(), kind: "other" }), /kind/);
  assert.throws(() => assertTaskSchema({ ...sampleTask(), mode: "restructure" }), /mode/);
  assert.throws(() => assertTaskSchema(null), /object/);
});

test("resolveSourceArtifact:只接受存在的 regular .html file: URL", () => {
  const tmp = mkTmp("hg-tb-src-");
  const html = path.join(tmp, "report.html");
  fs.writeFileSync(html, "<html></html>");
  assert.equal(resolveSourceArtifact(pathToFileURL(html).href).sourcePath, html);
  assert.throws(() => resolveSourceArtifact("https://x.com/a.html"), /file:/);
  assert.throws(() => resolveSourceArtifact(pathToFileURL(path.join(tmp, "nope.html")).href), /not found/);
  assert.throws(() => resolveSourceArtifact(pathToFileURL(tmp).href), /regular file/);
  const txt = path.join(tmp, "a.txt"); fs.writeFileSync(txt, "x");
  assert.throws(() => resolveSourceArtifact(pathToFileURL(txt).href), /\.html/);
});

test("verifySourceHash:一致通过、不一致抛 SOURCE_CHANGED_BEFORE_START", () => {
  const tmp = mkTmp("hg-tb-hash-");
  const html = path.join(tmp, "r.html");
  fs.writeFileSync(html, "<html>1</html>");
  const h = sha256File(html);
  assert.equal(verifySourceHash({ sourcePath: html, expectedHash: h }), h);
  assert.throws(() => verifySourceHash({ sourcePath: html, expectedHash: "sha256:" + "0".repeat(64) }),
    (e) => e.code === "SOURCE_CHANGED_BEFORE_START");
});

test("workspace:固定路径 + 0700;logical id 防路径穿越", () => {
  const tmp = mkTmp("hg-tb-ws-");
  const html = path.join(tmp, "r.html");
  fs.writeFileSync(html, "<html></html>");
  const ws = createWorkspace({ sourcePath: html, logicalDocumentId: "hgd_abc123" });
  assert.equal(ws, path.join(tmp, ".htmlgenius-bridge", "claude", "hgd_abc123"));
  assert.ok(fs.statSync(ws).isDirectory());
  assert.equal(fs.statSync(ws).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(tmp, ".htmlgenius-bridge")).mode & 0o777, 0o700);
  // 穿越/非法 id 一律拒绝
  for (const bad of ["../evil", "..", "a/b", "a b", "x".repeat(200), ""]) {
    assert.throws(() => workspacePathFor({ sourcePath: html, logicalDocumentId: bad }), (e) => e.code === "BAD_LOGICAL_ID");
  }
});

test("writeTaskBundle:JSON+md 落盘、0600、内容完整(顶层批注/回复树/mode/preserve/brief)、SHA 匹配", () => {
  const tmp = mkTmp("hg-tb-bundle-");
  const html = path.join(tmp, "r.html");
  fs.writeFileSync(html, "<html></html>");
  const ws = createWorkspace({ sourcePath: html, logicalDocumentId: "hgd_x1" });
  const task = sampleTask();
  const b = writeTaskBundle({ workspace: ws, runId: "hgr_test1234567890", task, sourcePath: html, baseArtifactHash: sha256File(html) });

  assert.ok(fs.existsSync(b.jsonPath) && fs.existsSync(b.mdPath));
  assert.equal(fs.statSync(b.jsonPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(b.mdPath).mode & 0o777, 0o600);
  assert.equal(b.taskSha256, taskSha256(task));
  assert.equal(sha256File(b.jsonPath), b.taskSha256); // 盘上字节即 canonical bytes

  const parsed = JSON.parse(fs.readFileSync(b.jsonPath, "utf8"));
  assert.equal(parsed.mode, "precise_patch");
  assert.equal(parsed.annotations.length, 2);                    // 两条顶层批注
  assert.equal(parsed.annotations[0].replies.length, 1);         // 回复树
  assert.equal(parsed.annotations[0].replies[0].comment, "同意,再温和点");
  assert.deepEqual(parsed.preserve, ["保留行A", "保留行B"]);
  assert.equal(parsed.brief, "补充说明背景");
  assert.deepEqual(parsed.source.root_annotation_ids, ["a1", "b1"]);

  const md = fs.readFileSync(b.mdPath, "utf8");
  assert.match(md, /Safety preamble/);
  assert.match(md, /task SHA-256: sha256:[0-9a-f]{64}/);
  assert.match(md, /run_id: hgr_test1234567890/);
  assert.match(md, /root annotation IDs: a1, b1/);
});

test("writeTaskBundle:run_id 白名单校验", () => {
  const tmp = mkTmp("hg-tb-runid-");
  const html = path.join(tmp, "r.html");
  fs.writeFileSync(html, "<html></html>");
  const ws = createWorkspace({ sourcePath: html, logicalDocumentId: "hgd_x2" });
  assert.throws(() => writeTaskBundle({ workspace: ws, runId: "../../evil", task: sampleTask(), sourcePath: html, baseArtifactHash: "sha256:" + "1".repeat(64) }),
    (e) => e.code === "BAD_RUN_ID");
});

test("buildHandoffPrompt:含路径/SHA/run ID/root IDs;注入串不影响结构(只进 bundle 不进 prompt)", () => {
  const evil = '"; rm -rf / ; $(echo hacked) `\nnewline`';
  const task = sampleTask({ brief: evil }); // 注入内容进 task(brief)
  const p = buildHandoffPrompt({
    jsonPath: "/abs/path/task-hgr_x.json",
    taskSha256: taskSha256(task),
    runId: "hgr_x999",
    rootAnnotationIds: rootAnnotationIdsOf(task)
  });
  assert.match(p, /Read the task bundle at: \/abs\/path\/task-hgr_x\.json/);
  assert.match(p, /Verify its SHA-256 is: sha256:[0-9a-f]{64}/);
  assert.match(p, /Run ID: hgr_x999/);
  assert.match(p, /Root annotation IDs: a1, b1/);
  // prompt 不含 brief/comment 原文(注入串只存在于 bundle JSON 里)
  assert.ok(!p.includes("hacked"));
  assert.ok(!p.includes("rm -rf"));
  // 注入串在 canonical JSON 里是合法字符串内容(JSON.stringify 转义),可被 Claude 读取解析
  const parsed = JSON.parse(canonicalTaskJson(task));
  assert.equal(parsed.brief, evil);
  assert.equal(sha256Bytes(Buffer.from(canonicalTaskJson(task), "utf8")), taskSha256(task));
});
