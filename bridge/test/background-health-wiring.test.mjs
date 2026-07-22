// bridge/test/background-health-wiring.test.mjs — v0.9 §4 background health/repair/bootstrap 接线(源码级断言)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "background.js"), "utf8");

test("v0.9:版本单一来源 — 无 0.8.1 漂移,扩展版本取 getManifest", () => {
  assert.ok(!bg.includes('"0.8.1"'), "不得残留硬编码 0.8.1");
  assert.match(bg, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(bg, /BRIDGE_PROTOCOL_VERSION = 1/);
  assert.match(bg, /TARGET_BRIDGE_VERSION = "0\.9\.0"/);
});

test("v0.9:三条新消息入口(仅 background 发起 native 通信)", () => {
  assert.match(bg, /msg\.type === "bridge-query-health"/);
  assert.match(bg, /msg\.type === "bridge-repair"/);
  assert.match(bg, /msg\.type === "bridge-get-bootstrap"/);
});

test("v0.9:bridge_health 请求带 protocol_version + extension{id,version}", () => {
  assert.match(bg, /type: "bridge_health", protocol_version: BRIDGE_PROTOCOL_VERSION, extension: \{ id: chrome\.runtime\.id, version: extensionVersion\(\) \}/);
});

test("v0.9:host 缺失/连接失败 → BRIDGE_NOT_INSTALLED 兜底(不透传 Chrome 原始错误)", () => {
  assert.match(bg, /notInstalledHealth\(/);
  assert.match(bg, /reason_code: reasonCode \|\| "BRIDGE_NOT_INSTALLED"/);
  assert.match(bg, /port\.onDisconnect\.addListener\(\(\) => finish\(fallback\(\)\)\)/);
});

test("v0.9:协议兼容分支 — 旧 host unknown_message → BRIDGE_PROTOCOL_TOO_OLD;host 过新 → BRIDGE_PROTOCOL_TOO_NEW", () => {
  assert.match(bg, /notInstalledHealth\("BRIDGE_PROTOCOL_TOO_OLD"\)/);
  assert.match(bg, /reason_code: "BRIDGE_PROTOCOL_TOO_NEW"/);
  assert.match(bg, /pv > BRIDGE_PROTOCOL_VERSION/);
});

test("v0.9:repair allow-list — 必须含 repair_native_host 才发;只透传该动作", () => {
  assert.match(bg, /confirmedActions\.includes\("repair_native_host"\)/);
  assert.match(bg, /confirmed_actions: \["repair_native_host"\]/);
  assert.match(bg, /code: "REPAIR_NOT_CONFIRMED"/);
});

test("v0.9:bootstrap 固定模板 — 变量仅 id/版本(严格校验),不得出现 latest,dev 态显著标注", () => {
  assert.match(bg, /\/\^\[a-p\]\{32\}\$\/\.test\(id/);
  assert.match(bg, /BOOTSTRAP_DISTRIBUTION = "development"/);
  assert.match(bg, /@htmlgenius\/bridge@" \+ TARGET_BRIDGE_VERSION/);
  assert.ok(!/@htmlgenius\/bridge@latest/.test(bg), "不得出现 latest");
  assert.match(bg, /仅开发环境|DEV ONLY/);
});

test("v0.9:bootstrap 模板不含用户内容注入点(无 change_contract/annotations/items 拼接)", () => {
  // 截取 makeBootstrap 函数体,确认其中不引用任何契约/评论内容
  const start = bg.indexOf("function makeBootstrap()");
  assert.ok(start > -1);
  const body = bg.slice(start, bg.indexOf("\n}", start) + 2);
  for (const forbidden of ["change_contract", "annotations", "items", "comment", "prompt_text", "artifact"]) {
    assert.ok(!body.includes(forbidden), "makeBootstrap 不得引用 " + forbidden);
  }
});

test("v0.9:provider probe / handoff 兼容保持(不因 health 改动回归)", () => {
  assert.match(bg, /type: "provider_probe"/);
  assert.match(bg, /HANDOFF_START_TYPES\[provider\]/);
});
