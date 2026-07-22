// bridge/test/provider-fixture-contract.test.mjs — v0.9.1 §4.2:fixture 硬门。
// 对 registry 每个 provider 循环:形状/能力一致/必需场景齐全/runtime_locked 必有 runtime_changed/
// probe 调用无敏感泄露。未来「忘记给新 Agent 写 fake」在这里直接失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_REGISTRY, listProviderIds } from "../provider-registry.mjs";
import {
  REQUIRED_PROBE_SCENARIOS, REQUIRED_CANDIDATE_SCENARIOS, REQUIRED_PLAN_SCENARIOS,
  assertFixtureShape, assertReportSanitized
} from "./providers/provider-fixture-contract.mjs";
import { fixture as claudeFixture } from "./providers/claude-code.fixture.mjs";
import { fixture as codexFixture } from "./providers/codex-app-server.fixture.mjs";
import { fixture as copilotFixture } from "./providers/github-copilot.fixture.mjs";

const FIXTURES = { claude_code_cli: claudeFixture, codex_app_server: codexFixture, github_copilot: copilotFixture };

test("registry 每个 provider 都有 fixture,且通过形状硬门(§4.2)", () => {
  for (const id of listProviderIds()) {
    const fixture = FIXTURES[id];
    assert.ok(fixture, "缺 fixture: " + id);
    assertFixtureShape(fixture, PROVIDER_REGISTRY[id]);
  }
});

test("每个 fixture 的必需场景齐全(不可跳过认证场景)", () => {
  for (const id of listProviderIds()) {
    const fixture = FIXTURES[id];
    const scenarios = new Set(fixture.scenarios);
    for (const s of REQUIRED_PROBE_SCENARIOS) assert.ok(scenarios.has(s), id + " 缺 " + s);
    if (fixture.capabilities.includes("candidate")) {
      for (const s of REQUIRED_CANDIDATE_SCENARIOS) assert.ok(scenarios.has(s), id + " 缺 " + s);
    }
    if (fixture.capabilities.includes("plan")) {
      for (const s of REQUIRED_PLAN_SCENARIOS) assert.ok(scenarios.has(s), id + " 缺 " + s);
    }
  }
});

test("每个 probe 场景都能执行且结果脱敏(无 path/token/session/stderr 键)", async () => {
  for (const id of listProviderIds()) {
    const fixture = FIXTURES[id];
    for (const name of REQUIRED_PROBE_SCENARIOS) {
      const scen = fixture.makeProbeScenario(name);
      const result = await scen.invoke();
      assert.ok(result && typeof result.status === "string", id + "/" + name + " 应返回 probe 结果");
      const expected = fixture.probeExpectations[name] || [];
      assert.ok(expected.includes(result.status), id + "/" + name + " 状态 " + result.status + " 不在期望集合 " + JSON.stringify(expected));
      const problems = assertReportSanitized(result);
      assert.deepEqual(problems, [], id + "/" + name + " probe 输出泄露: " + problems.join(","));
    }
  }
});

test("makeRunScenario 对每个声明场景返回可调用的 invoke(接口一致性)", () => {
  for (const id of listProviderIds()) {
    const fixture = FIXTURES[id];
    const ctx = {};
    for (const name of fixture.scenarios) {
      if (REQUIRED_PROBE_SCENARIOS.includes(name)) continue;
      const run = fixture.makeRunScenario(name, ctx);
      assert.equal(typeof run.invokeCandidate, "function", id + "/" + name + " 缺 invokeCandidate");
      assert.equal(typeof run.invokePlan, "function", id + "/" + name + " 缺 invokePlan");
    }
    fixture.cleanup(ctx);
  }
});
