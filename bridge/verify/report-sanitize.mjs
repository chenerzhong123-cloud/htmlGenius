// bridge/verify/report-sanitize.mjs — v0.9.1 §7:verification report 脱敏。
// 提炼自 v0.9 sanitizeHealth,但不假定 health sanitizer 足够:对嵌套键递归剥离敏感键,
// 并把字符串值里可能出现的绝对路径模式替换为占位符。report 只允许:稳定 check ID、provider ID、
// result、reason code、版本、耗时聚合。
const BLOCKED_KEYS = Object.freeze({
  path: 1, paths: 1, filepath: 1, file_path: 1, dir: 1, directory: 1, cwd: 1, home: 1,
  command: 1, commands: 1, argv: 1, args: 1,
  stdout: 1, stderr: 1, output: 1,
  token: 1, tokens: 1, cookie: 1, cookies: 1, credential: 1, credentials: 1, api_key: 1, apikey: 1,
  session: 1, session_id: 1, sessionid: 1, thread: 1, thread_id: 1, threadid: 1,
  prompt: 1, comment: 1, comments: 1, html: 1, body: 1, content: 1,
  stack: 1, stacktrace: 1, env: 1, environ: 1,
  username: 1, hostname: 1, login: 1, user: 1
});

// 绝对路径模式(macOS/Linux 用户目录与常见临时目录)→ 占位符。保守:仅替换明显路径串,不改语义字段。
const PATH_RE = /(?:\/(?:Users|home|tmp|var|private|opt|usr|Library)\/[^\s"',;)\]}]+)/g;

export function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      const lk = k.toLowerCase();
      if (BLOCKED_KEYS[lk] || BLOCKED_KEYS[k]) continue;
      out[k] = sanitizeValue(value[k]);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(PATH_RE, "<redacted-path>");
  return value;
}

export function sanitizeVerificationReport(report) {
  return sanitizeValue(report);
}

// report 骨架(§7.1 schema_version=1)。started_at/finished_at 由调用方在真实环境打点。
export function makeReportSkeleton({ kind, bridgeVersion, protocolVersion = 1, startedAt = null }) {
  return {
    schema_version: 1,
    kind,
    started_at: startedAt,
    finished_at: null,
    result: "pending",
    bridge: { version: bridgeVersion, protocol_version: protocolVersion },
    providers: [],
    summary: { passed: 0, failed: 0, skipped: 0 }
  };
}

// 汇总 checks → summary + overall result。
export function finalizeReport(report) {
  let passed = 0, failed = 0, skipped = 0;
  for (const p of report.providers || []) {
    for (const c of p.checks || []) {
      if (c.result === "passed") passed++;
      else if (c.result === "skipped") skipped++;
      else failed++;
    }
  }
  report.summary = { passed, failed, skipped };
  report.result = failed > 0 ? "failed" : "passed";
  report.finished_at = new Date().toISOString();
  return report;
}
