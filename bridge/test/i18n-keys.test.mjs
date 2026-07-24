// bridge/test/i18n-keys.test.mjs — v0.9 §8.1:三语言 key 完整性 + HTML data-i18n 引用存在性。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "..", "..", "extension");

function loadDict() {
  // i18n.js 是 window IIFE:桩 window/navigator 后加载,取 DICT。
  // navigator 在 Node 21+ 是只读全局 getter,直接赋值会 TypeError;用 defineProperty 覆盖以兼容 Node 20 与 22+。
  const sandboxWindow = {};
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const prevWindow = globalThis.window;
  globalThis.window = sandboxWindow;
  Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"], language: "en" }, configurable: true, writable: true });
  try {
    const code = fs.readFileSync(path.join(extDir, "i18n.js"), "utf8");
    (0, eval)(code); // eslint-disable-line no-eval
  } finally {
    globalThis.window = prevWindow;
    if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    else delete globalThis.navigator;
  }
  assert.ok(sandboxWindow.HG_I18N && sandboxWindow.HG_I18N.DICT, "HG_I18N.DICT 应可用");
  return sandboxWindow.HG_I18N.DICT;
}

const DICT = loadDict();

test("i18n:zh/en/ja 三语言 key 集合完全一致", () => {
  const zh = Object.keys(DICT.zh).sort();
  const en = Object.keys(DICT.en).sort();
  const ja = Object.keys(DICT.ja).sort();
  assert.deepEqual(en, zh, "en 与 zh key 不一致");
  assert.deepEqual(ja, zh, "ja 与 zh key 不一致");
  // 值不得为空串
  for (const lang of ["zh", "en", "ja"]) {
    for (const k of Object.keys(DICT[lang])) {
      assert.ok(typeof DICT[lang][k] === "string" && DICT[lang][k].length > 0, lang + "." + k + " 值为空");
    }
  }
});

test("i18n:sidepanel.html 的 data-i18n* 引用全部存在于三语言", () => {
  const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
  const keys = new Set();
  const re = /data-i18n(?:-placeholder|-title|-html)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) keys.add(m[1]);
  assert.ok(keys.size > 20, "应扫到足量 data-i18n 引用");
  for (const k of keys) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(DICT[lang], k), lang + " 缺少 key: " + k);
    }
  }
});

test("i18n:v0.9 Connection Center 关键 key 齐全(conn.*)", () => {
  const need = [
    "conn.check", "conn.copyDiag", "conn.titleNotInstalled", "conn.descNotInstalled",
    "conn.agentSetup", "conn.agentRepair", "conn.copyTerminal", "conn.titleNeedRepair",
    "conn.descNeedRepair", "conn.descNeedRepairHost", "conn.repair", "conn.repairConfirmText",
    "conn.repairConfirmOk", "conn.cancel", "conn.titleUnsupported", "conn.descUnsupported",
    "conn.titleExtNeedUpdate", "conn.descExtNeedUpdate", "conn.titleBridgeReady", "conn.descBridgeReady",
    "conn.titleConnected", "conn.promptStillAvailable", "conn.devOnly",
    "conn.setupCopied", "conn.terminalCopied", "conn.diagCopied", "conn.repaired", "conn.agentsGuide",
    "conn.status.ready", "conn.status.claudeNotInstalled", "conn.status.claudeAuth",
    "conn.status.codexNotFound", "conn.status.codexAuth", "conn.status.codexIncompatible",
    "conn.status.copilotNotFound", "conn.status.copilotAuth", "conn.status.copilotIncompatible",
    "conn.status.probeFailed"
  ];
  for (const k of need) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(DICT[lang], k), lang + " 缺少 " + k);
    }
  }
  // {n} 占位符三语都在
  for (const lang of ["zh", "en", "ja"]) assert.ok(DICT[lang]["conn.titleConnected"].includes("{n}"));
});
