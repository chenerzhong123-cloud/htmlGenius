// bridge/native-protocol.mjs — Chrome Native Messaging 帧 codec。
// 协议:每条消息 = 4 字节 little-endian 长度(字节数)+ UTF-8 JSON 正文。上限 1 MiB(§6.2)。
// 纯逻辑,只用 Buffer(不碰 chrome/文件/网络),便于 `node --test`。
// 所有日志走 stderr —— stdout 只允许出现 native 帧。

export const MAX_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MiB

// 编码一条 native 消息 -> Buffer(头 4B LE 长度 + UTF-8 JSON)
export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.byteLength > MAX_MESSAGE_BYTES) {
    const err = new Error("message exceeds 1 MiB native frame limit");
    err.code = "MESSAGE_TOO_LARGE";
    err.bytes = body.byteLength;
    throw err;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

// 流式解码:feed 累积字节,messages() 产出所有已收满的消息(处理拆包/粘包)。
// declared > 上限 -> 抛 FRAME_TOO_LARGE;正文非法 JSON -> 抛 INVALID_JSON。
export class NativeFrameDecoder {
  constructor(maxBytes) {
    this._buf = Buffer.alloc(0);
    this._max = maxBytes || MAX_MESSAGE_BYTES;
  }
  feed(chunk) {
    if (!chunk) return this;
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._buf = this._buf.length ? Buffer.concat([this._buf, c]) : c;
    return this;
  }
  *messages() {
    while (this._buf.length >= 4) {
      const declared = this._buf.readUInt32LE(0);
      if (declared > this._max) {
        const err = new Error("declared frame length exceeds limit");
        err.code = "FRAME_TOO_LARGE";
        err.declared = declared;
        throw err;
      }
      const end = 4 + declared;
      if (this._buf.length < end) break; // 帧未收满,等更多字节
      const body = this._buf.subarray(4, end);
      let obj;
      try {
        obj = JSON.parse(body.toString("utf8"));
      } catch (cause) {
        const err = new Error("native frame body is not valid JSON");
        err.code = "INVALID_JSON";
        err.cause = cause && cause.message;
        throw err;
      }
      this._buf = this._buf.subarray(end);
      yield obj;
    }
  }
  // 仅用于测试/调试:当前缓冲区长度
  get pendingBytes() { return this._buf.length; }
}

// 便捷:把一条消息写进 stream(帧编码)。失败(超限)由调用方处理。
export function writeMessage(stream, obj) {
  stream.write(encodeMessage(obj));
}
