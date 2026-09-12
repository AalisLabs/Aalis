import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitWritable } from '../../packages/plugin-webui-server/src/routes/proxy.js';

// ════════════════════════════════════════════════════════════
// 图片代理的背压等待（真 HTTP 服务端 + 真 socket，不 mock）。
//
// 缺陷背景：转发时 res.write() 返回 false 就 `await res.once('drain')`。客户端
// 中途断开后 'drain' 永不到达（socket 已毁），这条请求的 async 帧、上游 body
// reader 与 socket 引用全部永久悬挂，连 finally 的 clearTimeout 都到不了。
// 正解：drain 与 close/error 竞速，连接没了就返回 false，由调用方收上游。
// ════════════════════════════════════════════════════════════

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

/** 起一个 HTTP 服务，返回「拿到服务端 res」的 promise + 端口。 */
async function serveOnce(): Promise<{ res: Promise<http.ServerResponse>; port: number }> {
  let handoff: (res: http.ServerResponse) => void = () => {};
  const res = new Promise<http.ServerResponse>(resolve => {
    handoff = resolve;
  });
  server = http.createServer((_req, r) => handoff(r));
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  return { res, port: (server.address() as AddressInfo).port };
}

/**
 * 写到真卡住为止：write() 返回 false 且短时间内不 drain。
 * 只看首个 false 不够——环回上的内核缓冲还有余量时 drain 会立刻到，形成假背压。
 */
async function fillUntilStuck(res: http.ServerResponse): Promise<boolean> {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < 64; i++) {
    if (res.write(chunk)) continue;
    const drained = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 200);
      res.once('drain', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!drained) return true;
  }
  return false;
}

describe('图片代理背压等待 waitWritable', () => {
  it('客户端中途断开：不等 drain 等到天荒地老，返回 false', async () => {
    const { res: resP, port } = await serveOnce();
    // 客户端不读（暂停 socket），让服务端写满内核缓冲触发背压
    const req = http.get({ host: '127.0.0.1', port }, r => r.pause());
    req.on('error', () => {}); // 自己 destroy 引发的 ECONNRESET，无需理会
    const res = await resP;
    expect(await fillUntilStuck(res), '需要真背压才能测这条路径').toBe(true);

    const waiting = waitWritable(res);
    req.destroy(); // 客户端断开：'drain' 从此不会再来

    await expect(
      Promise.race([waiting, new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 3000))]),
    ).resolves.toBe(false);
  });

  it('客户端继续读：drain 到达，返回 true 可接着写', async () => {
    const { res: resP, port } = await serveOnce();
    let resume: (() => void) | undefined;
    const req = http.get({ host: '127.0.0.1', port }, r => {
      r.pause();
      resume = () => r.resume();
    });
    req.on('error', () => {});
    const res = await resP;
    expect(await fillUntilStuck(res)).toBe(true);

    const waiting = waitWritable(res);
    resume?.(); // 客户端开始消费
    await expect(waiting).resolves.toBe(true);
    res.end();
    req.destroy();
  });

  it('进入等待时连接已毁：立刻返回 false', async () => {
    const { res: resP, port } = await serveOnce();
    const req = http.get({ host: '127.0.0.1', port }, r => r.pause());
    req.on('error', () => {});
    const res = await resP;
    req.destroy();
    await new Promise<void>(resolve => res.on('close', () => resolve()));
    await expect(waitWritable(res)).resolves.toBe(false);
  });
});
