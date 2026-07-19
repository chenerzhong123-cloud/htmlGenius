// test/fake-claude.mjs — 可注入 executeHandoff 的假 Claude adapter(对象级,不起子进程)。
// 与 fake-claude-bin/claude(可执行文件级,测真实 spawn)互补:本 fake 跑 host-runner 编排测试,
// 零进程开销、可精确断言调用参数与顺序。
export function makeFakeClaude(overrides = {}) {
  const calls = { checkAuth: [], runHandoff: [], resumeHandoff: [] };
  const cfg = {
    authFail: null,          // 设 code 字符串 → checkAuth 抛错
    runResult: { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    runFail: null,           // 设 {code,message} → runHandoff 抛错
    resumeResult: null,      // 默认与 runResult 相同
    resumeFail: null,
    onRun: null,             // 钩子:(args) => void(可用来模拟运行期改 source)
    ...overrides
  };
  function mkErr(spec) { const e = new Error(spec.message || spec.code); e.code = spec.code; return e; }
  return {
    calls,
    cfg,
    async checkAuth(args) {
      calls.checkAuth.push(args || {});
      if (cfg.authFail) throw mkErr(typeof cfg.authFail === "string" ? { code: cfg.authFail } : cfg.authFail);
      return true;
    },
    async runHandoff(args) {
      calls.runHandoff.push(args || {});
      if (cfg.onRun) cfg.onRun(args);
      if (cfg.runFail) throw mkErr(cfg.runFail);
      return { ...cfg.runResult };
    },
    async resumeHandoff(args) {
      calls.resumeHandoff.push(args || {});
      if (cfg.onRun) cfg.onRun(args);
      if (cfg.resumeFail) throw mkErr(cfg.resumeFail);
      return { ...(cfg.resumeResult || cfg.runResult) };
    }
  };
}
