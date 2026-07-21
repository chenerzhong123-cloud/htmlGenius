// bridge/candidate-workspace.mjs — candidate run 的工作区与不可覆盖协议(Night Pack A spec §3/§3.4)。
// 职责:source snapshot(0400)、candidate-manifest.json(0600)、sibling candidate 原子复制;
// 路径安全(realpath + 拒 symlink + 拒 traversal);candidate 形态校验(存在/regular/非 symlink/大小/UTF-8 HTML 形态)。
// 设计强边界(spec §3.4 末):不向 Claude 暴露 source 真实路径 + 禁 shell + host 前后校验 hash + 失败拒绝注册;
// 这不是「模型绝不可能写 source」的虚假承诺,而是「source 永远不会被 host/Claude 覆盖」的可检查协议。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const MAX_CANDIDATE_BYTES = 10 * 1024 * 1024; // 10 MiB 硬上限
const HTML_HEAD_RE = /<!doctype\s+html|<html/i;     // 基本 HTML 形态(阻止 Markdown/纯文本,非质量判断)

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}
export function sha256Bytes(buf) { return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex"); }
export function sha256File(absPath) { return sha256Bytes(fs.readFileSync(absPath)); }

// runId 白名单(文件名安全;与 task-bundle 一致)
export function assertSafeRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_.-]{1,96}$/.test(runId)) {
    fail("BAD_RUN_ID", "runId must be filename-safe [A-Za-z0-9_.-]{1,96}");
  }
  return runId;
}

// source canonical 路径 + 安全校验(spec §3.4.1/8):realpath、regular file、.html/.htm、拒 symlink
export function resolveSourcePath(sourceUriOrPath) {
  let p;
  if (typeof sourceUriOrPath === "string" && /^file:/i.test(sourceUriOrPath)) {
    try { p = fileURLToPath(sourceUriOrPath); }
    catch (e) { fail("NOT_FILE_URI", "source must be a file: URL or absolute path"); }
  } else if (typeof sourceUriOrPath === "string" && path.isAbsolute(sourceUriOrPath)) {
    p = sourceUriOrPath;
  } else {
    fail("NOT_ABSOLUTE_SOURCE", "source must be absolute path or file: URL");
  }
  // 先 lstat 输入路径本身:realpath 会跟随 symlink,若在其后判断就检测不到 symlink 逃逸
  let lst0;
  try { lst0 = fs.lstatSync(p); }
  catch (e) { fail("SOURCE_NOT_FOUND", "source not found: " + p); }
  if (lst0.isSymbolicLink()) fail("SOURCE_SYMLINK", "source must not be a symlink: " + p);
  let real;
  try { real = fs.realpathSync(p); }
  catch (e) { fail("SOURCE_NOT_FOUND", "source not found: " + p); }
  let lst;
  try { lst = fs.lstatSync(real); }
  catch (e) { fail("SOURCE_NOT_FOUND", "source stat failed: " + real); }
  if (lst.isSymbolicLink()) fail("SOURCE_SYMLINK", "source resolves to a symlink: " + real);
  if (!lst.isFile()) fail("SOURCE_NOT_FILE", "source must be a regular file: " + real);
  if (!/\.html?$/i.test(real)) fail("SOURCE_NOT_HTML", "source must be .html/.htm: " + real);
  return real;
}

// sibling candidate 名(spec §3.2):<sourceStem>--htmlgenius-<runId>.candidate.html
export function siblingCandidateName(sourcePath, runId) {
  assertSafeRunId(runId);
  const stem = path.basename(sourcePath).replace(/\.html?$/i, "");
  return stem + "--htmlgenius-" + runId + ".candidate.html";
}

// 建立 runs/<runId>/(0700)+ 写 source snapshot(0400)+ copy 后 hash 校验(spec §3.4.2)
// 同时把 task bundle 复制进 runs/<runId>,使执行前言「当前目录的 task-<run-id>.*」语义成立(等价适配,见 preflight)。
export function prepareCandidateRun({ sourcePath, workspaceRoot, logicalDocumentId, runId, taskJsonPath, taskMdPath }) {
  assertSafeRunId(runId);
  const realSource = resolveSourcePath(sourcePath);
  const runsDir = path.join(workspaceRoot, "runs", runId);
  // 路径穿越防御:runsDir 的 realpath 必须落在 workspaceRoot/runs 下
  fs.mkdirSync(runsDir, { recursive: true });
  fs.chmodSync(runsDir, 0o700);
  const realRuns = fs.realpathSync(runsDir);
  const realRoot = fs.realpathSync(path.join(workspaceRoot, "runs"));
  if (realRuns !== realRoot && !realRuns.startsWith(realRoot + path.sep)) {
    try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch (_) {}
    fail("RUNS_PATH_ESCAPE", "runs dir escapes workspace: " + runsDir);
  }
  const snapshotPath = path.join(runsDir, "source.html");
  const candidatePath = path.join(runsDir, "candidate.html");
  const sourceSha256Before = sha256File(realSource);
  fs.copyFileSync(realSource, snapshotPath);
  fs.chmodSync(snapshotPath, 0o400); // 只读 snapshot
  const snapshotHash = sha256File(snapshotPath);
  if (snapshotHash !== sourceSha256Before) {
    try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch (_) {}
    fail("SNAPSHOT_HASH_MISMATCH", "source snapshot hash differs from source after copy");
  }
  // task bundle 复制进 run cwd(只读),使 Claude 在 cwd 内即可读 task 与 source
  if (taskJsonPath) { fs.copyFileSync(taskJsonPath, path.join(runsDir, path.basename(taskJsonPath))); fs.chmodSync(path.join(runsDir, path.basename(taskJsonPath)), 0o400); }
  if (taskMdPath) { fs.copyFileSync(taskMdPath, path.join(runsDir, path.basename(taskMdPath))); fs.chmodSync(path.join(runsDir, path.basename(taskMdPath)), 0o400); }
  return { runsDir, snapshotPath, candidatePath, sourceSha256Before, sourceByteLength: fs.statSync(realSource).size, realSource };
}

// 写 candidate-manifest.json(spec §3.3);ready 与失败 status 都写(若目录已建)
export function writeManifest({ runsDir, runId, logicalDocumentId, provider, sourcePath, sourceSha256Before, sourceSha256After, candidateResultPath, candidateWorkspacePath, candidateSha256, candidateByteLength, changeContractSha256, sessionId, status }) {
  const manifest = {
    schema_version: 1,
    kind: "htmlgenius_candidate_manifest",
    run_id: runId,
    logical_document_id: logicalDocumentId,
    provider: provider || "claude_code_cli",
    source: { path: sourcePath, sha256_before: sourceSha256Before, sha256_after: sourceSha256After || null },
    candidate: candidateResultPath ? {
      workspace_path: candidateWorkspacePath || null,
      result_path: candidateResultPath,
      sha256: candidateSha256 || null,
      byte_length: candidateByteLength || 0
    } : null,
    change_contract_sha256: changeContractSha256,
    session: sessionId ? { id: sessionId, ownership: "htmlgenius" } : null,
    created_at: new Date().toISOString(),
    status: status
  };
  const mp = path.join(runsDir, "candidate-manifest.json");
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try { fs.chmodSync(mp, 0o600); } catch (_) {}
  return mp;
}

// 校验 candidate 形态(spec §3.4.5/6):存在/regular/非 symlink/大小>0且≤cap/UTF-8 含 HTML 头
export function validateCandidate(candidatePath, sourceByteLength) {
  let lst;
  try { lst = fs.lstatSync(candidatePath); }
  catch (e) { fail("CANDIDATE_MISSING", "candidate.html not produced: " + candidatePath); }
  if (lst.isSymbolicLink()) fail("CANDIDATE_SYMLINK", "candidate.html must not be a symlink");
  if (!lst.isFile()) fail("CANDIDATE_NOT_FILE", "candidate.html not a regular file");
  if (lst.size === 0) fail("CANDIDATE_EMPTY", "candidate.html is empty");
  const cap = Math.min(MAX_CANDIDATE_BYTES, Math.max(MAX_CANDIDATE_BYTES, (sourceByteLength || 0) * 10));
  if (lst.size > cap) fail("CANDIDATE_TOO_LARGE", "candidate.html too large: " + lst.size + " > " + cap);
  const buf = fs.readFileSync(candidatePath);
  let text;
  try { text = buf.toString("utf8"); }
  catch (e) { fail("CANDIDATE_NOT_UTF8", "candidate.html not readable as UTF-8"); }
  if (!HTML_HEAD_RE.test(text.trimStart())) fail("CANDIDATE_INVALID_HTML", "candidate.html lacks <!doctype html> or <html> (possibly Markdown/text)");
  return { bytes: buf, sha256: sha256Bytes(buf), byteLength: lst.size };
}

// 成功后原子复制 sibling(spec §3.2/3.4.7):同名已存在不覆盖
export function publishSiblingCandidate({ candidatePath, sourcePath, runId }) {
  const realSource = resolveSourcePath(sourcePath);
  const resultPath = path.join(path.dirname(realSource), siblingCandidateName(realSource, runId));
  if (fs.existsSync(resultPath)) fail("CANDIDATE_NAME_CONFLICT", "sibling candidate already exists (won't overwrite): " + resultPath);
  const tmp = resultPath + ".tmp." + process.pid + "." + Date.now();
  fs.copyFileSync(candidatePath, tmp);
  try { fs.renameSync(tmp, resultPath); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  return resultPath;
}

// 失败时隔离/清理 workspace candidate(spec §3.4.4):不创建 sibling
export function quarantineCandidate(runsDir) {
  const cp = path.join(runsDir, "candidate.html");
  try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch (_) {}
}

// v0.8.1 §6.8:candidate 携带 approved_plan → 写只读 approved-plan.md(≤12KiB)进 run 目录。
// 原计划只是辅助执行约束,不替代 Change Contract;Agent 仍只输出 candidate.html。
export function writeApprovedPlan({ runsDir, editedPlanMarkdown }) {
  const body = String(editedPlanMarkdown || "").slice(0, 12 * 1024);
  const p = path.join(runsDir, "approved-plan.md");
  fs.writeFileSync(p, body, { mode: 0o400 });
  try { fs.chmodSync(p, 0o400); } catch (_) {}
  return p;
}
