// extension/palette.js — 编辑调色板单一来源(v0.9.1):工具栏浮窗(content-script)与 Side Panel 共用同一份取值,杜绝漂移。
// 加载于 content-script 隔离世界(manifest content_scripts)与 sidepanel 页面(<script>);两上下文各自持有一份实例,取值完全一致。
// 高亮色刻意包含白色(深色背景页/弱化高亮用途)与 transparent(清除高亮底色);共 16 格 = 侧栏 8 列 × 2 行整齐无空位。
// 文字色 16 格;第 15 格统一为品牌 mint #88e6d1(替换旧蓝 #7c8cff)。
(function (root) {
  "use strict";
  if (root.HG_PALETTE) return; // 防重复加载
  // 文字色:16 色;含 #ffffff(深色背景白字正常用途)。无"清除"概念(选色即上色)。
  var TEXT_COLORS = [
    "#0a0a0a", "#374151", "#6b7280", "#9ca3af", "#ffffff", "#ef4444", "#f97316", "#f59e0b",
    "#10b981", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#88e6d1", "#e11d48"
  ];
  // 高亮色:14 个色相 + #ffffff(白)+ "transparent"(清除)。transparent 在 UI 用红斜杠标记。
  // (相对旧版合并了两个极近的黄色 #fff59d/#ffe14d → 留 #fff59d 与 #ffd54f,腾出白色格。)
  var HL_COLORS = [
    "#fff59d", "#ffd54f", "#ffcdd2", "#f8bbd0", "#e1bee7", "#c5cae9", "#bbdefb", "#b2dfdb",
    "#c8e6c9", "#dcedc8", "#ffccbc", "#ffe0b2", "#d7ccc8", "#e5e7eb", "#ffffff", "transparent"
  ];
  root.HG_PALETTE = Object.freeze({ TEXT_COLORS: Object.freeze(TEXT_COLORS), HL_COLORS: Object.freeze(HL_COLORS) });
})(typeof globalThis !== "undefined" ? globalThis : this);
