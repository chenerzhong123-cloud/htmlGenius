#!/usr/bin/env node
// bridge/test/fake-codex-app-server.mjs — 测试用,模拟 Codex App Server 的 stdio JSON-RPC。
// 记录所有收到的 method(+cwd/threadId)到 $CODEX_FAKE_LOG,供断言:forbidden 不发、handshake 先行、turn cwd=workspace。
// 用 env 模拟失败场景:CODEX_FAKE_HANDSHAKE_FAIL / RESUME_FAIL / NO_CANDIDATE / NO_COMPLETED。
import fs from 'node:fs';
import path from 'node:path';

const LOG = process.env.CODEX_FAKE_LOG;
function record(method, params) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify({ method, cwd: params && params.cwd, threadId: params && params.threadId, sandboxPolicy: params && params.sandboxPolicy }) + '\n'); } catch (e) {}
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(msg) {
  const m = msg && msg.method;
  const p = (msg && msg.params) || {};
  record(m, p);
  if (m === 'initialize') {
    if (process.env.CODEX_FAKE_HANDSHAKE_FAIL) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'forced handshake fail' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex/0.1', platformFamily: 'unix' } });
  } else if (m === 'initialized') {
    // notification,无响应
  } else if (m === 'thread/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { threadId: 'thr_fake_' + process.pid } });
  } else if (m === 'thread/resume') {
    if (process.env.CODEX_FAKE_RESUME_FAIL) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'thread not found' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: { threadId: p.threadId } });
  } else if (m === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn_fake' } });
    if (p.cwd && !process.env.CODEX_FAKE_NO_CANDIDATE) {
      try { fs.writeFileSync(path.join(p.cwd, 'candidate.html'), '<!doctype html>\n<html lang="en"><body><p>fake codex candidate</p></body></html>'); } catch (e) {}
    }
    if (!process.env.CODEX_FAKE_NO_COMPLETED) {
      setTimeout(() => send({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: 'turn_fake' } }), 5);
    }
  }
  // forbidden(thread/list, thread/read, thread/fork, turn/steer, thread/inject_items 等):
  // fake 记录但不响应——若 client 误发,测试能在 log 中看到。
}
