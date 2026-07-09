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

  // 档3:Google 登录(launchWebAuthFlow 隐式 id_token 流 → 后端 JWKS 离线验签)
  // 不用 getAuthToken(部分 Chrome 不返回 idToken)。用 launchWebAuthFlow 直接拿 id_token。
  async function googleStart(opts) {
    opts = opts || {};
    var backend = (window.HG_CONFIG && window.HG_CONFIG.backend) || "";
    var clientId = (window.HG_CONFIG && window.HG_CONFIG.google_client_id) || "";
    if (!clientId) throw new Error("config 缺 google_client_id");
    var redirect = chrome.identity.getRedirectURL();  // https://<ext-id>.chromiumapp.org/
    var nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var authUrl = "https://accounts.google.com/o/oauth2/v2/auth?"
      + "client_id=" + encodeURIComponent(clientId)
      + "&response_type=id_token"
      + "&redirect_uri=" + encodeURIComponent(redirect)
      + "&scope=" + encodeURIComponent("openid email profile")
      + "&nonce=" + encodeURIComponent(nonce);
    var respUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: opts.interactive !== false });
    if (!respUrl) throw new Error("Google 授权取消");
    // 回调 URL:https://<ext-id>.chromiumapp.org/#id_token=<jwt>&...
    var params = new URLSearchParams(respUrl.split("#")[1] || "");
    var idToken = params.get("id_token");
    if (!idToken) {
      var err = params.get("error");
      throw new Error("Google 未返回 id_token" + (err ? "(" + err + ": " + (params.get("error_description") || "") + ")" : ""));
    }
    var body = { id_token: idToken };
    if (opts.action) body.action = opts.action;
    if (opts.code) body.code = opts.code;
    if (opts.team_name) body.team_name = opts.team_name;
    var r = await fetch(backend + "/auth/google", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("google login failed " + r.status);
    var j = await r.json();
    if (!j.teams || !j.teams.length) return { teams: [], user: { id: j.sub, name: j.name } };
    var team = j.teams[0]; // 默认最近加入的
    var sr = await fetch(backend + "/auth/google/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken, team_id: team.team_id }),
    });
    if (!sr.ok) throw new Error("session failed " + sr.status);
    var sj = await sr.json();
    return { token: sj.token, user: sj.user, team_id: sj.team_id, teams: j.teams };
  }

  return { start: start, googleStart: googleStart, parseCallbackUrl: parseCallbackUrl, buildCallbackBody: buildCallbackBody };
})();
