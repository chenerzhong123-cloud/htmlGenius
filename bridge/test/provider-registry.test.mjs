// bridge/test/provider-registry.test.mjs — v0.9.1 §3:provider registry 与 extension 元数据一致性硬门。
// 新增 provider 时两侧必须同步,本测试是漂移防线(§3.1 最后一句)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  PROVIDER_REGISTRY, listProviderIds, getProviderDescriptor, providerSupports, assertProviderDescriptor
} from "../provider-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "..", "..", "extension");
const require = createRequire(import.meta.url);
const EXT = require(path.join(extDir, "provider-metadata.js"));

const FIELDS = ["id", "label_key", "capabilities", "dispatch_type", "probe", "runtime_policy", "supports_real_smoke"];

test("registry:三家 provider + descriptor 严格合法 + API 行为", () => {
  assert.deepEqual(listProviderIds().slice().sort(), ["claude_code_cli", "codex_app_server", "github_copilot"]);
  for (const id of listProviderIds()) {
    assertProviderDescriptor(PROVIDER_REGISTRY[id]); // 形状不合法直接抛
    assert.equal(getProviderDescriptor(id).id, id);
  }
  assert.equal(getProviderDescriptor("rogue_provider"), null, "allow-list 外 → null");
  assert.equal(getProviderDescriptor(null), null);
  assert.equal(providerSupports("github_copilot", "candidate"), true);
  assert.equal(providerSupports("github_copilot", "handoff"), false);
  assert.equal(providerSupports("rogue", "candidate"), false);
  // 不可变
  assert.throws(() => { PROVIDER_REGISTRY.rogue = {}; }, TypeError);
});

test("一致性:bridge registry 与 extension provider-metadata 逐字段相同", () => {
  assert.deepEqual(EXT.listProviderIds().slice().sort(), listProviderIds().slice().sort());
  for (const id of listProviderIds()) {
    const a = getProviderDescriptor(id);
    const b = EXT.getProviderDescriptor(id);
    assert.ok(b, "extension 元数据缺 " + id);
    for (const f of FIELDS) {
      assert.deepEqual(b[f], a[f], "字段漂移 " + id + "." + f + " — 两个文件必须同步修改");
    }
  }
  assert.equal(EXT.getProviderDescriptor("rogue"), null);
});

test("一致性:host.mjs 对每个 registry dispatch_type 有分发分支,probe 默认走 registry", () => {
  const host = fs.readFileSync(path.resolve(__dirname, "..", "host.mjs"), "utf8");
  for (const id of listProviderIds()) {
    const dt = getProviderDescriptor(id).dispatch_type;
    assert.ok(host.includes('"' + dt + '"'), "host.mjs 缺 dispatch 分支: " + dt);
  }
  assert.match(host, /listProviderIds\(\)/, "host provider_probe 默认应走 registry");
  const probe = fs.readFileSync(path.resolve(__dirname, "..", "provider-probe.mjs"), "utf8");
  assert.match(probe, /probeProviders\(providers = listProviderIds\(\)/);
});

test("一致性:i18n 三语言含每个 provider 的 label_key(无 fallback 空串)", () => {
  const sandboxWindow = {};
  const prev = { window: globalThis.window, navigator: globalThis.navigator };
  globalThis.window = sandboxWindow;
  globalThis.navigator = { languages: ["en"], language: "en" };
  try { (0, eval)(fs.readFileSync(path.join(extDir, "i18n.js"), "utf8")); } // eslint-disable-line no-eval
  finally { globalThis.window = prev.window; globalThis.navigator = prev.navigator; }
  const DICT = sandboxWindow.HG_I18N.DICT;
  for (const id of listProviderIds()) {
    const key = getProviderDescriptor(id).label_key;
    for (const lang of ["zh", "en", "ja"]) {
      const v = DICT[lang][key];
      assert.ok(typeof v === "string" && v.length > 0, lang + " 缺 " + key);
    }
  }
});

test("sidepanel 加载 provider-metadata.js 且 providerLabel 走 label_key", () => {
  const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
  assert.match(html, /<script src="provider-metadata\.js"><\/script>/);
  assert.ok(html.indexOf('<script src="provider-metadata.js">') < html.indexOf('<script src="sidepanel.js">'), "须先于 sidepanel.js 加载");
  const sp = fs.readFileSync(path.join(extDir, "sidepanel.js"), "utf8");
  assert.match(sp, /ProviderMetadata\.getProviderDescriptor\(id\)/);
  assert.match(sp, /t\(d\.label_key\)/);
});

test("descriptor 不含敏感/动态键(路径/命令/token/可执行函数)", () => {
  for (const id of listProviderIds()) {
    const d = PROVIDER_REGISTRY[id];
    for (const bad of ["path", "command", "argv", "token", "cookie", "session", "exec", "fn", "url", "env"]) {
      assert.ok(!(bad in d), id + " descriptor 不得含 " + bad);
    }
    for (const v of Object.values(d)) {
      assert.ok(typeof v !== "function", id + " descriptor 不得含函数");
    }
  }
});
