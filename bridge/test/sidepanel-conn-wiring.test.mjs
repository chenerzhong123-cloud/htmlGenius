// bridge/test/sidepanel-conn-wiring.test.mjs — v0.9 §8.1:Connection Center 接线(源码级断言)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sp = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "sidepanel.js"), "utf8");
const html = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "sidepanel.html"), "utf8");

test("HTML:conn-center 内嵌发送菜单，仅保留连接操作而不重复 Agent 列表", () => {
  for (const id of ["conn-center", "conn-primary", "conn-secondary", "conn-check", "conn-diag",
    "conn-repair-confirm", "conn-repair-ok", "conn-repair-cancel"]) {
    assert.ok(html.includes('id="' + id + '"'), "缺元素 " + id);
  }
  assert.ok(html.indexOf('id="conn-center"') > html.indexOf('id="contract-send-menu"'), "conn-center 应内嵌发送菜单");
  for (const id of ["conn-head", "conn-title", "conn-desc", "conn-providers", "conn-hint"]) {
    assert.ok(!html.includes('id="' + id + '"'), "不应保留重复的连接管理结构: " + id);
  }
});

test("JS:状态矩阵已移到 connection-center-state.js,sidepanel 由其驱动(§5.2/§9.1)", () => {
  const ccs = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "connection-center-state.js"), "utf8");
  assert.match(ccs, /rc === "OS_UNSUPPORTED"/);
  assert.match(ccs, /rc === "BRIDGE_PROTOCOL_TOO_NEW"/);
  assert.match(ccs, /bs === "install_required" \|\| rc === "BRIDGE_NOT_INSTALLED"/);
  assert.match(ccs, /rc === "BRIDGE_PROTOCOL_TOO_OLD" \|\| rc === "BRIDGE_FILES_CORRUPT"/);
  assert.match(ccs, /bs === "repair_required"/);
  assert.match(ccs, /bs === "ready" && readyCount > 0/);
  assert.match(sp, /ConnectionCenterState\.connStateFor\(_health/);
  assert.match(sp, /t\(st\.titleKey\)\.replace\("\{n\}"/);
});

test("JS:health 只认 reason_code/枚举;native 通信仅经 background 消息(不 connectNative)", () => {
  assert.match(sp, /type: "bridge-query-health"/);
  assert.match(sp, /type: "bridge-repair"/);
  assert.match(sp, /type: "bridge-get-bootstrap"/);
  assert.ok(!sp.includes("connectNative"), "sidepanel 不得直接发起 Native Messaging");
});

test("JS:修复必须二次确认(确认按钮才发 bridge-repair,带 confirmed_actions)", () => {
  assert.match(sp, /connRepairOk\) connRepairOk\.addEventListener/);
  assert.match(sp, /confirmed_actions: \["repair_native_host"\]/);
  // 主按钮 repair 只打开确认面板,不直接发
  assert.match(sp, /action === "repair"\) \{\n      if \(connRepairConfirm\) connRepairConfirm\.hidden = false;/);
});

test("JS:任何状态保留复制 Prompt(既有不变量)+ 打开契约即查 health", () => {
  assert.match(sp, /contractCopyPrompt\) contractCopyPrompt\.disabled = false/);
  assert.match(sp, /_health = null; _connCollapsed = null;\n    queryHealth\(\);/);
});

test("JS:诊断复制只输出 health JSON(§5.4);host 缺失用兜底形态", () => {
  assert.match(sp, /connCopy\(JSON\.stringify\(h, null, 2\), "conn\.diagCopied"\)/);
  assert.match(sp, /reason_code: "BRIDGE_NOT_INSTALLED", extension_version:/);
});

test("JS:扁平连接操作与 Copy Prompt 常驻提示由纯函数输出驱动", () => {
  assert.match(sp, /connHead && st\.collapsed \? " collapsed" : ""/);
  assert.match(sp, /st\.permanentHintKey \? t\(st\.permanentHintKey\) : ""/);
});

test("JS:检查连接(queryHealth)成功后立即同步 provider 状态进发送菜单(v0.9.4 回归修复)", () => {
  // 检查连接(bridge_health)与 provider_probe 是两条独立往返;点完「检查连接」必须立即把
  // health.providers 同步进 _providerStates 并重渲染,否则 Agent 选择器仍显示旧状态,用户看不出已连接。
  assert.match(sp, /_health\.providers\.forEach\(\(p\) => \{ if \(p && p\.id\) _providerStates\[p\.id\] = p;/);
});

test("JS:openContract 不再清空 provider 状态(v0.9.4:candidate 新页发送按钮置灰修复)", () => {
  // provider 状态是机器级;每次开契约清空会导致切到新标签页(如新生成的 candidate)时发送按钮置灰
  // ~2-3s(要等异步 probe/queryHealth 回来)。openContract 不得再 reset _providerStates。
  assert.ok(!sp.includes("_provider = null; _providerStates = {}; _providerCacheAt = 0;"),
    "openContract 不应再清空 provider 状态(candidate 页按钮置灰回归)");
});
