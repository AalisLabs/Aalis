import { afterEach, describe, expect, it } from 'vitest';
import { App, LogHub } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的 WebSocket 入站帧：JSON 合法但形状不对时只记一行「协议违规」；非 JSON 帧此前被外层
// catch 接住，记成「消息处理失败」并带整段栈。两者同属协议违规，措辞与形态要一致。
// ════════════════════════════════════════════════════════════

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('webui-server：WS 非 JSON 帧', () => {
  it('记一行「协议违规消息: 非 JSON 帧」告警，不带栈，也不记成处理失败', async () => {
    const port = await freePort();
    const token = 'test-fixed-token-placeholder';
    const logHub = new LogHub();
    // 只收入站帧处理的两种告警：协议违规与处理失败（旧行为）
    const warns: string[] = [];
    logHub.onEntry(e => {
      if (e.level === 'warn' && /^WebUI (收到协议违规消息|消息处理失败)/.test(e.message)) warns.push(e.message);
    });
    const app = new App({ name: 'T', logLevel: 'warn', logHub });
    apps.push(app);
    await app.pluginAll([
      {
        definition: webuiServer,
        config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: token },
      },
    ]);
    await app.start();
    expect(app.plugins.getPlugin(webuiServer.name)?.state, '前置：webui-server 已激活').toBe('active');

    let ws: WebSocket | undefined;
    for (let i = 0; i < 100 && !ws; i++) {
      const attempt = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie: `aalis_webui_token=${token}` },
      });
      const opened = await new Promise<boolean>(resolve => {
        attempt.onopen = () => resolve(true);
        attempt.onerror = () => resolve(false);
      });
      if (opened) ws = attempt;
      else await new Promise(r => setTimeout(r, 20));
    }
    if (!ws) throw new Error('WebSocket 连不上');

    ws.send('not json');
    for (let i = 0; i < 100 && warns.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    ws.close();

    expect(warns).toEqual(['WebUI 收到协议违规消息: 非 JSON 帧']);
  });
});
