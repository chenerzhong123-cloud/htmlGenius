// bridge/test/real-smoke-gate.test.mjs — v0.9.1 §8.2:real smoke 安全门(不连 provider)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGate, chromeNativeSmokePlan } from "../verify/real-smoke.mjs";

test("gate:缺 HTMLGENIUS_ALLOW_REAL_SMOKE → 拒绝", () => {
  const r = checkGate({ HTMLGENIUS_SMOKE_WORKSPACE: "/tmp/whatever" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "SMOKE_NOT_ALLOWED");
});

test("gate:workspace 缺失/相对路径 → 拒绝", () => {
  assert.equal(checkGate({ HTMLGENIUS_ALLOW_REAL_SMOKE: "1" }).code, "SMOKE_WORKSPACE_INVALID");
  assert.equal(checkGate({ HTMLGENIUS_ALLOW_REAL_SMOKE: "1", HTMLGENIUS_SMOKE_WORKSPACE: "rel/dir" }).code, "SMOKE_WORKSPACE_INVALID");
});

test("gate:HOME/Desktop/repo 内路径 → 拒绝", () => {
  const home = os.homedir();
  for (const p of [home, path.join(home, "Desktop"), path.join(home, "smoke-x")]) {
    const r = checkGate({ HTMLGENIUS_ALLOW_REAL_SMOKE: "1", HTMLGENIUS_SMOKE_WORKSPACE: p });
    assert.equal(r.ok, false, p + " 应被拒绝");
    assert.equal(r.code, "SMOKE_WORKSPACE_FORBIDDEN");
  }
});

test("gate:非空目录 → 拒绝;新建空目录 → 通过", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hg-smoke-gate-"));
  try {
    const notEmpty = path.join(base, "notempty");
    fs.mkdirSync(notEmpty);
    fs.writeFileSync(path.join(notEmpty, "f.txt"), "x");
    assert.equal(checkGate({ HTMLGENIUS_ALLOW_REAL_SMOKE: "1", HTMLGENIUS_SMOKE_WORKSPACE: notEmpty }).code, "SMOKE_WORKSPACE_NOT_EMPTY");

    const fresh = path.join(base, "fresh-dir");
    const r = checkGate({ HTMLGENIUS_ALLOW_REAL_SMOKE: "1", HTMLGENIUS_SMOKE_WORKSPACE: fresh });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(fresh), "空 workspace 自动创建");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("chromeNativeSmokePlan:明确 manual gate,不声称无人值守 E2E", () => {
  const plan = chromeNativeSmokePlan();
  assert.equal(plan.status, "manual_gate");
  assert.equal(plan.unattended_e2e_claimed, false);
  assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 3);
});
