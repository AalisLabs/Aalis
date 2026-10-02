// ============================================================
// routes/pipe-to-response.ts — 把存储读流写进 HTTP 响应（文件下载、上传文件下载与媒体路由共用）
// ============================================================

import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '@aalis/core';

/**
 * 把读流写进响应。读流出错（打开前文件被删、读到一半出错）或客户端中途断开时，pipeline 把两端都销毁、断开这次
 * 响应，响应头可能已经发出，不再改回错误码。裸 pipe 不处理源流的错误，没有监听的 'error' 会让进程退出；客户端断开
 * 时也不销毁源流，fd 不回收。中途断开是常事，只记读流出错；label 是日志里这次发送的说明
 */
export function pipeToResponse(stream: Readable, res: Writable, logger: Logger, label: string): void {
  pipeline(stream, res).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.warn(`${label} 读取出错: ${err.message}`);
  });
}
