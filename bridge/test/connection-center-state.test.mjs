// bridge/test/connection-center-state.test.mjs — v0.9.1 §9.1:Connection Center 纯函数状态矩阵测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "..", "..", "extension");
const require = createRequire(import.meta.url);
const CCS = require(path.join(extDir, "connection-center-state.js"));

const H = (over) => Object.assign({
  schema_version: 1, overall: "action_required",
  bridge: { status: "install_required", version: null, protocol_version: 1, managed_install: false },
  browser: { status: "manifest_missing" }, providers: [], actions: [], reason_code: "BRIDGE_NOT_INSTALLED"
}, over);

test("矩阵:检查中(null health)", () => {
  const v = CCS.connStateFor(null, {});
  assert.equal(v.phase, "checking");
  assert.equal(v.titleKey, "conn.titleChecking");
  assert.equal(v.primary, null);
  assert.equal(v.repairAvailable, false);
});

test("矩阵:未安装 → 让 Agent 帮我连接 + Terminal;绝不出现安全修复;保留 Copy Prompt 提示", () => {
  const v = CCS.connStateFor(H(), {});
  assert.equal(v.titleKey, "conn.titleNotInstalled");
  assert.equal(v.primary.labelKey, "conn.agentSetup");
  assert.equal(v.primary.action, "setup");
  assert.equal(v.secondary.labelKey, "conn.copyTerminal");
  assert.equal(v.repairAvailable, false, "§5.2:BRIDGE_NOT_INSTALLED 不得出现安全修复");
  assert.equal(v.permanentHintKey, "conn.promptStillAvailable", "§0.2:复制 Prompt 降级提示");
});

test("矩阵:需修复(host 过旧)→ 让 Agent 帮我修复;repair_required → 安全修复可用", () => {
  const old = CCS.connStateFor(H({ reason_code: "BRIDGE_PROTOCOL_TOO_OLD", bridge: { status: "protocol_incompatible", protocol_version: 1 } }), {});
  assert.equal(old.titleKey, "conn.titleNeedRepair");
  assert.equal(old.primary.labelKey, "conn.agentRepair");
  assert.equal(old.repairAvailable, false, "host 过旧不能自修");

  const rep = CCS.connStateFor(H({ reason_code: "NATIVE_HOST_MANIFEST_MISSING", bridge: { status: "repair_required", protocol_version: 1 } }), {});
  assert.equal(rep.primary.labelKey, "conn.repair");
  assert.equal(rep.primary.action, "repair");
  assert.equal(rep.repairAvailable, true);
});

test("矩阵:OS 不支持 / 扩展需更新", () => {
  const osx = CCS.connStateFor(H({ reason_code: "OS_UNSUPPORTED" }), {});
  assert.equal(osx.titleKey, "conn.titleUnsupported");
  assert.equal(osx.primary, null, "不支持系统无主操作");
  const ext = CCS.connStateFor(H({ reason_code: "BRIDGE_PROTOCOL_TOO_NEW", bridge: { status: "protocol_incompatible", protocol_version: 9 } }), {});
  assert.equal(ext.titleKey, "conn.titleExtNeedUpdate");
});

test("矩阵:Bridge ready 无 provider → 逐项状态 + 检查连接;有 ready provider → 已连接 N 个 + 默认折叠", () => {
  const noProv = CCS.connStateFor(H({ overall: "action_required", reason_code: null, bridge: { status: "ready", protocol_version: 1 }, browser: { status: "origin_ok" }, providers: [{ id: "claude_code_cli", status: "auth_required" }] }), {});
  assert.equal(noProv.titleKey, "conn.titleBridgeReady");
  assert.equal(noProv.primary.labelKey, "conn.check");
  assert.equal(noProv.showProviders, true);
  assert.equal(noProv.collapsed, false);

  const ready = CCS.connStateFor(H({ overall: "ready", reason_code: null, bridge: { status: "ready", protocol_version: 1 }, browser: { status: "origin_ok" }, providers: [{ id: "codex_app_server", status: "ready" }, { id: "claude_code_cli", status: "auth_required" }] }), {});
  assert.equal(ready.titleKey, "conn.titleConnected");
  assert.equal(ready.readyCount, 1);
  assert.equal(ready.collapsed, true, "默认折叠不抢占发送动作");
  assert.equal(ready.permanentHintKey, null, "全就绪不再提示降级");
  // 用户手动覆盖折叠
  const expanded = CCS.connStateFor(H({ overall: "ready", reason_code: null, bridge: { status: "ready", protocol_version: 1 }, providers: [{ id: "codex_app_server", status: "ready" }] }), { userCollapsed: false });
  assert.equal(expanded.collapsed, false);
});

test("bootstrap 安全自检:干净模板通过;混入契约/评论/latest 即失败", () => {
  const clean = { setup_prompt: "请初始化 HTML Genius 本地连接。\nChrome Extension ID：abcdefghijklmnopabcdefghijklmnop\nnpx --yes @htmlgenius/bridge@0.9.1 setup --json --scope user --extension-id abcdefghijklmnopabcdefghijklmnop", terminal_command: "npx --yes @htmlgenius/bridge@0.9.1 setup --json --scope user --extension-id abcdefghijklmnopabcdefghijklmnop" };
  assert.deepEqual(CCS.assertBootstrapSafe(clean), []);
  const dirty = { setup_prompt: clean.setup_prompt + "\nchange_contract: {...} 评论: <div>hi</div>", terminal_command: "@latest" };
  const problems = CCS.assertBootstrapSafe(dirty);
  assert.ok(problems.some((p) => p.startsWith("BOOTSTRAP_CONTAINS:change_contract")));
  assert.ok(problems.some((p) => p.startsWith("BOOTSTRAP_CONTAINS:<div")));
  assert.ok(problems.includes("BOOTSTRAP_USES_LATEST"));
});

test("发送菜单只能选 ready provider(§2.3)", () => {
  const states = { claude_code_cli: { status: "auth_required" }, codex_app_server: { status: "ready" } };
  assert.equal(CCS.canSelectProvider(states, "codex_app_server"), true);
  assert.equal(CCS.canSelectProvider(states, "claude_code_cli"), false);
  assert.equal(CCS.canSelectProvider(states, "github_copilot"), false);
});

test("CSS:Connection Center 无横向滚动(overflow-x auto/scroll),评论区结构未被隐藏", () => {
  const css = fs.readFileSync(path.join(extDir, "sidepanel.css"), "utf8");
  const connBlocks = css.split("\n").filter((l) => /\.conn-/.test(l));
  for (const l of connBlocks) {
    assert.ok(!/overflow-x\s*:\s*(auto|scroll)/.test(l), "conn 样式不得横向滚动: " + l.trim());
  }
  const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
  assert.ok(html.includes('id="conn-center"'), "conn-center 存在");
  assert.ok(html.includes('id="contract-copy-prompt"'), "复制 Prompt 按钮仍在");
  assert.ok(html.includes('id="contract-send-menu"'), "发送菜单仍在");
});

test("sidepanel 由纯函数驱动且先加载 connection-center-state.js", () => {
  const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
  assert.ok(html.indexOf('<script src="connection-center-state.js">') < html.indexOf('<script src="sidepanel.js">'));
  const sp = fs.readFileSync(path.join(extDir, "sidepanel.js"), "utf8");
  assert.match(sp, /ConnectionCenterState\.connStateFor\(_health/);
});
