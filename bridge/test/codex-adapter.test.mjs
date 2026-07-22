// bridge/test/codex-adapter.test.mjs — spec §10 自动测试(adapter 编排层)。
// 注入 fake CodexAppServerClient(不 spawn 真实 codex)+ 预制 schemaDir,验证:
// candidate-ready(provider+thread_id)、source 运行期变更不发 ready、candidate 缺失/无效、turn 失败、restructure 拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeCodexCandidateRun } from '../codex-adapter.mjs';
import { sha256File } from '../candidate-workspace.mjs';

// 预制 schemaDir:含 verifySchema 要求的 token(initialize/thread·turn 方法 + workspaceWrite + approvalPolicy + cwd)
function makeSchemaDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sch-'));
  fs.writeFileSync(path.join(d, 'ClientRequest.json'), JSON.stringify({
    initialize: {}, 'thread/start': {}, 'thread/resume': {},
    'turn/start': { sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'never', cwd: 'x' }
  }));
  return d;
}

function mkFix(mode = 'precise_patch') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-codex-'));
  const src = path.join(dir, 'report.html');
  fs.writeFileSync(src, '<!doctype html><html><body>hello world</body></html>');
  const root = path.join(dir, '.htmlgenius-bridge', 'codex', 'hgd_cx');
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

function baseMsg(fix, session = { mode: 'new', thread_id: null }, runId = 'hgr_cx0123456789') {
  return {
    run_id: runId, provider: 'codex_app_server',
    source: { logical_document_id: 'hgd_cx', artifact_uri: pathToFileURL(fix.src).href, base_artifact_hash: fix.hash },
    session, task: fix.task
  };
}

// fake client:对象级(模拟 CodexAppServerClient.runCandidate/close)。onRun 写 candidate 或抛错。
function makeFakeCodexClient({ onRun }) {
  return {
    runCandidate: async ({ workspaceCwd }) => {
      const r = onRun ? onRun({ cwd: workspaceCwd }) : null;
      if (r && r.fail) throw Object.assign(new Error(r.message || 'fail'), { code: r.code || 'CODEX_TURN_FAILED' });
      return { threadId: 'thr_fake_1', terminal: {} };
    },
    close: async () => {}
  };
}
function collect() { const events = []; return { events, emit: (e) => events.push(e) }; }
const OPTS = (schemaDir) => ({ schemaDir, runtime: { runtimePath: '/fake' } });

test('§10.2: codex new 成功 → candidate-ready(provider+thread_id)+ sibling + manifest ready', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'candidate.html'), '<!doctype html><html><body>CODEX EDIT</body></html>') });
  const { events, emit } = collect();
  await executeCodexCandidateRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  const ready = events.find((e) => e.type === 'candidate-ready');
  assert.ok(ready, 'emit candidate-ready');
  assert.equal(ready.provider, 'codex_app_server');
  assert.equal(ready.thread_id, 'thr_fake_1');
  assert.equal(ready.source_sha256_before, fix.hash);
  assert.equal(ready.version_label, '1.1', 'candidate-ready 带文档级版本号 V1.1');
  const sib = path.join(fix.dir, 'reportV1.1.html');
  assert.ok(fs.existsSync(sib), 'sibling candidate 创建');
  const mp = path.join(fix.root, 'runs', 'hgr_cx0123456789', 'candidate-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.provider, 'codex_app_server');
  assert.equal(manifest.session && manifest.session.id, 'thr_fake_1');
});

test('§10.8: source 运行期被改 → 不发 candidate-ready,发 SOURCE_MUTATED', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'candidate.html'), '<!doctype html><html></html>'); fs.appendFileSync(fix.src, '<!--mutated-->'); } });
  const { events, emit } = collect();
  await executeCodexCandidateRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.ok(!events.some((e) => e.type === 'candidate-ready'));
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'SOURCE_MUTATED_DURING_CANDIDATE');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'report--htmlgenius-hgr_cx0123456789.candidate.html')), 'mutated 不创建 sibling');
});

test('§10.8: candidate 缺失 → CANDIDATE_MISSING,无 sibling', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: () => {} });
  const { events, emit } = collect();
  await executeCodexCandidateRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'CANDIDATE_MISSING');
});

test('§10.8: candidate 写 Markdown → CANDIDATE_INVALID_HTML', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'candidate.html'), '# not html') });
  const { events, emit } = collect();
  await executeCodexCandidateRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'CANDIDATE_INVALID_HTML');
});

test('turn 失败 → CODEX_TURN_FAILED,无 sibling', async () => {
  const fix = mkFix();
  const client = makeFakeCodexClient({ onRun: () => ({ fail: true, code: 'CODEX_TURN_FAILED', message: 'turn error' }) });
  const { events, emit } = collect();
  await executeCodexCandidateRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'CODEX_TURN_FAILED');
  assert.ok(!fs.existsSync(path.join(fix.dir, 'report--htmlgenius-hgr_cx0123456789.candidate.html')));
});

test('restructure → INVALID_MODE(codex candidate 不允许)', async () => {
  const fix = mkFix('restructure');
  const client = makeFakeCodexClient({});
  const { events, emit } = collect();
  await executeCodexCandidateRun(baseMsg(fix), { emit, client, ...OPTS(makeSchemaDir()) });
  assert.equal(events.find((e) => e.type === 'bridge_failed').code, 'INVALID_MODE');
});
