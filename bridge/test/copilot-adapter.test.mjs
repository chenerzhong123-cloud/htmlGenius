// bridge/test/copilot-adapter.test.mjs — v0.8.2 §9 Copilot Plan/Candidate adapter 编排测试。
// 注入 fake SDK(makeFakeSdk)+ selectRuntime 替身;不 spawn 真实 runtime、不走网络。
// 覆盖:成功闭环(provider_runtime/版本号/manifest/无 thread_id)、source 运行期变更、candidate 缺失/越权、
// approved-plan 只读注入、required_provider_runtime 传递、session.mode 门禁、plan 不产 candidate、plan 失败无 plan-ready。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeFakeSdk } from './fake-copilot-sdk.mjs';
import { executeCopilotCandidateRun, executeCopilotPlanRun, copilotWorkspacePathFor } from '../copilot-adapter.mjs';
import { sha256File } from '../candidate-workspace.mjs';
import { COPILOT_RUNTIMES, COPILOT_ERRORS } from '../copilot-runtime.mjs';

function mkFix(mode = 'precise_patch') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-copilot-ad-'));
  const src = path.join(dir, 'report.html');
  fs.writeFileSync(src, '<!doctype html><html><body>hello world</body></html>');
  const task = {
    schema_version: 1, kind: 'htmlgenius_change_contract', mode,
    artifact: { title: 'T', url: pathToFileURL(src).href, is_local: true },
    source: { root_annotation_ids: ['r1'], root_annotation_count: 1 },
    annotations: [{ id: 'r1', quote: 'hello', comment: 'change it', selector: { exact: 'hello' }, replies: [] }],
    brief: '', preserve: [], contract: { write_scope: 'target_only', locked_outside_scope: true, on_ambiguous_target: 'ask_or_stop', verification: ['v'] }
  };
  return { dir, src, task, hash: sha256File(src) };
}
function baseMsg(fix, extra = {}, runId = 'hgr_cp0123456789') {
  return {
    run_id: runId, provider: 'github_copilot',
    source: { logical_document_id: 'hgd_cp', artifact_uri: pathToFileURL(fix.src).href, base_artifact_hash: fix.hash },
    session: { mode: 'new' }, task: fix.task, ...extra
  };
}
function goodPlan() { return { schema_version: 1, kind: 'htmlgenius_change_plan', summary: '目标', plan_markdown: '1. 改 a', out_of_scope: [] }; }
function collect() { const events = []; return { events, emit: (e) => events.push(e) }; }
// selectRuntime 替身:返回给定 sdk + runtime;记录入参(验证 required_provider_runtime 传递)。
// local_cli 必须带 cliPath(buildCopilotClientOptions 会校验;此处为假路径,fake 不会真 spawn)。
function makeSelector(sdk, runtime = COPILOT_RUNTIMES.BUNDLED_SDK_CLI) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return { sdk, runtime, cliPath: runtime === COPILOT_RUNTIMES.LOCAL_CLI ? '/fake/bin/copilot' : null, version: '1.0.7' };
  };
  fn.calls = calls;
  return fn;
}
function failSelector(code, message) {
  return async () => { const e = new Error(message); e.code = code; throw e; };
}
const VALID_HTML = '<!doctype html><html><body>COPILOT EDIT</body></html>';

// ———————————————————————— Candidate ————————————————————————

test('copilot candidate 成功 → candidate-ready(provider=github_copilot + provider_runtime + V1.1),sibling+manifest,无 thread_id/session 持久化', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'candidate.html'), VALID_HTML) } });
  const selector = makeSelector(sdk);
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit, selectRuntime: selector });
  const ready = events.find((e) => e.type === 'candidate-ready');
  assert.ok(ready, 'emit candidate-ready');
  assert.equal(ready.provider, 'github_copilot');
  assert.equal(ready.provider_runtime, COPILOT_RUNTIMES.BUNDLED_SDK_CLI);
  assert.equal(ready.version_label, '1.1');
  assert.equal(ready.source_sha256_before, fix.hash);
  assert.equal(ready.thread_id, undefined, 'Copilot 不返回 thread_id');
  assert.match(ready.candidate_uri, /reportV1\.1\.html$/);
  const sib = path.join(fix.dir, 'reportV1.1.html');
  assert.ok(fs.existsSync(sib), 'sibling candidate 已创建');
  // manifest:provider=github_copilot,ready,不存 session id
  const ws = copilotWorkspacePathFor({ sourcePath: fix.src, logicalDocumentId: 'hgd_cp' });
  const manifest = JSON.parse(fs.readFileSync(path.join(ws, 'runs', 'hgr_cp0123456789', 'candidate-manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.provider, 'github_copilot');
  assert.ok(!manifest.session || !manifest.session.id, 'Copilot session 不持久化');
  // createSession 配置:empty 模式 allowlist + hooks 接线
  const cs = sdk.__calls.find((c) => c.name === 'client.createSession');
  assert.ok(cs.arg.config.availableTools.includes('builtin:write'));
  assert.ok(cs.arg.config.excludedTools.includes('builtin:bash'));
  assert.equal(typeof cs.arg.config.hooks.onPreToolUse, 'function');
});

test('copilot candidate:approved_plan → 只读 approved-plan.md + prompt 含计划前文', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'candidate.html'), VALID_HTML) } });
  const { events, emit } = collect();
  await executeCopilotCandidateRun(
    baseMsg(fix, { approved_plan: { plan_id: 'hgp_x', plan_sha256: 'sha256:' + 'a'.repeat(64), edited_plan_markdown: '## 计划正文\n- step' } }),
    { emit, selectRuntime: makeSelector(sdk) }
  );
  assert.ok(events.some((e) => e.type === 'candidate-ready'));
  const ws = copilotWorkspacePathFor({ sourcePath: fix.src, logicalDocumentId: 'hgd_cp' });
  const ap = path.join(ws, 'runs', 'hgr_cp0123456789', 'approved-plan.md');
  assert.ok(fs.existsSync(ap), 'approved-plan.md 已写入 run workspace');
  const st = fs.statSync(ap);
  assert.equal(st.mode & 0o222, 0, 'approved-plan.md 只读(无写位)');
  const sw = sdk.__calls.find((c) => c.name === 'session.sendAndWait');
  assert.ok(sw.arg.prompt.includes('计划') || sw.arg.prompt.includes('plan') || sw.arg.prompt.includes('step'), 'prompt 携带计划');
});

test('copilot candidate:required_provider_runtime 原样传给 runtime 选择器(§6.3.6)', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'candidate.html'), VALID_HTML) } });
  const selector = makeSelector(sdk, COPILOT_RUNTIMES.LOCAL_CLI);
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix, { required_provider_runtime: COPILOT_RUNTIMES.LOCAL_CLI }), { emit, selectRuntime: selector });
  assert.ok(events.some((e) => e.type === 'candidate-ready'));
  assert.equal(selector.calls[0].requiredRuntime, COPILOT_RUNTIMES.LOCAL_CLI);
  const ready = events.find((e) => e.type === 'candidate-ready');
  assert.equal(ready.provider_runtime, COPILOT_RUNTIMES.LOCAL_CLI);
});

test('copilot candidate:source 运行期被改 → SOURCE_MUTATED_DURING_CANDIDATE,无 sibling', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'candidate.html'), VALID_HTML); fs.appendFileSync(fix.src, '<!--mut-->'); } } });
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.ok(!events.some((e) => e.type === 'candidate-ready'));
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'SOURCE_MUTATED_DURING_CANDIDATE');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'reportV1.1.html')));
});

test('copilot candidate:candidate 缺失 → CANDIDATE_MISSING;无输出且期间有越权工具被拒 → COPILOT_PERMISSION_DENIED', async () => {
  const fix = mkFix();
  // a) 单纯没产出
  const sdkA = makeFakeSdk({ session: { writer: () => {} } });
  const ca = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit: ca.emit, selectRuntime: makeSelector(sdkA) });
  assert.equal(ca.events.find((e) => e.type === 'bridge_failed').code, 'CANDIDATE_MISSING');

  // b) 尝试 bash(被 pre-tool policy deny)且无产出 → 归因 PERMISSION_DENIED
  const fix2 = mkFix();
  const sdkB = makeFakeSdk({
    session: {
      writer: ({ config }) => {
        const r = config.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'rm -rf /' } });
        assert.equal(r.permissionDecision, 'deny', 'bash 必须被 hook 拒绝');
      }
    }
  });
  const cb = collect();
  await executeCopilotCandidateRun(baseMsg(fix2), { emit: cb.emit, selectRuntime: makeSelector(sdkB) });
  assert.equal(cb.events.find((e) => e.type === 'bridge_failed').code, COPILOT_ERRORS.PERMISSION_DENIED);
  // UI 可见事件:denied 流帧
  assert.ok(cb.events.some((e) => e.type === 'bridge_stream' && /denied: bash/.test(e.text || '')));
});

test('copilot candidate:candidate.html 是 symlink → CANDIDATE_SYMLINK,不发布', async () => {
  const fix = mkFix();
  const outside = path.join(fix.dir, 'outside.html');
  fs.writeFileSync(outside, VALID_HTML);
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => fs.symlinkSync(outside, path.join(cwd, 'candidate.html')) } });
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'CANDIDATE_SYMLINK');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'reportV1.1.html')));
});

test('copilot candidate:session.mode=continue → SESSION_MODE_NOT_ALLOWED(§5.3 始终新 session)', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({});
  const { events, emit } = collect();
  const msg = baseMsg(fix); msg.session = { mode: 'continue', thread_id: 'x' };
  await executeCopilotCandidateRun(msg, { emit, selectRuntime: makeSelector(sdk) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'SESSION_MODE_NOT_ALLOWED');
  assert.ok(!sdk.__calls.some((c) => c.name === 'client.createSession'), '门禁在 session 创建之前');
});

test('copilot candidate:restructure → INVALID_MODE', async () => {
  const fix = mkFix('restructure');
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit, selectRuntime: makeSelector(makeFakeSdk({})) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'INVALID_MODE');
});

test('copilot candidate:runtime 选择失败(未登录)→ COPILOT_AUTH_REQUIRED,不建 session', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({});
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit, selectRuntime: failSelector(COPILOT_ERRORS.AUTH_REQUIRED, 'not signed in') });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, COPILOT_ERRORS.AUTH_REQUIRED);
  assert.ok(!sdk.__calls.some((c) => c.name === 'client.createSession'));
});

test('copilot candidate:写越界路径被 hook 拒(write 只认 candidate.html)', async () => {
  const fix = mkFix();
  let evilDenied = null;
  const sdk = makeFakeSdk({
    session: {
      writer: ({ cwd, config }) => {
        evilDenied = config.hooks.onPreToolUse({ toolName: 'write', toolArgs: { path: '../evil.html', content: 'x' } });
        fs.writeFileSync(path.join(cwd, 'candidate.html'), VALID_HTML);
      }
    }
  });
  const { events, emit } = collect();
  await executeCopilotCandidateRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.equal(evilDenied.permissionDecision, 'deny');
  assert.ok(events.some((e) => e.type === 'candidate-ready'), '合法输出仍成功(拒绝的是越权写)');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'evil.html')));
});

// ———————————————————————— Plan ————————————————————————

test('copilot plan 成功 → plan-ready(provider_runtime + plan_sha256),只产 output/plan.json,不产 candidate/sibling', async () => {
  const fix = mkFix();
  const planJson = JSON.stringify(goodPlan());
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), planJson) } });
  const { events, emit } = collect();
  await executeCopilotPlanRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  const ready = events.find((e) => e.type === 'plan-ready');
  assert.ok(ready, 'emit plan-ready');
  assert.equal(ready.provider, 'github_copilot');
  assert.equal(ready.provider_runtime, COPILOT_RUNTIMES.BUNDLED_SDK_CLI);
  assert.match(ready.plan_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ready.plan.plan_markdown, '1. 改 a');
  assert.equal(ready.thread_id, undefined);
  // plan workspace 内只有 output/plan.json,无 candidate.html
  const ws = copilotWorkspacePathFor({ sourcePath: fix.src, logicalDocumentId: 'hgd_cp' });
  const plansDir = path.join(ws, 'plans', 'hgr_cp0123456789');
  assert.ok(fs.existsSync(path.join(plansDir, 'output', 'plan.json')));
  assert.ok(!fs.existsSync(path.join(plansDir, 'candidate.html')), 'plan run 不得产 candidate.html');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'reportV1.1.html')), 'plan run 不得发布 sibling');
  // plan manifest ready
  const manifest = JSON.parse(fs.readFileSync(path.join(plansDir, 'plan-manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.provider, 'github_copilot');
});

test('copilot plan:坏 JSON → 失败且无 plan-ready(失败 manifest 不含计划正文)', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), '{ not json') } });
  const { events, emit } = collect();
  await executeCopilotPlanRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.ok(!events.some((e) => e.type === 'plan-ready'));
  const failedEv = events.find((e) => e.type === 'bridge_failed');
  assert.ok(failedEv);
  const ws = copilotWorkspacePathFor({ sourcePath: fix.src, logicalDocumentId: 'hgd_cp' });
  const mp = path.join(ws, 'plans', 'hgr_cp0123456789', 'plan-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.plan, null, '失败 manifest 不含计划正文');
});

test('copilot plan:越权写被拒后仍产出合法 plan → 成功(拒绝≠失败;Agent 已纠正)', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({
    session: {
      writer: ({ cwd, config }) => {
        const r = config.hooks.onPreToolUse({ toolName: 'write', toolArgs: { path: 'not-plan.txt' } });
        assert.equal(r.permissionDecision, 'deny');
        fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), JSON.stringify(goodPlan()));
      }
    }
  });
  const { events, emit } = collect();
  await executeCopilotPlanRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.ok(events.some((e) => e.type === 'plan-ready'), '有合法输出即成功');
  assert.ok(!fs.existsSync(path.join(copilotWorkspacePathFor({ sourcePath: fix.src, logicalDocumentId: 'hgd_cp' }), 'plans', 'hgr_cp0123456789', 'not-plan.txt')));
});

test('copilot plan:无输出且全程被拒 → COPILOT_PERMISSION_DENIED', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({
    session: {
      writer: ({ config }) => {
        config.hooks.onPreToolUse({ toolName: 'task', toolArgs: {} });       // subagent 拒绝
        config.hooks.onPreToolUse({ toolName: 'web_fetch', toolArgs: {} }); // 网络拒绝
      }
    }
  });
  const { events, emit } = collect();
  await executeCopilotPlanRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, COPILOT_ERRORS.PERMISSION_DENIED);
});

test('copilot plan:source 运行期被改 → SOURCE_MUTATED_DURING_PLAN', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({ session: { writer: ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'output', 'plan.json'), JSON.stringify(goodPlan())); fs.appendFileSync(fix.src, '<!--m-->'); } } });
  const { events, emit } = collect();
  await executeCopilotPlanRun(baseMsg(fix), { emit, selectRuntime: makeSelector(sdk) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'SOURCE_MUTATED_DURING_PLAN');
});

test('copilot plan:runtime 选择失败 → 失败码透传,不建 session', async () => {
  const fix = mkFix();
  const sdk = makeFakeSdk({});
  const { events, emit } = collect();
  await executeCopilotPlanRun(baseMsg(fix), { emit, selectRuntime: failSelector(COPILOT_ERRORS.RUNTIME_CHANGED, 'runtime gone') });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, COPILOT_ERRORS.RUNTIME_CHANGED);
  assert.ok(!sdk.__calls.some((c) => c.name === 'client.createSession'));
});
