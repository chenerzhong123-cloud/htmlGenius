// analytics.js — 页面侧埋点薄壳。track 只把事件转发给 background SW(队列/游标/网络的唯一写者),
// 自身零存储零网络;同时把 config.js 里的 GA 配置搬进 storage(SW 无法加载 config.js)。
(function () {
  "use strict";
  window.HGAnalytics = {
    track: function (name, params) {
      try {
        var p = chrome.runtime.sendMessage({ type: "hg-track", name: name, params: params || {} });
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* 埋点永不影响产品 */ }
    },
  };
  try {
    var cfg = window.HG_CONFIG || {};
    if (cfg.ga_measurement_id) {
      chrome.storage.local.set({ hg_ga: { id: cfg.ga_measurement_id, secret: cfg.ga_api_secret || "" } });
    }
  } catch (e) { /* 非关键 */ }
})();
