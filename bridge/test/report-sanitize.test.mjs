// bridge/test/report-sanitize.test.mjs — v0.9.1 §7:report 脱敏与泄露回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeVerificationReport, makeReportSkeleton, finalizeReport } from "../verify/report-sanitize.mjs";

test("sanitize:递归剥离敏感键(嵌套/数组)", () => {
  const dirty = {
    schema_version: 1, result: "passed",
    providers: [{
      id: "claude_code_cli",
      checks: [{ id: "probe.ready", result: "passed", reason_code: null, stderr: "boom", path: "/Users/x/y" }],
      session: { id: "s1" }, thread_id: "t1", token: "tok", cookie: "c", prompt: "p", comment: "c", html: "<x>", stack: "st", env: {}, command: "rm", argv: [], stdout: "o", username: "u", hostname: "h"
    }]
  };
  const clean = sanitizeVerificationReport(dirty);
  const json = JSON.stringify(clean);
  for (const bad of ["stderr", "path", "session", "thread_id", "token", "cookie", "prompt", "comment", "html", "stack", "env", "command", "argv", "stdout", "username", "hostname"]) {
    assert.ok(!json.includes('"' + bad + '"'), "残留敏感键 " + bad);
  }
  assert.equal(clean.providers[0].checks[0].id, "probe.ready");
  assert.equal(clean.providers[0].checks[0].result, "passed");
});

test("sanitize:字符串值中的绝对路径被占位", () => {
  const clean = sanitizeVerificationReport({ note: "failed at /Users/someone/bridge/x and /tmp/hg-1/y" });
  assert.ok(!clean.note.includes("/Users/someone"));
  assert.ok(!clean.note.includes("/tmp/hg-1"));
  assert.ok(clean.note.includes("<redacted-path>"));
});

test("report 骨架 + finalize 汇总(§7.1)", () => {
  const r = makeReportSkeleton({ kind: "provider_certification", bridgeVersion: "0.9.1" });
  assert.equal(r.schema_version, 1);
  assert.equal(r.kind, "provider_certification");
  assert.equal(r.bridge.version, "0.9.1");
  r.providers.push({ id: "a", checks: [{ id: "x", result: "passed" }, { id: "y", result: "skipped" }] });
  r.providers.push({ id: "b", checks: [{ id: "z", result: "failed" }] });
  finalizeReport(r);
  assert.deepEqual(r.summary, { passed: 1, failed: 1, skipped: 1 });
  assert.equal(r.result, "failed");
  assert.ok(r.finished_at);
});
