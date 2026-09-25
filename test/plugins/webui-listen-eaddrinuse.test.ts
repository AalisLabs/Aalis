import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { App, LogHub } from '../../packages/core/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 端口被占（EADDRINUSE）是 listen 之后异步 emit 的 'error'，外层 try/catch 接不住；无人处理
// 就是 uncaughtException，runtime 收到即 process.exit(1)。契约是「WebUI 起不来、其余照跑」：
// 错误要被接住并记一条 error 日志。
//
// 监听必须挂在 wss 上：`new WebSocketServer({ server })` 构造时已给 http server 挂了一条把
// 'error' 转发给 wss 的监听并排在最前，wss 上没有监听时转发即同步抛出，挂在 server 上的
// 处理器轮不到。挂错地方时 vitest 会把 uncaught exception 记成 Unhandled Error 让整轮失败，
// 这里的日志断言也等不到。
// ════════════════════════════════════════════════════════════

describe('webui-server：监听端口被占', () => {
  it('记一条 error 日志，不抛成 uncaughtException', async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>(r => blocker.listen(port, '127.0.0.1', r));
    const logHub = new LogHub();
    const errors: string[] = [];
    logHub.onEntry(e => {
      if (e.level === 'error') errors.push(e.message);
    });
    const app = new App({ name: 'T', logLevel: 'warn', logHub });
    try {
      await app.pluginAll([{ definition: webuiServerPlugin, config: { port, host: '127.0.0.1', autoOpen: false } }]);
      await app.start();
      const hit = () => errors.some(m => m.includes('WebUI 监听') && m.includes('EADDRINUSE'));
      for (let i = 0; i < 150 && !hit(); i++) await new Promise(r => setTimeout(r, 20));
      expect(hit(), `错误日志：${JSON.stringify(errors)}`).toBe(true);
    } finally {
      await app.stop();
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });
});
