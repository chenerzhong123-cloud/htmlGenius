// bridge/test/packaging-selfcontained.test.mjs — v0.9.4 回归守护。
//
// 背景:v0.9.3 的 bridge/task-bundle.mjs 与 plan-workspace.mjs 在模块顶层
//   require("../extension/change-contract.js") / require("../extension/plan-validate.js")。
//   这两个路径只在仓库内解析得通;发布到 npm / 受管安装目录(~/.htmlgenius/bridge/versions/<v>/)
//   里根本没有上级 extension/ 目录 → MODULE_NOT_FOUND → host 启动即崩 →
//   所有走标准流程的用户 Connection Center 都报 BRIDGE_NOT_INSTALLED。
//
// 修法:把这两个共享文件 vendor 到 bridge/vendor/ 子目录,并放一个 {"type":"commonjs"} 的
//   package.json,强制它们按 CJS 加载(与 bridge 根包 type:module 隔离;这两个文件是 UMD,ESM 下
//   `root = window ?? this` 的 this 为 undefined 会崩,CJS 下 this=module.exports 正常)。
//
// 本文件三重守护,防止该类「包内模块依赖包外仓库路径 / 模块系统不匹配」的 bug 再次漏网:
// ① bridge 运行时 *.mjs 不得出现指向包外的相对 require/import(../ 开头);
// ② vendor 文件入 files 白名单、bridge/vendor/ 存在且与 extension/ 同源、vendor/package.json 为 commonjs 飞地;
// ③ 隔离布局(临时目录,无 ../extension/)下 task-bundle / plan-workspace 必须能正常加载
//    ——精确复现 v0.9.3 的 host 启动崩溃点。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(bridgeDir, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(bridgeDir, "package.json"), "utf8"));
// [bridge 相对路径, extension 源文件名]
const VENDORS = [
  ["vendor/change-contract.js", "change-contract.js"],
  ["vendor/plan-validate.js", "plan-validate.js"],
];

// ① bridge 运行时模块不得引用包外 ../ 路径(../extension/* 等在生产必崩)。
test("bridge 运行时模块无包外相对依赖(../ 在生产会 MODULE_NOT_FOUND)", () => {
  const bad = fs.readdirSync(bridgeDir)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => /(?:require\(\s*|from\s+)["']\.\.\//.test(fs.readFileSync(path.join(bridgeDir, f), "utf8")));
  assert.deepEqual(bad, [], "bridge 模块仍引用包外 ../ 路径,生产会崩: " + bad.join(", "));
});

// ② vendor 飞地:files 白名单含 vendor/、文件存在且与 extension/ 同源、package.json 为 commonjs。
test("vendor 共享文件入白名单 + 与 extension/ 同源 + commonjs 飞地", () => {
  assert.ok(Array.isArray(pkg.files), "须有 files 白名单");
  assert.ok(pkg.files.includes("vendor/"), 'files 白名单须含 "vendor/"');
  // vendor/package.json 必须强制 commonjs(否则根包 type:module 会让 .js 走 ESM,UMD 崩)
  const vpkg = JSON.parse(fs.readFileSync(path.join(bridgeDir, "vendor", "package.json"), "utf8"));
  assert.equal(vpkg.type, "commonjs", "vendor/package.json 须 {\"type\":\"commonjs\"}");
  for (const [bRel, eName] of VENDORS) {
    const b = path.join(bridgeDir, bRel);
    const e = path.join(repoRoot, "extension", eName);
    assert.ok(fs.existsSync(b), `bridge/ 缺 vendor 文件 ${bRel}`);
    assert.ok(fs.existsSync(e), `extension/ 缺源文件 ${eName}`);
    assert.equal(
      fs.readFileSync(b, "utf8"),
      fs.readFileSync(e, "utf8"),
      `bridge/${bRel} 与 extension/${eName} 不一致——请重新 vendor:cp extension/${eName} bridge/${bRel}`
    );
  }
});

// ③ 隔离布局加载:把 bridge 运行时拷到无 ../extension/ 的临时目录,
//    断言 task-bundle / plan-workspace 能加载(复现并守护生产受管目录场景)。
test("隔离布局(无 ../extension/)下 task-bundle / plan-workspace 可加载", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-selfcontained-"));
  try {
    fs.cpSync(bridgeDir, tmp, {
      recursive: true,
      filter: (s) => !["test", "verify", "node_modules", ".DS_Store"].includes(path.basename(s)),
    });
    // 隔离性自检:临时目录上级不得存在 extension/change-contract.js
    assert.ok(
      !fs.existsSync(path.join(path.dirname(tmp), "extension", "change-contract.js")),
      "测试环境异常:临时目录上级存在 extension/,隔离性失效"
    );
    // vendor 飞地必须一同拷过去(含 vendor/package.json 的 commonjs 声明)
    assert.ok(fs.existsSync(path.join(tmp, "vendor", "package.json")), "vendor/package.json 未随拷贝");
    // 被修过的两个模块必须在隔离布局下加载成功(这就是受管安装/发布包的真实布局)
    const tb = await import(pathToFileURL(path.join(tmp, "task-bundle.mjs")).href);
    const pw = await import(pathToFileURL(path.join(tmp, "plan-workspace.mjs")).href);
    assert.equal(typeof tb.canonicalTaskJson, "function", "task-bundle.mjs 未正常导出");
    assert.ok(pw && typeof pw === "object", "plan-workspace.mjs 未正常加载");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
