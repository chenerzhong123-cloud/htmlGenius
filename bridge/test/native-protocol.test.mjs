// bridge/test/native-protocol.test.mjs — Native Messaging 帧 codec 测试(§12.1)
// 运行:node --test bridge/test/native-protocol.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, NativeFrameDecoder, MAX_MESSAGE_BYTES } from "../native-protocol.mjs";

test("encodeMessage: 4B LE length prefix + UTF-8 JSON", () => {
  const buf = encodeMessage({ type: "ping", n: 1 });
  assert.equal(buf.readUInt32LE(0), Buffer.from(JSON.stringify({ type: "ping", n: 1 }), "utf8").length);
  assert.deepEqual(JSON.parse(buf.subarray(4).toString("utf8")), { type: "ping", n: 1 });
});

test("decode: 空输入不产出消息", () => {
  const d = new NativeFrameDecoder();
  d.feed(Buffer.alloc(0));
  assert.deepEqual([...d.messages()], []);
});

test("decode: 单条消息", () => {
  const d = new NativeFrameDecoder();
  d.feed(encodeMessage({ type: "bridge_status", status: "running" }));
  assert.deepEqual([...d.messages()], [{ type: "bridge_status", status: "running" }]);
});

test("decode: 多条连续消息(粘包)一次产出", () => {
  const d = new NativeFrameDecoder();
  d.feed(Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 }), encodeMessage({ c: 3 })]));
  assert.deepEqual([...d.messages()], [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("decode: 跨多次 feed 的拆包能重组", () => {
  const d = new NativeFrameDecoder();
  const frame = encodeMessage({ hello: "world" });
  d.feed(frame.subarray(0, 2));           // 不完整
  assert.deepEqual([...d.messages()], []);
  d.feed(frame.subarray(2, 5));           // 仍不完整
  assert.deepEqual([...d.messages()], []);
  d.feed(frame.subarray(5));              // 补齐
  assert.deepEqual([...d.messages()], [{ hello: "world" }]);
});

test("decode: 多条消息分散在不同 feed 到达", () => {
  const d = new NativeFrameDecoder();
  const f1 = encodeMessage({ i: 1 });
  const f2 = encodeMessage({ i: 2 });
  d.feed(f1);
  assert.deepEqual([...d.messages()], [{ i: 1 }]);
  d.feed(f2);
  assert.deepEqual([...d.messages()], [{ i: 2 }]);
});

test("decode: declared 超过上限 -> FRAME_TOO_LARGE", () => {
  const d = new NativeFrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
  d.feed(header);
  assert.throws(() => [...d.messages()], (err) => err.code === "FRAME_TOO_LARGE");
});

test("encodeMessage: 正文超 1 MiB -> MESSAGE_TOO_LARGE", () => {
  const big = { s: "x".repeat(MAX_MESSAGE_BYTES + 10) };
  assert.throws(() => encodeMessage(big), (err) => err.code === "MESSAGE_TOO_LARGE");
});

test("decode: 正文非法 JSON -> INVALID_JSON", () => {
  const d = new NativeFrameDecoder();
  const body = Buffer.from("{not json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  d.feed(Buffer.concat([header, body]));
  assert.throws(() => [...d.messages()], (err) => err.code === "INVALID_JSON");
});

test("decode: 0 长度帧(空正文)-> INVALID_JSON", () => {
  const d = new NativeFrameDecoder();
  d.feed(Buffer.from([0, 0, 0, 0]));
  assert.throws(() => [...d.messages()], (err) => err.code === "INVALID_JSON");
});

test("decode: 含中文/emoji 的 UTF-8 正文往返正确", () => {
  const d = new NativeFrameDecoder();
  const obj = { msg: "交给 Codex 生成新版本 ✦ 🚀", n: 42 };
  d.feed(encodeMessage(obj));
  assert.deepEqual([...d.messages()], [obj]);
});

test("decode: 一帧合法后紧跟一帧超大声明 -> 先产出合法,再抛 FRAME_TOO_LARGE", () => {
  const d = new NativeFrameDecoder();
  const ok = encodeMessage({ ok: true });
  const bigHeader = Buffer.alloc(4);
  bigHeader.writeUInt32LE(MAX_MESSAGE_BYTES + 5, 0);
  d.feed(Buffer.concat([ok, bigHeader]));
  const got = [];
  assert.throws(() => { for (const m of d.messages()) got.push(m); }, (e) => e.code === "FRAME_TOO_LARGE");
  assert.deepEqual(got, [{ ok: true }]);
});
