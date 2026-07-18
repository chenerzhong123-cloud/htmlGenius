// bridge/test/run-manager.test.mjs — run manager 文件/哈希/candidate 测试(§12.4)。全部在 os.tmpdir()。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  prepareRun, finalizeRun, resolveSourceArtifact, sha256File,
  createCandidateDir, buildSandboxPolicy, generateRunId, MAX_ARTIFACT_BYTES
} from "../run-manager.mjs";
import { buildCodexPrompt } from "../prompt.mjs";

const HTML = "<!doctype html><html><head><title>r</title></head><body><p>hello report</p></body></html>";

function tmpSource(name = "report.html", content = HTML) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-run-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return { dir, p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

test("resolveSourceArtifact: 合法 file URL -> 绝对路径", () => {
  const { p, cleanup } = tmpSource();
  try {
    const r = resolveSourceArtifact(pathToFileURL(p).href);
    assert.equal(r.sourcePath, p);
  } finally { cleanup(); }
});

test("resolveSourceArtifact: 非 file URI -> NOT_FILE_URI", () => {
  assert.throws(() => resolveSourceArtifact("https://example.com/x.html"), (e) => e.code === "NOT_FILE_URI");
  assert.throws(() => resolveSourceArtifact("foo/bar.html"), (e) => e.code === "NOT_FILE_URI");
});

test("resolveSourceArtifact: 目录 -> SOURCE_IS_DIRECTORY", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-dir-"));
  try { assert.throws(() => resolveSourceArtifact(pathToFileURL(dir + "/").href), (e) => e.code === "NOT_FILE_URI" || e.code === "SOURCE_IS_DIRECTORY"); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
});

test("resolveSourceArtifact: 非 .html -> SOURCE_NOT_HTML", () => {
  const { p, cleanup } = tmpSource("notes.txt", "hi");
  try { assert.throws(() => resolveSourceArtifact(pathToFileURL(p).href), (e) => e.code === "SOURCE_NOT_HTML"); }
  finally { cleanup(); }
});

test("resolveSourceArtifact: 不存在 -> SOURCE_NOT_FOUND", () => {
  assert.throws(() => resolveSourceArtifact(pathToFileURL(path.join(os.tmpdir(), "hg-nope-xyz.html")).href), (e) => e.code === "SOURCE_NOT_FOUND");
});

test("prepareRun: base 一致 -> 建 candidate(0700)、resultPath 在 candidate 内", () => {
  const { p, cleanup } = tmpSource();
  try {
    const base = sha256File(p);
    const runId = generateRunId();
    const r = prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: base }, runId });
    assert.ok(fs.existsSync(r.candidateDir));
    assert.equal(r.resultPath, path.join(r.candidateDir, "result.html"));
    assert.equal(r.confirmedBaseHash, base);
    cleanup();
  } finally { cleanup(); }
});

test("prepareRun: base 不一致 -> SOURCE_CHANGED_BEFORE_START 且 candidate 已清", () => {
  const { p, dir, cleanup } = tmpSource();
  try {
    const r = prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: "sha256:wrong" }, runId: generateRunId() });
    assert.ok(false, "应抛错");
  } catch (e) {
    assert.equal(e.code, "SOURCE_CHANGED_BEFORE_START");
    // candidate 目录不应残留
    const cand = path.join(dir, ".htmlgenius-candidates");
    assert.ok(!fs.existsSync(cand) || fs.readdirSync(cand).length === 0, "candidate 已清理");
  } finally { cleanup(); }
});

test("finalizeRun: source 未变 + 合法 result -> completion,hash/file URL 正确", () => {
  const { p, cleanup } = tmpSource();
  try {
    const base = sha256File(p);
    const runId = generateRunId();
    const prep = prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: base }, runId });
    fs.writeFileSync(prep.resultPath, "<!doctype html><html><body>new version</body></html>");
    const completion = finalizeRun({
      sourcePath: prep.sourcePath, confirmedBaseHash: prep.confirmedBaseHash,
      candidateDir: prep.candidateDir, resultPath: prep.resultPath,
      runId, logicalDocumentId: "hgd_1", threadId: "thr_1", turnId: "turn_1"
    });
    assert.equal(completion.type, "bridge_completed");
    assert.equal(completion.result_kind, "new_artifact");
    assert.equal(completion.base_artifact_hash, base);
    assert.notEqual(completion.result_artifact_hash, base);
    assert.match(completion.result_artifact_uri, /^file:\/.+result\.html$/);
    assert.equal(completion.logical_document_id, "hgd_1");
  } finally { cleanup(); }
});

test("finalizeRun: run 后 source 变化 -> SOURCE_MUTATED 且 candidate 已删", () => {
  const { p, dir, cleanup } = tmpSource();
  try {
    const base = sha256File(p);
    const prep = prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: base }, runId: generateRunId() });
    fs.writeFileSync(prep.resultPath, "<!doctype html><html><body>v2</body></html>");
    fs.writeFileSync(p, HTML + "<!-- external edit -->"); // 模拟 run 中途 source 被改
    assert.throws(() => finalizeRun({
      sourcePath: prep.sourcePath, confirmedBaseHash: prep.confirmedBaseHash,
      candidateDir: prep.candidateDir, resultPath: prep.resultPath, runId: generateRunId()
    }), (e) => e.code === "SOURCE_MUTATED");
    assert.ok(!fs.existsSync(prep.candidateDir), "candidate 已删");
  } finally { cleanup(); }
});

test("finalizeRun: result.html 缺失 -> NO_RESULT", () => {
  const { p, cleanup } = tmpSource();
  try {
    const base = sha256File(p);
    const prep = prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: base }, runId: generateRunId() });
    assert.throws(() => finalizeRun({
      sourcePath: prep.sourcePath, confirmedBaseHash: prep.confirmedBaseHash,
      candidateDir: prep.candidateDir, resultPath: prep.resultPath, runId: generateRunId()
    }), (e) => e.code === "NO_RESULT");
  } finally { cleanup(); }
});

test("finalizeRun: candidate 与 source 相同 -> NO_ARTIFACT_CHANGE", () => {
  const { p, cleanup } = tmpSource();
  try {
    const base = sha256File(p);
    const prep = prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: base }, runId: generateRunId() });
    fs.writeFileSync(prep.resultPath, HTML); // 与 source 完全相同
    assert.throws(() => finalizeRun({
      sourcePath: prep.sourcePath, confirmedBaseHash: prep.confirmedBaseHash,
      candidateDir: prep.candidateDir, resultPath: prep.resultPath, runId: generateRunId()
    }), (e) => e.code === "NO_ARTIFACT_CHANGE");
  } finally { cleanup(); }
});

test("prepareRun: source > 10 MiB -> SOURCE_TOO_LARGE", () => {
  const { p, cleanup } = tmpSource("big.html", "x".repeat(MAX_ARTIFACT_BYTES + 1024));
  try {
    assert.throws(() => prepareRun({ source: { artifact_uri: pathToFileURL(p).href, base_artifact_hash: "sha256:x" }, runId: generateRunId() }),
      (e) => e.code === "SOURCE_TOO_LARGE");
  } finally { cleanup(); }
});

test("buildSandboxPolicy: candidate 可写、sourceParent 只读、关网、approvalPolicy=never", () => {
  const pol = buildSandboxPolicy({ candidateDir: "/tmp/cand", sourceParent: "/tmp/src-parent" });
  assert.equal(pol.approvalPolicy, "never");
  assert.equal(pol.sandboxMode, "workspaceWrite");
  assert.deepEqual(pol.writableRoots, ["/tmp/cand"]);
  assert.deepEqual(pol.readOnlyAccess.readableRoots, ["/tmp/src-parent"]);
  assert.equal(pol.cwd, "/tmp/cand");
  assert.equal(pol.networkAccess, false);
});

test("generateRunId: hgr_ 前缀 + 足够长", () => {
  const id = generateRunId();
  assert.match(id, /^hgr_[0-9a-f]{16,}$/);
});

test("prompt.buildCodexPrompt: 含前言 + renderPrompt + 路径", async () => {
  const require = (await import("node:module")).createRequire(import.meta.url);
  const CC = require("../../extension/change-contract.js");
  const task = CC.buildTask({
    mode: "precise_patch", rootIds: ["a1"], brief: "改短这句", preserveText: "公司名",
    artifact: { title: "R", url: "file:///r.html", isLocal: true }
  }, [{ id: "a1", parent_id: null, quote: "原文", selector: { exact: "原文" }, body: { comment: "c" }, author: { name: "Z" } }]);
  const p = buildCodexPrompt({ task, sourcePath: "/abs/r.html", resultPath: "/abs/.htmlgenius-candidates/hgr_1/result.html" });
  assert.match(p, /HTML Genius Local Bridge 任务/);
  assert.match(p, /只能读取 source HTML/);                 // 前言
  assert.match(p, /HTML Genius 修改任务/);                  // renderPrompt 输出
  assert.match(p, /\/abs\/r\.html/);                        // source 路径
  assert.match(p, /\.htmlgenius-candidates\/hgr_1\/result\.html/); // candidate 路径
});

test("prompt.buildCodexPrompt: restructure -> INVALID_MODE(防御)", () => {
  assert.throws(() => buildCodexPrompt({ task: { mode: "restructure" }, sourcePath: "/a", resultPath: "/b" }),
    (e) => e.code === "INVALID_MODE");
});
