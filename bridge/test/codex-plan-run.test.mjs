// bridge/test/codex-plan-run.test.mjs — v0.8.1 Codex plan 执行编排(spec §6.6/§6.8/§9 Bridge)。
// 注入 fake client(对象级 runPlan/close):验证 plan-ready、绝不产 candidate/sibling、runPlan 被调(非 runCandidate)、
// source/task 运行期改动失败、缺失/无效 plan 失败。(thread/start vs resume / writableRoots / 禁网 在 codex-app-server-client.test.mjs 的 RPC 序列层覆盖)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeCodexPlanRun } from '../codex-adapter.mjs';
import { sha256File } from '../candidate-workspace.mjs';

function makeSchemaDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sch-'));
  fs.writeFileSync(path.join(d, 'ClientRequest.json'), JSON.stringify({
    initialize: {}, 'thread/start': {}, 'thread/resume': {},
    'turn/start': { sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'never', cwd: 'x' }
  }));
  return d;
}
function mkFix(mode = 'precise_patch') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-codplan-'));
  const src = path.join(dir, 'report.html');
  fs.writeFileSync(src, '<!doctype html><html><body>hello world</body></html>');
  const root = path.join(dir, '.htmlgenius-bridge', 'codex', 'hgd_cxp');
  fs.mkdirSync(root, { recursive: true });
  const task = {
    schema_version: 1, kind: 'htmlgenius_change_contract', mode,
    artifact: { title: 'T', url: pathToFileURL(src).href, is_local: true },
    source: { root_annotation_ids: ['r1'], root_annotation_count: 1 },
    annotations: [{ id: 'r1', quote: 'hello', comment: 'change it', selector: { exact: 'hello' }, replies: [] }],
    brief: '', preserve: [], contract: { write_scope: 'target_only', locked_outside_scope: true, on_ambiguous_target: 'ask_or_stop', verification: ['v'] }
  };
  return { dir, src, root, task, hash: sha256File(src) };
}
function baseMsg(fix, runId = 'hgr_cxp0123456789') {
  return {
    run_id: runId, provider: 'codex_app_server', run_kind: 'plan',
    source: { logical_document_id: 'hgd_cxp', artifact_uri: pathToFileURL(fix.src).href, base_artifact_hash: fix.hash },
    session: { mode: 'new', thread_id: null }, task: fix.task
  };
}
function collect() { const events = []; return { events, emit: (e) => events.push(e) }; }
const OPTS = (schemaDir) => ({ schemaDir, runtime: { runtimePath: '/fake' } });

// fake client:runPlan 写 output/plan.json(或抛错);runCandidate 永不应被调(plan 走 runPlan)。
function makeFakeCodexClient({ onRun } = {}) {
  const calls = { runPlan: [], runCandidate: [] };
  return {
    calls,
    async runPlan({ workspaceCwd, prompt, timeoutMs }) {
      calls.runPlan.push({ workspaceCwd, prompt: String(prompt || '').slice(0, 40), timeoutMs });
      const r = onRun ? onRun({ cwd: workspaceCwd }) : null;
      if (r && r.fail) throw Object.assign(new Error(r.message || 'fail'), { code: r.code || 'CODEX_PLAN_FAILED' });
      return { threadId: 'thr_fake_plan', terminal: {} };
    },
    async runCandidate() { calls.runCandidate.push(true); throw new Error('runCandidate must not be called for plan'); },
    async close() {}
  };
}
function goodPlan() { return { schema_version: 1, kind: 'htmlgenius_change_plan', summary: '目标', plan_markdown: '1. 改 a', out_of_scope: [] }; }

test('codex plan 成功:runPlan 写 output/plan.json → plan-ready;runPlan 被调(非 runCandidate);不产 candidate/sibling', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), JSON.stringify(goodPlan())) });
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  const ready = events.find((e) => e.type === 'plan-ready');
  assert.ok(ready, 'emit plan-ready');
  assert.equal(ready.provider, 'codex_app_server');
  assert.match(ready.plan_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ready.plan.summary, '目标');
  // §6.6:plan 走 runPlan(永远 thread/start),不走 runCandidate
  assert.equal(client.calls.runPlan.length, 1, 'runPlan 被调一次');
  assert.equal(client.calls.runCandidate.length, 0, 'runCandidate 未被调');
  assert.match(client.calls.runPlan[0].prompt, /You are preparing an HTML Genius/i, 'runPlan 收到 plan prompt');
  // 绝不产 candidate
  assert.ok(!events.some((e) => e.type === 'candidate-ready'), 'plan run 不发 candidate-ready');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'report--htmlgenius-hgr_cxp0123456789.candidate.html')), '不创建 sibling candidate');
  // plan-ready 不含 thread_id(plan 不可续发)
  assert.equal(ready.thread_id, undefined, 'plan-ready 不含 thread_id');
  // manifest ready
  const mp = path.join(fix.root, 'plans', 'hgr_cxp0123456789', 'plan-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.provider, 'codex_app_server');
});

test('codex plan 未写 plan.json → PLAN_MISSING', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: () => {} });
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'PLAN_MISSING');
});

test('codex plan 写无效 JSON → PLAN_INVALID', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), 'not json') });
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'PLAN_INVALID');
});

test('codex plan 运行期 source 被改 → SOURCE_MUTATED_DURING_PLAN,不返回计划', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), JSON.stringify(goodPlan())); fs.appendFileSync(fix.src, '<!--mutated-->'); } });
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'SOURCE_MUTATED_DURING_PLAN');
  assert.ok(!events.some((e) => e.type === 'plan-ready'));
});

test('codex plan 运行期 task bundle 被改 → TASK_MUTATED_DURING_PLAN', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), JSON.stringify(goodPlan()));
    const tj = path.join(cwd, 'task-hgr_cxp0123456789.json');
    fs.chmodSync(tj, 0o600); fs.writeFileSync(tj, '{"mutated":true}'); fs.chmodSync(tj, 0o400);
  } });
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'TASK_MUTATED_DURING_PLAN');
});

test('codex plan runPlan 抛错 → CODEX_PLAN_FAILED(不产 candidate)', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: () => ({ fail: true, code: 'CODEX_PLAN_FAILED', message: 'turn err' }) });
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'CODEX_PLAN_FAILED');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'report--htmlgenius-hgr_cxp0123456789.candidate.html')));
});

test('codex plan restructure → INVALID_MODE', async () => {
  const fix = mkFix('restructure');
  const client = makeFakeCodexClient({});
  const { events, emit } = collect();
  await executeCodexPlanRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'INVALID_MODE');
});
