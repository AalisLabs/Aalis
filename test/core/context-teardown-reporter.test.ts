import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { rootActivation } from '../../packages/core/src/orchestration/app.js';

// ════════════════════════════════════════════════════════════
// 拆卸路径上的诊断上报由宿主 logger 承担，其 sink 可能抛错（stdout EPIPE、磁盘满、WebUI 推送异常）。
// 清理链已兜（disposable-chain 的 report），Context 传给 Lifecycle 的回调里的裸 logger 调用同型：
// onTimeout 抛错会让整个 teardown 拒绝、清理链一项不跑。本文件用「只对特定文案抛错」的 logger
// 钉住：超时上报失败不得跳过清理；子模块 disposeAsync 收尾后名字释放，父激活仍可拆。
// ════════════════════════════════════════════════════════════

function throwingLogger(marker: string): Logger {
  const boom = (message: unknown) => {
    if (String(message).includes(marker)) throw new Error('sink boom');
  };
  const l = { debug() {}, info() {}, warn: boom, error: boom, child: () => l } as unknown as Logger;
  return l;
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const mkApp = (marker: string) => {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger: throwingLogger(marker) });
  apps.push(app);
  return app;
};

describe('Context 拆卸路径：宿主 logger 抛错不中断拆卸', () => {
  it('初始化等待超时的上报抛错：disposeAsync 仍完成，清理链照跑', async () => {
    const app = mkApp('等待初始化落定');
    const child = rootActivation(app).fork('slow');
    child.trackActivation(new Promise(() => {}));
    let cleaned = false;
    child.onDispose(() => {
      cleaned = true;
    });
    await expect(child.disposeAsync(20)).resolves.toBeUndefined();
    expect(cleaned, '超时上报抛错不得跳过清理链').toBe(true);
  });

  it('子模块 disposeAsync 之后名字释放，父激活仍可拆', async () => {
    const app = mkApp('sink boom');
    const root = rootActivation(app);
    const h = await root.useModule('m', () => {});
    await expect(h.disposeAsync()).resolves.toBeUndefined();
    const again = await root.useModule('m', () => {});
    expect(again.id, '收尾完成后名字已释放').toBe('root#m');
    apps.splice(apps.lastIndexOf(app), 1);
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
