// bridge/test/provider-probe.test.mjs — v0.8.1 §7:provider probe 分类(注入 fake,不起子进程/不连真实 App)。
// 每 provider 独立失败:一个不污染另一个(§5.1)。状态分类:ready/auth_required/not_installed/not_found/untrusted/incompatible/error。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeProviders } from '../provider-probe.mjs';

function makeSchemaDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-sch-'));
  fs.writeFileSync(path.join(d, 'ClientRequest.json'), JSON.stringify({
    initialize: {}, 'thread/start': {}, 'thread/resume': {},
    'turn/start': { sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'never', cwd: 'x' }
  }));
  return d;
}
function makeBadSchemaDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-bad-'));
  fs.writeFileSync(path.join(d, 'ClientRequest.json'), JSON.stringify({ initialize: {} })); // 缺必需方法
  return d;
}
const find = (r, id) => (r.providers || []).find((p) => p.id === id);

test('两 provider 都 ready', async () => {
  const r = await probeProviders(['claude_code_cli', 'codex_app_server'], {
    claudeVersion: () => '1.2.3',
    claudeAuthCheck: async () => {},
    codexDiscover: () => ({ runtimePath: '/fake', version: '0.1', appVersion: '9.9' }),
    schemaDir: makeSchemaDir(),
    codexHandshake: async () => {}
  });
  assert.equal(find(r, 'claude_code_cli').status, 'ready');
  assert.equal(find(r, 'claude_code_cli').version, '1.2.3');
  assert.deepEqual(find(r, 'claude_code_cli').capabilities, ['candidate', 'plan']);
  assert.equal(find(r, 'codex_app_server').status, 'ready');
  assert.equal(find(r, 'codex_app_server').version, '0.1');
});

test('claude auth_required + codex ready:互不污染(§5.1)', async () => {
  const r = await probeProviders(undefined, {
    claudeVersion: () => '1.2.3',
    claudeAuthCheck: async () => { const e = new Error('x'); e.code = 'CLAUDE_NOT_LOGGED_IN'; throw e; },
    codexDiscover: () => ({ runtimePath: '/fake', version: '0.1' }),
    schemaDir: makeSchemaDir(),
    codexHandshake: async () => {}
  });
  assert.equal(find(r, 'claude_code_cli').status, 'auth_required', 'claude 未登录');
  assert.equal(find(r, 'codex_app_server').status, 'ready', 'codex 未被 claude 失败污染');
});

test('claude not_installed(version 为空)+ codex not_found', async () => {
  const r = await probeProviders(['claude_code_cli', 'codex_app_server'], {
    claudeVersion: () => null,
    codexDiscover: () => { const e = new Error('not found'); e.code = 'CODEX_APP_NOT_FOUND'; throw e; }
  });
  assert.equal(find(r, 'claude_code_cli').status, 'not_installed');
  assert.equal(find(r, 'codex_app_server').status, 'not_found');
});

test('codex untrusted / incompatible 分类', async () => {
  const r1 = await probeProviders(['codex_app_server'], {
    codexDiscover: () => { const e = new Error('untrusted'); e.code = 'CODEX_APP_UNTRUSTED'; throw e; }
  });
  assert.equal(find(r1, 'codex_app_server').status, 'untrusted');
  const r2 = await probeProviders(['codex_app_server'], {
    codexDiscover: () => ({ runtimePath: '/fake', version: '0.1' }),
    schemaDir: makeBadSchemaDir()
  });
  assert.equal(find(r2, 'codex_app_server').status, 'incompatible', 'schema 不兼容');
});

test('codex handshake auth_required 分类', async () => {
  const r = await probeProviders(['codex_app_server'], {
    codexDiscover: () => ({ runtimePath: '/fake', version: '0.1' }),
    schemaDir: makeSchemaDir(),
    codexHandshake: async () => { const e = new Error('auth'); e.code = 'CODEX_AUTH_REQUIRED'; throw e; }
  });
  assert.equal(find(r, 'codex_app_server').status, 'auth_required');
});

test('只探一个 provider:只返回请求的', async () => {
  const r = await probeProviders(['claude_code_cli'], { claudeVersion: () => '1.0', claudeAuthCheck: async () => {} });
  assert.equal(r.providers.length, 1);
  assert.equal(r.providers[0].id, 'claude_code_cli');
});

test('provider 抛未分类异常 → 归一 error(不崩、不污染另一 provider)', async () => {
  const r = await probeProviders(['claude_code_cli', 'codex_app_server'], {
    claudeVersion: () => { throw new Error('boom'); },
    codexDiscover: () => ({ runtimePath: '/fake', version: '0.1' }),
    schemaDir: makeSchemaDir(),
    codexHandshake: async () => {}
  });
  assert.equal(find(r, 'claude_code_cli').status, 'error');
  assert.equal(find(r, 'codex_app_server').status, 'ready');
});
