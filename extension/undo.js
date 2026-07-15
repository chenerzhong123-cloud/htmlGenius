// undo.js — htmlGenius 编辑历史状态机(线性 undo/redo/reset)。
// 纯逻辑(不碰 DOM):通过注入 getState/applyState 解耦,便于 Node 单测(见 tests/test_undo_history.js)。
// 浏览器:挂 window.HgUndo;Node:module.exports。
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HgUndo = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";
  /**
   * 线性历史:history=状态快照数组,idx=当前位。
   * - push():提交当前状态为新一步(若与当前已提交相同则不记);新编辑会截断 redo 分支。
   * - undo():先撤回防抖窗口内未提交的变更,再回退一步。
   * - redo():前进一步。
   * - reset():回到基线(index 0)并截断。
   * 关键约束:任何修改状态的操作(文字/颜色/控件…)必须调 push() 才能被撤销/重做。
   * @param {() => string} getState 返回当前状态快照
   * @param {(s: string) => void} applyState 应用某历史状态
   * @param {number} max 最大步数(超限丢最旧)
   */
  function createHistory(getState, applyState, max) {
    let history = [];
    let idx = -1;
    return {
      init() { history = [getState()]; idx = 0; },
      push() {
        if (idx < 0) return;
        const cur = getState();
        if (cur === history[idx]) return;            // 无变化不记
        history = history.slice(0, idx + 1);          // 新编辑 → 截断 redo 分支
        history.push(cur); idx = history.length - 1;
        if (history.length > max) { history.shift(); idx--; }
      },
      undo() {
        if (idx < 0) return false;
        const cur = getState();
        if (cur !== history[idx]) { applyState(history[idx]); return true; } // 撤回未提交的变更
        if (idx > 0) { idx--; applyState(history[idx]); return true; }
        return false;
      },
      redo() {
        if (idx >= 0 && idx < history.length - 1) { idx++; applyState(history[idx]); return true; }
        return false;
      },
      reset() {
        if (idx < 0 || !history.length) return false;
        applyState(history[0]); history = [history[0]]; idx = 0; return true;
      },
      _snapshot() { return { len: history.length, idx: idx }; }, // 仅供测试/调试
    };
  }
  return { createHistory: createHistory };
});
