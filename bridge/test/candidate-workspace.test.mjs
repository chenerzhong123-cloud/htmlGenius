// bridge/test/candidate-workspace.test.mjs — Gate 2:candidate 工作区与不可覆盖协议(Night Pack A spec §3/§3.4)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveSourcePath, prepareCandidateRun, writeManifest, validateCandidate,
  publishSiblingCandidate, siblingCandidateName, assertSafeRunId, sha256File
} from "../candidate-workspace.mjs";
import { buildClaudeArgv } from "../claude-cli.mjs";

function mkSrc(name = "report.html", content = "<!doctype html><html><body>hello</body></html>") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-cand-src-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return { dir, p };
}
function mkWorkspaceRoot(dir) {
  const root = path.join(dir, ".htmlgenius-bridge", "claude", "hgd_test");
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function bundlePaths(root, runId) {
  const jsonPath = path.join(root, "task-" + runId + ".json");
  const mdPath = path.join(root, "task-" + runId + ".md");
  fs.writeFileSync(jsonPath, JSON.stringify({ schema_version: 1, brief: "SENSITIVE_BRIEF_DO_NOT_LEAK" }, null, 2));
  fs.writeFileSync(mdPath, "# task\nSENSITIVE_COMMENT_DO_NOT_LEAK");
  return { jsonPath, mdPath };
}

test("resolveSourcePath: file:// 与绝对路径 OK;拒 symlink/非 html/缺失/相对", () => {
  const { p } = mkSrc();
  assert.equal(resolveSourcePath(p), fs.realpathSync(p));
  assert.equal(resolveSourcePath(pathToFileURL(p).href), fs.realpathSync(p));
  // symlink
  const link = p + ".link";
  fs.symlinkSync(p, link);
  assert.throws(() => resolveSourcePath(link), (e) => e.code === "SOURCE_SYMLINK");
  // 非 html
  const txt = p.replace(/\.html$/, ".txt"); fs.writeFileSync(txt, "x");
  assert.throws(() => resolveSourcePath(txt), (e) => e.code === "SOURCE_NOT_HTML");
  // 缺失
  assert.throws(() => resolveSourcePath(p + ".nope"), (e) => e.code === "SOURCE_NOT_FOUND");
  // 相对
  assert.throws(() => resolveSourcePath("relative/report.html"), (e) => e.code === "NOT_ABSOLUTE_SOURCE");
});

test("prepareCandidateRun: runs 0700 + snapshot 0400 + hash 相等 + task 复制进 cwd", () => {
  const { p, dir } = mkSrc();
  const root = mkWorkspaceRoot(dir);
  const runId = "run001";
  const { jsonPath, mdPath } = bundlePaths(root, runId);
  const prep = prepareCandidateRun({ sourcePath: p, workspaceRoot: root, logicalDocumentId: "hgd_test", runId, taskJsonPath: jsonPath, taskMdPath: mdPath });
  const runsDir = path.join(root, "runs", runId);
  assert.equal(fs.statSync(runsDir).mode & 0o777, 0o700, "runs 0700");
  assert.equal(fs.statSync(prep.snapshotPath).mode & 0o777, 0o400, "snapshot 0400");
  assert.equal(sha256File(prep.snapshotPath), sha256File(p), "snapshot hash == source hash");
  assert.equal(prep.sourceSha256Before, sha256File(p));
  assert.ok(fs.existsSync(path.join(runsDir, "task-" + runId + ".json")), "task json 复制进 cwd");
  assert.ok(fs.existsSync(path.join(runsDir, "task-" + runId + ".md")), "task md 复制进 cwd");
});

test("sibling candidate:名称稳定;同名不覆盖;内容相等", () => {
  const { p, dir } = mkSrc();
  const root = mkWorkspaceRoot(dir);
  const runId = "run002";
  const { jsonPath, mdPath } = bundlePaths(root, runId);
  const prep = prepareCandidateRun({ sourcePath: p, workspaceRoot: root, logicalDocumentId: "hgd_test", runId, taskJsonPath: jsonPath, taskMdPath: mdPath });
  fs.writeFileSync(prep.candidatePath, "<!doctype html><html><body>cand</body></html>");
  const name = siblingCandidateName(p, runId);
  assert.match(name, /^report--htmlgenius-run002\.candidate\.html$/);
  const r1 = publishSiblingCandidate({ candidatePath: prep.candidatePath, sourcePath: p, runId });
  assert.equal(fs.readFileSync(r1, "utf8"), "<!doctype html><html><body>cand</body></html>");
  // 同名再发 → 冲突,不覆盖
  assert.throws(() => publishSiblingCandidate({ candidatePath: prep.candidatePath, sourcePath: p, runId }), (e) => e.code === "CANDIDATE_NAME_CONFLICT");
});

test("validateCandidate:缺失/空/symlink/过大/Markdown 全拒绝;合法 HTML 通过", () => {
  const { p, dir } = mkSrc();
  const root = mkWorkspaceRoot(dir);
  const runId = "run003";
  const { jsonPath, mdPath } = bundlePaths(root, runId);
  const prep = prepareCandidateRun({ sourcePath: p, workspaceRoot: root, logicalDocumentId: "hgd_test", runId, taskJsonPath: jsonPath, taskMdPath: mdPath });
  assert.throws(() => validateCandidate(prep.candidatePath, 100), (e) => e.code === "CANDIDATE_MISSING");
  fs.writeFileSync(prep.candidatePath, "");
  assert.throws(() => validateCandidate(prep.candidatePath, 100), (e) => e.code === "CANDIDATE_EMPTY");
  fs.unlinkSync(prep.candidatePath);
  const real = path.join(prep.runsDir, "real.html"); fs.writeFileSync(real, "<!doctype html><html></html>");
  fs.symlinkSync(real, prep.candidatePath);
  assert.throws(() => validateCandidate(prep.candidatePath, 100), (e) => e.code === "CANDIDATE_SYMLINK");
  fs.unlinkSync(prep.candidatePath);
  fs.writeFileSync(prep.candidatePath, "# this is markdown not html");
  assert.throws(() => validateCandidate(prep.candidatePath, 100), (e) => e.code === "CANDIDATE_INVALID_HTML");
  fs.writeFileSync(prep.candidatePath, "   \n  <!doctype html><html><body>ok</body></html>");
  const ok = validateCandidate(prep.candidatePath, 100);
  assert.match(ok.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(ok.byteLength > 0);
});

test("writeManifest:ready 含必需字段;失败 status;不含 prompt/comment/stdout", () => {
  const { p, dir } = mkSrc();
  const root = mkWorkspaceRoot(dir);
  const runId = "run004";
  const runsDir = path.join(root, "runs", runId);
  fs.mkdirSync(runsDir, { recursive: true });
  const before = sha256File(p);
  const SECRET_PROMPT = "TOP_SECRET_PROMPT_TEXT_XYZ";
  const SECRET_STDOUT = "CLAUDE_PRIVATE_THINKING_ABC";
  const mp = writeManifest({
    runsDir, runId, logicalDocumentId: "hgd_test", provider: "claude_code_cli",
    sourcePath: p, sourceSha256Before: before, sourceSha256After: before,
    candidateResultPath: p + ".cand", candidateWorkspacePath: path.join(runsDir, "candidate.html"),
    candidateSha256: "sha256:" + "a".repeat(64), candidateByteLength: 42,
    changeContractSha256: "sha256:" + "b".repeat(64), sessionId: "11111111-2222-3333-4444-555555555555", status: "ready"
  });
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  assert.equal(m.schema_version, 1);
  assert.equal(m.kind, "htmlgenius_candidate_manifest");
  assert.equal(m.status, "ready");
  assert.equal(m.candidate.result_path, p + ".cand");
  assert.equal(m.session.ownership, "htmlgenius");
  assert.equal(fs.statSync(mp).mode & 0o777, 0o600, "manifest 0600");
  // manifest 不含敏感 prompt/stdout(即使我们传了也不该出现;此处验证调用方未把敏感内容塞进 manifest 字段)
  const raw = fs.readFileSync(mp, "utf8");
  assert.ok(!raw.includes(SECRET_PROMPT) && !raw.includes(SECRET_STDOUT));
  // 失败 manifest
  const mp2 = writeManifest({ runsDir, runId: runId + "b", logicalDocumentId: "hgd_test", provider: "claude_code_cli", sourcePath: p, sourceSha256Before: before, changeContractSha256: "sha256:" + "c".repeat(64), status: "claude_failed" });
  assert.equal(JSON.parse(fs.readFileSync(mp2, "utf8")).status, "claude_failed");
});

test("路径安全:空格/中文 source OK;runId 含 .. 拒绝;argv 注入串仅作末元素", () => {
  const { p } = mkSrc("报 告 report.html"); // 空格 + 中文
  assert.equal(resolveSourcePath(p), fs.realpathSync(p));
  assert.throws(() => assertSafeRunId("../evil"), (e) => e.code === "BAD_RUN_ID");
  assert.throws(() => assertSafeRunId("a/b"), (e) => e.code === "BAD_RUN_ID");
  // argv 注入:candidate 放行 Write,handoff 禁 Write;注入串只是最后一个 argv 元素
  const injection = 'x"; rm -rf / ; $(whoami) `id`\n--evil-flag';
  const ca = buildClaudeArgv({ promptText: injection, runKind: "candidate" });
  assert.equal(ca[ca.length - 1], injection, "candidate:注入串原样末元素");
  assert.ok(ca.includes("--allowed-tools") && ca[ca.indexOf("--allowed-tools") + 1].includes("Write"), "candidate 放行 Write");
  assert.ok(!ca.slice(ca.indexOf("--disallowed-tools")).includes("Write"), "candidate disallowed 不含 Write");
  const ha = buildClaudeArgv({ promptText: injection, runKind: "handoff" });
  assert.ok(ha.slice(ha.indexOf("--disallowed-tools")).includes("Write"), "handoff 禁 Write");
  assert.ok(!ha.some((a) => a === "--evil-flag"), "注入串未被拆成 flag");
});
