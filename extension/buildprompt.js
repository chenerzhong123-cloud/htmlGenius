// extension/buildprompt.js — 多级回复 DFS 组装
// 从旧 sidepanel.js 的 exportPrompt 抽出并增强:按 parent_id 建树后 DFS 遍历,
// 使所有层级回复(而非仅顶层)都纳入结构化提示词。
// 暴露 window.BuildPrompt.{fromAnnotations, buildTree, fmtBlock, dfs}
(function () {
  "use strict";

  function buildTree(items) {
    const byParent = {};
    (items || []).forEach(function (a) {
      // parent_id 为 null 的顶层归到 null 键;字符串/数字 id 正常分组。
      const key = a && a.parent_id ? a.parent_id : null;
      (byParent[key] = byParent[key] || []).push(a);
    });
    return byParent;
  }

  function fmtBlock(ann, depth) {
    const sel = (ann && ann.selector) || {};
    const exact = sel.exact || (ann && ann.quote) || "";
    const prefix = (sel.prefix || "").trim();
    const suffix = (sel.suffix || "").trim();
    const indent = "  ".repeat(depth);

    let loc;
    if (prefix || suffix) {
      loc =
        "定位:" +
        (prefix ? "前文「" + prefix + "」 " : "") +
        "【原文】「" + exact + "」" +
        (suffix ? " 后文「" + suffix + "」" : "");
    } else if (exact) {
      loc = "定位:【原文】「" + exact + "」";
    } else {
      loc = "定位:(回复,无独立选区)";
    }

    const who =
      ann && ann.author && ann.author.name ? "[" + ann.author.name + "] " : "";
    const c = (ann && ann.body && ann.body.comment) || "(无)";

    return indent + loc + "\n" + indent + "评论:" + who + c;
  }

  // 深度优先:对 node 的每个子节点先输出块再递归其子树。
  // visited 用于防御性避免循环引用导致的无限递归(后端正常不应产生)。
  function dfs(node, byParent, depth, out, visited) {
    const kids = byParent[node.id] || [];
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!child || typeof child !== "object") continue;
      const cid = child.id;
      if (cid != null) {
        if (visited.has(cid)) continue; // 防御:跳过已访问(成环节点)
        visited.add(cid);
      }
      out.push(fmtBlock(child, depth));
      dfs(child, byParent, depth + 1, out, visited);
    }
  }

  function fromAnnotations(items) {
    const byParent = buildTree(items || []);
    const roots = byParent[null] || [];
    const out = [];
    const visited = new Set();

    let n = 0;
    roots.forEach(function (top) {
      if (!top || typeof top !== "object") return;
      n += 1;
      if (top.id != null) visited.add(top.id);
      out.push("==评论" + n + "==");
      out.push(fmtBlock(top, 0));
      dfs(top, byParent, 1, out, visited);
    });

    const header =
      "你是一名 HTML 编辑执行器。下面给出文档的全部 " +
      n +
      " 条顶层评论(含多级回复),请逐条执行修改,并输出完整的新版 HTML:\n\n";
    return header + out.join("\n");
  }

  window.BuildPrompt = {
    fromAnnotations: fromAnnotations,
    buildTree: buildTree,
    fmtBlock: fmtBlock,
    dfs: dfs,
  };
})();
