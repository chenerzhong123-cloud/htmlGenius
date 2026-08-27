// login.js — 飞书 OAuth 登录流程(MV3 chrome.identity.launchWebAuthFlow)
// 暴露 window.Login:
//   - parseCallbackUrl(url)   → {code, state}(从重定向 URL 解析)
//   - buildCallbackBody(o)    → POST /auth/lark/callback 的 JSON body 字符串(纯函数,测试用)
//   - start({backend})        → 完整登录,返回 {token, user:{id,name}, team_id}
window.Login = (function () {
  "use strict";

  function authError(code, message, stage) {
    var e = new Error(message);
    e.code = code;
    e.stage = stage;
    return e;
  }

  function responseError(response, body, fallback, stage) {
    var code = response.status === 400 ? "INVALID_REQUEST"
      : response.status === 401 ? "UNAUTHORIZED"
      : response.status === 409 ? "CONFLICT"
      : response.status === 422 ? "INVALID_INPUT"
      : response.status === 429 ? "RATE_LIMITED"
      : "HTTP_ERROR";
    return authError(code, (body && body.detail) || fallback, stage);
  }

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
    if (!clientId) throw authError("GOOGLE_CONFIG_MISSING", "config 缺 google_client_id", "google_config");
    var redirect = chrome.identity.getRedirectURL();  // https://<ext-id>.chromiumapp.org/
    // SUP-3:nonce 改用 CSPRNG(crypto.getRandomValues 16 字节 → base64url),替代可预测的 Math.random,防重放。
    var nonce = (function () {
      var bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      var b64 = btoa(String.fromCharCode.apply(null, bytes));
      return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    })();
    var authUrl = "https://accounts.google.com/o/oauth2/v2/auth?"
      + "client_id=" + encodeURIComponent(clientId)
      + "&response_type=id_token"
      + "&redirect_uri=" + encodeURIComponent(redirect)
      + "&scope=" + encodeURIComponent("openid email profile")
      + "&nonce=" + encodeURIComponent(nonce);
    var respUrl;
    try {
      respUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: opts.interactive !== false });
    } catch (e) {
      // OAuth 原始错误可能含上游细节;UI/埋点统一使用固定错误码。
      throw authError("OAUTH_FLOW_FAILED", "Google 授权未完成", "oauth_flow");
    }
    if (!respUrl) throw authError("OAUTH_FLOW_FAILED", "Google 授权取消", "oauth_flow");
    // 回调 URL:https://<ext-id>.chromiumapp.org/#id_token=<jwt>&...
    var params = new URLSearchParams(respUrl.split("#")[1] || "");
    var idToken = params.get("id_token");
    if (!idToken) {
      var err = params.get("error");
      throw authError("OAUTH_TOKEN_MISSING", "Google 未返回 id_token" + (err ? "(" + err + ")" : ""), "oauth_token");
    }
    var body = { id_token: idToken };
    if (opts.action) body.action = opts.action;
    if (opts.code) body.code = opts.code;
    if (opts.team_name) body.team_name = opts.team_name;
    var r = await fetch(backend + "/auth/google", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      var googleBody = null; try { googleBody = await r.json(); } catch (e) {}
      throw responseError(r, googleBody, "google login failed " + r.status, "google_auth");
    }
    var j = await r.json();
    if (!j.teams || !j.teams.length) return { teams: [], user: { id: j.sub, name: j.name } };
    var team = j.teams[0]; // 默认最近加入的
    var sr = await fetch(backend + "/auth/google/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken, team_id: team.team_id }),
    });
    if (!sr.ok) {
      var sessionBody = null; try { sessionBody = await sr.json(); } catch (e) {}
      throw responseError(sr, sessionBody, "session failed " + sr.status, "google_session");
    }
    var sj = await sr.json();
    return { token: sj.token, user: sj.user, team_id: sj.team_id, teams: j.teams };
  }

  // 邮箱 + 密码登录(带邮箱验证码)。backend 由调用方传入。
  async function emailRegister(backend, email, password, name) {
    var body = { email: email, password: password };
    if (name) body.name = name;
    var r = await fetch(backend + "/auth/email/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw responseError(r, j, "register failed " + r.status, "email_register");
    return j;
  }
  async function emailVerify(backend, email, code, inviteCode, teamName) {
    var body = { email: email, code: code };
    if (inviteCode) body.invite_code = inviteCode;
    if (teamName) body.team_name = teamName;
    var r = await fetch(backend + "/auth/email/verify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw responseError(r, j, "verify failed " + r.status, "email_verify");
    return j;
  }
  async function emailLogin(backend, email, password) {
    var r = await fetch(backend + "/auth/email/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: password }),
    });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw responseError(r, j, "login failed " + r.status, "email_login");
    return j;
  }

  async function emailProbe(backend, email) {
    var r = await fetch(backend + "/auth/email/probe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email }),
    });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw responseError(r, j, "probe failed " + r.status, "email_probe");
    return j;
  }

  async function emailResend(backend, email) {
    var r = await fetch(backend + "/auth/email/resend", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email }),
    });
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw responseError(r, j, "resend failed " + r.status, "email_resend");
    return j;
  }

  return { start: start, googleStart: googleStart, emailRegister: emailRegister, emailVerify: emailVerify, emailLogin: emailLogin, emailProbe: emailProbe, emailResend: emailResend, parseCallbackUrl: parseCallbackUrl, buildCallbackBody: buildCallbackBody };
})();
