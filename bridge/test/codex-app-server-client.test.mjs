// bridge/test/codex-app-server-client.test.mjs — spec §10 自动测试(client 层)。
// 用 fake-codex-app-server 验证:handshake 先行、new 只 thread/start、resume 失败不退化、
// forbidden 永不发、turn cwd=workspace、timeout、handshake 失败不漏 thread/turn。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient, CODEX_SESSION_UNAVAILABLE, CODEX_TIMED_OUT } from '../codex-app-server-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(__dirname, 'fake-codex-app-server.mjs');

function setup() {
  fs.chmodSync(FAKE, 0o755);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ws-'));
  const logFile = path.join(ws, 'methods.log');
  return { ws, logFile };
}
function readLog(logFile) {
  try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { return []; }
}

test('§10.1/10.4: new — handshake 先行;forbidden 永不发', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile } });
  const r = await c.runCandidate({ sessionMode: 'new', workspaceCwd: ws, prompt: 'do task', timeoutMs: 6000 });
  await c.close();
  assert.ok(r.threadId, '应返回 threadId');
  const methods = readLog(logFile).map((x) => x.method);
  assert.ok(methods.indexOf('initialize') < methods.indexOf('thread/start'), 'initialize 必须在 thread/start 前');
  assert.ok(methods.indexOf('thread/start') < methods.indexOf('turn/start'), 'thread/start 必须在 turn/start 前');
  assert.ok(methods.includes('turn/start'));
  for (const f of ['thread/list', 'thread/read', 'thread/fork', 'turn/steer', 'thread/inject_items']) {
    assert.ok(!methods.includes(f), '不应发 forbidden: ' + f);
  }
});

test('§10.5: turn/start cwd = workspace(不含真实 source path)', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile } });
  await c.runCandidate({ sessionMode: 'new', workspaceCwd: ws, prompt: 'x', timeoutMs: 6000 });
  await c.close();
  const turn = readLog(logFile).find((x) => x.method === 'turn/start');
  assert.equal(turn && turn.cwd, ws, 'turn/start cwd 必须是 candidate workspace');
});

test('§10.3 + §6.2: continue resume 失败 → CODEX_SESSION_UNAVAILABLE,不退化 thread/start', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile, CODEX_FAKE_RESUME_FAIL: '1' } });
  await assert.rejects(
    () => c.runCandidate({ sessionMode: 'continue', storedThreadId: 'thr_x', workspaceCwd: ws, prompt: 'x', timeoutMs: 6000 }),
    (e) => e.code === CODEX_SESSION_UNAVAILABLE
  );
  await c.close();
  const methods = readLog(logFile).map((x) => x.method);
  assert.ok(methods.includes('thread/resume'), '应发 thread/resume');
  assert.ok(!methods.includes('thread/start'), 'resume 失败不得退化到 thread/start');
});

test('§10.7: turn 无 terminal → CODEX_TIMED_OUT,清理 run', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile, CODEX_FAKE_NO_COMPLETED: '1' } });
  await assert.rejects(
    () => c.runCandidate({ sessionMode: 'new', workspaceCwd: ws, prompt: 'x', timeoutMs: 1500 }),
    (e) => e.code === CODEX_TIMED_OUT
  );
  await c.close();
});

test('§10.1: handshake 失败 → 不发 thread/turn', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile, CODEX_FAKE_HANDSHAKE_FAIL: '1' } });
  await assert.rejects(
    () => c.runCandidate({ sessionMode: 'new', workspaceCwd: ws, prompt: 'x', timeoutMs: 6000 })
  );
  await c.close();
  const methods = readLog(logFile).map((x) => x.method);
  assert.ok(!methods.includes('thread/start') && !methods.includes('turn/start'), 'handshake 失败不应发 thread/turn');
});

test('continue 成功:thread/resume 用 storedThreadId', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile } });
  const r = await c.runCandidate({ sessionMode: 'continue', storedThreadId: 'thr_stored_123', workspaceCwd: ws, prompt: 'x', timeoutMs: 6000 });
  await c.close();
  assert.equal(r.threadId, 'thr_stored_123');
  const resume = readLog(logFile).find((x) => x.method === 'thread/resume');
  assert.equal(resume && resume.threadId, 'thr_stored_123');
});

// —— v0.8.1 §6.6:runPlan 永远 thread/start(绝不 resume);sandbox writableRoots 仅 cwd、networkAccess false ——
test('§6.6: runPlan 永远 thread/start,绝不 thread/resume', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile } });
  const r = await c.runPlan({ workspaceCwd: ws, prompt: 'plan task', timeoutMs: 6000 });
  await c.close();
  assert.ok(r.threadId, 'runPlan 返回 threadId');
  const methods = readLog(logFile).map((x) => x.method);
  assert.ok(methods.includes('thread/start'), 'runPlan 发 thread/start');
  assert.ok(!methods.includes('thread/resume'), 'runPlan 绝不发 thread/resume');
});

test('§6.6: runPlan turn/start sandboxPolicy writableRoots=[cwd] 且 networkAccess=false', async () => {
  const { ws, logFile } = setup();
  const c = new CodexAppServerClient(FAKE, { env: { CODEX_FAKE_LOG: logFile } });
  await c.runPlan({ workspaceCwd: ws, prompt: 'plan task', timeoutMs: 6000 });
  await c.close();
  const turn = readLog(logFile).find((x) => x.method === 'turn/start');
  assert.ok(turn && turn.sandboxPolicy, 'turn/start 含 sandboxPolicy');
  assert.equal(turn.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [ws], 'writableRoots 仅限 plan 目录(cwd)');
  assert.equal(turn.sandboxPolicy.networkAccess, false, '网络关闭');
});
