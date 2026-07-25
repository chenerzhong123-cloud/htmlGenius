// change-contract.js — v0.6.1 修改契约(Change Contract)任务生成器
// 纯前端模块:把批注升级为带「允许范围 / 保护规则 / 歧义处理 / 验收条件」的任务,
// 同一任务可复制为人可读 prompt 或机器可读 JSON,安全交给 glm5.2 / Codex / Claude Code / Copilot。
//
// 纯函数约束:不读取 DOM、chrome API、时间、随机数或 Clipboard,方便稳定测试(见 change-contract-test.html)。
// 不替代 BuildPrompt;旧 BuildPrompt.fromAnnotations() 保持原样。新 UI 只能调用 ChangeContract。
// 暴露 window.ChangeContract.{MODES, validateDraft, buildTask, renderPrompt, serialize, getRoots, buildReplyTree}
// UMD:浏览器挂 window.ChangeContract;Node 走 module.exports(供 bridge/prompt.mjs 复用 renderPrompt,
// 单一真相源,不与扩展侧漂移)。与 undo.js 同款,不改任何 schema/语义。
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChangeContract = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  // mode → 固定契约元数据(§4.3,不让 UI 改写)。prompt 文本固定中文(§6)。
  var MODES = [
    {
      id: "precise_patch",
      writeScope: "target_only",
      locked: true,
      onAmbiguous: "ask_or_stop",
      verification: "仅修改定位目标；报告前后片段或 diff；不改其他文件。",
      forced: "禁止修改任何未被本任务定位的文本、DOM 结构、样式或其他文件。若目标出现多次且无法凭定位唯一判断，停止并请求确认。",
      briefRequired: false,
      promptName: "精准修补",
      promptDesc: "只允许修改精确定位的目标",
      scopeText: "仅被评论精确定位的内容"
    },
    {
      id: "local_optimize",
      writeScope: "annotated_local_areas",
      locked: true,
      onAmbiguous: "ask_or_stop",
      verification: "仅改评论所在局部；报告每个局部的变更；不改其他页面区域。",
      forced: "只能在每条评论定位到的局部内容中修改；不要扩展到页面其他区块。",
      briefRequired: false,
      promptName: "局部优化",
      promptDesc: "只优化评论所在的局部内容",
      scopeText: "每条评论所在的局部内容"
    },
    {
      id: "restructure",
      writeScope: "document_structure",
      locked: false,
      onAmbiguous: "ask_or_stop",
      verification: "先输出结构计划、保留项和影响范围；不得在本轮修改文件。",
      forced: "此轮仅输出可执行的重组计划、涉及范围和风险；不要修改文件，也不要输出重写后的完整 HTML。",
      briefRequired: true,
      promptName: "结构重组",
      promptDesc: "重新规划章节、顺序或局部结构；先产出计划，不直接改文件",
      scopeText: "文档结构（本轮只规划，不改文件）"
    },
    {
      id: "regenerate",
      writeScope: "whole_document",
      locked: false,
      onAmbiguous: "ask_or_stop",
      verification: "列出采用的 brief、保留项、假设和待复核项；报告全文结构变化。",
      forced: "允许重写全文，但必须保留「必须保留」列出的内容，并列出未能确认的假设。",
      briefRequired: false,
      promptName: "重新生成",
      promptDesc: "基于新的完整说明重写整份页面/报告；允许改全文",
      scopeText: "整份文档"
    }
  ];

  function modeById(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return null;
  }

  function hasParent(a) { return a && a.parent_id != null && a.parent_id !== ""; }

  // 非 stale 的顶层 annotation(§5 getRoots)
  function getRoots(allAnnotations) {
    return (allAnnotations || []).filter(function (a) {
      return a && !hasParent(a) && a._status !== "stale";
    });
  }

  // 必须保留 textarea 原文本 → 按换行拆分、trim、去空行(§3.4)
  function splitPreserve(text) {
    return String(text || "").split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; })
      .slice(0, 200);
  }

  // 纯 helper:选中 rootIds → 有序、含完整 DFS 后代的节点树(§4.4, §5)
  // - roots 输出顺序 = 在 allAnnotations 中的原始顺序(§8.1 用例6)
  // - 每条 root 含完整后代,DFS,父在子前,同级按原始顺序
  // - 孤儿 reply(父不在树中)不会被纳入;循环引用/重复 id 跳过,不抛异常
  function buildReplyTree(allAnnotations, rootIds, selectedIds) {
    var items = allAnnotations || [];
    var pos = new Map();
    items.forEach(function (a, i) { if (a && a.id != null) pos.set(a.id, i); });

    var childrenOf = new Map(); // parent_id -> [children]
    items.forEach(function (a) {
      if (!a || a.id == null || !hasParent(a)) return; // 只为有父的节点建索引
      var p = a.parent_id;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(a);
    });
    childrenOf.forEach(function (arr) {
      arr.sort(function (x, y) { return (pos.get(x.id) | 0) - (pos.get(y.id) | 0); });
    });

    // 节点级选择(v0.7.2 反馈):selectedSet 存在时,未选的回复子树不纳入;未传则含全部后代(向后兼容)
    var selectedSet = selectedIds ? new Set((selectedIds || []).map(function (x) { return String(x); })) : null;

    function toNode(ann, seen) {
      var sel = ann.selector || {};
      var node = {
        id: ann.id,
        selector: {
          type: sel.type || "TextQuoteSelector",
          exact: sel.exact != null ? String(sel.exact) : String(ann.quote || ""),
          prefix: String(sel.prefix || ""),
          suffix: String(sel.suffix || "")
        },
        quote: String(ann.quote || sel.exact || ""),
        comment: String((ann.body && ann.body.comment) || ""),
        author: String((ann.author && ann.author.name) || ""),
        replies: []
      };
      var kids = childrenOf.get(ann.id) || [];
      kids.forEach(function (ch) {
        if (!ch || ch.id == null || seen.has(ch.id)) return; // 防御:循环/重复
        if (selectedSet && !selectedSet.has(String(ch.id))) return; // 未选的回复不纳入
        seen.add(ch.id);
        node.replies.push(toNode(ch, seen));
      });
      return node;
    }

    var want = {};
    (rootIds || []).forEach(function (id) { if (id != null) want[id] = true; })
    // 仅纳入:被选中 + 顶层 + 非 stale;filter 保持原始顺序
    var roots = items.filter(function (a) {
      return a && !hasParent(a) && a._status !== "stale" && want[a.id] === true;
    });

    var seen = new Set();
    var out = [];
    roots.forEach(function (r) {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      out.push(toNode(r, seen));
    });
    return out;
  }

  // { ok, errors:{ rootIds?, brief?, mode? } }(§5)
  function validateDraft(draft, allAnnotations) {
    var errors = {};
    if (!draft) return { ok: false, errors: { mode: "no_draft" } };

    var meta = modeById(draft.mode);
    if (!meta) errors.mode = "invalid_mode";

    var validSet = {};
    getRoots(allAnnotations || []).forEach(function (a) { validSet[a.id] = true; });
    var rootIds = draft.rootIds || [];
    if (!rootIds.length) {
      errors.rootIds = "empty";
    } else {
      var bad = rootIds.filter(function (id) { return !validSet[id]; });
      if (bad.length) errors.rootIds = "invalid:" + bad.join(",");
    }

    var brief = String(draft.brief || "").trim();
    if (meta && meta.briefRequired && brief.length < 10) errors.brief = "too_short";

    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  // 校验失败抛 Error("Invalid change contract")(§5)
  function buildTask(draft, allAnnotations) {
    var v = validateDraft(draft, allAnnotations);
    if (!v.ok) throw new Error("Invalid change contract");

    var meta = modeById(draft.mode);
    var tree = buildReplyTree(allAnnotations || [], draft.rootIds, draft.selectedIds);
    var art = draft.artifact || {};
    return {
      schema_version: 1,
      kind: "htmlgenius_change_contract",
      mode: draft.mode,
      artifact: {
        title: String(art.title || ""),
        url: String(art.url || ""),
        is_local: !!art.isLocal
      },
      source: {
        root_annotation_ids: tree.map(function (n) { return n.id; }),
        root_annotation_count: tree.length
      },
      annotations: tree,
      brief: String(draft.brief || "").trim().slice(0, 2000),
      preserve: splitPreserve(draft.preserveText),
      contract: {
        write_scope: meta.writeScope,
        locked_outside_scope: meta.locked,
        on_ambiguous_target: meta.onAmbiguous,
        verification: [meta.verification]
      }
    };
  }

  function serialize(task) { return JSON.stringify(task, null, 2); }

  // —— prompt 渲染辅助 ——
  function locText(node) {
    var parts = [];
    if (node.selector && node.selector.prefix) parts.push("前文「" + node.selector.prefix + "」");
    parts.push("原文「" + ((node.selector && node.selector.exact) || node.quote || "") + "」");
    if (node.selector && node.selector.suffix) parts.push("后文「" + node.selector.suffix + "」");
    return parts.join("｜") || "(无选区)";
  }

  function protectionText(meta, preserve) {
    var base = meta.locked
      ? "默认:未在「允许范围」内的内容一律不得修改。"
      : "默认:不得删除或篡改用户指定必须保留的内容。";
    if (!preserve.length) return base + "(用户未额外指定必须保留项)";
    return base + "用户必须保留:" + preserve.map(function (p) { return "「" + p + "」"; }).join("、") + "。";
  }

  function renderReplies(replies, depth, out) {
    (replies || []).forEach(function (r) {
      var indent = "  ".repeat(depth);
      out.push(indent + "- [" + (r.author || "") + "] " + (r.comment || "(无)"));
      renderReplies(r.replies, depth + 1, out);
    });
  }

  // 中文、模型中立的指令(§6)
  function renderPrompt(task) {
    var meta = modeById(task.mode);
    var lines = [];
    lines.push("# HTML Genius 修改任务");
    lines.push("");
    lines.push("## 任务模式");
    lines.push(meta.promptName + "(" + meta.promptDesc + ")");
    lines.push("");
    lines.push("## 文档");
    lines.push("- 标题:" + (task.artifact.title || "(无标题)"));
    lines.push("- 地址:" + (task.artifact.url || "(未知)"));
    lines.push("- 本地 HTML:" + (task.artifact.is_local ? "是" : "否"));
    lines.push("");
    lines.push("## 修改契约");
    lines.push("- 允许范围:" + meta.scopeText);
    lines.push("- 受保护内容:" + protectionText(meta, task.preserve || []));
    lines.push("- 目标不明确时:停止修改并说明需要确认的位置。");
    lines.push("");
    lines.push("## 评论与讨论");
    (task.annotations || []).forEach(function (node, i) {
      lines.push("### 评论 " + (i + 1));
      lines.push("- 定位:" + locText(node));
      lines.push("- 评论:" + (node.author ? "[" + node.author + "] " : "") + (node.comment || "(无)"));
      var reps = [];
      renderReplies(node.replies, 1, reps);
      if (reps.length) {
        lines.push("- 回复:");
        reps.forEach(function (r) { lines.push(r); });
      }
      lines.push("");
    });
    lines.push("## 补充说明");
    lines.push(String(task.brief || "").trim() || "(无)");
    lines.push("");
    lines.push("## 验收与输出");
    lines.push("1. " + (task.contract && task.contract.verification ? task.contract.verification.join("；") : ""));
    lines.push("");
    lines.push("## 强制约束");
    lines.push(meta.forced);
    return lines.join("\n");
  }

  return {
    MODES: MODES,
    validateDraft: validateDraft,
    buildTask: buildTask,
    renderPrompt: renderPrompt,
    serialize: serialize,
    getRoots: getRoots,
    buildReplyTree: buildReplyTree
  };
});
