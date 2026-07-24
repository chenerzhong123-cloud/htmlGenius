// bridge/test/npm-publish-readiness.test.mjs — v0.9.1:@htmlgenius/bridge 可发布 + 下拉教程接线(源码级断言)。
// 目标:任何 macOS 用户 `npx --yes @htmlgenius/bridge@<ver> setup` 即可装 bridge;未连接时下拉弹窗内嵌教程。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(__dirname, "..");
const extDir = path.resolve(__dirname, "..", "..", "extension");
const pkg = JSON.parse(fs.readFileSync(path.join(bridgeDir, "package.json"), "utf8"));

test("npm 可发布:@htmlgenius/bridge,非 private,public access,锁 copilot-sdk", () => {
  assert.equal(pkg.name, "@htmlgenius/bridge", "包名须为 scoped @htmlgenius/bridge(与 bootstrap 命令一致)");
  assert.ok(pkg.private !== true, "不得 private:true,否则无法发布");
  assert.equal(pkg.publishConfig && pkg.publishConfig.access, "public", "scoped 包须显式 public");
  assert.equal(pkg.dependencies["@github/copilot-sdk"], "1.0.7", "copilot-sdk 精确锁版");
});

test("npm files 白名单:含 bin/ 与根级 *.mjs,排除 test/verify(发布产物自包含)", () => {
  assert.ok(Array.isArray(pkg.files), "须有 files 白名单");
  assert.ok(pkg.files.includes("bin/"), "含 bin/(受控 CLI)");
  assert.ok(pkg.files.includes("*.mjs"), "含根级 *.mjs(host 与运行时模块)");
  assert.ok(!pkg.files.some((f) => /test|verify/.test(f)), "白名单不显式含 test/verify");
  // bin 指向的文件必须真实存在
  assert.ok(fs.existsSync(path.join(bridgeDir, pkg.bin["htmlgenius-bridge"])), "CLI bin 存在");
  assert.ok(fs.existsSync(path.join(bridgeDir, pkg.bin["htmlgenius-bridge-host"])), "host bin 存在");
});

test("扩展与 bridge 版本对齐:manifest 版本 == bridge 包版本", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "扩展版本与 bridge 包版本一致(bootstrap TARGET 指向它)");
});

test("bootstrap 生产态命令:指向已发布包名与固定版本(无 latest)", () => {
  const bg = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
  assert.match(bg, /BOOTSTRAP_DISTRIBUTION = "production"/);
  const m = bg.match(/TARGET_BRIDGE_VERSION = "([^"]+)"/);
  assert.ok(m, "有 TARGET_BRIDGE_VERSION");
  assert.equal(m[1], pkg.version, "TARGET_BRIDGE_VERSION == bridge 包版本");
  assert.ok(bg.includes("@htmlgenius/bridge@\" + TARGET_BRIDGE_VERSION"), "npx 命令用 @htmlgenius/bridge@<ver>");
  assert.ok(!/@htmlgenius\/bridge@latest/.test(bg), "不得用 latest");
});

test("下拉教程:send-menu 内嵌 setup 块,位于 agent 列表之前,含命令位 + 复制按钮", () => {
  const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
  const setupIdx = html.indexOf('id="contract-send-setup"');
  const agentIdx = html.indexOf('data-provider="claude_code_cli"');
  assert.ok(setupIdx > -1, "有 contract-send-setup 块");
  assert.ok(setupIdx < agentIdx, "教程块在 agent 列表之前(未连接时最显眼)");
  assert.ok(html.includes('id="contract-send-setup-cmd"'), "有命令展示位");
  assert.ok(html.includes('id="contract-send-setup-copy"'), "有复制按钮");
  assert.match(html, /id="contract-send-setup" hidden/, "默认隐藏(有 ready provider 时不显示)");
});

test("下拉教程逻辑:无 ready provider 才显示,命令取自 bootstrap.terminal_command", () => {
  const sp = fs.readFileSync(path.join(extDir, "sidepanel.js"), "utf8");
  assert.match(sp, /function renderSendSetup\(\)/, "有 renderSendSetup");
  assert.match(sp, /readyCount > 0\) \{ box\.hidden = true/, "有 ready 即隐藏");
  assert.match(sp, /_bootstrap\.terminal_command/, "命令取自 bootstrap.terminal_command");
  assert.match(sp, /renderSendSetup\(\);/, "在 renderProviderMenu 末尾调用");
  assert.match(sp, /getElementById\("contract-send-setup-copy"\)/, "复制按钮已接线");
});

test("下拉教程三语文案齐全(zh/en/ja)", () => {
  const i18n = fs.readFileSync(path.join(extDir, "i18n.js"), "utf8");
  for (const key of ["bridge.setupTitle", "bridge.setupStep1", "bridge.setupStep2", "bridge.copyCmd", "bridge.copied"]) {
    const count = (i18n.match(new RegExp('"' + key.replace(/\./g, "\\.") + '":', "g")) || []).length;
    assert.equal(count, 3, key + " 须有 zh/en/ja 三条");
  }
});
