// bridge/test/patch-edits.test.mjs — 确定性编辑引擎单测(schema 校验 + 定位消歧 + 外科应用 + 范围映射)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEditsJson, validateEdit, collectScope, locateExact, owningStartTag, rewriteStyleAttr, applyEdits,
  extractEditsFromMessages
} from "../patch-edits.mjs";

// —— helpers ——
function ann(id, exact, prefix, suffix) {
  return { id, selector: { type: "TextQuoteSelector", exact, prefix: prefix || "", suffix: suffix || "" }, quote: exact, comment: "c", replies: [] };
}
function taskWith(annotations) {
  return { schema_version: 1, kind: "htmlgenius_change_contract", mode: "precise_patch", annotations };
}
function rep(id, exact) { return { id, replacement: exact, action: "replace_text" }; }

// ============================ parseEditsJson ============================
test("parseEditsJson: 纯 JSON / ```json 围栏 / 前后 prose 均可提取", () => {
  const obj = { schema_version: 1, edits: [{ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "x" }, replacement: "y" }] };
  assert.equal(parseEditsJson(JSON.stringify(obj)).edits.length, 1);
  assert.equal(parseEditsJson("```json\n" + JSON.stringify(obj) + "\n```").edits.length, 1);
  assert.equal(parseEditsJson("Sure, here is the result:\n" + JSON.stringify(obj) + "\nDone.").edits.length, 1);
});

test("parseEditsJson: 坏 JSON / schema_version≠1 / edits 非数组 → PATCH_EDITS_INVALID", () => {
  assert.throws(() => parseEditsJson("no json here"), (e) => e.code === "PATCH_EDITS_INVALID");
  assert.throws(() => parseEditsJson(""), (e) => e.code === "PATCH_EDITS_INVALID");
  assert.throws(() => parseEditsJson('{"schema_version":2,"edits":[]}'), (e) => e.code === "PATCH_EDITS_INVALID");
  assert.throws(() => parseEditsJson('{"schema_version":1,"edits":{"a":1}}'), (e) => e.code === "PATCH_EDITS_INVALID");
});

// ============================ validateEdit ============================
test("validateEdit: 缺字段/非法 action 抛 PATCH_EDIT_INVALID", () => {
  assert.throws(() => validateEdit({ id: "e", action: "replace_text", locator: { exact: "x" } }), (e) => e.code === "PATCH_EDIT_INVALID"); // 缺 replacement
  assert.throws(() => validateEdit({ id: "e", action: "set_style", locator: { exact: "x" }, property: "color" }), (e) => e.code === "PATCH_EDIT_INVALID"); // 缺 value
  assert.throws(() => validateEdit({ id: "e", action: "set_style", locator: { exact: "x" }, value: "red" }), (e) => e.code === "PATCH_EDIT_INVALID"); // 缺 property
  assert.throws(() => validateEdit({ id: "e", action: "delete_node", locator: { exact: "x" } }), (e) => e.code === "PATCH_EDIT_INVALID");
  assert.throws(() => validateEdit({ id: "e", action: "replace_text", locator: {}, replacement: "y" }), (e) => e.code === "PATCH_EDIT_INVALID"); // 缺 exact
  assert.throws(() => validateEdit({ action: "replace_text", locator: { exact: "x" }, replacement: "y" }), (e) => e.code === "PATCH_EDIT_INVALID"); // 缺 id
});

test("validateEdit: 合法编辑规范化", () => {
  const e = validateEdit({ id: "e1", comment_ref: null, action: "replace_text", locator: { exact: "a" }, replacement: "b" });
  assert.equal(e.comment_ref, null);
  assert.equal(e.locator.prefix, "");
  assert.equal(e.replacement, "b");
});

// ============================ locateExact ============================
test("locateExact: 唯一命中 / 未命中 / 多处无上下文→ambiguous / prefix 消歧", () => {
  const src = "<div>alpha item one</div><div>beta item two</div>";
  const one = locateExact("<p>solo</p>", { exact: "solo", prefix: "", suffix: "" });
  assert.deepEqual({ status: one.status, start: one.start, end: one.end }, { status: "ok", start: 3, end: 7 });
  assert.equal(locateExact(src, { exact: "zzz", prefix: "", suffix: "" }).status, "not_found");
  assert.equal(locateExact(src, { exact: "item", prefix: "", suffix: "" }).status, "ambiguous");
  const a = locateExact(src, { exact: "item", prefix: "alpha ", suffix: "" });
  assert.equal(a.status, "ok");
  assert.equal(src.slice(a.start, a.end), "item");
  assert.equal(src.slice(a.start - 6, a.start), "alpha ");
  const b = locateExact(src, { exact: "item", prefix: "beta ", suffix: "" });
  assert.equal(b.status, "ok");
  assert.equal(src.slice(b.start - 5, b.start), "beta ");
  assert.notEqual(a.start, b.start);
});

// ============================ owningStartTag ============================
test("owningStartTag: 跳过已闭合内层标签,选真正 owner(<p> 而非 <b>)", () => {
  const src = "<p>foo <b>bar</b> baz</p>";
  const idx = src.indexOf("baz");
  const owner = owningStartTag(src, idx);
  assert.equal(owner.tagName, "p");
  assert.equal(owner.tagStr, "<p>");
  // "bar" 的 owner 是 <b>
  const ownerBar = owningStartTag(src, src.indexOf("bar"));
  assert.equal(ownerBar.tagName, "b");
});

test("rewriteStyleAttr: 无 style 插入 / 有 style 追加保留其余 / 覆盖同名", () => {
  assert.equal(rewriteStyleAttr('<h1 class="t">', "font-size", "18px"), '<h1 class="t" style="font-size: 18px">');
  assert.equal(rewriteStyleAttr('<h1 style="color: red; margin: 0">', "font-size", "18px"), '<h1 style="color: red; margin: 0; font-size: 18px">');
  assert.equal(rewriteStyleAttr('<h1 style="font-size: 12px; color: red">', "font-size", "18px"), '<h1 style="font-size: 18px; color: red">');
});

// ============================ applyEdits ============================
test("applyEdits replace_text: 替换命中且未命中区域逐字不变", () => {
  const src = "<!doctype html><html><body><h1>Old Title</h1><p>keep me</p></body></html>";
  const task = taskWith([ann("a1", "Old Title")]);
  const edits = [validateEdit({ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "Old Title" }, replacement: "New Title" })];
  const { html, applied, skipped } = applyEdits(src, edits, task);
  assert.equal(html, src.replace("Old Title", "New Title"));
  assert.ok(html.startsWith("<!doctype html><html><body><h1>"), "前缀逐字不变");
  assert.ok(html.endsWith("</h1><p>keep me</p></body></html>"), "后缀逐字不变");
  assert.deepEqual(applied, [{ id: "e1", action: "replace_text" }]);
  assert.equal(skipped.length, 0);
});

test("applyEdits: not_found / ambiguous 均 skip 且不改 html", () => {
  const src = "<p>AAA</p><div>beta item two</div>";
  const task = taskWith([ann("a1", "AAA"), ann("a2", "item")]);
  const nf = applyEdits(src, [validateEdit({ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "NOPE" }, replacement: "x" })], task);
  assert.equal(nf.html, src);
  assert.equal(nf.skipped[0].status, "not_found");
  const amb = applyEdits("<div>alpha item one</div><div>beta item two</div>",
    [validateEdit({ id: "e2", comment_ref: "a2", action: "replace_text", locator: { exact: "item" }, replacement: "x" })],
    taskWith([ann("a2", "item")]));
  assert.equal(amb.skipped[0].status, "ambiguous");
});

test("applyEdits set_style: 插入新 style,class 等其余属性保留", () => {
  const src = '<!doctype html><html><body><h1 class="t">Hello</h1></body></html>';
  const task = taskWith([ann("a1", "Hello")]);
  const edits = [validateEdit({ id: "e1", comment_ref: "a1", action: "set_style", locator: { exact: "Hello" }, property: "font-size", value: "18px" })];
  const { html, applied } = applyEdits(src, edits, task);
  assert.ok(html.includes('<h1 class="t" style="font-size: 18px">Hello</h1>'), html);
  assert.deepEqual(applied, [{ id: "e1", action: "set_style" }]);
});

test("applyEdits set_style: owner 选 <p> 不动已闭合的 <b>", () => {
  const src = "<!doctype html><p>foo <b>bar</b> baz</p>";
  const task = taskWith([ann("a1", "baz")]);
  const edits = [validateEdit({ id: "e1", comment_ref: "a1", action: "set_style", locator: { exact: "baz" }, property: "color", value: "red" })];
  const { html } = applyEdits(src, edits, task);
  assert.ok(html.includes('<p style="color: red">foo <b>bar</b> baz</p>'), html);
});

test("applyEdits: 同一元素多条 set_style 合并为一个 rewrite", () => {
  const src = "<!doctype html><h1>Hello</h1>";
  const task = taskWith([ann("a1", "Hello")]);
  const edits = [
    validateEdit({ id: "e1", comment_ref: "a1", action: "set_style", locator: { exact: "Hello" }, property: "color", value: "red" }),
    validateEdit({ id: "e2", comment_ref: "a1", action: "set_style", locator: { exact: "Hello" }, property: "font-size", value: "18px" })
  ];
  const { html, applied, skipped } = applyEdits(src, edits, task);
  assert.ok(html.includes('<h1 style="color: red; font-size: 18px">Hello</h1>'), html);
  assert.equal(applied.length, 2);
  assert.equal(skipped.length, 0);
});

test("applyEdits: 多条 replace_text 逆序应用不串位", () => {
  const src = "<!doctype html><p>AAA</p><p>BBB</p>";
  const task = taskWith([ann("a1", "AAA"), ann("a2", "BBB")]);
  const edits = [
    validateEdit({ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "AAA" }, replacement: "aaa" }),
    validateEdit({ id: "e2", comment_ref: "a2", action: "replace_text", locator: { exact: "BBB" }, replacement: "bbbb" })
  ];
  const { html } = applyEdits(src, edits, task);
  assert.equal(html, "<!doctype html><p>aaa</p><p>bbbb</p>");
});

test("applyEdits: 区间重叠 → 双双 conflict,html 不变", () => {
  const src = "<!doctype html><p>overlap text here</p>";
  const task = taskWith([ann("a1", "overlap text"), ann("a2", "text here")]);
  const edits = [
    validateEdit({ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "overlap text" }, replacement: "X" }),
    validateEdit({ id: "e2", comment_ref: "a2", action: "replace_text", locator: { exact: "text here" }, replacement: "Y" })
  ];
  const { html, applied, skipped } = applyEdits(src, edits, task);
  assert.equal(html, src);
  assert.equal(applied.length, 0);
  assert.equal(skipped.filter((s) => s.status === "conflict").length, 2);
});

test("applyEdits: 范围外(comment_ref 不在选中集合) → out_of_scope 不应用", () => {
  const src = "<!doctype html><p>AAA</p><p>BBB</p>";
  const task = taskWith([ann("a1", "AAA")]);
  const edits = [
    validateEdit({ id: "e1", comment_ref: "a1", action: "replace_text", locator: { exact: "AAA" }, replacement: "x" }),
    validateEdit({ id: "e2", comment_ref: "zzz", action: "replace_text", locator: { exact: "BBB" }, replacement: "y" })
  ];
  const { html, applied, skipped } = applyEdits(src, edits, task);
  assert.equal(html, "<!doctype html><p>x</p><p>BBB</p>");
  assert.deepEqual(applied, [{ id: "e1", action: "replace_text" }]);
  assert.equal(skipped[0].id, "e2");
  assert.equal(skipped[0].status, "out_of_scope");
});

test("collectScope: DFS 含回复 id 与锚点", () => {
  const task = taskWith([{ ...ann("a1", "foo"), replies: [ann("r1", "bar")] }]);
  const { commentIds, anchors } = collectScope(task);
  assert.ok(commentIds.has("a1") && commentIds.has("r1"));
  assert.equal(anchors.length, 2);
});

// ============================ extractEditsFromMessages(codex/copilot 多消息)============================
test("extractEditsFromMessages: 倒序逐条尝试 —— 过程 prose 在前、JSON 在最后 → 取最后一条", () => {
  const msgs = ["我读取了 source.html 并分析了评论。", '{"schema_version":1,"edits":[]}'];
  const { edits } = extractEditsFromMessages(msgs);
  assert.deepEqual(edits, []);
});

test("extractEditsFromMessages: 最后一条是 prose、倒数第二条是 JSON → 仍提取成功(不要求必须在最后)", () => {
  const msgs = ['{"schema_version":1,"edits":[]}', "以上就是我的结论。"];
  const { edits } = extractEditsFromMessages(msgs);
  assert.deepEqual(edits, []);
});

test("extractEditsFromMessages: 拼接会误解析的场景 —— 过程消息含非 edits JSON,逐条解析不受干扰", () => {
  // 若拼接后解析,extractFirstObject 会先命中 {"note":...} 并因 schema_version≠1 失败;逐条倒序则跳过它
  const msgs = ['这是进度:{"note":"thinking"}', '最终结果 ```json\n{"schema_version":1,"edits":[]}\n```'];
  const { edits } = extractEditsFromMessages(msgs);
  assert.deepEqual(edits, []);
});

test("extractEditsFromMessages: 全部无效 / 空数组 → PATCH_EDITS_INVALID", () => {
  assert.throws(() => extractEditsFromMessages(["抱歉", "我无法生成"]), (e) => e.code === "PATCH_EDITS_INVALID");
  assert.throws(() => extractEditsFromMessages([]), (e) => e.code === "PATCH_EDITS_INVALID");
  assert.throws(() => extractEditsFromMessages(null), (e) => e.code === "PATCH_EDITS_INVALID");
});
