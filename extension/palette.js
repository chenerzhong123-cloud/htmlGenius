// extension/palette.js — 编辑调色板单一来源(v0.9.1):工具栏浮窗(content-script)与 Side Panel 共用同一份取值,杜绝漂移。
// 加载于 content-script 隔离世界(manifest content_scripts)与 sidepanel 页面(<script>);两上下文各自持有一份实例,取值完全一致。
// 高亮色刻意包含白色(深色背景页/弱化高亮用途)与 transparent(清除高亮底色);共 16 格 = 侧栏 8 列 × 2 行整齐无空位。
(function (root) {
  "use strict";
  if (root.HG_PALETTE) return; // 防重复加载
  // 高亮色:14 个色相 + #ffffff(白)+ "transparent"(清除)。transparent 在 UI 用红斜杠标记。
  // (相对旧版合并了两个极近的黄色 #fff59d/#ffe14d → 留 #fff59d 与 #ffd54f,腾出白色格。)
  var HL_COLORS = [
    "#fff59d", "#ffd54f", "#ffcdd2", "#f8bbd0", "#e1bee7", "#c5cae9", "#bbdefb", "#b2dfdb",
    "#c8e6c9", "#dcedc8", "#ffccbc", "#ffe0b2", "#d7ccc8", "#e5e7eb", "#ffffff", "transparent"
  ];
  root.HG_PALETTE = Object.freeze({ HL_COLORS: HL_COLORS });
})(typeof globalThis !== "undefined" ? globalThis : this);
