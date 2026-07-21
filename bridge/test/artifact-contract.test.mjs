// bridge/test/artifact-contract.test.mjs — 锁定 background↔content-script 的 artifact-update-ready 字段契约。
// 背景:Night Pack A candidate 闭环卡死两轮。根因是 background completeCandidate 发 `result_uri`,
// 而 content-script handleArtifactUpdateReady 校验 `msg.result_artifact_uri` —— 字段名不一致 → 永远
// VALIDATION_ERROR → background 判 CONSUMER_REJECTED → 卡在「生成中」。再加上 952cce7 之前还漏发
// result_artifact_hash。两处都是「扩展两端字段名分叉」,自动测试从没覆盖过这条跨进程契约。
// 此测试用源码级断言锁住两端字段名一致。虽然跨界读 extension/ 源码,但这是目前最直接的防回归手段。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "..", "..", "extension");
const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const cs = fs.readFileSync(path.join(EXT, "content-script.js"), "utf8");

// 截 background completeCandidate 里 tabs.sendMessage(artifact-update-ready) 的消息字面量。
const sendStart = bg.indexOf('type: "artifact-update-ready"');
const sendEnd = bg.indexOf("}).catch(() => null);", sendStart);
const bgSendBlock = bg.slice(sendStart, sendEnd);

test("background artifact-update-ready 消息含 content-script 校验所需全部字段", () => {
  // 对照 content-script.js handleArtifactUpdateReady 的校验行
  for (const f of [
    'source: "bridge"',
    "result_kind:",
    "base_artifact_hash:",
    "result_artifact_hash:",   // 952cce7 修复点
    "logical_document_id:",
    "result_artifact_uri:",    // 本轮修复点(旧误写 result_uri)
  ]) {
    assert.ok(bgSendBlock.includes(f), "background artifact-update-ready 缺字段: " + f);
  }
});

test("background 不得写 result_uri(必须 result_artifact_uri,否则 content-script 判 VALIDATION_ERROR)", () => {
  assert.doesNotMatch(bgSendBlock, /result_uri:/, "又写成 result_uri,应为 result_artifact_uri");
});

test("content-script handleArtifactUpdateReady 仍校验 result_artifact_uri / result_artifact_hash", () => {
  assert.match(cs, /msg\.result_artifact_uri/, "content-script 不再校验 result_artifact_uri");
  assert.match(cs, /msg\.result_artifact_hash/, "content-script 不再校验 result_artifact_hash");
});
