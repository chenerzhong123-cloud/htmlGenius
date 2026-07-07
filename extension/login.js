// login.js — 飞书 OAuth 登录流程(MV3 chrome.identity.launchWebAuthFlow)
// 暴露 window.Login:
//   - parseCallbackUrl(url)   → {code, state}(从重定向 URL 解析)
//   - buildCallbackBody(o)    → POST /auth/lark/callback 的 JSON body 字符串(纯函数,测试用)
//   - start({backend})        → 完整登录,返回 {token, user:{id,name}, team_id}
window.Login = (function () {
  "use strict";

  function parseCallbackUrl(url) {
    try {
      var u = new URL(url);
      return {
        code: u.searchParams.get("code") || "",
        state: u.searchParams.get("state") || "",
      };
    } catch (e) {
      return { code: "", state: "" };
    }
  }

  function buildCallbackBody(o) {
    return JSON.stringify({
      code: o.code,
      redirect_uri: o.redirect,
      state: o.state,
    });
  }

  // 完整流程:getRedirectURL → /auth/lark/login → launchWebAuthFlow → /auth/lark/callback
  async function start(opts) {
    opts = opts || {};
    var backend = opts.backend || "";
    var redirect = chrome.identity.getRedirectURL();
    var lr = await fetch(
      backend + "/auth/lark/login?redirect=" + encodeURIComponent(redirect)
    ).then(function (r) { return r.json(); });
    var respUrl = await chrome.identity.launchWebAuthFlow({
      url: lr.auth_url,
      interactive: true,
    });
    var cb = parseCallbackUrl(respUrl);
    if (!cb.code) throw new Error("未拿到授权码");
    var r = await fetch(backend + "/auth/lark/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildCallbackBody({ code: cb.code, redirect: redirect, state: cb.state }),
    });
    if (!r.ok) throw new Error("login failed " + r.status);
    return r.json();
  }

  return { start: start, parseCallbackUrl: parseCallbackUrl, buildCallbackBody: buildCallbackBody };
})();
