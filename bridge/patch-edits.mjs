// bridge/patch-edits.mjs — 确定性编辑快车道:结构化编辑 schema 校验 + 范围映射 + 文本级外科应用。
// 纯函数:无 chrome/网络/子进程/时间/随机数,方便稳定单测。
// 不引 HTML parser(字符串级手术)——candidate = source + 且仅 + 清单内编辑,未命中区域逐字保留;
// 范围合规由「编辑映射到选中评论」构造保证,非事后 diff(方向3 的真正落点)。
//
// Edit = {
//   id: string,
//   comment_ref: string|null,                 // 引起本编辑的选中评论 id(范围主信号)
//   action: "replace_text" | "set_style",
//   locator: { exact: string, prefix?: string, suffix?: string },  // 复用 TextQuoteSelector 三件套
//   replacement?: string,                      // replace_text
//   property?: string, value?: string          // set_style
// }
// 状态:ok | not_found | ambiguous | conflict | out_of_scope

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}

// —— 从 Claude result 文本稳健提取 edits JSON ——
// 容忍:纯 JSON / ```json 围栏 / 前后 prose。坏 → PATCH_EDITS_INVALID。
export function parseEditsJson(resultText) {
  const text = String(resultText == null ? "" : resultText);
  if (!text.trim()) fail("PATCH_EDITS_INVALID", "empty result text");
  let obj = tryParseObject(text.trim());
  if (!obj) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) obj = tryParseObject(fence[1].trim());
  }
  if (!obj) obj = extractFirstObject(text);
  if (!obj) fail("PATCH_EDITS_INVALID", "result does not contain a JSON edit object");
  if (obj.schema_version !== 1) fail("PATCH_EDITS_INVALID", "unsupported edits schema_version: " + obj.schema_version);
  if (!Array.isArray(obj.edits)) fail("PATCH_EDITS_INVALID", "edits must be an array");
  return { edits: obj.edits.map(validateEdit), note: (obj.note == null ? null : String(obj.note).slice(0, 500)) };
}

function tryParseObject(s) {
  try {
    const o = JSON.parse(s);
    return (o && typeof o === "object" && !Array.isArray(o)) ? o : null;
  } catch (_) { return null; }
}

// —— 从多条 Agent 消息中提取 edits(倒序逐条尝试,首个成功者胜出)——
// Codex/Copilot patch preview:最终消息可能有多条(过程说明 + 最终结果),edits JSON 通常在最后一条。
// 逐条独立解析而非拼接后解析 —— 拼接会让 extractFirstObject 先命中过程消息里的非 edits JSON 而误失败。
// 全部失败 → PATCH_EDITS_INVALID(附带最后一条的解析失败原因供排障)。
export function extractEditsFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let lastErr = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const text = list[i] == null ? "" : String(list[i]);
    if (!text.trim()) continue;
    try { return parseEditsJson(text); } catch (e) { lastErr = e; }
  }
  fail("PATCH_EDITS_INVALID", lastErr
    ? "no agent message contained a valid edits JSON: " + lastErr.message
    : "no agent messages captured");
}

// 抓首个 { 到配平 }(尊重字符串字面量与转义),再 parse。
function extractFirstObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return tryParseObject(text.slice(start, i + 1)); }
  }
  return null;
}

const ACTIONS = { replace_text: 1, set_style: 1 };

// 单条编辑 schema 校验;坏 → PATCH_EDIT_INVALID。返回规范化后的 Edit。
export function validateEdit(edit) {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) fail("PATCH_EDIT_INVALID", "edit must be an object");
  if (typeof edit.id !== "string" || !edit.id) fail("PATCH_EDIT_INVALID", "edit.id required");
  if (!ACTIONS[edit.action]) fail("PATCH_EDIT_INVALID", "edit.action must be replace_text|set_style: " + edit.action);
  const loc = edit.locator;
  if (!loc || typeof loc !== "object" || Array.isArray(loc)) fail("PATCH_EDIT_INVALID", "edit.locator required");
  if (typeof loc.exact !== "string" || !loc.exact) fail("PATCH_EDIT_INVALID", "locator.exact required (non-empty string)");
  if (loc.prefix != null && typeof loc.prefix !== "string") fail("PATCH_EDIT_INVALID", "locator.prefix must be string");
  if (loc.suffix != null && typeof loc.suffix !== "string") fail("PATCH_EDIT_INVALID", "locator.suffix must be string");
  if (edit.comment_ref != null && typeof edit.comment_ref !== "string") fail("PATCH_EDIT_INVALID", "comment_ref must be string|null");
  if (edit.action === "replace_text") {
    if (typeof edit.replacement !== "string") fail("PATCH_EDIT_INVALID", "replace_text requires replacement string");
  } else {
    if (typeof edit.property !== "string" || !edit.property) fail("PATCH_EDIT_INVALID", "set_style requires non-empty property");
    if (typeof edit.value !== "string") fail("PATCH_EDIT_INVALID", "set_style requires value string");
  }
  return {
    id: edit.id,
    comment_ref: edit.comment_ref == null ? null : edit.comment_ref,
    action: edit.action,
    locator: { exact: loc.exact, prefix: loc.prefix || "", suffix: loc.suffix || "" },
    replacement: edit.action === "replace_text" ? edit.replacement : undefined,
    property: edit.action === "set_style" ? edit.property : undefined,
    value: edit.action === "set_style" ? edit.value : undefined
  };
}

// —— 范围:选中评论 id 集合 + 锚点(DFS task.annotations,含回复)——
export function collectScope(task) {
  const commentIds = new Set();
  const anchors = [];
  (function walk(nodes) {
    for (const n of (nodes || [])) {
      if (!n) continue;
      if (n.id != null) commentIds.add(String(n.id));
      const sel = n.selector || {};
      if (typeof sel.exact === "string" && sel.exact) {
        anchors.push({ id: n.id == null ? null : String(n.id), exact: sel.exact, prefix: sel.prefix || "", suffix: sel.suffix || "" });
      }
      if (Array.isArray(n.replies) && n.replies.length) walk(n.replies);
    }
  })(task && task.annotations);
  return { commentIds, anchors };
}

// 编辑是否在范围内:主信号 comment_ref ∈ 选中评论集合;兜底 locator.exact 与某锚点 exact 相同。
function editInScope(edit, scope) {
  if (edit.comment_ref != null && scope.commentIds.has(String(edit.comment_ref))) return true;
  return scope.anchors.some((a) => a.exact === edit.locator.exact);
}

function commonSuffixLen(a, b) {
  let n = 0; const la = a.length, lb = b.length;
  while (n < la && n < lb && a[la - 1 - n] === b[lb - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a, b) {
  let n = 0; const la = a.length, lb = b.length;
  while (n < la && n < lb && a[n] === b[n]) n++;
  return n;
}

// —— 定位 exact 在 src 中的唯一区间;多处用 prefix/suffix 打分消歧 ——
// 返回 { status:"ok", start, end } | { status:"not_found" } | { status:"ambiguous" }
export function locateExact(src, locator) {
  const exact = locator.exact;
  const occ = [];
  let from = 0;
  while (from <= src.length) {
    const i = src.indexOf(exact, from);
    if (i === -1) break;
    occ.push(i);
    from = i + Math.max(1, exact.length);
  }
  if (occ.length === 0) return { status: "not_found" };
  if (occ.length === 1) return { status: "ok", start: occ[0], end: occ[0] + exact.length };
  const prefix = locator.prefix || "";
  const suffix = locator.suffix || "";
  if (!prefix && !suffix) return { status: "ambiguous" }; // 多处且无上下文 → 选不定
  let best = -1, bestScore = -1, tie = false;
  for (const i of occ) {
    let score = 0;
    if (prefix) score += commonSuffixLen(src.slice(Math.max(0, i - prefix.length), i), prefix);
    if (suffix) score += commonPrefixLen(src.slice(i + exact.length, i + exact.length + suffix.length), suffix);
    if (score > bestScore) { bestScore = score; best = i; tie = false; }
    else if (score === bestScore) { tie = true; }
  }
  if (tie || bestScore <= 0 || best === -1) return { status: "ambiguous" };
  return { status: "ok", start: best, end: best + exact.length };
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

// —— 从文本位置 idx 反向找真正所属的开启标签 ——
// 带层级计数:反向遇到关闭标签 </x> → depth++;遇到开启标签 <x> → depth>0 则配对(depth--)继续向外,
// depth==0 即文本的 owner。跳过 void/自闭合/注释/doctype。避免把「已闭合的内层标签」误当 owner。
export function owningStartTag(src, idx) {
  let i = Math.min(idx, src.length - 1);
  let depth = 0;
  while (i >= 0) {
    const lt = src.lastIndexOf("<", i);
    if (lt === -1) return null;
    const gt = src.indexOf(">", lt);
    if (gt === -1) return null;
    const tagStr = src.slice(lt, gt + 1);
    const c = src[lt + 1];
    if (c === "!" || c === "?") { i = lt - 1; continue; }         // 注释 / doctype / 处理指令
    if (c === "/") { depth++; i = lt - 1; continue; }             // 关闭标签 → 深入一层
    const m = tagStr.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!m) { i = lt - 1; continue; }
    const tagName = m[1].toLowerCase();
    if (VOID_TAGS.has(tagName) || /\/>\s*$/.test(tagStr)) { i = lt - 1; continue; } // void/自闭合不影响层级
    if (depth > 0) { depth--; i = lt - 1; continue; }             // 配对内层关闭,继续向外
    return { tagStart: lt, tagEnd: gt + 1, tagName, tagStr };
  }
  return null;
}

function setDeclaration(rawStyle, prop, val) {
  const decls = String(rawStyle).split(";").map((s) => s.trim()).filter((s) => s.length);
  let found = false;
  const out = decls.map((d) => {
    const ci = d.indexOf(":");
    if (ci === -1) return d;
    const p = d.slice(0, ci).trim();
    if (p.toLowerCase() === prop.toLowerCase()) { found = true; return p + ": " + val; }
    return d;
  });
  if (!found) out.push(prop + ": " + val);
  return out.join("; ");
}

// 在 start tag 字符串上设置/覆盖一个 style 声明,保留其余属性与声明。
export function rewriteStyleAttr(tagStr, property, value) {
  const prop = String(property).trim();
  const val = String(value);
  const re = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/i;
  const m = tagStr.match(re);
  if (m) {
    const quote = m[2][0];
    const raw = m[3] != null ? m[3] : m[4];
    const replacement = m[1] + quote + setDeclaration(raw, prop, val) + quote;
    return tagStr.slice(0, m.index) + replacement + tagStr.slice(m.index + m[0].length);
  }
  const decl = " style=\"" + prop + ": " + val + "\"";
  if (/\/>\s*$/.test(tagStr)) return tagStr.replace(/\/>\s*$/, decl + "/>");
  return tagStr.replace(/>$/, decl + ">");
}

// —— 主入口:把 edits 确定性应用到 sourceHtml,产出 { html, applied, skipped } ——
// 规则:范围外(out_of_scope)/定位不到(not_found)/歧义(ambiguous) → skipped 不应用;
//      区间重叠 → 相关编辑双双 conflict 不应用;同一元素多条 set_style 合并;
//      replace_text(文本区间)与 set_style(起始标签区间)天然不相交,不误判冲突;
//      逆序 splice 应用,未命中区域逐字保留。
export function applyEdits(sourceHtml, edits, task) {
  const src = String(sourceHtml);
  const scope = collectScope(task);
  const skipped = [];
  const textEdits = [];                 // { id, start, end, replacement }
  const styleByTag = new Map();         // tagStart -> { tagEnd, tagStr, props:[{property,value}], ids:[] }

  for (const edit of (edits || [])) {
    if (!editInScope(edit, scope)) {
      skipped.push({ id: edit.id, status: "out_of_scope", message: "edit not tied to any selected comment" });
      continue;
    }
    const loc = locateExact(src, edit.locator);
    if (loc.status !== "ok") {
      skipped.push({ id: edit.id, status: loc.status, message: loc.status === "not_found" ? "locator not found in source" : "locator ambiguous (multiple matches)" });
      continue;
    }
    if (edit.action === "replace_text") {
      textEdits.push({ id: edit.id, start: loc.start, end: loc.end, replacement: edit.replacement });
    } else {
      const owner = owningStartTag(src, loc.start);
      if (!owner) { skipped.push({ id: edit.id, status: "not_found", message: "owning element start tag not found" }); continue; }
      let g = styleByTag.get(owner.tagStart);
      if (!g) { g = { tagEnd: owner.tagEnd, tagStr: owner.tagStr, props: [], ids: [] }; styleByTag.set(owner.tagStart, g); }
      g.props.push({ property: edit.property, value: edit.value });
      g.ids.push(edit.id);
    }
  }

  // 每 tag 合并为一个 rewrite
  const styleEdits = [];
  for (const [tagStart, g] of styleByTag) {
    let tag = g.tagStr;
    for (const p of g.props) tag = rewriteStyleAttr(tag, p.property, p.value);
    styleEdits.push({ start: tagStart, end: g.tagEnd, replacement: tag, ids: g.ids, action: "set_style" });
  }
  const all = textEdits.map((e) => ({ ...e, ids: [e.id], action: "replace_text" })).concat(styleEdits);

  // 区间重叠 → 双双 conflict
  const conflicted = new Set();
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      if (all[a].start < all[b].end && all[b].start < all[a].end) { conflicted.add(a); conflicted.add(b); }
    }
  }
  const toApply = [];
  all.forEach((r, idx) => {
    if (conflicted.has(idx)) {
      r.ids.forEach((id) => skipped.push({ id, status: "conflict", message: "edit region overlaps another edit" }));
    } else toApply.push(r);
  });

  toApply.sort((x, y) => y.start - x.start);
  let html = src;
  for (const r of toApply) html = html.slice(0, r.start) + r.replacement + html.slice(r.end);

  const applied = [];
  // 维持 edits 原始顺序汇报 applied(更可读)
  const appliedIds = new Set();
  for (const r of toApply) r.ids.forEach((id) => appliedIds.add(id));
  for (const edit of (edits || [])) {
    if (appliedIds.has(edit.id)) applied.push({ id: edit.id, action: edit.action });
  }
  return { html, applied, skipped };
}
