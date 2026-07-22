// bridge/test/fake-copilot-sdk.mjs — @github/copilot-sdk 1.0.7 的测试替身。
// 只复刻 HTML Genius 使用的 SDK 表面(§5.1 允许集):CopilotClient(start/getAuthStatus/getStatus/ping/
// createSession/stop/forceStop)、RuntimeConnection.forStdio、CopilotSession(sendAndWait/on/disconnect/abort)。
// 明确不实现被禁 API(listSessions/resumeSession/getLastSessionId/getEvents/...);若被测代码调用它们,
// 测试会因 "not a function" 直接失败——这本身就是回归防线。
// 所有调用记入 calls[],测试据此断言:probe 不建 session、不发送消息、输出不含路径等。

function makeCalls() {
  const calls = [];
  calls.record = (name, arg) => { calls.push({ name, arg }); };
  return calls;
}

export function makeFakeSdk(behavior = {}) {
  const calls = makeCalls();
  const local = behavior.local || {};     // 针对「本地 CLI 连接」的行为
  const bundled = behavior.bundled || {}; // 针对「SDK 自带 runtime」的行为
  const sessionBehavior = behavior.session || {};

  class FakeCopilotClient {
    constructor(options = {}) {
      this.options = options;
      this._kind = options.connection && options.connection.kind === "stdio" ? "local" : "bundled";
      calls.record("client.construct", {
        kind: this._kind,
        connection: options.connection ? { kind: options.connection.kind, path: options.connection.path } : null,
        mode: options.mode,
        workingDirectory: options.workingDirectory,
        baseDirectory: options.baseDirectory
      });
    }
    async start() {
      calls.record("client.start", { kind: this._kind });
      const b = this._kind === "local" ? local : bundled;
      if (b.startError) throw b.startError;
    }
    async getAuthStatus() {
      calls.record("client.getAuthStatus", { kind: this._kind });
      const b = this._kind === "local" ? local : bundled;
      if (b.authError) throw b.authError;
      return b.auth || { isAuthenticated: true, statusMessage: "Signed in" };
    }
    async getStatus() {
      calls.record("client.getStatus", { kind: this._kind });
      const b = this._kind === "local" ? local : bundled;
      if (b.statusError) throw b.statusError;
      return b.status || { version: "1.0.7", protocolVersion: 1 };
    }
    async ping(message) {
      calls.record("client.ping", { kind: this._kind, message });
      return { message: message || "pong", timestamp: "0", protocolVersion: 1 };
    }
    async createSession(config) {
      calls.record("client.createSession", { kind: this._kind, config });
      if (sessionBehavior.createError) throw sessionBehavior.createError;
      return new FakeSession(this, config);
    }
    async stop() {
      calls.record("client.stop", { kind: this._kind });
      return [];
    }
    async forceStop() {
      calls.record("client.forceStop", { kind: this._kind });
    }
    // —— 以下被禁 API 不应被调用;实现它们反而会掩盖错误,故不提供 ——
  }

  class FakeSession {
    constructor(client, config) {
      this.client = client;
      this.config = config;
      this.sessionId = "fake-session-id-do-not-persist";
      this._handlers = [];
    }
    on(handlerOrType, maybeHandler) {
      const handler = typeof handlerOrType === "function" ? handlerOrType : maybeHandler;
      this._handlers.push(handler);
      calls.record("session.on", {});
      return () => {};
    }
    emit(event) { for (const h of this._handlers.slice()) { try { h(event); } catch (_) {} } }
    async sendAndWait(optionsOrPrompt, timeoutMs) {
      const prompt = typeof optionsOrPrompt === "string" ? optionsOrPrompt : optionsOrPrompt && optionsOrPrompt.prompt;
      calls.record("session.sendAndWait", { prompt, timeoutMs });
      // 模拟 Agent 在受控 workspace 里干活:测试通过 writer 写入 candidate.html / output/plan.json
      if (sessionBehavior.writer) {
        sessionBehavior.writer({
          cwd: this.client.options.workingDirectory,
          prompt,
          emit: (e) => this.emit(e),
          session: this,       // 供测试调用 config.hooks.onPreToolUse 验证策略接线
          config: this.config
        });
      }
      if (sessionBehavior.sendAndWaitError) throw sessionBehavior.sendAndWaitError;
      return { type: "assistant.message", data: { content: sessionBehavior.reply || "done" } };
    }
    async disconnect() { calls.record("session.disconnect", {}); }
    async abort() { calls.record("session.abort", {}); }
  }

  const RuntimeConnection = {
    forStdio(opts = {}) {
      calls.record("RuntimeConnection.forStdio", { path: opts.path });
      return { kind: "stdio", path: opts.path };
    }
  };

  class ToolSet {
    constructor() { this.items = []; }
    addBuiltIn(names) { for (const n of [].concat(names)) this.items.push("builtin:" + n); return this; }
    addCustom(n) { this.items.push("custom:" + n); return this; }
    addMcp(n) { this.items.push("mcp:" + n); return this; }
    toArray() { return this.items.slice(); }
  }

  const BuiltInTools = {
    Isolated: ["ask_user", "task_complete", "exit_plan_mode", "task", "read_agent", "write_agent", "list_agents", "send_inbox", "context_board", "skill"]
  };

  return { CopilotClient: FakeCopilotClient, RuntimeConnection, ToolSet, BuiltInTools, __calls: calls };
}

// 模拟「SDK 模块缺失」的 loader(dynamic import 失败)。
export function makeMissingSdkLoader(code = "ERR_MODULE_NOT_FOUND") {
  return async () => {
    const e = new Error("Cannot find package '@github/copilot-sdk'");
    e.code = code;
    throw e;
  };
}
