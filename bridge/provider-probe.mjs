// bridge/provider-probe.mjs — v0.8.1 §7:provider probe helpers(只读检查,绝不创建 session/thread/candidate)。
// 给 host.mjs 的 provider_probe 消息用;返回稳定分类状态,不把原始 stderr/路径/TeamID/schema 路径透给 UI
// (UI 侧的裁剪在 background PlanValidate.sanitizeProbeResult 做;这里只产出分类 + 简短 version)。
// 每 provider 独立 try/catch:一个失败不污染另一个(§5.1)。
import { spawnSync } from 'node:child_process';
import { CLAUDE_BIN, checkAuth } from './claude-cli.mjs';
import {
  discoverAppRuntime, verifySchema, CodexAppServerClient,
  CODEX_APP_NOT_FOUND, CODEX_APP_UNTRUSTED, CODEX_INCOMPATIBLE, CODEX_AUTH_REQUIRED, CODEX_TIMED_OUT
} from './codex-app-server-client.mjs';
import { spawnGenerateSchema } from './codex-adapter.mjs';
import { probeCopilot } from './copilot-runtime.mjs';
import { listProviderIds } from './provider-registry.mjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 10_000; // §7:单 provider 超时 10s

// Claude CLI 探测(§7):--version(在不在)+ auth status(登没登)。绝不启动 -p task。
// opts 注入点:claudeVersion() / claudeAuthCheck()(测试用 fake)。
// v0.9.1:导出单 provider probe(带注入点),供 certification harness / fixture 复用;probeProviders 仍是主入口。
export async function probeClaude({ claudeVersion, claudeAuthCheck } = {}) {
  const version = typeof claudeVersion === 'function'
    ? claudeVersion()
    : (() => {
        try {
          const r = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          if (r.error || r.status !== 0) return null;
          return String(r.stdout || '').trim() || null;
        } catch (e) { return null; }
      })();
  if (!version) return { id: 'claude_code_cli', status: 'not_installed', capabilities: [] };
  try {
    const check = claudeAuthCheck || ((cwd) => checkAuth({ cwd, timeoutMs: PROBE_TIMEOUT_MS }));
    await check(process.cwd());
    return { id: 'claude_code_cli', label: 'Claude Code', status: 'ready', version, capabilities: ['candidate', 'plan'] };
  } catch (e) {
    if (e && (e.code === 'CLAUDE_NOT_INSTALLED')) return { id: 'claude_code_cli', status: 'not_installed', capabilities: [] };
    if (e && e.code === 'CLAUDE_NOT_LOGGED_IN') return { id: 'claude_code_cli', label: 'Claude Code', status: 'auth_required', capabilities: [] };
    return { id: 'claude_code_cli', label: 'Claude Code', status: 'error', capabilities: [] };
  }
}

// Codex App Server 探测(§7):discovery + 签名 + --version + schema gen/validation + 短初始化 handshake。绝不创建 thread/turn。
// opts 注入点:codexDiscover() / generateSchema / codexHandshake(runtimePath)(测试用 fake)。
export async function probeCodex({ codexDiscover, generateSchema, codexHandshake, schemaDir } = {}) {
  let rt;
  try {
    rt = typeof codexDiscover === 'function' ? codexDiscover() : discoverAppRuntime();
  } catch (e) {
    if (e && (e.code === CODEX_APP_NOT_FOUND)) return { id: 'codex_app_server', status: 'not_found', capabilities: [] };
    if (e && e.code === CODEX_APP_UNTRUSTED) return { id: 'codex_app_server', label: 'Codex', status: 'untrusted', capabilities: [] };
    return { id: 'codex_app_server', label: 'Codex', status: 'error', capabilities: [] };
  }
  // schema 兼容(spec §2/§7):未提供 schemaDir 时才 generate(避免重复 spawn;测试/缓存可直接给)
  let sd = schemaDir;
  let tmpSd = null;
  try {
    if (!sd) {
      tmpSd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-schema-'));
      sd = tmpSd;
      await (generateSchema || spawnGenerateSchema)(rt.runtimePath, sd);
    }
    verifySchema({ schemaDir: sd });
  } catch (e) {
    if (tmpSd) { try { fs.rmSync(tmpSd, { recursive: true, force: true }); } catch (_) {} }
    return { id: 'codex_app_server', label: 'Codex', status: 'incompatible', capabilities: [] };
  } finally {
    if (tmpSd) { try { fs.rmSync(tmpSd, { recursive: true, force: true }); } catch (_) {} }
  }
  // 短初始化 handshake(不创 thread/turn);失败按 auth/超时分类
  try {
    if (typeof codexHandshake === 'function') {
      await codexHandshake(rt.runtimePath);
    } else {
      const c = new CodexAppServerClient(rt.runtimePath);
      try { await c.initialize(PROBE_TIMEOUT_MS); }
      finally { try { await c.close(); } catch (_) {} }
    }
    return { id: 'codex_app_server', label: 'Codex', status: 'ready', version: rt.version || rt.appVersion || null, capabilities: ['candidate', 'plan'] };
  } catch (e) {
    if (e && e.code === CODEX_AUTH_REQUIRED) return { id: 'codex_app_server', label: 'Codex', status: 'auth_required', capabilities: [] };
    if (e && e.code === CODEX_TIMED_OUT) return { id: 'codex_app_server', label: 'Codex', status: 'error', capabilities: [] };
    return { id: 'codex_app_server', label: 'Codex', status: 'error', capabilities: [] };
  }
}

// 主入口:并发探测请求的 providers(默认三个都探),每 provider 独立失败。返回 { providers: [...] }。
// opts 透传给各 probe 的注入点(测试用);copilot 的注入点在 opts.copilot。
export async function probeProviders(providers = listProviderIds(), opts = {}) {
  const wanted = new Set(Array.isArray(providers) ? providers : []);
  const tasks = [];
  if (wanted.has('claude_code_cli')) tasks.push(probeClaude(opts).catch((e) => ({ id: 'claude_code_cli', status: 'error', capabilities: [] })));
  if (wanted.has('codex_app_server')) tasks.push(probeCodex(opts).catch((e) => ({ id: 'codex_app_server', status: 'error', capabilities: [] })));
  // v0.8.2:GitHub Copilot。独立失败域——copilot probe 炸了不影响 claude/codex(§9 隔离要求)。
  if (wanted.has('github_copilot')) tasks.push(probeCopilot((opts && opts.copilot) || {}).catch((e) => ({ id: 'github_copilot', status: 'error', capabilities: [] })));
  const settled = await Promise.all(tasks);
  return { providers: settled };
}
