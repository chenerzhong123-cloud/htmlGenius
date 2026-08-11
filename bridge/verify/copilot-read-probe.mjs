#!/usr/bin/env node
// bridge/verify/copilot-read-probe.mjs — Copilot 读源最小复现(诊断脚本,非产品代码)。
//
// 目的:隔离"Copilot 读不到源文件"的根因——是【我们的配置】还是【Copilot CLI/SDK 自身】。
// 做法:用与 htmlgenius 完全相同的 Copilot 配置(mode:"empty" + workingDirectory + baseDirectory
//   + availableTools + onPreToolUse 路径围栏),在一个临时目录放一个带水印的测试文件,
//   让 Copilot 用 read 工具读它,看能否读出水印。
//
// 用法(在 mac pro 的 bridge 目录):
//   node verify/copilot-read-probe.mjs                 # 完全复刻 htmlgenius 配置
//   node verify/copilot-read-probe.mjs --no-empty-mode  # 对照:不用 mode:"empty"/availableTools 限制
//
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadCopilotSdk, selectCopilotRuntime, buildCopilotClientOptions,
  buildAvailableTools, buildExcludedTools, createPreToolPolicy, readCopilotCliVersion
} from "../copilot-runtime.mjs";

const WATERMARK = "HTMLGENIUS-PROBE-WATERMARK-9281";
const TIMEOUT_MS = 120000;

function parseArgs() {
  const a = { noEmpty: false, workdir: null };
  for (let i = 2; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === "--no-empty-mode") a.noEmpty = true;
    else if (v === "--working-dir") a.workdir = process.argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs();
  // 1. 临时工作目录 + 测试文件(模拟 htmlgenius 的 run workspace:source.html 就在工作目录里)
  //    --working-dir 给定时自动创建(用于测试隐藏目录等不同路径形态)。
  const cwd = args.workdir || fs.mkdtempSync(path.join(os.tmpdir(), "hg-copilot-probe-"));
  fs.mkdirSync(cwd, { recursive: true });
  const helloPath = path.join(cwd, "hello.txt");
  fs.writeFileSync(helloPath, "The secret token is " + WATERMARK + ".\n", { mode: 0o600 });
  const baseDirectory = path.join(cwd, ".copilot-home-probe");
  fs.mkdirSync(baseDirectory, { recursive: true });
  console.log("[probe] workingDirectory =", cwd);
  console.log("[probe] test file        =", helloPath);
  console.log("[probe] baseDirectory    =", baseDirectory);
  console.log("[probe] mode:empty       =", !args.noEmpty);

  // 2. 加载 SDK + 选 runtime(与 htmlgenius 同源:local CLI 优先,bundled 兜底)
  const sdk = await loadCopilotSdk();
  const sel = await selectCopilotRuntime({ requiredRuntime: null });
  console.log("[probe] runtime =", sel.runtime, " cliPath =", sel.cliPath);
  try { if (sel.cliPath) { const v = await readCopilotCliVersion(sel.cliPath); console.log("[probe] CLI version =", v); } } catch (_) {}

  // 3. onPreToolUse 策略(与 htmlgenius 同:read 白名单 + 路径围栏)+ 记录拒绝
  const denials = [];
  const { handler } = createPreToolPolicy({
    workspaceDir: cwd, writableFiles: [],
    recordDenial: (t, c) => { denials.push({ tool: t, category: c }); console.log("[probe] TOOL DENIED:", t, "(" + c + ")"); }
  });

  // 4. client options(--no-empty-mode 时用默认工具集,不传 availableTools/excludedTools)
  const options = args.noEmpty
    ? { workingDirectory: cwd, baseDirectory, telemetry: { enabled: false }, connection: sdk.RuntimeConnection.forStdio({ path: sel.cliPath }) }
    : buildCopilotClientOptions({ sdk, runtime: sel.runtime, cliPath: sel.cliPath, cwd, baseDirectory });

  const client = new sdk.CopilotClient(options);
  let session = null;
  const texts = [];
  try {
    await client.start();
    const sessionOpts = { clientName: "hg-copilot-probe", hooks: { onPreToolUse: handler } };
    if (!args.noEmpty) { sessionOpts.availableTools = buildAvailableTools(); sessionOpts.excludedTools = buildExcludedTools(); }
    session = await client.createSession(sessionOpts);
    if (typeof session.on === "function") {
      session.on((event) => {
        const type = event && event.type;
        if (type === "tool.execution_start") console.log("[probe] tool:", String((event.data && event.data.toolName) || ""));
        else if (type === "assistant.message") { const txt = String((event.data && event.data.content) || ""); console.log("[probe] assistant:", txt.slice(0, 300)); texts.push(txt); }
        else if (type === "session.idle") console.log("[probe] idle");
      });
    }
    const prompt = "Read the file hello.txt in the current directory using your read tool, then reply with its exact content verbatim.";
    console.log("[probe] sending prompt...");
    const reply = await session.sendAndWait({ prompt }, TIMEOUT_MS);
    // reply 对象形状因 SDK 版本而异;统一用 assistant 消息文本(texts)做水印判定,最可靠。
    const replyText = String((reply && (reply.text || reply.message || JSON.stringify(reply))) || "");
    const allText = texts.join("\n") + "\n" + replyText;
    console.log("\n[probe] === RESULT ===");
    console.log("[probe] reply   :", (texts.join(" ").slice(0, 500)) || replyText.slice(0, 500));
    console.log("[probe] denials :", JSON.stringify(denials));
    const ok = allText.includes(WATERMARK);
    console.log("\n[probe] " + (ok ? "✅ SUCCESS — Copilot 读到了文件(水印命中)。" : "❌ FAIL — Copilot 没读到文件(水印缺失)。"));
    if (!ok) {
      console.log("[probe] 判定:");
      if (denials.length) console.log("[probe]   • denials 非空 → 是【我们的 onPreToolUse 策略】挡的(category 见上)。");
      else console.log("[probe]   • denials 空 → 不是我们的策略,是【Copilot CLI/SDK 自身】未读到。");
      console.log("[probe]   • 再跑 `node verify/copilot-read-probe.mjs --no-empty-mode` 对照:若加了能读 → mode:\"empty\"+availableTools 是元凶;若仍读不到 → CLI/SDK/工作目录本身。");
    }
  } finally {
    if (session) { try { await session.disconnect(); } catch (_) {} }
    try { await client.stop(); } catch (_) { try { await client.forceStop(); } catch (_) {} }
  }
}

main().catch((e) => { console.error("[probe] ERROR:", (e && e.message) || e); process.exit(1); });
