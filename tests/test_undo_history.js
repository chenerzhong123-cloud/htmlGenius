// tests/test_undo_history.js — 验证 createHistory 状态机(线性 undo/redo/reset)
// 运行:node tests/test_undo_history.js
// 覆盖:基线/同状态不记、undo/redo 遍历、新编辑截断 redo、MAX 封顶、
//       【关键】颜色改动入历史后可撤销/重做、【回归】未 push 的改动不可重做。
const { createHistory } = require("../extension/undo.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ " + msg); } }
function eq(a, b, msg) { ok(a === b, msg + "  (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

// 用字符串变量模拟 body 状态;applyState 改它
function makeHist(max) {
  let state = "";
  return {
    h: createHistory(() => state, (s) => { state = s; }, max || 100),
    get: () => state,
    set: (v) => { state = v; },
  };
}

// T1 基线 + 同状态不记步
{
  const t = makeHist(); t.h.init();            // state=""
  t.set("a"); t.h.push();                       // ["",a]
  const len1 = t.h._snapshot().len;
  t.set("a"); t.h.push();                       // 同状态 → 不记
  eq(t.h._snapshot().len, len1, "T1 同状态不记步");
}

// T2 undo/redo 基本遍历
{
  const t = makeHist(); t.h.init();             // ""
  t.set("a"); t.h.push();
  t.set("ab"); t.h.push();
  t.set("abc"); t.h.push();
  t.h.undo(); eq(t.get(), "ab", "T2 undo→ab");
  t.h.undo(); eq(t.get(), "a", "T2 undo→a");
  t.h.undo(); eq(t.get(), "", "T2 undo→基线");
  t.h.undo(); eq(t.get(), "", "T2 基线处 undo 无效");
  t.h.redo(); eq(t.get(), "a", "T2 redo→a");
  t.h.redo(); eq(t.get(), "ab", "T2 redo→ab");
  t.h.redo(); eq(t.get(), "abc", "T2 redo→abc");
  t.h.redo(); eq(t.get(), "abc", "T2 末尾 redo 无效");
}

// T3 新编辑截断 redo 分支
{
  const t = makeHist(); t.h.init();
  t.set("a"); t.h.push();
  t.set("b"); t.h.push();                       // ["",a,b]
  t.h.undo(); t.h.undo();                       // → ""
  t.set("c"); t.h.push();                       // 新编辑 → ["",c],redo 分支(a,b)截断
  eq(t.h._snapshot().len, 2, "T3 新编辑截断 redo");
  t.h.redo(); eq(t.get(), "c", "T3 redo 无更多(被截断)");
}

// T4 MAX 封顶丢最旧
{
  const t = makeHist(3); t.h.init();            // [""],max=3
  t.set("a"); t.h.push();                       // ["",a]
  t.set("b"); t.h.push();                       // ["",a,b]
  t.set("c"); t.h.push();                       // len4>3 → shift → [a,b,c]
  eq(t.h._snapshot().len, 3, "T4 封顶3步");
  t.h.undo(); t.h.undo(); eq(t.get(), "a", "T4 最早只能撤到 a(基线已被丢)");
}

// T5 【关键 · 对应报告的 bug】颜色改动入历史 → 可撤销/重做
//   文字编辑(push)、颜色改动(push)、撤销两次、重做两次 → 颜色这一步能重做回来
{
  const t = makeHist(); t.h.init();             // ""
  t.set("text"); t.h.push();                    // 文字编辑入历史
  t.set("text+color"); t.h.push();              // 颜色改动入历史(修复后 apply-color 会 push)
  t.h.undo(); eq(t.get(), "text", "T5 undo 撤掉颜色 → text");
  t.h.undo(); eq(t.get(), "", "T5 undo 撤掉文字 → 基线");
  t.h.redo(); eq(t.get(), "text", "T5 redo → text");
  t.h.redo(); eq(t.get(), "text+color", "T5 redo → 颜色这一步能重做回来 ✓");
}

// T6 【回归】改了状态但没 push → 不可单独撤销/重做(证明 push 是必需的,即原 bug 根因)
{
  const t = makeHist(); t.h.init();
  t.set("a"); t.h.push();
  t.set("a+unpushed");                          // 改了状态但【故意不 push】(模拟 bug)
  t.h.undo(); eq(t.get(), "a", "T6 未 push 的改动被 undo 直接丢弃");
  t.h.redo(); eq(t.get(), "a", "T6 未 push 的改动 redo 不回来(印证 push 必需)");
}

// T7 reset 回基线并截断
{
  const t = makeHist(); t.h.init();
  t.set("a"); t.h.push(); t.set("b"); t.h.push();
  t.h.reset(); eq(t.get(), "", "T7 reset 回基线");
  t.h.redo(); eq(t.get(), "", "T7 reset 后无 redo 可走");
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
