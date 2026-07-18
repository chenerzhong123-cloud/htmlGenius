// bridge/prompt.mjs — 生成交给 Codex 的单一 text 输入(§8)。
// 不让 Side Panel 拼 prompt;复用扩展侧 ChangeContract.renderPrompt(task) 作为单一真相源(经 createRequire)。
// 前言 + renderPrompt + 路径 + 验收要求;restructure 永不调用(host/background 已拦截,此处再防御)。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ChangeContract = require("../extension/change-contract.js");

const PRELUDE = [
  "你由 HTML Genius Local Bridge 启动。你只能读取 source HTML，且只能把最终候选页面写到指定 result.html。",
  "不得修改、重命名或删除 source HTML；不得写 candidate 目录之外的文件；不得访问网络；不得要求用户提供 API key。",
  "在开始前读取 source HTML。严格执行下方 Change Contract；其中未允许的内容默认不得修改。",
  "完成时确保 result.html 是完整、可独立打开的 HTML 文档。不要只在对话中给出代码，不要等待用户复制粘贴。",
  "若无法在契约范围内完成，停止，不创建 result.html，并在最终回复中简述阻塞原因。"
].join("\n");

export function buildCodexPrompt({ task, sourcePath, resultPath }) {
  if (!task || task.mode === "restructure") {
    const err = new Error("restructure must not reach the bridge"); err.code = "INVALID_MODE"; throw err;
  }
  const rendered = ChangeContract.renderPrompt(task);
  const parts = [];
  parts.push("# HTML Genius Local Bridge 任务");
  parts.push("");
  parts.push("## 安全前言(不可放松)");
  parts.push(PRELUDE);
  parts.push("");
  parts.push("## Change Contract(严格执行)");
  parts.push(rendered);
  parts.push("");
  parts.push("## 文件路径");
  parts.push("- 只读 source HTML:" + sourcePath);
  parts.push("- 唯一可写 candidate(result.html):" + resultPath);
  parts.push("- candidate 目录之外的任何文件都不得创建或修改。");
  parts.push("");
  parts.push("## 完成验收");
  parts.push("- result.html 必须存在、是 regular file、为完整可独立打开的 HTML 文档。");
  parts.push("- 只允许在 candidate 目录写入;source HTML 字节级不得变化。");
  if (task.mode === "regenerate") {
    parts.push("- regenerate:candidate 是新版本,不代表已取代 source;原文件仍以用户决定为准。");
  }
  return parts.join("\n");
}
