// bridge/run-manager.mjs — candidate run 的文件/哈希/candidate/sandbox 逻辑(§7.1)。
// 纯本地文件操作 + SHA-256;不碰 chrome、不连 Codex(那是 app-server-client 的事)。
// 关键不变量:原文件字节哈希在整个 run 后仍等于启动前;base 不一致即停,绝不写 DOM/不导航。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024; // 10 MiB(§7.1)

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}

export function generateRunId() {
  return "hgr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

// 安全解析 artifact_uri(§7.1):必须 file:、存在、regular file、.html/.htm、<=10MiB。
export function resolveSourceArtifact(artifactUri) {
  if (typeof artifactUri !== "string" || !/^file:/i.test(artifactUri)) {
    fail("NOT_FILE_URI", "artifact_uri must be a file: URL");
  }
  let p;
  try { p = fileURLToPath(artifactUri); }
  catch (e) { fail("NOT_FILE_URI", "cannot parse artifact_uri as file URL"); }
  let stat;
  try { stat = fs.statSync(p); }
  catch (e) { fail("SOURCE_NOT_FOUND", "source file not found: " + p); }
  if (stat.isDirectory()) fail("SOURCE_IS_DIRECTORY", "artifact_uri is a directory: " + p);
  if (!/\.html?$/i.test(p)) fail("SOURCE_NOT_HTML", "source must be .html/.htm: " + p);
  if (stat.size > MAX_ARTIFACT_BYTES) fail("SOURCE_TOO_LARGE", "source > 10 MiB: " + stat.size);
  return { sourcePath: p };
}

// candidate 目录:<source-parent>/.htmlgenius-candidates/<run-id>/,权限 0700。
export function createCandidateDir(sourcePath, runId) {
  const parent = path.dirname(sourcePath);
  const candidateDir = path.join(parent, ".htmlgenius-candidates", runId);
  fs.mkdirSync(candidateDir, { recursive: true });
  try { fs.chmodSync(candidateDir, 0o700); } catch (_) {}
  return { candidateDir, resultPath: path.join(candidateDir, "result.html") };
}

export function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

// 启动前:解析 source、建 candidate、读 source hash 并比对 base;不一致即删 candidate 并失败。
export function prepareRun({ source, runId }) {
  const { artifact_uri, base_artifact_hash } = source || {};
  const { sourcePath } = resolveSourceArtifact(artifact_uri);
  const { candidateDir, resultPath } = createCandidateDir(sourcePath, runId);
  const sourceHash = sha256File(sourcePath);
  if (sourceHash !== base_artifact_hash) {
    try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch (_) {}
    fail("SOURCE_CHANGED_BEFORE_START", "source hash differs from base before start", {
      current_hash: sourceHash, expected: base_artifact_hash
    });
  }
  return {
    sourcePath, candidateDir, resultPath,
    sourceParent: path.dirname(sourcePath),
    confirmedBaseHash: sourceHash
  };
}

// 结束后:重读 source(必须未变)→ 校验 result.html → 算 candidate hash → 构造 completion。
export function finalizeRun(ctx) {
  const { sourcePath, confirmedBaseHash, candidateDir, resultPath, runId, logicalDocumentId, threadId, turnId } = ctx;
  const afterHash = sha256File(sourcePath); // §7.1 再次读 source
  if (afterHash !== confirmedBaseHash) {
    try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch (_) {}
    fail("SOURCE_MUTATED", "source file changed during run", { current_hash: afterHash, base: confirmedBaseHash });
  }
  let st;
  try { st = fs.statSync(resultPath); }
  catch (e) { fail("NO_RESULT", "result.html not produced: " + resultPath); }
  if (!st.isFile()) fail("NO_RESULT", "result.html is not a regular file");
  if (st.size > MAX_ARTIFACT_BYTES) {
    try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch (_) {}
    fail("RESULT_TOO_LARGE", "result.html > 10 MiB: " + st.size);
  }
  const resultHash = sha256File(resultPath);
  if (resultHash === confirmedBaseHash) {
    try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch (_) {}
    fail("NO_ARTIFACT_CHANGE", "result.html identical to source; nothing to open");
  }
  return {
    type: "bridge_completed",
    run_id: runId,
    logical_document_id: logicalDocumentId,
    thread_id: threadId || null,
    turn_id: turnId || null,
    source: "bridge",
    result_kind: "new_artifact",
    base_artifact_hash: confirmedBaseHash,
    result_artifact_hash: resultHash,
    result_artifact_uri: pathToFileURL(resultPath).href
  };
}

// sandbox policy(§7.1):workspaceWrite 只写 candidate;source parent 只读;关网;approvalPolicy=never。
export function buildSandboxPolicy({ candidateDir, sourceParent }) {
  return {
    approvalPolicy: "never",
    sandboxMode: "workspaceWrite",
    writableRoots: [candidateDir],
    readOnlyAccess: { readableRoots: [sourceParent] },
    cwd: candidateDir,
    networkAccess: false
  };
}
