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
export const MAX_APPROVED_PLAN_BYTES = 12 * 1024;        // §6.8:approved-plan.md ≤12KiB(plan_markdown 上限)
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

// —— candidate 执行前言(Night Pack A spec §4.3):不可省略;prompt 是协作约束,host hash/manifest/artifact 协议才是可信边界。
// cwd=runs/<runId>,source.html 与 task-<runId>.* 均在当前目录(由 prepareCandidateRun 复制)。
export function buildCandidatePrompt({ runId, task }) {
  const prelude = [
    "You are executing a task inside HTML Genius's controlled candidate workspace.",
    "",
    "- Only read source.html and task-" + runId + ".md / task-" + runId + ".json in the current directory.",
    "- Only write the final, complete, directly-openable HTML to candidate.html in the current directory.",
    "- Do not modify source.html, the task files, or any other file; do not use shell, network, MCP, or the browser.",
    "- Do not emit Markdown files, diffs, explanations, or multiple candidate files instead of candidate.html.",
    "- Strictly follow the Change Contract below; anything it does not permit must stay unchanged.",
    "- If a target cannot be uniquely located, do not guess; keep the corresponding source content and note it briefly in your final text."
  ].join("\n");
  const rendered = ChangeContract.renderPrompt(task);
  return prelude + "\n\n## Change Contract (execute strictly)\n" + rendered;
}

// —— Codex App Server 执行前言(v0.8 spec §6.4,固定、不可由用户覆盖)——
// 与 buildCandidatePrompt 语义等价(都是受控候选工作区),按 spec §6.4 中文原文;前言在 renderPrompt 之前拼接。
export function buildCodexPrompt({ task }) {
  const prelude = [
    "你正在 HTML Genius 的受控候选工作区中执行任务。",
    "",
    "- 只读取当前目录中的 source.html 以及 task bundle。",
    "- 只将最终、完整、可直接打开的 HTML 写入当前目录的 candidate.html。",
    "- 不要修改 source.html、task bundle、其它文件;不要使用网络、MCP、外部插件或其它工作目录。",
    "- 严格遵守 Change Contract。无法唯一定位目标时,保留该内容并在最终消息中说明。",
    "- 不要以 Markdown、diff、解释文本或多个文件替代 candidate.html。"
  ].join("\n");
  return prelude + "\n\n## Change Contract (execute strictly)\n" + ChangeContract.renderPrompt(task);
}

// —— v0.8.1 受控 Plan 执行前言(spec §6.4,固定英文原文,不可由用户覆盖)——
// Agent 唯一允许输出 output/plan.json(schema v1)。Prompt 是协作约束;真正的强约束是
// workspace 目录、source/task hash 前后校验、固定文件名、validator 和 Host completion 校验。
export function buildPlanPrompt({ runId, task }) {
  const prelude = [
    "You are preparing an HTML Genius change plan in a controlled workspace.",
    "- Read only source.html and the task bundle in the current directory.",
    "- Do not modify source.html, task files, or any other input.",
    "- Do not create candidate.html or edit the original document.",
    "- Write exactly one UTF-8 JSON file to output/plan.json matching the required schema.",
    "- State only the user-reviewable change plan and out-of-scope boundaries; do not include hidden reasoning.",
    "- Do not use shell, network, browser, MCP, plugins, hooks, credentials, or other directories."
  ].join("\n");
  const schema = [
    "",
    "## Required output schema (output/plan.json, UTF-8, max 16 KiB)",
    "```json",
    "{",
    '  "schema_version": 1,',
    '  "kind": "htmlgenius_change_plan",',
    '  "summary": "one-sentence goal (non-empty, <=1 KiB UTF-8)",',
    '  "plan_markdown": "1. ...\\n2. ... (non-empty, <=12 KiB UTF-8)",',
    '  "out_of_scope": ["will not change (0-20 items, each <=512 bytes)"]',
    "}",
    "```"
  ].join("\n");
  return prelude + schema + "\n\n## Change Contract (plan only within its boundaries)\n" + ChangeContract.renderPrompt(task);
}

// —— v0.8.1 §6.8:把用户审核后的计划作为 candidate 执行的辅助约束 ——
// Host 限长(≤12KiB)后写入只读 approved-plan.md,并把这段固定前言 + 计划文本追加到 candidate prompt。
// 原计划不是扩大修改范围的通行证:Agent 仍只能输出 candidate.html,且 Change Contract 是硬边界。
export function approvedPlanPreamble(editedPlanMarkdown) {
  const body = String(editedPlanMarkdown || "").slice(0, MAX_APPROVED_PLAN_BYTES);
  return "\n\n## Approved implementation plan\n" +
    "Implement this reviewed plan only insofar as it is consistent with the Change Contract.\n" +
    "The Change Contract is the hard boundary. If the plan conflicts with it, preserve the Contract boundary.\n\n" +
    body;
}
