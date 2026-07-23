// bridge/test/palette.test.mjs — v0.9.1:编辑调色板单一来源(palette.js)+ 两处消费者同源锁。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "..", "..", "extension");
const sb = {};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(extDir, "palette.js"), "utf8"), sb, { filename: "palette.js" });

test("palette:TEXT_COLORS 16 格,含白色 + 品牌 mint,无旧蓝", () => {
  const t = sb.HG_PALETTE.TEXT_COLORS;
  assert.equal(t.length, 16);
  assert.ok(t.includes("#ffffff"), "文字色含白色");
  assert.ok(t.includes("#88e6d1"), "文字色含品牌 mint #88e6d1");
  assert.ok(!t.includes("#7c8cff"), "文字色不含旧蓝 #7c8cff");
  assert.equal(new Set(t).size, 16, "无重复");
});

test("palette:HL_COLORS 16 格,含白色 + transparent(清除)", () => {
  const h = sb.HG_PALETTE.HL_COLORS;
  assert.equal(h.length, 16);
  assert.equal(h.length % 8, 0, "8 列整除");
  assert.ok(h.includes("#ffffff"), "高亮色含白色");
  assert.ok(h.includes("transparent"), "高亮色含 transparent(清除)");
  assert.equal(new Set(h).size, 16, "无重复");
});

test("palette:深冻结不可变(对象 + 两个数组)", () => {
  assert.equal(Object.isFrozen(sb.HG_PALETTE), true);
  assert.equal(Object.isFrozen(sb.HG_PALETTE.HL_COLORS), true);
  assert.equal(Object.isFrozen(sb.HG_PALETTE.TEXT_COLORS), true);
});

test("同源锁:content-script 与 sidepanel 均从 HG_PALETTE 取 TEXT/HL 两色", () => {
  const cs = fs.readFileSync(path.join(extDir, "content-script.js"), "utf8");
  const sp = fs.readFileSync(path.join(extDir, "sidepanel.js"), "utf8");
  assert.match(cs, /HG_PALETTE\.TEXT_COLORS/);
  assert.match(cs, /HG_PALETTE\.HL_COLORS/);
  assert.match(sp, /HG_PALETTE\.TEXT_COLORS/);
  assert.match(sp, /HG_PALETTE\.HL_COLORS/);
});

test("加载链:palette.js 在 content_scripts 与 sidepanel.html 中均被引用且先于消费者", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes("palette.js"), "manifest content_scripts 含 palette.js");
  assert.ok(js.indexOf("palette.js") < js.indexOf("content-script.js"), "palette.js 先于 content-script.js");
  const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
  assert.ok(html.indexOf('src="palette.js"') < html.indexOf('src="sidepanel.js"'), "sidepanel.html 中 palette.js 先于 sidepanel.js");
});
