// bridge/provider-registry.mjs — v0.9.1 §3:provider descriptor 唯一生产 registry(不可变 allow-list)。
// 目标:新增第 4/5 家 Agent 时,能力/dispatch/probe 映射不再散落在 background/host/probe/sidepanel 的 if/else 里漂移。
// descriptor 只含静态声明:不含路径、命令、token、登录态、用户数据、动态版本或可执行函数。
// 生产运行时只相信 registry 的静态能力;provider probe 自报的 capabilities 不得扩大权限。

const cap = (list) => Object.freeze(list.slice());

export const PROVIDER_REGISTRY = Object.freeze({
  claude_code_cli: Object.freeze({
    id: "claude_code_cli",
    label_key: "provider.claude",
    capabilities: cap(["candidate", "plan"]),
    dispatch_type: "claude_handoff_start",
    probe: "claude",
    runtime_policy: "provider_default",   // claude CLI 固定 argv 沙箱
    supports_real_smoke: true
  }),
  codex_app_server: Object.freeze({
    id: "codex_app_server",
    label_key: "provider.codex",
    capabilities: cap(["candidate", "plan"]),
    dispatch_type: "codex_handoff_start",
    probe: "codex",
    runtime_policy: "signed_app_only",    // 仅 com.openai.codex bundle + codesign TeamID
    supports_real_smoke: true
  }),
  github_copilot: Object.freeze({
    id: "github_copilot",
    label_key: "provider.copilot",
    capabilities: cap(["candidate", "plan"]),
    dispatch_type: "copilot_handoff_start",
    probe: "copilot",
    runtime_policy: "runtime_locked",     // Plan→Candidate 锁定同一 runtime(local_cli / bundled_sdk_cli)
    supports_real_smoke: true
  })
});

const _IDS = Object.freeze(Object.keys(PROVIDER_REGISTRY));

export function listProviderIds() { return _IDS; }

// 不在 allow-list → null(绝不抛异常,调用方按未知 provider 处理)。
export function getProviderDescriptor(id) {
  if (typeof id !== "string") return null;
  return Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, id) ? PROVIDER_REGISTRY[id] : null;
}

export function providerSupports(id, capability) {
  const d = getProviderDescriptor(id);
  return !!(d && d.capabilities.indexOf(capability) !== -1);
}

// 启动/测试期严格校验 descriptor 形状(新增 provider 写错结构时第一道硬门)。
const VALID_CAPS = { candidate: 1, plan: 1 };
const VALID_POLICIES = { provider_default: 1, signed_app_only: 1, runtime_locked: 1 };
const FORBIDDEN_KEYS = { path: 1, command: 1, argv: 1, token: 1, cookie: 1, session: 1, exec: 1, fn: 1, url: 1, env: 1 };

export function assertProviderDescriptor(value) {
  const bad = (field) => { const e = new Error("invalid provider descriptor: " + field); e.code = "INVALID_PROVIDER_DESCRIPTOR"; throw e; };
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("shape");
  if (typeof value.id !== "string" || !value.id) bad("id");
  if (typeof value.label_key !== "string" || !value.label_key) bad("label_key");
  if (!Array.isArray(value.capabilities) || !value.capabilities.length) bad("capabilities");
  for (const c of value.capabilities) { if (!VALID_CAPS[c]) bad("capability:" + c); }
  if (typeof value.dispatch_type !== "string" || !/^[a-z_]+$/.test(value.dispatch_type)) bad("dispatch_type");
  if (typeof value.probe !== "string" || !value.probe) bad("probe");
  if (!VALID_POLICIES[value.runtime_policy]) bad("runtime_policy");
  if (typeof value.supports_real_smoke !== "boolean") bad("supports_real_smoke");
  for (const k of Object.keys(value)) { if (FORBIDDEN_KEYS[k]) bad("forbidden_key:" + k); }
  return value;
}

// 自检:registry 内所有 descriptor 合法(模块加载即校验)。
for (const id of _IDS) assertProviderDescriptor(PROVIDER_REGISTRY[id]);
