// analytics-core.js — 埋点纯函数集合(无 chrome.*、无网络;now 一律注入,可在测试页驱动)。
// 白名单与 server/app.py EVENT_SPECS 同源镜像:两边必须同步改。
(function () {
  "use strict";
  var CODE_RE = /^[A-Z0-9_]{1,64}$/;
  var PROVIDERS = ["claude_code_cli", "codex_app_server", "github_copilot"];
  var SCOPES = ["precise_patch", "local_optimize", "regenerate"];
  var METHODS = ["google", "email"];
  var SPEC = {
    panel_open: {}, login_start: { method: METHODS }, login_success: { method: METHODS },
    join_workspace: {}, create_workspace: {}, edit_start: { is_local: "bool" },
    comment_create: {}, task_open: { scope: SCOPES },
    task_send: { provider: PROVIDERS, scope: SCOPES },
    task_success: { provider: PROVIDERS }, task_failed: { provider: PROVIDERS, code: "code" },
  };
  function valueOk(rule, v) {
    if (rule === "bool") return typeof v === "boolean" ? v : undefined;
    if (rule === "code") return (typeof v === "string" && CODE_RE.test(v)) ? v : undefined;
    if (Array.isArray(rule)) return (typeof v === "string" && rule.indexOf(v) >= 0) ? v : undefined;
    return undefined;
  }
  function cleanEvent(name, params) {
    var spec = SPEC[name];
    if (!spec) return null;
    var out = {};
    var src = params || {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var rule = spec[k];
      if (rule === undefined) continue;
      var v = valueOk(rule, src[k]);
      if (v !== undefined) out[k] = v;
    }
    return { name: name, params: out };
  }
  function nextSeq(events) {
    var m = 0;
    for (var i = 0; i < events.length; i++) if (events[i].seq > m) m = events[i].seq;
    return m + 1;
  }
  function appendEvent(events, name, params, tsMs, nowMs, cap) {
    cap = cap || 500;
    var ev = cleanEvent(name, params);
    var arr = events.slice();
    if (!ev) return { events: arr, seq: nextSeq(arr) - 1, oldestSeq: arr.length ? arr[0].seq : 0 };
    var seq = nextSeq(arr);
    arr.push({ seq: seq, name: ev.name, params: ev.params, ts: tsMs != null ? tsMs : nowMs });
    while (arr.length > cap) arr.shift();
    return { events: arr, seq: seq, oldestSeq: arr.length ? arr[0].seq : 0 };
  }
  function toFlush(events, cursor) {
    return events.filter(function (e) { return e.seq > cursor; });
  }
  function gaTimestamp(tsMs, nowMs) {
    var H = 3600000;
    if (nowMs - tsMs <= 72 * H) return tsMs * 1000;           // 真实时间
    if (nowMs - tsMs <= 7 * 24 * H) return (nowMs - 71 * H) * 1000; // 钳制(GA4 回填上限 72h)
    return null;                                               // >7 天放弃 GA
  }
  function gaBatches(events, nowMs, size) {
    size = size || 20; // mp/collect 硬上限 25,留余量
    var sendable = [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var ts = gaTimestamp(e.ts, nowMs);
      if (ts === null) continue;
      var params = {};
      for (var k in e.params) params[k] = e.params[k];
      params.engagement_time_msec = "100"; // 缺它用户不计入活跃、部分报告缺事件
      sendable.push({ name: e.name, params: params, timestamp_unix_micros: String(ts) });
    }
    var batches = [];
    for (var j = 0; j < sendable.length; j += size) batches.push(sendable.slice(j, j + size));
    return batches;
  }
  function prune(events, backendCursor, gaCursor) {
    var floor = Math.min(backendCursor, gaCursor);
    return events.filter(function (e) { return e.seq > floor; });
  }
  // 同时被 Side Panel 页面和 MV3 Service Worker 通过 importScripts() 加载；
  // Worker 没有 window，必须使用两种上下文都具备的 globalThis。
  globalThis.HGAnalyticsCore = {
    cleanEvent: cleanEvent, nextSeq: nextSeq, appendEvent: appendEvent,
    toFlush: toFlush, gaTimestamp: gaTimestamp, gaBatches: gaBatches, prune: prune,
  };
})();
