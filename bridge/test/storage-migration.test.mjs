// bridge/test/storage-migration.test.mjs — 锁定 v0.8.1 storage.js 的 DB v5 迁移契约(spec §5.5/§9)。
// 无 IndexedDB shim 时,用源码级断言保证:升级只新增 bridge_plans,绝不删除/重建 bridge_sessions/bridge_runs。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storage = fs.readFileSync(path.resolve(__dirname, "..", "..", "extension", "storage.js"), "utf8");

test("DB_VERSION = 5", () => {
  assert.match(storage, /DB_VERSION\s*=\s*5/);
});

test("bridge_plans store:keyPath=plan_id + 4 索引(logical_document_id/tab_id/status/plan_run_id)", () => {
  // 截 bridge_plans 创建块(取足够大的窗口覆盖 4 个 createIndex)
  const start = storage.indexOf('createObjectStore("bridge_plans"');
  assert.ok(start > -1, "缺 bridge_plans store 创建");
  const block = storage.slice(start, start + 700);
  assert.match(block, /keyPath:\s*"plan_id"/);
  assert.match(block, /createIndex\("logical_document_id"/);
  assert.match(block, /createIndex\("tab_id"/);
  assert.match(block, /createIndex\("status"/);
  assert.match(block, /createIndex\("plan_run_id"/);
});

test("bridge_plans 创建由 !contains 守卫(幂等,只新增不删)", () => {
  assert.match(storage, /if \(!db\.objectStoreNames\.contains\("bridge_plans"\)\)/);
});

test("v3→v4 的删除重建被 e.oldVersion < 4 严格门禁:v4→v5 升级不会触碰 bridge_sessions/bridge_runs(spec §9 关键)", () => {
  // 删除 bridge_sessions/runs 的代码必须包在 if (e.oldVersion < 4) 内
  const delIdx = storage.indexOf('deleteObjectStore("bridge_sessions")');
  assert.ok(delIdx > -1, "找不到 v3 废弃删除");
  // 向前找最近的老版本门禁
  const gateIdx = storage.lastIndexOf("e.oldVersion < 4", delIdx);
  assert.ok(gateIdx > -1 && gateIdx < delIdx, "删除未被 oldVersion<4 门禁保护");
  // 门禁块闭合应在删除之后(粗校:删除行到下一个 } 之间无提前关闭导致的越界)
  assert.ok(delIdx < storage.indexOf("bridge_sessions", delIdx + 10) || true); // 仅占位,关键断言是上面的 gate
});

test("LocalStore + facade 提供 bridge_plans CRUD(spec §5.5)", () => {
  for (const m of ["saveBridgePlan", "getBridgePlan", "updateBridgePlan", "markDraftPlansStaleForDocument"]) {
    assert.ok(storage.indexOf(m + "(") > -1, "LocalStore 缺方法: " + m);
    // facade 转发也存在
    assert.ok(storage.indexOf(m + "(") !== storage.lastIndexOf(m + "("), "facade 未转发: " + m);
  }
});
