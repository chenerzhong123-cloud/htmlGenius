// extension/connection-center-state.js — v0.9.1 §9.1:Connection Center 的纯函数状态层。
// sidepanel 的渲染/复制/修复逻辑由此模块的无副作用输出驱动,使其可用 node:test 直接验证(§5.2 状态矩阵)。
// 不依赖 chrome/DOM;不解析英文错误文本,只认 reason_code / bridge.status 枚举。
(function (root) {
  "use strict";

  // §5.2 状态矩阵 → 视图模型。输入:health(§3.4 契约,可为 null=检查中)+ opts{ userCollapsed, devOnly }。
  // 输出:{ phase, titleKey, descKey, primary:{labelKey,action}|null, secondary:..., showProviders,
  //         collapsed, cls, permanentHintKey, repairAvailable, devOnly }
  function connStateFor(health, opts) {
    opts = opts || {};
    var userCollapsed = (opts.userCollapsed === undefined) ? null : opts.userCollapsed;
    var devOnly = !!opts.devOnly;
    if (!health) {
      return {
        phase: "checking", titleKey: "conn.titleChecking", descKey: null,
        primary: null, secondary: null, showProviders: false, collapsed: false,
        cls: "", permanentHintKey: null, repairAvailable: false, devOnly: devOnly
      };
    }
    var rc = health.reason_code || null;
    var bs = (health.bridge && health.bridge.status) || "";
    var providers = Array.isArray(health.providers) ? health.providers : [];
    var readyCount = 0;
    for (var i = 0; i < providers.length; i++) { if (providers[i] && providers[i].status === "ready") readyCount++; }

    var v = {
      phase: "known", titleKey: "", descKey: null,
      primary: null, secondary: null, showProviders: false, collapsed: false,
      cls: "", permanentHintKey: null, repairAvailable: false, devOnly: devOnly,
      readyCount: readyCount
    };

    if (rc === "OS_UNSUPPORTED") {
      v.titleKey = "conn.titleUnsupported"; v.descKey = "conn.descUnsupported"; v.cls = "warn";
    } else if (rc === "BRIDGE_PROTOCOL_TOO_NEW") {
      v.titleKey = "conn.titleExtNeedUpdate"; v.descKey = "conn.descExtNeedUpdate"; v.cls = "warn";
    } else if (bs === "install_required" || rc === "BRIDGE_NOT_INSTALLED") {
      v.titleKey = "conn.titleNotInstalled"; v.descKey = "conn.descNotInstalled"; v.cls = "warn";
      v.primary = { labelKey: "conn.agentSetup", action: "setup" };
      v.secondary = { labelKey: "conn.copyTerminal", action: "terminal" };
      // 未安装态绝不出现安全修复(§5.2):repairAvailable 保持 false
    } else if (bs === "protocol_incompatible" || rc === "BRIDGE_PROTOCOL_TOO_OLD" || rc === "BRIDGE_FILES_CORRUPT") {
      v.titleKey = "conn.titleNeedRepair"; v.descKey = "conn.descNeedRepair"; v.cls = "warn";
      v.primary = { labelKey: "conn.agentRepair", action: "setup" };
      v.secondary = { labelKey: "conn.copyTerminal", action: "terminal" };
    } else if (bs === "repair_required") {
      v.titleKey = "conn.titleNeedRepair"; v.descKey = "conn.descNeedRepairHost"; v.cls = "warn";
      v.primary = { labelKey: "conn.repair", action: "repair" };
      v.secondary = { labelKey: "conn.copyTerminal", action: "terminal" };
      v.repairAvailable = true;
    } else if (bs === "ready" && readyCount > 0) {
      v.titleKey = "conn.titleConnected"; v.cls = "ok"; v.showProviders = true;
      v.collapsed = true; // 自动折叠基准;userCollapsed 可覆盖
    } else if (bs === "ready") {
      v.titleKey = "conn.titleBridgeReady"; v.descKey = "conn.descBridgeReady";
      v.showProviders = true;
      v.primary = { labelKey: "conn.check", action: "check" };
    } else {
      v.titleKey = "conn.titleNeedRepair"; v.descKey = "conn.descNeedRepair"; v.cls = "warn";
      v.primary = { labelKey: "conn.agentRepair", action: "setup" };
    }

    if (userCollapsed !== null) v.collapsed = !!userCollapsed;
    // 常驻底注:未全部就绪 → 复制 Prompt 仍可用(§0.2 降级路径)
    if (bs !== "ready" || readyCount === 0) v.permanentHintKey = "conn.promptStillAvailable";
    return v;
  }

  // bootstrap 安全自检(§6.1):Setup Prompt 只允许含扩展 ID/版本/固定命令骨架;
  // 不得含 Change Contract/评论/HTML 片段/路径占位以外的用户数据。返回问题数组(空=安全)。
  function assertBootstrapSafe(bootstrap) {
    var problems = [];
    if (!bootstrap || typeof bootstrap !== "object") return ["BOOTSTRAP_MISSING"];
    var text = String(bootstrap.setup_prompt || "") + "\n" + String(bootstrap.terminal_command || "");
    var markers = ["change_contract", "annotations", "annotation", "comment", "quote", "selector", "<html", "<body", "<div", "artifact_uri", "base_artifact_hash"];
    for (var i = 0; i < markers.length; i++) {
      if (text.toLowerCase().indexOf(markers[i]) !== -1) problems.push("BOOTSTRAP_CONTAINS:" + markers[i]);
    }
    // 扩展 ID 若存在必须合法形态
    var ids = text.match(/[a-p]{32}/g) || [];
    if (bootstrap.setup_prompt && ids.length === 0) problems.push("BOOTSTRAP_NO_EXTENSION_ID");
    if (String(bootstrap.terminal_command || "").indexOf("@latest") !== -1) problems.push("BOOTSTRAP_USES_LATEST");
    return problems;
  }

  // 发送菜单只能选择真实 ready 的 provider(§2.3 不变量)。
  function canSelectProvider(providerStates, id) {
    return !!(providerStates && providerStates[id] && providerStates[id].status === "ready");
  }

  var api = {
    connStateFor: connStateFor,
    assertBootstrapSafe: assertBootstrapSafe,
    canSelectProvider: canSelectProvider,
    VERSION: 1
  };
  root.ConnectionCenterState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
