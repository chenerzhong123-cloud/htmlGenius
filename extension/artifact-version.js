// artifact-version.js — 完整本地 HTML artifact 的可测试版本指纹工具。
(function () {
  "use strict";

  const EXTENSION_SELECTOR = "#hg-toolbar, .hg-hl, .hg-inspect, .hg-select, .hg-tip, .hg-drop, style[data-hg-injected=\"ui\"]";

  function normalizeArtifactHtml(html) {
    return String(html == null ? "" : html).replace(/\r\n?/g, "\n");
  }

  function stripExtensionNodes(root) {
    if (!root || !root.querySelectorAll) return;
    // content-script 用该属性同步 sidepanel 主题；它不是用户 artifact 的一部分。
    if (root.removeAttribute) root.removeAttribute("data-hg-theme");
    root.querySelectorAll(EXTENSION_SELECTOR).forEach((node) => node.remove());
  }

  function serializeCurrentArtifact(documentElement) {
    if (!documentElement || !documentElement.cloneNode) throw new Error("documentElement is required");
    const clone = documentElement.cloneNode(true);
    stripExtensionNodes(clone);
    return "<!doctype html>\n" + clone.outerHTML;
  }

  async function sha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
      throw new Error("Web Crypto SHA-256 is unavailable");
    }
    const bytes = new TextEncoder().encode(normalizeArtifactHtml(text));
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return "sha256:" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  window.HgArtifactVersion = Object.freeze({
    normalizeArtifactHtml,
    sha256Hex,
    serializeCurrentArtifact,
    stripExtensionNodes,
  });
})();
