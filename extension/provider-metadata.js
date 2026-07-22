// extension/provider-metadata.js — v0.9.1 §3.1:extension 侧只读 provider 元数据(与 bridge/provider-registry.mjs 同源一致)。
// extension 不能 import Node 模块;本文件供 background(importScripts)与 sidepanel 使用。
// 一致性由 bridge/test/provider-registry.test.mjs 强制:ID / label_key / capabilities / dispatch_type 两侧必须完全相同。
// 修改 provider 集合时两个文件一起改,测试会兜底。
(function (root) {
  "use strict";

  function freezeDesc(d) {
    return Object.freeze({
      id: d.id, label_key: d.label_key, capabilities: Object.freeze(d.capabilities.slice()),
      dispatch_type: d.dispatch_type, probe: d.probe, runtime_policy: d.runtime_policy,
      supports_real_smoke: d.supports_real_smoke
    });
  }

  var PROVIDERS = Object.freeze({
    claude_code_cli: freezeDesc({
      id: "claude_code_cli", label_key: "provider.claude", capabilities: ["candidate", "plan"],
      dispatch_type: "claude_handoff_start", probe: "claude", runtime_policy: "provider_default", supports_real_smoke: true
    }),
    codex_app_server: freezeDesc({
      id: "codex_app_server", label_key: "provider.codex", capabilities: ["candidate", "plan"],
      dispatch_type: "codex_handoff_start", probe: "codex", runtime_policy: "signed_app_only", supports_real_smoke: true
    }),
    github_copilot: freezeDesc({
      id: "github_copilot", label_key: "provider.copilot", capabilities: ["candidate", "plan"],
      dispatch_type: "copilot_handoff_start", probe: "copilot", runtime_policy: "runtime_locked", supports_real_smoke: true
    })
  });

  var _IDS = Object.freeze(Object.keys(PROVIDERS));

  function listProviderIds() { return _IDS; }
  function getProviderDescriptor(id) {
    if (typeof id !== "string") return null;
    return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
  }
  function providerSupports(id, capability) {
    var d = getProviderDescriptor(id);
    return !!(d && d.capabilities.indexOf(capability) !== -1);
  }

  var api = {
    PROVIDERS: PROVIDERS,
    listProviderIds: listProviderIds,
    getProviderDescriptor: getProviderDescriptor,
    providerSupports: providerSupports
  };
  root.ProviderMetadata = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
