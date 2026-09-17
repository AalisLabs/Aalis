import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 拆卸路径上的诊断上报由宿主 logger 承担，其 sink 可能抛错（stdout EPIPE、磁盘满、WebUI 推送异常）。
// 清理链已兜（disposable-chain 的 report），Context 传给 Lifecycle 的回调里的裸 logger 调用同型：
// onTimeout 抛错会让整个 teardown 拒绝、清理链一项不跑；afterCleanup 里 unregisterByPlugin 的 catch
// 抛错会跳过末尾的模块名释放。本文件用「只对特定文案抛错」的 logger 钉住这两条不变量。
// ════════════════════════════════════════════════════════════

function throwingLogger(marker: string): Logger {
  const boom = (message: unknown) => {
    if (String(message).includes(marker)) throw new Error('sink boom');
  };
  const l = { debug() {}, info() {}, warn: boom, error: boom, child: () => l } as unknown as Logger;
  return l;
}

const mkApp = (marker: string) =>
  new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger: throwingLogger(marker) });

describe('Context 拆卸路径：宿主 logger 抛错不中断拆卸', () => {
  it('初始化等待超时的上报抛错：disposeAsync 仍完成，清理链照跑', async () => {
    const app = mkApp('等待初始化落定');
    const child = app.ctx.fork('slow');
    child.trackActivation(new Promise(() => {}));
    let cleaned = false;
    child.onDispose(() => {
      cleaned = true;
    });
    await expect(child.disposeAsync(20)).resolves.toBeUndefined();
    expect(cleaned, '超时上报抛错不得跳过清理链').toBe(true);
    app.ctx.dispose();
  });

  it('枢纽清扫抛错、其上报再抛错：模块名仍释放，父 ctx 仍可拆', async () => {
    const app = mkApp('unregisterByPlugin 抛错');
    app.ctx.provide('hub', {
      unregisterByPlugin() {
        throw new Error('hub boom');
      },
    });
    const h = await app.ctx.useModule({ name: 'm', apply() {} });
    await expect(h.disposeAsync()).resolves.toBeUndefined();
    const again = await app.ctx.useModule({ name: 'm', apply() {} });
    expect(again.id, '收尾上报抛错也不能让名字泄漏').toBe('root#m');
    await expect(app.ctx.disposeAsync()).resolves.toBeUndefined();
  });
});
