import { createServer } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import mcpServer from '../../packages/plugin-mcp-server/src/index.js';

// ════════════════════════════════════════════════════════════
// createServer 的 async 回调此前全程无 try/catch，且第一行用 Host 头拼 URL base。
// Node 把 `Host:`（空值）解析成空字符串——空串非 nullish，`??` 兜不住，base 退化成
// 'http://' → ERR_INVALID_URL → 回调返回的 Promise 无人接 → runtime 的
// unhandledRejection 处理器判为致命并结束进程。一行请求打死整个 bot。
// ════════════════════════════════════════════════════════════

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

/** 直接用裸 socket 发畸形请求：http.request 不允许构造空 Host */
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(raw));
    let out = '';
    sock.on('data', d => {
      out += d.toString();
    });
    sock.on('close', () => resolve(out));
    sock.on('error', reject);
    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, 3000).unref?.();
  });
}

describe('plugin-mcp-server: 畸形 Host 不得打死进程', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) {
      try {
        await a.stop();
      } catch {
        /* 停不掉也继续 */
      }
    }
  });

  it('空 Host 头：正常应答，且不产生未处理拒绝', async () => {
    const port = await freePort();
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const host = app.bind({ provide });
    host.provide(tools, {
      getAll: () => [],
      getDefinitions: () => [],
      getSummaries: () => [],
      listGroups: () => [],
      execute: async () => ({ content: '' }),
    } as never);
    await app.plugins.register(mcpServer, {
      port,
      bind: '127.0.0.1',
      toolGroups: [],
      allowRestricted: false,
    });
    await app.plugins.idle();

    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on('unhandledRejection', onRejection);
    try {
      const res = await rawRequest(port, 'GET /nope HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n');
      // 给事件循环一轮，让可能的未处理拒绝浮出来
      await new Promise(r => setTimeout(r, 200));
      expect(res, '服务端必须给出应答，而不是让回调抛穿').toMatch(/^HTTP\/1\.1 \d{3}/);
      expect(rejections, '回调里逃逸的异常会被 runtime 判为致命并结束进程').toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
