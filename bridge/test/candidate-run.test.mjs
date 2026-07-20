// bridge/test/candidate-run.test.mjs — Gate 3:candidate 执行编排(Night Pack A spec §4)。
// 对象级 fake 覆盖编排分支 + 真实 spawn 校验 argv(用户内容不成为 flag/command/cwd)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeCandidateRun } from "../host-runner.mjs";
import { sha256File } from "../candidate-workspace.mjs";
import { makeFakeClaude } from "./fake-claude.mjs";

const FAKE_BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fake-claude-bin");

function mkFix(mode = "precise_patch") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-crun-"));
  const src = path.join(dir, "report.html");
  fs.writeFileSync(src, "<!doctype html><html><body>hello world</body></html>");
  const root = path.join(dir, ".htmlgenius-bridge", "claude", "hgd_c");
  fs.mkdirSync(root, { recursive: true });
  const task = {
    schema_version: 1, kind: "htmlgenius_change_contract", mode,
    artifact: { title: "T", url: pathToFileURL(src).href, is_local: true },
    source: { root_annotation_ids: ["r1"], root_annotation_count: 1 },
    annotations: [{ id: "r1", quote: "hello", comment: "change it", selector: { exact: "hello" }, replies: [] }],
    brief: "", preserve: [], contract: { write_scope: "target_only", locked_outside_scope: true, on_ambiguous_target: "ask_or_stop", verification: ["v"] }
  };
  return { dir, src, root, task, hash: sha256File(src) };
}
function baseMsg(fix, session = { mode: "new", session_id: null }, runId = "hgr_crun0123456789") {
  return { run_id: runId, run_kind: "candidate", source: { logical_document_id: "hgd_c", artifact_uri: pathToFileURL(fix.src).href, base_artifact_hash: fix.hash }, session, task: fix.task };
}
function collect() { const events = []; return { events, emit: (e) => events.push(e) }; }

test("candidate 成功:fake 写 candidate.html → sibling + ready manifest + candidate-ready", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "candidate.html"), "<!doctype html><html><body>EDITED</body></html>") });
  const { events, emit } = collect();
  await executeCandidateRun(baseMsg(fix), { emit, claude });
  const ready = events.find((e) => e.type === "candidate-ready");
  assert.ok(ready, "emit candidate-ready");
  assert.equal(ready.logical_document_id, "hgd_c");
  assert.match(ready.candidate_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ready.source_sha256_before, fix.hash);
  // sibling 存在且内容正确
  const sib = path.join(fix.dir, "report--htmlgenius-hgr_crun0123456789.candidate.html");
  assert.ok(fs.existsSync(sib), "sibling candidate 创建");
  assert.equal(fs.readFileSync(sib, "utf8"), "<!doctype html><html><body>EDITED</body></html>");
  // manifest ready
  const mp = path.join(fix.root, "runs", "hgr_crun0123456789", "candidate-manifest.json");
  assert.equal(JSON.parse(fs.readFileSync(mp, "utf8")).status, "ready");
  // bridge_session_created(new)
  assert.ok(events.some((e) => e.type === "bridge_session_created"));
});

test("candidate 写 Markdown → CANDIDATE_INVALID_HTML,无 sibling", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "candidate.html"), "# markdown only") });
  const { events, emit } = collect();
  await executeCandidateRun(baseMsg(fix), { emit, claude });
  const f = events.find((e) => e.type === "bridge_failed");
  assert.equal(f.code, "CANDIDATE_INVALID_HTML");
  assert.ok(!fs.existsSync(path.join(fix.dir, "report--htmlgenius-hgr_crun0123456789.candidate.html")), "不创建 sibling");
});

test("candidate 未写文件 → CANDIDATE_MISSING,无 sibling", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: () => {} }); // 不写
  const { events, emit } = collect();
  await executeCandidateRun(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "CANDIDATE_MISSING");
  assert.ok(!fs.existsSync(path.join(fix.dir, "report--htmlgenius-hgr_crun0123456789.candidate.html")));
});

test("运行期 source 被改 → SOURCE_MUTATED_DURING_CANDIDATE,无 sibling", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => { fs.writeFileSync(path.join(a.cwd, "candidate.html"), "<!doctype html><html></html>"); fs.appendFileSync(fix.src, "<!--mutated-->"); } });
  const { events, emit } = collect();
  await executeCandidateRun(baseMsg(fix), { emit, claude });
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "SOURCE_MUTATED_DURING_CANDIDATE");
  assert.ok(!fs.existsSync(path.join(fix.dir, "report--htmlgenius-hgr_crun0123456789.candidate.html")), "mutated 不创建 sibling");
});

test("extension 哈希 ≠ 文件字节 → host 忽略、自算、正常产 candidate", async () => {
  const fix = mkFix();
  const claude = makeFakeClaude({ onRun: (a) => fs.writeFileSync(path.join(a.cwd, "candidate.html"), "<!doctype html><html><body>ok</body></html>") });
  const msg = baseMsg(fix);
  msg.source.base_artifact_hash = "sha256:" + "0".repeat(64); // 故意给错
  const { events, emit } = collect();
  await executeCandidateRun(msg, { emit, claude });
  assert.ok(events.some((e) => e.type === "candidate-ready"), "host 自算源哈希,不与 extension 比对,正常产 candidate");
});

test("restructure 模式 → INVALID_MODE;continue 非法 UUID → NO_SAVED_SESSION", async () => {
  const fix = mkFix("restructure");
  const c1 = collect();
  await executeCandidateRun(baseMsg(fix), { emit: c1.emit, claude: makeFakeClaude() });
  assert.equal(c1.events.find((e) => e.type === "bridge_failed").code, "INVALID_MODE");
  const fix2 = mkFix();
  const c2 = collect();
  const m2 = baseMsg(fix2, { mode: "continue", session_id: "not-a-uuid" });
  await executeCandidateRun(m2, { emit: c2.emit, claude: makeFakeClaude() });
  assert.equal(c2.events.find((e) => e.type === "bridge_failed").code, "NO_SAVED_SESSION");
});

test("真实 spawn argv:candidate 放行 Write,注入串不成为独立 flag/command/cwd", async () => {
  const fix = mkFix();
  fix.task.brief = 'INJECT"; rm -rf / ; $(whoami) `id` --evil'; // 注入串进 task → 渲染进 prompt
  const savedPath = process.env.PATH;
  const tmpBase = process.env.TMPDIR || os.tmpdir();
  const argvLog = path.join(tmpBase, "fake-claude.argv." + process.pid);
  try { fs.unlinkSync(argvLog); } catch (_) {}
  fs.writeFileSync(path.join(tmpBase, "fake-claude.mode." + process.pid), "ok"); // fake 不写 candidate → 将 CANDIDATE_MISSING
  process.env.PATH = FAKE_BIN + path.delimiter + savedPath;
  const { events, emit } = collect();
  await executeCandidateRun(baseMsg(fix, { mode: "new", session_id: null }, "hgr_spawnx1234567890"), { emit, claude: undefined }); // 真实 spawn
  // 编排应在 validateCandidate 失败( fake 没写 candidate)
  assert.equal(events.find((e) => e.type === "bridge_failed").code, "CANDIDATE_MISSING");
  // 读 argv 日志:校验 candidate argv 结构
  const raw = fs.readFileSync(argvLog, "utf8");
  const calls = raw.split("\0").reduce((acc, t) => { if (t === "END") { acc.push([]); } else { acc[acc.length - 1] = acc[acc.length - 1] || []; acc[acc.length - 1].push(t); } return acc; }, [[]]).filter((c) => c.length && c[0] !== "");
  const argv = calls.find((c) => c[0] === "-p") || calls[calls.length - 1];
  assert.ok(argv, "fake 收到 -p 调用");
  const ai = argv.indexOf("--allowed-tools");
  assert.ok(argv[ai + 1].includes("Write"), "candidate argv 放行 Write:" + argv[ai + 1]);
  const di = argv.indexOf("--disallowed-tools");
  assert.ok(argv.slice(di + 1).includes("Bash"), "candidate argv 禁 Bash");
  assert.ok(!argv.slice(di + 1).includes("Write"), "candidate disallowed 不含 Write");
  // 注入串只作为 prompt(末元素)的一部分,不是独立 flag
  assert.equal(argv[argv.length - 1].includes("INJECT"), true, "注入串在 prompt 末元素内");
  assert.ok(!argv.slice(0, -1).some((a) => a.includes("INJECT")), "注入串未泄漏为独立 argv 元素");
  assert.ok(!argv.includes("--evil"), "注入串未被拆成 flag");
  // cwd 不是注入串(argv 不含 cwd;cwd 由 spawn 选项传,fake 的 $PWD 是 runs 目录)
} );
