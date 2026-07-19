// bridge/task-bundle.mjs — v0.7.1 Claude handoff 的本地文件证据层(spec §3/§7)。
// 职责:source 校验与哈希、稳定 workspace、canonical task bundle(JSON + md)、SHA-256、固定交接 prompt。
// 纯 Node 文件操作:不碰 chrome、不碰网络、不启动子进程。stdout 不写任何东西。
//
// 关键不变量:
// - workspace 固定为 <source-parent>/.htmlgenius-bridge/claude/<logical-document-id>/
//   (Claude CLI 的 `--resume <uuid>` 只搜索当前项目目录;目录不稳定,已记录 session 就无法续发)
// - task bundle 是本地可审计的传输证据:0700 目录、0600 文件;绝不复制到 ~/Library、IndexedDB 或任何服务器
// - task_sha256 以 canonical JSON(JSON.stringify(task,null,2))的原始 UTF-8 bytes 计算,
//   host 与 extension background 用同一算法对照,任何不一致即拒绝
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ChangeContract = require("../extension/change-contract.js");

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;      // 10 MiB(source 上限)
export const MAX_TASK_JSON_BYTES = 1 * 1024 * 1024;      // 1 MiB(task bundle 不超过 native 帧上限)
export const BRIDGE_DIR_NAME = ".htmlgenius-bridge";
export const PROVIDER_DIR_NAME = "claude";

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}

export function generateRunId() {
  return "hgr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

// —— 哈希:唯一算法源(host 与 background 都以此对照)——
export function sha256Bytes(buf) {
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}
export function sha256File(absPath) {
  return sha256Bytes(fs.readFileSync(absPath));
}
export function isSha256Tagged(v) {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
}

// canonical task JSON —— 与 extension/change-contract.js 的 serialize 完全一致(同一真相源)。
export function canonicalTaskJson(task) {
  return JSON.stringify(task, null, 2);
}
export function taskSha256(task) {
  return sha256Bytes(Buffer.from(canonicalTaskJson(task), "utf8"));
}

// —— source artifact 安全解析(§7 步骤2):必须 file:、存在、regular file、.html/.htm、≤10MiB ——
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
  if (!stat.isFile()) fail("SOURCE_NOT_FILE", "artifact_uri is not a regular file: " + p);
  if (!/\.html?$/i.test(p)) fail("SOURCE_NOT_HTML", "source must be .html/.htm: " + p);
  if (stat.size > MAX_ARTIFACT_BYTES) fail("SOURCE_TOO_LARGE", "source > 10 MiB: " + stat.size);
  return { sourcePath: p };
}

// 启动前校验 source 哈希与 base 一致;不一致即 SOURCE_CHANGED_BEFORE_START。
export function verifySourceHash({ sourcePath, expectedHash }) {
  const current = sha256File(sourcePath);
  if (current !== expectedHash) {
    fail("SOURCE_CHANGED_BEFORE_START", "source hash differs from base before start", {
      current_hash: current, expected: expectedHash
    });
  }
  return current;
}

// —— 稳定 workspace(§3):<source-parent>/.htmlgenius-bridge/claude/<logical-document-id>/,0700 ——
// logical-document-id 白名单校验,防路径穿越。
export function workspacePathFor({ sourcePath, logicalDocumentId }) {
  if (typeof logicalDocumentId !== "string" || !/^[A-Za-z0-9_:-]{1,128}$/.test(logicalDocumentId)) {
    fail("BAD_LOGICAL_ID", "logical_document_id must match [A-Za-z0-9_:-]{1,128}");
  }
  return path.join(path.dirname(sourcePath), BRIDGE_DIR_NAME, PROVIDER_DIR_NAME, logicalDocumentId);
}

export function createWorkspace({ sourcePath, logicalDocumentId }) {
  const ws = workspacePathFor({ sourcePath, logicalDocumentId });
  fs.mkdirSync(ws, { recursive: true });
  // bridge 链路上的每一级目录都收 0700(证据目录不向其他用户开放)
  const sourceParent = path.dirname(sourcePath);
  for (let d = ws; d !== sourceParent && d !== path.dirname(d); d = path.dirname(d)) {
    try { fs.chmodSync(d, 0o700); } catch (_) { /* 尽力,非致命 */ }
  }
  return ws;
}

// —— task schema 入口校验(§7 步骤1):版本/kind/大小 ——
export function assertTaskSchema(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) fail("BAD_TASK", "task must be an object");
  if (task.schema_version !== 1) fail("BAD_TASK_SCHEMA", "unsupported schema_version: " + task.schema_version);
  if (task.kind !== "htmlgenius_change_contract") fail("BAD_TASK_SCHEMA", "unexpected kind: " + task.kind);
  if (!["precise_patch", "local_optimize", "regenerate"].includes(task.mode)) {
    fail("INVALID_MODE", "mode not bridge-eligible: " + task.mode);
  }
  const json = canonicalTaskJson(task);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.byteLength > MAX_TASK_JSON_BYTES) fail("TASK_TOO_LARGE", "task JSON > 1 MiB: " + bytes.byteLength);
  return json;
}

// —— task bundle 落盘(§7 步骤3/4):task-<run-id>.json + task-<run-id>.md,均 0600 ——
export function writeTaskBundle({ workspace, runId, task, sourcePath, baseArtifactHash }) {
  if (typeof runId !== "string" || !/^hgr_[A-Za-z0-9]{12,48}$/.test(runId)) {
    fail("BAD_RUN_ID", "run_id must match hgr_*");
  }
  const json = assertTaskSchema(task);
  const jsonBytes = Buffer.from(json, "utf8");
  const taskSha = sha256Bytes(jsonBytes);

  const jsonPath = path.join(workspace, "task-" + runId + ".json");
  const mdPath = path.join(workspace, "task-" + runId + ".md");
  fs.writeFileSync(jsonPath, jsonBytes, { mode: 0o600 });
  try { fs.chmodSync(jsonPath, 0o600); } catch (_) {}
  const md = buildBundleMarkdown({ task, runId, jsonPath, taskSha, sourcePath, baseArtifactHash });
  fs.writeFileSync(mdPath, md, { mode: 0o600 });
  try { fs.chmodSync(mdPath, 0o600); } catch (_) {}
  return { jsonPath, mdPath, taskSha256: taskSha, taskJson: json };
}

// task.md = 固定安全前言 + 人可读 prompt(ChangeContract.renderPrompt)+ 传输元数据。
function buildBundleMarkdown({ task, runId, jsonPath, taskSha, sourcePath, baseArtifactHash }) {
  const rootIds = ((task.source && task.source.root_annotation_ids) || []).join(", ") || "(none)";
  const parts = [];
  parts.push("# HTML Genius Change Contract — Claude Code Handoff");
  parts.push("");
  parts.push("## Safety preamble (do not relax)");
  parts.push("- This handoff is for ACKNOWLEDGEMENT ONLY. Do not modify any file.");
  parts.push("- Do not run shell commands, use the browser or network, MCP, plugins, hooks, or ask for credentials.");
  parts.push("- Read the task JSON at the path below, verify its hash, and reply with a concise acknowledgement.");
  parts.push("");
  parts.push("## Transport");
  parts.push("- run_id: " + runId);
  parts.push("- task JSON: " + jsonPath);
  parts.push("- task SHA-256: " + taskSha);
  parts.push("- root annotation IDs: " + rootIds);
  parts.push("- source HTML (read-only reference): " + sourcePath);
  parts.push("- source baseline SHA-256: " + baseArtifactHash);
  parts.push("");
  parts.push("## Change Contract (human-readable)");
  parts.push(ChangeContract.renderPrompt(task));
  parts.push("");
  return parts.join("\n");
}

// —— 固定交接 prompt(§7):只含路径/哈希/run ID/root IDs,不含完整 contract 文本(contract 在 bundle 文件里)——
export function buildHandoffPrompt({ jsonPath, taskSha256, runId, rootAnnotationIds }) {
  const ids = Array.isArray(rootAnnotationIds) && rootAnnotationIds.length ? rootAnnotationIds.join(", ") : "(none)";
  return [
    "You are receiving an HTML Genius Change Contract for acknowledgement only.",
    "Read the task bundle at: " + jsonPath,
    "Verify its SHA-256 is: " + taskSha256 + ".",
    "Run ID: " + runId + ". Root annotation IDs: " + ids + ".",
    "Do not modify any file. Do not run shell commands, use the browser, network, MCP, plugins, or ask for credentials.",
    "Reply with a concise acknowledgement of the task mode and the root annotation IDs you received."
  ].join("\n");
}

// task 内的 root annotation IDs(供 host 组装 prompt / background 校验)。
export function rootAnnotationIdsOf(task) {
  const ids = task && task.source && task.source.root_annotation_ids;
  return Array.isArray(ids) ? ids.slice() : [];
}
