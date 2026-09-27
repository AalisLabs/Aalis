// ============================================================
// Server-Sent Events 的增量解析（WHATWG 规则的子集）：空行分隔消息；data 多行以换行拼接；
// 冒号开头的行是注释；没有 data 的消息不派发。id 只取这条消息自己写的 id 字段——续传位置由调用方
// 按事件类型决定推进与否（Cursor 的 status、heartbeat 没有 id，interaction_update 与简化事件共用 id）。
// ============================================================

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  #buf = '';
  #event = '';
  #data: string[] = [];
  #id: string | undefined;

  /** 喂入一段已解码的文本，返回这段文本里完整结束的消息 */
  push(text: string): SseMessage[] {
    this.#buf += text;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.#buf);
      if (!m) break;
      // 行尾的 \r 可能是跨块的 \r\n 的前半，等下一块再定
      if (m[0] === '\r' && m.index === this.#buf.length - 1) break;
      const line = this.#buf.slice(0, m.index);
      this.#buf = this.#buf.slice(m.index + m[0].length);
      const msg = this.#line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  #line(line: string): SseMessage | undefined {
    if (line === '') {
      const msg = this.#data.length > 0 ? { event: this.#event || 'message', data: this.#data.join('\n') } : undefined;
      const id = this.#id;
      this.#event = '';
      this.#data = [];
      this.#id = undefined;
      return msg && id !== undefined ? { ...msg, id } : msg;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    return undefined;
  }
}
