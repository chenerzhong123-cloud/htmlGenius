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

  // 档3:Google 登录(getAuthToken → /auth/google → /auth/google/session)
  async function googleStart(opts) {
    opts = opts || {};
    var backend = (window.HG_CONFIG && window.HG_CONFIG.backend) || "";
    var at = await new Promise(function (resolve, reject) {
      chrome.identity.getAuthToken({ interactive: opts.interactive !== false }, function (token) {
        if (chrome.runtime.lastError || !token) reject(chrome.runtime.lastError || new Error("no token"));
        else resolve(token);
      });
    });
    var body = { access_token: at };
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
      body: JSON.stringify({ access_token: at, team_id: team.team_id }),
    });
    if (!sr.ok) throw new Error("session failed " + sr.status);
    var sj = await sr.json();
    return { token: sj.token, user: sj.user, team_id: sj.team_id, teams: j.teams };
  }

  return { start: start, googleStart: googleStart, parseCallbackUrl: parseCallbackUrl, buildCallbackBody: buildCallbackBody };
})();
