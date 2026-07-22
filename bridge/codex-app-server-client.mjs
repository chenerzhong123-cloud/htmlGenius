// bridge/codex-app-server-client.mjs — Codex App Server adapter 低层(stdio JSON-RPC)+ App runtime 发现/信任。
// spec v0.8 §2(协议/兼容门槛)、§2.2(App 发现与信任)、§6.1(唯一允许 RPC 序列)、§6.3(turn 配置)、§9(失败码)。
// 仅 macOS。只暴露 discoverAppRuntime / verifySchema / CodexAppServerClient.runCandidate。
// 不发 forbidden method(thread/list, thread/read, thread/fork, turn/steer, thread/inject_items 等);
// RPC 序列由 runCandidate 硬编码,没有通用 sendMethod 入口(spec §6.1)。
// framing = newline-delimited JSON-RPC(Preflight handshake 实测,非 LSP Content-Length)。
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// —— 失败码(spec §9)——
export const CODEX_APP_NOT_FOUND = 'CODEX_APP_NOT_FOUND';
export const CODEX_APP_UNTRUSTED = 'CODEX_APP_UNTRUSTED';
export const CODEX_INCOMPATIBLE = 'CODEX_INCOMPATIBLE';
export const CODEX_AUTH_REQUIRED = 'CODEX_AUTH_REQUIRED';
export const CODEX_SESSION_UNAVAILABLE = 'CODEX_SESSION_UNAVAILABLE';
export const CODEX_TURN_FAILED = 'CODEX_TURN_FAILED';
export const CODEX_TIMED_OUT = 'CODEX_TIMED_OUT';

const CODEX_BUNDLE_ID = 'com.openai.codex';
const REQUIRED_TEAM_ID = '2DC432GLL2';
const CLIENT_INFO = { name: 'htmlgenius-bridge', version: '0.8.0' };
const HANDSHAKE_TIMEOUT_MS = 20_000;
export const DEFAULT_TURN_TIMEOUT_MS = 180_000; // spec §6.3.6(可配置)
const REQUIRED_METHODS = ['initialize', 'thread/start', 'thread/resume', 'turn/start'];

function fail(code, message, extra) {
  const err = Object.assign(new Error(message || code), { code }, extra || {});
  throw err;
}
function sha256Hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
// 提取 thread/start|resume 返回的 thread id。真实 Codex App Server 0.145+:result.thread.id(嵌套);
// 兼容旧/其他实现的 result.threadId / result.id / result.thread_id。
function extractThreadId(r) {
  if (!r) return null;
  if (r.thread) {
    if (r.thread.id) return r.thread.id;
    if (r.thread.threadId) return r.thread.threadId;
    if (r.thread.thread_id) return r.thread.thread_id;
  }
  return r.threadId || r.id || r.thread_id || null;
}
function streamBaseName(p) { const s = String(p || ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }
// 把 Codex 中途 notification 转成 UI 可展示的进度事件(安全边界:不暴露完整命令/绝对路径/stderr/思维链正文)。
// - agentMessage/delta → 逐字 token 流(kind=delta)
// - fileChange → "写入 plan.json" 等(只 basename + 操作)
// - commandExecution → 仅"执行命令"(不含命令体,可能含路径/敏感参数)
// - reasoning → "思考中"(不含 summary/content)
// - tokenUsage → token 总量
function codexNotificationToStream(msg) {
  const m = msg && (msg.method || msg.notification);
  const p = (msg && msg.params) || {};
  if (m === 'item/agentMessage/delta') return { kind: 'delta', text: String(p.delta || '') };
  if (m === 'item/started' || m === 'item/completed') {
    const it = p.item || {}; const starting = (m === 'item/started');
    if (it.type === 'fileChange' && Array.isArray(it.changes)) {
      const ch = it.changes[0] || {}; const op = (ch.kind && ch.kind.type) || 'change';
      return { kind: 'file', text: op + ' ' + streamBaseName(ch.path), starting };
    }
    if (it.type === 'commandExecution') return { kind: 'command', starting };
    if (it.type === 'reasoning') return { kind: 'reasoning', starting };
    if (it.type === 'agentMessage' && !starting) return { kind: 'message', text: String(it.text || '').slice(0, 400) };
    return null;
  }
  if (m === 'thread/tokenUsage/updated') {
    const tot = p.tokenUsage && p.tokenUsage.total && p.tokenUsage.total.totalTokens;
    return (tot != null) ? { kind: 'tokens', text: String(tot) } : null;
  }
  return null;
}

// 最小 env 白名单:runtime 需要 HOME(~/.codex 登录态)、PATH、locale。extension 内容永不进 env。
function sanitizedEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'];
  const env = {};
  for (const k of keep) { if (process.env[k] != null) env[k] = process.env[k]; }
  return env;
}

// —— App runtime 发现与信任(spec §2.2,同步纯 Node)——
// 首发查 /Applications/ChatGPT.app + ~/Applications/ChatGPT.app;mdfind 按 bundle id 兜底;**不搜 PATH**(§2.1)。
export function discoverAppRuntime() {
  const candidates = [
    '/Applications/ChatGPT.app',
    path.join(os.homedir(), 'Applications', 'ChatGPT.app'),
  ];
  try {
    const out = execFileSync('mdfind', ['kMDItemCFBundleIdentifier == "' + CODEX_BUNDLE_ID + '"'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const p of String(out).split('\n').map(s => s.trim()).filter(Boolean)) {
      if (!candidates.includes(p)) candidates.push(p);
    }
  } catch (e) { /* mdfind 不可用则只用默认候选,非致命 */ }

  let seenApp = false;
  for (const appPath of candidates) {
    if (!appPath || !fs.existsSync(appPath)) continue;
    seenApp = true;
    // 1. CFBundleIdentifier 精确匹配(spec §2.2.1)
    let bid = '';
    try {
      bid = execFileSync('defaults', ['read', path.join(appPath, 'Contents/Info'), 'CFBundleIdentifier'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) { continue; }
    if (bid !== CODEX_BUNDLE_ID) continue;

    // 2. runtime 是 regular executable(spec §2.2.2)
    const runtimePath = path.join(appPath, 'Contents/Resources/codex');
    try {
      const st = fs.statSync(runtimePath);
      if (!st.isFile()) fail(CODEX_APP_UNTRUSTED, 'runtime 不是 regular file: ' + runtimePath);
      if (!(st.mode & 0o111)) fail(CODEX_APP_UNTRUSTED, 'runtime 不可执行: ' + runtimePath);
    } catch (e) { if (e && e.code === CODEX_APP_UNTRUSTED) throw e; continue; }

    // 3. codesign TeamIdentifier(spec §2.2.3;codesign -dv 输出到 stderr)
    const cs = spawnSync('codesign', ['-dv', '--verbose=2', runtimePath], { encoding: 'utf8' });
    if (cs.status !== 0) fail(CODEX_APP_UNTRUSTED, 'codesign 校验失败: ' + runtimePath);
    const csOut = String(cs.stderr || '') + String(cs.stdout || '');
    const tm = csOut.match(/TeamIdentifier=(\S+)/);
    const teamId = tm ? tm[1] : '';
    if (teamId !== REQUIRED_TEAM_ID) fail(CODEX_APP_UNTRUSTED, 'TeamIdentifier 不匹配: ' + (teamId || '(none)'));

    // 4. runtime --version(spec §2.2.4)
    let version = '';
    try { version = execFileSync(runtimePath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch (e) { fail(CODEX_APP_UNTRUSTED, 'runtime --version 失败'); }

    let appVersion = '';
    try {
      appVersion = execFileSync('defaults', ['read', path.join(appPath, 'Contents/Info'), 'CFBundleShortVersionString'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {}

    // 不把路径/版本/teamId 展示给 UI(spec §2.2.5);只作为 Host 诊断 metadata 返回。
    return { appPath, runtimePath, version, appVersion, teamId };
  }
  fail(CODEX_APP_NOT_FOUND, seenApp ? '找到 App 但 bundle id/codesign/version 不符合' : '未找到 Codex Mac App (com.openai.codex)');
}

// —— schema 兼容检查(spec §2 启动前检查)—— 调用方先 spawn generate-json-schema --out schemaDir。
export function verifySchema({ schemaDir }) {
  const cr = path.join(schemaDir, 'ClientRequest.json');
  if (!fs.existsSync(cr)) fail(CODEX_INCOMPATIBLE, 'generate-json-schema 未产出 ClientRequest.json');
  let text;
  try { text = fs.readFileSync(cr, 'utf8'); } catch (e) { fail(CODEX_INCOMPATIBLE, '无法读取 ClientRequest schema'); }
  const missing = REQUIRED_METHODS.filter(m => !text.includes('"' + m + '"'));
  if (missing.length) fail(CODEX_INCOMPATIBLE, 'schema 缺必需方法: ' + missing.join(','));
  // spec §6.3:schema 必须能表达 workspace-write sandbox + 非交互 approval
  if (!/workspaceWrite|workspace-write/.test(text)) fail(CODEX_INCOMPATIBLE, 'schema 不支持 workspace-write sandbox');
  if (!/approvalPolicy|approval_policy/.test(text)) fail(CODEX_INCOMPATIBLE, 'schema 不支持 approval policy');
  if (!/cwd/.test(text)) fail(CODEX_INCOMPATIBLE, 'schema 不支持 cwd');
  return { schemaHash: sha256Hex(text).slice(0, 16) };
}

// —— JSON-RPC client(newline-delimited;Preflight handshake 实测)——
export class CodexAppServerClient {
  constructor(runtimePath, opts = {}) {
    this.runtimePath = runtimePath;
    this._extraEnv = opts && opts.env ? opts.env : null; // 测试注入(如 CODEX_FAKE_LOG);生产为 null
    this._child = null;
    this._buf = '';
    this._reqId = 0;
    this._pending = new Map();        // id → {resolve, reject}
    this._onNotification = null;
    this._closed = false;
  }
  onNotification(cb) { this._onNotification = cb; }

  _spawn() {
    if (this._child) return;
    let child;
    try {
      child = spawn(this.runtimePath, ['app-server', '--stdio'],
        { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: this._extraEnv ? { ...sanitizedEnv(), ...this._extraEnv } : sanitizedEnv(), windowsHide: true });
    } catch (e) {
      fail((e && e.code === 'ENOENT') ? CODEX_APP_NOT_FOUND : CODEX_APP_UNTRUSTED, '无法启动 App runtime: ' + (e && e.message));
    }
    this._child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    child.stderr.on('data', () => { /* 诊断 only,不泄给 UI / stdout(spec §9) */ });
    child.on('error', () => this._terminate(new Error('app-server process error'), CODEX_TURN_FAILED));
    child.on('close', (code) => this._terminate(new Error('app-server exited code=' + code), CODEX_TURN_FAILED));
  }
  _terminate(err, code) {
    if (this._closed) return;
    this._closed = true;
    const e = Object.assign(new Error(err.message || 'terminated'), { code });
    for (const { reject } of this._pending.values()) { try { reject(e); } catch (_) {} }
    this._pending.clear();
    if (this._onNotification) { try { this._onNotification({ __terminated: true, code }); } catch (_) {} }
  }
  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; } // 非 JSON 噪声忽略(spec §10.7)
      this._handle(msg);
    }
  }
  _handle(msg) {
    if (msg && msg.id != null && this._pending.has(String(msg.id))) {
      const { resolve, reject } = this._pending.get(String(msg.id));
      this._pending.delete(String(msg.id));
      if (msg.error) {
        const txt = JSON.stringify(msg.error);
        const code = /auth|unauthorized|login|credential/i.test(txt) ? CODEX_AUTH_REQUIRED : CODEX_TURN_FAILED;
        reject(Object.assign(new Error('JSON-RPC error: ' + txt), { code, rpcError: msg.error }));
      } else { resolve(msg.result); }
      return;
    }
    // notification(无 id):method 或 notification 字段
    if (msg && msg.id == null && (msg.method || msg.notification)) {
      if (this._onNotification) { try { this._onNotification(msg); } catch (_) {} }
    }
    // 未知 response id(spec §10.7):忽略,不崩
  }
  _send(obj) {
    if (!this._child || this._closed) fail(CODEX_TURN_FAILED, 'app-server 未运行或已退出');
    this._child.stdin.write(JSON.stringify(obj) + '\n');
  }
  _request(method, params, timeoutMs) {
    const id = String(++this._reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(Object.assign(new Error('request timeout: ' + method), { code: CODEX_TIMED_OUT }));
        }
      }, timeoutMs || HANDSHAKE_TIMEOUT_MS);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  _notify(method, params) { this._send({ jsonrpc: '2.0', method, params: params || {} }); }

  // initialize → initialized(spec §2/§6.1;真实 0.145 实测 params={clientInfo, protocolVersion:1, capabilities:{}})
  async initialize(timeoutMs) {
    this._spawn();
    await this._request('initialize', { clientInfo: CLIENT_INFO, protocolVersion: 1, capabilities: {} }, timeoutMs || HANDSHAKE_TIMEOUT_MS);
    this._notify('initialized', {});
    return true;
  }

  // —— runTask(spec §6.1 唯一允许序列,§6.6 抽出的共用执行):handshake → thread/start|resume → turn/start → 等 turn/completed ——
  // 不接受任意 method;序列写死,杜绝 forbidden method。runCandidate / runPlan 都是它的薄封装。
  async runTask({ sessionMode, storedThreadId, workspaceCwd, prompt, timeoutMs, onStream }) {
    const turnTimeout = timeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    await this.initialize(HANDSHAKE_TIMEOUT_MS);

    let threadId;
    if (sessionMode === 'continue') {
      if (!storedThreadId) fail(CODEX_SESSION_UNAVAILABLE, 'continue 需要 storedThreadId');
      try {
        const r = await this._request('thread/resume',
          { threadId: storedThreadId, cwd: workspaceCwd, approvalPolicy: 'never', sandbox: 'workspace-write' }, turnTimeout);
        threadId = extractThreadId(r) || storedThreadId;
      } catch (e) {
        if (e && e.code === CODEX_TIMED_OUT) throw e;
        fail(CODEX_SESSION_UNAVAILABLE, 'thread/resume 失败: ' + (e && e.message)); // spec §6.2:resume 失败不退化到 start
      }
    } else {
      const r = await this._request('thread/start',
        { cwd: workspaceCwd, approvalPolicy: 'never', sandbox: 'workspace-write' }, turnTimeout);
      threadId = extractThreadId(r);
      if (!threadId) fail(CODEX_TURN_FAILED, 'thread/start 未返回 threadId(result.thread.id):' + JSON.stringify(r).slice(0, 200));
    }

    // 等终态:turn/completed(notification);期间 error 视为 turn 失败(spec §6.1/§9)。
    // 同时把中途 notification 转发为 stream 事件(onStream),给 UI 实时进度。
    let terminal = null;
    const done = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(Object.assign(new Error('turn 超过 ' + turnTimeout + 'ms'), { code: CODEX_TIMED_OUT })); }
      }, turnTimeout);
      this._onNotification = (msg) => {
        if (typeof onStream === 'function') { try { const s = codexNotificationToStream(msg); if (s) onStream(s); } catch (e) { /* 非关键 */ } }
        if (settled) return;
        const m = msg.method || msg.notification;
        if (msg.__terminated) { settled = true; clearTimeout(timer); reject(Object.assign(new Error('app-server 终止'), { code: msg.code || CODEX_TURN_FAILED })); return; }
        if (m === 'turn/completed') { settled = true; clearTimeout(timer); terminal = msg.params || {}; resolve(); }
        else if (m === 'error' && msg.params && msg.params.fatal) { settled = true; clearTimeout(timer); reject(Object.assign(new Error('app-server fatal: ' + JSON.stringify(msg.params).slice(0, 200)), { code: CODEX_TURN_FAILED })); }
      };
    });

    // turn/start:cwd=workspace,sandboxPolicy=workspaceWrite(禁网),approvalPolicy=never(spec §6.3)
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: workspaceCwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspaceCwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    };
    try { await this._request('turn/start', turnParams, turnTimeout); }
    catch (e) { if (!terminal) { try { await this.close(); } catch (_) {} throw e; } }

    await done;
    return { threadId, terminal };
  }

  // runCandidate = runTask(向后兼容 codex-adapter 的 candidate 执行)。
  async runCandidate({ sessionMode, storedThreadId, workspaceCwd, prompt, timeoutMs, onStream }) {
    return this.runTask({ sessionMode, storedThreadId, workspaceCwd, prompt, timeoutMs, onStream });
  }

  // runPlan(spec §6.6):永远 thread/start,绝不 thread/resume;writableRoots 仅 plan 目录(调用方传 planDir 作 workspaceCwd)。
  async runPlan({ workspaceCwd, prompt, timeoutMs, onStream }) {
    return this.runTask({ sessionMode: 'new', storedThreadId: null, workspaceCwd, prompt, timeoutMs, onStream });
  }

  async close() {
    if (this._closed && !this._child) return;
    this._closed = true;
    const c = this._child;
    this._child = null;
    if (c) {
      try { c.stdin.end(); } catch (_) {}
      try { c.kill(); } catch (_) {}
    }
  }
}
