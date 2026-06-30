// text-quote anchoring:DOM Range ⇄ TextQuoteSelector 双向转换。
// 算法忠实参考 Hypothesis client(https://github.com/hypothesis/client,BSD-2-Clause)
// 的 text-quote anchoring 思路:空白规范化 + prefix/suffix 消歧 + 文本节点映射。
// 阶段 0 的自包含精简实现。

const CONTEXT = 32; // prefix / suffix 上下文长度

/** 遍历 root 下文本节点,构建:原始全文 raw、规范化文本 normalized、
 *  规范化字符 → 原始字符偏移映射 normToRaw、文本节点区间表 textNodes。 */
function buildIndex(root) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  let raw = "";
  let rawPos = 0;
  while ((node = walker.nextNode())) {
    const parent = node.parentNode;
    if (parent && (parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE")) continue;
    const data = node.data;
    textNodes.push({ node, start: rawPos, end: rawPos + data.length });
    raw += data;
    rawPos += data.length;
  }

  let normalized = "";
  const normToRaw = []; // normToRaw[i] = 规范化第 i 个字符对应的 raw 偏移
  let i = 0;
  while (i < raw.length) {
    if (/\s/.test(raw[i])) {
      normalized += " ";
      normToRaw.push(i);
      while (i < raw.length && /\s/.test(raw[i])) i++;
    } else {
      normalized += raw[i];
      normToRaw.push(i);
      i++;
    }
  }
  return { textNodes, raw, normalized, normToRaw };
}

/** raw 偏移 → normalized 偏移(normToRaw 递增,二分) */
function rawToNorm(rawOff, normToRaw) {
  let lo = 0;
  let hi = normToRaw.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (normToRaw[mid] <= rawOff) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 文本节点 + 节点内偏移 → raw 偏移 */
function nodeOffsetToRaw(textNodes, container, offset) {
  for (const tn of textNodes) {
    if (tn.node === container) return tn.start + offset;
  }
  return null;
}

/** Range → normalized 文本中的 [start, end) */
function rangeToOffsets(range, index) {
  const startRaw = nodeOffsetToRaw(index.textNodes, range.startContainer, range.startOffset);
  const endRaw = nodeOffsetToRaw(index.textNodes, range.endContainer, range.endOffset);
  if (startRaw === null || endRaw === null) return null;
  return { start: rawToNorm(startRaw, index.normToRaw), end: rawToNorm(endRaw, index.normToRaw) };
}

/** raw 偏移 → 所在文本节点 + 节点内偏移 */
function locate(textNodes, rawOff) {
  for (const tn of textNodes) {
    if (rawOff >= tn.start && rawOff < tn.end) return { node: tn.node, offset: rawOff - tn.start };
  }
  const last = textNodes[textNodes.length - 1];
  if (last && rawOff === last.end) return { node: last.node, offset: last.node.data.length };
  return null;
}

/** raw 偏移区间 → DOM Range */
function rawToRange(textNodes, rawStart, rawEnd) {
  const s = locate(textNodes, rawStart);
  const e = locate(textNodes, Math.max(rawStart, rawEnd - 1));
  if (!s || !e) return null;
  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset + 1);
  return range;
}

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** Range → TextQuoteSelector */
function describe(range, root) {
  const index = buildIndex(root);
  const off = rangeToOffsets(range, index);
  if (!off) return null;
  const text = index.normalized;
  return {
    type: "TextQuoteSelector",
    exact: text.slice(off.start, off.end),
    prefix: text.slice(Math.max(0, off.start - CONTEXT), off.start),
    suffix: text.slice(off.end, Math.min(text.length, off.end + CONTEXT)),
  };
}

/** TextQuoteSelector → Range(找不到返回 null,即 stale) */
function anchor(selector, root) {
  const index = buildIndex(root);
  const text = index.normalized;
  const exact = selector.exact;
  if (!exact) return null;

  const candidates = [];
  let from = 0;
  while (from <= text.length) {
    const pos = text.indexOf(exact, from);
    if (pos === -1) break;
    candidates.push(pos);
    from = pos + 1;
  }
  if (candidates.length === 0) return null;

  let best = -1;
  let bestScore = -1;
  for (const pos of candidates) {
    const pre = text.slice(Math.max(0, pos - CONTEXT), pos);
    const suf = text.slice(pos + exact.length, Math.min(text.length, pos + exact.length + CONTEXT));
    let score = 0;
    if (selector.prefix) score += commonSuffix(pre, selector.prefix);
    if (selector.suffix) score += commonPrefix(suf, selector.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }

  // 多处命中 + 前后文消歧不足 → 判 stale(review 1.2:避免静默漂移到错误位置)
  if (candidates.length > 1 && bestScore < exact.length * 0.5) return null;

  const normStart = best;
  const normEnd = best + exact.length;
  const rawStart = index.normToRaw[normStart];
  const rawEnd = (index.normToRaw[normEnd - 1] ?? rawStart) + 1;
  return rawToRange(index.textNodes, rawStart, rawEnd);
}
window.describe = describe; window.anchor = anchor;
