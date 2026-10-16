import { isTextRef, type TextRef } from './text-ref.js';

/**
 * 给人看的错误：message 是 `text.source`（日志照旧可读），出口按读者语言渲染 `text`；`status` 是 HTTP 出口用的状态码。
 * 判定用 {@link isTextError}，不用 instanceof：进程里装了两份本包时，两份的类互不认得
 */
export class TextError extends Error {
  override name = 'TextError';
  readonly text: TextRef;
  declare readonly status?: number;

  constructor(text: TextRef, options: { status?: number; cause?: unknown } = {}) {
    super(text.source, 'cause' in options ? { cause: options.cause } : undefined);
    this.text = text;
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * 给任意 Error 挂上文字对象并返回它本身，name 与类不变（ConfigError、SessionConfigError 这类按 name 判定的错误照旧认得）。
 * message 不动，由调用方给（通常就是 `text.source`）
 */
export function withText<E extends Error>(error: E, text: TextRef): E & { readonly text: TextRef } {
  return Object.assign(error, { text });
}

/** 是不是挂着文字对象的错误：按结构判（Error 且 `text` 是文字对象），另一份包的 TextError、改了 name 的子类都认 */
export function isTextError(error: unknown): error is Error & { readonly text: TextRef } {
  return error instanceof Error && isTextRef((error as { text?: unknown }).text);
}

/** 接住的报错作参数用：有文字对象取它，否则 message，再否则 String(err)。不要取 `.message` 拼句 */
export function textOf(error: unknown): string | TextRef {
  if (isTextError(error)) return error.text;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string') return message;
  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
