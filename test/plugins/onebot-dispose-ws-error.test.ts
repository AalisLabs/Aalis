import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// onebot 拆卸块先 removeAllListeners() 再 terminate()/close()。ws 对 CONNECTING 套接字的
// terminate() 走 abortHandshake → process.nextTick(emit('error'))：emit 发生在 terminate 返回
// 之后，此时 'error' 已无人接，EventEmitter 直接抛，成为 uncaughtException——runtime 的处理器
// 判为致命并结束进程。bounce 撞上握手在途（对端 SYN 黑洞时可长达 15s）即整个实例退出。
//
// 修法是在 removeAllListeners 之后补一个 no-op 'error' 监听。本测试在子进程里把这条前提从
// 两侧钉死：不补则进程死（exit 3），补了则活（exit 0）——ws 若改了这一行为，这里会先报。
// 拆卸块本身在 2300 行的 apply 里，无法单独实例化，故测的是它依赖的库行为。
// ════════════════════════════════════════════════════════════

const wsPath = createRequire(new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url)).resolve(
  'ws',
);

const SCRIPT = `
const { default: WebSocket } = await import(process.env.WS_PATH);
const net = await import('node:net');
process.on('uncaughtException', () => process.exit(3));
const srv = net.createServer(() => {}); // 接受 TCP 但永不回 upgrade → ws 停在 CONNECTING
srv.listen(0, '127.0.0.1', () => {
  const ws = new WebSocket('ws://127.0.0.1:' + srv.address().port);
  ws.on('error', () => {}); // 插件平时挂的 error handler
  setTimeout(() => {
    if (ws.readyState !== 0) process.exit(9); // 前置不成立：不在 CONNECTING
    ws.removeAllListeners();
    if (process.env.MODE === 'fixed') ws.on('error', () => {});
    ws.terminate();
    setTimeout(() => process.exit(0), 200);
  }, 100);
});
`;

function run(mode: 'bare' | 'fixed'): Promise<number> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT],
      { env: { ...process.env, WS_PATH: wsPath, MODE: mode }, timeout: 5000 },
      (err, _stdout, _stderr) =>
        resolve(err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0),
    );
  });
}

describe('onebot 拆卸：CONNECTING 套接字 terminate 前必须有 error 监听', () => {
  it('前提：removeAllListeners 后直接 terminate，进程死于 uncaughtException', async () => {
    expect(await run('bare'), 'ws 行为若已变，此处先报；exit 9 表示前置条件（CONNECTING）不成立').toBe(3);
  });

  it('修法：补一个 no-op error 监听后进程存活', async () => {
    expect(await run('fixed')).toBe(0);
  });
});
