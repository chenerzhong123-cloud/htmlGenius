// extension/sync.js — 协同插件 SSE 客户端
//
// 职责：
//   1. 纯函数 parseEvent：把后端 SSE 事件名 + data JSON 解析成 delta
//      （create/delete/presence），hello 及未知事件返回 null。
//   2. start()：先 POST /api/stream/ticket(Bearer) 换短时效票据，再以
//      EventSource(/api/stream?doc=&ticket=) 连接并绑定事件回调；连接打开时
//      发 presence=join 并启动 25s 心跳；断线时取【新票据】重连（票据会过期，
//      不能复用旧 URL）；stop() 清理定时器、尽力发 bye（sendBeacon 优先，回退
//      fetch keepalive），再关闭连接。
//
// 鉴权约定（SUP-2）：长期 session token 只放进 POST/心跳的 Authorization 头，
//   【不再】拼进 SSE URL —— 改由短时效、仅绑定 team 的流票据进 URL，落日志也无碍。
//   presence POST 用 Authorization: Bearer + body {doc,user,op}。
//   bye 走 sendBeacon（不能加 header，浏览器限制）→ 后端对 bye 放宽鉴权
//   兜底；MVP 接受 bye 偶发丢失（后端 60s GC 清理）。
//
// classic script（非 module），挂到 window.Sync；MV3 兼容。
window.Sync = (function () {
  "use strict";

  // 纯函数：SSE event 名 + data JSON 字符串 → delta 或 null（hello/未知/坏 JSON）
  //  - {op:"create", annotation}    annotation:created
  //  - {op:"update", annotation}    annotation:updated
  //  - {op:"delete", id}            annotation:deleted
  //  - {op:"presence", users}       presence
  function parseEvent(event, dataStr) {
    var data;
    try {
      data = JSON.parse(dataStr || "{}");
    } catch (e) {
      // SUP-12:畸形 JSON 一律返回 null(让 applyDelta no-op),杜绝幽灵空批注
      //(原先 catch 里 data 归一为 {} → annotation:created 产出 {op:create,annotation:{}})。
      return null;
    }
    // 非对象(JSON 字符串/数字/null/数组)同样无法成批注/presence → null
    if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
    if (event === "annotation:created") return { op: "create", annotation: data };
    if (event === "annotation:updated") return { op: "update", annotation: data };
    if (event === "annotation:deleted") return { op: "delete", id: data.id };
    if (event === "presence") return { op: "presence", users: Array.isArray(data.users) ? data.users : [] };
    return null; // hello / 未知事件忽略
  }

  // 纯函数:把 delta 原地应用到 list,返回 list。
  //   op:"create" — id 不存在才 push(幂等:重复 create 同 id 不重复入列)
  //   op:"update" — 按 id 替换(不存在则 push)
  //   op:"delete" — 移除该 id 及其所有子孙(parent_id === 被删 id 的项级联删除)
  //   其余 op 静默无副作用。
  // 不触碰 DOM / chrome.*;content-script 调它后再自行重渲染 overlay。
  function applyDelta(list, delta) {
    if (!list || !delta) return list;
    if (delta.op === "create") {
      var ann = delta.annotation || {};
      if (!list.find(function (a) { return a && a.id === ann.id; })) {
        list.push(ann);
      }
    } else if (delta.op === "update") {
      var upd = delta.annotation || {};
      var ui = list.findIndex(function (a) { return a && a.id === upd.id; });
      if (ui >= 0) list[ui] = upd; else list.push(upd);
    } else if (delta.op === "delete") {
      var id = delta.id;
      // 先删目标
      var i = list.findIndex(function (a) { return a && a.id === id; });
      if (i >= 0) list.splice(i, 1);
      // 级联:删所有 parent_id === 被删 id 的子回复
      for (var j = list.length - 1; j >= 0; j--) {
        if (list[j] && list[j].parent_id === id) list.splice(j, 1);
      }
    }
    return list;
  }

  function start(opts) {
    opts = opts || {};
    var backend = opts.backend || "";
    var sessionToken = opts.session_token || "";
    var docId = opts.docId || "";
    var user = opts.user || {};
    var onCreate = opts.onCreate || null;
    var onUpdate = opts.onUpdate || null;
    var onDelete = opts.onDelete || null;
    var onPresence = opts.onPresence || null;
    // v0.4 §5.3:重连(及首连)时回调一次,供 content-script 跑 GET /api/annotations
    // 全量对账,补齐断线期间错过的 delta。首连会多一次 GET,可接受。
    var onReconnect = opts.onReconnect || null;
    // R-12:永久性失败(session 失效,取票 401/403)回调一次,供上层提示用户重登;触发后本端停止重连。
    var onFatal = opts.onFatal || null;

    // SUP-2:长期 session token 不再进 SSE URL。连接前先 POST /api/stream/ticket
    // (Bearer 头)换一张短时效、仅绑定 team 的票据,EventSource 用 ?ticket= 连接。
    var es = null;
    var hbTimer = null;
    var reconnectTimer = null;
    var stopped = false;
    var failCount = 0; // R-12:连续失败计数(连上即清零),用于指数退避

    // 发送 presence：join/heartbeat/自定义 op。catch 吞错，避免心跳偶发失败炸进程。
    function sendPresence(op) {
      var body = JSON.stringify({
        doc: docId,
        user: user,
        op: op || "heartbeat",
      });
      return fetch(backend + "/api/presence", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + sessionToken,
          "Content-Type": "application/json",
        },
        body: body,
      }).catch(function () {
        /* 心跳/失败不影响主流程 */
      });
    }

    // 事件回调：复用 parseEvent 解析，再分发到业务回调
    function dispatch(eventName, raw, handler, extract) {
      var delta = parseEvent(eventName, raw);
      if (delta && handler) handler(extract(delta));
    }

    function bindEvents(source) {
      source.addEventListener(
        "annotation:created",
        function (e) {
          dispatch(e.type, e.data, onCreate, function (d) {
            return d.annotation;
          });
        }
      );
      source.addEventListener(
        "annotation:updated",
        function (e) {
          dispatch(e.type, e.data, onUpdate, function (d) {
            return d.annotation;
          });
        }
      );
      source.addEventListener(
        "annotation:deleted",
        function (e) {
          dispatch(e.type, e.data, onDelete, function (d) {
            return d.id;
          });
        }
      );
      source.addEventListener(
        "presence",
        function (e) {
          dispatch(e.type, e.data, onPresence, function (d) {
            return d.users;
          });
        }
      );

      // 打开即 join + 25s 心跳（与后端 60s GC 留足 2 次心跳冗余）。
      // 每次(重)连上都触发 onReconnect 跑一次 GET /api/annotations 全量对账(§5.3)。
      source.onopen = function () {
        failCount = 0; // R-12:连上即重置退避计数
        sendPresence("join");
        if (hbTimer) clearInterval(hbTimer);
        hbTimer = setInterval(function () {
          sendPresence("heartbeat");
        }, 25000);
        if (onReconnect) {
          try { onReconnect(); } catch (e) { /* 对账失败不影响主流程 */ }
        }
      };

      // SUP-2:票据会过期,EventSource 默认自动重连会复用同一(过期)URL → 失败循环。
      // 故关闭当前连接、取一张新票据手动重连。
      source.onerror = function () {
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (stopped) return;
      try { if (es) es.close(); } catch (e) {}
      es = null;
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (reconnectTimer) return;  // 已有重连排队,避免叠加
      // R-12:指数退避(1.5→3→6→12→24→48→60s 封顶),避免永久性失败时固定 1.5s 死循环刷屏/压服务端。
      failCount = Math.min(failCount + 1, 6);
      var delay = Math.min(60000, 1500 * Math.pow(2, failCount - 1));
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      if (stopped) return;
      fetch(backend + "/api/stream/ticket", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + sessionToken,
          "Content-Type": "application/json",
        },
      })
        .then(function (r) {
          if (!r.ok) throw new Error("ticket HTTP " + r.status);
          return r.json();
        })
        .then(function (j) {
          if (stopped) return;
          var ticket = j && j.ticket;
          if (!ticket) throw new Error("no ticket in response");
          var url =
            backend +
            "/api/stream?doc=" +
            encodeURIComponent(docId) +
            "&ticket=" +
            encodeURIComponent(ticket);
          es = new EventSource(url);
          bindEvents(es);
        })
        .catch(function (err) {
          if (stopped) return;
          // R-12:取票 401/403 = session 失效(永久)→ 不再重试,回调 onFatal 提示用户重登;
          //      其余(网络抖动 / 5xx)走指数退避重连,不丢实时性。
          var msg = (err && err.message) || "";
          if (/HTTP 40[13]/.test(msg)) {
            if (onFatal) { try { onFatal("auth"); } catch (e) { /* 非关键 */ } }
            stopped = true; // 停止重连,等用户重登后由上层重新 startSync
            return;
          }
          scheduleReconnect();
        });
    }

    connect();

    // 停止：清定时器 → 尽力 bye → 关连接
    function stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (hbTimer) {
        clearInterval(hbTimer);
        hbTimer = null;
      }
      try {
        // sendBeacon 不能带 header，bye 鉴权放宽；body 与 presence 一致
        var blob = new Blob(
          [JSON.stringify({ doc: docId, user: user, op: "bye" })],
          { type: "application/json" }
        );
        if (
          navigator &&
          typeof navigator.sendBeacon === "function" &&
          navigator.sendBeacon(backend + "/api/presence", blob)
        ) {
          // 已投递
        } else {
          // 回退：fetch keepalive（页面即将关闭时也能投出）
          fetch(backend + "/api/presence", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + sessionToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ doc: docId, user: user, op: "bye" }),
            keepalive: true,
          }).catch(function () {});
        }
      } catch (e) {
        /* bye 失败无碍，靠后端 GC 兜底 */
      }
      if (es) {
        try { es.close(); } catch (e) {}
        es = null;
      }
    }

    return { stop: stop, sendPresence: sendPresence };
  }

  return { start: start, parseEvent: parseEvent, applyDelta: applyDelta };
})();
