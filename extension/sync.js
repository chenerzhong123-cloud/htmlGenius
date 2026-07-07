// extension/sync.js — 协同插件 SSE 客户端
//
// 职责：
//   1. 纯函数 parseEvent：把后端 SSE 事件名 + data JSON 解析成 delta
//      （create/delete/presence），hello 及未知事件返回 null。
//   2. start()：打开 EventSource(/api/stream?doc=&token=)，绑定事件回调；
//      连接打开时发 presence=join 并启动 25s 心跳；stop() 清理定时器、
//      尽力发 bye（sendBeacon 优先，回退 fetch keepalive），再关闭连接。
//
// 鉴权约定：presence POST 用 Authorization: Bearer + body {doc,user,op}。
//   bye 走 sendBeacon（不能加 header，浏览器限制）→ 后端对 bye 放宽鉴权
//   兜底；MVP 接受 bye 偶发丢失（后端 60s GC 清理）。
//
// classic script（非 module），挂到 window.Sync；MV3 兼容。
window.Sync = (function () {
  "use strict";

  // 纯函数：SSE event 名 + data JSON 字符串 → delta 或 null（hello/未知/坏 JSON）
  //  - {op:"create", annotation}    annotation:created
  //  - {op:"delete", id}            annotation:deleted
  //  - {op:"presence", users}       presence
  function parseEvent(event, dataStr) {
    var data = {};
    try {
      data = JSON.parse(dataStr || "{}");
    } catch (e) {
      data = {};
    }
    if (event === "annotation:created") return { op: "create", annotation: data };
    if (event === "annotation:deleted") return { op: "delete", id: data.id };
    if (event === "presence") return { op: "presence", users: data.users || [] };
    return null; // hello / 未知事件忽略
  }

  // 纯函数:把 delta 原地应用到 list,返回 list。
  //   op:"create" — id 不存在才 push(幂等:重复 create 同 id 不重复入列)
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
    var onDelete = opts.onDelete || null;
    var onPresence = opts.onPresence || null;
    // v0.4 §5.3:重连(及首连)时回调一次,供 content-script 跑 GET /api/annotations
    // 全量对账,补齐断线期间错过的 delta。首连会多一次 GET,可接受。
    var onReconnect = opts.onReconnect || null;

    var url =
      backend +
      "/api/stream?doc=" +
      encodeURIComponent(docId) +
      "&token=" +
      encodeURIComponent(sessionToken);

    var es = new EventSource(url);
    var hbTimer = null;

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

    es.addEventListener(
      "annotation:created",
      function (e) {
        dispatch(e.type, e.data, onCreate, function (d) {
          return d.annotation;
        });
      }
    );
    es.addEventListener(
      "annotation:deleted",
      function (e) {
        dispatch(e.type, e.data, onDelete, function (d) {
          return d.id;
        });
      }
    );
    es.addEventListener(
      "presence",
      function (e) {
        dispatch(e.type, e.data, onPresence, function (d) {
          return d.users;
        });
      }
    );

    // 打开即 join + 25s 心跳（与后端 60s GC 留足 2 次心跳冗余）。
    // onopen 在首连和 EventSource 自动重连时都会触发 → 顺便调 onReconnect
    // 跑一次 GET /api/annotations 全量对账(§5.3),补齐断线期间错过的 delta。
    es.onopen = function () {
      sendPresence("join");
      hbTimer = setInterval(function () {
        sendPresence("heartbeat");
      }, 25000);
      if (onReconnect) {
        try { onReconnect(); } catch (e) { /* 对账失败不影响主流程 */ }
      }
    };

    // EventSource 默认自动重连，这里只需静默
    es.onerror = function () {
      /* 自动重连 */
    };

    // 停止：清心跳 → 尽力 bye → 关连接
    function stop() {
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
      es.close();
    }

    return { stop: stop, sendPresence: sendPresence };
  }

  return { start: start, parseEvent: parseEvent, applyDelta: applyDelta };
})();
